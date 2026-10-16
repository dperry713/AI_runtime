# Decisions Log

- 2026-10-16 | Initialized .agent memory tracking | Following user_global engineering operating rules | rejected: unrecorded session state
- 2026-10-16 | Dual implementation for planner.py (Python reference package + native TypeScript in src/agent) | Provides executable Python test harness alongside native TypeScript runtime integration matching AIR layer rules | rejected: single-language only implementation
- 2026-10-16 | Prioritize NVIDIA as provider (NVIDIA NIM / integrate.api.nvidia.com) | User directive; added 'nvidia' as first-class provider type in schema; will implement in Phase 3 alongside OpenAI-compat/Anthropic | rejected: deferring NVIDIA support
- 2026-10-16 | Rust toolchain approved for native sandbox helper (P7-T02) | User confirmed Rust toolchain is fine for Windows Job Objects sandbox helper | rejected: C++ or pure Node native addon
- 2026-10-16 | Windows long paths requested | User approved enabling LongPathsEnabled=1; requires elevated admin prompt to write HKLM | rejected: MAX_PATH limitation
- 2026-10-16 | Transitional secrets store (ADR-0005) | CredentialManagerStore uses authenticated AES-256-GCM encrypted file vault as transitional layer; will be enhanced with native Windows Credential Manager / DPAPI before production secrets | rejected: direct C++ native addon in Phase 1
