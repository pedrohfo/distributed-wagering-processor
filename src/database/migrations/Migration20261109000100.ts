import { Migration } from '@mikro-orm/migrations';

/**
 * Initial financial persistence schema. All changes are transactional.
 * PostgreSQL deferred constraint triggers reconcile final commit-time state.
 */
export class Migration20261109000100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table wallets (
  id text primary key,
  player_id text not null,
  currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
  balance numeric(18,2) not null default 0 check (balance >= 0),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wallets_player_currency_unique unique (player_id, currency),
  constraint wallets_identity_currency_unique unique (id, currency),
  constraint wallets_full_identity_unique unique (id, player_id, currency)
)`);
    this.addSql(`create table wager_transactions (
  id text primary key,
  provider_id text not null,
  external_transaction_id text not null,
  idempotency_key text not null,
  payload_hash char(64) not null check (payload_hash ~ '^[a-fA-F0-9]{64}$'),
  wallet_id text not null,
  player_id text not null,
  round_id text,
  game_id text,
  kind text not null check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount numeric(18,2) not null check (amount > 0),
  currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
  reference_external_transaction_id text,
  reference_transaction_id text,
  status text not null check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  failure_code text,
  processed_at timestamptz,
  observed_balance numeric(18,2) check (observed_balance >= 0),
  retry_attempts integer not null default 0 check (retry_attempts >= 0),
  next_retry_at timestamptz,
  created_at timestamptz not null default now(),
  constraint wager_tx_idempotency_unique unique (idempotency_key),
  constraint wager_tx_provider_external_unique unique (provider_id, external_transaction_id),
  constraint wager_tx_wallet_currency_unique unique (id, wallet_id, currency),
  constraint wager_tx_wallet_identity_fk foreign key (wallet_id, player_id, currency)
    references wallets (id, player_id, currency) on delete restrict,
  constraint wager_tx_reference_fk foreign key (reference_transaction_id)
    references wager_transactions (id) on delete restrict,
  constraint wager_tx_kind_fields_ck check (
    (kind = 'OPENING' and provider_id = '__internal__' and round_id is null and game_id is null)
    or (kind <> 'OPENING' and provider_id <> '__internal__' and round_id is not null and game_id is not null)
  ),
  constraint wager_tx_reference_required_ck check (
    kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null
  ),
  constraint wager_tx_status_fields_ck check (
    (status = 'PROCESSED' and processed_at is not null and failure_code is null)
    or (status in ('REJECTED','FAILED') and failure_code is not null and processed_at is null)
    or (status in ('PENDING','PENDING_REFERENCE') and failure_code is null and processed_at is null)
  )
)`);
    this.addSql(`create table wallet_ledger_entries (
  id text primary key,
  wallet_id text not null,
  transaction_id text not null,
  direction text not null check (direction in ('DEBIT','CREDIT')),
  amount numeric(18,2) not null check (amount > 0),
  currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
  balance_before numeric(18,2) not null check (balance_before >= 0),
  balance_after numeric(18,2) not null check (balance_after >= 0),
  created_at timestamptz not null default now(),
  constraint ledger_one_entry_per_tx_wallet unique (wallet_id, transaction_id),
  constraint ledger_wallet_currency_fk foreign key (wallet_id, currency)
    references wallets (id, currency) on delete restrict,
  constraint ledger_transaction_fk foreign key (transaction_id, wallet_id, currency)
    references wager_transactions (id, wallet_id, currency) on delete restrict,
  constraint ledger_arithmetic_ck check (
    (direction = 'CREDIT' and balance_after = balance_before + amount)
    or (direction = 'DEBIT' and balance_after = balance_before - amount)
  )
)`);
    this.addSql(`create table inbox_messages (
  consumer_name text not null,
  message_id text not null,
  payload_hash char(64) not null check (payload_hash ~ '^[a-fA-F0-9]{64}$'),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint inbox_messages_pk primary key (consumer_name, message_id),
  constraint inbox_processed_chronology_ck check (processed_at is null or processed_at >= received_at)
)`);
    this.addSql(`create table outbox_messages (
  id text primary key,
  aggregate_id text not null,
  event_type text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  published_at timestamptz,
  constraint outbox_publish_schedule_ck check (published_at is null or next_attempt_at is null)
)`);
    this.addSql(`create index wager_tx_wallet_created_idx on wager_transactions (wallet_id, created_at desc, id desc)`);
    this.addSql(`create index wager_tx_reference_lookup_idx on wager_transactions (provider_id, reference_external_transaction_id) where reference_external_transaction_id is not null`);
    this.addSql(`create index wager_tx_reference_pending_idx on wager_transactions (next_retry_at, created_at) where status = 'PENDING_REFERENCE' `);
    this.addSql(`create unique index wager_tx_one_processed_reversal_idx on wager_transactions (provider_id, reference_external_transaction_id, kind) where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED' `);
    this.addSql(`create index ledger_wallet_cursor_idx on wallet_ledger_entries (wallet_id, created_at desc, id desc)`);
    this.addSql(`create index outbox_due_idx on outbox_messages (coalesce(next_attempt_at, occurred_at), occurred_at, id) where published_at is null`);
    this.addSql(`create index inbox_unprocessed_idx on inbox_messages (received_at) where processed_at is null`);
    this.addSql(`create function prevent_ledger_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'wallet_ledger_entries is append-only' using errcode = '23514';
end;
$$`);
    this.addSql(`create trigger ledger_no_update_delete before update or delete on wallet_ledger_entries for each row execute function prevent_ledger_mutation()`);
    this.addSql(`create trigger ledger_no_truncate before truncate on wallet_ledger_entries for each statement execute function prevent_ledger_mutation()`);
    this.addSql(`create function enforce_wallet_version() returns trigger language plpgsql as $$
begin
  if new.balance is distinct from old.balance then
    if new.version <> old.version + 1 then
      raise exception 'wallet version must increment by exactly one on balance change' using errcode = '23514';
    end if;
  elsif new.version <> old.version then
    raise exception 'wallet version may not change without balance change' using errcode = '23514';
  end if;
  return new;
end;
$$`);
    this.addSql(`create trigger wallets_version_guard before update on wallets for each row execute function enforce_wallet_version()`);
    this.addSql(`create function assert_wallet_ledger_sum() returns trigger language plpgsql as $$
declare
  target_wallet text;
  stored_balance numeric(18,2);
  ledger_balance numeric;
begin
  if tg_table_name = 'wallets' then
    target_wallet := new.id;
  else
    target_wallet := new.wallet_id;
  end if;
  select balance into stored_balance from wallets where id = target_wallet;
  if not found then return null; end if;
  select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)
    into ledger_balance from wallet_ledger_entries where wallet_id = target_wallet;
  if stored_balance <> ledger_balance then
    raise exception 'wallet % balance % does not reconcile with ledger %', target_wallet, stored_balance, ledger_balance
      using errcode = '23514';
  end if;
  return null;
end;
$$`);
    this.addSql(`create constraint trigger wallet_balance_reconciles after insert or update on wallets
  deferrable initially deferred for each row execute function assert_wallet_ledger_sum()`);
    this.addSql(`create constraint trigger ledger_balance_reconciles after insert on wallet_ledger_entries
  deferrable initially deferred for each row execute function assert_wallet_ledger_sum()`);
    this.addSql(`create function assert_transaction_ledger() returns trigger language plpgsql as $$
declare
  target_tx text;
  tx_kind text;
  tx_status text;
  ledger_count integer;
begin
  if tg_table_name = 'wager_transactions' then
    target_tx := new.id;
  else
    target_tx := new.transaction_id;
  end if;
  select kind, status into tx_kind, tx_status from wager_transactions where id = target_tx;
  if not found then return null; end if;
  select count(*) into ledger_count from wallet_ledger_entries where transaction_id = target_tx;
  if (tx_status = 'PROCESSED' and tx_kind <> 'LOSS' and ledger_count <> 1)
     or ((tx_status <> 'PROCESSED' or tx_kind = 'LOSS') and ledger_count <> 0) then
     raise exception 'transaction % kind % status % requires a different ledger count (found %)', target_tx, tx_kind, tx_status, ledger_count
       using errcode = '23514';
  end if;
  return null;
end;
$$`);
    this.addSql(`create constraint trigger tx_ledger_matches after insert or update on wager_transactions
  deferrable initially deferred for each row execute function assert_transaction_ledger()`);
    this.addSql(`create constraint trigger entry_transaction_matches after insert on wallet_ledger_entries
  deferrable initially deferred for each row execute function assert_transaction_ledger()`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists outbox_messages`);
    this.addSql(`drop table if exists inbox_messages`);
    this.addSql(`drop table if exists wallet_ledger_entries`);
    this.addSql(`drop table if exists wager_transactions`);
    this.addSql(`drop table if exists wallets`);
    this.addSql(`drop function if exists assert_transaction_ledger()`);
    this.addSql(`drop function if exists assert_wallet_ledger_sum()`);
    this.addSql(`drop function if exists enforce_wallet_version()`);
    this.addSql(`drop function if exists prevent_ledger_mutation()`);
  }
}
