import { Hono } from "hono";
import type { CliBridge } from "../session/cli-bridge.js";
import type { SessionPool } from "../session/pool.js";
import type {
  AnthropicRequest,
  CLIAssistantMessage,
  CLIResultMessage,
  CLIStreamEventMessage,
  PermissionMode,
} from "../session/types.js";
import { extractUserContent } from "../translators/request.js";
import {
  buildAnthropicResponse,
  sseMessageStart,
  ssePing,
  sseContentBlockStart,
  sseContentBlockDelta,
  sseContentBlockStop,
  sseMessageDelta,
  sseMessageStop,
} from "../translators/response.js";

export function createMessagesRoute(bridge: CliBridge, pool: SessionPool) {
  const app = new Hono();

  app.post("/v1/messages", async (c) => {
    const body = await c.req.json<AnthropicRequest>();
    const sessionId = c.req.header("x-session-id") || undefined;
    const permissionMode = (c.req.header("x-permission-mode") as PermissionMode) || "acceptEdits";
    const apiKey = c.req.header("x-api-key") || c.req.header("authorization")?.replace(/^Bearer\s+/i, "") || undefined;

    // Validate request
    if (!body.messages?.length) {
      return c.json({ error: { type: "invalid_request_error", message: "messages array is required" } }, 400);
    }

    // Get or create session
    let session;
    try {
      session = await pool.getOrCreate({
        sessionId,
        model: body.model,
        permissionMode,
        apiKey,
      });
    } catch (err) {
      return c.json({
        error: { type: "api_error", message: `Failed to initialize session: ${(err as Error).message}` }
      }, 500);
    }

    const content = extractUserContent(body);

    if (body.stream) {
      return handleStreaming(c, bridge, session.sessionId, content, body.model);
    } else {
      return handleNonStreaming(c, bridge, session.sessionId, content, body.model);
    }
  });

  return app;
}

async function handleNonStreaming(
  c: any,
  bridge: CliBridge,
  sessionId: string,
  content: string,
  model: string,
) {
  return new Promise<Response>((resolve) => {
    let lastAssistant: CLIAssistantMessage | null = null;

    const onAssistant = (sid: string, msg: CLIAssistantMessage) => {
      if (sid !== sessionId) return;
      lastAssistant = msg;
    };

    const onResult = (sid: string, msg: CLIResultMessage) => {
      if (sid !== sessionId) return;
      cleanup();

      if (!lastAssistant) {
        resolve(c.json({
          error: { type: "api_error", message: "No response received from Claude Code" }
        }, 500));
        return;
      }

      const response = buildAnthropicResponse(lastAssistant, msg);
      const headers: Record<string, string> = {
        "x-session-id": sessionId,
      };
      resolve(c.json(response, 200, headers));
    };

    const onError = (sid: string, err: Error) => {
      if (sid !== sessionId) return;
      cleanup();
      resolve(c.json({
        error: { type: "api_error", message: err.message }
      }, 500));
    };

    const onExit = (sid: string, code: number | null) => {
      if (sid !== sessionId) return;
      cleanup();
      resolve(c.json({
        error: { type: "api_error", message: `CLI process exited with code ${code}` }
      }, 500));
    };

    function cleanup() {
      bridge.removeListener("assistant", onAssistant);
      bridge.removeListener("result", onResult);
      bridge.removeListener("error", onError);
      bridge.removeListener("exit", onExit);
    }

    bridge.on("assistant", onAssistant);
    bridge.on("result", onResult);
    bridge.on("error", onError);
    bridge.on("exit", onExit);

    bridge.sendUserMessage(sessionId, content);

    // Timeout after 5 minutes
    setTimeout(() => {
      cleanup();
      resolve(c.json({
        error: { type: "api_error", message: "Request timed out" }
      }, 504));
    }, 5 * 60 * 1000);
  });
}

function handleStreaming(
  _c: any,
  bridge: CliBridge,
  sessionId: string,
  content: string,
  model: string,
) {
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    start(controller) {
      let blockIndex = 0;
      let sentMessageStart = false;

      const enqueue = (s: string) => {
        try { controller.enqueue(encoder.encode(s)); } catch {}
      };

      const onAssistant = (sid: string, msg: CLIAssistantMessage) => {
        if (sid !== sessionId) return;

        if (!sentMessageStart) {
          enqueue(sseMessageStart(msg.message.model || model, msg.message.id));
          sentMessageStart = true;
        }

        for (const block of msg.message.content) {
          if (block.type === "text") {
            enqueue(sseContentBlockStart(blockIndex, { type: "text", text: "" }));
            enqueue(sseContentBlockDelta(blockIndex, block.text));
            enqueue(sseContentBlockStop(blockIndex));
            blockIndex++;
          } else if (block.type === "tool_use") {
            enqueue(sseContentBlockStart(blockIndex, block));
            enqueue(sseContentBlockStop(blockIndex));
            blockIndex++;
          }
        }
      };

      const onStreamEvent = (sid: string, msg: CLIStreamEventMessage) => {
        if (sid !== sessionId) return;

        if (!sentMessageStart) {
          enqueue(sseMessageStart(model));
          sentMessageStart = true;
        }

        const event = msg.event as any;
        if (event?.type === "content_block_start") {
          enqueue(sseContentBlockStart(event.index ?? blockIndex, event.content_block));
          blockIndex = (event.index ?? blockIndex) + 1;
        } else if (event?.type === "content_block_delta") {
          if (event.delta?.type === "text_delta") {
            enqueue(sseContentBlockDelta(event.index ?? blockIndex - 1, event.delta.text));
          }
        } else if (event?.type === "content_block_stop") {
          enqueue(sseContentBlockStop(event.index ?? blockIndex - 1));
        }
      };

      const onResult = (sid: string, msg: CLIResultMessage) => {
        if (sid !== sessionId) return;
        cleanup();

        if (sentMessageStart) {
          enqueue(sseMessageDelta(msg.stop_reason || "end_turn", msg.usage.output_tokens));
          enqueue(sseMessageStop());
        }
        try { controller.close(); } catch {}
      };

      const onError = (sid: string, _err: Error) => {
        if (sid !== sessionId) return;
        cleanup();
        try { controller.close(); } catch {}
      };

      const onExit = (sid: string, _code: number | null) => {
        if (sid !== sessionId) return;
        cleanup();
        try { controller.close(); } catch {}
      };

      function cleanup() {
        clearTimeout(timer);
        bridge.removeListener("assistant", onAssistant);
        bridge.removeListener("stream_event", onStreamEvent);
        bridge.removeListener("result", onResult);
        bridge.removeListener("error", onError);
        bridge.removeListener("exit", onExit);
      }

      bridge.on("assistant", onAssistant);
      bridge.on("stream_event", onStreamEvent);
      bridge.on("result", onResult);
      bridge.on("error", onError);
      bridge.on("exit", onExit);

      enqueue(ssePing());
      bridge.sendUserMessage(sessionId, content);

      const timer = setTimeout(() => {
        cleanup();
        try { controller.close(); } catch {}
      }, 5 * 60 * 1000);
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Session-Id": sessionId,
    },
  });
}
