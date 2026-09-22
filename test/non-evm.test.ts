import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { completedSnapshot, SOURCES, validateChain, validateExpectations, type Expectation } from '../src/non-evm/policy.js';
import { resolveSolanaSignerPolicy } from '../src/signers.js';
import { fromRoot, readJson, runCli, tempJson } from './helpers.js';

const SIGNER = '0x1111111111111111111111111111111111111111';
const OTHER_SIGNER = '0x2222222222222222222222222222222222222222';

const expectation: Expectation = {
  signers: [SIGNER],
  quorum: 1,
  defaultMultiplierBps: 12000,
  destinationMultiplierBps: { default: 12000 },
};
const destinations = [
  { name: 'solana', eid: 30168 },
  { name: 'ethereum', eid: 30101 },
];

/** A snapshot that satisfies `expectation` for solana -> ethereum. */
function passingSnapshot(): any {
  return {
    checks: { network: true, deployed: true, feeDependencies: true },
    signerAddresses: [SIGNER],
    quorum: 1,
    paused: false,
    allowlistSize: 0,
    defaultMultiplierBps: 12000,
    pathways: [
      { dst: 'ethereum', eid: 30101, gas: '77000', floorMarginUSD: '0', multiplierBps: 12000, configStatus: 'PASS', quoteStatus: 'PASS', feeRaw: '123' },
    ],
  };
}

const validate = (snapshot: any, expected = expectation) => validateChain('solana', snapshot, expected, destinations);

// ---------------------------------------------------------------------------
// expectations
// ---------------------------------------------------------------------------

test('the shipped policy is valid once the Solana key is resolved', () => {
  const policy = readJson('expected-non-evm.json');
  resolveSolanaSignerPolicy(policy);
  assert.deepEqual(validateExpectations(policy, SOURCES), []);
});

test('expectations need independent, nonempty, unique, valid signers', () => {
  assert.deepEqual(validateExpectations({ chains: { solana: expectation } }, ['solana']), []);
  for (const signers of [null, [], ['0x123'], ['0x0000000000000000000000000000000000000000'], [SIGNER, SIGNER]]) {
    const errors = validateExpectations({ chains: { solana: { ...expectation, signers } } }, ['solana']);
    assert.ok(errors.length > 0, JSON.stringify(signers));
  }
});

test('expectations need a sane quorum and multiplier policy', () => {
  const invalid: Array<Partial<Expectation>> = [
    { quorum: 0 },
    { quorum: 2 },
    { defaultMultiplierBps: 0 },
    { destinationMultiplierBps: undefined },
    { destinationMultiplierBps: { default: 12000, ethereum: 0 } },
  ];
  for (const override of invalid) {
    const errors = validateExpectations({ chains: { tron: { ...expectation, ...override } } }, ['tron']);
    assert.equal(errors.length, 1, JSON.stringify(override));
  }
});

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------

test('a complete snapshot that matches the policy passes', () => {
  assert.deepEqual(validate(passingSnapshot()), []);
  assert.deepEqual(validate(undefined), ['solana: no completed chain result']);
});

test('PASS requires the exact expected signer set, not just a count', () => {
  for (const signerAddresses of [[], [OTHER_SIGNER], [SIGNER, SIGNER], [SIGNER, OTHER_SIGNER], undefined]) {
    assert.ok(validate({ ...passingSnapshot(), signerAddresses }).length > 0, JSON.stringify(signerAddresses));
  }
});

test('Solana requires the full expected public key as well as its derived address', () => {
  const publicKey = '0x' + '11'.repeat(64);
  const expected = { ...expectation, publicKeys: [publicKey] };
  assert.deepEqual(validate({ ...passingSnapshot(), signerPublicKeys: [publicKey] }, expected), []);

  for (const signerPublicKeys of [undefined, [], ['0x' + '22'.repeat(64)], [publicKey, publicKey]]) {
    const errors = validate({ ...passingSnapshot(), signerPublicKeys }, expected);
    assert.ok(errors.some((error) => error.includes('public key set')), JSON.stringify(signerPublicKeys));
  }
});

test('Tron needs a confirmed membership check and a matching signer count', () => {
  const tronDestinations = [{ name: 'ethereum', eid: 30101 }];
  const validateTron = (snapshot: any) => validateChain('tron', snapshot, expectation, tronDestinations);
  const snapshot = { ...passingSnapshot(), signerSize: '1', signerSetMatchesExpected: true };

  assert.deepEqual(validateTron(snapshot), []);
  // an expected-looking signer list is not enough on its own
  for (const signerSetMatchesExpected of [false, undefined]) {
    assert.ok(validateTron({ ...snapshot, signerSetMatchesExpected }).some((error) => error.includes('membership')));
  }
  assert.ok(validateTron({ ...snapshot, signerSize: '2' }).some((error) => error.includes('signer count')));
});

test('successfully returned zero quotes are valid, in any numeric form', () => {
  for (const feeRaw of ['0', 0, 0n]) {
    const snapshot = passingSnapshot();
    snapshot.pathways[0].feeRaw = feeRaw;
    assert.deepEqual(validate(snapshot), []);

    snapshot.pathways[0].quoteStatus = 'FAIL';
    assert.ok(validate(snapshot).length > 0);
  }
});

test('incomplete, duplicate, failed, wrong-EID and invalid-fee results are rejected', () => {
  const defects: Record<string, (snapshot: any) => void> = {
    'no pathways': (s) => (s.pathways = []),
    'pathways missing entirely': (s) => delete s.pathways,
    'duplicate destination': (s) => s.pathways.push({ ...s.pathways[0] }),
    'wrong endpoint id': (s) => (s.pathways[0].eid = 999),
    'unconfigured gas': (s) => (s.pathways[0].gas = '0'),
    'non-zero sponsored floor': (s) => (s.pathways[0].floorMarginUSD = '1'),
    'wrong destination multiplier': (s) => (s.pathways[0].multiplierBps = 1),
    'config read error': (s) => (s.pathways[0].configError = 'RPC timeout'),
    'null fee': (s) => (s.pathways[0].feeRaw = null),
    'negative fee': (s) => (s.pathways[0].feeRaw = '-1'),
    'empty fee': (s) => (s.pathways[0].feeRaw = ''),
    'boolean fee': (s) => (s.pathways[0].feeRaw = false),
    'non-numeric fee': (s) => (s.pathways[0].feeRaw = 'garbage'),
    'unknown quote status': (s) => (s.pathways[0].quoteStatus = 'ZERO_FEE'),
    'failed quote': (s) => (s.pathways[0].quoteStatus = 'FAIL'),
    'quote error alongside a fee': (s) => (s.pathways[0].error = 'RPC timeout'),
    'network check missing': (s) => (s.checks.network = undefined),
    'pause state missing': (s) => (s.paused = null),
    paused: (s) => (s.paused = true),
    'wrong quorum': (s) => (s.quorum = 2),
    'gated allowlist': (s) => (s.allowlistSize = 1),
    'wrong default multiplier': (s) => (s.defaultMultiplierBps = 10000),
  };
  for (const [description, introduce] of Object.entries(defects)) {
    const snapshot = passingSnapshot();
    introduce(snapshot);
    assert.ok(validate(snapshot).length > 0, description);
  }
});

test('per-destination multipliers override the default', () => {
  const expected = { ...expectation, destinationMultiplierBps: { default: 12000, ethereum: 10500 } };
  assert.deepEqual(validate(passingSnapshot(), expected), ['solana: ethereum: destination multiplier mismatch']);

  const snapshot = passingSnapshot();
  snapshot.pathways[0].multiplierBps = 10500;
  assert.deepEqual(validate(snapshot, expected), []);
});

test('old, mixed-run, partial and future-dated snapshots cannot be used to pass', () => {
  const startedAt = new Date(Date.now() - 1000).toISOString();
  const complete = { runId: 'new-run', completedAt: new Date().toISOString() };
  assert.equal(completedSnapshot(complete, 'new-run', startedAt), true);

  const unusable = {
    'another run': { ...complete, runId: 'old-run' },
    'never completed': { runId: 'new-run' },
    'unparsable completion time': { ...complete, completedAt: 'invalid' },
    'completed before this run started': { ...complete, completedAt: '2000-01-01' },
    'completed in the future': { ...complete, completedAt: '2999-01-01' },
  };
  for (const [description, snapshot] of Object.entries(unusable)) {
    assert.equal(completedSnapshot(snapshot, 'new-run', startedAt), false, description);
  }
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('a policy that tries to replace the Solana signer fails before any network access', (t) => {
  const policy = readJson('expected-non-evm.json');
  resolveSolanaSignerPolicy(policy);
  policy.chains.solana.signers = ['nKtqDFhGeUDQpDVatUxKFUkSciAkBUaTof1g1iJQTr4'];

  const run = runCli('src/non-evm/index.ts', ['--expected', tempJson(t, policy)]);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /cannot override/);
  assert.doesNotMatch(run.stdout, /\bPASS\b/);

  // the failed run replaces latest.json, so a stale PASS can never be reported
  const latest = JSON.parse(readFileSync(fromRoot('reports/usdt0-non-evm/latest.json'), 'utf8'));
  assert.equal(latest.status, 'FAIL');
  const report = JSON.parse(readFileSync(latest.json, 'utf8'));
  assert.equal(report.runId, latest.runId);
  assert.equal(report.status, 'FAIL');
  assert.deepEqual(report.chains, {});
});

test('help exits 0; invalid arguments exit 2 without creating a run', () => {
  assert.equal(runCli('src/non-evm/index.ts', ['--help']).status, 0);
  for (const args of [['--only', 'stellar'], ['--bogus'], ['--expected']]) {
    const run = runCli('src/non-evm/index.ts', args);
    assert.equal(run.status, 2, args.join(' '));
    assert.doesNotMatch(run.stdout, /Report:/);
  }
});
