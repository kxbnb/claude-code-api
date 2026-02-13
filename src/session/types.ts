// Types for NDJSON protocol between ccc-api and Claude Code CLI

// ── Content blocks (matches Anthropic API) ─────────────────────────────────

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }
  | { type: "thinking"; thinking: string; budget_tokens?: number };

// ── CLI → Server messages ──────────────────────────────────────────────────

export interface CLISystemInitMessage {
  type: "system";
  subtype: "init";
  session_id: string;
  model: string;
  cwd: string;
  tools: string[];
  permissionMode: string;
}

export interface CLIAssistantMessage {
  type: "assistant";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    model: string;
    content: ContentBlock[];
    stop_reason: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  parent_tool_use_id: string | null;
  session_id: string;
}

export interface CLIResultMessage {
  type: "result";
  subtype: "success" | "error_during_execution" | "error_max_turns" | string;
  is_error: boolean;
  result?: string;
  errors?: string[];
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  total_cost_usd: number;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  session_id: string;
}

export interface CLIStreamEventMessage {
  type: "stream_event";
  event: unknown;
  parent_tool_use_id: string | null;
  session_id: string;
}

export interface CLIControlRequestMessage {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
    tool_use_id: string;
  };
}

export interface CLIKeepAliveMessage {
  type: "keep_alive";
}

export type CLIMessage =
  | CLISystemInitMessage
  | CLIAssistantMessage
  | CLIResultMessage
  | CLIStreamEventMessage
  | CLIControlRequestMessage
  | CLIKeepAliveMessage
  | { type: "system"; subtype: "status"; [key: string]: unknown }
  | { type: "tool_progress"; [key: string]: unknown }
  | { type: "tool_use_summary"; [key: string]: unknown }
  | { type: "auth_status"; [key: string]: unknown };

// ── Server → CLI messages ──────────────────────────────────────────────────

export interface UserMessage {
  type: "user";
  message: { role: "user"; content: string | unknown[] };
  parent_tool_use_id: null;
  session_id: string;
}

export interface ControlResponse {
  type: "control_response";
  response: {
    subtype: "success";
    request_id: string;
    response: {
      behavior: "allow" | "deny";
      updatedInput?: Record<string, unknown>;
      message?: string;
    };
  };
}

// ── Session state ──────────────────────────────────────────────────────────

export type PermissionMode = "bypassPermissions" | "acceptEdits" | "default";

export interface SessionInfo {
  sessionId: string;
  cliSessionId?: string;
  model: string;
  permissionMode: PermissionMode;
  state: "starting" | "connected" | "ready" | "busy" | "exited";
  pid?: number;
  cwd: string;
  createdAt: number;
  lastUsedAt: number;
}

// ── Anthropic API types ────────────────────────────────────────────────────

export interface AnthropicRequest {
  model: string;
  messages: Array<{
    role: "user" | "assistant";
    content: string | ContentBlock[];
  }>;
  max_tokens?: number;
  system?: string | Array<{ type: "text"; text: string }>;
  stream?: boolean;
  metadata?: Record<string, unknown>;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// SSE event types matching Anthropic streaming format
export type SSEEvent =
  | { event: "message_start"; data: { type: "message_start"; message: Omit<AnthropicResponse, "content"> & { content: [] } } }
  | { event: "content_block_start"; data: { type: "content_block_start"; index: number; content_block: ContentBlock } }
  | { event: "content_block_delta"; data: { type: "content_block_delta"; index: number; delta: { type: "text_delta"; text: string } } }
  | { event: "content_block_stop"; data: { type: "content_block_stop"; index: number } }
  | { event: "message_delta"; data: { type: "message_delta"; delta: { stop_reason: string; stop_sequence: string | null }; usage: { output_tokens: number } } }
  | { event: "message_stop"; data: { type: "message_stop" } }
  | { event: "ping"; data: { type: "ping" } };
