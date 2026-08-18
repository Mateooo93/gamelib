#!/usr/bin/env bash
# Gamelib launcher — your personal Steam.
# --disable-gpu: this is a flat UI app; avoiding the GPU process entirely
# sidesteps the Chromium "GPU process isn't usable" hard-exit seen on this box.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
exec ./node_modules/.bin/electron . --disable-gpu --ozone-platform-hint=auto "$@"
