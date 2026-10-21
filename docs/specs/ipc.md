# IPC.md — AIR Inter-Process Communication Protocol

Status: **normative**. Implemented in Phase 9 (P9-T01). Changes require an ADR.

## 1. Overview

The AIR daemon (`aird`) and the `air` shell communicate over a **Windows named pipe** using **JSON-RPC 2.0** messages framed as **NDJSON** (one JSON object per line). The pipe is scoped to the current Windows user so that only the operator's own shell can connect to their own daemon.

## 2. Transport

| Property | Value |
|---|---|
| Mechanism | Windows named pipe (`\\.\pipe\<name>`) |
| Pipe name | `\\.\pipe\air-<username>` where `<username>` is the current Windows user |
| ACL | Pipe grants access only to the current user SID (enforced at OS level; pipe name is user-scoped) |
| Framing | NDJSON: one complete JSON-RPC 2.0 message per `\n`-terminated line |
| Max frame size | 4 MiB (4,194,304 bytes). Oversized frames are rejected. |
| Encoding | UTF-8 |
| Duplex | Full-duplex: client and server both send and receive on the same pipe connection |

## 3. Protocol Version

- Current protocol version: **1** (major version)
- `daemon.health` returns the protocol version
- Clients must refuse to connect if the server's major version differs from the client's
- Minor version changes are additive and backward compatible

## 4. Message Format

All messages are JSON-RPC 2.0. Each line is exactly one message.

### 4.1 Request (client → server)

```json
{
  "jsonrpc": "2.0",
  "method": "daemon.health",
  "params": { ... },
  "id": "1"
}
```

- `jsonrpc`: must be `"2.0"`
- `method`: method name string
- `params`: optional object of named parameters
- `id`: required for requests (string or number); used to match responses

### 4.2 Notification (client → server or server → client)

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": { ... }
}
```

- No `id` field. Notifications are not answered.

### 4.3 Success Response (server → client)

```json
{
  "jsonrpc": "2.0",
  "result": { ... },
  "id": "1"
}
```

### 4.4 Error Response (server → client)

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32601,
    "message": "Method not found",
    "data": null
  },
  "id": "1"
}
```

### 4.5 Standard JSON-RPC Error Codes

| Code | Message | Meaning |
|---|---|---|
| -32700 | Parse error | Invalid JSON received |
| -32600 | Invalid Request | Not a valid JSON-RPC request |
| -32601 | Method not found | Method does not exist |
| -32602 | Invalid params | Parameters failed validation |
| -32603 | Internal error | Internal server error |

### 4.6 AIR-Defined Server Error Codes

| Code | Message | Meaning |
|---|---|---|
| -32000 | Pipe connection failed | Could not establish pipe connection |
| -32001 | Pipe closed | Pipe connection was closed |
| -32002 | Request timeout | Request timed out waiting for response |
| -32003 | Protocol version mismatch | Client/server protocol versions incompatible |
| -32004 | Frame too large | Message exceeds 4 MiB limit |
| -32005 | Unauthorized | Caller not authorized for this method |

## 5. Methods

### 5.1 Daemon methods

#### `daemon.health`

Returns daemon status and protocol version.

**Request:** `{}`  
**Response:**
```json
{
  "protocolVersion": 1,
  "status": "healthy",
  "uptimeMs": 12345,
  "activeRuns": 2,
  "version": "0.0.0"
}
```

#### `daemon.shutdown`

Requests graceful daemon shutdown.

**Request:** `{}`  
**Response:** `{ "ok": true }`

### 5.2 Session methods

#### `session.create`

Create a new session.

**Request:** `{ "agentId": "..." }`  
**Response:** `{ "sessionId": "..." }`

#### `session.list`

List active sessions.

**Request:** `{}`  
**Response:** `{ "sessions": [ { "sessionId": "...", "agentId": "...", "createdAt": "..." } ] }`

### 5.3 Run methods

#### `run.start`

Start a new agent run.

**Request:** `{ "sessionId": "...", "agentId": "...", "goal": "..." }`  
**Response:** `{ "runId": "..." }`

#### `run.cancel`

Cancel a running agent run.

**Request:** `{ "runId": "..." }`  
**Response:** `{ "ok": true }`

#### `run.pause`

Pause a running agent run.

**Request:** `{ "runId": "..." }`  
**Response:** `{ "ok": true }`

#### `run.resume`

Resume a paused agent run.

**Request:** `{ "runId": "..." }`  
**Response:** `{ "ok": true }`

#### `run.list`

List runs (optionally filtered by session).

**Request:** `{ "sessionId": "..." }`  
**Response:** `{ "runs": [ { "runId": "...", "status": "...", "createdAt": "..." } ] }`

#### `run.get`

Get run details and current state.

**Request:** `{ "runId": "..." }`  
**Response:** `{ "run": { ... } }`

#### `run.replay`

Replay a completed run from the journal.

**Request:** `{ "runId": "..." }`  
**Response:** `{ "runId": "...", "events": [ ... ] }`

### 5.4 Approval methods

#### `approval.list`

List pending approval requests.

**Request:** `{}`  
**Response:** `{ "approvals": [ { "approvalId": "...", "tool": "...", "reason": "...", "createdAt": "..." } ] }`

#### `approval.resolve`

Approve or deny a pending approval.

**Request:** `{ "approvalId": "...", "decision": "approve" \| "deny", "reason": "..." }`  
**Response:** `{ "ok": true }`

### 5.5 Logs methods

#### `logs.tail`

Tail recent log records.

**Request:** `{ "stream": "runtime", "limit": 100 }`  
**Response:** `{ "records": [ ... ] }`

### 5.6 Config methods

#### `config.get`

Get effective configuration value.

**Request:** `{ "key": "logging.level" }`  
**Response:** `{ "value": "info", "source": "defaults" }`

#### `config.explain`

Explain configuration provenance for a key.

**Request:** `{ "key": "logging.level" }`  
**Response:** `{ "key": "...", "value": "...", "provenance": [ ... ] }`

## 6. Notifications (server → client)

### 6.1 `event`

Live journal events pushed to subscribed clients. The client subscribes via `session.create` or a dedicated subscription mechanism; the server pushes `event` notifications as journal events occur.

**Params:**
```json
{
  "subscriptionId": "...",
  "event": { ...event envelope... }
}
```

### 6.2 `approval.requested`

Push notification when a tool execution requires operator approval.

**Params:**
```json
{
  "approvalId": "...",
  "runId": "...",
  "tool": "fs.write",
  "args": { ... },
  "reason": "Policy requires approval for medium-risk write",
  "createdAt": "..."
}
```

## 7. Connection Lifecycle

1. Client connects to `\\.\pipe\air-<username>`
2. Client sends `daemon.health` to verify protocol version compatibility
3. Client sends requests and receives responses
4. Server pushes `event` and `approval.requested` notifications asynchronously
5. Either side may close the connection at any time
6. Server handles `daemon.shutdown` by closing all connections and exiting

## 8. Error Handling

- Malformed JSON → parse error (-32700), connection may be closed
- Unknown method → method not found (-32601)
- Invalid parameters → invalid params (-32602)
- Request timeout → request timeout (-32002)
- Frame exceeds 4 MiB → frame too large (-32004), connection closed
- Unauthorized access → unauthorized (-32005)
- All errors returned as JSON-RPC error responses with `id` matching the request (or `null` for parse errors)

## 9. Security

- **User scoping**: Pipe name includes the Windows username, so different users have different pipes
- **ACL**: Named pipe ACL grants access only to the current user SID
- **Frame size limit**: 4 MiB maximum to prevent memory exhaustion
- **No secrets**: API keys and secrets are never transmitted in method params or results; secrets are referenced by name only
- **Input validation**: All method parameters validated with Zod schemas before handling

## 10. Implementation Notes

- Transport layer: Node.js `net` module with Windows named pipe support
- Framing: Line-delimited JSON with `\n` terminator; buffer accumulates until newline or max size
- Concurrency: Each pipe connection handled independently; requests matched to responses by `id`
- Determinism: Protocol layer does not use `Date.now()` or `Math.random()` directly; uses injected `Clock` and `IdGenerator` where needed (Rule R6)
- Logging: All IPC actions logged via `src/observability` with correlation IDs (Rule R1)
