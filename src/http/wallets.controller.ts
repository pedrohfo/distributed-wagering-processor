import { Body, Controller, Get, Param, Post, Query, BadRequestException, NotFoundException } from '@nestjs/common';
import { CreateWalletService } from '../application/wallets/create-wallet.service';
import { WalletEntity } from '../database/entities/wallet.entity';
import { HttpResourcesService } from './http-resources.service';
import { object, stringField, moneyField } from './http-validation';
import { translateHttpError } from './http-errors';

interface LedgerRow {
  id: string; wallet_id: string; transaction_id: string; direction: string;
  amount: string; currency: string; balance_before: string; balance_after: string;
  created_at: string;
}
interface Cursor { createdAt: string; id: string }

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}
function decodeCursor(raw: string): Cursor {
  try {
    const c: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const o = object(c, 'cursor');
    const createdAt = stringField(o, 'createdAt');
    const id = stringField(o, 'id');
    if (!/^\d{4}-\d\d-\d\d /.test(createdAt)) throw new Error('Invalid timestamp');
    return { createdAt, id };
  } catch {
    throw new BadRequestException('Invalid ledger cursor');
  }
}

@Controller('wallets')
export class WalletsController {
  constructor(private readonly resources: HttpResourcesService) {}

  @Post()
  async create(@Body() body: unknown) {
    const o = object(body);
    const playerId = stringField(o, 'playerId');
    const initialBalance = moneyField(o.initialBalance);
    try {
      const wallet = await new CreateWalletService(this.resources.fork()).execute({ playerId, initialBalance });
      return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
    } catch (error) { return translateHttpError(error); }
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    const entity = await this.resources.fork().findOne(WalletEntity, { id: walletId });
    if (!entity) throw new NotFoundException('Wallet not found');
    return {
      id: entity.id, playerId: entity.playerId,
      balance: { amount: entity.balanceAmount, currency: entity.currency },
      version: entity.version,
    };
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') rawCursor?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer from 1 to 100');
    }
    const em = this.resources.fork();
    const wallet = await em.findOne(WalletEntity, { id: walletId });
    if (!wallet) throw new NotFoundException('Wallet not found');
    const cursor = rawCursor ? decodeCursor(rawCursor) : undefined;
    // created_at::text preserves PostgreSQL timestamp precision across pages.
    const whereCursor = cursor
      ? 'and (created_at < ?::timestamptz or (created_at = ?::timestamptz and id < ?))'
      : '';
    const parameters: unknown[] = [walletId];
    if (cursor) parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
    parameters.push(limit + 1);
    const rows = await em.getConnection().execute<LedgerRow[]>(`
      select id, wallet_id, transaction_id, direction, amount::text as amount,
        currency, balance_before::text as balance_before,
        balance_after::text as balance_after, created_at::text as created_at
      from wallet_ledger_entries where wallet_id = ? ${whereCursor}
      order by created_at desc, id desc limit ?
    `, parameters);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id, walletId: row.wallet_id, transactionId: row.transaction_id,
        direction: row.direction, money: { amount: row.amount, currency: row.currency },
        balanceBefore: { amount: row.balance_before, currency: row.currency },
        balanceAfter: { amount: row.balance_after, currency: row.currency },
        createdAt: row.created_at,
      })),
      nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
    };
  }

  @Post(':walletId/reconciliation')
  async reconcile(@Param('walletId') walletId: string) {
    const rows = await this.resources.fork().getConnection().execute<Array<{
      wallet_id: string; currency: string; stored_balance: string;
      calculated_balance: string; difference: string; checked_entries: string;
    }>>(`
      select w.id as wallet_id, w.currency,
        w.balance::numeric(18,2)::text as stored_balance,
        coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(18,2)::text as calculated_balance,
        (w.balance - coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0))::numeric(18,2)::text as difference,
        count(l.id)::text as checked_entries
      from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ? group by w.id, w.currency, w.balance
    `, [walletId]);
    const row = rows[0];
    if (!row) throw new NotFoundException('Wallet not found');
    const consistent = /^-?0\.00$/.test(row.difference);
    if (!consistent) {
      console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error',
        event: 'wallet_reconciliation_mismatch', walletId }));
    }
    return {
      walletId,
      storedBalance: { amount: row.stored_balance, currency: row.currency },
      calculatedBalance: { amount: row.calculated_balance, currency: row.currency },
      difference: { amount: row.difference, currency: row.currency },
      consistent, checkedEntries: Number(row.checked_entries),
    };
  }
}
