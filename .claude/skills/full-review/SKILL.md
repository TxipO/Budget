---
name: full-review
description: >
  Run the complete code-quality pass for this project: /selfcheck, then
  /deep-review, then /security-review, in sequence. Invoke when the user asks
  for a "full check", "повний чек коду", "перевір все", or a comprehensive
  audit spanning bugs, deep logic issues, and security in one go — instead of
  the user having to invoke each skill separately and remember the order.
---

# Full review skill

A thin sequencer, not a fourth review method. `/selfcheck` and `/deep-review`
intentionally run in **opposite modes** — selfcheck is grep-only, never reads
a full file, and is meant to be cheap enough to run after every change;
deep-review reads every file in full and reasons about data flow, and is
meant to be expensive. Merging their instructions into one skill would blur
that boundary (the fast pass starts reading files fully, or the deep pass
gets lazy and greps). Keep them as separate skills; this one just calls them
in the right order and carries findings forward between stages.

## Order and why

1. **`/selfcheck`** first — cheap, mechanical, catches the "obvious" bug
   shapes fast. No point spending deep-review's expensive full-file reads on
   a bug a grep pattern would've caught in seconds.
2. **`/deep-review`** second — now that the mechanical bugs are cleared out,
   spend the expensive reasoning pass on what's left: logic errors, race
   conditions, environment-dependent behavior, trust-boundary issues grep
   can't see.
3. **`/security-review`** third — a final security-specific lens over
   whatever changed during steps 1-2 plus the pre-existing auth/webhook/crypto
   surface. Run this last so it also covers any fixes just made in steps 1-2,
   not just the code as it looked before this pass started.

## What to do

1. Invoke `/selfcheck` via the Skill tool. Follow its own report format, fix
   every Critical immediately, commit.
2. Invoke `/deep-review` via the Skill tool. Follow its own report format,
   fix confirmed bugs immediately, commit. Do not re-run checks step 1
   already covered — deep-review's own instructions already say not to
   grep-and-report, trust that division of labor.
3. Invoke `/security-review` via the Skill tool (or the built-in
   security-review capability if no project-specific one exists) over the
   current diff/branch state, which now includes the fixes from steps 1-2.
   Fix confirmed findings immediately.
4. After all three stages: run `node scripts/verify-data-integrity.mjs` once
   at the end to confirm nothing regressed across the whole pass, not just
   after each individual stage.
5. Give the user **one consolidated report**, not three separate ones —
   merge findings from all three stages into a single Critical /
   Warnings / Reviewed-clean summary, noting which stage found what.
6. Update project memory (`C:\Users\doter\.claude\projects\C--Users-doter-Budget\memory\`)
   with what this pass actually changed — see below. Do this even if the
   user didn't ask; a full-review pass is exactly the point where accumulated
   session work (features shipped, bugs found, architecture that changed)
   needs to land in memory before it's lost to context compaction.

## Updating memory after a pass

Don't treat this as optional cleanup — it's the last step, not a nice-to-have.

- **What qualifies**: new architecture or subsystems shipped since the last
  memory update (e.g. a new auth mechanism, a new external integration), real
  bugs found and fixed (the failure mode + fix, not the diff), and any
  security-relevant finding from the security-review stage — confirmed or a
  pattern worth remembering even if this pass found it clean. Routine
  selfcheck Criticals with no broader lesson don't need their own memory;
  fold them into the summary of whichever project file covers that area.
- **What doesn't**: anything already fully described by the code itself
  (file paths, function names as of today) or by git history — memory is for
  facts a future session can't re-derive by reading the repo, not a changelog.
- **Where it goes**: update the existing project-scoped memory file that
  already covers this area (e.g. a security-relevant fix goes in the
  project's security-posture memory, not a new file) rather than defaulting
  to a new file per pass. Create a new file only when the work is a genuinely
  new subsystem with no existing home. Always update `MEMORY.md`'s index line
  for any file you touch or add.
- **Supersede, don't append**: if a memory file already describes the area
  this pass touched, rewrite/trim the stale parts rather than stacking a new
  paragraph on top of an now-inaccurate one — a memory file should read as
  the current state of that area, not a log of every pass over it.

## After finding new bug patterns

If any stage surfaces a genuinely new class of bug (not just a new instance
of an existing pattern), update that stage's own skill file
(`.claude/skills/selfcheck/SKILL.md` or `.claude/skills/deep-review/SKILL.md`)
with the lesson, per this project's established convention — don't let the
lesson live only in this session's chat history.
