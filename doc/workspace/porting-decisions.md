# Porting Decisions — Workspace Blueprints

## Purpose and Status

The [RBAC](rbac-architecture-blueprint.md), [map adapter](map-adapter-architecture-blueprint.md), and [chatbox and LLM](chatbox-llm-architecture-blueprint.md) blueprints are ports from an earlier project. Each closes with an explicit *"Open questions to re-decide for a new project"* section.

This document records how those questions were answered, so the platform does not silently inherit another system's assumptions (implementation plan, milestone W0). Every answer carries a status:

* **DECIDED** — follows from a decision or document already in this bundle.
* **APPROVED** — an owner decision, recorded here.
* **OPEN** — still needs an owner answer; the interim is stated.

The owner signed off all nine previously-proposed items and both W6 answers. No question and no follow-up remains. The retention windows this document decided now live in [Workspace Retention](retention.md) with the other workspace-owned classes.

Two principles settled most of the questions: **fail closed on authorization, fail open on accounting**, and **there is no deny path — permission is the presence of an allow**.

## RBAC

Source: [rbac-architecture-blueprint.md](rbac-architecture-blueprint.md), "Open questions to re-decide for a new project".

| # | Question | Answer | Status |
| --- | --- | --- | --- |
| R1 | Is an explicit **deny** ever needed? | No. Access is an allow-list; absence of an allow is denial. The Non-Functional Requirements require authorization to deny by default and forbid a missing policy from granting access, so a deny path would add an override with no consumer. | DECIDED |
| R2 | Should **suspension** subtract permissions, and how does that interact with global-looking roles? | Suspension removes the role assignment or the membership. It does not subtract capabilities from a role. A suspended member holds no assignment, so the evaluator grants nothing and the interaction question disappears. | APPROVED |
| R3 | How is **public/showcase read access** granted and revoked, and is the read-only guard sufficient? | Through scoped, expiring share grants (`facility.share`), never a public role. Read-only is enforced server-side at the route; the client's read-only mode is presentation only and is never the control. Revocation is expiry or an explicit revoke. | DECIDED |
| R4 | Are **direct per-user grants** worth keeping? | No. Membership plus role assignment only; the per-user grant table is not created. Revisit only with a concrete need, because it doubles the administration surface and the evaluation paths. | APPROVED |
| R5 | Where should the **catalog** live, so the client stops retyping keys? | Generated from a single source of truth in the specification bundle into a shared module, with a contract test asserting client/server key parity. This mirrors the existing requirement that the server registry and the client handler registry stay comparable by contract test. | DECIDED |

Consequences: W1 ships no deny flag and no per-user grant table; the permission catalog is generated, and key drift is a test failure rather than a review comment.

## Map Adapters

Source: [map-adapter-architecture-blueprint.md](map-adapter-architecture-blueprint.md), "Open questions to re-decide for a new project".

| # | Question | Answer | Status |
| --- | --- | --- | --- |
| M1 | Add **viewport/bounding-box filtering and a response cap** up front, and define complete versus truncated? | Yes to both, from the first version. Every collection response states explicitly whether it is complete or truncated, and the cap is part of the published limit set rather than an implementation detail. | APPROVED |
| M2 | **Explicit type-to-category map** or substring heuristics, and how are unknown types surfaced? | An explicit type-to-category map, with unknown types resolved into a visible `unclassified` bucket. Never a silent default, and never dropped. Heuristics are unreviewable and make a classification change indistinguishable from a data change. | APPROVED |
| M3 | Should **marker/asset collections** be versioned or replaced in place? | Versioned. Project assets have immutable versions by decision (D20), and replace-in-place would break the provenance and binding guarantees the tool contracts rely on. | APPROVED |
| M4 | Does a **missing snapshot** degrade or fail, per artifact, and how does the client learn which happened? | Degrade uniformly, at every surface, with no hard failure. A missing snapshot falls back to the newest artifact on the same base version, and the response states whether it is complete or truncated. An incomplete input makes the dependent checks **unrun rather than passed**: the affected capability stays `NOT_PROVIDED` or `PROVISIONAL`, the run is recorded as incomplete, and the revision cannot become `VALIDATED` from it. | APPROVED |
| M5 | How does **import idempotency** work: natural keys, replace-by-upload, or explicit rollback? | Natural keys plus an explicit rollback path. Replace-by-upload is rejected because it destroys the pinned-version provenance that D1, D2, and D20 depend on. | APPROVED |

**Degrade uniformly — but never degrade the verdict.** The rule has three layers, and only the first is a transport concern. **Transport** degrades: a missing snapshot falls back to the newest artifact on the same base version, and the response states complete or truncated (M1). **Interpretation** does not: an incomplete input is insufficient evidence, never an empty-and-clean result. **The gate** follows: dependent checks are recorded as not run, the affected capability stays `NOT_PROVIDED` or `PROVISIONAL`, and the revision cannot become `VALIDATED` from that run. That consumer-side rule is normative in [Verification Requirements](../tools/site-and-facility/verification-requirements.md). Nothing fails hard, so a map stays readable after an interrupted run, while a gate can still never pass over data it never saw.

## Chatbox and LLM

Source: [chatbox-llm-architecture-blueprint.md](chatbox-llm-architecture-blueprint.md), "Open questions to re-decide for a new project".

| # | Question | Answer | Status |
| --- | --- | --- | --- |
| C1a | Where does the **token estimate** for the pre-check come from? | From the provider's own tokenizer. A conservative constant is the fallback when the provider is unreachable, so a pre-check never fails for want of an estimate. | APPROVED |
| C1b | Is pre-check refusal **soft (warn) or hard (block)**? | Soft. The token pre-check warns and records but never blocks a turn, following the fail-open-on-accounting invariant. Quota enforcement is a separate check and stays blocking: over quota returns 429 and a lapsed entitlement returns 402, as the quota contract already specifies. | APPROVED |
| C2 | Should the client still probe **read-only scopes**, or is server tool selection the only control? | Server tool selection is authoritative. The client may hide write tools for clarity, but hiding is never the control and a hidden tool must still be refused if invoked. | DECIDED |
| C3 | How far should the **digest** go before details are left to tools? | A small bounded snapshot plus read tools, matching the existing bounded-digest rule in the assistant document. The digest carries identity, lifecycle, and coverage state, not payloads. | DECIDED |
| C4 | **Retention and expiry** for orphaned attachment objects and for turn objects? | Orphaned objects expire. An attachment never sent in a turn expires **1 hour** after upload, by a prefix-and-age sweep. Turn objects do not expire individually: a session's index row, manifest, and turn objects expire together after **90 days** of inactivity. Audit records keep their full retention. | APPROVED |
| C5 | Will **writes actually exist**? | Yes. The facility tool ships write tools, so the write-and-confirmation path is exercised against a real one before the assistant is enabled for that surface, rather than trusted from tests alone. | DECIDED |
| C6 | Should attachments stored via a **local/relative path** scheme be reachable by the model at all? | No. The model reads from object storage only; local and relative path reads are rejected. A deployment that stores attachments by relative path must normalize at ingest, otherwise the attachment is rejected loudly rather than silently lost. | APPROVED |
| C7 | May the model invoke a permission-checked capability whose permission was **never enforced at the route level**? Is route pre-check sufficient? | Not sufficient. Every tool re-checks its own permission. The route pre-check is one layer, not the control, and defense in depth is already required for tool selection. | DECIDED |

### C4 implementation notes

This adopts the chatbox blueprint's own guidance — *"expire them by prefix rather than sweeping per request"* — and adds the two things it left open: a grace window, and session-scoped rather than per-turn expiry.

1. **Grace window: 1 hour.** Upload happens at pick time, before send, so a freshly uploaded object is unreferenced but legitimate. The sweep only touches objects older than the grace window. It is a floor on safety, not a storage optimisation: if real pick-to-send traffic can exceed an hour, the window must rise.
2. **Session expiry is atomic.** A session's index row, manifest, and turn objects are deleted together after 90 days of inactivity. Individual turn objects never expire, so replay never meets a hole and no truncation marker is needed.
3. **Promotion copies the bytes into the asset key layout.** The resulting project asset (D20) owns its own object, and asset retention plus the reference-guarded deletion rule govern it from then on. The originally uploaded attachment object is still named by the turn's message block, and turns are immutable, so that copy is retained until its session expires rather than swept as an orphan. The cost is duplication across the two storage planes on promotion: quota accounting must count both copies, and no cross-plane deduplication is attempted. Copy-on-promotion is what makes the sweep safe, because a reused object could be deleted out from under a binding.
4. **The sweep is prefix-scoped and owner-aware**, so it cannot reach past the owner segment that read re-authorization depends on.
5. **The sweep is a system action that is audited**, with counts and prefixes recorded, and a legal or regulatory hold overrides it, consistent with every other deletion rule in this bundle.
6. **Quota remains the backstop** for promoted assets and active sessions. Expiry removes the abandoned-upload tail; on its own it does not make storage safe.
7. **The windows live at the workspace level.** They are recorded with the other workspace-owned classes in [Workspace Retention](retention.md), which [Project Assets](project-assets.md) now references too. A tool cannot redefine them.

## Remaining Items

None. Every question is answered, and the retention windows decided here now live in [Workspace Retention](retention.md) rather than in this document.
