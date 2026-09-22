/** LayerZero's chain metadata: download/cache it, and resolve a deployment chain name to its endpoint. */
import { existsSync, readFileSync } from 'node:fs';
import { readCache, writeCache } from './cache.js';

const METADATA_URL = 'https://metadata.layerzero-api.com/v1/metadata';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** The parts of a LayerZero metadata entry this tool reads. */
interface MetadataEntry {
  chainDetails?: {
    chainKey?: string;
    chainType?: string;
    stage?: string;
    nativeChainId?: number | string;
    nativeCurrency?: { symbol?: string; decimals?: number | string };
  };
  environment?: string;
  deployments?: Array<{ version?: number | string; stage?: string; eid?: number | string }>;
  rpcs?: Array<string | { url?: string }>;
  blockExplorers?: Array<{ url?: string }>;
  /** DVN address -> provider info */
  dvns?: Record<string, { id?: string; deprecated?: boolean }>;
}

/** Keyed by chainKey, e.g. "arbitrum" or "arbitrum-mainnet". */
export type Metadata = Record<string, MetadataEntry>;

export interface ChainInfo {
  /** canonical name as used in the deployment file, e.g. "arbitrum" */
  name: string;
  /** LayerZero V2 endpoint id, e.g. 30110 */
  eid: number;
  /** metadata key it resolved through, e.g. "arbitrum" */
  chainKey: string;
  /** "evm", "solana", ... or "unknown" */
  chainType: string;
  nativeChainId: number | null;
  nativeCurrency: { symbol: string; decimals: number };
  rpcs: string[];
  explorer: string | null;
}

interface LoadMetadataOptions {
  cachePath: string;
  /** read this local copy instead of downloading */
  metadataFile?: string;
  /** ignore a fresh cache and download again */
  refresh?: boolean;
}

export async function loadMetadata(options: LoadMetadataOptions): Promise<Metadata> {
  if (options.metadataFile) {
    if (!existsSync(options.metadataFile)) throw new Error(`--metadata-file not found: ${options.metadataFile}`);
    return JSON.parse(readFileSync(options.metadataFile, 'utf8'));
  }

  const fresh = options.refresh ? null : readCache<Metadata>(options.cachePath, CACHE_TTL_MS);
  if (fresh) return fresh;

  let response: Response;
  try {
    response = await fetch(METADATA_URL, { headers: { accept: 'application/json' } });
  } catch (err) {
    const reason = err instanceof Error ? err.message : err;
    const stale = readCache<Metadata>(options.cachePath);
    if (stale) {
      console.warn(`! metadata fetch failed (${reason}) — falling back to stale cache`);
      return stale;
    }
    throw new Error(
      `Could not reach ${METADATA_URL} (${reason}).\n` +
        'Download it on a machine with access and pass --metadata-file <path>.',
    );
  }
  if (!response.ok) throw new Error(`metadata fetch failed: HTTP ${response.status}`);

  const metadata = (await response.json()) as Metadata;
  writeCache(options.cachePath, metadata);
  return metadata;
}

/** Deployment inventories still use the historical Linea name. */
const CHAIN_ALIASES: Record<string, string> = { zkconsensys: 'linea' };

/**
 * Find the metadata entry for a deployment name ("arbitrum").
 * Metadata is keyed by chainKey; mainnet keys are usually the bare name, but we
 * also try the "-mainnet" suffix and a chainDetails.chainKey scan as fallbacks.
 */
function findEntry(metadata: Metadata, name: string): { key: string; entry: MetadataEntry } | null {
  const alias = CHAIN_ALIASES[name];
  const candidates = [name, `${name}-mainnet`, ...(alias ? [alias, `${alias}-mainnet`] : [])];
  for (const key of candidates) {
    const entry = metadata[key];
    if (entry) return { key, entry };
  }

  for (const [key, entry] of Object.entries(metadata)) {
    const stage = entry?.chainDetails?.stage ?? entry?.environment;
    const isMainnet = stage !== 'testnet' && stage !== 'sandbox';
    if (entry?.chainDetails?.chainKey === name && isMainnet) return { key, entry };
  }
  return null;
}

/** The entry's LayerZero V2 mainnet endpoint id (the 30xxx one), if it has one. */
function v2MainnetEid(entry: MetadataEntry): number | null {
  for (const deployment of entry.deployments ?? []) {
    const stage = deployment?.stage ?? entry.chainDetails?.stage;
    if (Number(deployment?.version) !== 2 || stage === 'testnet') continue;
    const eid = Number(deployment.eid);
    if (Number.isSafeInteger(eid) && eid >= 30000 && eid < 40000) return eid;
  }
  return null;
}

/** Resolve a deployment chain name to its LayerZero V2 mainnet endpoint, or null if it has none. */
export function resolveChain(metadata: Metadata, name: string): ChainInfo | null {
  const found = findEntry(metadata, name);
  if (!found) return null;
  const eid = v2MainnetEid(found.entry);
  if (eid === null) return null;

  const { entry } = found;
  const details = entry.chainDetails ?? {};
  const rpcs = (entry.rpcs ?? [])
    .map((rpc) => (typeof rpc === 'string' ? rpc : rpc?.url))
    .filter((url): url is string => typeof url === 'string' && url.startsWith('http'));

  return {
    name,
    eid,
    chainKey: found.key,
    chainType: details.chainType ?? 'unknown',
    nativeChainId: details.nativeChainId === undefined ? null : Number(details.nativeChainId),
    nativeCurrency: {
      symbol: details.nativeCurrency?.symbol ?? '?',
      decimals: Number(details.nativeCurrency?.decimals ?? 18),
    },
    rpcs,
    explorer: entry.blockExplorers?.[0]?.url ?? null,
  };
}
