import { fail } from '../core/errors.js';
import { accountObservation } from '../core/config.js';
import { createJsonTransport } from '../core/transport.js';

export async function preflightMembership({ config, secret, fetch, clock, check }) {
  const review = await check({ now: clock.now() });
  const transport = createJsonTransport({ baseUrl: config.baseUrl, family: 'native-workflow', fetch, clock,
    timeoutMs: config.http.requestTimeoutMs, maxResponseBytes: config.http.maxResponseBytes });
  const before = clock.now();
  const response = await transport.request({ path: '/uc/openapi/accountStatus', secret, body: { apikey: secret } });
  const observation = accountObservation(response);
  if (observation.actualAccountApiType === 'SHARED') fail('BILLING_MISMATCH');
  if (observation.actualAccountApiType !== 'NORMAL') fail('MEMBER_ACCOUNT_INCONSISTENT');
  const coins = response.data.remainCoins;
  if (typeof coins !== 'string' || coins.length > 32 || !/^\d+(\.\d+)?$/.test(coins) || !Number.isFinite(Number(coins)) || Number(coins) <= 0) fail('COINS_BALANCE_UNUSABLE');
  if (clock.now() < before || clock.now() - before > 60000) fail('ACCOUNT_PREFLIGHT_STALE');
  const finalReview = await check({ now: clock.now() });
  const observedAt = clock.now(), expiresAt = Math.min(Date.parse(review.expiresAt), Date.parse(finalReview.expiresAt));
  if (observedAt < before || observedAt - before > 60000) fail('ACCOUNT_PREFLIGHT_STALE');
  if (observedAt >= expiresAt) fail('MEMBER_BINDING_EXPIRED');
  return { observedAt, expiresAt };
}
