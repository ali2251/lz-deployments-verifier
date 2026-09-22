/**
 * ABI fragments for the LayerZero V2 DVN stack — only what this tool reads.
 *
 * Sourced from layerzero-v2/packages/layerzero-v2/evm/messagelib/contracts/uln/dvn/
 *   DVN.sol        (vid, dstConfig, getFee)
 *   DVNFeeLib.sol  (getFee)
 *   ../../Worker.sol   (priceFeed, workerFeeLib, defaultMultiplierBps, allowlistSize, paused)
 *   ../../MultiSig.sol (signers, signerSize, quorum, UpdateSigner)
 */
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

  // --- Worker ---
  { type: 'function', name: 'priceFeed', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'workerFeeLib', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'defaultMultiplierBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'allowlistSize', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },

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
