require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

// ===== OPENAI =====
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== MEMORIA SIMPLE =====
const conversations = {};

// ===== PULSE SYSTEM PROMPT (ANTI-HISTORIA) =====
const SYSTEM_PROMPT = `
Eres PULSE.

Reglas:
- Responde MUY corto (máximo 2 líneas).
- Directo al grano.
- Cero cursi.
- Sin emojis.
- Si la pregunta es de actualidad y no estás seguro, responde: "No estoy seguro."
- Nunca inventes datos actuales.
`;

// ===== WIKIDATA (ACTUALIZADO) =====
async function fetchHeadOfState(countryQid, lang = "es") {
  const endpoint = "https://query.wikidata.org/sparql";

  const query = `
    SELECT ?personLabel WHERE {
      wd:${countryQid} wdt:P35 ?person .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "${lang}". }
    }
    LIMIT 1
  `;

  const url = `${endpoint}?format=json&query=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Pulse/1.0 (marcoskamhaji2598@gmail.com)",
      "Accept": "application/sparql-results+json",
    },
  });

  if (!res.ok) throw new Error(`Wikidata error ${res.status}`);

  const data = await res.json();
  const bindings = data?.results?.bindings || [];
  const label = bindings?.[0]?.personLabel?.value;

  if (!label) throw new Error("No head of state found");

  return label;
}

// ===== ROUTE CHAT =====
app.post("/chat", async (req, res) => {
  try {
    const { text, sessionId = "default" } = req.body || {};

    if (!text) return res.status(400).json({ error: "Text required" });

    if (!conversations[sessionId]) conversations[sessionId] = [];

    const normalized = String(text).toLowerCase();

    // ==============================
    // PRESIDENTE — RESPUESTA EN VIVO
    // ==============================
    const asksPresident =
      normalized.includes("presidente") ||
      normalized.includes("president");

    try {
      if (asksPresident) {
        // 🇵🇦 PANAMÁ
        if (normalized.includes("panama") || normalized.includes("panamá")) {
          const name = await fetchHeadOfState("Q804", "es");
          return res.json({
            reply: `El presidente de Panamá es ${name}.`,
          });
        }

        // 🇺🇸 USA
        if (
          normalized.includes("united states") ||
          normalized.includes("usa") ||
          normalized.includes("estados unidos")
        ) {
          const name = await fetchHeadOfState("Q30", "en");
          return res.json({
            reply: `${name} is the president of the United States.`,
          });
        }
      }
    } catch (e) {
      console.log("WIKIDATA FAIL:", e.message);
      // si falla, sigue al modelo
    }

    // ==============================
    // CHAT NORMAL (OpenAI)
    // ==============================
    conversations[sessionId].push({
      role: "user",
      content: text,
    });

    // limitar historial
    if (conversations[sessionId].length > 20) {
      conversations[sessionId] = conversations[sessionId].slice(-20);
    }

    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...conversations[sessionId],
      ],
    });

    let reply = response.choices[0].message.content || "";

    // 🔥 hard limit 2 líneas
    reply = reply.split("\n").slice(0, 2).join("\n").trim();

    conversations[sessionId].push({
      role: "assistant",
      content: reply,
    });

    res.json({ reply });
  } catch (err) {
    console.error("ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 8081;

app.listen(PORT, () => {
  console.log(`PULSE running on http://127.0.0.1:${PORT}`);
});
