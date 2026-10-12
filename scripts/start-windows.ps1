$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js is required. Install a current Node.js LTS release and run this script again.'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'npm was not found. Reinstall Node.js with npm included, then try again.'
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
    Write-Host 'Installing project dependencies…'
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
}

Write-Host 'Building Codex Insight…'
npm run build
if ($LASTEXITCODE -ne 0) { throw 'The build failed. Review the output above.' }

Write-Host ''
Write-Host 'Starting Codex Insight. Open the loopback URL printed below.'
Write-Host 'Press Ctrl+C in this window to stop the local server.'
npm start
if ($LASTEXITCODE -ne 0) { throw 'Codex Insight exited with an error.' }
