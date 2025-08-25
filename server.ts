import crypto from "crypto";
import express from "express";
import http from "http";
import WebSocket from "ws";

const DASH_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";

// ---- configurable defaults ----
const MODEL = process.env.COSYVOICE_MODEL ?? "cosyvoice-v2";
const DEFAULT_VOICE = process.env.COSYVOICE_VOICE ?? "longxiaochun_v2";
const DEFAULT_FORMAT = (process.env.COSYVOICE_FORMAT ?? "mp3") as
  | "mp3"
  | "wav"
  | "pcm";
const DEFAULT_SR = Number(process.env.COSYVOICE_SR ?? 16000); // 16000 keeps first-byte fast
const DEFAULT_RATE = Number(process.env.COSYVOICE_RATE ?? 1);
const DEFAULT_PITCH = Number(process.env.COSYVOICE_PITCH ?? 1);
const DEFAULT_VOL = Number(process.env.COSYVOICE_VOL ?? 50);
const API_KEY =
  process.env.ALIBABA_MODEL_STUDIO_API_KEY 
const SHARED_TOKEN = process.env.TTS_SIDECAR_TOKEN || "123"; // optional shared secret from Convex
const REQUEST_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS ?? 30000);
// --------------------------------

if (!API_KEY) {
  console.error("Missing ALIBABA_MODEL_STUDIO_API_KEY");
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");

// optional auth middleware from Convex proxy
app.use((req, res, next) => {
  if (!SHARED_TOKEN) return next();
  const tok = req.headers["x-sidecar-auth"];
  if (tok !== SHARED_TOKEN) return res.status(401).end("Unauthorized");
  next();
});

app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

// GET /tts/stream?text=...&voice=...&format=mp3&sampleRate=16000&rate=1&pitch=1&volume=50
app.get("/tts/stream", async (req, res) => {
  console.log("hehee");
  const text = ((req.query.text as string) || "").trim();
  if (!text) return res.status(400).end("Missing text");

  const voice = (req.query.voice as string) || DEFAULT_VOICE;
  const format = (req.query.format as "mp3" | "wav" | "pcm") || DEFAULT_FORMAT;
  const sampleRate = Number(req.query.sampleRate || DEFAULT_SR);
  const rate = Number(req.query.rate || DEFAULT_RATE);
  const pitch = Number(req.query.pitch || DEFAULT_PITCH);
  const volume = Number(req.query.volume || DEFAULT_VOL);

  // Prepare chunked response headers
  const mime =
    format === "wav"
      ? "audio/wav"
      : format === "pcm"
        ? "audio/L16"
        : "audio/mpeg";
  res.setHeader("Content-Type", mime);
  res.setHeader("Cache-Control", "no-store");

  // DashScope WS
  const ws = new WebSocket(DASH_URL, {
    headers: {
      Authorization: `bearer ${API_KEY}`,
      // 'X-DashScope-DataInspection': 'enable', // dev only; adds a bit of overhead
    },
  });

  const taskId = crypto.randomUUID();
  let closed = false;
  let finished = false;

  const safeClose = (code?: number) => {
    if (closed) return;
    closed = true;
    try {
      ws.close();
    } catch {}
    if (!res.headersSent) res.statusCode = code ?? (res.statusCode || 200);
    res.end();
  };

  // Abort upstream if client disconnects
  req.on("close", () => safeClose());

  // Request timeout
  const kill = setTimeout(() => {
    if (finished) return;
    res.statusCode = 504;
    safeClose();
  }, REQUEST_TIMEOUT_MS);

  ws.on("open", () => {
    const runTask = {
      header: { action: "run-task", task_id: taskId, streaming: "duplex" },
      payload: {
        task_group: "audio",
        task: "tts",
        function: "SpeechSynthesizer",
        model: MODEL,
        parameters: {
          text_type: "PlainText",
          voice,
          format,
          sample_rate: sampleRate,
          volume,
          rate,
          pitch,
        },
        input: {},
      },
    };
    ws.send(JSON.stringify(runTask));
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // Pipe audio chunk straight to response
      res.write(data);
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      const ev = msg?.header?.event;
      if (ev === "task-started") {
        // send text & finish signal
        ws.send(
          JSON.stringify({
            header: {
              action: "continue-task",
              task_id: taskId,
              streaming: "duplex",
            },
            payload: { input: { text } },
          }),
        );
        ws.send(
          JSON.stringify({
            header: {
              action: "finish-task",
              task_id: taskId,
              streaming: "duplex",
            },
            payload: { input: {} },
          }),
        );
      } else if (ev === "task-finished") {
        finished = true;
        clearTimeout(kill);
        safeClose();
      } else if (ev === "task-failed") {
        clearTimeout(kill);
        res.statusCode = 502;
        safeClose();
      }
    } catch {}
  });

  ws.on("error", () => {
    clearTimeout(kill);
    res.statusCode = 502;
    safeClose();
  });

  ws.on("close", () => {
    clearTimeout(kill);
    safeClose();
  });
});

const server = http.createServer(app);
const PORT = Number(process.env.PORT || 8787);
server.listen(PORT, () =>
  console.log(`CosyVoice sidecar streaming on :${PORT}`),
);
