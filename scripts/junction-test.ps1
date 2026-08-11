Set-Location d:\workagent
Get-PSDrive D | Format-List Name, Provider, Root, DisplayRoot
New-Item -ItemType Directory -Path d:\workagent\.jt-src -Force | Out-Null
"hello" | Out-File d:\workagent\.jt-src\test.txt
cmd /c mklink /J d:\workagent\.jt-link d:\workagent\.jt-src
Write-Output "--- read through junction ---"
Get-Content d:\workagent\.jt-link\test.txt -ErrorAction SilentlyContinue
Write-Output "--- existing broken junction reparse target ---"
fsutil reparsepoint query d:\workagent\node_modules\vitest | Select-Object -First 6
