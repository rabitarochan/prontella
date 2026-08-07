# Harvest Protocol — Atomic Updates for Harvested Skills

## The pair model

Every harvested skill is managed as a pair of files:

- **`SKILL.md`** — the current snapshot of Why + How. The **living Why** (why the
  *current* procedure is the right one) stays inline here, because it is what
  lets an agent adapt the procedure at runtime when the context shifts.
- **`harvest.md`** — the append-only decision record (ADR, Architecture Decision
  Record: a short note capturing one decision and its rationale). The **retired
  Why** (why previous approaches were abandoned, what was tried and rejected)
  lives here.

Why two files: the living Why must be in the runtime-loaded file to influence
execution; the retired Why would be noise there, but deleting it destroys the
lineage of decisions. Splitting them keeps SKILL.md lean and harvest.md honest.
harvest.md is a bundled resource — it is NOT loaded into context in normal use,
only during skill-evolution or lineage-review flows.

## The transaction

A **decision-level** change to a harvested skill is ONE transaction:

1. **Draft the harvest.md entry FIRST** (`context` / `change` / `supersedes` /
   `result` — see `adr-entry-schema.md`). Writing down *why you are changing it*
   before changing it is the quality gate: it prevents judgments from being
   silently overwritten.
2. **Apply the SKILL.md edit**, updating the inline Why wherever it is affected.
3. **Append the entry to harvest.md.**
4. **Verify the invariant** (below).

Changing only one side is invalid. Do not end the task between steps.

## The invariant

> The tail (newest) entry of harvest.md == the rationale for the current SKILL.md.

Consequence: reading the tail of harvest.md always answers "why does this skill
have its current form?" without diffing history.

**Drift repair**: if you find SKILL.md was changed without a harvest.md entry
(the invariant is broken), reconstruct the missing rationale and append an entry
with `context: drift repair — SKILL.md was edited without a harvest entry`.

## Decision-level gate

Record in harvest.md ONLY decision-level changes. The value of an ADR is signal
density; do not bury decisions in noise.

**Decision-level (record it):**

- The recommended approach changes (old procedure retired, new one adopted)
- A new constraint or prerequisite is discovered that reshapes the guidance
- An alternative was considered and rejected (record what and why)
- A threshold, decision rule, or branching condition changes
- The skill's scope expands or contracts

**Trivial (edit SKILL.md directly, no entry):**

- Typos, wording, formatting
- Adding an example that changes no guidance
- Updating a file path or command flag that changes no judgment

When unsure, ask: "would a future agent, seeing the old and new SKILL.md, wonder
*why* it changed?" If yes, it is decision-level.

## Oscillation guard

Context drifts, and a previously rejected approach can start to look attractive
again. Before adopting an approach in a skill update:

1. Scan harvest.md for an entry whose `change` or `context` rejected that same approach.
2. If found, do NOT silently re-adopt it. Either respect the rejection, or — if
   the context has genuinely changed — append a new entry that explicitly
   `supersedes` the rejection and states *what changed in the context* to
   justify reversing it.

This stops the thrash of re-adopting discarded ideas with a confident face.
