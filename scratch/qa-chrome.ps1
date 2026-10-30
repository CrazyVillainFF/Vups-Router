param([string]$Url = "about:blank")
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" }
if (-not (Test-Path $chrome)) { Write-Output "chrome.exe not found"; exit 1 }
Start-Process -FilePath $chrome -ArgumentList @(
  "--remote-debugging-port=9223",
  "--user-data-dir=C:\Users\Vishnu\AppData\Local\Temp\vupsrouter-qa-profile",
  "--no-first-run",
  "--no-default-browser-check",
  $Url
)
Write-Output "launched $chrome"
