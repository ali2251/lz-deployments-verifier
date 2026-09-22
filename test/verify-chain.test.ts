import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAddress } from 'viem';
import { loadExpected } from '../src/config.js';
import { verifyChain } from '../src/verify-chain.js';
import type { ChainResult } from '../src/types.js';
import { ethereumSource, FEE_LIB, fromRoot, installFakeDvn, NO_RETRY, planFor, readJson, REVERT } from './helpers.js';

const mockExpected = () => loadExpected(fromRoot('test/mock-expected.json'));

const severities = (result: ChainResult, check: string) =>
  result.findings.filter((finding) => finding.check === check).map((finding) => finding.severity);

test('a healthy DVN passes, with every read pinned to one snapshot block', async (t) => {
  const dvn = installFakeDvn(t);
  const result = await verifyChain(ethereumSource(), planFor(mockExpected()), NO_RETRY);

  assert.equal(result.status, 'OK', JSON.stringify(result.findings));
  assert.equal(result.verificationScope, 'configuration-and-quotes');
  assert.equal(result.blockNumber, '16');
  // the first call is the connection probe, made before the snapshot block is known
  const [probe, ...reads] = dvn.calls;
  assert.equal(probe?.functionName, 'quorum');
  assert.ok(reads.length > 0);
  for (const read of reads) assert.equal(read.block, '0x10', `${read.functionName} must be read at the snapshot block`);
  // the DVN quote and the fee library's zero-floor quote
  assert.equal(dvn.calls.filter((call) => call.functionName === 'getFee').length, 2);
});

test('a failed read is an ERROR finding, never a silent pass', async (t) => {
  const dvn = installFakeDvn(t);
  const failures = [
    { failing: 'feeLib', check: 'quote.floorNotBinding' },
    { failing: 'vid', check: 'worker.vid' },
    { failing: 'signers', check: 'multisig.signer' },
    { failing: 'dstConfig', check: 'dstConfig.read' },
  ];
  for (const { failing, check } of failures) {
    dvn.failing = { [failing]: REVERT };
    const result = await verifyChain(ethereumSource(), planFor(mockExpected()), NO_RETRY);
    assert.notEqual(result.status, 'OK', failing);
    assert.deepEqual(severities(result, check), ['ERROR'], failing);
  }
});

test('a failed pause read is an ERROR; the same chain passes once the read succeeds', async (t) => {
  const dvn = installFakeDvn(t);
  const plan = planFor(mockExpected(), { destinations: [], quote: false });

  dvn.failing = { paused: 'temporary read failure' };
  const failed = await verifyChain(ethereumSource(), plan, NO_RETRY);
  assert.equal(failed.status, 'ERROR');
  assert.equal(failed.worker?.paused, null);
  assert.deepEqual(severities(failed, 'worker.paused'), ['ERROR']);

  dvn.failing = {};
  const passed = await verifyChain(ethereumSource(), plan, NO_RETRY);
  assert.equal(passed.status, 'OK');
  assert.equal(passed.worker?.paused, false);
  assert.deepEqual(severities(passed, 'worker.paused'), ['PASS']);
});

test('concurrency 1 serializes every read, including the worker reads that start together', async (t) => {
  const dvn = installFakeDvn(t);
  await verifyChain(ethereumSource(), planFor(mockExpected(), { concurrency: 1 }), NO_RETRY);
  assert.equal(dvn.maxConcurrentRequests, 1);

  dvn.maxConcurrentRequests = 0;
  await verifyChain(ethereumSource(), planFor(mockExpected(), { concurrency: 6 }), NO_RETRY);
  assert.ok(dvn.maxConcurrentRequests > 1);
});

test('a successfully returned zero quote is valid; a reverting quote is a FAIL', async (t) => {
  const dvn = installFakeDvn(t);

  dvn.values.getFee = 0n;
  const zero = await verifyChain(ethereumSource(), planFor(mockExpected()), NO_RETRY);
  assert.equal(zero.status, 'OK');
  assert.equal(zero.pathways[0]!.feeWei, 0n);

  dvn.failing = { getFee: REVERT };
  const reverted = await verifyChain(ethereumSource(), planFor(mockExpected()), NO_RETRY);
  assert.equal(reverted.status, 'FAIL');
  assert.deepEqual(severities(reverted, 'quote.getFee'), ['FAIL']);
  assert.equal(reverted.pathways[0]!.feeWei, null);
});

test('disabled quotes are never requested and the result is labelled configuration-only', async (t) => {
  const dvn = installFakeDvn(t);
  const expected = mockExpected();
  expected.quote.enabled = false;

  const result = await verifyChain(ethereumSource(), planFor(expected), NO_RETRY);
  assert.equal(result.status, 'OK');
  assert.equal(result.verificationScope, 'configuration-only');
  assert.equal(dvn.calls.filter((call) => call.functionName === 'getFee').length, 0);
});

test('a USD cap needs a native price, and is enforced when there is one', async (t) => {
  const dvn = installFakeDvn(t);
  const expected = mockExpected();
  expected.quote.maxUsd = 1;

  dvn.failing = { nativeTokenPriceUSD: REVERT };
  const noPrice = await verifyChain(ethereumSource(), planFor(expected), NO_RETRY);
  assert.deepEqual(severities(noPrice, 'quote.usdPrice'), ['ERROR']);

  dvn.failing = {};
  dvn.values.getFee = 2n * 10n ** 18n; // 2 native tokens at $1
  const overCap = await verifyChain(ethereumSource(), planFor(expected), NO_RETRY);
  assert.deepEqual(severities(overCap, 'quote.maxUsd'), ['FAIL']);
  assert.equal(overCap.pathways[0]!.feeUsd, 2);
});

test('a binding USD floor is detected by comparing with the fee library zero-floor quote', async (t) => {
  const dvn = installFakeDvn(t);
  dvn.values.getFee = 500n;
  dvn.zeroFloorFee = 100n;

  const result = await verifyChain(ethereumSource(), planFor(mockExpected()), NO_RETRY);
  assert.equal(result.status, 'FAIL');
  assert.deepEqual(severities(result, 'quote.floorNotBinding'), ['FAIL']);
  assert.equal(result.pathways[0]!.floorBinding, true);
});

test('missing bytecode stops verification with a FAIL', async (t) => {
  const dvn = installFakeDvn(t);
  dvn.code = '0x';
  const result = await verifyChain(ethereumSource(), planFor(mockExpected()), NO_RETRY);
  assert.equal(result.status, 'FAIL');
  assert.deepEqual(result.findings.map((finding) => finding.check), ['contract.deployed']);
});

test('an extra on-chain signer fails, and --scan-signers adds a best-effort scan finding', async (t) => {
  const dvn = installFakeDvn(t);
  dvn.values.signerSize = 2n;

  const result = await verifyChain(ethereumSource(), planFor(mockExpected(), { scanSigners: true }), NO_RETRY);
  assert.equal(result.status, 'FAIL');
  assert.deepEqual(severities(result, 'multisig.signerSize'), ['FAIL']);
  assert.deepEqual(severities(result, 'multisig.unexpectedSigners'), ['FAIL']);
  // the fake endpoint has no eth_getLogs, so the scan degrades to a warning
  assert.deepEqual(severities(result, 'multisig.scan'), ['WARN']);
});

test('subsidized profile verifies the supplied contracts, the exact signer and the $0.25 floor', async (t) => {
  const addresses: Record<string, string> = readJson('deployments/canary-subsidized.json').config.contractAddresses;
  assert.equal(Object.keys(addresses).length, 39);
  for (const address of Object.values(addresses)) assert.ok(isAddress(address), address);

  const expected = loadExpected(fromRoot('expected-subsidized.json'));
  const quarterDollar = expected.usdDenominator / 4n;
  assert.equal(expected.dst.default.floorMarginUSD, quarterDollar);
  assert.equal(expected.quote.requireFloorNotBinding, false);

  const dvn = installFakeDvn(t);
  dvn.values.dstConfig = [100000n, 0, quarterDollar];
  dvn.values.getFee = 100000000000000n;
  const source = ethereumSource(addresses.ethereum);
  const run = () => verifyChain(source, planFor(expected), NO_RETRY);

  const good = await run();
  assert.equal(good.status, 'OK', JSON.stringify(good.findings));
  assert.equal(good.pathways[0]?.floorMarginUSD, 25000000000000000000n);
  // a subsidized floor is allowed to bind, so the fee library is never consulted
  assert.ok(dvn.calls.every((call) => call.to !== FEE_LIB));
  assert.equal(dvn.calls.filter((call) => call.functionName === 'getFee').length, 1);
  for (const call of dvn.calls) {
    if (call.functionName !== 'nativeTokenPriceUSD') assert.equal(call.to, addresses.ethereum);
    if (call.functionName === 'signers') assert.equal(String(call.args[0]).toLowerCase(), expected.signers[0]!.toLowerCase());
  }

  for (const wrongFloor of [0n, 2n * quarterDollar]) {
    dvn.values.dstConfig = [100000n, 0, wrongFloor];
    const wrong = await run();
    assert.equal(wrong.status, 'FAIL');
    assert.deepEqual(severities(wrong, 'dstConfig.floorMarginUSD'), ['FAIL']);
  }

  dvn.values.dstConfig = [100000n, 0, quarterDollar];
  dvn.values.signers = false;
  const wrongSigner = await run();
  assert.equal(wrongSigner.status, 'FAIL');
  assert.deepEqual(severities(wrongSigner, 'multisig.signer'), ['FAIL']);
});
