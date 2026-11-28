param(
  [string]$ExtensionId = ''
)

$ErrorActionPreference = 'Stop'

$HostName = 'com.soundcloud.multiplay.lan'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir '..')).Path.TrimEnd('\').ToLowerInvariant()
$ServerPath = Join-Path $ScriptDir 'server.js'
$WrapperPath = Join-Path $ScriptDir 'native-host.cmd'
$ManifestPath = Join-Path $ScriptDir "$HostName.json"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw 'Node.js was not found in PATH. Install Node.js first.'
}
$NodeExe = $nodeCmd.Source

# Update native-host.cmd with the exact node.exe path so Chrome can launch it regardless of PATH
$cmdContent = "@echo off`r`n`"$NodeExe`" `"%~dp0server.js`" --native`r`n"
[System.IO.File]::WriteAllText($WrapperPath, $cmdContent, [System.Text.Encoding]::ASCII)

$ids = New-Object System.Collections.Generic.HashSet[string]
if ($ExtensionId) {
  $cleanId = $ExtensionId.Trim().ToLowerInvariant()
  if ($cleanId -notmatch '^[a-p]{32}$') {
    throw "Invalid Chrome extension ID: $ExtensionId"
  }
  [void]$ids.Add($cleanId)
} else {
  $userDataDirs = @(
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data'),
    (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\User Data')
  )
  foreach ($base in $userDataDirs) {
    if (-not (Test-Path $base)) { continue }
    $prefFiles = Get-ChildItem -Path $base -Recurse -Depth 2 -Include 'Secure Preferences','Preferences' -ErrorAction SilentlyContinue
    foreach ($pf in $prefFiles) {
      try {
        $json = Get-Content -Raw -Path $pf.FullName | ConvertFrom-Json
        $settings = $json.extensions.settings
        if (-not $settings) { continue }
        foreach ($prop in $settings.PSObject.Properties) {
          $extPath = $prop.Value.path
          if ($extPath -and ($extPath.TrimEnd('\').ToLowerInvariant() -eq $RepoRoot)) {
            [void]$ids.Add($prop.Name.ToLowerInvariant())
          }
        }
      } catch {
        # Skip unreadable preference files
      }
    }
  }
}

if ($ids.Count -eq 0) {
  throw "Could not auto-detect the extension ID for $RepoRoot. Pass -ExtensionId <32-char-id> (copy it from the extension popup or chrome://extensions)."
}

$allowedOrigins = @($ids | ForEach-Object { "chrome-extension://$_/" })
$manifestObj = [ordered]@{
  name = $HostName
  description = 'SoundCloud Multi-Play LAN Remote Companion Server'
  path = $WrapperPath
  type = 'stdio'
  allowed_origins = $allowedOrigins
}

$manifestJson = $manifestObj | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($ManifestPath, $manifestJson, (New-Object System.Text.UTF8Encoding($false)))

$regRoots = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
)

foreach ($regPath in $regRoots) {
  New-Item -Path $regPath -Force | Out-Null
  Set-ItemProperty -Path $regPath -Name '(Default)' -Value $ManifestPath
}

# Install a global `sc-remote` command in user PATH so manual server runs work from any directory
$BinDir = Join-Path $env:LOCALAPPDATA 'SoundCloudMultiPlay\bin'
New-Item -Path $BinDir -ItemType Directory -Force | Out-Null
$ShimPath = Join-Path $BinDir 'sc-remote.cmd'
$shimContent = "@echo off`r`n`"$NodeExe`" `"$ServerPath`" %*`r`n"
[System.IO.File]::WriteAllText($ShimPath, $shimContent, [System.Text.Encoding]::ASCII)

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$pathParts = @($userPath -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ine $BinDir.TrimEnd('\')) })
$nextUserPath = (@($pathParts) + $BinDir) -join ';'
if ($userPath -ne $nextUserPath) {
  [Environment]::SetEnvironmentVariable('Path', $nextUserPath, 'User')
}

Write-Host ''
Write-Host "  Installed Native Messaging host: $HostName" -ForegroundColor Green
Write-Host "  Manifest : $ManifestPath"
Write-Host "  Launcher : $WrapperPath"
Write-Host "  CLI Shim : $ShimPath (run 'sc-remote' from any new terminal)"
Write-Host "  Origins  : $($allowedOrigins -join ', ')"
Write-Host ''
Write-Host '  Reload SoundCloud Multi-Play in chrome://extensions and toggle LAN Mobile Remote on.'
Write-Host ''
