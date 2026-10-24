/**
 * Windows Filtering Platform (WFP) client for sandbox egress enforcement.
 *
 * Communicates with the native `air-sandbox.exe` helper via its versioned
 * JSON stdin/stdout protocol to add/remove/list WFP filters at the kernel
 * level. On modern Windows, `netsh advfirewall` operates on top of WFP,
 * providing kernel-enforced packet filtering that cannot be bypassed by
 * child processes ignoring HTTP_PROXY/HTTPS_PROXY environment variables.
 *
 * The WFP enforcement is the authoritative egress boundary. The existing
 * `EgressProxy` remains as a convenience layer for SSRF prevention and DNS
 * inspection, but is no longer the sole boundary.
 *
 * Adheres to:
 * - Rule R1: Structured logging via src/observability
 * - Rule R2: Process execution boundaries (sandbox helper)
 * - Rule R7: Strict TypeScript, no any
 * - Rule R11: Typed AirError errors
 */

import { spawn } from 'node:child_process';
import { AirError } from '../errors/index.js';
import { getLogger, type ComponentLogger } from '../observability/index.js';

const defaultLogger = getLogger('wfp-client');

export const WFP_PROTOCOL_VERSION = 1;

export interface WfpFilterSpec {
  /** Human-readable filter name. */
  readonly name: string;
  /** IP protocol (6 = TCP, 17 = UDP, 255 = any). */
  readonly ipProtocol?: number | undefined;
  /** Remote port or port range (e.g. "443" or "1024-65535"). */
  readonly remotePort?: string | undefined;
  /** Remote address prefix (CIDR, e.g. "0.0.0.0/0" or specific IP). */
  readonly remoteAddress?: string | undefined;
  /** Local port or port range. */
  readonly localPort?: string | undefined;
  /** Local address prefix (CIDR). */
  readonly localAddress?: string | undefined;
  /** AppContainer SID to scope the filter to (optional). */
  readonly appContainerSid?: string | undefined;
  /** Package family name to scope the filter to (optional). */
  readonly packageFamilyName?: string | undefined;
  /** Action: "block" or "permit". */
  readonly action: 'block' | 'permit';
}

export interface WfpFilterResult {
  readonly filterId: number;
  readonly name: string;
  readonly success: boolean;
  readonly message: string;
}

export interface WfpClientOptions {
  readonly helperPath?: string | undefined;
  readonly logger?: ComponentLogger | undefined;
  /** Optional mock handler for testing (bypasses spawning air-sandbox.exe). */
  readonly mockHandler?: ((request: WfpRequest) => Promise<WfpResponse>) | undefined;
}

export type WfpRequest =
  | { readonly op: 'add_filter'; readonly filter: WfpFilterSpec }
  | { readonly op: 'remove_filter'; readonly filterId: number }
  | { readonly op: 'list_filters' };

export type WfpResponse =
  | { readonly type: 'wfp_filter_added'; readonly version: number; readonly filterId: number; readonly name: string }
  | { readonly type: 'wfp_filter_removed'; readonly version: number; readonly filterId: number; readonly success: boolean }
  | { readonly type: 'wfp_filters_listed'; readonly version: number; readonly filters: readonly WfpFilterResult[] }
  | { readonly type: 'error'; readonly version: number; readonly code: string; readonly message: string };

/**
 * WFP client for managing kernel-level egress filters via air-sandbox.exe.
 */
export class WfpClient {
  private readonly helperPath: string;
  private readonly logger: ComponentLogger;
  private readonly mockHandler?: ((request: WfpRequest) => Promise<WfpResponse>) | undefined;

  constructor(options: WfpClientOptions = {}) {
    this.helperPath = options.helperPath ?? 'air-sandbox.exe';
    this.logger = options.logger ?? defaultLogger;
    this.mockHandler = options.mockHandler;
  }

  /**
   * Adds a WFP filter to block or permit outbound connections at the kernel level.
   */
  async addFilter(spec: WfpFilterSpec): Promise<WfpFilterResult> {
    const request: WfpRequest = { op: 'add_filter', filter: spec };
    const response = await this.sendRequest(request);

    if (response.type === 'wfp_filter_added') {
      this.logger.info(
        {
          event: 'sandbox.wfp.filter_added',
          filterId: response.filterId,
          name: response.name,
          action: spec.action,
        },
        `WFP filter added: ${response.name} (id=${response.filterId})`,
      );
      return {
        filterId: response.filterId,
        name: response.name,
        success: true,
        message: 'WFP filter added successfully',
      };
    }

    if (response.type === 'error') {
      throw new AirError(
        'SANDBOX_VIOLATION',
        `WFP add filter failed: ${response.message}`,
        { context: { code: response.code, filter: spec } },
      );
    }

    throw new AirError(
      'SANDBOX_VIOLATION',
      `Unexpected WFP response type: ${(response as { readonly type: string }).type}`,
      { context: { filter: spec } },
    );
  }

  /**
   * Removes a WFP filter by ID.
   */
  async removeFilter(filterId: number): Promise<boolean> {
    const request: WfpRequest = { op: 'remove_filter', filterId };
    const response = await this.sendRequest(request);

    if (response.type === 'wfp_filter_removed') {
      this.logger.info(
        { event: 'sandbox.wfp.filter_removed', filterId, success: response.success },
        `WFP filter removed: id=${filterId} success=${response.success}`,
      );
      return response.success;
    }

    if (response.type === 'error') {
      throw new AirError(
        'SANDBOX_VIOLATION',
        `WFP remove filter failed: ${response.message}`,
        { context: { code: response.code, filterId } },
      );
    }

    throw new AirError(
      'SANDBOX_VIOLATION',
      `Unexpected WFP response type: ${(response as { readonly type: string }).type}`,
      { context: { filterId } },
    );
  }

  /**
   * Lists all active WFP filters.
   */
  async listFilters(): Promise<readonly WfpFilterResult[]> {
    const request: WfpRequest = { op: 'list_filters' };
    const response = await this.sendRequest(request);

    if (response.type === 'wfp_filters_listed') {
      return response.filters;
    }

    if (response.type === 'error') {
      throw new AirError(
        'SANDBOX_VIOLATION',
        `WFP list filters failed: ${response.message}`,
        { context: { code: response.code } },
      );
    }

    throw new AirError(
      'SANDBOX_VIOLATION',
      `Unexpected WFP response type: ${(response as { readonly type: string }).type}`,
      { context: {} },
    );
  }

  /**
   * Sends a WFP request to the air-sandbox.exe helper and waits for a response.
   * If a mockHandler is configured, uses it instead of spawning the helper.
   */
  private async sendRequest(request: WfpRequest): Promise<WfpResponse> {
    // Mock handler for testing (bypasses spawning air-sandbox.exe)
    if (this.mockHandler) {
      return this.mockHandler(request);
    }

    return new Promise<WfpResponse>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.helperPath, [], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err: unknown) {
        return reject(
          new AirError(
            'TOOL_EXECUTION_FAILED',
            `Failed to launch sandbox helper "${this.helperPath}": ${(err as Error).message}`,
            { cause: err instanceof Error ? err : undefined },
          ),
        );
      }

      if (!child.stdin || !child.stdout || !child.stderr) {
        return reject(
          new AirError('TOOL_EXECUTION_FAILED', 'Failed to initialize stdio pipes for sandbox helper'),
        );
      }

      const childStdin = child.stdin;
      const childStdout = child.stdout;
      const childStderr = child.stderr;

      let stdoutAccum = '';
      let stderrAccum = '';
      let resolved = false;

      const cleanup = (): void => {
        try {
          child.kill();
        } catch {
          // Ignore
        }
      };

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new AirError('TOOL_TIMEOUT', 'WFP request timed out'));
        }
      }, 10_000);

      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      childStdin.write(JSON.stringify(request) + '\n', () => {
        childStdin.end();
      });

      childStdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        stdoutAccum += text;
        const lines = stdoutAccum.split('\n');
        stdoutAccum = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;

          try {
            const resp = JSON.parse(trimmed) as WfpResponse;
            if (
              resp &&
              (resp.type === 'wfp_filter_added' ||
                resp.type === 'wfp_filter_removed' ||
                resp.type === 'wfp_filters_listed' ||
                resp.type === 'error')
            ) {
              if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                cleanup();
                resolve(resp);
              }
              return;
            }
          } catch {
            // Not a JSON protocol line - ignore
          }
        }
      });

      childStderr.on('data', (chunk: Buffer) => {
        stderrAccum += chunk.toString('utf-8');
      });

      child.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          cleanup();
          reject(
            new AirError('TOOL_EXECUTION_FAILED', `Sandbox helper process error: ${err.message}`, {
              cause: err,
            }),
          );
        }
      });

      child.on('close', (code: number | null) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          cleanup();
          reject(
            new AirError(
              'TOOL_EXECUTION_FAILED',
              `Sandbox helper exited with code ${code ?? -1} before WFP response: ${stderrAccum}`,
            ),
          );
        }
      });
    });
  }
}

/**
 * Creates a default WFP block rule for all outbound traffic from a process.
 * This is the default-deny rule that ensures no outbound connections are
 * possible unless explicitly permitted by an allow rule.
 */
export function createDefaultDenyFilter(processName: string): WfpFilterSpec {
  return {
    name: `AIR WFP Default Deny ${processName}`,
    ipProtocol: 255, // any
    remoteAddress: '0.0.0.0/0',
    action: 'block',
  };
}

/**
 * Creates a WFP permit rule for outbound traffic to an allowlisted host.
 */
export function createAllowFilter(
  name: string,
  remoteAddress: string,
  remotePort: string,
  ipProtocol: number = 6, // TCP
): WfpFilterSpec {
  return {
    name: `AIR WFP Allow ${name}`,
    ipProtocol,
    remoteAddress,
    remotePort,
    action: 'permit',
  };
}
