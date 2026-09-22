import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zeroAddress } from 'viem';
import { checkDstConfig, checkMultisig, checkQuotePrerequisites, checkWorker, exceedsUsdCap, feeToUsd, type WorkerState } from '../src/checks.js';
import { loadExpected } from '../src/config.js';
import type { Finding } from '../src/types.js';
import { FEE_LIB, fromRoot, PRICE_FEED } from './helpers.js';

const expected = loadExpected(fromRoot('test/mock-expected.json'));
const [signer] = expected.signers as [`0x${string}`];

const healthyWorker: WorkerState = {
  quorum: 1n,
  signerSize: 1n,
  priceFeed: PRICE_FEED,
  feeLib: FEE_LIB,
  defaultMultiplierBps: 12000,
  allowlistSize: 0n,
  paused: false,
  vid: 1,
  nativePriceUSD: 10n ** 20n,
};

const failed = (findings: Finding[]) => findings.filter((f) => f.severity !== 'PASS').map((f) => `${f.severity} ${f.check}`);

test('a healthy worker and the exact signer set pass every check', () => {
  assert.deepEqual(failed(checkMultisig(expected, healthyWorker, [{ signer, active: true }])), []);
  assert.deepEqual(failed(checkWorker(expected, healthyWorker)), []);
  assert.deepEqual(failed(checkQuotePrerequisites(expected, healthyWorker)), []);
});

test('the signer set must be exactly the expected set', () => {
  const inactive = checkMultisig(expected, healthyWorker, [{ signer, active: false }]);
  assert.deepEqual(failed(inactive), ['FAIL multisig.signer']);

  const unreadable = checkMultisig(expected, healthyWorker, [{ signer, active: null, error: 'timeout' }]);
  assert.deepEqual(failed(unreadable), ['ERROR multisig.signer']);

  const extraSigner = checkMultisig(expected, { ...healthyWorker, signerSize: 2n }, [{ signer, active: true }]);
  assert.deepEqual(failed(extraSigner), ['FAIL multisig.signerSize', 'FAIL multisig.unexpectedSigners']);

  const wrongQuorum = checkMultisig(expected, { ...healthyWorker, quorum: 2n }, [{ signer, active: true }]);
  assert.deepEqual(failed(wrongQuorum), ['FAIL multisig.quorum']);
});

test('worker policy: multiplier, allowlist, pause state and dependencies', () => {
  const unhealthy: WorkerState = {
    ...healthyWorker,
    defaultMultiplierBps: 10000,
    allowlistSize: 3n,
    paused: true,
    priceFeed: zeroAddress,
    feeLib: zeroAddress,
  };
  assert.deepEqual(failed(checkWorker(expected, unhealthy)), [
    'FAIL worker.defaultMultiplierBps',
    'FAIL worker.allowlistSize',
    'FAIL worker.paused',
    'FAIL worker.priceFeed',
    'FAIL worker.workerFeeLib',
  ]);
  // a failed pause read is reported by the reader, not compared here
  assert.ok(!checkWorker(expected, { ...healthyWorker, paused: null }).some((f) => f.check === 'worker.paused'));
});

test('null expectations are recorded but not asserted', () => {
  const lenient = structuredClone(expected);
  lenient.worker = { defaultMultiplierBps: null, allowlistSize: null, paused: null, requirePriceFeedSet: false, requireFeeLibSet: false };
  assert.deepEqual(checkWorker(lenient, { ...healthyWorker, paused: true, allowlistSize: 9n, priceFeed: zeroAddress }), []);

  const anything = { gas: 1n, multiplierBps: 999, floorMarginUSD: 5n };
  assert.deepEqual(checkDstConfig({ floorMarginUSD: null, multiplierBps: null, minGas: 1n }, anything, 'arbitrum'), []);
});

test('destination config: gas minimum, exact floor, exact multiplier', () => {
  const want = { floorMarginUSD: 0n, multiplierBps: 12000, minGas: 1n };
  assert.deepEqual(checkDstConfig(want, { gas: 77000n, multiplierBps: 12000, floorMarginUSD: 0n }, 'arbitrum'), []);

  const findings = checkDstConfig(want, { gas: 0n, multiplierBps: 10500, floorMarginUSD: 1n }, 'arbitrum');
  assert.deepEqual(failed(findings), ['FAIL dstConfig.gas', 'FAIL dstConfig.floorMarginUSD', 'FAIL dstConfig.multiplierBps']);
  assert.ok(findings.every((f) => f.dst === 'arbitrum'));
});

test('required quote checks that cannot run are errors', () => {
  const capped = structuredClone(expected);
  capped.quote.maxUsd = 1;
  assert.deepEqual(failed(checkQuotePrerequisites(capped, { ...healthyWorker, nativePriceUSD: null })), ['ERROR quote.usdPrice']);
  assert.deepEqual(failed(checkQuotePrerequisites(capped, { ...healthyWorker, nativePriceUSD: 0n })), ['ERROR quote.usdPrice']);
  assert.deepEqual(failed(checkQuotePrerequisites(expected, { ...healthyWorker, feeLib: zeroAddress })), ['ERROR quote.floorNotBinding']);
});

test('USD cap uses exact decimal math, including values rounded to the same JS number', () => {
  const ONE_DOLLAR = 10n ** 20n; // native price, in 1e20 USD units
  assert.equal(exceedsUsdCap(1000000000000000001n, ONE_DOLLAR, 18, 10n ** 20n, 1), true);
  assert.equal(exceedsUsdCap(10n ** 18n, ONE_DOLLAR, 18, 10n ** 20n, 1), false);
  assert.equal(exceedsUsdCap(10000000001n, ONE_DOLLAR, 18, 10n ** 20n, 1e-8), true);
  assert.equal(exceedsUsdCap(15n * 10n ** 17n, ONE_DOLLAR, 18, 10n ** 20n, 1.5), false);
});

test('fees convert to USD for display', () => {
  const price = 3000n * 10n ** 20n;
  assert.equal(feeToUsd(10n ** 18n, price, 18, 10n ** 20n), 3000);
  assert.equal(feeToUsd(24n * 10n ** 12n, price, 18, 10n ** 20n), 0.072);
  assert.equal(feeToUsd(10n ** 6n, price, 6, 10n ** 20n), 3000);
});
