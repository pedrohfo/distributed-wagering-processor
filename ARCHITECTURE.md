# Distributed Wagering Processor — Architecture (draft)

## Purpose and scope

This document records design decisions for the technical challenge. Phase 1 implements only the financial domain primitives (`Money`, `Wallet`, `WalletLedgerEntry`) and their unit tests. **No SQL, SQS, API or concurrency guarantees are delivered by Phase 1 alone.**

## Decisions

- **Stack:** Bun 1.x, strict TypeScript, NestJS, MikroORM, PostgreSQL, LocalStack SQS, Docker Compose.
- **Domain isolation:** domain classes have no imports from NestJS, MikroORM, or transport DTOs. Persistence entities are separate adapters and domain objects are rehydrated by factories.
- **Money:** `decimal.js`; externally accept nonnegative decimal strings with at most two fractional digits, serialize exactly two decimal digits, reject rounding and out-of-range values; bound to PostgreSQL `NUMERIC(18,2)`. Negative values may arise only from internal arithmetic for differences. ISO currency codes are currently validated structurally (`[A-Z]{3}`); API can restrict to BRL per challenge scope. The ISO-4217 membership check remains to be added at the transport boundary if supporting more currencies.
- **Opening balance:** `Wallet.open` creates the aggregate with version 1. The wallet-creation *use case* MUST atomically insert the wallet, internal `OPENING` wager transaction and matching credit ledger for nonzero balance. A `Wallet.openingEntry()` helper builds the latter; calling the domain factory alone does not persist records.
- **Concurrency (planned):** lock a single wallet row with `SELECT ... FOR UPDATE` / `LockMode.PESSIMISTIC_WRITE` in each financial SQL transaction, not a global lock. Each request holds the lock until wallet, transaction status, ledger, inbox and outbox commit together.
- **Idempotency (planned):** `UNIQUE(provider_id, external_transaction_id)` and `UNIQUE(idempotency_key)` in PostgreSQL, stable canonical JSON payload SHA-256, return original persisted response for exact replay; reject same key with different hash.
- **Constraints (planned):** wallet `UNIQUE(player_id, currency)`, `CHECK(balance >= 0)`, `CHECK(version >= 1)`; immutable ledger enforced by rejecting SQL UPDATE/DELETE via database trigger or restricted privileges; `UNIQUE(wallet_id, transaction_id)` in ledger; appropriate FK, positive amount, currency and transition constraints.
- **Migration policy:** SQL migrations version-controlled with explicit `up()` and `down()`; rollback is tested against PostgreSQL. Schema sync must not run at application startup.
- **Outbox (planned):** atomically write integration events to SQL outbox. Concurrent publishers claim work with `FOR UPDATE SKIP LOCKED`, publish after commit, then mark published. Since crash can occur between SQS publish and mark-as-published, consumers must deduplicate by event ID.
- **SQS (planned):** `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (and an output events destination), `MessageGroupId = walletId` as an ordering optimization, persistent inbox as final dedup guarantee; SQS messages are acknowledged only after SQL commit.
- **Out-of-order references (planned):** persist `PENDING_REFERENCE`, retry with bounded exponential backoff via a scheduled worker, reject with stable failure code after timeout/attempt cap.
- **Authentication:** defer external IdP integration to focus on scored requirements. Expose a clearly marked authorization guard/identity-port extension seam; never implement custom password storage. Health endpoints remain public.
- **Tests:** Bun test runner; pure domain tests followed by real PostgreSQL + LocalStack integration tests, then multi-process races and crash recovery.

## Notes and limitations

- `Money`'s decimal input accepts `25`, `25.0` and `25.00`, but produces canonical `25.00` output. No implicit rounding is performed.
- The domain itself cannot ensure atomic persistence; the application service and SQL constraints must do that in Phase 2 and 3.
- The sample UUID-like identifiers in pure unit tests are not persisted. Database IDs will use UUIDs.
- Financial transaction reversal rules, inbox/outbox, API response caching, reconciliation, auth and observability remain unimplemented in this phase.
