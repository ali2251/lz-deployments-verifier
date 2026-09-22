import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadExpected } from '../src/config.js';
import { validateExpectations } from '../src/non-evm/policy.js';
import {
  assertHardcodedSigner,
  HARD_CODED_SIGNERS,
  resolveSolanaSignerPolicy,
  secp256k1SignerAddress,
  SOLANA_SIGNER_PUBLIC_KEY,
} from '../src/signers.js';
import { fromRoot, readJson, tempJson } from './helpers.js';

const OTHER_SIGNER = '0x1111111111111111111111111111111111111111';
const SOLANA_ACCOUNT = 'nKtqDFhGeUDQpDVatUxKFUkSciAkBUaTof1g1iJQTr4';

test('production EVM profiles reject attempts to override the pinned signer', (t) => {
  for (const file of ['expected.json', 'expected-subsidized.json']) {
    assert.equal(loadExpected(fromRoot(file)).signers[0]!.toLowerCase(), HARD_CODED_SIGNERS.evm.toLowerCase());

    const policy = readJson(file);
    policy.signers = [OTHER_SIGNER];
    assert.throws(() => loadExpected(tempJson(t, policy)), /cannot override/);
  }
});

test('non-EVM signer pins reject overrides and ignore hex case', () => {
  const policy = readJson('expected-non-evm.json');
  resolveSolanaSignerPolicy(policy);

  for (const chain of ['solana', 'stellar', 'tron'] as const) {
    const pinned = HARD_CODED_SIGNERS[chain];
    assert.doesNotThrow(() => assertHardcodedSigner(chain, policy.chains[chain].signers));
    assert.doesNotThrow(() => assertHardcodedSigner(chain, [pinned.toLowerCase()]));
    for (const signers of [null, [], [pinned, pinned], [OTHER_SIGNER]]) {
      assert.throws(() => assertHardcodedSigner(chain, signers), /cannot override/);
    }
  }
  assert.deepEqual(validateExpectations(policy, ['solana', 'stellar', 'tron']), []);
});

test('Solana derives its address from a validated raw public key', () => {
  assert.equal(secp256k1SignerAddress(SOLANA_SIGNER_PUBLIC_KEY), '0x30Eef9754502f7B77895602F2C355baA37C36281');
  assert.equal(HARD_CODED_SIGNERS.solana, '0x30Eef9754502f7B77895602F2C355baA37C36281');

  const substitutes = {
    'a point that is not on the curve': '0x' + '00'.repeat(64),
    'a key with the 04 prefix': '0x04' + SOLANA_SIGNER_PUBLIC_KEY.slice(2),
    'a 32-byte value': '0x' + '11'.repeat(32),
    'the Solana account address': SOLANA_ACCOUNT,
  };
  for (const [description, key] of Object.entries(substitutes)) assert.throws(() => secp256k1SignerAddress(key), description);
});

test('the Solana policy must list exactly the pinned public key', () => {
  const policy = { chains: { solana: { publicKeys: [SOLANA_SIGNER_PUBLIC_KEY] } as any } };
  resolveSolanaSignerPolicy(policy);
  assert.deepEqual(policy.chains.solana.signers, [HARD_CODED_SIGNERS.solana]);

  for (const publicKeys of [undefined, [], [SOLANA_SIGNER_PUBLIC_KEY, SOLANA_SIGNER_PUBLIC_KEY], ['0x' + '11'.repeat(64)]]) {
    assert.throws(() => resolveSolanaSignerPolicy({ chains: { solana: { publicKeys } } }), /cannot override/);
  }
  // an address listed next to the key has to agree with it
  const disagreeing = { chains: { solana: { publicKeys: [SOLANA_SIGNER_PUBLIC_KEY], signers: [OTHER_SIGNER] } } };
  assert.throws(() => resolveSolanaSignerPolicy(disagreeing), /cannot override/);
});
