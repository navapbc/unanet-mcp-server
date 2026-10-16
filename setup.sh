#!/usr/bin/env bash
# Superseded. The interactive macOS installer is setup-mac.sh; Windows users run setup-windows.bat.
if [[ "$(uname -s)" != "Darwin" ]]; then
	echo "setup.sh runs the macOS installer. On other systems follow the manual steps in README.md." >&2
	exit 1
fi
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/setup-mac.sh" "$@"
