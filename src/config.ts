/** Loads and validates the two input files: the deployment inventory and the expected on-chain state. */
import { existsSync, readFileSync } from 'node:fs';
import { getAddress, isAddress, zeroAddress, type Address, type Hex } from 'viem';
import { assertHardcodedSigner } from './signers.js';

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/** What one pathway's dstConfig must look like. `null` means "record it, don't assert it". */
export interface DstExpectation {
  /** exact floorMarginUSD, in price-feed USD denomination */
  floorMarginUSD: bigint | null;
  /** exact multiplierBps (0 on-chain means "inherit defaultMultiplierBps") */
  multiplierBps: number | null;
  /** dstConfig.gas must be >= this. 1 means "must be configured at all". */
  minGas: bigint;
}

export interface WorkerExpectation {
  defaultMultiplierBps: number | null;
  allowlistSize: bigint | null;
  paused: boolean | null;
  requirePriceFeedSet: boolean;
  requireFeeLibSet: boolean;
}

/** Parameters of the sample getFee() quote taken on every pathway. */
export interface QuoteExpectation {
  enabled: boolean;
  sender: Address;
  confirmations: bigint;
  options: Hex;
  /** optional USD cap on a quote */
  maxUsd: number | null;
  /** require the quote to equal the fee library's quote with the floor forced to zero */
  requireFloorNotBinding: boolean;
}

export interface Expected {
  /** must equal the deployment's canonicalName */
  deployment: string;
  signers: Address[];
  quorum: bigint;
  worker: WorkerExpectation;
  dst: {
    default: DstExpectation;
    /** keyed by "src" or "src->dst", lowercased; see expectationFor() */
    overrides: Record<string, Partial<DstExpectation>>;
  };
  quote: QuoteExpectation;
  /** price-feed USD scale, a power of ten */
  usdDenominator: bigint;
}

export interface Deployment {
  canonicalName: string;
  /** chain canonical name -> DVN address (EVM chains are 0x + 40 hex) */
  contractAddresses: Record<string, string>;
}

// ---------------------------------------------------------------------------
// field parsers — each throws a message naming the offending field
// ---------------------------------------------------------------------------

type Json = Record<string, any>;

/** Profiles whose signer is pinned in src/signers.ts and cannot be overridden by a file. */
const PINNED_SIGNER_PROFILES = ['canary-sponsored', 'canary-subsidized'];
const DEFAULT_USD_DENOMINATOR = '100000000000000000000'; // 1e20
const DEFAULT_QUOTE_SENDER = '0x000000000000000000000000000000000000dEaD';

const isMissing = (value: unknown): value is null | undefined => value === undefined || value === null;

/** An unsigned integer that fits `bits`. Numbers must be safe integers; larger values must be strings. */
function unsigned(name: string, value: unknown, bits: number): bigint {
  const isInteger =
    (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) &&
    /^\d+$/.test(String(value));
  if (!isInteger) throw new Error(`${name} must be an unsigned integer (large values must be strings)`);
  const parsed = BigInt(value as string | number);
  if (parsed >= 2n ** BigInt(bits)) throw new Error(`${name} exceeds uint${bits}`);
  return parsed;
}

function optionalBoolean(name: string, value: unknown): boolean | null {
  if (isMissing(value)) return null;
  if (typeof value !== 'boolean') throw new Error(`${name} must be boolean`);
  return value;
}

function parseSigners(raw: unknown): Address[] {
  if (!Array.isArray(raw)) throw new Error('signers must be an array');
  if (raw.length === 0) throw new Error('"signers" is empty — paste the expected DVN signer address(es).');

  const invalid = raw.filter((s) => typeof s !== 'string' || !isAddress(s) || s.toLowerCase() === zeroAddress);
  if (invalid.length > 0) {
    throw new Error(
      `not valid addresses: ${invalid.join(', ')}\n` +
        'Replace the placeholder(s) with the real Canary DVN signer address(es) before running.',
    );
  }

  const signers = raw.map((s: string) => getAddress(s));
  const duplicates = signers.filter((s, i) => signers.indexOf(s) !== i);
  if (duplicates.length > 0) throw new Error(`duplicate signers: ${[...new Set(duplicates)].join(', ')}`);
  return signers;
}

function parseQuorum(raw: unknown, signerCount: number): bigint {
  const quorum = unsigned('quorum', raw ?? 0, 64);
  if (quorum <= 0n) throw new Error('"quorum" must be > 0');
  if (quorum > BigInt(signerCount)) {
    throw new Error(`quorum (${quorum}) exceeds the number of expected signers (${signerCount}).`);
  }
  return quorum;
}

function parseWorker(raw: Json = {}): WorkerExpectation {
  return {
    defaultMultiplierBps: isMissing(raw.defaultMultiplierBps)
      ? null
      : Number(unsigned('defaultMultiplierBps', raw.defaultMultiplierBps, 16)),
    allowlistSize: isMissing(raw.allowlistSize) ? null : unsigned('allowlistSize', raw.allowlistSize, 64),
    paused: optionalBoolean('paused', raw.paused),
    requirePriceFeedSet: optionalBoolean('requirePriceFeedSet', raw.requirePriceFeedSet) !== false,
    requireFeeLibSet: optionalBoolean('requireFeeLibSet', raw.requireFeeLibSet) !== false,
  };
}

/** Only the fields present in `raw`, so that an override inherits everything it omits. */
function parseDstFields(raw: Json | null | undefined): Partial<DstExpectation> {
  const fields: Partial<DstExpectation> = {};
  if (raw?.floorMarginUSD !== undefined) {
    fields.floorMarginUSD = raw.floorMarginUSD === null ? null : unsigned('floorMarginUSD', raw.floorMarginUSD, 128);
  }
  if (raw?.multiplierBps !== undefined) {
    fields.multiplierBps = raw.multiplierBps === null ? null : Number(unsigned('multiplierBps', raw.multiplierBps, 16));
  }
  if (raw?.minGas !== undefined) {
    fields.minGas = unsigned('minGas', raw.minGas, 64);
    if (fields.minGas < 1n) throw new Error('minGas must be >= 1');
  }
  return fields;
}

function parseDst(raw: Json = {}): Expected['dst'] {
  const overrides: Record<string, Partial<DstExpectation>> = {};
  for (const [key, value] of Object.entries<Json>(raw.overrides ?? {})) {
    overrides[key.toLowerCase()] = parseDstFields(value);
  }
  return {
    default: { floorMarginUSD: null, multiplierBps: null, minGas: 1n, ...parseDstFields(raw.default) },
    overrides,
  };
}

function parseQuote(raw: Json = {}): QuoteExpectation {
  const maxUsd = raw.maxUsd ?? null;
  const options = raw.options ?? '0x';
  const sender = raw.sender ?? DEFAULT_QUOTE_SENDER;
  if (maxUsd !== null && (typeof maxUsd !== 'number' || !Number.isFinite(maxUsd) || maxUsd < 0)) {
    throw new Error('maxUsd must be finite and nonnegative');
  }
  if (typeof options !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(options)) {
    throw new Error('quote.options must be hex bytes');
  }
  if (!isAddress(sender)) throw new Error('quote.sender is not a valid address');

  return {
    enabled: optionalBoolean('enabled', raw.enabled) !== false,
    sender: getAddress(sender),
    confirmations: unsigned('confirmations', raw.confirmations ?? 1, 64),
    options: options as Hex,
    maxUsd,
    requireFloorNotBinding: optionalBoolean('requireFloorNotBinding', raw.requireFloorNotBinding) !== false,
  };
}

function parseUsdDenominator(raw: unknown): bigint {
  const denominator = unsigned('usdDenominator', raw ?? DEFAULT_USD_DENOMINATOR, 256);
  if (!/^10*$/.test(denominator.toString())) throw new Error('usdDenominator must be a positive power of ten');
  return denominator;
}

// ---------------------------------------------------------------------------
// loaders
// ---------------------------------------------------------------------------

function parseExpected(raw: Json): Expected {
  if (PINNED_SIGNER_PROFILES.includes(raw.deployment)) assertHardcodedSigner('evm', raw.signers);
  const signers = parseSigners(raw.signers);
  return {
    deployment: raw.deployment ?? 'unknown',
    signers,
    quorum: parseQuorum(raw.quorum, signers.length),
    worker: parseWorker(raw.worker ?? undefined),
    dst: parseDst(raw.dstConfig ?? undefined),
    quote: parseQuote(raw.quote ?? undefined),
    usdDenominator: parseUsdDenominator(raw.usdDenominator),
  };
}

export function loadExpected(path: string): Expected {
  if (!existsSync(path)) throw new Error(`expected config not found: ${path}`);
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path}: expected an object`);
  try {
    return parseExpected(raw);
  } catch (err) {
    throw new Error(`${path}: ${err instanceof Error ? err.message : err}`);
  }
}

/** Resolve the expectation for one src->dst pathway (pathway override > src override > default). */
export function expectationFor(expected: Expected, src: string, dst: string): DstExpectation {
  const sourceWide = expected.dst.overrides[src.toLowerCase()];
  const pathway = expected.dst.overrides[`${src}->${dst}`.toLowerCase()];
  return { ...expected.dst.default, ...sourceWide, ...pathway };
}

export function loadDeployment(path: string): Deployment {
  if (!existsSync(path)) throw new Error(`deployment file not found: ${path}`);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const addresses: unknown = raw.config?.contractAddresses ?? raw.contractAddresses;

  const isAddressMap =
    addresses !== null &&
    typeof addresses === 'object' &&
    !Array.isArray(addresses) &&
    Object.keys(addresses).length > 0 &&
    Object.entries(addresses).every(([name, address]) => name.trim() && typeof address === 'string' && address.trim());
  if (!isAddressMap) throw new Error(`${path}: no config.contractAddresses object found`);

  return {
    canonicalName: raw.canonicalName ?? 'unknown',
    contractAddresses: addresses as Record<string, string>,
  };
}
