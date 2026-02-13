import type { AnthropicRequest } from "../session/types.js";

/**
 * Extract the user prompt from an Anthropic Messages API request.
 * Takes the last user message content. System prompt is prepended if present.
 */
export function extractUserContent(req: AnthropicRequest): string {
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
  if (!lastUser) throw new Error("No user message found in messages array");

  let content: string;
  if (typeof lastUser.content === "string") {
    content = lastUser.content;
  } else {
    content = lastUser.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }

  if (req.system) {
    const sysText = typeof req.system === "string"
      ? req.system
      : req.system.map((b) => b.text).join("\n");
    content = `${sysText}\n\n${content}`;
  }

  return content;
}
