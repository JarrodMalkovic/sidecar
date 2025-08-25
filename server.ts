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
const API_KEY = process.env.ALIBABA_MODEL_STUDIO_API_KEY;
const SHARED_TOKEN = process.env.TTS_SIDECAR_TOKEN || "123"; // optional shared secret from Convex
const REQUEST_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS ?? 30000);
const MAX_CONCURRENT_CONNECTIONS = Number(process.env.MAX_CONCURRENT_CONNECTIONS ?? 10);
// --------------------------------

if (!API_KEY) {
  console.error("Missing ALIBABA_MODEL_STUDIO_API_KEY");
  process.exit(1);
}

// Connection pool for WebSocket connections
class WebSocketPool {
  private pool: WebSocket[] = [];
  private inUse: Set<WebSocket> = new Set();
  private maxSize: number;

  get poolSize(): number {
    return this.pool.length;
  }

  get inUseCount(): number {
    return this.inUse.size;
  }

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  async getConnection(): Promise<WebSocket> {
    // Try to reuse an existing connection
    for (const ws of this.pool) {
      if (!this.inUse.has(ws) && ws.readyState === WebSocket.OPEN) {
        this.inUse.add(ws);
        return ws;
      }
    }

    // Create new connection if pool is not full
    if (this.pool.length < this.maxSize) {
      const ws = new WebSocket(DASH_URL, {
        headers: {
          Authorization: `bearer ${API_KEY}`,
        },
      });

      // Clean up connection on close
      ws.on("close", () => {
        this.pool = this.pool.filter(conn => conn !== ws);
        this.inUse.delete(ws);
      });

      ws.on("error", () => {
        this.pool = this.pool.filter(conn => conn !== ws);
        this.inUse.delete(ws);
      });

      this.pool.push(ws);
      this.inUse.add(ws);
      return ws;
    }

    // Wait for a connection to become available
    return new Promise((resolve) => {
      const checkPool = () => {
        for (const ws of this.pool) {
          if (!this.inUse.has(ws) && ws.readyState === WebSocket.OPEN) {
            this.inUse.add(ws);
            resolve(ws);
            return;
          }
        }
        setTimeout(checkPool, 10); // Check every 10ms
      };
      checkPool();
    });
  }

  releaseConnection(ws: WebSocket) {
    this.inUse.delete(ws);
  }
}

// Pre-compiled JSON templates for faster serialization
const RUN_TASK_TEMPLATE = {
  header: { action: "run-task", streaming: "duplex" },
  payload: {
    task_group: "audio",
    task: "tts",
    function: "SpeechSynthesizer",
    model: MODEL,
    parameters: {
      text_type: "PlainText",
    },
    input: {},
  },
};

const CONTINUE_TASK_TEMPLATE = {
  header: { action: "continue-task", streaming: "duplex" },
  payload: { input: {} },
};

const FINISH_TASK_TEMPLATE = {
  header: { action: "finish-task", streaming: "duplex" },
  payload: { input: {} },
};

// Create connection pool
const wsPool = new WebSocketPool(MAX_CONCURRENT_CONNECTIONS);

const app = express();
app.disable("x-powered-by");

// Performance monitoring
let requestCount = 0;
let activeRequests = 0;

// optional auth middleware from Convex proxy
app.use((req, res, next) => {
  if (!SHARED_TOKEN) return next();
  const tok = req.headers["x-sidecar-auth"];
  if (tok !== SHARED_TOKEN) return res.status(401).end("Unauthorized");
  next();
});

app.get("/healthz", (_req, res) => res.status(200).json({ 
  ok: true, 
  stats: { 
    totalRequests: requestCount, 
    activeRequests,
    poolSize: wsPool.poolSize,
    inUse: wsPool.inUseCount
  } 
}));

// GET /tts/stream?text=...&voice=...&format=mp3&sampleRate=16000&rate=1&pitch=1&volume=50
app.get("/tts/stream", async (req, res) => {
  const startTime = Date.now();
  requestCount++;
  activeRequests++;

  try {
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

    // Get connection from pool
    const ws = await wsPool.getConnection();
    const taskId = crypto.randomUUID();
    let closed = false;
    let finished = false;

    const safeClose = (code?: number) => {
      if (closed) return;
      closed = true;
      wsPool.releaseConnection(ws);
      if (!res.headersSent) res.statusCode = code ?? (res.statusCode || 200);
      res.end();
      activeRequests--;
      console.log(`Request completed in ${Date.now() - startTime}ms`);
    };

    // Abort upstream if client disconnects
    req.on("close", () => safeClose());

    // Request timeout
    const kill = setTimeout(() => {
      if (finished) return;
      res.statusCode = 504;
      safeClose();
    }, REQUEST_TIMEOUT_MS);

    // Optimized message handler with minimal JSON parsing
    const messageHandler = (data: WebSocket.Data, isBinary: boolean) => {
      if (isBinary) {
        // Pipe audio chunk straight to response
        res.write(data);
        return;
      }

      // Fast string check before JSON parsing
      const dataStr = data.toString();
      if (!dataStr.includes('"event"')) return;

      try {
        const msg = JSON.parse(dataStr);
        const ev = msg?.header?.event;
        
        if (ev === "task-started") {
          // Use pre-compiled templates for faster serialization
          const continueTask = {
            ...CONTINUE_TASK_TEMPLATE,
            header: { ...CONTINUE_TASK_TEMPLATE.header, task_id: taskId },
            payload: { input: { text } }
          };
          
          const finishTask = {
            ...FINISH_TASK_TEMPLATE,
            header: { ...FINISH_TASK_TEMPLATE.header, task_id: taskId }
          };

          ws.send(JSON.stringify(continueTask));
          ws.send(JSON.stringify(finishTask));
        } else if (ev === "task-finished") {
          finished = true;
          clearTimeout(kill);
          safeClose();
        } else if (ev === "task-failed") {
          clearTimeout(kill);
          res.statusCode = 502;
          safeClose();
        }
      } catch (error) {
        // Ignore JSON parsing errors for non-JSON messages
      }
    };

    ws.on("message", messageHandler);

    ws.on("error", () => {
      clearTimeout(kill);
      res.statusCode = 502;
      safeClose();
    });

    ws.on("close", () => {
      clearTimeout(kill);
      safeClose();
    });

    // Send initial task with optimized template
    const runTask = {
      ...RUN_TASK_TEMPLATE,
      header: { ...RUN_TASK_TEMPLATE.header, task_id: taskId },
      payload: {
        ...RUN_TASK_TEMPLATE.payload,
        parameters: {
          ...RUN_TASK_TEMPLATE.payload.parameters,
          voice,
          format,
          sample_rate: sampleRate,
          volume,
          rate,
          pitch,
        }
      }
    };
    
    ws.send(JSON.stringify(runTask));

  } catch (error) {
    activeRequests--;
    console.error("Request error:", error);
    res.status(500).end("Internal server error");
  }
});

const server = http.createServer(app);
const PORT = Number(process.env.PORT || 8787);
server.listen(PORT, () =>
  console.log(`CosyVoice sidecar streaming on :${PORT} (max connections: ${MAX_CONCURRENT_CONNECTIONS})`),
);
