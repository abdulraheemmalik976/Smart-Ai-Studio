const express = require("express");
const path = require("path");

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const MODELS = {
  fast: "gemini-3.5-flash-lite",
  smart: "gemini-3.8-flash"
};

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    app: "Smart AI Studio"
  });
});

app.post("/api/chat", async (req, res) => {
  console.log("CHAT REQUEST RECEIVED:", req.body);

  const message = String(req.body?.message || "").trim();
  const mode = req.body?.mode === "smart" ? "smart" : "fast";
  const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
  const history = rawHistory.slice(-20).map(item => ({
    role: item?.role === "assistant" || item?.role === "model" ? "model" : "user",
    parts: [{ text: String(item?.text || "").slice(0, 5000) }]
  })).filter(item => item.parts[0].text.trim());

  if (!message) {
    return res.status(400).json({
      error: "Please enter a message."
    });
  }

  if (message.length > 10000) {
    return res.status(400).json({
      error: "Message is too long."
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      error: "GEMINI_API_KEY is missing in Railway Variables."
    });
  }

  const model = MODELS[mode];

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  try {
    console.log("AI REQUEST:", mode, model);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: "You are Smart AI Studio, a helpful, accurate, friendly AI assistant. Answer in the language the user uses, including Urdu or Roman Urdu. Use the conversation history for context. Be honest about uncertainty and never claim to perform actions you cannot perform."
          }]
        },
        contents: [
          ...history,
          { role: "user", parts: [{ text: message }] }
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: mode === "smart" ? 2048 : 1024
        }
      }),
      signal: controller.signal
    });

    const data = await response.json();

    if (!response.ok) {
      const errorMessage =
        data.error?.message || "Gemini API request failed.";

      console.error("GEMINI ERROR:", response.status, errorMessage);

      return res.status(502).json({
        error: errorMessage,
        apiStatus: response.status
      });
    }

    const reply = data.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    if (!reply) {
      return res.status(502).json({
        error: "AI returned an empty response. Please try again."
      });
    }

    console.log("AI RESPONSE RECEIVED");

    return res.json({
      reply,
      mode,
      model
    });

  } catch (error) {
    console.error("SERVER ERROR:", error);

    return res.status(500).json({
      error: error.name === "AbortError"
        ? "AI request timed out. Please try again."
        : error.message || "Server error."
    });

  } finally {
    clearTimeout(timer);
  }
});



// Hugging Face Inference Providers text-to-video.
// The token stays on the server in Railway; generation may incur provider charges.
app.post("/api/video", async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "Please enter a video prompt." });
  if (prompt.length > 1200) return res.status(400).json({ error: "Prompt is too long (max 1200 characters)." });

  const apiKey = process.env.HF_TOKEN;
  if (!apiKey) return res.status(503).json({ error: "HF_TOKEN is missing in Railway Variables." });

  try {
    const { InferenceClient } = await import("@huggingface/inference");
    const client = new InferenceClient(apiKey);
    const video = await client.textToVideo({
      inputs: prompt,
      model: "Wan-AI/Wan2.2-TI2V-5B",
      provider: "fal-ai"
    });
    const bytes = Buffer.from(await video.arrayBuffer());
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", bytes.length);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(bytes);
  } catch (error) {
    const message = String(error.message || "Hugging Face video generation failed.");
    console.error("HUGGING FACE VIDEO ERROR:", message);
    const status = /402|payment|credit|billing|quota/i.test(message) ? 402 : 502;
    return res.status(status).json({
      error: status === 402
        ? "Hugging Face/provider credits are insufficient or billing is required. No free generation is available for this request."
        : message.slice(0, 500)
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Smart AI Studio running on port", PORT);
});
