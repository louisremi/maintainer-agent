# Playbook: propose a change for an issue (fix agent)

Either a maintainer opened the issue, or a maintainer added the fix label to
it. Maintainer comments in the task are authoritative and override the issue
text. An earlier automated analysis may be included: treat it as a hint and
re-verify it.

You edit the checkout at `/work/repo`; you do not commit or push. When you
finish, your edits become a patch that is checked and pushed to a new branch
by a separate step, and a **draft** change request is opened for a maintainer
to review. Nothing is merged without a human.

1. **Decide whether to act.** Stop without changes (and write the reason to
   `/tmp/agent/summary.md`) if the request is ambiguous, conflicts with the
   repository's instructions, needs secrets or infrastructure you do not
   have, or would touch a protected path.
2. **Understand the conventions.** Read the repository instructions, then
   the code around the change and its tests. Match the existing style,
   structure and naming. Prefer extending an existing pattern over inventing
   a new one.
3. **Plan the smallest change** that fully satisfies the request, including
   the tests and documentation the repository would expect for it.
4. **Verify locally** with the checks listed in the task, or the
   repository's own test/lint commands. Fix what you broke; never disable
   checks. If a check cannot run here (no network, no Docker), say so.
5. **Describe the change** in `/tmp/agent/pr.json`:
   ```json
   {"title": "fix: <what> (#<issue>)", "body": "What changed and why.\n\nHow it was verified.\n\nAnything left for the reviewer."}
   ```
   Do not write "Fixes #n": it is added for you.
6. Finish with `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`.
