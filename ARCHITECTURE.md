# Architecture and Design Decisions

## Design boundaries

- `src/domain`: domain entities and value objects, no NestJS/ORM dependency. Constructors are encapsulated and static factories validate creation and transitions; `rehydrate` reconstructs persisted state.
- `src/application`: use cases for wallet opening, wagering, pending-reference recovery, inbox processing and outbox publishing.
- `src/database`: MikroORM entities, explicit domain mappers, transaction-scoped repositories and versioned PostgreSQL migration.
- `src/infrastructure/sqs`: AWS SDK configuration and FIFO transport.
- `src/http`: NestJS controllers, validation, consistent HTTP error mapping, read endpoints, and health probes.
- `src/workers`: independently hosted NestJS worker lifecycle for inbox, outbox, and reference polling.

This separation keeps business rules independently testable and allows HTTP API and SQS consumers to invoke the same wagering use case.

## Financial correctness

`Money` uses exact decimal arithmetic and always serializes to an amount **string** plus ISO currency. PostgreSQL stores `NUMERIC(18,2)` values; entity fields use strings, and mappers turn them into domain `Money`. No floating point calculations are permitted for ledger movements.

Wallet materialized balance is checked against the ledger with deferred PostgreSQL triggers. Ledger entries are append-only: PostgreSQL triggers reject `UPDATE`, `DELETE`, and `TRUNCATE`. Constraints validate nonnegative wallet balances, ledger debit/credit arithmetic, currency matching, uniqueness of wallet-per-player-and-currency, and one ledger entry per transaction/wallet.

Initial positive wallet balances generate a processed internal `OPENING` transaction and corresponding `CREDIT` ledger entry inside the wallet creation transaction. Zero-balance wallets have no opening ledger movement.

## Concurrency and transactional boundaries

MikroORM `EntityManager.transactional()` wraps the full unit of work. `LockMode.PESSIMISTIC_WRITE` acquires a **per-wallet** PostgreSQL row lock, rather than a global lock; operations on independent wallets can proceed concurrently. Explicit `flush()` boundaries ensure the wallet is inserted before referenced transactions and ledger entries without committing early.

A pair of concurrent `80.00 BRL` bets against `100.00 BRL` has been verified in a real PostgreSQL integration test: exactly one processed debit, one rejected insufficient-funds result, balance `20.00 BRL`.

Workers processing the outbox and pending references claim due rows using `FOR UPDATE SKIP LOCKED`, so parallel worker instances do not claim the same unit of work at the same time.

## Idempotency and out-of-order delivery

The mandatory `Idempotency-Key` and provider/external-transaction identity are persisted with uniqueness constraints. A SHA-256 hash is computed over a deterministic JSON object of business fields in fixed order (provider ID, external transaction ID, player ID, wallet ID, round ID, game ID, kind, decimal money/currency and reference external ID); transport headers, the idempotency key itself, tracing metadata and HTTP transport details are **not part of the hash**.

Same key + same business payload => original transaction ID and stored **observed balance**, with `idempotentReplay: true`; same key + different payload => HTTP conflict, no ledger entry.

A REFUND or ROLLBACK with missing reference becomes durable `PENDING_REFERENCE`, with a retry schedule and worker-managed backoff/TTL/attempt limits. Invalid or exhausted references are rejected without ledger movement.

## SQS inbox/outbox and crash recovery

Incoming FIFO wager commands use a PostgreSQL-backed inbox unique by `(consumerName, messageId)`. The inbox claim, domain wager processing, resulting ledger movement, and outbox events commit together. Only **after commit** does the SQS consumer delete the message. If the process crashes before commit, PostgreSQL rolls back and SQS redelivers; if it crashes after commit but before delete, redelivery finds the processed inbox entry and does not apply another financial movement.

The outbox publisher sends events **after** the originating financial commit and stores retry state and `publishedAt`. SQS send and database update cannot participate in one distributed atomic transaction: consequently event publication is *at-least-once*. Stable event IDs enable downstream deduplication. Poison/malformed inbound messages can be routed to the FIFO DLQ.

## HTTP and operability

The HTTP process uses the same application use cases as SQS, and the three polling workers run in a separate NestJS application context. Both use connection pools and fresh MikroORM entity managers per operation. Health is split into `/health/live` (process) and `/health/ready` (PostgreSQL and configured SQS queues). Read-only ledger cursors preserve `(created_at, id)` ordering. Reconciliation reports mismatches; it never self-heals financial state.

Lifecycle hooks stop scheduling new worker polling cycles during graceful shutdown and await in-flight cycles; a hard kill is handled by durable PostgreSQL/SQS state and retries.

## Authentication decision (technical-challenge scope)

Authentication is **not implemented** because the exercise explicitly assigns it no scoring points and prioritizes financial correctness. In production, integrate an external OIDC provider such as Keycloak or Zitadel; configure NestJS guards on wallet/wager routes, enforce JWT issuer/audience/signature, map provider identity from verified claims rather than body input, use per-provider authorization policies, and keep `/health/*` unauthenticated. The controller boundary in `src/http` is the extension point. Existing provider identifiers are business data, **not verified identity claims**.

Do not expose this unprotected API to the public internet.

## Known gaps / follow-ups

- Real three-independent-process concurrency test and 50 parallel identical wagers, on top of the already verified two-concurrent-BET scenario.
- Stronger multi-worker publisher contention/stress verification and restart/partition recovery testing.
- Full observability metrics: per-status transaction counts, duplicate count, retry/DLQ counts, PostgreSQL lock conflicts, outbox lag and processing latency. Current logging is structured for worker lifecycle and selected errors but not complete for every requested correlation dimension.
- HTTP- and worker-specific Docker Compose services if the current Compose file only contains PostgreSQL and LocalStack.
- Production security: external IdP, authorization, input-rate limits, network isolation, HTTPS, secret management, SQS IAM, and telemetry.

These limitations are documented rather than represented as already tested.
