#!/usr/bin/env bash
# Superseded. The interactive macOS installer is setup-mac.sh; Windows users run setup-windows.bat.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/setup-mac.sh" "$@"
