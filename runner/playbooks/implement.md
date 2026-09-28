# Playbook: implement a maintainer-approved issue (implement mode)

A maintainer labelled a hand-written issue `agent-fix`. Maintainer comments in
the task are authoritative and override the issue text. An earlier automated
triage answer may be included: treat it as a hint, re-verify it.

1. **Decide whether to act.** Stop without changes (and say why in your final
   summary) if the request is ambiguous, conflicts with an invariant in
   `AGENTS.md`, needs secrets or infrastructure you do not have, or would need
   edits under `.github/` (you cannot push those; describe the change instead).
2. **Plan the smallest change** that satisfies the request, following the
   conventions already in the repo:
   - new apt tool → the apt list in `Dockerfile` + the `command -v` list in
     `scripts/smoke.sh`;
   - new release binary → `ARG <TOOL>_VERSION` with a `# renovate:` comment,
     two `<TOOL>_SHA256_*` ARGs, the download in the `RUN` step, an entry in
     `TOOLS` in `scripts/refresh-checksums.py`, then
     `python3 scripts/refresh-checksums.py --tool <depName>`, plus a version
     check in `scripts/smoke.sh`;
   - new npm CLI → `tools/npm/package.json` (exact version), regenerate the
     lockfile, decide `allowScripts` for any new install scripts, add the bin
     to the Dockerfile bin check and to `scripts/smoke.sh`;
   - new Python library → exact pin in `tools/python/requirements.txt`
     (must have cp313 wheels for x86_64 and aarch64), import mapping in
     `scripts/smoke.sh` if the module name differs;
   - docs → keep README.md / AGENTS.md consistent with the change.
3. **Verify locally:** `scripts/static-check.sh --online`.
4. **Commit, push, open the PR, wait:**
   ```bash
   git add -A && git commit -m "feat: <what> (#<issue>)"
   git push origin HEAD:<branch>
   agent-pr
   scripts/ci-wait.sh <branch>
   ```
   Iterate on red CI (see `fix-ci-failure.md`). The PR is reviewed and merged
   by a human; it closes the issue on merge.
5. **Final summary:** what changed, what you verified, anything left for the
   reviewer.
