import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../src/pool.js';
import { describeError, isRetryable, redactRpc } from '../src/rpc.js';
import { AUTO_RPC, loadRpcOverrides, mergeRpcs, resolveRpcs } from '../src/rpc-endpoints.js';
import { resolveChain } from '../src/metadata.js';
import { MOCK_METADATA, tempJson } from './helpers.js';

test('redaction removes basic auth, path keys and query tokens', () => {
  const redacted = redactRpc('https://alice:synthetic-secret@rpc.example.com/v2/abcdefghijklmnop?token=query-secret');
  for (const secret of ['alice', 'synthetic-secret', 'abcdefghijklmnop', 'query-secret']) {
    assert.ok(!redacted.includes(secret), redacted);
  }
  assert.ok(redacted.includes('rpc.example.com'));
  assert.equal(redactRpc('not a url'), 'not a url');
});

test('error descriptions are one line, bounded and credential-free', () => {
  const description = describeError(new Error(`request to https://rpc.example.com/v2/${'k'.repeat(32)} failed\nsecond line\nthird line`));
  assert.equal(description, 'request to https://rpc.example.com/v2/*** failed second line');

  const viemStyle = { shortMessage: 'HTTP request failed.', status: 429, details: 'rate   limited' };
  assert.equal(describeError(viemStyle), 'HTTP request failed. HTTP 429 rate limited');
  assert.ok(describeError(new Error('x'.repeat(1000))).length <= 240);
});

test('reverts are final; transport errors are worth retrying', () => {
  assert.equal(isRetryable(new Error('execution reverted: PriceFeed_UnknownEid')), false);
  assert.equal(isRetryable({ name: 'ContractFunctionRevertedError' }), false);
  assert.equal(isRetryable(new Error('The contract function "vid" returned no data ("0x")')), false);
  assert.equal(isRetryable(new Error('HTTP request failed. Status: 429')), true);
  assert.equal(isRetryable(new Error('The request took too long to respond')), true);
});

test('pool keeps input order, honours the limit and rejects invalid concurrency', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const doubled = await pool([1, 2, 3, 4, 5], 2, async (n) => {
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5 - n));
    inFlight--;
    return n * 2;
  });
  assert.deepEqual(doubled, [2, 4, 6, 8, 10]);
  assert.equal(maxInFlight, 2);

  // a limit of zero must not silently perform zero checks
  for (const limit of [NaN, 0, -1, 1.5]) await assert.rejects(pool([1], limit, async (n) => n));
});

test('endpoint lists merge in priority order without duplicates', () => {
  assert.deepEqual(mergeRpcs(['https://a/', 'https://b'], ['https://a', 'https://c', 'https://d'], 3), ['https://a/', 'https://b', 'https://c']);
});

test('an override replaces the automatic endpoints unless it says @auto', () => {
  const ethereum = resolveChain(MOCK_METADATA, 'ethereum')!;
  const [metadataRpc] = ethereum.rpcs;
  const chainlist = new Map([[1, ['https://public-1.example', 'https://public-2.example']]]);

  assert.deepEqual(resolveRpcs(ethereum, undefined, chainlist, 5), {
    rpcs: [metadataRpc, 'https://public-1.example', 'https://public-2.example'],
    origin: 'metadata+chainlist',
  });
  assert.deepEqual(resolveRpcs(ethereum, undefined, new Map(), 5), { rpcs: [metadataRpc], origin: 'metadata' });
  assert.deepEqual(resolveRpcs({ ...ethereum, rpcs: [] }, undefined, chainlist, 1), { rpcs: ['https://public-1.example'], origin: 'chainlist' });

  assert.deepEqual(resolveRpcs(ethereum, ['https://mine.example'], chainlist, 5), { rpcs: ['https://mine.example'], origin: 'override' });
  // explicit URLs do not count against the cap on automatic ones
  assert.deepEqual(resolveRpcs(ethereum, ['https://mine.example', AUTO_RPC], chainlist, 2), {
    rpcs: ['https://mine.example', metadataRpc, 'https://public-1.example'],
    origin: 'override',
  });
});

test('rpc-overrides substitutes environment variables and drops unusable URLs', (t) => {
  process.env.TEST_RPC_KEY = 'alch_secret';
  t.after(() => delete process.env.TEST_RPC_KEY);
  const warn = t.mock.method(console, 'warn', () => {});

  const overrides = loadRpcOverrides(
    tempJson(t, {
      $comment: 'ignored',
      ethereum: ['https://eth.example/v2/alch_${TEST_RPC_KEY}', AUTO_RPC],
      arbitrum: 'https://arb.example/rpc',
      base: ['https://base.example/${UNSET_TEST_VARIABLE}'],
      optimism: ['https://opt.example/v2/YOUR_KEY_HERE', AUTO_RPC],
    }),
  );
  assert.deepEqual(overrides, {
    // pasting a full "alch_..." key into the alch_ slot is tolerated
    ethereum: ['https://eth.example/v2/alch_secret', AUTO_RPC],
    arbitrum: ['https://arb.example/rpc'],
    optimism: [AUTO_RPC],
  });
  assert.equal(warn.mock.callCount(), 2);
  assert.deepEqual(loadRpcOverrides('/nonexistent/overrides.json'), {});
});
