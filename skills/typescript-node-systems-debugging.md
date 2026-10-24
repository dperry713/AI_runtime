# TypeScript / Node.js Systems Debugging

## Mission

Diagnose correctness failures at TypeScript boundaries and in concurrent Node.js execution without bypassing the type system, module architecture, or runtime validation. Apply this playbook to daemon, IPC, tool execution, memory, policy, and sandbox code.

## First-response checklist

- Record the failing command, commit, Node/npm versions, OS, test name, and complete error/stack.
- Reproduce with the narrowest test or script; preserve the original failure before changing code.
- Enable source-mapped stacks with NODE_OPTIONS=--enable-source-maps when supported. Preserve raw output as well as mapped frames.
- Follow the data from its ingress boundary through parsing, domain logic, side effects, and error translation.
- Inspect module ownership and dependency-cruiser rules before moving imports or adding exceptions.

## Strict TypeScript and branded types

- Keep untrusted strings as plain strings until validated. Construct branded values only through validated constructors/factories.
- Check strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess, and noImplicitOverride assumptions in tsconfig.
- Under exactOptionalPropertyTypes, distinguish an omitted property from a property explicitly set to undefined. Build objects conditionally instead of spreading invalid optional fields.
- Use override for actual overrides; do not add it to unrelated members or suppress the compiler error.
- Avoid non-null assertions, broad casts, and any as repairs. Capture narrowed values in locals when closure control-flow narrowing requires it.
- For invariant failures, validate at construction or boundary and keep invalid states unrepresentable where practical.

## Async, cancellation, and races

1. Identify ownership of each AbortController and the exact signal passed to every child operation.
2. Trace cancellation from request/tool-run creation through queueing, execution, subprocess termination, and final journal/event write.
3. Check whether listeners are removed, timers are cleared, and child resources are disposed on success, failure, and abort.
4. Distinguish cancellation requested, cancellation observed, process terminated, and operation settled; these are separate states.
5. Look for double settlement, stale state updates, shared mutable state, missing awaits, and cleanup racing with retries.
6. Use deterministic synchronization (barriers, deferred promises, fake clocks where appropriate) instead of arbitrary sleeps.
7. Use async_hooks only when ordinary tracing cannot establish async-resource ownership; keep instrumentation scoped and remove it after diagnosis.

## Zod boundary failures

- Locate schema parse/safeParse and capture structured issue paths, expected types, and received types.
- Do not log the full rejected payload if it may contain credentials or user data; log a redacted shape and issue metadata.
- Decide whether the failure is malformed external input, schema drift, a producer bug, or an incorrectly strict schema.
- Update producer, schema, and contract tests together when a contract intentionally changes.
- Do not silently coerce security-sensitive values or replace strict validation with permissive parsing to make tests pass.

## Module boundaries and dependency-cruiser

- Read the rule ID, source module, target module, and complete dependency path.
- Fix dependency direction: move shared contracts to a lower-level types/contracts module, introduce a narrow port, or inject an implementation at the composition root.
- Keep domain types independent from infrastructure implementations.
- Add or update a regression assertion for the forbidden edge.
- Do not add a rule exception unless architecture owners explicitly approve and document the reason.

## Stack traces and evidence

- Preserve the original error as cause when wrapping errors.
- Include stable operation/correlation IDs and safe context in logs; avoid dumping whole objects.
- Check source-map generation and availability in the actual runtime package, not only the test runner.
- Compare mapped and generated frames when line numbers appear wrong.

## Practice targets

- Diagnose a flaky async test without increasing arbitrary timeout values.
- Trace AbortSignal cancellation through a tool run and prove child-process cleanup.
- Repair exactOptionalPropertyTypes and noImplicitOverride errors with accurate types.
- Fix a dependency-cruiser violation by correcting dependency direction.
- Turn a Zod error into a safe, actionable diagnostic and regression test.

## Definition of done

- The root cause is supported by a reproducer or trace.
- A regression test fails before the fix and passes after it.
- Typecheck, lint, dependency checks, and relevant tests pass.
- No security validation, architectural rule, or compiler strictness was weakened.
