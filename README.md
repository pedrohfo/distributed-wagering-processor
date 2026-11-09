# Distributed Wagering Processor

A distributed, financial-grade wagering backend built with **Bun 1.x**, **TypeScript (strict)**, **NestJS**, **MikroORM 7**, **PostgreSQL**, **SQS FIFO / LocalStack**, and **Docker Compose**.

## What works

- Exact decimal `Money` value object (`amount` as decimal string; no floating point for monetary balances).
- `Wallet` aggregate, immutable PostgreSQL ledger, nonnegative balance constraints, wallet versioning.
- `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`, internal `OPENING` transaction, and out-of-order references.
- Persistent idempotency keyed by `Idempotency-Key`, with canonical SHA-256 business payload and response balance snapshot.
- PostgreSQL wallet row locking, uniqueness constraints, deferred ledger/balance reconciliation, and atomic outbox.
- Durable pending-reference retry with exponential backoff, TTL, and `SKIP LOCKED` worker claims.
- SQS FIFO inbox consumer, PostgreSQL-backed deduplication, ack after SQL commit, malformed-message DLQ, and separate outbox publisher.
- NestJS API and independent NestJS worker process, shutdown hooks, health endpoints.

## Requirements

- Bun 1.x, Docker Engine with Docker Compose, Windows PowerShell or equivalent shell.
- PostgreSQL and LocalStack started by the project's existing `docker-compose.yml`.
- The `backend` database configured by `.env` (development) and optional test databases `backend_test`, `backend_sqs_test`.

## Setup

```powershell
Copy-Item .env.example .env # development-only defaults; adjust as needed
bun install
docker compose up -d
bunx mikro-orm debug
bunx mikro-orm migration:up
bun run scripts/setup-sqs.ts
```

Use the printed queue URLs for the following variables (exact values depend on LocalStack):

```powershell
$env:DB_NAME = 'backend'
$env:DB_HOST = '127.0.0.1'
$env:DB_PORT = '5434' # existing Compose port mapping; adjust for your environment
$env:DB_USER = 'postgres'
$env:DB_PASSWORD = 'postgres'
$env:AWS_REGION = 'us-east-1'
$env:AWS_ACCESS_KEY_ID = 'test'
$env:AWS_SECRET_ACCESS_KEY = 'test'
$env:SQS_ENDPOINT = 'http://127.0.0.1:4566'
$env:SQS_INBOX_QUEUE_URL = '<from setup-sqs.ts>'
$env:SQS_INBOX_DLQ_URL = '<from setup-sqs.ts>'
$env:SQS_OUTBOX_QUEUE_URL = '<from setup-sqs.ts>'
```

**Start HTTP API** (terminal 1):

```powershell
bun run scripts/run-api.ts
```

**Start background workers** (terminal 2; use the same development database/queue configuration):

```powershell
$env:WORKERS_ENABLED = '1'
bun run scripts/run-workers.ts
```

**Smoke test** (terminal 3):

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health/live
Invoke-RestMethod http://127.0.0.1:3000/health/ready
.\scripts\smoke-api.ps1
```

## HTTP API

| Method | Route |
|---|---|
| POST | `/wallets` |
| GET | `/wallets/:walletId` |
| GET | `/wallets/:walletId/ledger?limit=50&cursor=...` |
| POST | `/wallets/:walletId/reconciliation` |
| POST | `/wagering/transactions` (mandatory `Idempotency-Key` header) |
| GET | `/wagering/transactions/:transactionId` |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` |
| GET | `/health/live` |
| GET | `/health/ready` |

Sample wager request:

```http
POST /wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:transaction-123

{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "player-uuid",
  "walletId": "wallet-uuid",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

HTTP codes distinguish invalid requests (400), unknown entities (404), conflicts (409), business rejections (422), pending references (202), successful processing or replay (200), and unavailable infrastructure (503).

## Testing

Domain/unit tests (no special DB overrides):

```powershell
bunx tsc --noEmit
bun test src/domain
bun test src/workers/worker-loop.spec.ts
bun test src/http/http-validation.spec.ts
```

PostgreSQL-only integration suite (set test DB and enable guard):

```powershell
$env:DB_NAME = 'backend_test'
$env:RUN_DB_INTEGRATION = '1'
Remove-Item Env:RUN_SQS_INTEGRATION -ErrorAction SilentlyContinue
bunx mikro-orm migration:up
bun test
```

LocalStack+PostgreSQL integration suite (separate DB, queues configured):

```powershell
$env:DB_NAME = 'backend_sqs_test'
$env:RUN_SQS_INTEGRATION = '1'
Remove-Item Env:RUN_DB_INTEGRATION -ErrorAction SilentlyContinue
bunx mikro-orm migration:up
bun test
```

The integration suites deliberately use **different database names**. Their totals should not be added as if one command had executed them all. Tests inject synthetic crashes/outages to exercise retry paths, and corresponding warning logs are expected.

## Failure guarantees and limitations

- Ledger rows are immutable (database triggers forbid update/delete/truncate) and must not be cleaned up after test runs.
- All wallet/transaction/ledger/outbox changes commit in one PostgreSQL transaction. The SQS consumer acknowledges only after commit.
- SQS FIFO is an ordering aid, **not** an exactly-once guarantee; inbox keys, idempotency keys and PostgreSQL constraints provide durable correctness.
- Integration events may publish more than once if a process crashes between SQS send and `publishedAt` persistence; consumers must deduplicate by event ID.
- Authentication is intentionally not implemented in this technical challenge (zero rubric points). See `ARCHITECTURE.md` for intended OIDC/guard extension.
- Multi-process scale, 50-parallel duplicate operations, lock-contention benchmarks, outbox lag histograms, and containerized API/worker service definitions are **not claimed verified unless separately demonstrated**.

See `ARCHITECTURE.md` for architecture decisions, tradeoffs, and test gaps.

## Submission verification

Run `bunx tsc --noEmit`, `bun test`, and the PowerShell HTTP smoke script (on Windows PowerShell 5.1, use `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-api.ps1`). Database integration tests intentionally require separate `backend_test` and `backend_sqs_test` databases. `docker-compose.yml` currently hosts only PostgreSQL and LocalStack: launch API and worker processes with the Bun commands above; multiple-process stress verification remains an explicit follow-up, not a tested guarantee.
