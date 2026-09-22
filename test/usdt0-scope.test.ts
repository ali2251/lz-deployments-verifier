import assert from 'node:assert/strict';
import { test } from 'node:test';
import { USDT0_EXCLUSIONS, usdt0VerificationChains } from '../src/usdt0-scope.js';
import { readJson } from './helpers.js';

test('USDT0 verification shares explicit exclusions while retaining non-EVM destinations', () => {
  const { products } = readJson('applications/requirements.json').usdt0;
  const chains = usdt0VerificationChains(products);
  assert.equal(chains.length, 27);
  for (const excluded of ['ton', 'corn']) assert.ok(!chains.includes(excluded));
  for (const required of ['solana', 'stellar', 'tron', 'arbitrum', 'ethereum']) assert.ok(chains.includes(required));
  assert.deepEqual(Object.keys(USDT0_EXCLUSIONS).sort(), ['corn', 'ton']);

  // The requirements inventory itself keeps the excluded chains ...
  assert.ok(products.usdt0.includes('Corn'));
  assert.ok(products.usdt0.includes('TON'));
  // ... and an unknown new requirement must not disappear.
  assert.deepEqual(usdt0VerificationChains({ token: ['Corn', 'TON', 'Arbitrum One', 'Arbitrum', 'New Chain'] }), ['arbitrum', 'new chain']);
});
