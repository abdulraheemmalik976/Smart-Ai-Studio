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
        contents: [{
          role: "user",
          parts: [{ text: message }]
        }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: mode === "smart" ? 1024 : 512
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



// Magic Hour text-to-video: API key is stored only in Railway Variables.
app.post("/api/video", async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "Please enter a video prompt." });
  if (prompt.length > 2000) return res.status(400).json({ error: "Prompt is too long (max 2000 characters)." });

  const apiKey = process.env.MAGIC_HOUR_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "MAGIC_HOUR_API_KEY is missing in Railway Variables." });
  }

  const seconds = Number(req.body?.seconds || 5);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 10) {
    return res.status(400).json({ error: "Video duration must be between 1 and 10 seconds." });
  }

  try {
    const response = await fetch("https://api.magichour.ai/v1/text-to-video", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        end_seconds: seconds,
        aspect_ratio: req.body?.aspect_ratio === "9:16" ? "9:16" : "16:9",
        style: { prompt },
        name: "Smart AI Studio video",
        model: "ltx-2.5",
        resolution: "480p",
        audio: true
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("MAGIC HOUR API ERROR:", response.status, data);
      return res.status(response.status).json({
        error: data.message || data.error || "Magic Hour video request failed.",
        details: data
      });
    }

    return res.status(202).json({ message: "Video job submitted to Magic Hour.", project: data });
  } catch (error) {
    console.error("MAGIC HOUR SERVER ERROR:", error);
    return res.status(502).json({
      error: "Magic Hour connection failed: " + (error.cause?.code || error.code || error.message || "Unknown network error")
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Smart AI Studio running on port", PORT);
});
