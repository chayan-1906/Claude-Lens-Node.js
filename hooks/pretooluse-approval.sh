#!/bin/bash
# PreToolUse hook for Claude Lens — sends Edit/Write/Bash and MCP tool calls
# to the backend for user approval before execution. The hook blocks until
# the user responds (approve/deny) via the Web UI.
#
# Registered in ~/.claude/settings.json with matcher: "Read|Edit|Write|NotebookEdit|Bash|WebSearch|WebFetch|mcp__.*"
# Claude CLI pauses while this hook runs. Set the registered hook's "timeout"
# in ~/.claude/settings.json to 7200000 (ms) to match this script's --max-time 7200 (s).

INPUT=$(cat)

# Quick check: is the backend reachable? If not, fall back to "ask"
# so the native Claude Code terminal prompt appears as usual.
if ! curl -s --connect-timeout 1 -o /dev/null "http://localhost:20261/" 2>/dev/null; then
    cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}
EOF
    exit 0
fi

# POST the full stdin JSON to the backend approval endpoint.
# The backend forwards to the frontend via WebSocket, waits for the user's
# decision, and returns the permissionDecision JSON.
RESPONSE=$(curl -s -X POST \
    -H 'Content-Type: application/json' \
    -d "$INPUT" \
    "http://localhost:20261/api/v1/tool-approval" \
    --max-time 7200)

# If curl failed unexpectedly, fall back to native prompt (not deny)
if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
    cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}
EOF
    exit 0
fi

# Forward the backend's response as-is (already in permissionDecision format)
echo "$RESPONSE"
exit 0