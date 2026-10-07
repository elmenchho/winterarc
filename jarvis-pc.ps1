# JARVIS fuer Windows - Begruessung beim Anmelden + Spotify
# Einrichten:  powershell -ExecutionPolicy Bypass -File jarvis-pc.ps1 -Setup
param([switch]$Setup, [switch]$Music)
$ErrorActionPreference = 'Stop'
$Server = 'https://91-98-2-107.sslip.io'
$Dir = Join-Path $env:APPDATA 'Jarvis'
$Cfg = Join-Path $Dir 'config.json'
$Self = Join-Path $Dir 'jarvis-pc.ps1'
New-Item -ItemType Directory -Force $Dir | Out-Null

function Say-Local($t) {
  try { Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
        $v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'de*' } | Select-Object -First 1
        if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }; $s.Speak($t) } catch {}
}

if ($Setup -or -not (Test-Path $Cfg)) {
  Write-Host ''
  Write-Host '  J.A.R.V.I.S.  -  PC-Einrichtung' -ForegroundColor Cyan
  Write-Host ''
  Write-Host '  Kopplungscode auf dem Server erzeugen:  sudo -u jarvis node /opt/jarvis/jarvis-server.js pair'
  $code = (Read-Host '  Kopplungscode').Trim().ToUpper()
  $r = Invoke-RestMethod -Method Post -Uri "$Server/api/pair" -ContentType 'application/json' -Body (@{ code = $code; name = 'Windows-PC' } | ConvertTo-Json)
  $tok = ConvertTo-SecureString $r.token -AsPlainText -Force | ConvertFrom-SecureString   # verschluesselt mit deinem Windows-Konto (DPAPI)
  Write-Host ''
  Write-Host '  Spotify: In der App bei deiner Playlist/Song auf "..." > Teilen > Link kopieren.'
  $sp = Read-Host '  Spotify-Link einfuegen (leer = keine Musik)'
  $uri = ''
  if ($sp -match 'open\.spotify\.com/(?:intl-[a-z]+/)?(playlist|album|track|artist)/([A-Za-z0-9]+)') { $uri = "spotify:$($Matches[1]):$($Matches[2])" }
  elseif ($sp -match '^spotify:') { $uri = $sp.Trim() }
  @{ server = $Server; token = $tok; spotify = $uri } | ConvertTo-Json | Set-Content $Cfg -Encoding UTF8
  if ($PSCommandPath -and $PSCommandPath -ne $Self) { Copy-Item $PSCommandPath $Self -Force }
  $startup = [Environment]::GetFolderPath('Startup')
  "@echo off`r`nstart `"`" /min powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Self`"" |
    Set-Content (Join-Path $startup 'JARVIS.cmd') -Encoding ASCII
  Write-Host ''
  Write-Host '  Fertig. JARVIS startet ab jetzt bei jeder Anmeldung. Test laeuft...' -ForegroundColor Green
}

$c = Get-Content $Cfg -Raw | ConvertFrom-Json
$tok = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR((ConvertTo-SecureString $c.token)))

if (-not $Music) {
  Start-Sleep -Seconds 4
  $mp3 = Join-Path $env:TEMP 'jarvis-greet.mp3'
  $ok = $false
  for ($i = 0; $i -lt 10 -and -not $ok; $i++) {
    try {
      $resp = Invoke-WebRequest -Method Post -Uri "$($c.server)/api/greet" -Headers @{ Authorization = "Bearer $tok" } -UseBasicParsing -TimeoutSec 40
      if ($resp.Headers['Content-Type'] -like 'audio/*') { [IO.File]::WriteAllBytes($mp3, $resp.Content); $ok = $true }
      else { $j = $resp.Content | ConvertFrom-Json; Say-Local $j.text; $ok = 'said' }
    } catch { Start-Sleep -Seconds 3 }
  }
  if ($ok -eq $true) {
    $p = New-Object -ComObject WMPlayer.OCX
    $p.settings.volume = 90; $p.URL = $mp3; $p.controls.play()
    $t = 0; Start-Sleep -Milliseconds 800
    while ($t -lt 90 -and $p.playState -ne 1 -and $p.playState -ne 8) { Start-Sleep -Milliseconds 300; $t += 0.3 }
    $p.close()
  } elseif (-not $ok) { Say-Local 'Willkommen zurück, Sir. Mein Server ist gerade nicht erreichbar.' }
}

if ($c.spotify) {
  Start-Process $c.spotify
  Start-Sleep -Seconds 7
  Add-Type -Namespace J -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);'
  [J.K]::keybd_event(0xB3, 0, 0, [UIntPtr]::Zero); [J.K]::keybd_event(0xB3, 0, 2, [UIntPtr]::Zero)   # Play
}
