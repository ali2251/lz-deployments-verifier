import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDeployment } from '../src/config.js';
import { chainsToRerun, resolveScope, selectSources, type AppScope } from '../src/scope.js';
import { USDT0_EXCLUSIONS, usdt0VerificationChains } from '../src/usdt0-scope.js';
import { fromRoot, MOCK_METADATA, readJson, tempJson } from './helpers.js';

const mockDeployment = loadDeployment(fromRoot('test/mock-deployment.json'));

function mockScope(overrides: Partial<Parameters<typeof resolveScope>[0]> = {}) {
  return resolveScope({
    deployment: mockDeployment,
    metadata: MOCK_METADATA,
    chainlist: new Map(),
    rpcOverrides: {},
    maxRpcs: 5,
    app: null,
    ...overrides,
  });
}

test('EVM chains become sources; non-EVM chains are skipped but stay destinations', () => {
  const scope = mockScope();
  assert.deepEqual(scope.sources.map((s) => s.info.name), ['ethereum', 'arbitrum', 'polygon', 'metis', 'fuse']);
  assert.deepEqual(scope.unverified.map((c) => [c.name, c.status, c.skipReason]), [
    ['solana', 'SKIPPED', 'non-EVM VM — not verified by this script'],
  ]);
  assert.deepEqual(scope.destinations.at(-1), { name: 'solana', eid: 30168 });
  assert.equal(scope.destinations.length, 6);
  // addresses are checksummed for viem
  assert.equal(scope.sources[0]!.address, '0xF9D2C0915cac4C75b7ae359089333c8Ac258E12C');
});

test('chains that cannot be set up are reported as errors, not dropped', () => {
  const deployment = {
    canonicalName: 'test',
    contractAddresses: {
      ethereum: mockDeployment.contractAddresses.ethereum!,
      arbitrum: 'not-an-address',
      atlantis: '0x0000000000000000000000000000000000000001',
      polygon: mockDeployment.contractAddresses.polygon!,
    },
  };
  const metadata = { ...MOCK_METADATA, polygon: { ...MOCK_METADATA.polygon, rpcs: [] } };
  const scope = mockScope({ deployment, metadata });

  assert.deepEqual(scope.sources.map((s) => s.info.name), ['ethereum']);
  assert.deepEqual(scope.unverified.map((c) => [c.name, c.status, c.findings[0]?.check]), [
    ['arbitrum', 'ERROR', 'contract.address'],
    ['atlantis', 'ERROR', 'metadata.resolve'],
    ['polygon', 'ERROR', 'rpc.missing'],
  ]);
  // a chain with an endpoint id is still a required destination
  assert.deepEqual(scope.destinations.map((d) => d.name), ['ethereum', 'arbitrum', 'polygon']);
});

test('a scope without cross-chain coverage is refused', () => {
  const deployment = { canonicalName: 'test', contractAddresses: { ethereum: mockDeployment.contractAddresses.ethereum! } };
  assert.throws(() => mockScope({ deployment }), /No cross-chain destination coverage/);
});

test('--chains narrows sources, and flags requests that cannot be verified', () => {
  const scope = mockScope();
  assert.equal(selectSources(scope, null).selected.length, 5);

  const { selected, unverified } = selectSources(mockScope(), ['ethereum', 'solana', 'typo']);
  assert.deepEqual(selected.map((s) => s.info.name), ['ethereum']);
  assert.deepEqual(unverified.map((c) => [c.name, c.status, c.findings[0]?.detail]), [
    ['solana', 'ERROR', 'Explicitly requested source cannot be verified by the EVM verifier'],
    ['typo', 'ERROR', 'Requested source missing or outside selected application scope'],
  ]);

  assert.throws(() => selectSources(mockScope(), ['solana']), /No verifiable EVM source chains selected/);
});

test('the USDT0 application scope on the real sponsored inventory', () => {
  const app: AppScope = {
    chains: usdt0VerificationChains(readJson('applications/requirements.json').usdt0.products),
    exclusions: USDT0_EXCLUSIONS,
  };
  // synthetic metadata: every application chain resolves, with a unique endpoint id
  const nonEvm = ['solana', 'stellar', 'tron'];
  const metadata = Object.fromEntries(
    app.chains.map((name, index) => [
      name,
      {
        chainDetails: { chainType: nonEvm.includes(name) ? name : 'evm', nativeChainId: index + 1 },
        deployments: [{ version: 2, stage: 'mainnet', eid: 30100 + index }],
        rpcs: [{ url: 'http://rpc.invalid' }],
      },
    ]),
  );
  const scope = mockScope({ deployment: loadDeployment(fromRoot('deployments/canary-sponsored.json')), metadata, app });

  // every application chain is a destination, including the non-EVM ones
  assert.deepEqual(scope.destinations.map((d) => d.name).sort(), [...app.chains].sort());
  for (const name of nonEvm) assert.ok(scope.destinations.some((d) => d.name === name));
  // sources are the application's EVM chains only
  assert.ok(scope.sources.every((s) => app.chains.includes(s.info.name) && s.info.chainType === 'evm'));
  // exclusions are reported as skipped, never as passed
  for (const excluded of ['ton', 'corn']) {
    assert.equal(scope.unverified.find((c) => c.name === excluded)?.status, 'SKIPPED');
    assert.ok(!scope.destinations.some((d) => d.name === excluded));
  }
});

test('--rerun selects what did not pass, except chains this verifier never verifies', (t) => {
  const report = (chains: unknown) => tempJson(t, { deployment: 'canary-sponsored-mock', chains });
  const rerun = (chains: unknown) => chainsToRerun(report(chains), 'canary-sponsored-mock', MOCK_METADATA, null);

  assert.deepEqual(
    rerun([
      { name: 'ethereum', status: 'OK' },
      { name: 'arbitrum', status: 'FAIL' },
      { name: 'polygon', status: 'ERROR' },
      { name: 'solana', status: 'SKIPPED' },
    ]),
    ['arbitrum', 'polygon'],
  );
  assert.throws(() => rerun([{ name: 'ethereum', status: 'OK' }]), /No chains selected for rerun/);
  assert.throws(() => rerun([]), /Invalid or incompatible/);
  assert.throws(() => chainsToRerun(report([{ name: 'ethereum', status: 'FAIL' }]), 'another-deployment', MOCK_METADATA, null), /Invalid or incompatible/);
});
