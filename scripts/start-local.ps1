$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root ".local-server.pid"

if (Test-Path $pidFile) {
    $savedPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($savedPid -and (Get-Process -Id $savedPid -ErrorAction SilentlyContinue)) {
        Start-Process "http://127.0.0.1:4173"
        Write-Host "Inspiration Catcher is already running."
        exit 0
    }
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { throw "npm is required. Install Node.js before starting Inspiration Catcher." }
if (-not (Test-Path (Join-Path $root "node_modules"))) {
    & npm.cmd ci --prefix $root
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
}
& npm.cmd run build --prefix $root
if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }

$server = Start-Process node -ArgumentList "server.mjs" -WorkingDirectory $root -WindowStyle Hidden -PassThru
Set-Content -Path $pidFile -Value $server.Id -Encoding ascii
Start-Sleep -Seconds 2

if (-not (Get-Process -Id $server.Id -ErrorAction SilentlyContinue)) {
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    throw "Server failed to start. Check that Node.js is installed."
}

Start-Process "http://127.0.0.1:4173"
Write-Host "Inspiration Catcher started: http://127.0.0.1:4173"
