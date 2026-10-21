/**
 * Shell module entry point (Phase 9 - P9-T04/P9-T05/P9-T07).
 *
 * Public API:
 * - `runAir(argv)` — `air` CLI entrypoint, returns exit code
 * - `Repl` — interactive REPL class
 * - `CommandRegistry` — command registry
 * - `registerBuiltinCommands` — register all built-in commands
 * - `ExitCode` — documented exit codes
 * - `writeResult`, `writeError` — output formatting
 *
 * Layer 8 per ARCHITECTURE.md §3: imports layers 0–7 only through their index.ts.
 */

export { runAir } from './main.js';
export { Repl } from './repl.js';
export { CommandRegistry, registerBuiltinCommands, type CommandDefinition } from './commands.js';
export { ExitCode, type ExitCode as ExitCodeType, exitCodeDescription } from './exit-codes.js';
export { writeResult, writeError, type OutputOptions } from './output.js';
