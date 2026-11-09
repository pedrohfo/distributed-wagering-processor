import {
  BadRequestException, ConflictException, HttpException,
  InternalServerErrorException, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { IdempotencyConflictError, WalletNotFoundError } from '../application/wagering/process-wager.service';
import { InvalidTransactionError } from '../domain/wagering/wager-transaction';

/** One consistent HTTP error taxonomy; never leak SQL or incoming financial payloads. */
export function translateHttpError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if (error instanceof IdempotencyConflictError) throw new ConflictException('Idempotency conflict');
  if (error instanceof WalletNotFoundError) throw new NotFoundException('Wallet not found');
  if (error instanceof InvalidTransactionError) throw new BadRequestException(error.message);
  if (error instanceof Error && /constraint|UniqueConstraint/i.test(error.name) && /unique/i.test(error.message)) {
    throw new ConflictException('Resource already exists');
  }
  // Some PostgreSQL error converters wrap the native SQLSTATE 23505.
  if (hasSqlState(error, '23505')) throw new ConflictException('Resource already exists');
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(), level: 'error', component: 'http',
    event: 'request_failed', errorType: error instanceof Error ? error.name : 'UnknownError',
  }));
  // Avoid suggesting a retry for a known business conflict; all remaining failures are unexpected.
  throw new ServiceUnavailableException('Request could not be completed');
}

function hasSqlState(error: unknown, expected: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; cause?: unknown; driverException?: unknown };
  return e.code === expected ||
    (!!e.cause && e.cause !== error && hasSqlState(e.cause, expected)) ||
    (!!e.driverException && e.driverException !== error && hasSqlState(e.driverException, expected));
}
