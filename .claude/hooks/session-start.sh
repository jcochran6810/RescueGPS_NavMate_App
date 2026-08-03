#!/usr/bin/env bash
# SessionStart hook — unified.
#
# Always (every environment):
#   - Injects the "read CLAUDE.md / README.md / fix_list.md first" policy
#     into additionalContext.
#   - Auto-creates a stub fix_list.md if it's missing (never overwrites).
#
# Web/remote only ($CLAUDE_CODE_REMOTE == "true"):
#   - Resets the working branch to origin/main (safety rails: only on
#     source=startup, never on main itself, never with a dirty tree).
#   - Runs npm install, npm run typecheck, npm run lint, npm test for a
#     known-good baseline.
#   - Extracts the most recent ## Session log entry from CLAUDE.md so the
#     assistant sees what the previous session shipped.
#
# Output: a single JSON `hookSpecificOutput` blob with all of the above as
# `additionalContext`.

set -uo pipefail

INPUT="$(cat)"

read_source() {
  printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("source",""))
except Exception:
    print("")' 2>/dev/null || true
}

emit_context() {
  printf '%s' "$1" | python3 -c 'import json,sys
print(json.dumps({"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":sys.stdin.read()}}))'
}

REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$REPO_ROOT"

log() { printf '[session-start] %s\n' "$*" >&2; }

# === Always-on: auto-create fix_list.md if missing (never overwrites) ===
if [ ! -f "$REPO_ROOT/fix_list.md" ]; then
  cat > "$REPO_ROOT/fix_list.md" <<'STUB'
# Fix list

Outstanding fixes, TODOs, and known issues for RescueGPS NavMate.

Add new items at the top. Use the format:

- [ ] YYYY-MM-DD — short description (file_path:line if relevant)

## Open

_(none yet)_

## Done

_(none yet)_
STUB
fi

# === Always-on: required-reading policy ===
POLICY_BLOCK="SESSION STARTUP — REQUIRED FIRST STEP

Before taking any action, doing any work, or answering any question in this
session, read the following three files in this order:

  1. CLAUDE.md     — project instructions, start/end-session protocols, session log
  2. README.md     — product overview, features, architecture, env vars
  3. fix_list.md   — outstanding fixes / TODOs / known issues

This is mandatory project policy. Do this BEFORE any other tool calls,
investigation, or response. If any of these files is missing, note it and
continue."

# === Local (non-remote): emit just the policy and exit ===
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  emit_context "$POLICY_BLOCK

(Local environment — automatic git sync + npm install/typecheck/lint/test are
skipped. Run them manually per CLAUDE.md's start-session protocol.)"
  exit 0
fi

# === Web-only from here on: sync + baseline checks ===
SOURCE="$(read_source)"
CURRENT_BRANCH="$(git branch --show-current 2>/dev/null || echo '')"

# Sync policy (per CLAUDE.md): every new session MUST start at origin/main HEAD.
#
#   - source=startup  → always reset to origin/main (clean tree required;
#     ahead commits are discarded — fresh sessions never inherit forked state).
#   - source=resume/compact/clear → only sync if it's a pure fast-forward
#     (no commits ahead). If the branch is ahead of origin/main, this is
#     in-progress session work; emit a BLOCKER and let the assistant
#     surface the drift to the user.
#   - Dirty tree → never auto-reset; emit a BLOCKER.
#   - On `main` directly → BLOCKER (main is the release branch).
SYNC_STATUS=""
DRIFT_BLOCKER=""

if [ -z "$CURRENT_BRANCH" ]; then
  SYNC_STATUS="⛔ Detached HEAD — STOP. Check out a session branch from origin/main before doing anything else."
  DRIFT_BLOCKER="yes"
elif [ "$CURRENT_BRANCH" = "main" ]; then
  SYNC_STATUS="⛔ On main directly — STOP. main is the release branch; sessions belong on a per-session branch. Create one from origin/main: \`git fetch origin && git checkout -b claude/<slug> origin/main\`."
  DRIFT_BLOCKER="yes"
elif ! git fetch origin main --quiet 2>/dev/null; then
  # Distinguish "main does not exist yet" from a genuine network failure —
  # they need very different responses from the assistant.
  if ! git ls-remote --exit-code --heads origin main >/dev/null 2>&1; then
    SYNC_STATUS="⛔ origin/main does not exist. This repository has no main branch, so the start-session protocol cannot anchor to it. STOP and surface to the user: main must be created from the current work (\`git checkout -B main && git push -u origin main\`) before the protocol can function."
  else
    SYNC_STATUS="‼️ git fetch origin main failed — cannot verify sync state. Surface this to the user before continuing."
  fi
  DRIFT_BLOCKER="yes"
else
  DIRTY="no"
  if ! git diff --quiet HEAD 2>/dev/null; then DIRTY="yes"; fi
  if ! git diff --cached --quiet 2>/dev/null; then DIRTY="yes"; fi
  AHEAD="$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
  BEHIND="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"

  if [ "$DIRTY" = "yes" ]; then
    SYNC_STATUS="⛔ Uncommitted changes on \`$CURRENT_BRANCH\` (ahead=$AHEAD, behind=$BEHIND vs origin/main) — sync SKIPPED. STOP and surface to the user: either commit/stash and re-sync, or address the dirty state intentionally before any other work."
    [ "$BEHIND" != "0" ] && DRIFT_BLOCKER="yes"
  elif [ "$AHEAD" = "0" ] && [ "$BEHIND" = "0" ]; then
    SYNC_STATUS="✅ \`$CURRENT_BRANCH\` already at origin/main HEAD ($(git rev-parse --short HEAD))."
  elif [ "$AHEAD" = "0" ]; then
    # Pure fast-forward — always safe regardless of source
    if git reset --hard origin/main >&2 2>&1; then
      SYNC_STATUS="✅ \`$CURRENT_BRANCH\` fast-forwarded to origin/main ($(git rev-parse --short HEAD); was $BEHIND commit(s) behind)."
    else
      SYNC_STATUS="‼️ git reset --hard origin/main failed."
      DRIFT_BLOCKER="yes"
    fi
  elif [ "$SOURCE" = "startup" ]; then
    # Fresh session on a stale/forked branch — protocol mandates: start from main.
    OLD_SHA="$(git rev-parse --short HEAD)"
    if git reset --hard origin/main >&2 2>&1; then
      SYNC_STATUS="⚠️  \`$CURRENT_BRANCH\` reset to origin/main ($(git rev-parse --short HEAD); discarded $AHEAD commit(s) ahead, was at $OLD_SHA). CLAUDE.md mandates every new session starts from origin/main HEAD; the discarded commits remain in the reflog (\`git reflog $CURRENT_BRANCH\`) if needed."
    else
      SYNC_STATUS="‼️ git reset --hard origin/main failed."
      DRIFT_BLOCKER="yes"
    fi
  else
    SYNC_STATUS="⛔ \`$CURRENT_BRANCH\` has drifted from origin/main (ahead=$AHEAD, behind=$BEHIND) on source=$SOURCE. Resume/compact/clear does NOT auto-reset (could destroy in-progress session work). STOP and surface to the user: (a) merge origin/main in to keep session work: \`git merge origin/main\`; (b) reset to origin/main and discard session work: \`git reset --hard origin/main\`; (c) end the session via the end-session protocol so the work merges to main."
    DRIFT_BLOCKER="yes"
  fi
fi
log "$SYNC_STATUS"

# Extract the most recent ## Session log entry from CLAUDE.md
LAST_SESSION_LOG=""
if [ -f CLAUDE.md ]; then
  LAST_SESSION_LOG="$(awk '
    /^## Session log/ { in_log=1; next }
    in_log && /^### / && !started { started=1; print; next }
    started && /^### / { exit }
    started && /^## / && !/^### / { exit }
    started { print }
  ' CLAUDE.md)"
fi
[ -z "$LAST_SESSION_LOG" ] && LAST_SESSION_LOG="(no previous session-log entry found in CLAUDE.md)"

# Baseline checks
log "npm install..."
if npm install --no-audit --no-fund --loglevel=error >&2; then
  INSTALL_STATUS="✅ npm install"
else
  INSTALL_STATUS="‼️ npm install FAILED"
fi

log "npm run typecheck..."
if npm run typecheck >&2 2>&1; then
  TYPECHECK_STATUS="✅ npm run typecheck"
else
  TYPECHECK_STATUS="‼️ npm run typecheck FAILED"
fi

log "npm run lint..."
if npm run lint >&2 2>&1; then
  LINT_STATUS="✅ npm run lint"
else
  LINT_STATUS="‼️ npm run lint FAILED"
fi

log "npm test..."
if npm test --silent >&2 2>&1; then
  TEST_STATUS="✅ npm test"
else
  TEST_STATUS="‼️ npm test FAILED"
fi

# Emit unified context
BLOCKER_HEADER=""
if [ "$DRIFT_BLOCKER" = "yes" ]; then
  BLOCKER_HEADER="⛔ SESSION-START BLOCKER — the working branch is NOT at origin/main HEAD and the hook could not auto-correct it. Per CLAUDE.md, no new session may begin from anywhere other than the most recent origin/main. Before doing ANY other work, surface the sync status below to the user and resolve it (commit/stash, merge origin/main in, or reset). Do not start the user's task until the branch is at origin/main HEAD.

"
fi

CONTEXT="${BLOCKER_HEADER}${POLICY_BLOCK}

## Session start — automatic baseline

Branch: \`$CURRENT_BRANCH\`
Sync: $SYNC_STATUS

Baseline checks (already executed by SessionStart hook — no need to rerun):
- $INSTALL_STATUS
- $TYPECHECK_STATUS
- $LINT_STATUS
- $TEST_STATUS

Reminder: \`main\` is the release branch — once the Vercel project is connected to this repo it auto-deploys on push to main. All work happens on \`$CURRENT_BRANCH\` and only lands when the user types \"end session\" and CLAUDE.md's end-session protocol merges this branch into main.

## Previous session (most recent entry in CLAUDE.md \`## Session log\`)

$LAST_SESSION_LOG"

emit_context "$CONTEXT"
