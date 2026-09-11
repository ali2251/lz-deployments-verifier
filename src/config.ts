import { readFileSync, existsSync } from 'node:fs';
import { isAddress, getAddress, type Address, type Hex } from 'viem';

export interface DstExpectation {
  /** Exact expected floorMarginUSD, in price-feed USD denomination. `null` = don't assert. */
  floorMarginUSD: bigint | null;
  /** Exact expected multiplierBps (0 means "inherit defaultMultiplierBps"). `null` = don't assert. */
  multiplierBps: number | null;
  /** dstConfig.gas must be >= this. 1 means "must be configured at all". */
  minGas: bigint;
}

export interface Expected {
  deployment: string;
  signers: Address[];
  quorum: bigint;
  worker: {
    defaultMultiplierBps: number | null;
    allowlistSize: bigint | null;
    paused: boolean | null;
    requirePriceFeedSet: boolean;
    requireFeeLibSet: boolean;
  };
  dst: {
    default: DstExpectation;
    /** Keyed by "src" or "src->dst". More specific wins. */
    overrides: Record<string, Partial<DstExpectation>>;
  };
  quote: {
    enabled: boolean;
    sender: Address;
    confirmations: bigint;
    options: Hex;
    maxUsd: number | null;
    requireFloorNotBinding: boolean;
  };
  usdDenominator: bigint;
}

export interface Deployment {
  canonicalName: string;
  /** chain canonical name -> DVN address (EVM chains are 0x + 40 hex) */
  contractAddresses: Record<string, string>;
}

function parseDstExpectation(raw: any, base?: DstExpectation): DstExpectation {
  return {
    floorMarginUSD:
      raw?.floorMarginUSD === undefined
        ? (base?.floorMarginUSD ?? null)
        : raw.floorMarginUSD === null
          ? null
          : BigInt(raw.floorMarginUSD),
    multiplierBps:
      raw?.multiplierBps === undefined
        ? (base?.multiplierBps ?? null)
        : raw.multiplierBps === null
          ? null
          : Number(raw.multiplierBps),
    minGas: raw?.minGas === undefined ? (base?.minGas ?? 1n) : BigInt(raw.minGas),
  };
}

export function loadExpected(path: string): Expected {
  if (!existsSync(path)) throw new Error(`expected config not found: ${path}`);
  const raw = JSON.parse(readFileSync(path, 'utf8'));

  const signersRaw: string[] = raw.signers ?? [];
  if (signersRaw.length === 0) {
    throw new Error(`${path}: "signers" is empty — paste the expected DVN signer address(es).`);
  }
  const bad = signersRaw.filter((s) => !isAddress(s));
  if (bad.length > 0) {
    throw new Error(
      `${path}: not valid addresses: ${bad.join(', ')}\n` +
        `Replace the placeholder(s) with the real Canary DVN signer address(es) before running.`,
    );
  }
  const signers = signersRaw.map((s) => getAddress(s));
  const dupes = signers.filter((s, i) => signers.indexOf(s) !== i);
  if (dupes.length > 0) throw new Error(`${path}: duplicate signers: ${[...new Set(dupes)].join(', ')}`);

  const quorum = BigInt(raw.quorum ?? 0);
  if (quorum <= 0n) throw new Error(`${path}: "quorum" must be > 0`);
  if (quorum > BigInt(signers.length)) {
    throw new Error(`${path}: quorum (${quorum}) exceeds the number of expected signers (${signers.length}).`);
  }

  const defaultDst = parseDstExpectation(raw.dstConfig?.default ?? {});
  const overrides: Record<string, Partial<DstExpectation>> = {};
  for (const [key, value] of Object.entries<any>(raw.dstConfig?.overrides ?? {})) {
    overrides[key.toLowerCase()] = parseDstExpectation(value, defaultDst);
  }

  const quoteSender = raw.quote?.sender ?? '0x000000000000000000000000000000000000dEaD';
  if (!isAddress(quoteSender)) throw new Error(`${path}: quote.sender is not a valid address`);

  return {
    deployment: raw.deployment ?? 'unknown',
    signers,
    quorum,
    worker: {
      defaultMultiplierBps:
        raw.worker?.defaultMultiplierBps === undefined || raw.worker?.defaultMultiplierBps === null
          ? null
          : Number(raw.worker.defaultMultiplierBps),
      allowlistSize:
        raw.worker?.allowlistSize === undefined || raw.worker?.allowlistSize === null
          ? null
          : BigInt(raw.worker.allowlistSize),
      paused: raw.worker?.paused ?? null,
      requirePriceFeedSet: raw.worker?.requirePriceFeedSet !== false,
      requireFeeLibSet: raw.worker?.requireFeeLibSet !== false,
    },
    dst: { default: defaultDst, overrides },
    quote: {
      enabled: raw.quote?.enabled !== false,
      sender: getAddress(quoteSender),
      confirmations: BigInt(raw.quote?.confirmations ?? 1),
      options: (raw.quote?.options ?? '0x') as Hex,
      maxUsd: raw.quote?.maxUsd ?? null,
      requireFloorNotBinding: raw.quote?.requireFloorNotBinding !== false,
    },
    usdDenominator: BigInt(raw.usdDenominator ?? '100000000000000000000'),
  };
}

/** Resolve the expectation for one src->dst pathway (pathway override > src override > default). */
export function expectationFor(expected: Expected, src: string, dst: string): DstExpectation {
  const pathway = expected.dst.overrides[`${src}->${dst}`.toLowerCase()];
  const srcWide = expected.dst.overrides[src.toLowerCase()];
  return { ...expected.dst.default, ...srcWide, ...pathway };
}

export function loadDeployment(path: string): Deployment {
  if (!existsSync(path)) throw new Error(`deployment file not found: ${path}`);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const addresses = raw.config?.contractAddresses ?? raw.contractAddresses;
  if (!addresses || typeof addresses !== 'object') {
    throw new Error(`${path}: no config.contractAddresses object found`);
  }
  return {
    canonicalName: raw.canonicalName ?? 'unknown',
    contractAddresses: addresses,
  };
}

/** A 20-byte hex address is EVM; anything else (base58, 32-byte) is a non-EVM VM we don't read here. */
export function isEvmAddress(value: string): value is Address {
  return isAddress(value);
}
