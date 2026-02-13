import { randomUUID } from "node:crypto";
import type {
  CLIAssistantMessage,
  CLIResultMessage,
  AnthropicResponse,
  ContentBlock,
} from "../session/types.js";

/**
 * Build an Anthropic Messages API response from CLI assistant + result messages.
 */
export function buildAnthropicResponse(
  assistant: CLIAssistantMessage,
  result: CLIResultMessage,
): AnthropicResponse {
  return {
    id: assistant.message.id || `msg_${randomUUID().replace(/-/g, "").substring(0, 20)}`,
    type: "message",
    role: "assistant",
    content: assistant.message.content,
    model: assistant.message.model,
    stop_reason: mapStopReason(result.stop_reason || assistant.message.stop_reason),
    stop_sequence: null,
    usage: {
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
      cache_read_input_tokens: result.usage.cache_read_input_tokens,
    },
  };
}

export function buildPartialResponse(
  assistant: CLIAssistantMessage,
  model: string,
): AnthropicResponse {
  return {
    id: assistant.message.id || `msg_${randomUUID().replace(/-/g, "").substring(0, 20)}`,
    type: "message",
    role: "assistant",
    content: assistant.message.content,
    model: assistant.message.model || model,
    stop_reason: mapStopReason(assistant.message.stop_reason),
    stop_sequence: null,
    usage: assistant.message.usage || { input_tokens: 0, output_tokens: 0 },
  };
}

function mapStopReason(reason: string | null): AnthropicResponse["stop_reason"] {
  if (!reason) return null;
  if (reason === "end_turn") return "end_turn";
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "stop_sequence") return "stop_sequence";
  if (reason === "tool_use") return "tool_use";
  return "end_turn";
}

// ── SSE helpers ────────────────────────────────────────────────────────────

export function sseMessageStart(model: string, id?: string): string {
  const msgId = id || `msg_${randomUUID().replace(/-/g, "").substring(0, 20)}`;
  const data = {
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
  return `event: message_start\ndata: ${JSON.stringify(data)}\n\n`;
}

export function ssePing(): string {
  return `event: ping\ndata: {"type":"ping"}\n\n`;
}

export function sseContentBlockStart(index: number, block: ContentBlock): string {
  const data = { type: "content_block_start", index, content_block: block };
  return `event: content_block_start\ndata: ${JSON.stringify(data)}\n\n`;
}

export function sseContentBlockDelta(index: number, text: string): string {
  const data = {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  };
  return `event: content_block_delta\ndata: ${JSON.stringify(data)}\n\n`;
}

export function sseContentBlockStop(index: number): string {
  const data = { type: "content_block_stop", index };
  return `event: content_block_stop\ndata: ${JSON.stringify(data)}\n\n`;
}

export function sseMessageDelta(stopReason: string, outputTokens: number): string {
  const data = {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  };
  return `event: message_delta\ndata: ${JSON.stringify(data)}\n\n`;
}

export function sseMessageStop(): string {
  return `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
}
