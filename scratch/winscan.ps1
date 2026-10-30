param([switch]$Short)
$procs = @('msedge','chrome','firefox','brave','vivaldi','opera','vupsrouter')
foreach ($p in $procs) {
  Get-Process -Name $p -ErrorAction SilentlyContinue | ForEach-Object {
    [pscustomobject]@{ Name = $_.ProcessName; Id = $_.Id; Title = $_.MainWindowTitle }
  }
}
Write-Output "--- default https handler ---"
(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' -ErrorAction SilentlyContinue).ProgID
