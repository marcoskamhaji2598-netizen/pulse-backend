const express = require("express");
const cors = require("cors");
require("dotenv").config({ override: true });

const OpenAI = require("openai");

console.log("PULSE SERVER STARTING...");

const app = express();
app.use(cors());
app.use(express.json());

// ===== OpenAI =====
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== Memoria en RAM =====
const conversations = {};
const userMemory = {};
const usageCount = {};

const FREE_LIMIT = 3; // cambia aquí si quieres

// ===== Health check =====
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ===== CHAT =====
app.post("/chat", async (req, res) => {
  try {
    console.log("CHAT HIT:", req.body);

    const { text, sessionId } = req.body || {};

    if (!text) {
      return res.status(400).json({ error: "No text provided" });
    }

    const sid = sessionId || "default";

    // ===== contador free =====
    if (!usageCount[sid]) usageCount[sid] = 0;
    usageCount[sid]++;

    if (usageCount[sid] > FREE_LIMIT) {
      return res.json({
        paywall: true,
        reply: "Límite gratis alcanzado."
      });
    }

    // ===== detectar nombre =====
    const nameMatch = text.match(/me llamo\s+(\w+)/i);
    if (nameMatch) {
      const detectedName = nameMatch[1];
      if (!userMemory[sid]) userMemory[sid] = {};
      userMemory[sid].name = detectedName;
      console.log("NAME SAVED:", detectedName);
    }

    // ===== memoria conversación =====
    if (!conversations[sid]) conversations[sid] = [];

    conversations[sid].push({
      role: "user",
      content: text
    });

    // ===== prompt PULSE =====
    const systemPrompt = `
Eres PULSE.
Responde corto, directo y útil.
Máximo 2 oraciones.
Sin emojis.
Sin relleno.
Idioma: responde en el idioma del usuario.
Nombre del usuario: ${userMemory[sid]?.name || "desconocido"}
`;

    // ===== OpenAI =====
    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        ...conversations[sid].slice(-10)
      ]
    });

    const reply =
      response.choices?.[0]?.message?.content ||
      "No tengo respuesta.";

    conversations[sid].push({
      role: "assistant",
      content: reply
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
