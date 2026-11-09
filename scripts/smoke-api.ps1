# Smoke test against the development DB. Creates real, immutable financial records.
param([string]$BaseUrl = 'http://127.0.0.1:3000')
$ErrorActionPreference = 'Stop'

function Assert-Equal([object]$Actual, [object]$Expected, [string]$Description) {
  if ([string]$Actual -ne [string]$Expected) {
    throw "$Description — expected '$Expected', received '$Actual'"
  }
}

$live = Invoke-RestMethod -Uri "$BaseUrl/health/live"
Assert-Equal $live.status 'ok' 'Liveness'
$ready = Invoke-RestMethod -Uri "$BaseUrl/health/ready"
Assert-Equal $ready.status 'ready' 'Readiness'

$playerId = [guid]::NewGuid().ToString()
$walletPayload = @{ playerId = $playerId; initialBalance = @{ amount = '100.00'; currency = 'BRL' } } | ConvertTo-Json -Depth 5
$wallet = Invoke-RestMethod -Method Post -Uri "$BaseUrl/wallets" -ContentType 'application/json' -Body $walletPayload
Assert-Equal $wallet.balance.amount '100.00' 'Opening balance'
Assert-Equal $wallet.version 1 'Opening version'

$external = [guid]::NewGuid().ToString()
$provider = 'smoke-provider'
$key = "${provider}:${external}"
$wagerPayload = @{
  providerId = $provider
  externalTransactionId = $external
  playerId = $playerId
  walletId = $wallet.id
  roundId = [guid]::NewGuid().ToString()
  gameId = 'smoke-game'
  kind = 'BET'
  money = @{ amount = '25.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 5
$headers = @{ 'Idempotency-Key' = $key }

$first = Invoke-RestMethod -Method Post -Uri "$BaseUrl/wagering/transactions" -Headers $headers -ContentType 'application/json' -Body $wagerPayload
Assert-Equal $first.status 'PROCESSED' 'BET status'
Assert-Equal $first.balance.amount '75.00' 'BET balance'
Assert-Equal $first.idempotentReplay $false 'First submission must not be a replay'

$replay = Invoke-RestMethod -Method Post -Uri "$BaseUrl/wagering/transactions" -Headers $headers -ContentType 'application/json' -Body $wagerPayload
Assert-Equal $replay.transactionId $first.transactionId 'Replay transaction ID'
Assert-Equal $replay.idempotentReplay $true 'Replay flag'
Assert-Equal $replay.balance.amount '75.00' 'Replay observed balance'

$walletNow = Invoke-RestMethod -Uri "$BaseUrl/wallets/$($wallet.id)"
Assert-Equal $walletNow.balance.amount '75.00' 'Persisted wallet balance'
$ledger = Invoke-RestMethod -Uri "$BaseUrl/wallets/$($wallet.id)/ledger?limit=10"
Assert-Equal $ledger.items.Count 2 'Opening credit + BET debit ledger count'
$reconciliation = Invoke-RestMethod -Method Post -Uri "$BaseUrl/wallets/$($wallet.id)/reconciliation"
Assert-Equal $reconciliation.consistent $true 'Reconciliation'
Assert-Equal $reconciliation.difference.amount '0.00' 'Reconciliation difference'

Write-Host "PASS: live, ready, wallet creation, BET, idempotency replay, ledger and reconciliation. Wallet ID: $($wallet.id)" -ForegroundColor Green
