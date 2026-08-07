<!-- skdd:begin -->
<!-- skdd:config prefix=pj- hooks=false threshold=medium version=0.3.0 -->
<!-- This section is managed by the skdd plugin. Do not edit inside the markers; run /skdd:update to regenerate. -->

## SkDD (Skill Driven Development)

This project uses SkDD: reusable work patterns are crystallized into Skills and
grown over time with their Why (rationale) attached. Agents working in this
repository must follow this protocol.

### Skill discovery and use

- Skills live in `.claude/skills/<skill-name>/SKILL.md`.
- If your platform does not auto-discover skills there (Claude Code does), list
  the directories under `.claude/skills/`, read each SKILL.md frontmatter
  (name / description), and load the relevant skill bodies before starting work.
- No static skill index is maintained — discover dynamically (indexes drift).
- Project skill prefix: `pj-` (naming: `pj-<domain>-<action>`).

### Harvest criteria

At natural task-completion points, evaluate the session against 5 criteria:
(1) recurrence (2) proceduralness (3) non-obviousness (4) correction-derived (5) generality

This project's harvest threshold is **`medium`**, which sets these bars:

- **3/5 or more** → propose skillification (or an update to an existing skill)
- **1-2/5** → silently record a Proto-Skill in `.claude/skills/skdd-harvest/backlog.md`
- **below that** → do nothing
- A Proto-Skill that reappears in **2+ separate sessions** → propose promotion
- Insights within an existing skill's scope → propose updating that skill, not a
  new one. Read the existing skills' descriptions before proposing a new skill —
  a name-collision check does not detect overlapping scope.
- Full procedure, and the consolidation/distillation rules for this threshold
  level: `.claude/skills/skdd-harvest/SKILL.md`

### Skill authoring conventions (two layers)

- The SkDD rules in this section — criteria, threshold bars, the pair model
  and atomic updates, naming, routing — are invariants and always apply.
- Format mechanics of a generated SKILL.md (frontmatter field set, description
  style, body skeleton, when to split content into reference files) follow the
  executing platform's current conventions, resolved at harvest time: a
  dedicated skill-authoring skill available to the executing agent, if any;
  otherwise the agent's own current knowledge of its platform's skill-format
  best practices; otherwise the dated baseline in
  `.claude/skills/skdd-harvest/SKILL.md` (Step 3).
- Precedence: SkDD invariants > current platform conventions > dated baseline.
  When unsure whether guidance is newer, prefer the baseline. Do not fetch
  documentation to decide.
- When updating an existing skill, apply current conventions only to the parts
  being touched — never restyle a whole skill to match newer conventions.

### Skill update protocol (atomic updates)

- Harvested skills are managed as a pair: `SKILL.md` (current Why+How snapshot)
  and `harvest.md` (append-only decision record).
- A decision-level change to SKILL.md requires appending a harvest.md entry
  (context / change / supersedes / result) in the same transaction. Changing
  only one side is invalid.
- Trivial How-level fixes may edit SKILL.md directly.
- Invariant: the tail entry of harvest.md == the rationale of the current SKILL.md.
- Details: `.claude/skills/skdd-harvest/references/harvest-protocol.md`

### Knowledge routing

- Project-specific knowledge → a `pj-*` skill in this project
- Project-independent, generic knowledge → suggest a global skill (`~/.claude/skills/`)
- `backlog.md` is per-developer local state (gitignored; do not commit)

<!-- skdd:end -->
