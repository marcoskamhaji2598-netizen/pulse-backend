const express = require("express");
const cors = require("cors");
require("dotenv").config({ override: true });

const OpenAI = require("openai");
const { createClient } = require("redis");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ====== CONFIG ======
const PORT = process.env.PORT || 8081;
const FREE_DAILY_LIMIT = 15;

const clientAI = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== REDIS ======
const REDIS_URL = process.env.REDIS_URL;
let redis = null;

async function initRedis() {
  if (!REDIS_URL) {
    console.warn("⚠️ REDIS_URL not set. Running in memory-less mode (not recommended).");
    return;
  }
  redis = createClient({ url: REDIS_URL });
  redis.on("error", (e) => console.error("REDIS ERROR:", e));
  await redis.connect();
  console.log("✅ Redis connected");
}

// ====== HELPERS ======
function todayKey() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isSpanish(text = "") {
  const t = text.toLowerCase();
  if (/[¿¡ñáéíóúü]/i.test(text)) return true;
  const hits = ["que", "como", "quien", "dime", "hola", "gracias", "por favor", "ayer", "hoy"];
  let score = 0;
  for (const w of hits) if (t.includes(w)) score++;
  return score >= 2;
}

function detectName(text = "") {
  let m = text.match(/\b(?:me\s+llamo|soy)\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)\b/i);
  if (m && m[1]) return m[1];
  m = text.match(/\b(?:my\s+name\s+is|i\s*'?m|i\s+am)\s+([A-Za-z]+)\b/i);
  if (m && m[1]) return m[1];
  return null;
}

function enforceTwoLines(reply = "") {
  const trimmed = String(reply).trim();
  const lines = trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const two = lines.slice(0, 2).join("\n");
  return two.length > 500 ? two.slice(0, 500).trim() : two;
}

// ====== REDIS KEYS ======
// count:{sessionId}:{dayKey} -> integer
// user:{sessionId} -> hash { name: "Marcos" }
// conv:{sessionId} -> list of JSON messages [{"role":"user","content":"..."}, ...]

// TTLs
const COUNT_TTL_SECONDS = 60 * 60 * 48; // 48h
const CONV_TTL_SECONDS = 60 * 60 * 24 * 7; // 7d
const USER_TTL_SECONDS = 60 * 60 * 24 * 30; // 30d

async function getUsage(sessionId) {
  const day = todayKey();
  const countKey = `count:${sessionId}:${day}`;
  let usedToday = 0;

  if (redis) {
    const v = await redis.get(countKey);
    usedToday = v ? parseInt(v, 10) : 0;
  }

  const remainingToday = Math.max(0, FREE_DAILY_LIMIT - usedToday);
  return { usedToday, remainingToday, limit: FREE_DAILY_LIMIT, dayKey: day };
}

async function incUsage(sessionId) {
  const day = todayKey();
  const countKey = `count:${sessionId}:${day}`;
  if (!redis) return;

  const newVal = await redis.incr(countKey);
  await redis.expire(countKey, COUNT_TTL_SECONDS);
  return newVal;
}

async function getUserName(sessionId) {
  if (!redis) return "";
  const key = `user:${sessionId}`;
  const name = await redis.hGet(key, "name");
  return name || "";
}

async function setUserName(sessionId, name) {
  if (!redis) return;
  const key = `user:${sessionId}`;
  await redis.hSet(key, "name", name);
  await redis.expire(key, USER_TTL_SECONDS);
}

async function pushConversation(sessionId, msgObj) {
  if (!redis) return;
  const key = `conv:${sessionId}`;
  await redis.rPush(key, JSON.stringify(msgObj));
  await redis.lTrim(key, -12, -1); // guarda solo últimas 12 entradas
  await redis.expire(key, CONV_TTL_SECONDS);
}

async function getConversation(sessionId) {
  if (!redis) return [];
  const key = `conv:${sessionId}`;
  const items = await redis.lRange(key, -12, -1);
  return items.map((s) => {
    try { return JSON.parse(s); } catch { return null; }
  }).filter(Boolean);
}

// ====== ROUTES ======
app.get("/health", async (req, res) => {
  res.json({ ok: true, redis: !!redis });
});

app.get("/usage", async (req, res) => {
  try {
    const sessionId = String(req.query.sessionId || "default").trim();
    const usage = await getUsage(sessionId);
    res.json(usage);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/chat", async (req, res) => {
  try {
    if (!req.body) return res.status(400).json({ error: "Missing JSON body" });

    const text = String(req.body.text || "").trim();
    const sessionId = String(req.body.sessionId || "default").trim();
    if (!text) return res.status(400).json({ error: "No text provided" });

    // detect + save name
    const maybeName = detectName(text);
    if (maybeName && redis) await setUserName(sessionId, maybeName);

    // usage check
    const usageBefore = await getUsage(sessionId);
    if (usageBefore.usedToday >= FREE_DAILY_LIMIT) {
      const es = isSpanish(text);
      return res.json({
        paywall: true,
        reply: es ? "Límite diario alcanzado.\nActiva Pro." : "Daily limit reached.\nUnlock Pro.",
        ...usageBefore
      });
    }

    // count this message
    if (redis) await incUsage(sessionId);

    // save user msg in history
    if (redis) await pushConversation(sessionId, { role: "user", content: text });

    const history = redis ? await getConversation(sessionId) : [{ role: "user", content: text }];

    const name = redis ? await getUserName(sessionId) : "";

    const systemPrompt = [
      "You are PULSE.",
      "Reply in the same language as the user (Spanish or English).",
      "Max 2 lines. Short, direct, complete.",
      "Zero fluff. Zero emojis. No links. No citations.",
      name ? `User name: ${name}` : ""
    ].filter(Boolean).join("\n");

    const response = await clientAI.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.3,
      max_tokens: 160,
      messages: [
        { role: "system", content: systemPrompt },
        ...history
      ]
    });

    let reply = response.choices?.[0]?.message?.content || "";
    reply = enforceTwoLines(reply);

    // save assistant msg
    if (redis) await pushConversation(sessionId, { role: "assistant", content: reply });

    const usageAfter = await getUsage(sessionId);

    return res.json({
      reply,
      paywall: false,
      ...usageAfter
    });

  } catch (err) {
    console.error("ERROR:", err?.message || err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
});

// ====== START ======
initRedis()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`PULSE running on http://127.0.0.1:${PORT}`);
    });
  })
  .catch((e) => {
    console.error("Redis init failed:", e);
    // Igual levantamos el server, pero sin persistencia
    app.listen(PORT, () => {
      console.log(`PULSE running on http://127.0.0.1:${PORT} (NO REDIS)`);
    });
  });
