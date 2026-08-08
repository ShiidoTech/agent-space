#!/usr/bin/env bash
set -euo pipefail

BUMP_TYPE="${1:-}"

if [[ -z "$BUMP_TYPE" ]] || [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
	echo "Usage: bash scripts/release.sh <patch|minor|major>"
	exit 1
fi

# --- Validate state (skip in CI) ---
if [[ "${CI:-}" != "true" ]]; then
	if [[ -n "$(git status --porcelain)" ]]; then
		echo "Error: Working directory is not clean. Commit or stash changes first."
		exit 1
	fi

	CURRENT_BRANCH="$(git branch --show-current)"
	if [[ "$CURRENT_BRANCH" != "main" ]]; then
		echo "Error: Must be on 'main' branch (currently on '$CURRENT_BRANCH')."
		exit 1
	fi

	# --- Quality gate ---
	echo "Running quality gate..."
	bunx @biomejs/biome check --error-on-warnings
	bun run typecheck
	bun run test
	echo "Quality gate passed."
fi

# --- Get current and compute new version ---
OLD_VERSION="$(node -p "require('./package.json').version")"
if [[ "$OLD_VERSION" =~ ^[0-9]+\.[0-9]+$ ]]; then
	NORMALIZED_OLD_VERSION="${OLD_VERSION}.0"
	echo "Normalizing legacy version: $OLD_VERSION -> $NORMALIZED_OLD_VERSION"
	node -e "const fs=require('fs'); const pkg=JSON.parse(fs.readFileSync('package.json','utf8')); pkg.version='$NORMALIZED_OLD_VERSION'; fs.writeFileSync('package.json', JSON.stringify(pkg, null, '\t') + '\n');"
	OLD_VERSION="$NORMALIZED_OLD_VERSION"
fi

echo "Current version: $OLD_VERSION"

npm version "$BUMP_TYPE" --no-git-tag-version > /dev/null
NEW_VERSION="$(node -p "require('./package.json').version")"
echo "New version: $NEW_VERSION"

# --- Generate changelog entry ---
LAST_TAG="$(git describe --tags --abbrev=0 2>/dev/null || echo "")"
DATE="$(date +%Y-%m-%d)"

if [[ -n "$LAST_TAG" ]]; then
	LOG_RANGE="${LAST_TAG}..HEAD"
else
	LOG_RANGE="HEAD"
fi

FEATURES=""
FIXES=""
REFACTORING=""
OTHER=""

while IFS= read -r line; do
	# Strip leading spaces
	line="$(echo "$line" | sed 's/^ *//')"
	[[ -z "$line" ]] && continue

	if [[ "$line" =~ ^feat:\ (.+) ]] || [[ "$line" =~ ^feat\(.+\):\ (.+) ]]; then
		FEATURES="${FEATURES}- ${BASH_REMATCH[1]}\n"
	elif [[ "$line" =~ ^fix:\ (.+) ]] || [[ "$line" =~ ^fix\(.+\):\ (.+) ]]; then
		FIXES="${FIXES}- ${BASH_REMATCH[1]}\n"
	# "reactor:" is a historical typo for "refactor:" in commit 63a354f
	elif [[ "$line" =~ ^refactor:\ (.+) ]] || [[ "$line" =~ ^refactor\(.+\):\ (.+) ]] || [[ "$line" =~ ^reactor:\ (.+) ]]; then
		REFACTORING="${REFACTORING}- ${BASH_REMATCH[1]}\n"
	elif [[ "$line" =~ ^(docs|chore|style|ci|build|perf|test):\ (.+) ]] || [[ "$line" =~ ^(docs|chore|style|ci|build|perf|test)\(.+\):\ (.+) ]]; then
		OTHER="${OTHER}- ${BASH_REMATCH[2]}\n"
	else
		# Non-conventional commit — include as-is under Other
		OTHER="${OTHER}- ${line}\n"
	fi
done < <(git log "$LOG_RANGE" --pretty=format:"%s")

ENTRY="## [$NEW_VERSION] - $DATE\n"

[[ -n "$FEATURES" ]] && ENTRY="${ENTRY}\n### Features\n${FEATURES}"
[[ -n "$FIXES" ]] && ENTRY="${ENTRY}\n### Fixes\n${FIXES}"
[[ -n "$REFACTORING" ]] && ENTRY="${ENTRY}\n### Refactoring\n${REFACTORING}"
[[ -n "$OTHER" ]] && ENTRY="${ENTRY}\n### Other\n${OTHER}"

# --- Update CHANGELOG.md ---
if [[ -f "CHANGELOG.md" ]]; then
	# Insert after the first line (# Changelog)
	{
		head -n 1 CHANGELOG.md
		echo ""
		echo -e "$ENTRY"
		tail -n +2 CHANGELOG.md
	} > CHANGELOG.tmp && mv CHANGELOG.tmp CHANGELOG.md
else
	echo -e "# Changelog\n\n${ENTRY}" > CHANGELOG.md
fi

echo "Changelog updated."

# --- Build VSIX ---
echo "Building VSIX package..."
bun run compile
bun run package
VSIX_FILE="$(ls -1t *.vsix 2>/dev/null | head -1)"
echo "VSIX built: ${VSIX_FILE:-agent-space-${NEW_VERSION}.vsix}"

# --- Commit and tag ---
git add package.json CHANGELOG.md
git commit -m "release: v${NEW_VERSION}"
git tag "v${NEW_VERSION}"

echo ""
echo "========================================="
echo "  Release v${NEW_VERSION} ready!"
echo "========================================="
echo ""
echo "Next steps:"
echo "  git push && git push --tags"
echo "  # VSIX distribution: install/share the package built above"
echo "  # Marketplace distribution (intentional ShiidoTech release only):"
echo "  AGENT_SPACE_ALLOW_MARKETPLACE_PUBLISH=1 bun run deploy"
echo ""
