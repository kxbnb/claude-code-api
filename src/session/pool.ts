import { CliBridge } from "./cli-bridge.js";
import type { PermissionMode, SessionInfo } from "./types.js";

/**
 * Session pool that manages Claude Code CLI sessions.
 * Provides lookup-or-create semantics keyed by session ID.
 */
export class SessionPool {
  private bridge: CliBridge;

  constructor(bridge: CliBridge) {
    this.bridge = bridge;
  }

  /**
   * Get or create a session. If the session doesn't exist, spawn a new CLI.
   * Waits for the CLI to be ready before returning.
   */
  async getOrCreate(options: {
    sessionId?: string;
    model?: string;
    permissionMode?: PermissionMode;
    cwd?: string;
    apiKey?: string;
  }): Promise<{ sessionId: string; info: SessionInfo; isNew: boolean }> {
    // Try existing session
    if (options.sessionId && this.bridge.hasSession(options.sessionId)) {
      const info = this.bridge.getSession(options.sessionId);
      if (info && info.state !== "exited") {
        return { sessionId: options.sessionId, info, isNew: false };
      }
    }

    // Spawn new session
    const sessionId = this.bridge.spawnSession({
      sessionId: options.sessionId,
      model: options.model,
      permissionMode: options.permissionMode,
      cwd: options.cwd,
      apiKey: options.apiKey,
    });

    await this.bridge.waitForReady(sessionId);
    const info = this.bridge.getSession(sessionId)!;
    return { sessionId, info, isNew: true };
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.bridge.getSession(sessionId);
  }
}
