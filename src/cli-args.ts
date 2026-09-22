/** Command-line flags of the EVM verifier. All flag handling lives here; index.ts only sees CliOptions. */
import { resolve } from 'node:path';
import { fromRoot } from './paths.js';
import type { RpcOptions } from './rpc.js';

export interface CliOptions {
  // --- what to verify ---
  deployment: string;
  expected: string;
  /** application scope, e.g. "usdt0"; null = the whole deployment inventory */
  app: string | null;
  /** source chains to verify; null = all */
  chains: string[] | null;
  /** previous report.json whose unsuccessful chains should be verified again */
  rerun: string | null;
  /** take live getFee() quotes */
  quote: boolean;
  scanSigners: boolean;

  // --- where chain data and RPC endpoints come from ---
  rpcOverrides: string;
  metadataFile?: string;
  chainlistFile?: string;
  refreshMetadata: boolean;
  useChainlist: boolean;
  /** cap on automatically resolved endpoints per chain */
  maxRpcs: number;

  // --- how hard to push the RPCs ---
  rpc: RpcOptions;
  /** destination checks in parallel per chain */
  concurrency: number;
  /** source chains verified in parallel */
  chainConcurrency: number;

  // --- output ---
  outJson: string | null;
  outMd: string | null;
  /** 0 = summary, 1 = -v, 2 = -vv */
  verbose: number;
}

export const HELP = `
canary-dvn-verify — read-only audit of a LayerZero V2 DVN deployment

  npm install
  npm run verify -- [options]

Options
  --deployment <file>     deployment JSON            (default deployments/canary-sponsored.json)
  --expected <file>       expected on-chain state    (default expected.json)
  --rpc-overrides <file>  { "chain": "https://..." } (default rpc-overrides.json, optional)
  --metadata-file <file>  use a local copy of LayerZero metadata instead of fetching
  --refresh-metadata      ignore the 24h metadata cache
  --no-chainlist          don't append public RPCs from chainlist as failover
  --chainlist-file <file> use a local copy of chainlist's chains.json
  --max-rpcs <n>          endpoints tried per chain before giving up (default 5)
  --chains a,b,c          only verify these source chains
  --app usdt0             scope sources and destinations to USDT0 requirements
  --no-quote              skip live getFee() quotes (much faster, config checks only)
  --scan-signers          on a signer-count mismatch, replay UpdateSigner logs to name the extras
  --concurrency <n>       parallel calls per chain     (default 6)
  --chain-concurrency <n> chains verified in parallel  (default 6)
  --rpc-timeout <ms>      per-request timeout          (default 20000)
  --retries <n>           retries per call on transport errors (default 3)
  --delay-ms <n>          pause before every call, to stay under a rate limit
  --no-batch              one eth_call per HTTP request (some providers reject batches)
  --slow                  preset: --concurrency 1 --chain-concurrency 2 --delay-ms 150
                          --no-batch --retries 3, 30s timeout
  --rerun <report.json>   re-verify only the chains that didn't pass in that report
  --json <file|none>      JSON report path             (default report.json)
  --md <file|none>        Markdown report path         (default report.md)
  -v, --verbose           show every check that passed, per chain, plus what was read
  -vv                     as -v, plus the full per-destination pathway table

API keys in RPC URLs are redacted from all output, including report.json.

Exit code is 1 if any chain FAILs or ERRORs, 2 on a setup error, 0 otherwise.
`;

function defaults(): CliOptions {
  return {
    deployment: fromRoot('deployments/canary-sponsored.json'),
    expected: fromRoot('expected.json'),
    app: null,
    chains: null,
    rerun: null,
    quote: true,
    scanSigners: false,
    rpcOverrides: fromRoot('rpc-overrides.json'),
    refreshMetadata: false,
    useChainlist: true,
    maxRpcs: 5,
    rpc: { timeoutMs: 20_000, retries: 3, delayMs: 0, batch: true },
    concurrency: 6,
    chainConcurrency: 6,
    outJson: fromRoot('report.json'),
    outMd: fromRoot('report.md'),
    verbose: 0,
  };
}

/** One call at a time, two chains at a time, no batching, patient retries. */
function applySlowPreset(options: CliOptions): void {
  options.concurrency = 1;
  options.chainConcurrency = 2;
  options.rpc.batch = false;
  options.rpc.delayMs = Math.max(options.rpc.delayMs, 150);
  options.rpc.retries = Math.max(options.rpc.retries, 3);
  options.rpc.timeoutMs = Math.max(options.rpc.timeoutMs, 30_000);
}

function integer(flag: string, value: string, min: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) throw new Error(`${flag} must be an integer >= ${min}`);
  return parsed;
}

const outputPath = (value: string): string | null => (value === 'none' ? null : resolve(value));

/**
 * Flags apply left to right, so a later flag overrides an earlier one. The npm scripts
 * rely on this: they put --slow first and the user's flags after it.
 * Returns 'help' when help was requested.
 */
export function parseArgs(argv: string[]): CliOptions | 'help' {
  const options = defaults();

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = (): string => {
      const next = argv[++i];
      if (!next || next.startsWith('--')) throw new Error(`${flag} requires a value`);
      return next;
    };

    switch (flag) {
      case '--deployment': options.deployment = resolve(value()); break;
      case '--expected': options.expected = resolve(value()); break;
      case '--app': options.app = value(); break;
      case '--chains': options.chains = value().split(',').map((name) => name.trim()).filter(Boolean); break;
      case '--rerun': options.rerun = resolve(value()); break;
      case '--no-quote': options.quote = false; break;
      case '--scan-signers': options.scanSigners = true; break;

      case '--rpc-overrides': options.rpcOverrides = resolve(value()); break;
      case '--metadata-file': options.metadataFile = resolve(value()); break;
      case '--chainlist-file': options.chainlistFile = resolve(value()); break;
      case '--refresh-metadata': options.refreshMetadata = true; break;
      case '--no-chainlist': options.useChainlist = false; break;
      case '--max-rpcs': options.maxRpcs = integer(flag, value(), 1); break;

      case '--rpc-timeout': options.rpc.timeoutMs = integer(flag, value(), 1); break;
      case '--retries': options.rpc.retries = integer(flag, value(), 0); break;
      case '--delay-ms': options.rpc.delayMs = integer(flag, value(), 0); break;
      case '--no-batch': options.rpc.batch = false; break;
      case '--concurrency': options.concurrency = integer(flag, value(), 1); break;
      case '--chain-concurrency': options.chainConcurrency = integer(flag, value(), 1); break;
      case '--slow': applySlowPreset(options); break;

      case '--json': options.outJson = outputPath(value()); break;
      case '--md': options.outMd = outputPath(value()); break;
      case '-v':
      case '--verbose': options.verbose = Math.max(options.verbose, 1); break;
      case '-vv': options.verbose = 2; break;

      case '-h':
      case '--help': return 'help';
      default: throw new Error(`unknown argument: ${flag}\n\n${HELP}`);
    }
  }

  if (options.chains && !options.chains.length) throw new Error('--chains must select at least one chain');
  return options;
}
