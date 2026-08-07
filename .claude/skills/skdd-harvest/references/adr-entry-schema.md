# harvest.md — ADR Entry Schema

## File layout

```markdown
# Harvest Log — <skill-name>

## 001: <short title of the founding decision>

- date: 2026-07-16
- context: <what situation produced this skill>
- change: <the initial Why + How in one or two lines>
- supersedes: —
- result: <fill in when the outcome becomes known>

## 002: <short title of the next decision>

- date: 2026-08-02
- context: <what triggered reconsideration>
- change: <what changed in the Why and the How>
- supersedes: 001
- result: <fill in when known>
```

## Rules

- **Append-only**: never rewrite or delete an existing entry. New entries go at
  the **bottom**; the bottom entry is the "tail" referenced by the invariant in
  `harvest-protocol.md`.
- **id**: zero-padded sequence (`001`, `002`, ...), unique within the file.
- **date**: `YYYY-MM-DD`.
- **context**: the situation that caused the skill to be created or reconsidered
  — not the change itself. This is what future readers need to judge whether the
  decision still applies.
- **change**: what changed, in both Why and How terms. For a rejection, state
  the rejected alternative and why it lost.
- **supersedes**: the id(s) this decision overrides, or `—` for entries that
  override nothing (e.g., the founding entry). `superseded-by` is not written;
  it is derived by scanning later entries.
- **result**: the observed outcome of the change. This is the ONLY field that
  may be edited after the fact — fill it in when the outcome becomes known.
- Field names stay in English (machine-greppable); field values follow whatever
  language the project writes in.

## Example

```markdown
# Harvest Log — pj-api-error-routing

## 001: Route domain-check failures through the validation pipeline

- date: 2026-06-01
- context: External-system reference checks could not be expressed in the
  standard validator, so errors surfaced through an ad-hoc exception with its
  own frontend handling, diverging from every other error path.
- change: Domain checkers now throw the shared ValidationException so failures
  join the existing validator display path. Why: one error pipeline is easier
  to reason about than two; How: build ValidationResult manually and throw.
- supersedes: —
- result: Reused across 3 screens in the first week without new frontend code.

## 002: Prefer warning-response over exception for save-time checks

- date: 2026-06-15
- context: A new requirement wanted saves to succeed while still surfacing
  check failures; blocking via exception (001) prevented that.
- change: Save-time checks return warning messages on the response instead of
  throwing; blocking exceptions remain only for confirm-time checks. The 001
  approach is retired for save paths but stays valid for confirm paths.
- supersedes: 001
- result:
```
