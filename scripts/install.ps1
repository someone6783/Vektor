<# Vektor Windows installer. Use -Docker for separate API/web containers, -Open to sign in again. #>
[CmdletBinding()]
param(
  [switch]$Docker,
  [switch]$Open,
  [string]$Version = 'latest',
  [string]$Directory = (Join-Path $env:LOCALAPPDATA 'Vektor-Docker')
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = 'someone6783/Vektor'
if ($Version -ne 'latest' -and $Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Use a stable version such as 0.1.0.' }
if ($Docker -or $Open) {
  & docker compose version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Install and start Docker Desktop with Compose v2.' }
  & docker info | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop and try again.' }
}
$work = Join-Path ([IO.Path]::GetTempPath()) ('vektor-install-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  if (-not $Open) {
    if ($Version -eq 'latest') {
      $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest"
      $Version = $release.tag_name -replace '^v', ''
      if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'No stable release found.' }
    }
    $base = "https://github.com/$repo/releases/download/v$Version"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile (Join-Path $work 'SHA256SUMS')
  }
  function Get-VerifiedAsset([string]$Name) {
    $path = Join-Path $work $Name
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$Name" -OutFile $path
    $lines = @(Get-Content (Join-Path $work 'SHA256SUMS') | Where-Object { $_ -match ('^[a-f0-9]{64}  ' + [regex]::Escape($Name) + '$') })
    if ($lines.Count -ne 1 -or (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lines[0].Substring(0,64)) { throw "Release checksum verification failed: $Name" }
    return $path
  }
  if (-not $Docker -and -not $Open) {
    if ($env:PROCESSOR_ARCHITECTURE -notin @('AMD64', 'ARM64')) { throw 'The desktop installer requires 64-bit Windows.' }
    $installer = Get-VerifiedAsset "Vektor_${Version}_x64-setup.exe"
    $process = Start-Process -FilePath $installer -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Desktop installation did not complete (exit $($process.ExitCode))." }
    Write-Host 'Vektor installed. Open Vektor from Start to choose local service or Docker.'
    return
  }
  New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  if ($Docker -and -not $Open) {
    $compose = Get-VerifiedAsset 'compose.yaml'
    $launcher = Get-VerifiedAsset 'open-workspace.mjs'
    $destination = Join-Path $Directory 'compose.yaml'
    if (Test-Path $destination) {
      Copy-Item $compose (Join-Path $Directory 'compose.release.new.yaml')
      Write-Host 'Existing compose.yaml preserved. New template saved as compose.release.new.yaml.'
    } else { Copy-Item $compose $destination }
    Copy-Item $launcher (Join-Path $Directory 'open-workspace.mjs') -Force
    @("VEKTOR_IMAGE=ghcr.io/someone6783/vektor:$Version", "VEKTOR_WEB_IMAGE=ghcr.io/someone6783/vektor-web:$Version") | Set-Content (Join-Path $Directory 'release.env') -Encoding ascii
  }
  if (-not (Test-Path (Join-Path $Directory 'compose.yaml')) -or -not (Test-Path (Join-Path $Directory 'open-workspace.mjs'))) { throw 'Run with -Docker once before -Open.' }
  Push-Location $Directory
  try {
    $composeArgs = @('compose')
    if (Test-Path '.env') { $composeArgs += @('--env-file', '.env') }
    $composeArgs += @('--env-file', 'release.env', '-f', 'compose.yaml')
    if ($Docker -and -not $Open) {
      & docker @composeArgs pull
      if ($LASTEXITCODE -ne 0) { throw 'Downloading containers failed.' }
      & docker @composeArgs up -d --wait --wait-timeout 180
      if ($LASTEXITCODE -ne 0) { throw 'Containers did not become healthy. Check docker compose logs.' }
    }
    $source = Get-Content 'open-workspace.mjs' -Raw
    $link = ($source | & docker @composeArgs exec -T vektor node --input-type=module | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $link -notmatch '^http://127\.0\.0\.1:8788/\?signin=1#setup=[A-Za-z0-9_-]{43}$') { throw 'Could not create a sign-in link.' }
    Start-Process $link
    Write-Host 'Vektor is ready. The API and web UI run in separate containers.'
  } finally { Pop-Location }
} finally { Remove-Item -LiteralPath $work -Recurse -Force }
