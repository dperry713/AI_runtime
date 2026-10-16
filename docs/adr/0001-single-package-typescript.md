# ADR-0001: Single TypeScript package with enforced module boundaries

- Status: accepted
- Date: 2026-10-15

## Context
AIR has ~18 internal modules. A solo developer plus AI agents will work on it. A multi-package monorepo adds
tooling overhead (workspaces, build ordering, versioning) with little benefit before v1.0.

## Decision
One npm package (`air-runtime`), TypeScript strict ESM, modules under `src/<module>/` with a public `index.ts`.
Boundaries (layer direction, index-only imports, restricted Node builtins) are enforced by `dependency-cruiser`
(`.dependency-cruiser.cjs`) and ESLint, run in `npm run check` and CI.

## Consequences
+ Fast setup, one build, one test runner, simple CI.
+ Boundaries are machine-enforced, so splitting into packages later is mechanical.
− Discipline depends on tooling; a rule gap could allow coupling (mitigated by violation-fixture tests, P0-T07).

## Alternatives considered
- pnpm/turborepo monorepo: heavier; revisit if modules need independent publishing.
- Rust or .NET core: stronger isolation primitives, but slower iteration and less aligned with existing TypeScript expertise; Rust is used only for the sandbox helper (ADR-0004).
