$ErrorActionPreference = 'Stop'

$HostName = 'com.soundcloud.multiplay.lan'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ManifestPath = Join-Path $ScriptDir "$HostName.json"

$regRoots = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
)

foreach ($regPath in $regRoots) {
  if (Test-Path $regPath) {
    Remove-Item -Path $regPath -Force
  }
}

if (Test-Path $ManifestPath) {
  Remove-Item -Path $ManifestPath -Force
}

$AppDir = Join-Path $env:LOCALAPPDATA 'SoundCloudMultiPlay'
$BinDir = Join-Path $AppDir 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
  $filtered = @($userPath -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ine $BinDir.TrimEnd('\')) }) -join ';'
  if ($filtered -ne $userPath) {
    [Environment]::SetEnvironmentVariable('Path', $filtered, 'User')
  }
}
if (Test-Path $AppDir) {
  Remove-Item -Path $AppDir -Recurse -Force
}

Write-Host "Uninstalled Native Messaging host: $HostName" -ForegroundColor Yellow
