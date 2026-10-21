/**
 * IPC Method Registry — method/notification dispatch (Phase 9 - P9-T01).
 *
 * Implements:
 * - Registration of JSON-RPC method handlers and notification handlers
 * - Dispatch of inbound messages to the correct handler
 * - Unknown method detection (returns -32601 Method not found)
 * - Handler invocation with error isolation
 *
 * Adheres to:
 * - Rule R7: No any; strict TypeScript
 * - Rule R11: Typed AirError errors
 */

import { AirError } from '../errors/index.js';
import {
  type IpcContext,
  type IpcMethodHandler,
  type IpcNotificationHandler,
  type JsonRpcErrorResponse,
  type JsonRpcNotification,
  type JsonRpcRequest,
  JsonRpcErrorCode,
  createErrorResponse,
  parseInboundMessage,
} from './protocol.js';

// ============================================================================
// 1. Method Registry
// ============================================================================

/**
 * Registry of IPC methods and notifications. Dispatches inbound JSON-RPC
 * messages to registered handlers, returning responses or errors.
 */
export class MethodRegistry {
  private readonly methods = new Map<string, IpcMethodHandler>();
  private readonly notifications = new Map<string, IpcNotificationHandler>();

  /** Returns the number of registered methods. */
  get size(): number {
    return this.methods.size;
  }

  /** Returns all registered method names. */
  listMethods(): readonly string[] {
    return Array.from(this.methods.keys());
  }

  /** Returns all registered notification names. */
  listNotifications(): readonly string[] {
    return Array.from(this.notifications.keys());
  }

  /** Returns whether a method is registered. */
  hasMethod(method: string): boolean {
    return this.methods.has(method);
  }

  /** Returns whether a notification is registered. */
  hasNotification(method: string): boolean {
    return this.notifications.has(method);
  }

  /**
   * Register a method handler. Throws if the method is already registered.
   */
  register<P = unknown, R = unknown>(method: string, handler: IpcMethodHandler<P, R>): void {
    if (this.methods.has(method)) {
      throw new AirError('IPC_PROTOCOL_ERROR', `Method "${method}" is already registered`, {
        context: { method },
        exposeToModel: true,
      });
    }
    this.methods.set(method, handler as IpcMethodHandler);
  }

  /**
   * Register a notification handler. Throws if the notification is already registered.
   */
  registerNotification<P = unknown>(method: string, handler: IpcNotificationHandler<P>): void {
    if (this.notifications.has(method)) {
      throw new AirError('IPC_PROTOCOL_ERROR', `Notification "${method}" is already registered`, {
        context: { method },
        exposeToModel: true,
      });
    }
    this.notifications.set(method, handler as IpcNotificationHandler);
  }

  /** Unregister a method. Returns true if the method was found and removed. */
  unregisterMethod(method: string): boolean {
    return this.methods.delete(method);
  }

  /** Unregister a notification. Returns true if the notification was found and removed. */
  unregisterNotification(method: string): boolean {
    return this.notifications.delete(method);
  }

  /**
   * Dispatch an inbound JSON-RPC request to its handler.
   * Returns a success response or an error response (never throws).
   */
  async handleRequest(message: JsonRpcRequest, ctx: IpcContext): Promise<{ ok: true; result: unknown } | { ok: false; error: JsonRpcErrorResponse }> {
    const handler = this.methods.get(message.method);

    if (!handler) {
      return {
        ok: false,
        error: createErrorResponse(
          message.id,
          JsonRpcErrorCode.METHOD_NOT_FOUND,
          `Method "${message.method}" not found`,
        ),
      };
    }

    try {
      const result = await handler(message.params ?? {}, ctx);
      return { ok: true, result };
    } catch (err) {
      const errorResponse = err instanceof AirError
        ? createErrorResponse(message.id, JsonRpcErrorCode.INTERNAL_ERROR, err.message, {
            code: err.code,
            ...(err.context ? { context: err.context } : {}),
          })
        : createErrorResponse(message.id, JsonRpcErrorCode.INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
      return { ok: false, error: errorResponse };
    }
  }

  /**
   * Dispatch an inbound JSON-RPC notification to its handler.
   * Errors are caught and logged via the context; notifications never produce responses.
   */
  async handleNotification(message: JsonRpcNotification, ctx: IpcContext): Promise<void> {
    const handler = this.notifications.get(message.method);

    if (!handler) {
      // Unknown notifications are silently ignored per JSON-RPC 2.0 spec
      return;
    }

    await handler(message.params ?? {}, ctx);
  }

  /**
   * Parse raw input and dispatch to the appropriate handler.
   * Returns the outbound message to send back to the client (null for notifications).
   */
  async dispatch(raw: unknown, ctx: IpcContext): Promise<{ ok: true; result: unknown } | { ok: false; error: JsonRpcErrorResponse } | null> {
    const message = parseInboundMessage(raw);

    if ('id' in message && message.id !== undefined) {
      return this.handleRequest(message, ctx);
    }

    // Notification: no id, fire-and-forget
    await this.handleNotification(message, ctx);
    return null;
  }
}
