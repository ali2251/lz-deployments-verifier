/**
 * Public RPC endpoints from the ethereum-lists/chains dataset (the data behind
 * chainlist.org), keyed by EVM chain id.
 *
 * Used as an automatic fallback layer beneath the LayerZero metadata RPCs, so a
 * chain whose metadata lists no endpoint — or a dead one — still gets tried
 * against whatever public infrastructure exists. Matching is by numeric chain id,
 * never by name, so there is no chance of resolving the wrong network.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readCache, writeCache } from './cache.js';

/** Built artifact of ethereum-lists/chains. chainid.network serves the same file. */
const SOURCES = [
  'https://raw.githubusercontent.com/ethereum-lists/chains/gh-pages/chains.json',
  'https://chainid.network/chains.json',
];
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Public endpoints kept per chain. They are tried in order, each costing a timeout. */
const RPCS_PER_CHAIN = 4;

/** EVM chain id -> public RPC URLs */
export type ChainlistIndex = Map<number, string[]>;

interface ChainlistEntry {
  chainId?: number;
  rpc?: unknown[];
}

interface LoadChainlistOptions {
  cachePath: string;
  /** read this local chains.json instead of downloading */
  file?: string;
  /** ignore a fresh cache and download again */
  refresh?: boolean;
}

function usableRpcs(entry: ChainlistEntry): string[] {
  const urls = (entry?.rpc ?? [])
    // ${INFURA_API_KEY} style placeholders and websocket endpoints are no use to us
    .filter((url): url is string => typeof url === 'string' && url.startsWith('http') && !url.includes('${'))
    .map((url) => url.replace(/\/+$/, ''));
  return [...new Set(urls)].slice(0, RPCS_PER_CHAIN);
}

async function download(): Promise<{ entries: ChainlistEntry[] | null; errors: string[] }> {
  const errors: string[] = [];
  for (const url of SOURCES) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (response.ok) return { entries: (await response.json()) as ChainlistEntry[], errors };
      errors.push(`${url}: HTTP ${response.status}`);
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { entries: null, errors };
}

/** Local file, else fresh cache, else download, else stale cache, else nothing (with a warning). */
async function loadEntries(options: LoadChainlistOptions): Promise<ChainlistEntry[]> {
  if (options.file) {
    if (!existsSync(options.file)) throw new Error(`--chainlist-file not found: ${options.file}`);
    return JSON.parse(readFileSync(options.file, 'utf8'));
  }

  const fresh = options.refresh ? null : readCache<ChainlistEntry[]>(options.cachePath, CACHE_TTL_MS);
  if (fresh) return fresh;

  const { entries, errors } = await download();
  if (entries) {
    writeCache(options.cachePath, entries);
    return entries;
  }

  const stale = readCache<ChainlistEntry[]>(options.cachePath);
  if (stale) {
    console.warn('! chainlist fetch failed — using stale cache');
    return stale;
  }
  console.warn(`! chainlist unavailable, continuing without it:\n    ${errors.join('\n    ')}`);
  return [];
}

export async function loadChainlist(options: LoadChainlistOptions): Promise<ChainlistIndex> {
  const index: ChainlistIndex = new Map();
  for (const entry of (await loadEntries(options)) ?? []) {
    const chainId = Number(entry?.chainId);
    if (!Number.isFinite(chainId)) continue;
    const rpcs = usableRpcs(entry);
    if (rpcs.length > 0) index.set(chainId, rpcs);
  }
  return index;
}
