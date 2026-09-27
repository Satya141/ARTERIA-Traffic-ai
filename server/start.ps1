# Start the ARTERIA Laya decision sidecar.
#   powershell -ExecutionPolicy Bypass -File server\start.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$py = Join-Path $root "server\.venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "Creating virtual environment..."
    python -m venv (Join-Path $root "server\.venv")
    & $py -m pip install --upgrade pip
    & $py -m pip install -r (Join-Path $root "server\requirements.txt")
}
& $py (Join-Path $root "server\laya_service.py")
