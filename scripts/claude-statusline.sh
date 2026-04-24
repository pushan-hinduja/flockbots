#!/bin/bash
# Claude Code statusline script — writes rate limit data to a shared file
# so the coordinator can read real Anthropic rate limit info.
#
# Setup: add to ~/.claude/settings.json:
#   "statusLine": {
#     "type": "command",
#     "command": "<path-to-repo>/scripts/claude-statusline.sh"
#   }

input=$(cat)

RATE_FILE="/tmp/claude-rate-limits.json"

FIVE_H_PCT=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty' 2>/dev/null)
FIVE_H_RESET=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty' 2>/dev/null)
SEVEN_D_PCT=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty' 2>/dev/null)
SEVEN_D_RESET=$(echo "$input" | jq -r '.rate_limits.seven_day.resets_at // empty' 2>/dev/null)

# Only write if we got rate limit data
if [ -n "$FIVE_H_PCT" ] || [ -n "$SEVEN_D_PCT" ]; then
  cat > "$RATE_FILE" <<EOF
{
  "five_hour": { "used_percentage": ${FIVE_H_PCT:-null}, "resets_at": ${FIVE_H_RESET:-null} },
  "seven_day": { "used_percentage": ${SEVEN_D_PCT:-null}, "resets_at": ${SEVEN_D_RESET:-null} },
  "updated_at": $(date +%s)
}
EOF
fi

# Output for statusline display
if [ -n "$FIVE_H_PCT" ]; then
  echo "5h: ${FIVE_H_PCT}%"
else
  echo ""
fi
