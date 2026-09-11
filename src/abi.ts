/**
 * ABI fragments for the LayerZero V2 DVN stack.
 *
 * Sourced from layerzero-v2/packages/layerzero-v2/evm/messagelib/contracts/uln/dvn/
 *   DVN.sol        (dstConfig, getFee, assignJob)
 *   DVNFeeLib.sol  (getFee)
 *   ../../Worker.sol   (priceFeed, workerFeeLib, defaultMultiplierBps, allowlistSize, roles)
 *   ../../MultiSig.sol (signers, signerSize, quorum)
 */
import { keccak256, toBytes } from 'viem';

export const dvnAbi = [
  // --- MultiSig ---
  { type: 'function', name: 'quorum', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'signerSize', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  {
    type: 'function',
    name: 'signers',
    stateMutability: 'view',
    inputs: [{ name: 'signer', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'event',
    name: 'UpdateSigner',
    inputs: [
      { name: '_signer', type: 'address', indexed: false },
      { name: '_active', type: 'bool', indexed: false },
    ],
  },
  { type: 'event', name: 'UpdateQuorum', inputs: [{ name: '_quorum', type: 'uint64', indexed: false }] },

  // --- Worker ---
  { type: 'function', name: 'priceFeed', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'workerFeeLib', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'defaultMultiplierBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'allowlistSize', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  {
    type: 'function',
    name: 'hasRole',
    stateMutability: 'view',
    inputs: [
      { name: 'role', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getRoleMemberCount',
    stateMutability: 'view',
    inputs: [{ name: 'role', type: 'bytes32' }],
    outputs: [{ type: 'uint256' }],
  },

  // --- DVN ---
  { type: 'function', name: 'vid', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  {
    type: 'function',
    name: 'dstConfig',
    stateMutability: 'view',
    inputs: [{ name: 'dstEid', type: 'uint32' }],
    outputs: [
      { name: 'gas', type: 'uint64' },
      { name: 'multiplierBps', type: 'uint16' },
      { name: 'floorMarginUSD', type: 'uint128' },
    ],
  },
  {
    type: 'function',
    name: 'getFee',
    stateMutability: 'view',
    inputs: [
      { name: '_dstEid', type: 'uint32' },
      { name: '_confirmations', type: 'uint64' },
      { name: '_sender', type: 'address' },
      { name: '_options', type: 'bytes' },
    ],
    outputs: [{ name: 'fee', type: 'uint256' }],
  },
] as const;

export const priceFeedAbi = [
  { type: 'function', name: 'nativeTokenPriceUSD', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
  {
    type: 'function',
    name: 'estimateFeeByEid',
    stateMutability: 'view',
    inputs: [
      { name: '_dstEid', type: 'uint32' },
      { name: '_callDataSize', type: 'uint256' },
      { name: '_gas', type: 'uint256' },
    ],
    outputs: [
      { name: 'fee', type: 'uint256' },
      { name: 'priceRatio', type: 'uint128' },
      { name: 'priceRatioDenominator', type: 'uint128' },
      { name: 'priceUSD', type: 'uint128' },
    ],
  },
] as const;

/**
 * DVNFeeLib.getFee(FeeParams, IDVN.DstConfig, bytes) — the pure-view variant.
 * Used only for the "is the USD floor binding?" cross-check: we call it twice,
 * once with the real dstConfig and once with floorMarginUSD forced to 0. If the
 * two quotes are identical, no USD floor is being applied and the pathway is
 * priced on gas alone.
 */
export const dvnFeeLibAbi = [
  {
    type: 'function',
    name: 'getFee',
    stateMutability: 'view',
    inputs: [
      {
        name: '_params',
        type: 'tuple',
        components: [
          { name: 'priceFeed', type: 'address' },
          { name: 'dstEid', type: 'uint32' },
          { name: 'confirmations', type: 'uint64' },
          { name: 'sender', type: 'address' },
          { name: 'quorum', type: 'uint64' },
          { name: 'defaultMultiplierBps', type: 'uint16' },
        ],
      },
      {
        name: '_dstConfig',
        type: 'tuple',
        components: [
          { name: 'gas', type: 'uint64' },
          { name: 'multiplierBps', type: 'uint16' },
          { name: 'floorMarginUSD', type: 'uint128' },
        ],
      },
      { name: '_options', type: 'bytes' },
    ],
    outputs: [{ name: 'fee', type: 'uint256' }],
  },
] as const;

/** Role identifiers as defined in Worker.sol — computed, never hardcoded. */
export const ROLE = {
  ADMIN: keccak256(toBytes('ADMIN_ROLE')),
  MESSAGE_LIB: keccak256(toBytes('MESSAGE_LIB_ROLE')),
  ALLOWLIST: keccak256(toBytes('ALLOWLIST')),
  DENYLIST: keccak256(toBytes('DENYLIST')),
} as const;
