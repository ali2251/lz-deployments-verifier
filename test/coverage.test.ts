import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadDeployment } from '../src/config.js';
import { chainKey } from '../src/chain-names.js';
import { coverage, type ApplicationRequirements } from '../src/coverage.js';
import { fromRoot, readJson, runCli } from './helpers.js';

const requirements: Record<string, ApplicationRequirements> = readJson('applications/requirements.json');
const deployments = {
  sponsored: loadDeployment(fromRoot('deployments/canary-sponsored.json')),
  subsidized: loadDeployment(fromRoot('deployments/canary-subsidized.json')),
};

test('USDT0 requirements cover both CSV columns, including aliases and non-EVM chains', () => {
  // both chain columns of every CSV row, header excluded
  const csvChains = readFileSync(fromRoot('usdt0.csv'), 'utf8')
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .flatMap((line) => line.split(',').slice(0, 2))
    .map(chainKey);
  const rows = coverage(requirements.usdt0!, 'sponsored', deployments);
  assert.deepEqual(new Set(rows.map(r => r.key)), new Set(csvChains));
  assert.deepEqual(rows.filter(r => r.status === 'MISSING').map(r => r.chain), ['Corn', 'TON', 'Tron']);
  assert.equal(rows.find(r => r.chain === 'HyperEVM')?.status, 'LISTED');
  assert.equal(rows.find(r => r.chain === 'HyperEVM')?.address, '0x0e330b859441d6172e41591ad6a2448268840456');
  assert.equal(rows.find(r => r.chain === 'HyperEVM')?.otherTierAddress, deployments.subsidized.contractAddresses.hyperliquid);
  assert.equal(rows.find(r => r.chain === 'Solana')?.status, 'LISTED');
});

test('Ondo deduplicates shared products and compares each tier independently', () => {
  const sponsored = coverage(requirements.ondo!, 'sponsored', deployments);
  const subsidized = coverage(requirements.ondo!, 'subsidized', deployments);
  assert.equal(sponsored.length, 15);
  assert.deepEqual(sponsored.find(r => r.key === 'ethereum')?.products, ['usdy', 'ousg', 'stocks']);
  assert.equal(sponsored.find(r => r.key === 'plumephoenix')?.status, 'LISTED');
  assert.equal(sponsored.find(r => r.key === 'solana')?.status, 'LISTED');
  assert.equal(subsidized.find(r => r.key === 'solana')?.status, 'MISSING');
  assert.equal(coverage(requirements.ondo!, 'sponsored', deployments, 'stocks').filter(r => r.status === 'MISSING').length, 0);
});

test('fixed tiers, unknown products and empty requirements cannot pass accidentally', () => {
  assert.throws(() => coverage(requirements.ethena!, 'sponsored', deployments), /requires subsidized/);
  assert.throws(() => coverage(requirements.ondo!, 'sponsored', deployments, 'typo'), /Unknown product/);
  assert.throws(() => coverage({ tier: 'either', source: '', products: {} }, 'sponsored', deployments), /no required chains/);
  const rows = coverage({ tier: 'either', source: '', products: { test: ['New Chain', 'Ethereum'] } }, 'sponsored', {
    ...deployments, sponsored: { canonicalName: 'test', contractAddresses: { ethereum: '0x0000000000000000000000000000000000000000' } },
  });
  assert.ok(rows.every(r => r.status === 'MISSING'));
});

test('CLI returns 1 for gaps, 0 for covered product and 2 for invalid input', () => {
  const run = (...args: string[]) => runCli('src/coverage-cli.ts', args);
  const gaps = run('all');
  assert.equal(gaps.status, 1, gaps.stderr);
  assert.match(gaps.stdout, /ethena — subsidized/);
  assert.match(gaps.stdout, /ondo — sponsored/);
  assert.match(gaps.stdout, /ondo — subsidized/);
  assert.equal(run('ondo', '--tier', 'sponsored', '--product', 'stocks').status, 0);
  assert.equal(run('unknown').status, 2);
  assert.equal(run('ondo', '--tier').status, 2);
  assert.equal(run('ethena', '--tier', 'sponsored').status, 2);
});
