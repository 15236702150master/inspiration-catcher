$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root ".local-server.pid"

if (-not (Test-Path $pidFile)) {
    Write-Host "Inspiration Catcher is not running locally."
    exit 0
}

$savedPid = Get-Content $pidFile -ErrorAction SilentlyContinue
if ($savedPid) {
    Stop-Process -Id $savedPid -Force -ErrorAction SilentlyContinue
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "Inspiration Catcher stopped."
