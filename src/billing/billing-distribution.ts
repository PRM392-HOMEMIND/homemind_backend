import { ForbiddenException } from '@nestjs/common';

// Public client metadata, never an authentication/authorization credential.
// Owner's temporary policy: every mobile channel is consumption-only.
// A direct/legacy client header must not reopen checkout or payment instructions.
export function externalBillingAllowed(distribution: unknown): boolean {
  return process.env.PAYOS_ENABLED === 'true' || distribution === 'direct';
}

export function requireExternalBilling(distribution: unknown): void {
  if (!externalBillingAllowed(distribution)) {
    throw new ForbiddenException({ code: 'BILLING_DISTRIBUTION_DISABLED', message: 'Consumption-only client.' });
  }
}

function pick(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(fields.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}

// Allowlist, including nested snapshots: new provider fields cannot leak by
// default. Unpaid orders are status-only; no transfer amount or checkout clock.
export function consumptionPayment(value: unknown): Record<string, unknown> {
  const payment = pick(value, ['id', 'status', 'financialState', 'fulfillment', 'createdAt', 'paidAt', 'cancelledAt', 'cancellationTimeSource', 'amountPaid']);
  payment.price = pick((value as Record<string, unknown>)?.price,
    payment.financialState === 'PAID' ? ['plan', 'amount', 'currency'] : ['plan']);
  payment.grant = pick((value as Record<string, unknown>)?.grant, ['plan', 'startsAt', 'expiresAt', 'originalExpiresAt', 'supersededAt']);
  return payment;
}

export function consumptionBilling(value: Record<string, unknown>): Record<string, unknown> {
  if ('id' in value) return consumptionPayment(value);
  return {
    ...pick(value, ['entitlement', 'subscription', 'scheduled', 'workspaceType', 'eligibility', 'nextOffset']),
    payments: Array.isArray(value.payments) ? value.payments.map(consumptionPayment) : [],
    checkoutEnabled: false,
  };
}
