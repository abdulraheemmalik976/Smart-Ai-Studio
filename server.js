const express = require("express");
const path = require("path");
const admin = require("firebase-admin");
const Safepay = require("@sfpy/node-core");
const crypto = require("crypto");

const app = express();

app.use(express.json({ limit: "1mb", verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); } }));
app.use(express.static(path.join(__dirname, "public")));


function getAdminApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing in Railway Variables.");
  const serviceAccount = JSON.parse(raw);
  return admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Please sign in to use credits." });
    const app = getAdminApp();
    req.user = await app.auth().verifyIdToken(token);
    req.db = app.firestore();
    next();
  } catch (error) {
    console.error("AUTH VERIFY ERROR:", error.message);
    return res.status(401).json({ error: "Your session expired. Please sign in again." });
  }
}
async function getCredits(db, uid) {
  const snap = await db.collection("users").doc(uid).get();
  return snap.exists ? Number(snap.data().credits || 0) : 0;
}
async function chargeCredits(db, uid, amount) {
  const ref = db.collection("users").doc(uid);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("USER_PROFILE_MISSING");
    const current = Number(snap.data().credits || 0);
    if (current < amount) throw new Error("NOT_ENOUGH_CREDITS");
    const remaining = current - amount;
    tx.update(ref, { credits: remaining });
    return remaining;
  });
}

async function refundCredits(db, uid, amount) {
  const ref = db.collection("users").doc(uid);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("USER_PROFILE_MISSING");
    const current = Number(snap.data().credits || 0);
    const refunded = current + amount;
    tx.update(ref, { credits: refunded });
    return refunded;
  });
}

// Video credit prices are server-owned; never trust a price from the browser.
const VIDEO_CREDIT_COST = Object.freeze({6:10,10:16,15:24});
const CREDIT_PACKAGES = Object.freeze([
  {id:"starter",name:"Starter",credits:20,pricePkr:399},
  {id:"basic",name:"Basic",credits:40,pricePkr:749},
  {id:"pro",name:"Pro",credits:80,pricePkr:1399},
  {id:"premium",name:"Premium",credits:160,pricePkr:2599}
]);
app.get("/api/pricing",(req,res)=>{
  res.set("Cache-Control","no-store");
  res.json({currency:"PKR",packages:CREDIT_PACKAGES,videoCredits:VIDEO_CREDIT_COST,paymentsEnabled:false});
});

const MODEL_CHAINS = {
  fast: ["gemini-3.5-flash-lite", "gemini-3.5-flash"],
  smart: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash"]
};

app.get("/api/firebase-config", (req, res) => {
  const projectId = process.env.FIREBASE_PROJECT_ID || "";
  const config = {
    apiKey: process.env.FIREBASE_API_KEY || "",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || (projectId ? projectId + ".firebaseapp.com" : ""),
    projectId,
    appId: process.env.FIREBASE_APP_ID || ""
  };
  if (!config.apiKey || !config.projectId || !config.appId) {
    return res.status(503).json({ error: "Set FIREBASE_API_KEY, FIREBASE_PROJECT_ID and FIREBASE_APP_ID in Railway Variables." });
  }
  res.set("Cache-Control", "no-store");
  res.json(config);
});

app.get("/api/credits", requireUser, async (req, res) => {
  try {
    const credits = await getCredits(req.db, req.user.uid);
    res.json({ credits });
  } catch (error) {
    res.status(500).json({ error: "Could not load credits." });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    app: "Smart AI Studio"
  });
});

app.post("/api/chat", requireUser, async (req, res) => {
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

  const models = MODEL_CHAINS[mode];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);

  try {
    let lastStatus = 0;
    let lastError = "AI service is temporarily busy.";
    let reply = "";
    let usedModel = "";

    for (const model of models) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      console.log("AI REQUEST:", mode, model);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: "You are Smart AI Studio, a helpful, accurate, friendly AI assistant. Answer in the language the user uses, including Urdu or Roman Urdu. Use conversation history. For difficult questions, reason carefully, explain steps clearly, and check your answer. Be honest about uncertainty."
            }]
          },
          contents: [...history, { role: "user", parts: [{ text: message }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: mode === "smart" ? 4096 : 1024
          }
        }),
        signal: controller.signal
      });

      const data = await response.json();
      if (!response.ok) {
        lastStatus = response.status;
        lastError = data.error?.message || "Gemini API request failed.";
        console.error("GEMINI ERROR:", response.status, model, lastError);
        if ([429, 500, 502, 503, 504].includes(response.status)) continue;
        return res.status(502).json({ error: lastError, apiStatus: response.status });
      }

      reply = data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim() || "";
      if (reply) {
        usedModel = model;
        break;
      }
      lastStatus = 502;
      lastError = "AI returned an empty response.";
    }

    if (!reply) {
      console.error("ALL GEMINI MODELS BUSY:", lastStatus, lastError);
      return res.status(503).json({
        error: "Google AI is busy right now. Backup models were tried automatically. Please wait a minute and try again.",
        apiStatus: lastStatus
      });
    }

    console.log("AI RESPONSE RECEIVED:", usedModel);
    return res.json({ reply, mode, model: usedModel, freeChat: true });
  } catch (error) {
    console.error("SERVER ERROR:", error);
    return res.status(500).json({
      error: error.name === "AbortError" ? "AI request timed out. Please try again." : error.message || "Server error."
    });
  } finally {
    clearTimeout(timer);
  }
});



// Magic Hour text-to-video. Keep the API token on the server in Railway.
app.post("/api/video", requireUser, async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();
  const duration = Number(req.body?.duration || 6);
  const aspectRatio = ["16:9", "9:16", "1:1"].includes(req.body?.aspectRatio) ? req.body.aspectRatio : "16:9";

  if (!prompt) return res.status(400).json({ error: "Please enter a video prompt." });
  if (prompt.length > 1200) return res.status(400).json({ error: "Prompt is too long (max 1200 characters)." });
  if (![6, 10, 15].includes(duration)) return res.status(400).json({ error: "Choose a supported video duration." });

  const apiKey = process.env.MAGIC_HOUR_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "MAGIC_HOUR_API_KEY is missing in Railway Variables." });

  const videoCost = VIDEO_CREDIT_COST[duration];
  let creditsReserved = false;
  try {
    // Reserve app credits before calling the paid video provider.
    await chargeCredits(req.db, req.user.uid, videoCost);
    creditsReserved = true;

    const response = await fetch("https://api.magichour.ai/v1/text-to-video", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        name: "Smart AI Studio video",
        end_seconds: duration,
        aspect_ratio: aspectRatio,
        resolution: "480p",
        model: "ltx-2.5",
        audio: true,
        style: { prompt }
      }),
      signal: AbortSignal.timeout(45000)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      await refundCredits(req.db, req.user.uid, videoCost);
      creditsReserved = false;
      const status = response.status === 402 ? 402 : response.status === 401 ? 401 : 502;
      return res.status(status).json({
        error: response.status === 402
          ? "Magic Hour credits are finished or this generation requires a paid plan."
          : response.status === 401
            ? "Magic Hour API key was rejected. Check the Railway variable."
            : data.message || "Magic Hour could not start the video."
      });
    }
    if (!data.id) {
      await refundCredits(req.db, req.user.uid, videoCost);
      creditsReserved = false;
      return res.status(502).json({ error: "Magic Hour did not return a video job ID." });
    }
    // Save ownership so only the account that created this job can check its status.
    await req.db.collection("videoJobs").doc(String(data.id)).set({
      uid: req.user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    creditsReserved = false; // The duration-based credits are charged for this queued job.
    const remainingCredits = await getCredits(req.db, req.user.uid);
    return res.json({ id: data.id, appCreditsCharged: videoCost, creditsCharged: data.credits_charged ?? null, remainingCredits, status: "queued" });
  } catch (error) {
    if (creditsReserved) {
      try {
        await refundCredits(req.db, req.user.uid, videoCost);
      } catch (refundError) {
        console.error("VIDEO CREDIT REFUND ERROR:", refundError);
      }
    }
    if (error.message === "NOT_ENOUGH_CREDITS") {
      return res.status(402).json({ error: "You need more app credits for this video duration." });
    }
    if (error.message === "USER_PROFILE_MISSING") {
      return res.status(404).json({ error: "Your credit profile is missing. Please sign out and sign in again." });
    }
    console.error("MAGIC HOUR VIDEO CREATE ERROR:", error);
    return res.status(502).json({ error: error.name === "TimeoutError" ? "Magic Hour request timed out. Please try again." : "Could not connect to Magic Hour. Please try again." });
  }
});

app.get("/api/video/:id", requireUser, async (req, res) => {
  const apiKey = process.env.MAGIC_HOUR_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "MAGIC_HOUR_API_KEY is missing in Railway Variables." });
  const id = String(req.params.id || "");
  if (!/^[a-zA-Z0-9_-]{5,100}$/.test(id)) return res.status(400).json({ error: "Invalid video job ID." });

  try {
    const jobSnap = await req.db.collection("videoJobs").doc(id).get();
    if (!jobSnap.exists || jobSnap.data().uid !== req.user.uid) {
      return res.status(404).json({ error: "Video job not found for this account." });
    }
    const response = await fetch(`https://api.magichour.ai/v1/video-projects/${encodeURIComponent(id)}`, {
      headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
      signal: AbortSignal.timeout(20000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status === 402 ? 402 : 502).json({ error: data.message || "Could not check video status." });
    return res.json({
      id: data.id,
      status: data.status,
      error: data.error?.message || data.error || null,
      creditsCharged: data.credits_charged ?? null,
      videoUrl: data.status === "complete" ? data.downloads?.[0]?.url || null : null
    });
  } catch (error) {
    console.error("MAGIC HOUR VIDEO STATUS ERROR:", error);
    return res.status(502).json({ error: "Could not check video status. Please retry." });
  }
});


// Safepay one-time hosted checkout (sandbox). Never grant credits from redirect alone.
const PAYMENT_PACKAGES = Object.freeze({
  starter: { credits: 20, pricePkr: 399 },
  basic: { credits: 40, pricePkr: 749 },
  pro: { credits: 80, pricePkr: 1399 },
  premium: { credits: 160, pricePkr: 2599 }
});
function getSafepay() {
  const secret = process.env.SAFEPAY_SECRET_KEY;
  if (!secret) throw new Error("Safepay secret key is not configured.");
  return Safepay(secret, {
    authType: "secret",
    host: process.env.SAFEPAY_HOST || "https://sandbox.api.getsafepay.com"
  });
}
app.post("/api/payments/create", requireUser, async (req, res) => {
  const packageId = String(req.body?.packageId || "");
  const pkg = PAYMENT_PACKAGES[packageId];
  if (!pkg) return res.status(400).json({ error: "Invalid credit package." });
  try {
    const db = req.db;
    const orderRef = db.collection("paymentOrders").doc();
    const sf = getSafepay();
    const setup = await sf.payments.session.setup({
      merchant_api_key: process.env.SAFEPAY_PUBLIC_KEY,
      intent: "CYBERSOURCE",
      mode: "payment",
      entry_mode: "raw",
      currency: "PKR",
      amount: pkg.pricePkr * 100,
      include_fees: false,
      metadata: { order_id: orderRef.id, package_id: packageId }
    });
    const tracker = setup?.data?.tracker?.token;
    if (!tracker) throw new Error("Safepay tracker was not returned.");
    await orderRef.set({
      uid: req.user.uid, packageId, credits: pkg.credits,
      amountPaisa: pkg.pricePkr * 100, currency: "PKR", tracker,
      status: "pending", createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    const auth = await sf.auth.passport.create();
    const tbt = auth?.data;
    if (typeof tbt !== "string" || !tbt) throw new Error("Safepay checkout token was not returned.");
    const checkoutUrl = sf.checkouts.payment.create({
      tracker, tbt, environment: "sandbox", source: "hosted",
      redirect_url: "https://smart-ai-studio-production.up.railway.app/payment/return",
      cancel_url: "https://smart-ai-studio-production.up.railway.app/payment/return?cancelled=1"
    });
    if (typeof checkoutUrl !== "string" || !checkoutUrl.startsWith("https://")) {
      throw new Error("Safepay returned an invalid checkout URL.");
    }
    return res.json({ checkoutUrl });
  } catch (error) {
    console.error("SAFEPAY CHECKOUT ERROR:", error.message);
    return res.status(502).json({ error: "Could not start Safepay checkout. Please try again." });
  }
});
app.post("/api/payments/webhook", async (req, res) => {
  let event;
  try {
    const sf = getSafepay();
    event = sf.webhooks.constructEvent(
      req.rawBody || Buffer.from(""),
      req.get("X-SFPY-SIGNATURE") || "",
      process.env.SAFEPAY_WEBHOOK_SECRET || ""
    );
  } catch (error) {
    console.error("SAFEPAY WEBHOOK SIGNATURE ERROR:", error.message);
    return res.status(400).send("Invalid webhook signature");
  }
  if (event.type !== "payment.succeeded" || event.data?.success !== true) return res.sendStatus(200);
  const trackerValue = event.data?.tracker;
  const tracker = typeof trackerValue === "string" ? trackerValue : trackerValue?.token;
  const eventId = event.token || crypto.createHash("sha256").update(req.rawBody || Buffer.from("")).digest("hex");
  if (!tracker || !eventId) return res.status(400).send("Missing payment identifiers");
  try {
    const sf = getSafepay();
    const verified = await sf.reporter.payments.fetch(tracker);
    const payment = verified?.data?.tracker;
    const purchase = payment?.purchase_totals?.base_amount;
    if (payment?.state !== "TRACKER_ENDED" || purchase?.currency !== "PKR") {
      return res.status(400).send("Payment is not captured");
    }
    const db = getAdminApp().firestore();
    const found = await db.collection("paymentOrders").where("tracker", "==", tracker).limit(1).get();
    if (found.empty) return res.status(404).send("Order not found");
    const orderRef = found.docs[0].ref;
    const eventRef = db.collection("safepayEvents").doc(String(eventId));
    await db.runTransaction(async tx => {
      const orderSnap = await tx.get(orderRef);
      const eventSnap = await tx.get(eventRef);
      if (eventSnap.exists) return;
      if (!orderSnap.exists || orderSnap.data().status !== "pending") {
        tx.create(eventRef, { type: event.type, ignored: true, receivedAt: admin.firestore.FieldValue.serverTimestamp() });
        return;
      }
      const order = orderSnap.data();
      if (Number(purchase.amount) !== Number(order.amountPaisa) || order.currency !== purchase.currency) {
        tx.create(eventRef, { type: event.type, ignored: true, reason: "amount_mismatch", receivedAt: admin.firestore.FieldValue.serverTimestamp() });
        return;
      }
      const userRef = db.collection("users").doc(order.uid);
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error("PAYMENT_USER_MISSING");
      tx.update(userRef, { credits: Number(userSnap.data().credits || 0) + Number(order.credits) });
      tx.update(orderRef, { status: "paid", paidAt: admin.firestore.FieldValue.serverTimestamp(), webhookEventId: eventId });
      tx.create(eventRef, { type: event.type, tracker, receivedAt: admin.firestore.FieldValue.serverTimestamp() });
    });
    return res.sendStatus(200);
  } catch (error) {
    console.error("SAFEPAY WEBHOOK PROCESS ERROR:", error.message);
    return res.sendStatus(500);
  }
});
app.get("/payment/return", (req, res) => {
  res.type("html").send("<!doctype html><html><meta name='viewport' content='width=device-width,initial-scale=1'><title>Payment status</title><body style='font-family:Arial;padding:24px'><h2>Payment received for checking</h2><p>Credits will appear only after Safepay confirms payment. Return to Smart AI Studio and refresh your credits.</p><a href='/'>Back to Smart AI Studio</a></body></html>");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Smart AI Studio running on port", PORT);
});
