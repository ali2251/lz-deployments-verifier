import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const METADATA_URL = 'https://metadata.layerzero-api.com/v1/metadata';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ChainInfo {
  /** canonical name as used in the deployment file, e.g. "arbitrum" */
  name: string;
  /** LayerZero V2 endpoint id, e.g. 30110 */
  eid: number;
  /** metadata key it resolved through, e.g. "arbitrum" */
  chainKey: string;
  chainType: string;
  nativeChainId: number | null;
  nativeCurrency: { symbol: string; decimals: number };
  rpcs: string[];
  explorer: string | null;
}

interface FetchOpts {
  cachePath: string;
  metadataFile?: string;
  refresh?: boolean;
}

export async function loadMetadata(opts: FetchOpts): Promise<Record<string, any>> {
  if (opts.metadataFile) {
    if (!existsSync(opts.metadataFile)) throw new Error(`--metadata-file not found: ${opts.metadataFile}`);
    return JSON.parse(readFileSync(opts.metadataFile, 'utf8'));
  }

  const fresh =
    !opts.refresh && existsSync(opts.cachePath) && Date.now() - statSync(opts.cachePath).mtimeMs < CACHE_TTL_MS;
  if (fresh) {
    try {
      return JSON.parse(readFileSync(opts.cachePath, 'utf8'));
    } catch {
      /* fall through to refetch */
    }
  }

  let res: Response;
  try {
    res = await fetch(METADATA_URL, { headers: { accept: 'application/json' } });
  } catch (err: any) {
    if (existsSync(opts.cachePath)) {
      console.warn(`! metadata fetch failed (${err?.message ?? err}) — falling back to stale cache`);
      return JSON.parse(readFileSync(opts.cachePath, 'utf8'));
    }
    throw new Error(
      `Could not reach ${METADATA_URL} (${err?.message ?? err}).\n` +
        `Download it on a machine with access and pass --metadata-file <path>.`,
    );
  }
  if (!res.ok) throw new Error(`metadata fetch failed: HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, any>;

  mkdirSync(dirname(opts.cachePath), { recursive: true });
  writeFileSync(opts.cachePath, JSON.stringify(json));
  return json;
}

/** Pick the LayerZero V2 mainnet deployment entry (the one carrying the 30xxx eid). */
function v2MainnetEid(entry: any): number | null {
  const deployments: any[] = entry?.deployments ?? [];
  const candidates = deployments.filter(
    (d) => Number(d?.version) === 2 && (d?.stage ?? entry?.chainDetails?.stage) !== 'testnet' && d?.eid,
  );
  for (const d of candidates) {
    const eid = Number(d.eid);
    if (Number.isFinite(eid) && eid >= 30000 && eid < 40000) return eid;
  }
  return null;
}

/**
 * Resolve a canonical deployment name ("arbitrum") to its metadata entry.
 * Metadata is keyed by chainKey; mainnet keys are usually the bare name, but we
 * also try the "-mainnet" suffix and a chainDetails.chainKey scan as fallbacks.
 */
export function resolveChain(metadata: Record<string, any>, name: string): ChainInfo | null {
  const tries = [name, `${name}-mainnet`];
  let key: string | null = null;
  let entry: any = null;

  for (const t of tries) {
    if (metadata[t]) {
      key = t;
      entry = metadata[t];
      break;
    }
  }

  if (!entry) {
    for (const [k, v] of Object.entries<any>(metadata)) {
      const ck = v?.chainDetails?.chainKey;
      const stage = v?.chainDetails?.stage ?? v?.environment;
      if (ck === name && stage !== 'testnet' && stage !== 'sandbox') {
        key = k;
        entry = v;
        break;
      }
    }
  }
  if (!entry || !key) return null;

  const eid = v2MainnetEid(entry);
  if (eid === null) return null;

  const cd = entry.chainDetails ?? {};
  const rpcs: string[] = (entry.rpcs ?? [])
    .map((r: any) => (typeof r === 'string' ? r : r?.url))
    .filter((u: any) => typeof u === 'string' && u.startsWith('http'));

  return {
    name,
    eid,
    chainKey: key,
    chainType: cd.chainType ?? 'unknown',
    nativeChainId: cd.nativeChainId === undefined ? null : Number(cd.nativeChainId),
    nativeCurrency: {
      symbol: cd.nativeCurrency?.symbol ?? '?',
      decimals: Number(cd.nativeCurrency?.decimals ?? 18),
    },
    rpcs,
    explorer: entry.blockExplorers?.[0]?.url ?? null,
  };
}

/**
 * rpc-overrides.json: { "<chain>": "https://..." } or { "<chain>": ["url1", "url2", "@auto"] }
 *
 * Two substitutions are applied:
 *   ${ENV_VAR}  -> process.env.ENV_VAR, so a key need never be written to disk
 *   @auto       -> expanded later to the metadata + chainlist endpoints for that chain
 */
export function loadRpcOverrides(path: string): Record<string, string[]> {
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const out: Record<string, string[]> = {};
  const missingEnv = new Set<string>();
  const placeholders = new Set<string>();

  const substitute = (url: string): string | null => {
    if (url === AUTO_RPC) return url;
    const resolved = url.replace(/\$\{([A-Z0-9_]+)\}/gi, (_m, name: string) => {
      const value = process.env[name];
      if (!value) {
        missingEnv.add(name);
        return `\${${name}}`;
      }
      return value;
    });
    if (resolved.includes('${')) return null;
    // tolerate pasting the full key (which already starts with alch_) into the alch_ slot
    const deduped = resolved.replace(/\/v2\/alch_alch_/, '/v2/alch_');
    if (/YOUR_KEY_HERE|YOUR_ALCHEMY_KEY|<API_KEY>|YOUR_KEY\b/i.test(deduped)) {
      placeholders.add(deduped.replace(/^(https?:\/\/[^/]+).*$/, '$1'));
      return null;
    }
    return deduped;
  };

  for (const [k, v] of Object.entries<any>(raw)) {
    if (k.startsWith('$')) continue;
    const list = (Array.isArray(v) ? v : [v]).map(substitute).filter((u): u is string => u !== null);
    if (list.length > 0) out[k] = list;
  }

  if (missingEnv.size > 0) {
    console.warn(`! rpc-overrides: unset env var(s) ${[...missingEnv].join(', ')} — those endpoints were dropped`);
  }
  if (placeholders.size > 0) {
    console.warn(
      `! rpc-overrides: ${placeholders.size} endpoint(s) still contain a placeholder key and were dropped.\n` +
        `  Replace YOUR_KEY_HERE with your Alchemy key (or set ALCHEMY_KEY in the environment).`,
    );
  }
  return out;
}

/** Sentinel in an override list meaning "and then whatever resolves automatically". */
export const AUTO_RPC = '@auto';
