# Policy Language Specification (P5-T02)

## 1. Overview

AIR operates under a **strict deny-by-default security model** (Security Directive S1). Every tool execution request must be explicitly evaluated and authorized by the Policy Engine before execution begins. If no matching rule permits the action, the request is unconditionally denied.

The Policy Language provides a declarative, auditable, and human-readable format (JSON or YAML) for defining access control rules across:
- **Tools**: Tool identifiers and namespace patterns (e.g., `fs.*`, `http.fetch`, `exec.run`).
- **Capabilities**: Fine-grained capability patterns (e.g., `fs:read:C:\repo\**`, `net:fetch:*.github.com:443`).
- **Arguments**: Value and pattern constraints on raw tool inputs.
- **Taint & Provenance**: Preventing tainted inputs from triggering high-risk actions.
- **Scope**: Restricting rules to specific agents, sessions, or profiles.

---

## 2. Policy Document Schema

A complete policy document contains top-level metadata, global defaults, and an ordered list of policy rules:

```json
{
  "$schema": "https://air.dev/schemas/policy.v1.json",
  "version": 1,
  "name": "developer-default",
  "description": "Standard developer workspace policy for local coding agents",
  "defaultEffect": "deny",
  "rules": [
    {
      "id": "allow-workspace-read",
      "description": "Allow reading files inside the workspace repository",
      "effect": "allow",
      "match": {
        "tools": ["fs.read", "fs.list", "fs.stat", "fs.glob", "fs.grep"],
        "capabilities": ["fs:read:C:\\repo\\**", "fs:list:C:\\repo\\**", "fs:stat:C:\\repo\\**"]
      },
      "reason": "Workspace reading is safe"
    },
    {
      "id": "ask-user-workspace-write",
      "description": "Require operator approval before modifying files",
      "effect": "ask_user",
      "match": {
        "tools": ["fs.write", "fs.edit", "fs.mkdir"],
        "capabilities": ["fs:write:C:\\repo\\**"]
      },
      "reason": "Writing to disk requires operator consent"
    },
    {
      "id": "deny-system-directory-tamper",
      "description": "Strictly forbid any access to Windows system directories",
      "effect": "deny",
      "match": {
        "capabilities": ["fs:*:C:\\Windows\\**", "fs:*:C:\\Program Files\\**"]
      },
      "reason": "System directories are immutable and protected"
    }
  ]
}
```

---

## 3. Rule Anatomy

Each rule in the `rules` array contains:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | **Yes** | Unique identifier for the rule (alphanumeric, dashes, underscores). |
| `description` | `string` | No | Human-readable explanation of rule purpose. |
| `effect` | `'allow' \| 'deny' \| 'ask_user'` | **Yes** | Decision when rule matches. |
| `scope` | `PolicyScope` | No | Scope constraints (agents, sessions, profiles). |
| `match` | `PolicyMatchCondition` | **Yes** | Matching conditions for tools, capabilities, arguments, and taint. |
| `reason` | `string` | **Yes** | Justification emitted in audit logs and user prompts. |
| `priority` | `number` | No | Explicit priority override (higher number = higher precedence). Default derived from specificity. |

### 3.1 Match Conditions (`PolicyMatchCondition`)
- `tools`: `string | string[]` — Matches tool names using exact names or namespace wildcards (e.g. `fs.*`, `exec.*`).
- `capabilities`: `string | CapabilityPattern | Array<string | CapabilityPattern>` — Matches derived tool capabilities against capability patterns.
- `args`: `Record<string, unknown>` — Pattern matching against tool arguments (string glob, exact value, or regex).
- `taint`: `TaintCondition` — Provenance requirements (e.g. `disallowTainted: true`).

---

## 4. Evaluation & Precedence Order

When the Policy Engine evaluates a tool execution request against the policy:

1. **Deny Precedence**: Explicit `deny` rules always take absolute precedence over `allow` and `ask_user` when match criteria are identical or overlapping.
2. **Specificity Ordering**: Rules are ranked by their capability and tool specificity score:
   - Exact file/host/command pattern > Directory glob `*` > Recursive glob `**` > Domain wildcard `*`.
   - Specific tool (`fs.read`) > Namespace wildcard (`fs.*`) > All tools (`*`).
3. **Explicit Priority**: If a rule defines `priority`, higher priority numbers are evaluated first.
4. **First Match Wins**: Within the same priority and specificity tier, the first rule to match dictates the decision.
5. **Default Deny Fallback**: If no rule matches, the policy's `defaultEffect` (always `deny`) is returned with reason `"No matching policy rule; denied by default"`.

---

## 5. Policy Linter & Static Analysis

The Policy Linter (`air policy lint`) performs static analysis on policy documents to detect:
1. **Duplicate IDs**: Two or more rules sharing the same identifier.
2. **Shadowed Rules**: An unreachable rule because a preceding, broader rule always matches first with the same or stricter effect.
3. **Contradictory Rules**: Exact identical match patterns with opposing effects (`allow` vs `deny`).
4. **Dangerous Grants**: Broad, unconstrained execution permissions (`exec:run:*`) or network wildcards without port constraints.
5. **Syntax Errors**: Invalid globs, unparseable CIDR blocks, or malformed capability strings.
