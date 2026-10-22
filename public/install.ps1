# Multicode AI installer for Windows (64-bit).
#
#   irm https://multicode.in/install.ps1 | iex
#
# Downloads the current release, checks it against the published SHA-256
# checksums (and refuses anything that does not match), installs it for this
# user (no administrator rights needed) and opens it. A download made here
# rather than in a browser carries no "from the internet" mark, so Windows does
# not stop the installer with a SmartScreen warning.
#
# Settings (optional): $env:MULTICODE_SITE (default https://multicode.in),
# $env:MULTICODE_DOWNLOAD_BASE (a release folder, instead of asking the site),
# $env:MULTICODE_NO_OPEN = "1".

& {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"   # the progress bar makes large downloads very slow
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $app = "Multicode AI"

  function Fail([string]$message) { throw "Multicode AI install failed: $message" }
  function Check-Url([string]$url) {
    if ($url -notmatch '^(https://|http://127\.0\.0\.1:|http://localhost:)') { Fail "refusing to download from $url" }
  }

  if (-not [Environment]::Is64BitOperatingSystem) { Fail "Multicode AI needs 64-bit Windows." }

  $site = if ($env:MULTICODE_SITE) { $env:MULTICODE_SITE } else { "https://multicode.in" }
  $base = $env:MULTICODE_DOWNLOAD_BASE
  if (-not $base) {
    Check-Url "$site/install/latest"
    $base = (Invoke-WebRequest -UseBasicParsing "$site/install/latest").Content.Trim()
  }
  if (-not $base.EndsWith("/")) { $base = "$base/" }
  Check-Url $base

  Write-Host "Checking the latest Multicode AI release..."
  $sums = (Invoke-WebRequest -UseBasicParsing "${base}SHA256SUMS.txt").Content
  if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
  $line = $sums -split "`r?`n" | Where-Object { $_ -match '^[0-9a-f]{64}  Multicode-AI-[^ /]+-win-x64(-preview)?\.exe$' } | Select-Object -Last 1
  if (-not $line) { Fail "no Windows build in this release." }
  $hash, $name = $line -split "  ", 2

  $file = Join-Path ([IO.Path]::GetTempPath()) $name
  try {
    Write-Host "Downloading $name..."
    Invoke-WebRequest -UseBasicParsing -OutFile $file "$base$name"
    if ((Get-FileHash -Algorithm SHA256 $file).Hash.ToLowerInvariant() -ne $hash) {
      Fail "$name does not match its published checksum; nothing was installed."
    }
    Write-Host "Checksum verified."

    Get-Process -Name $app -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Host "Installing..."
    $setup = Start-Process -FilePath $file -ArgumentList "/S", "/currentuser" -Wait -PassThru
    if ($setup.ExitCode -ne 0) { Fail "the installer exited with code $($setup.ExitCode)." }
  } finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $file
  }

  $exe = Join-Path $env:LOCALAPPDATA "Programs\$app\$app.exe"
  if (-not (Test-Path $exe)) { Fail "the app was not found at $exe after installing." }
  Write-Host "Installed $app."
  if (-not $env:MULTICODE_NO_OPEN) { Start-Process -FilePath $exe }
  Write-Host "Done. Sign in with your Multicode AI account; your computer connects by itself."
}
