#!/usr/bin/env bash
# Gamelib launcher — your personal Steam.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
exec ./node_modules/.bin/electron . "$@"
