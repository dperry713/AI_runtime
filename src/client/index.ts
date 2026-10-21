/**
 * Client module entry point (Phase 9 - P9-T03).
 *
 * Public API:
 * - `AirClient` — typed IPC client with method wrappers for all IPC methods
 * - `AirClientOptions` — client construction options
 * - Notification types: `EventNotification`, `ApprovalRequestedNotification`
 * - All request/response types
 *
 * Layer 8 per ARCHITECTURE.md §3: may import layers 0–7 only through their index.ts.
 */

export { AirClient, type AirClientOptions } from './air-client.js';
export type {
  EventNotification,
  ApprovalRequestedNotification,
  HealthResponse,
  ShutdownResponse,
  SessionCreateRequest,
  SessionCreateResponse,
  SessionListResponse,
  RunStartRequest,
  RunStartResponse,
  RunIdRequest,
  RunOkResponse,
  RunListRequest,
  RunListResponse,
  RunGetResponse,
  RunReplayResponse,
  ApprovalListResponse,
  ApprovalResolveRequest,
  ApprovalResolveResponse,
  LogsTailRequest,
  LogsTailResponse,
  ConfigGetRequest,
  ConfigGetResponse,
  ConfigExplainRequest,
  ConfigExplainResponse,
} from './air-client.js';
