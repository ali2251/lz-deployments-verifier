/**
 * Mock LayerZero DVN chain, for exercising the verifier without touching mainnet.
 *
 *   npx tsx test/mock-rpc.ts &
 *   npm run verify -- --metadata-file test/mock-metadata.json \
 *                     --deployment test/mock-deployment.json \
 *                     --expected test/mock-expected.json \
 *                     --json none --md none
 *
 * Chain 1 (ethereum) is configured correctly. Chain 42161 (arbitrum) is
 * deliberately broken — an extra signer and a $0.25 floor on one pathway — so the
 * failure paths get exercised too. Chain 137 (polygon) is offline.
 */
import { createServer } from 'node:http';
import { decodeFunctionData, encodeFunctionResult, isAddressEqual, type Address } from 'viem';
import { dvnAbi, dvnFeeLibAbi, priceFeedAbi } from '../src/abi.js';

const PORT = 8599;

const GOOD_SIGNER = '0x1111111111111111111111111111111111111111' as Address;
const ROGUE_SIGNER = '0x2222222222222222222222222222222222222222' as Address;
const PRICE_FEED = '0x0000000000000000000000000000000000000f33' as Address;
const FEE_LIB = '0x000000000000000000000000000000000000fe1b' as Address;

/** $0.25 in the price feed's 1e20 USD denomination */
const QUARTER_USD = 25n * 10n ** 18n;

interface ChainState {
  chainId: number;
  signers: Address[];
  quorum: bigint;
  allowlistSize: bigint;
  paused: boolean;
  defaultMultiplierBps: number;
  /** dstEid -> [gas, multiplierBps, floorMarginUSD] */
  dstConfig: Record<number, [bigint, number, bigint]>;
  nativeTokenPriceUSD: bigint;
  /** gas-only fee returned before any floor is applied */
  baseFeeWei: bigint;
  /** dstEids whose getFee() reverts even though dstConfig looks configured */
  revertFeeFor?: number[];
  /** simulate a DVN contract version whose fee lib has a different ABI */
  feeLibIncompatible?: boolean;
  /** fail this many requests with 503 before serving normally, to exercise retry */
  flaky?: number;
}

const CHAINS: Record<number, ChainState> = {
  1: {
    chainId: 1,
    signers: [GOOD_SIGNER],
    quorum: 1n,
    allowlistSize: 0n,
    paused: false,
    defaultMultiplierBps: 12000,
    dstConfig: { 30110: [100000n, 0, 0n], 30109: [100000n, 0, 0n], 30168: [100000n, 0, 0n] },
    nativeTokenPriceUSD: 3000n * 10n ** 20n / 1n, // $3000 in 1e20 denomination
    baseFeeWei: 20_000_000_000_000n, // 0.00002 ETH
  },
  42161: {
    chainId: 42161,
    signers: [GOOD_SIGNER, ROGUE_SIGNER], // <- extra signer, should FAIL
    quorum: 1n,
    allowlistSize: 0n,
    paused: false,
    defaultMultiplierBps: 12000,
    dstConfig: {
      30101: [100000n, 0, QUARTER_USD], // <- $0.25 floor on a sponsored pathway, should FAIL
      30109: [100000n, 0, 0n],
      30168: [0n, 0, 0n], // <- unconfigured destination, should FAIL
    },
    nativeTokenPriceUSD: 3000n * 10n ** 20n,
    baseFeeWei: 2_000_000_000_000n,
  },
  // every remaining failure path at once: paused, allowlist-gated, wrong quorum,
  // a getFee that reverts on a configured destination, and an unrecognised fee lib
  1088: {
    chainId: 1088,
    signers: [GOOD_SIGNER],
    quorum: 2n, // <- expected 1
    allowlistSize: 3n, // <- gated, expected 0
    paused: true, // <- expected false
    defaultMultiplierBps: 10000, // <- expected 12000
    dstConfig: { 30101: [100000n, 0, 0n], 30110: [100000n, 5000, 0n], 30109: [100000n, 0, 0n] },
    nativeTokenPriceUSD: 2n * 10n ** 20n,
    baseFeeWei: 500_000_000_000_000_000n,
    revertFeeFor: [30101],
    feeLibIncompatible: true,
  },
  // correctly configured, but rate-limits the first few requests — should end up PASS
  // once retries kick in, which is the whole point of --retries / --slow
  122: {
    chainId: 122,
    signers: [GOOD_SIGNER],
    quorum: 1n,
    allowlistSize: 0n,
    paused: false,
    defaultMultiplierBps: 12000,
    dstConfig: {
      30101: [100000n, 0, 0n],
      30110: [100000n, 0, 0n],
      30109: [100000n, 0, 0n],
      30151: [100000n, 0, 0n],
      30168: [100000n, 0, 0n],
    },
    nativeTokenPriceUSD: 3n * 10n ** 19n,
    baseFeeWei: 100_000_000_000_000_000n,
    flaky: 3,
  },
};

/** how many requests each flaky chain has rejected so far */
const flakyCount = new Map<number, number>();

function feeFor(state: ChainState, dstEid: number): bigint {
  const cfg = state.dstConfig[dstEid];
  if (!cfg || cfg[0] === 0n) throw new Error('DVN_EidNotSupported');
  if (state.revertFeeFor?.includes(dstEid)) throw new Error('PriceFeed_UnknownEid');
  const [, multiplierBps, floor] = cfg;
  const mult = BigInt(multiplierBps === 0 ? state.defaultMultiplierBps : multiplierBps);
  const withMultiplier = (state.baseFeeWei * mult) / 10000n;
  if (floor === 0n) return withMultiplier;
  const withFloor = state.baseFeeWei + (floor * 10n ** 18n) / state.nativeTokenPriceUSD;
  return withFloor > withMultiplier ? withFloor : withMultiplier;
}

function handleCall(state: ChainState, to: Address, data: `0x${string}`): `0x${string}` {
  // price feed
  if (isAddressEqual(to, PRICE_FEED)) {
    const { functionName } = decodeFunctionData({ abi: priceFeedAbi, data });
    if (functionName === 'nativeTokenPriceUSD') {
      return encodeFunctionResult({ abi: priceFeedAbi, functionName, result: state.nativeTokenPriceUSD });
    }
    throw new Error(`unhandled price feed call ${functionName}`);
  }

  // fee lib — used for the "is the floor binding?" cross-check
  if (isAddressEqual(to, FEE_LIB)) {
    if (state.feeLibIncompatible) throw new Error('function selector not recognized');
    const { args } = decodeFunctionData({ abi: dvnFeeLibAbi, data });
    const [params, dstConfig] = args as any;
    const mult = BigInt(dstConfig.multiplierBps === 0 ? params.defaultMultiplierBps : dstConfig.multiplierBps);
    const withMultiplier = (state.baseFeeWei * mult) / 10000n;
    const floor: bigint = dstConfig.floorMarginUSD;
    const fee =
      floor === 0n
        ? withMultiplier
        : (() => {
            const withFloor = state.baseFeeWei + (floor * 10n ** 18n) / state.nativeTokenPriceUSD;
            return withFloor > withMultiplier ? withFloor : withMultiplier;
          })();
    return encodeFunctionResult({ abi: dvnFeeLibAbi, functionName: 'getFee', result: fee });
  }

  // the DVN itself
  const { functionName, args } = decodeFunctionData({ abi: dvnAbi, data });
  const r = (result: unknown) => encodeFunctionResult({ abi: dvnAbi, functionName, result: result as any });

  switch (functionName) {
    case 'quorum': return r(state.quorum);
    case 'signerSize': return r(BigInt(state.signers.length));
    case 'signers': return r(state.signers.some((s) => isAddressEqual(s, (args as any)[0])));
    case 'priceFeed': return r(PRICE_FEED);
    case 'workerFeeLib': return r(FEE_LIB);
    case 'defaultMultiplierBps': return r(state.defaultMultiplierBps);
    case 'allowlistSize': return r(state.allowlistSize);
    case 'paused': return r(state.paused);
    case 'vid': return r(1);
    case 'dstConfig': {
      const cfg = state.dstConfig[Number((args as any)[0])] ?? [0n, 0, 0n];
      return encodeFunctionResult({ abi: dvnAbi, functionName, result: cfg as any });
    }
    case 'getFee': return r(feeFor(state, Number((args as any)[0])));
    default: throw new Error(`unhandled DVN call ${functionName}`);
  }
}

function respond(state: ChainState, req: any) {
  const id = req.id ?? null;
  try {
    switch (req.method) {
      case 'eth_chainId':
        return { jsonrpc: '2.0', id, result: `0x${state.chainId.toString(16)}` };
      case 'eth_getCode':
        return { jsonrpc: '2.0', id, result: '0x60806040' };
      case 'eth_blockNumber':
        return { jsonrpc: '2.0', id, result: '0x1000' };
      case 'eth_call': {
        const { to, data } = req.params[0];
        return { jsonrpc: '2.0', id, result: handleCall(state, to as Address, data) };
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported: ${req.method}` } };
    }
  } catch (err: any) {
    return { jsonrpc: '2.0', id, error: { code: 3, message: `execution reverted: ${err?.message ?? err}` } };
  }
}

createServer((req, res) => {
  const chainId = Number((req.url ?? '/').slice(1));
  const state = CHAINS[chainId];
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (!state) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: 'chain offline in mock' }));
      return;
    }
    if (state.flaky) {
      const seen = flakyCount.get(chainId) ?? 0;
      if (seen < state.flaky) {
        flakyCount.set(chainId, seen + 1);
        res.statusCode = 503;
        res.end(JSON.stringify({ error: `rate limited (${seen + 1}/${state.flaky})` }));
        return;
      }
    }
    const parsed = JSON.parse(body || '{}');
    const out = Array.isArray(parsed) ? parsed.map((p) => respond(state, p)) : respond(state, parsed);
    res.end(JSON.stringify(out));
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock DVN chains listening on http://127.0.0.1:${PORT}/{1,42161}  (137 = offline)`);
  console.log(`  good signer  ${GOOD_SIGNER}`);
  console.log(`  rogue signer ${ROGUE_SIGNER} (present on 42161 only)`);
});
