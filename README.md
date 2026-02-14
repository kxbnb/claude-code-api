# ccc-api

Anthropic-compatible REST API that wraps the Claude Code CLI via its `--sdk-url` WebSocket protocol. Spawn a server, hit `POST /v1/messages`, and get responses in the same format as the Anthropic Messages API.

## Quick Start

```bash
npm install
npm run dev
```

Server starts on `http://localhost:3457`. Requires `claude` CLI installed and authenticated.

## API

### `POST /v1/messages`

Drop-in compatible with the [Anthropic Messages API](https://docs.anthropic.com/en/api/messages).

```bash
curl -X POST http://localhost:3457/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

#### Streaming

Set `"stream": true` to get Server-Sent Events matching the Anthropic streaming format:

```bash
curl -N -X POST http://localhost:3457/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

#### Authentication

Pass an Anthropic API key via header. The key is forwarded to the spawned CLI process as `ANTHROPIC_API_KEY`:

```bash
curl -X POST http://localhost:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-ant-..." \
  -d '{"model": "claude-sonnet-4-5-20250929", "max_tokens": 100, "messages": [{"role": "user", "content": "Hello"}]}'
```

Also accepts `Authorization: Bearer <key>`. If no key is provided, the CLI uses whatever credentials are configured on the host (e.g. OAuth from `claude login`).

#### Session Continuity (non-standard)

The Anthropic API is stateless — you send the full `messages[]` array every request. This API supports that.

Additionally, since each request is backed by a live CLI process, you can reuse sessions. The response includes an `x-session-id` header. Pass it back on subsequent requests to continue the conversation without resending history:

```bash
# First request — new session
curl -D - -X POST http://localhost:3457/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4-5-20250929", "max_tokens": 100, "messages": [{"role": "user", "content": "Remember: the code is 42."}]}'
# Response header: x-session-id: abc-123-...

# Follow-up — reuse session, send only the new message
curl -X POST http://localhost:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-session-id: abc-123-..." \
  -d '{"model": "claude-sonnet-4-5-20250929", "max_tokens": 100, "messages": [{"role": "user", "content": "What was the code?"}]}'
```

Sessions are reaped after 30 minutes of inactivity (configurable via `SESSION_TIMEOUT_MS`).

#### Permission Mode

Control how the CLI handles tool permissions via the `x-permission-mode` header. Default is `acceptEdits`.

```bash
curl -X POST http://localhost:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-permission-mode: bypassPermissions" \
  -d '...'
```

### `GET /health`

Returns `{"status": "ok"}`.

## Configuration

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3457` | HTTP server port |
| `WS_PORT` | `3458` | Internal WebSocket port for CLI connections |
| `SESSION_TIMEOUT_MS` | `1800000` | Idle session reap timeout (30 min) |

## Docker

```bash
docker build -t ccc-api .
docker run -p 3457:3457 -e ANTHROPIC_API_KEY=sk-ant-... ccc-api
```

Or with Docker Compose:

```bash
ANTHROPIC_API_KEY=sk-ant-... docker compose up
```

## Deploy to Fly.io

```bash
fly launch
fly deploy
# SSH in to authenticate with OAuth if needed:
fly ssh console
claude login
```

## How It Works

1. Server starts an internal WebSocket server on `WS_PORT`
2. On each request, a Claude Code CLI process is spawned with `--sdk-url ws://localhost:WS_PORT/ws/cli/SESSION_ID`
3. The CLI connects back over WebSocket using NDJSON protocol
4. User messages are translated and forwarded to the CLI
5. CLI responses are translated back to Anthropic Messages API format
6. Tool permission requests are auto-approved
