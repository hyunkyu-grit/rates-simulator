$proc = Get-Process -Name Code -ErrorAction SilentlyContinue
if ($proc) { Stop-Process -InputObject $proc -Force }
Start-Sleep -Milliseconds 500
$paths = @(
  Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'
  Join-Path $env:ProgramFiles 'Microsoft VS Code\Code.exe'
  'C:\Program Files (x86)\Microsoft VS Code\Code.exe'
)
$codePath = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $codePath) {
  $cmd = Get-Command code -ErrorAction SilentlyContinue
  if ($cmd) { $codePath = $cmd.Source }
}
if (-not $codePath) { Write-Output 'CODE_NOT_FOUND'; exit 2 }
Start-Process -FilePath $codePath -ArgumentList 'C:\Users\infomax\Desktop\vibe coding\rates-simulator'
Write-Output 'RESTARTED'
