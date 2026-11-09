
const express = require("express");
const path = require("path");

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const MODELS = {
  fast: "gemini-3.5-flash-lite",
  smart: "gemini-3.5-flash"
};

const sleep = (ms) =>
  new Promise(resolve => setTimeout(resolve, ms));

app.get("/health", (req, res) => {
  res.json({ status: "ok", app: "Smart AI Studio" });
});

app.post("/api/chat", async (req, res) => {
  try {
    const message = String(req.body.message || "").trim();
    const mode = req.body.mode === "smart" ? "smart" : "fast";

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
        error: "AI API key is not configured."
      });
    }

    const model = MODELS[mode];

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    let data;
    let lastError;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
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
          signal: AbortSignal.timeout(60000)
        });

        const responseText = await response.text();

        try {
          data = JSON.parse(responseText);
        } catch {
          throw new Error("Invalid response from Google AI.");
        }

        if (response.ok) break;

        lastError = data.error?.message || "AI request failed.";

        if (![429, 500, 502, 503, 504].includes(response.status)) {
          return res.status(response.status).json({
            error: lastError
          });
        }

        if (attempt === 2) {
          return res.status(response.status).json({
            error: lastError,
            retryable: true
          });
        }

        await sleep(1000 * (attempt + 1));

      } catch (error) {
        lastError = error.message;

        if (attempt === 2) {
          return res.status(503).json({
            error: lastError,
            retryable: true
          });
        }

        await sleep(1000 * (attempt + 1));
      }
    }

    const reply = data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    if (!reply) {
      return res.status(502).json({
        error: "No AI response received. Please try again."
      });
    }

    res.json({
      reply,
      mode,
      model
    });

  } catch (error) {
    res.status(500).json({
      error: "Server error. Please try again."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Smart AI Studio is running on port " + PORT);
});
        
