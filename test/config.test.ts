import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectationFor, loadDeployment, loadExpected } from '../src/config.js';
import { fromRoot, readJson, tempJson } from './helpers.js';

const mockExpected = (): any => readJson('test/mock-expected.json');

test('the shipped profiles load with the documented policy', () => {
  const sponsored = loadExpected(fromRoot('expected.json'));
  assert.equal(sponsored.deployment, 'canary-sponsored');
  assert.equal(sponsored.quorum, 1n);
  assert.deepEqual(sponsored.dst.default, { floorMarginUSD: 0n, multiplierBps: null, minGas: 1n });
  assert.equal(sponsored.quote.requireFloorNotBinding, true);
  assert.equal(sponsored.usdDenominator, 10n ** 20n);

  const subsidized = loadExpected(fromRoot('expected-subsidized.json'));
  assert.equal(subsidized.dst.default.floorMarginUSD, 25n * 10n ** 18n); // $0.25
  assert.equal(subsidized.quote.requireFloorNotBinding, false);
});

test('omitted settings fall back to defaults', (t) => {
  const { deployment, signers, quorum } = mockExpected();
  const expected = loadExpected(tempJson(t, { deployment, signers, quorum }));

  assert.deepEqual(expected.worker, {
    defaultMultiplierBps: null,
    allowlistSize: null,
    paused: null,
    requirePriceFeedSet: true,
    requireFeeLibSet: true,
  });
  assert.deepEqual(expected.dst, { default: { floorMarginUSD: null, multiplierBps: null, minGas: 1n }, overrides: {} });
  assert.deepEqual(expected.quote, {
    enabled: true,
    sender: '0x000000000000000000000000000000000000dEaD',
    confirmations: 1n,
    options: '0x',
    maxUsd: null,
    requireFloorNotBinding: true,
  });
  assert.equal(expected.usdDenominator, 10n ** 20n);
});

test('partial pathway overrides inherit source settings and preserve explicit null', (t) => {
  const raw = mockExpected();
  raw.dstConfig.overrides = {
    ethereum: { floorMarginUSD: '99', minGas: 500 },
    'ethereum->arbitrum': { multiplierBps: 123 },
    'ethereum->polygon': { floorMarginUSD: null },
  };
  const expected = loadExpected(tempJson(t, raw));

  assert.deepEqual(expectationFor(expected, 'ethereum', 'arbitrum'), { floorMarginUSD: 99n, multiplierBps: 123, minGas: 500n });
  assert.deepEqual(expectationFor(expected, 'ethereum', 'polygon'), { floorMarginUSD: null, multiplierBps: null, minGas: 500n });
  // other sources are untouched by ethereum's overrides
  assert.deepEqual(expectationFor(expected, 'arbitrum', 'ethereum'), { floorMarginUSD: 0n, multiplierBps: null, minGas: 1n });
});

test('unsafe or invalid policies are rejected', (t) => {
  const invalid: Record<string, (policy: any) => void> = {
    'zero usdDenominator': (p) => (p.usdDenominator = '0'),
    'usdDenominator that is not a power of ten': (p) => (p.usdDenominator = '25'),
    'maxUsd as a string': (p) => (p.quote.maxUsd = '1'),
    'odd-length quote options': (p) => (p.quote.options = '0x1'),
    'quote.enabled as a string': (p) => (p.quote.enabled = 'false'),
    'worker.paused as a string': (p) => (p.worker.paused = 'false'),
    'minGas of zero': (p) => (p.dstConfig.default.minGas = 0),
    'a floor too large for a JS number': (p) => (p.dstConfig.default.floorMarginUSD = 1e20),
    'a floor that overflows uint128': (p) => (p.dstConfig.default.floorMarginUSD = (2n ** 128n).toString()),
    'the zero address as signer': (p) => (p.signers = ['0x0000000000000000000000000000000000000000']),
    'an empty signer list': (p) => (p.signers = []),
    'duplicate signers': (p) => (p.signers = [p.signers[0], p.signers[0]]),
    'quorum of zero': (p) => (p.quorum = 0),
    'quorum above the signer count': (p) => (p.quorum = 2),
    'an invalid quote sender': (p) => (p.quote.sender = '0x123'),
  };
  for (const [description, mutate] of Object.entries(invalid)) {
    const policy = mockExpected();
    mutate(policy);
    assert.throws(() => loadExpected(tempJson(t, policy)), description);
  }
  assert.throws(() => loadExpected(tempJson(t, [])), /expected an object/);
  assert.throws(() => loadExpected('/nonexistent/expected.json'), /not found/);
});

test('errors name the file and the offending field', (t) => {
  const policy = mockExpected();
  policy.dstConfig.overrides = { ethereum: { minGas: 0 } };
  const path = tempJson(t, policy);
  assert.throws(() => loadExpected(path), (err: Error) => err.message.startsWith(path) && /minGas must be >= 1/.test(err.message));
});

test('deployments accept both layouts and reject malformed address maps', (t) => {
  const addresses = { ethereum: '0xf9d2c0915cac4c75b7ae359089333c8ac258e12c', solana: 'FGfRUbiNjXJ5FaVzWj7gcnUJMYTiCLPmgTVeeozWooZB' };
  const nested = loadDeployment(tempJson(t, { canonicalName: 'x', config: { contractAddresses: addresses } }));
  const flat = loadDeployment(tempJson(t, { contractAddresses: addresses }));
  assert.deepEqual(nested, { canonicalName: 'x', contractAddresses: addresses });
  assert.deepEqual(flat, { canonicalName: 'unknown', contractAddresses: addresses });

  for (const malformed of [{}, [], { ethereum: 123 }, { ethereum: ' ' }, { ' ': addresses.ethereum }]) {
    assert.throws(() => loadDeployment(tempJson(t, { contractAddresses: malformed })), /no config.contractAddresses/);
  }
});
