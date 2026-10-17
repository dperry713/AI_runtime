/**
 * Tool Test Kit & Schema Fuzz Harness (P4-T08).
 *
 * Provides:
 * - ToolTestKit: Complete sandbox test environment with fake clock, deterministic random,
 *   isolated filesystem jail, mock policy hook, and wired ToolExecutor.
 * - SchemaFuzzer: Adversarial fuzzing harness for tool input schemas.
 * - WINDOWS_PATH_TRAVERSAL_CORPUS: Comprehensive corpus of ≥ 100 Windows-specific traversal cases.
 * - SSRF_TEST_CORPUS: Comprehensive corpus of SSRF attacking URLs and obfuscated IPs.
 */

import type { Clock, Random } from '../util/index.js';
import { FakeClock, SeededRandom } from '../util/index.js';
import { BUILTIN_EXEC_TOOLS } from './builtin/exec.js';
import { BUILTIN_FS_TOOLS } from './builtin/fs.js';
import { BUILTIN_HTTP_TOOLS } from './builtin/http.js';
import { BUILTIN_INTERACTION_TOOLS } from './builtin/interaction.js';
import type { AnyTool, ToolDefinition, ToolExecutionResult } from './contract.js';
import type {
  ToolExecutionRequest,
  ToolPolicyDecision,
  ToolPolicyEvaluationContext,
  ToolPolicyHook,
} from './executor.js';
import { ToolExecutor } from './executor.js';
import { ToolRegistry } from './registry.js';

// ============================================================================
// Windows Path Traversal Corpus (≥ 100 Cases)
// ============================================================================

export const WINDOWS_PATH_TRAVERSAL_CORPUS: readonly string[] = [
  // 1-10: Basic dot-dot traversals
  '..',
  '../',
  '..\\',
  '../..',
  '..\\..',
  '../../..',
  '..\\..\\..',
  '../../../../..',
  '..\\..\\..\\..\\..',
  '../file.txt',

  // 11-20: Mixed slash traversals
  '..\\../file.txt',
  '../..\\file.txt',
  '..\\..\\/file.txt',
  '/../../windows/system32',
  '\\..\\..\\windows\\system32',
  'sub/../../windows',
  'sub\\..\\..\\windows',
  'a/b/../../../c',
  'a\\b\\..\\..\\..\\c',
  './../file.txt',

  // 21-30: Multiple dots and dot-spacing
  '...',
  '....',
  '.../',
  '...\\',
  '..../..../',
  '....\\....\\',
  '.. /',
  '.. \\',
  '../ ./../',
  '..\\ .\\..\\',

  // 31-40: Trailing dots and spaces (Windows stripping vulnerability)
  'file.txt.',
  'file.txt..',
  'file.txt...',
  'file.txt ',
  'file.txt  ',
  'file.txt .',
  'file.txt. ',
  'file.txt. .',
  'dir./file.txt',
  'dir /file.txt',

  // 41-55: DOS / Windows reserved device names (standard)
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',

  // 56-70: Reserved device names with extensions and subpaths
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
  'CON.txt',
  'PRN.txt',
  'AUX.json',
  'NUL.log',
  'com1.txt',
  'lpt1.dat',
  'con/file.txt',
  'aux\\file.txt',

  // 71-80: NTFS Alternate Data Streams (ADS)
  'file.txt:stream',
  'file.txt:stream:$DATA',
  'file.txt:$DATA',
  'file.txt::$DATA',
  'dir::$INDEX_ALLOCATION',
  'dir:$INDEX_ALLOCATION',
  'file.txt:evil.exe',
  'sub/file.txt:stream',
  'sub\\file.txt:stream',
  'test.txt::$INDEX_ALLOCATION',

  // 81-90: Absolute paths (Drive letters)
  'C:\\',
  'C:/',
  'C:\\Windows',
  'C:/Windows',
  'C:\\Windows\\System32\\calc.exe',
  'C:/Windows/System32/cmd.exe',
  'D:\\data.txt',
  'D:/data.txt',
  'Z:\\secret.key',
  'C:file.txt', // Drive-relative

  // 91-100: UNC paths and Device namespaces
  '\\\\server\\share',
  '//server/share',
  '\\\\server\\share\\file.txt',
  '//server/share/file.txt',
  '\\\\?\\C:\\Windows',
  '\\\\.\\C:\\Windows',
  '\\\\?\\UNC\\server\\share',
  '\\\\.\\PhysicalDrive0',
  '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}',
  '\\Device\\HarddiskVolume1',

  // 101-110: Null bytes, control characters, URL-encoded forms
  'file.txt\0.jpg',
  '..\0\\file.txt',
  '..%2f..%2ffile.txt',
  '..%5c..%5cfile.txt',
  '%2e%2e%2f',
  '%2e%2e%5c',
  '..%252f',
  '..%255c',
  'file.txt\r\n',
  'file.txt\t',
];

// ============================================================================
// SSRF Test Corpus
// ============================================================================

export const SSRF_TEST_CORPUS: readonly string[] = [
  // IPv4 Loopback (various representations)
  'http://127.0.0.1/',
  'http://127.0.0.2:8080/',
  'http://127.255.255.254/',
  'http://127.1/',
  'http://2130706433/', // decimal dword for 127.0.0.1
  'http://0x7f000001/', // hex for 127.0.0.1
  'http://0177.0.0.1/', // octal for 127.0.0.1

  // RFC1918 Private
  'http://10.0.0.1/',
  'http://10.255.255.255/',
  'http://172.16.0.1/',
  'http://172.31.255.254/',
  'http://192.168.0.1/',
  'http://192.168.1.1:8443/',

  // Link-Local & Cloud Metadata
  'http://169.254.169.254/',
  'http://169.254.169.254/latest/meta-data/',
  'http://169.254.1.1/',
  'http://2852039166/', // dword for 169.254.169.254

  // Carrier-Grade NAT
  'http://100.64.0.1/',
  'http://100.127.255.254/',

  // IPv6 Loopback, ULA, Link-local, Mapped
  'http://[::1]/',
  'http://[::1]:8080/admin',
  'http://[fc00::1]/',
  'http://[fd12:3456::1]/',
  'http://[fe80::1]/',
  'http://[::ffff:127.0.0.1]/',
  'http://[::ffff:169.254.169.254]/',

  // Local domains
  'http://localhost/',
  'http://localhost:3000/',
  'http://sub.localhost/',
  'http://router.local/',
  'http://db.internal/',
  'http://metadata.google.internal/',

  // Forbidden schemes
  'file:///etc/passwd',
  'file:///C:/Windows/win.ini',
  'ftp://ftp.example.com/',
  'gopher://gopher.example.com/',
];

// ============================================================================
// Tool Test Kit
// ============================================================================

export interface ToolTestKitOptions {
  readonly clock?: Clock | undefined;
  readonly random?: Random | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly defaultDecision?: 'allow' | 'deny' | 'ask_user' | undefined;
  readonly defaultDecisionReason?: string | undefined;
  readonly tools?: readonly AnyTool[] | undefined;
}

export class ToolTestKit {
  public readonly clock: FakeClock;
  public readonly random: SeededRandom;
  public readonly workspaceRoot: string;
  public readonly registry: ToolRegistry;
  public readonly executor: ToolExecutor;
  public readonly recordedDecisions: ToolPolicyEvaluationContext[] = [];

  private currentDecision: 'allow' | 'deny' | 'ask_user';
  private currentDecisionReason?: string | undefined;

  public constructor(options?: ToolTestKitOptions) {
    this.clock = options?.clock instanceof FakeClock ? options.clock : new FakeClock('2026-10-17T12:00:00.000Z');
    this.random = options?.random instanceof SeededRandom ? options.random : new SeededRandom(42);
    this.workspaceRoot = options?.workspaceRoot ?? `C:\\temp\\air-test-${this.clock.now().getTime()}`;
    this.currentDecision = options?.defaultDecision ?? 'allow';
    this.currentDecisionReason = options?.defaultDecisionReason;

    this.registry = new ToolRegistry();

    // Register all standard built-ins by default
    const allBuiltins: readonly AnyTool[] = options?.tools ?? [
      ...BUILTIN_FS_TOOLS,
      ...BUILTIN_EXEC_TOOLS,
      ...BUILTIN_HTTP_TOOLS,
      ...BUILTIN_INTERACTION_TOOLS,
    ];

    for (const tool of allBuiltins) {
      this.registry.register(tool);
    }

    const policyHook: ToolPolicyHook = {
      evaluate: (ctx) => {
        this.recordedDecisions.push(ctx);
        const decision: ToolPolicyDecision = {
          allowed: this.currentDecision === 'allow',
          decisionId: `dec-testkit-${this.recordedDecisions.length}`,
          reason: this.currentDecisionReason ?? `Decision: ${this.currentDecision}`,
        };
        return Promise.resolve(decision);
      },
    };

    this.executor = new ToolExecutor({
      registry: this.registry,
      clock: this.clock,
      random: this.random,
      policyHook,
    });
  }

  /**
   * Sets the policy hook decision for subsequent executions.
   */
  public setPolicyDecision(action: 'allow' | 'deny' | 'ask_user', reason?: string): void {
    this.currentDecision = action;
    this.currentDecisionReason = reason;
  }

  /**
   * Executes a tool via the configured executor with standard test context.
   */
  public async execute<TOutput = unknown, TInput = unknown>(
    request: ToolExecutionRequest<TInput, TOutput>,
  ): Promise<ToolExecutionResult<TOutput>> {
    return this.executor.execute<TOutput, TInput>({
      ...request,
      workspaceRoot: request.workspaceRoot ?? this.workspaceRoot,
    });
  }
}

/**
 * Creates a configured ToolTestKit instance.
 */
export function createToolTestKit(options?: ToolTestKitOptions): ToolTestKit {
  return new ToolTestKit(options);
}

// ============================================================================
// Schema Fuzz Harness
// ============================================================================

export interface SchemaFuzzResult {
  readonly testedMutations: number;
  readonly rejectedCount: number;
  readonly unexpectedErrors: readonly Error[];
}

/**
 * Generates an adversarial set of inputs against any Zod schema and asserts
 * clean schema rejection (no unhandled exceptions or crashes).
 */
export function fuzzToolSchema<TInput, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
  validSample: TInput,
): SchemaFuzzResult {
  const schema = tool.inputSchema;
  let tested = 0;
  let rejected = 0;
  const unexpectedErrors: Error[] = [];

  const invalidCandidates: unknown[] = [
    null,
    undefined,
    12345,
    'not an object',
    [],
    true,
    false,
    Symbol('fuzz'),
    {},
  ];

  // If validSample is an object, test mutating each property
  if (typeof validSample === 'object' && validSample !== null) {
    const record = validSample as Record<string, unknown>;

    for (const key of Object.keys(record)) {
      // 1. Missing required field
      const missing = { ...record };
      delete missing[key];
      invalidCandidates.push(missing);

      // 2. Wrong types for property
      invalidCandidates.push({ ...record, [key]: null });
      invalidCandidates.push({ ...record, [key]: undefined });
      invalidCandidates.push({ ...record, [key]: 123456 });
      invalidCandidates.push({ ...record, [key]: true });
      invalidCandidates.push({ ...record, [key]: ['unexpected', 'array'] });
      invalidCandidates.push({ ...record, [key]: { nested: 'object' } });

      // 3. String mutations if value is string
      if (typeof record[key] === 'string') {
        invalidCandidates.push({ ...record, [key]: '' });
        invalidCandidates.push({ ...record, [key]: '\0' });
        invalidCandidates.push({ ...record, [key]: 'A'.repeat(500_000) }); // Massive string
        invalidCandidates.push({ ...record, [key]: 'CON' });
        invalidCandidates.push({ ...record, [key]: '../../../../Windows' });
        invalidCandidates.push({ ...record, [key]: 'http://127.0.0.1/' });
      }

      // 4. Number mutations if value is number
      if (typeof record[key] === 'number') {
        invalidCandidates.push({ ...record, [key]: -1 });
        invalidCandidates.push({ ...record, [key]: 0 });
        invalidCandidates.push({ ...record, [key]: 1.5 });
        invalidCandidates.push({ ...record, [key]: Number.NaN });
        invalidCandidates.push({ ...record, [key]: Number.POSITIVE_INFINITY });
        invalidCandidates.push({ ...record, [key]: Number.MAX_SAFE_INTEGER });
      }
    }
  }

  for (const candidate of invalidCandidates) {
    tested += 1;
    try {
      const parsed = schema.safeParse(candidate);
      if (!parsed.success) {
        rejected += 1;
      }
    } catch (err: unknown) {
      unexpectedErrors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }

  return {
    testedMutations: tested,
    rejectedCount: rejected,
    unexpectedErrors,
  };
}
