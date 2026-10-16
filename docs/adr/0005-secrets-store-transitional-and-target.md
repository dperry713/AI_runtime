# ADR-0005: Transitional Encrypted Vault & Target Windows Credential Manager / DPAPI Integration

- Status: accepted
- Date: 2026-10-16
- Deciders: Engineering Agent, User

## Context
In Phase 1 (P1-T09), AIR required an initial `SecretStore` implementation supporting secure get, set, delete, and list operations, with automatic registration into the observability redactor (Rule R4). Real production secrets on Windows require backing by native Windows Credential Manager (`CredReadW` / `CredWriteW`) or DPAPI (`CryptProtectData`) to ensure OS-level protection bound to the user's logon session. However, native Win32 FFI bindings introduce external toolchain dependencies during early foundation phases.

## Decision
1. `CredentialManagerStore` in `src/secrets/credential-manager.ts` is implemented as an authenticated, encrypted file vault using AES-256-GCM with PBKDF2-derived keys, strictly routed through the safe filesystem jail (`src/util/fs-safe.ts`).
2. This implementation is explicitly **transitional**: it fulfills the `SecretStore` interface contract, satisfies Rule R4 redaction integration, and ensures test isolation across platforms.
3. Before production secrets are stored or the v1.0 release is packaged (Phase 12 / P12-T05), `CredentialManagerStore` will be enhanced/replaced with native Windows Credential Manager or DPAPI integration (via Node-API / native helper).

## Consequences
- **Positive:** Zero external native binary dependencies for Phase 1; complete testability on any Windows or mock environment; authenticated encryption at rest prevents plaintext leakage in logs or repo.
- **Negative / Follow-up:** The transitional vault relies on machine-local master keys; DPAPI / Windows Credential Manager integration is scheduled for production hardening.
- **Enforcement:** `redactor.register` is called on all secret read/writes; test suite asserts secrets never appear in plaintext on disk or in logs.

## Alternatives considered
- Direct Node native addon in Phase 1 → Rejected: delays foundational runtime work with C++/native build setup before IPC/daemon architecture is established.
- Plaintext file storage → Rejected: violates Rule R4 and security baseline.
