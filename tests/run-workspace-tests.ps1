$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  Write-Host "[1/3] Build current production assets"
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw "Production build failed with exit code $LASTEXITCODE" }

  Write-Host "[2/3] Node unit, migration, and API tests"
  & node --test --test-concurrency=1 tests/workspace-text.test.mjs tests/workspace-reanchor.test.mjs tests/workspace-migration.test.mjs tests/workspace-api.test.mjs tests/workspace-completion.test.mjs tests/workspace-performance.test.mjs
  if ($LASTEXITCODE -ne 0) { throw "Node workspace tests failed with exit code $LASTEXITCODE" }

  Write-Host "[3/3] Chromium and WebKit interaction tests"
  & python tests/workspace_e2e.py
  if ($LASTEXITCODE -ne 0) { throw "Browser workspace tests failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}
