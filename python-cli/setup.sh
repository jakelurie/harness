#!/bin/sh
# Create the venv and install dependencies.
#
# The normal path is just `python3 -m venv .venv && .venv/bin/pip install -r
# requirements.txt`. This machine's Homebrew python@3.14 ships a pyexpat linked
# against a libexpat newer than macOS provides, which breaks plistlib ->
# platform.mac_ver() -> pip's vendored truststore, and takes ensurepip down with
# it. The fallback below works around that. See README "Environment notes".
set -e
cd "$(dirname "$0")"

PY=${PY:-$(command -v python3.14 || command -v python3.13 || command -v python3.12 || command -v python3)}
echo "using $PY ($("$PY" -V 2>&1))"

if [ ! -d .venv ]; then
  if "$PY" -m venv .venv 2>/dev/null; then
    echo "venv created with pip"
  else
    echo "ensurepip failed - creating venv without pip and bootstrapping manually"
    rm -rf .venv
    "$PY" -m venv --without-pip .venv

    SITE=$(.venv/bin/python -c "import sysconfig;print(sysconfig.get_paths()['purelib'])")

    # Repair platform.mac_ver() for every interpreter start in this venv.
    cat > "$SITE/macver_shim.py" <<'SHIM'
import platform
import subprocess

_real = platform.mac_ver
_cached = None


def mac_ver():
    global _cached
    try:
        v = _real()
        if v[0]:
            return v
    except Exception:
        pass  # plistlib blows up when pyexpat is broken
    if _cached is None:
        try:
            _cached = subprocess.run(
                ["sw_vers", "-productVersion"], capture_output=True, text=True
            ).stdout.strip() or "0.0.0"
        except Exception:
            _cached = "0.0.0"
    return (_cached, ("", "", ""), platform.machine())


platform.mac_ver = mac_ver
SHIM
    echo "import macver_shim" > "$SITE/macver_shim.pth"

    # pip 26.2+ pre-imports its whole install path and refuses to continue when
    # any of it failed; pin an older pip that tolerates the missing pyexpat.
    PIP_WHL=$(mktemp -d)/pip.whl
    curl -sSLf -o "$PIP_WHL" \
      "https://files.pythonhosted.org/packages/py3/p/pip/pip-25.2-py3-none-any.whl"
    .venv/bin/python -c "import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" \
      "$PIP_WHL" "$SITE"
  fi
fi

# pyexpat stub, needed only while pip runs (distlib imports xmlrpc.client).
STUB=$(mktemp -d)
cat > "$STUB/pyexpat.py" <<'STUBPY'
import types

class ExpatError(Exception):
    pass

error = ExpatError
XMLParserType = type(None)
EXPAT_VERSION = "expat_2.7.0"
version_info = (2, 7, 0)
native_encoding = "UTF-8"
features = []

def ParserCreate(*args, **kwargs):
    raise ExpatError("pyexpat is unavailable (broken Homebrew build)")

def ErrorString(code):
    return "pyexpat unavailable"

model = types.ModuleType("pyexpat.model")
errors = types.ModuleType("pyexpat.errors")
errors.messages = {}
errors.codes = {}
STUBPY

if .venv/bin/python -c "import pyexpat" 2>/dev/null; then
  .venv/bin/python -m pip install -q -r requirements.txt
else
  PYTHONPATH="$STUB" .venv/bin/python -m pip install -q -r requirements.txt
fi
rm -rf "$STUB"

.venv/bin/python -c "import anthropic, openai; print('anthropic', anthropic.__version__, '/ openai', openai.__version__)"
echo
echo "done. try:  ./harness.sh models"
