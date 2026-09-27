# Launch the Laya fine-tuning run detached, so it survives the terminal closing.
#
#   powershell -ExecutionPolicy Bypass -File server\train.ps1
#   Get-Content train.log -Wait      # follow progress
#
# Output goes to train.log / train.err in the project root.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$py = Join-Path $root "server\.venv\Scripts\python.exe"

if (-not (Test-Path $py)) {
    Write-Error "No virtual environment. Run: powershell -File server\start.ps1 first."
}

$env:ARTERIA_EPOCHS = if ($env:ARTERIA_EPOCHS) { $env:ARTERIA_EPOCHS } else { "2" }
$env:PYTHONUNBUFFERED = "1"

$out = Join-Path $root "train.log"
$err = Join-Path $root "train.err"
Remove-Item $out, $err -ErrorAction SilentlyContinue

$p = Start-Process -FilePath $py `
    -ArgumentList "-u", "server/finetune_traffic.py" `
    -WorkingDirectory $root `
    -RedirectStandardOutput $out `
    -RedirectStandardError $err `
    -WindowStyle Hidden `
    -PassThru

Write-Host "training started, pid $($p.Id), epochs $($env:ARTERIA_EPOCHS)"
Write-Host "follow with:  Get-Content train.log -Wait"
