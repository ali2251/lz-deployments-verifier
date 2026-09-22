/**
 * The non-EVM pass/fail policy. Collectors only record what they read (a ChainSnapshot);
 * everything here decides whether a snapshot satisfies the expected policy.
 *
 * Snapshots are read back from disk, so nothing about their shape is trusted: a missing
 * or malformed field must fail, never pass by accident.
 */
import { isAddress, zeroAddress } from 'viem';
import type { Destination } from '../types.js';

export type Source = 'solana' | 'stellar' | 'tron';
export const SOURCES: Source[] = ['solana', 'stellar', 'tron'];

/** One chain's entry in expected-non-evm.json. */
export interface Expectation {
  /** signer addresses; for Solana these are derived from `publicKeys` */
  signers: string[];
  /** Solana only: the full 64-byte secp256k1 keys stored on-chain */
  publicKeys?: string[];
  quorum: number;
  defaultMultiplierBps: number;
  /** per destination chain name, falling back to `default` */
  destinationMultiplierBps: Record<string, number> & { default: number };
}

type ReadStatus = 'PASS' | 'FAIL' | 'MISSING' | 'ERROR';

/** What a collector read for one source -> destination pathway. */
export interface PathwaySnapshot {
  dst: string;
  eid: number;
  gas?: string | number;
  floorMarginUSD?: string;
  multiplierBps?: number;
  /** PASS = configured (gas > 0) with a zero floor */
  configStatus?: ReadStatus;
  configError?: string;
  /** the quoted fee in the chain's smallest unit; zero is a valid quote */
  feeRaw?: string;
  quoteStatus?: ReadStatus;
  error?: string;
}

/** What a collector read for one source chain. Written to <chain>-final.json. */
export interface ChainSnapshot {
  runId: string;
  checkedAt: string;
  /** set last: a snapshot without it is incomplete and cannot pass */
  completedAt?: string;
  address: string;
  signerAddresses: string[];
  /** Solana only */
  signerPublicKeys?: string[];
  /** Tron only: the contract exposes a count and membership instead of the signer list */
  signerSize?: string;
  signerSetMatchesExpected?: boolean;
  quorum: number | string;
  paused: boolean;
  allowlistSize: number | string;
  defaultMultiplierBps: number;
  pathways: PathwaySnapshot[];
  checks?: { network: boolean; deployed: boolean; feeDependencies: boolean };
}

const lowercaseSorted = (values: string[]): string[] => values.map((value) => value.toLowerCase()).sort();
const sameSet = (a: string[], b: string[]): boolean => JSON.stringify(lowercaseSorted(a)) === JSON.stringify(lowercaseSorted(b));
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const isPositiveInteger = (value: unknown): boolean => Number.isInteger(value) && Number(value) >= 1;

/** Problems with the expectation file itself, checked before any network access. */
export function validateExpectations(policy: any, sources: Source[]): string[] {
  const errors: string[] = [];
  for (const name of sources) {
    const expected = policy?.chains?.[name];
    const signers: unknown[] = expected?.signers;
    if (!Array.isArray(signers) || !signers.length) {
      errors.push(`${name}: expected signers are missing; set chains.${name}.signers in expected-non-evm.json`);
      continue;
    }
    if (name === 'solana' && signers.some((s) => typeof s === 'string' && !s.startsWith('0x'))) {
      errors.push('solana: supplied account public key cannot verify the DVN secp256k1 signer; independently confirmed 20-byte signing-key address required');
      continue;
    }

    const isValidSigner = (s: unknown) =>
      typeof s === 'string' && isAddress(s, { strict: false }) && s.toLowerCase() !== zeroAddress;
    const uniqueSigners = new Set(signers.map((s) => String(s).toLowerCase()));
    if (!signers.every(isValidSigner)) errors.push(`${name}: invalid expected signer address`);
    if (uniqueSigners.size !== signers.length) errors.push(`${name}: duplicate expected signers`);

    if (!isPositiveInteger(expected.quorum) || expected.quorum > signers.length) errors.push(`${name}: invalid expected quorum`);
    if (!isPositiveInteger(expected.defaultMultiplierBps)) errors.push(`${name}: missing/invalid default multiplier`);

    const multipliers = expected.destinationMultiplierBps;
    if (!multipliers || !Number.isInteger(multipliers.default) || !Object.values(multipliers).every(isPositiveInteger)) {
      errors.push(`${name}: missing/invalid destination multiplier policy`);
    }
  }
  return errors;
}

/** A snapshot counts only if this run produced it and it ran to completion. */
export function completedSnapshot(snapshot: any, runId: string, startedAt: string): boolean {
  const started = Date.parse(startedAt);
  const completed = Date.parse(snapshot?.completedAt);
  return (
    snapshot?.runId === runId &&
    Number.isFinite(started) &&
    Number.isFinite(completed) &&
    completed >= started &&
    completed <= Date.now()
  );
}

/** A successfully returned fee: a nonnegative integer. Zero is valid. */
function isValidFee(fee: unknown): boolean {
  if (typeof fee === 'bigint') return fee >= 0n;
  if (typeof fee === 'number') return Number.isSafeInteger(fee) && fee >= 0;
  return typeof fee === 'string' && /^\d+$/.test(fee);
}

function isPositive(value: unknown): boolean {
  try {
    return value !== null && value !== undefined && BigInt(String(value)) > 0n;
  } catch {
    return false;
  }
}

function pathwayProblems(pathway: PathwaySnapshot, expectedMultiplierBps: number): string[] {
  const problems: string[] = [];
  const configOk =
    pathway.configStatus === 'PASS' && !pathway.configError && isPositive(pathway.gas) && String(pathway.floorMarginUSD) === '0';
  if (!configOk) problems.push('destination gas/floor check failed or incomplete');

  if (pathway.multiplierBps !== expectedMultiplierBps) problems.push('destination multiplier mismatch');

  const quoteOk = pathway.quoteStatus === 'PASS' && !pathway.error && isValidFee(pathway.feeRaw);
  if (!quoteOk) {
    problems.push(`fee check failed, missing, or invalid (${pathway.error ?? pathway.quoteStatus ?? 'missing'})`);
  }
  return problems;
}

/** Every way `snapshot` falls short of `expected`. An empty list means the chain passes. */
export function validateChain(
  name: Source,
  snapshot: Partial<ChainSnapshot> | undefined,
  expected: Expectation,
  destinations: Destination[],
): string[] {
  if (!snapshot) return [`${name}: no completed chain result`];
  const errors: string[] = [];
  const fail = (problem: string) => errors.push(`${name}: ${problem}`);

  // --- network, deployment, dependencies ---
  for (const check of ['network', 'deployed', 'feeDependencies'] as const) {
    if (snapshot.checks?.[check] !== true) fail(`${check} verification incomplete`);
  }

  // --- signers ---
  if (name === 'solana' && expected.publicKeys) {
    const keys = snapshot.signerPublicKeys;
    if (!isStringArray(keys) || !sameSet(keys, expected.publicKeys)) fail('public key set mismatch or missing');
  }
  const signers = snapshot.signerAddresses;
  if (!isStringArray(signers) || !signers.every((signer) => isAddress(signer, { strict: false }))) {
    fail('signer read missing/invalid');
  } else if (!sameSet(signers, expected.signers)) {
    const list = (values: string[]) => lowercaseSorted(values).join(', ');
    fail(`signer set mismatch: expected ${list(expected.signers)}, observed ${list(signers)}`);
  }
  if (name === 'tron') {
    if (snapshot.signerSetMatchesExpected !== true) fail('expected signer membership/count check failed or incomplete');
    if (String(snapshot.signerSize) !== String(expected.signers.length)) fail('signer count mismatch or missing');
  }

  // --- worker ---
  if (String(snapshot.quorum) !== String(expected.quorum)) fail('quorum mismatch or missing');
  if (snapshot.paused !== false) fail('pause check failed or missing');
  if (String(snapshot.allowlistSize) !== '0') fail('allowlist must be empty');
  if (snapshot.defaultMultiplierBps !== expected.defaultMultiplierBps) fail('default multiplier mismatch or missing');

  // --- exactly one good result per required destination ---
  const { pathways } = snapshot;
  if (!Array.isArray(pathways)) return [...errors, `${name}: pathway reads missing`];

  const required = destinations.filter((dst) => dst.name !== name);
  if (pathways.length !== required.length) fail(`incomplete pathway count: ${pathways.length}/${required.length}`);

  for (const dst of required) {
    const matches = pathways.filter((pathway) => pathway.dst === dst.name && pathway.eid === dst.eid);
    if (matches.length !== 1) {
      fail(`${dst.name}: missing or duplicate destination result`);
      continue;
    }
    const expectedMultiplierBps = expected.destinationMultiplierBps[dst.name] ?? expected.destinationMultiplierBps.default;
    for (const problem of pathwayProblems(matches[0]!, expectedMultiplierBps)) fail(`${dst.name}: ${problem}`);
  }
  return errors;
}
