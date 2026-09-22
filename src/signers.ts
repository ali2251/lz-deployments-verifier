/**
 * The pinned public signer identities. These are supplied independently of any RPC read:
 * expectation files must agree with them and can never override them.
 */
import { ECDH } from 'node:crypto';
import { getAddress, keccak256, type Hex } from 'viem';

/** Raw 64-byte x || y secp256k1 key published by Canary signer-info. */
export const SOLANA_SIGNER_PUBLIC_KEY =
  '0xd171a4428246ac2fe197c6ffe4973809e8d8c797a9c24010a99e31e98fcceb3694be32cbaa366166cafe512728e543a99e575aecd94451608ea20206cc5639f8';

/** The EVM-style address of a raw secp256k1 public key: last 20 bytes of keccak256(x || y). */
export function secp256k1SignerAddress(publicKey: string): string {
  if (typeof publicKey !== 'string' || !/^0x[0-9a-fA-F]{128}$/.test(publicKey)) {
    throw new Error('Expected a raw 64-byte secp256k1 public key (0x + 128 hex digits)');
  }
  // Throws unless the key is a point on the curve. The 04 (uncompressed) prefix is only
  // needed for this validation; it is never hashed.
  ECDH.convertKey(Buffer.from('04' + publicKey.slice(2), 'hex'), 'secp256k1');
  return getAddress('0x' + keccak256(publicKey as Hex).slice(-40));
}

export const HARD_CODED_SIGNERS = Object.freeze({
  evm: '0x6d695bDb416274d37fb877f5f46A3F20c9343D80',
  solana: secp256k1SignerAddress(SOLANA_SIGNER_PUBLIC_KEY),
  sui: '0x36e353871e75c0918126368cd0689f21835bcf57aea32e78feb78e34fc939576',
  tron: '0x869bFFb8777378343631ae99A5ef68d406Ab774c',
  starknet: '0x82c16B5BB0933428Dd69b9449728B0b25dd06A88',
  stellar: '0x70Da0d17248E28801f2FE4321497f8bbA57aC7c4',
  iotal1: '0x67a9137092e444d4a8d31e26c78f08ee2f114caab2afa67478f021c4c9bac2fb',
  aptos: '0xedb0145daf54b2f17644121ca490ab918985d11b21d0df9d3623ad65877f7a85',
});

export type PinnedChain = keyof typeof HARD_CODED_SIGNERS;

/** Throws unless `signers` is exactly the one pinned signer for `chain` (hex case is ignored). */
export function assertHardcodedSigner(chain: PinnedChain, signers: unknown): void {
  const pinned = HARD_CODED_SIGNERS[chain];
  const matches =
    Array.isArray(signers) &&
    signers.length === 1 &&
    typeof signers[0] === 'string' &&
    signers[0].toLowerCase() === pinned.toLowerCase();
  if (!matches) {
    throw new Error(`${chain}: signer policy must match the hardcoded signer ${pinned}; configuration files cannot override it`);
  }
}

/**
 * The Solana policy lists full public keys rather than addresses. Check that it is exactly
 * the pinned key, then fill in `signers` with the derived address so that Solana can be
 * validated like every other chain. Mutates `policy`.
 */
export function resolveSolanaSignerPolicy(policy: any): void {
  const solana = policy?.chains?.solana;
  const keys: unknown = solana?.publicKeys;
  const isPinnedKey =
    Array.isArray(keys) &&
    keys.length === 1 &&
    typeof keys[0] === 'string' &&
    keys[0].toLowerCase() === SOLANA_SIGNER_PUBLIC_KEY;
  if (!isPinnedKey) {
    throw new Error('solana: expected publicKeys must match the pinned 64-byte public key; configuration files cannot override it');
  }
  // a policy may also list the address, but then it has to agree with the pin
  if (solana.signers !== undefined) assertHardcodedSigner('solana', solana.signers);
  solana.signers = keys.map(secp256k1SignerAddress);
}
