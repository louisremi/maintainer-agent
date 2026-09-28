# Playbook: implement a maintainer-approved issue (implement mode)

A maintainer labelled the issue `agent-fix`. Maintainer comments in the task
are authoritative and override the issue text. An earlier automated triage
answer may be included: treat it as a hint and re-verify it.

1. **Decide whether to act.** Stop without changes (and say why in your final
   summary) if the request is ambiguous, conflicts with the repository's
   instructions, needs secrets or infrastructure you do not have, or would
   touch a protected path (describe the change instead).
2. **Understand the conventions.** Read the repository instructions, then
   the code around the change and its tests. Match the existing style,
   structure and naming. Prefer extending an existing pattern over inventing
   a new one.
3. **Plan the smallest change** that fully satisfies the request, including
   tests and documentation the repository would expect for it.
4. **Verify locally** with the checks listed in the task, or the repository's
   own test/lint commands. Fix what you broke; do not disable checks.
5. **Commit, push, open the draft PR, wait:**
   ```bash
   git add -A && git commit -m "feat: <what> (#<issue>)"
   git push origin HEAD:<branch>
   agent-pr
   ci-wait <branch>
   ```
   Iterate on red CI (see `ci-fix.md`). A maintainer reviews and merges the
   PR; it closes the issue on merge.
6. **Final summary:** what changed, what you verified, and anything left for
   the reviewer.
