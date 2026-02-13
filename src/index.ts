import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { CliBridge } from "./session/cli-bridge.js";
import { SessionPool } from "./session/pool.js";
import { createMessagesRoute } from "./routes/messages.js";

const PORT = Number(process.env.PORT) || 3457;
const WS_PORT = Number(process.env.WS_PORT) || 3458;
const SESSION_TIMEOUT_MS = Number(process.env.SESSION_TIMEOUT_MS) || 30 * 60 * 1000;

// ── Initialize components ──────────────────────────────────────────────────

const bridge = new CliBridge({
  wsPort: WS_PORT,
  sessionTimeoutMs: SESSION_TIMEOUT_MS,
});

const pool = new SessionPool(bridge);
const messagesRoute = createMessagesRoute(bridge, pool);

// ── Hono app ───────────────────────────────────────────────────────────────

const app = new Hono();
app.use("/*", cors());

// Mount the Anthropic-compatible messages endpoint
app.route("/", messagesRoute);

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// ── Start server ───────────────────────────────────────────────────────────

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[ccc-api] HTTP server on http://localhost:${info.port}`);
  console.log(`[ccc-api] CLI WebSocket on ws://localhost:${WS_PORT}`);
  console.log(`[ccc-api] Session timeout: ${SESSION_TIMEOUT_MS / 1000}s`);
  console.log(`[ccc-api] Ready. POST /v1/messages to interact.`);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────

async function shutdown() {
  console.log("[ccc-api] Shutting down...");
  await bridge.shutdown();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
