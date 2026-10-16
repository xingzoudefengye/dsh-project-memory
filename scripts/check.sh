#!/usr/bin/env bash
# Verify one profile's project-memory wiring:
#   1. all four rows are present in the composed tree;
#   2. the stable prompt section is placed where this bundle intends.
#
# Usage: scripts/check.sh [profile]   (default: web)
set -euo pipefail

PROFILE="${1:-web}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

[ -d "$PROFILE_DIR" ] || { echo "FAIL: no such profile: $PROFILE_DIR" >&2; exit 1; }

DUMP="$(mktemp)"
trap 'rm -f "$DUMP"' EXIT
dsh --profile "$PROFILE" --dump-config > "$DUMP"

status=0

for row in project-memory project-memory-section tool-project-memory command-project-memory; do
	if grep -q "id: $row" "$DUMP"; then
		echo "ok:   $row is in the composed tree"
	else
		echo "FAIL: $row is missing — install this bundle: dsh plugin --profile $PROFILE add github:xingzoudefengye/dsh-project-memory" >&2
		status=1
	fi
done

if grep -q "dsh-project-memory/section" "$DUMP"; then
	echo "ok:   the prompt section row is mounted"
else
	echo "FAIL: dsh-project-memory/section is not mounted" >&2
	status=1
fi

if [ -d "$DSH_HOME/project-memory" ]; then
	echo "ok:   the global layer exists ($DSH_HOME/project-memory)"
else
	echo "note: no global layer yet — create it with /memory init --global (optional, cross-project memory)"
fi

exit "$status"
