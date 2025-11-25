param(
  [string]$BaseUrl = 'http://35.231.137.231:3000',
  [Parameter(Mandatory = $true)][string]$ApiKey,
  [string]$ChargeBoxId = 'DRBAKANA-TEST-03',
  [string]$IdTag = 'DEMO-123456',
  [int]$ConnectorId = 1
)

$ErrorActionPreference = 'Stop'

# Cabeçalhos padrão para rotas /v1/**
$headers = @{ 'X-API-Key' = $ApiKey; 'Content-Type' = 'application/json' }

function Write-Line($msg) { Write-Host $msg }

# 1) Enviar RemoteStart
Write-Line "== RemoteStart $ChargeBoxId =="
$body = @{ chargeBoxId = $ChargeBoxId; idTag = $IdTag; connectorId = $ConnectorId } | ConvertTo-Json
$res = $null
try {
  $res = Invoke-RestMethod -Method Post -Uri "$BaseUrl/v1/commands/remoteStart?force=1" -Headers $headers -Body $body
} catch {
  $raw = $_.ErrorDetails.Message
  if ($raw) { try { $res = $raw | ConvertFrom-Json } catch { Write-Line "remoteStart.error=$($_.Exception.Message)" } }
}
$cmdId = $null
$status = $null
if ($res) { $cmdId = ($res.commandId); if (-not $cmdId) { $cmdId = ($res.id) }; $status = $res.status }
Write-Line ("remoteStart.status=" + ($status))
Write-Line ("remoteStart.commandId=" + ($cmdId))

# 2) Poll da sessão ativa (~30s: 10 tentativas com Sleep 3s)
Write-Line "== Poll sessão ativa (detail) =="
$maxAttempts = 10
$sleepSeconds = 3
$txId = $null
for ($i = 1; $i -le $maxAttempts; $i++) {
  $detail = $null
  try {
    $detail = Invoke-RestMethod -Method Get -Uri "$BaseUrl/v1/sessions/active/$ChargeBoxId/detail" -Headers $headers
  } catch {
    try { $detail = Invoke-RestMethod -Method Get -Uri "$BaseUrl/v1/sessions/active/$ChargeBoxId" -Headers $headers } catch {}
  }
  if ($detail) {
    $sess = $detail.session
    if ($sess) {
      if ($sess.transaction_id) { $txId = $sess.transaction_id }
      elseif ($sess.transaction_pk) { $txId = $sess.transaction_pk }
    }
  }
  $txText = $txId
  if (-not $txText) { $txText = 'not-found' }
  Write-Line ("[try $i] transactionId=" + $txText)
  if ($txId) { break }
  Start-Sleep -Seconds $sleepSeconds
}

# 3) Listar últimos 5 eventos StartTransaction para o CP
Write-Line "== Últimos StartTransaction =="
$events = $null
try {
  $events = Invoke-RestMethod -Method Get -Uri "$BaseUrl/v1/events?event_type=StartTransaction&charge_box_id=$ChargeBoxId&limit=5&sort=desc" -Headers $headers
} catch { Write-Line "events.error=$($_.Exception.Message)" }
if ($events) {
  if (-not ($events -is [System.Array])) { $events = @($events) }
  $count = ($events | Measure-Object).Count
  Write-Line ("events.count=" + $count)
  foreach ($ev in $events) {
    $tid = $null
    if ($ev.transaction_pk) { $tid = $ev.transaction_pk }
    elseif ($ev.transactionId) { $tid = $ev.transactionId }
    elseif ($ev.transaction_id) { $tid = $ev.transaction_id }
    $ts = ($ev.created_at, $ev.timestamp, $ev.at, $ev.time) | Where-Object { $_ } | Select-Object -First 1
    Write-Line ("- txId=" + ($tid) + " ts=" + ($ts))
  }
} else {
  Write-Line "events=unavailable"
}

# 4) Contexto: OCPP online e chargers online
Write-Line "== OCPP Online IDs =="
$idsResp = $null
try { $idsResp = Invoke-RestMethod -Method Get -Uri "$BaseUrl/v1/ocpp/online" -Headers $headers } catch { Write-Line "ocpp.online.error=$($_.Exception.Message)" }
$ids = $idsResp
if ($ids -and $ids.online) { $ids = $ids.online }
elseif ($ids -and $ids.items) { $ids = $ids.items }
elseif ($ids -and $ids.ids) { $ids = $ids.ids }
if ($ids) {
  if (-not ($ids -is [System.Array])) { $ids = @($ids) }
  Write-Line ("ocpp.online.count=" + (($ids | Measure-Object).Count))
  Write-Line ("ocpp.online.sample=" + ((($ids | Select-Object -First 5)) -join ','))
} else { Write-Line "ocpp.online=unavailable" }

Write-Line "== Chargers Online =="
$online = $null
try { $online = Invoke-RestMethod -Method Get -Uri "$BaseUrl/v1/chargers/online?limit=200" -Headers $headers } catch { Write-Line "chargers.online.error=$($_.Exception.Message)" }
if ($online) {
  $cnt = ($online | Measure-Object).Count
  Write-Line ("chargers.online.count=" + $cnt)
  $sampleIds = @()
  foreach ($o in ($online | Select-Object -First 5)) {
    if ($o.chargeBoxId) { $sampleIds += $o.chargeBoxId }
    elseif ($o.id) { $sampleIds += $o.id }
  }
  Write-Line ("chargers.online.sample=" + ($sampleIds -join ','))
} else { Write-Line "chargers.online=unavailable" }

Write-Line "== Fim =="