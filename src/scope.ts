/**
 * Works out what a run covers:
 *   sources       EVM chains whose DVN this run can verify
 *   destinations  every chain each source must be configured for (non-EVM chains included —
 *                 a sponsored pathway to Solana still needs a dstConfig on the source)
 *   unverified    chains that appear in the report without being verified: skipped on
 *                 purpose (non-EVM, excluded) or failed during setup (no metadata, no RPC, ...)
 */
import { existsSync, readFileSync } from 'node:fs';
import { getAddress, isAddress } from 'viem';
import type { ChainlistIndex } from './chainlist.js';
import type { Deployment } from './config.js';
import { resolveChain, type Metadata } from './metadata.js';
import { resolveRpcs, type RpcOrigin, type RpcOverrides } from './rpc-endpoints.js';
import type { ChainResult, ChainStatus, Destination } from './types.js';
import { USDT0_EXCLUSIONS, usdt0VerificationChains } from './usdt0-scope.js';
import type { SourceChain } from './verify-chain.js';

const NON_EVM_TYPES = new Set(['solana', 'aptos', 'sui', 'iotamove', 'ton', 'tron', 'stellar', 'initia', 'move']);

/** `--app` narrows sources and destinations to one application's chains. */
export interface AppScope {
  /** chains the application requires, as deployment keys */
  chains: string[];
  /** chain -> reason, for chains left out of verification on purpose */
  exclusions: Readonly<Record<string, string>>;
}

/** A verifiable source, plus where its RPC list came from (for the startup summary). */
export interface ResolvedSource extends SourceChain {
  rpcOrigin: RpcOrigin;
}

export interface Scope {
  sources: ResolvedSource[];
  destinations: Destination[];
  unverified: ChainResult[];
}

interface ScopeInputs {
  deployment: Deployment;
  metadata: Metadata;
  chainlist: ChainlistIndex;
  rpcOverrides: RpcOverrides;
  maxRpcs: number;
  app: AppScope | null;
}

// ---------------------------------------------------------------------------
// report entries for chains that are not verified
// ---------------------------------------------------------------------------

function skipped(name: string, address: string, skipReason: string): ChainResult {
  return { name, eid: null, address, status: 'SKIPPED', findings: [], pathways: [], skipReason };
}

function setupError(name: string, eid: number | null, address: string, check: string, detail: string): ChainResult {
  return { name, eid, address, status: 'ERROR', findings: [{ check, severity: 'ERROR', detail }], pathways: [] };
}

// ---------------------------------------------------------------------------
// application scope
// ---------------------------------------------------------------------------

export function loadAppScope(app: string, deployment: Deployment, requirementsFile: string): AppScope {
  if (app !== 'usdt0') throw new Error('Supported --app: usdt0');
  if (deployment.canonicalName !== 'canary-sponsored') throw new Error('USDT0 requires canary-sponsored');

  const requirements = JSON.parse(readFileSync(requirementsFile, 'utf8'));
  const chains = usdt0VerificationChains(requirements.usdt0.products);

  for (const [name, reason] of Object.entries(USDT0_EXCLUSIONS)) {
    console.log(`> USDT0 scope excludes ${name}: ${reason}`);
  }
  const missing = chains.filter((name) => !deployment.contractAddresses[name]);
  if (missing.length) console.warn(`! USDT0 addresses missing from inventory: ${missing.join(', ')}`);

  return { chains, exclusions: USDT0_EXCLUSIONS };
}

// ---------------------------------------------------------------------------
// scope resolution
// ---------------------------------------------------------------------------

/** One inventory entry becomes either a verifiable source or an unverified report entry. */
function classify(name: string, address: string, inputs: ScopeInputs): ResolvedSource | ChainResult {
  const info = resolveChain(inputs.metadata, name);
  if (!info) {
    const detail = 'No LayerZero V2 mainnet endpoint found; required destination cannot be checked';
    return setupError(name, null, address, 'metadata.resolve', detail);
  }
  if (NON_EVM_TYPES.has(info.chainType)) return skipped(name, address, 'non-EVM VM — not verified by this script');
  if (info.chainType !== 'evm') return setupError(name, info.eid, address, 'metadata.vm', `Unknown VM type: ${info.chainType}`);
  if (!isAddress(address)) return setupError(name, info.eid, address, 'contract.address', 'Invalid address for an EVM chain');

  const { rpcs, origin } = resolveRpcs(info, inputs.rpcOverrides[name], inputs.chainlist, inputs.maxRpcs);
  if (rpcs.length === 0) return setupError(name, info.eid, address, 'rpc.missing', 'No RPC URL; add one to rpc-overrides.json');

  return { info, address: getAddress(address), rpcs, rpcOrigin: origin };
}

/** With --app, the destinations are the application's chains, whether or not we have a DVN there. */
function appDestinations(app: AppScope, metadata: Metadata, unverified: ChainResult[]): Destination[] {
  const destinations: Destination[] = [];
  for (const name of app.chains) {
    const info = resolveChain(metadata, name);
    if (info) {
      destinations.push({ name, eid: info.eid });
      continue;
    }
    console.warn(`! USDT0 destination unresolved in metadata: ${name}`);
    if (!unverified.some((chain) => chain.name === name)) {
      unverified.push(setupError(name, null, '', 'metadata.resolve', 'Required USDT0 destination unresolved'));
    }
  }
  return destinations;
}

/** Without --app, the destinations are every inventory chain that has an endpoint id. */
function inventoryDestinations(scope: Scope, metadata: Metadata): Destination[] {
  const destinations = scope.sources.map(({ info }) => ({ name: info.name, eid: info.eid }));
  for (const chain of scope.unverified) {
    const info = resolveChain(metadata, chain.name);
    if (info) destinations.push({ name: chain.name, eid: info.eid });
  }
  return destinations;
}

export function resolveScope(inputs: ScopeInputs): Scope {
  const { deployment, metadata, app } = inputs;
  const scope: Scope = { sources: [], destinations: [], unverified: [] };

  for (const [name, reason] of Object.entries(app?.exclusions ?? {})) {
    scope.unverified.push(skipped(name, deployment.contractAddresses[name] ?? '', reason));
  }

  for (const [name, address] of Object.entries(deployment.contractAddresses)) {
    if (app && !app.chains.includes(name)) continue;
    const chain = classify(name, address, inputs);
    if ('rpcs' in chain) scope.sources.push(chain);
    else scope.unverified.push(chain);
  }

  scope.destinations = app ? appDestinations(app, metadata, scope.unverified) : inventoryDestinations(scope, metadata);

  for (const name of app?.chains ?? []) {
    const info = resolveChain(metadata, name);
    if (info?.chainType === 'evm' && !deployment.contractAddresses[name]) {
      const detail = 'Required EVM source missing from deployment inventory';
      scope.unverified.push(setupError(name, info.eid, '', 'coverage.missing', detail));
    }
  }

  if (scope.destinations.length < 2) throw new Error('No cross-chain destination coverage available');
  if (new Set(scope.destinations.map((d) => d.eid)).size !== scope.destinations.length) {
    throw new Error('Duplicate endpoint IDs in destination scope');
  }
  return scope;
}

// ---------------------------------------------------------------------------
// source selection: --rerun and --chains
// ---------------------------------------------------------------------------

const REPORT_STATUSES: ChainStatus[] = ['OK', 'FAIL', 'ERROR', 'SKIPPED'];

/** Chains that did not pass in a previous report, minus those this verifier can never verify as sources. */
export function chainsToRerun(reportFile: string, deploymentName: string, metadata: Metadata, app: AppScope | null): string[] {
  if (!existsSync(reportFile)) throw new Error(`--rerun: report not found: ${reportFile}`);
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));

  const chains: Array<{ name: string; status: ChainStatus }> = report.chains;
  const isCompatible =
    report.deployment === deploymentName &&
    Array.isArray(chains) &&
    chains.length > 0 &&
    chains.every((chain) => typeof chain.name === 'string' && REPORT_STATUSES.includes(chain.status));
  if (!isCompatible) throw new Error('Invalid or incompatible rerun report');

  const isSkippedForGood = (name: string) =>
    NON_EVM_TYPES.has(resolveChain(metadata, name)?.chainType ?? '') || Object.hasOwn(app?.exclusions ?? {}, name);

  const failed = chains
    .filter((chain) => chain.status !== 'OK' && !(chain.status === 'SKIPPED' && isSkippedForGood(chain.name)))
    .map((chain) => chain.name);
  if (failed.length === 0) throw new Error('No chains selected for rerun; no fresh verification performed');
  return failed;
}

/**
 * Narrow the run to the requested source chains. A requested chain that cannot be
 * verified is reported as an error rather than silently dropped.
 * Pass `wanted = null` to select everything.
 */
export function selectSources(scope: Scope, wanted: string[] | null): { selected: ResolvedSource[]; unverified: ChainResult[] } {
  const selected = wanted ? scope.sources.filter((source) => wanted.includes(source.info.name)) : scope.sources;
  if (!selected.length) throw new Error('No verifiable EVM source chains selected; no verification performed');
  if (!wanted) return { selected, unverified: scope.unverified };

  const unverified = [...scope.unverified];
  for (const name of wanted) {
    if (scope.sources.some((source) => source.info.name === name)) continue;
    const existing = unverified.find((chain) => chain.name === name);
    if (existing) {
      const detail = 'Explicitly requested source cannot be verified by the EVM verifier';
      existing.status = 'ERROR';
      existing.findings.push({ check: 'scope.requested', severity: 'ERROR', detail });
    } else {
      const detail = 'Requested source missing or outside selected application scope';
      unverified.push(setupError(name, null, '', 'scope.requested', detail));
    }
  }

  // Setup errors of chains nobody asked for are left out; chains without an endpoint id
  // (skipped or unresolved) are always listed so the report shows the full scope.
  return { selected, unverified: unverified.filter((chain) => wanted.includes(chain.name) || chain.eid === null) };
}
