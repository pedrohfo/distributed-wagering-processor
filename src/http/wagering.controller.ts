import { Body, Controller, Get, Headers, NotFoundException, Param, Post, Res } from '@nestjs/common';
import {
  IdempotencyConflictError, ProcessWagerService,
} from '../application/wagering/process-wager.service';
import { WagerTransactionStatus } from '../domain/wagering/wager-transaction';
import { WagerTransactionEntity } from '../database/entities/wager-transaction.entity';
import { HttpResourcesService } from './http-resources.service';
import { wagerCommand } from './http-validation';
import { translateHttpError } from './http-errors';

type HttpReply = { status: (code: number) => { json: (payload: unknown) => void } };
function txView(tx: WagerTransactionEntity) {
  return {
    transactionId: tx.id, providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId, walletId: tx.walletId,
    playerId: tx.playerId, roundId: tx.roundId, gameId: tx.gameId,
    kind: tx.kind, status: tx.status,
    money: { amount: tx.amount, currency: tx.currency },
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    failureCode: tx.failureCode ?? null,
    processedAt: tx.processedAt ?? null,
    observedBalance: tx.observedBalanceAmount == null ? null
      : { amount: tx.observedBalanceAmount, currency: tx.currency },
  };
}

@Controller('wagering/transactions')
export class WageringController {
  constructor(private readonly resources: HttpResourcesService) {}

  @Post()
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res() reply: HttpReply,
  ): Promise<void> {
    const command = wagerCommand(body, idempotencyKey);
    try {
      const result = await new ProcessWagerService(this.resources.fork()).execute(command);
      // Distinguish business rejection, accepted-pending and processed/replay outcomes.
      const code = result.status === WagerTransactionStatus.PendingReference ? 202
        : result.status === WagerTransactionStatus.Rejected ? 422 : 200;
      reply.status(code).json(result);
    } catch (error) { translateHttpError(error); }
  }

  @Get(':transactionId')
  async byId(@Param('transactionId') id: string) {
    const entity = await this.resources.fork().findOne(WagerTransactionEntity, { id });
    if (!entity) throw new NotFoundException('Transaction not found');
    return txView(entity);
  }
}

@Controller('providers/:providerId/wagering/transactions')
export class ProviderTransactionsController {
  constructor(private readonly resources: HttpResourcesService) {}

  @Get(':externalTransactionId')
  async byExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const tx = await this.resources.fork().findOne(WagerTransactionEntity, {
      providerId, externalTransactionId,
    });
    if (!tx) throw new NotFoundException('Transaction not found');
    return txView(tx);
  }
}
