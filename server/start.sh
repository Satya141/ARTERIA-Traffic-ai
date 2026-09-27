#!/usr/bin/env bash
# Start the ARTERIA Laya decision sidecar.
set -e
cd "$(dirname "$0")/.."
PY=server/.venv/Scripts/python.exe
[ -x "$PY" ] || PY=server/.venv/bin/python
if [ ! -x "$PY" ]; then
  python -m venv server/.venv
  [ -x server/.venv/Scripts/python.exe ] && PY=server/.venv/Scripts/python.exe || PY=server/.venv/bin/python
  "$PY" -m pip install --upgrade pip
  "$PY" -m pip install -r server/requirements.txt
fi
exec "$PY" server/laya_service.py
