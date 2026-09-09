#!/bin/sh
# Launcher: uses the project venv if present, otherwise whatever python3 is around.
DIR=$(cd "$(dirname "$0")" && pwd)
if [ -x "$DIR/.venv/bin/python" ]; then
  exec "$DIR/.venv/bin/python" -m harness "$@"
fi
exec python3 -m harness "$@"
