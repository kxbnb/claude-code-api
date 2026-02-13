import { randomUUID } from "node:crypto";
import { spawn, execSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { EventEmitter } from "node:events";
import type {
  CLIMessage,
  CLISystemInitMessage,
  CLIAssistantMessage,
  CLIResultMessage,
  CLIStreamEventMessage,
  CLIControlRequestMessage,
  ControlResponse,
  PermissionMode,
  SessionInfo,
} from "./types.js";

export interface BridgeEvents {
  ready: [sessionId: string, initMsg: CLISystemInitMessage];
  assistant: [sessionId: string, msg: CLIAssistantMessage];
  result: [sessionId: string, msg: CLIResultMessage];
  stream_event: [sessionId: string, msg: CLIStreamEventMessage];
  permission_request: [sessionId: string, msg: CLIControlRequestMessage];
  error: [sessionId: string, error: Error];
  exit: [sessionId: string, code: number | null];
}

interface ManagedSession {
  info: SessionInfo;
  cliSocket: WebSocket | null;
  process: ChildProcess | null;
  pendingMessages: string[];
  readyResolve?: (value: void) => void;
  readyPromise?: Promise<void>;
  apiKey?: string;
}

/**
 * Manages Claude Code CLI processes connected via --sdk-url WebSocket.
 *
 * Spawns a local WebSocket server. Each CLI process connects back to
 * ws://localhost:{wsPort}/ws/cli/{sessionId}. Messages are NDJSON.
 */
export class CliBridge extends EventEmitter<BridgeEvents> {
  private wss: WebSocketServer;
  private wsPort: number;
  private sessions = new Map<string, ManagedSession>();
  private sessionTimeout: number;
  private reapInterval: ReturnType<typeof setInterval>;

  constructor(options: { wsPort: number; sessionTimeoutMs?: number }) {
    super();
    this.wsPort = options.wsPort;
    this.sessionTimeout = options.sessionTimeoutMs ?? 30 * 60 * 1000;

    this.wss = new WebSocketServer({ port: this.wsPort });
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));

    this.reapInterval = setInterval(() => this.reapIdleSessions(), 60_000);

    console.log(`[cli-bridge] WebSocket server listening on ws://localhost:${this.wsPort}`);
  }

  private handleConnection(ws: WebSocket, req: import("http").IncomingMessage) {
    const url = req.url || "";
    const match = url.match(/^\/ws\/cli\/([a-f0-9-]+)$/);
    if (!match) {
      ws.close(4000, "Invalid path");
      return;
    }
    const sessionId = match[1];
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      ws.close(4001, "Unknown session");
      return;
    }

    managed.cliSocket = ws;
    managed.info.state = "connected";
    console.log(`[cli-bridge] CLI connected for session ${sessionId}`);

    // Flush queued messages
    for (const ndjson of managed.pendingMessages) {
      ws.send(ndjson + "\n");
    }
    managed.pendingMessages = [];

    ws.on("message", (raw) => {
      const data = typeof raw === "string" ? raw : raw.toString("utf-8");
      const lines = data.split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        try {
          const msg: CLIMessage = JSON.parse(line);
          this.routeMessage(sessionId, managed, msg);
        } catch {
          console.warn(`[cli-bridge] Failed to parse: ${line.substring(0, 200)}`);
        }
      }
    });

    ws.on("close", () => {
      managed.cliSocket = null;
      console.log(`[cli-bridge] CLI disconnected for session ${sessionId}`);
    });

    ws.on("error", (err) => {
      console.error(`[cli-bridge] WebSocket error for session ${sessionId}:`, err.message);
    });
  }

  private routeMessage(sessionId: string, managed: ManagedSession, msg: CLIMessage) {
    switch (msg.type) {
      case "system":
        if ("subtype" in msg && msg.subtype === "init") {
          const initMsg = msg as CLISystemInitMessage;
          managed.info.cliSessionId = initMsg.session_id;
          managed.info.state = "ready";
          this.emit("ready", sessionId, initMsg);
          managed.readyResolve?.();
        }
        break;

      case "assistant":
        this.emit("assistant", sessionId, msg as CLIAssistantMessage);
        break;

      case "result":
        managed.info.state = "ready";
        managed.info.lastUsedAt = Date.now();
        this.emit("result", sessionId, msg as CLIResultMessage);
        break;

      case "stream_event":
        this.emit("stream_event", sessionId, msg as CLIStreamEventMessage);
        break;

      case "control_request": {
        const ctrlMsg = msg as CLIControlRequestMessage;
        if (ctrlMsg.request.subtype === "can_use_tool") {
          this.autoApprovePermission(managed, ctrlMsg);
        }
        break;
      }

      case "keep_alive":
        break;

      default:
        break;
    }
  }

  private autoApprovePermission(managed: ManagedSession, msg: CLIControlRequestMessage) {
    const response: ControlResponse = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: msg.request_id,
        response: {
          behavior: "allow",
          updatedInput: msg.request.input,
        },
      },
    };
    this.sendToCLI(managed, JSON.stringify(response));
  }

  spawnSession(options: {
    model?: string;
    permissionMode?: PermissionMode;
    cwd?: string;
    sessionId?: string;
    apiKey?: string;
  }): string {
    const sessionId = options.sessionId ?? randomUUID();
    const cwd = options.cwd ?? process.cwd();

    let readyResolve: ((value: void) => void) | undefined;
    const readyPromise = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });

    const managed: ManagedSession = {
      info: {
        sessionId,
        model: options.model ?? "claude-sonnet-4-5-20250929",
        permissionMode: options.permissionMode ?? "acceptEdits",
        state: "starting",
        cwd,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      },
      cliSocket: null,
      process: null,
      pendingMessages: [],
      readyResolve,
      readyPromise,
      apiKey: options.apiKey,
    };

    this.sessions.set(sessionId, managed);
    this.spawnCLI(sessionId, managed);
    return sessionId;
  }

  private spawnCLI(sessionId: string, managed: ManagedSession) {
    let binary = "claude";
    try {
      binary = execSync("which claude", { encoding: "utf-8" }).trim();
    } catch {
      // hope it's in PATH
    }

    const sdkUrl = `ws://localhost:${this.wsPort}/ws/cli/${sessionId}`;
    const args: string[] = [
      "--sdk-url", sdkUrl,
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
    ];

    if (managed.info.model) {
      args.push("--model", managed.info.model);
    }
    if (managed.info.permissionMode) {
      args.push("--permission-mode", managed.info.permissionMode);
    }

    args.push("-p", "");

    console.log(`[cli-bridge] Spawning: ${binary} ${args.join(" ")}`);

    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDECODE: "1",
    };
    if (managed.apiKey) {
      env.ANTHROPIC_API_KEY = managed.apiKey;
    }

    const proc = spawn(binary, args, {
      cwd: managed.info.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    managed.process = proc;
    managed.info.pid = proc.pid;

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.log(`[session:${sessionId}:stdout] ${text}`);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[session:${sessionId}:stderr] ${text}`);
    });

    proc.on("exit", (code) => {
      console.log(`[cli-bridge] Session ${sessionId} exited (code=${code})`);
      managed.info.state = "exited";
      this.emit("exit", sessionId, code);
    });

    proc.on("error", (err) => {
      console.error(`[cli-bridge] Process error for ${sessionId}:`, err.message);
      this.emit("error", sessionId, err);
    });
  }

  async waitForReady(sessionId: string, timeoutMs = 30_000): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error(`Session ${sessionId} not found`);
    if (managed.info.state === "ready") return;

    await Promise.race([
      managed.readyPromise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout waiting for CLI to initialize")), timeoutMs)
      ),
    ]);
  }

  sendUserMessage(sessionId: string, content: string | unknown[], cliSessionId?: string) {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error(`Session ${sessionId} not found`);

    managed.info.state = "busy";
    managed.info.lastUsedAt = Date.now();

    const msg = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: cliSessionId ?? managed.info.cliSessionId ?? "",
    };

    this.sendToCLI(managed, JSON.stringify(msg));
  }

  sendInterrupt(sessionId: string) {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;

    const msg = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "interrupt" },
    });
    this.sendToCLI(managed, msg);
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId)?.info;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async killSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;

    if (managed.process) {
      managed.process.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          managed.process?.kill("SIGKILL");
          resolve();
        }, 5000);
        managed.process?.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (managed.cliSocket) {
      managed.cliSocket.close();
    }
    this.sessions.delete(sessionId);
  }

  private sendToCLI(managed: ManagedSession, ndjson: string) {
    if (!managed.cliSocket || managed.cliSocket.readyState !== WebSocket.OPEN) {
      managed.pendingMessages.push(ndjson);
      return;
    }
    managed.cliSocket.send(ndjson + "\n");
  }

  private reapIdleSessions() {
    const now = Date.now();
    for (const [id, managed] of this.sessions) {
      if (managed.info.state === "exited") {
        this.sessions.delete(id);
        continue;
      }
      if (now - managed.info.lastUsedAt > this.sessionTimeout) {
        console.log(`[cli-bridge] Reaping idle session ${id}`);
        this.killSession(id);
      }
    }
  }

  async shutdown() {
    clearInterval(this.reapInterval);
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.killSession(id)));
    this.wss.close();
  }
}
