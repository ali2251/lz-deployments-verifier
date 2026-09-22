import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveChain } from '../src/metadata.js';
import { MOCK_METADATA } from './helpers.js';

test('a deployment name resolves to its endpoint, chain id, currency and RPCs', () => {
  assert.deepEqual(resolveChain(MOCK_METADATA, 'arbitrum'), {
    name: 'arbitrum',
    eid: 30110,
    chainKey: 'arbitrum',
    chainType: 'evm',
    nativeChainId: 42161,
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    rpcs: ['http://127.0.0.1:8599/42161'],
    explorer: 'https://arbiscan.io',
  });
  assert.equal(resolveChain(MOCK_METADATA, 'solana')?.chainType, 'solana');
  assert.equal(resolveChain(MOCK_METADATA, 'atlantis'), null);
});

test('legacy zkconsensys deployment resolves current Linea metadata without changing the deployment key', () => {
  const metadata = { linea: { deployments: [{ version: 2, stage: 'mainnet', eid: 30183 }], chainDetails: { chainType: 'evm', nativeChainId: 59144 } } };
  const chain = resolveChain(metadata, 'zkconsensys');
  assert.equal(chain?.name, 'zkconsensys');
  assert.equal(chain?.chainKey, 'linea');
  assert.equal(chain?.eid, 30183);
  assert.equal(chain?.nativeChainId, 59144);
});

test('chain resolution only accepts LayerZero V2 mainnet endpoints', () => {
  const entry = (deployments: unknown[]) => ({ x: { deployments, chainDetails: { chainType: 'evm' } } }) as any;
  assert.equal(resolveChain(entry([{ version: 1, eid: 101 }]), 'x'), null);
  assert.equal(resolveChain(entry([{ version: 2, stage: 'testnet', eid: 40101 }]), 'x'), null);
  assert.equal(resolveChain(entry([{ version: 1, eid: 101 }, { version: 2, stage: 'mainnet', eid: '30101' }]), 'x')?.eid, 30101);
  assert.equal(resolveChain({}, 'x'), null);
  assert.equal(resolveChain({ 'x-mainnet': entry([{ version: 2, eid: 30101 }]).x }, 'x')?.chainKey, 'x-mainnet');
});
