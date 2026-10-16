#!/usr/bin/env bash
# Link the installed DeepSeek Harness packages this bundle imports into this
# checkout, so a *local-path* install can resolve them.
#
# Why this is needed: `dsh plugin add /abs/path` installs a `link:` dependency,
# and Node's ESM resolver follows that symlink to this repository's real path.
# Resolution then walks up from here and never reaches the profile's
# node_modules. A git install has no such problem, so this is a development
# convenience, not part of a normal install.
#
# Usage: scripts/dev-link.sh [directory containing @deepseek-ai/dsh-*]
#   DSH_PACKAGE_DIR  same, via environment
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
packages=(cordis dsh-tools dsh-commands dsh-system-prompt schemastery)

resolve() {
	local target="$1" dir
	while [ -L "$target" ]; do
		dir="$(cd "$(dirname "$target")" && pwd)"
		target="$(readlink "$target")"
		case "$target" in
		/*) ;;
		*) target="$dir/$target" ;;
		esac
	done
	printf '%s\n' "$target"
}

has_packages() { [ -d "$1/cordis" ] && [ -d "$1/dsh-tools" ]; }

package_dir="${1:-${DSH_PACKAGE_DIR:-}}"

if [ -z "$package_dir" ]; then
	dsh_bin="$(command -v dsh || true)"
	if [ -z "$dsh_bin" ]; then
		echo "dev-link: cannot find 'dsh' on PATH; pass the directory holding @deepseek-ai/dsh-* instead" >&2
		exit 1
	fi
	dsh_pkg="$(cd "$(dirname "$(resolve "$dsh_bin")")/.." && pwd)"
	for candidate in "$dsh_pkg/node_modules/@deepseek-ai" "$(dirname "$dsh_pkg")"; do
		if has_packages "$candidate"; then
			package_dir="$candidate"
			break
		fi
	done
fi

if [ -z "$package_dir" ] || ! has_packages "$package_dir"; then
	echo "dev-link: no cordis/dsh-tools under '${package_dir:-<unresolved>}'" >&2
	exit 1
fi

mkdir -p "$here/node_modules/@deepseek-ai"
for pkg in "${packages[@]}"; do
	ln -sfn "$(cd "$package_dir" && pwd)/$pkg" "$here/node_modules/@deepseek-ai/$pkg"
	echo "dev-link: linked $pkg"
done
echo "dev-link: local-path installs can now resolve the harness packages"
