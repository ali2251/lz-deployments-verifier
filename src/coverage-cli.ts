#!/usr/bin/env tsx
/** `npm run coverage` — compares application chain requirements with the local deployment inventories. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadDeployment } from './config.js';
import { coverage, type ApplicationRequirements, type CoverageRow, type Tier } from './coverage.js';
import { fromRoot } from './paths.js';

const HELP = `Check application requirements against the local Canary deployment inventory.

  npm run coverage -- usdt0
  npm run coverage -- ethena
  npm run coverage -- ondo
  npm run coverage -- ondo --tier subsidized --product usdy
  npm run coverage -- all --json coverage-report.json --md coverage-report.md

Options: --app <name|all>, --tier <sponsored|subsidized|both>, --product <name>,
         --requirements <file>, --json <file>, --md <file>, --help
Ondo defaults to separate comparisons for both tiers; fixed-tier apps use their assigned tier.
LISTED means a nonempty, nonzero address exists in the deployment JSON, not on-chain verification.
Exit: 0 all selected comparisons covered, 1 missing entries, 2 invalid input.`;

type TierSelection = Tier | 'both';

interface CoverageOptions {
  /** application name, or "all" */
  app: string;
  /** undefined = each application's own tier */
  tier?: TierSelection;
  product?: string;
  requirementsFile: string;
  outJson?: string;
  outMd?: string;
}

/** One application compared against one tier's inventory. */
interface Comparison {
  application: string;
  tier: Tier;
  source: string;
  required: number;
  listed: number;
  missing: string[];
  rows: CoverageRow[];
}

function parseArgs(argv: string[]): CoverageOptions | 'help' {
  const options: Partial<CoverageOptions> = {};

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = (): string => {
      const next = argv[++i];
      if (!next || next.startsWith('--')) throw new Error(`${flag} requires a value`);
      return next;
    };

    switch (flag) {
      case '--app': options.app = value().toLowerCase(); break;
      case '--tier': {
        const tier = value();
        if (tier !== 'sponsored' && tier !== 'subsidized' && tier !== 'both') throw new Error(`Unknown tier: ${tier}`);
        options.tier = tier;
        break;
      }
      case '--product': options.product = value().toLowerCase(); break;
      case '--requirements': options.requirementsFile = resolve(value()); break;
      case '--json': options.outJson = resolve(value()); break;
      case '--md': options.outMd = resolve(value()); break;
      case '-h':
      case '--help': return 'help';
      default:
        // the application may also be given as the one positional argument
        if (flag.startsWith('-') || options.app) throw new Error(`Unexpected argument: ${flag}`);
        options.app = flag.toLowerCase();
    }
  }

  if (!options.app) throw new Error(HELP);
  return {
    ...options,
    app: options.app,
    requirementsFile: options.requirementsFile ?? fromRoot('applications/requirements.json'),
  };
}

function assertValidRequirements(name: string, requirements: ApplicationRequirements): void {
  const isChainList = (chains: unknown) => Array.isArray(chains) && chains.every((chain) => typeof chain === 'string');
  const valid =
    ['sponsored', 'subsidized', 'either'].includes(requirements.tier) &&
    requirements.products &&
    Object.values(requirements.products).every(isChainList);
  if (!valid) throw new Error(`Invalid requirements for ${name}`);
}

function compare(options: CoverageOptions): Comparison[] {
  const allRequirements: Record<string, ApplicationRequirements> = JSON.parse(readFileSync(options.requirementsFile, 'utf8'));
  if (options.app !== 'all' && !Object.hasOwn(allRequirements, options.app)) {
    throw new Error(`Unknown application: ${options.app}`);
  }
  const applications = options.app === 'all' ? Object.keys(allRequirements) : [options.app];

  const deployments = {
    sponsored: loadDeployment(fromRoot('deployments/canary-sponsored.json')),
    subsidized: loadDeployment(fromRoot('deployments/canary-subsidized.json')),
  };

  return applications.flatMap((application) => {
    const requirements = allRequirements[application]!;
    assertValidRequirements(application, requirements);

    const selection: TierSelection = options.tier ?? (requirements.tier === 'either' ? 'both' : requirements.tier);
    const tiers: Tier[] = selection === 'both' ? ['sponsored', 'subsidized'] : [selection];

    return tiers.map((tier): Comparison => {
      const rows = coverage(requirements, tier, deployments, options.product);
      return {
        application,
        tier,
        source: requirements.source,
        required: rows.length,
        listed: rows.filter((row) => row.status === 'LISTED').length,
        missing: rows.filter((row) => row.status === 'MISSING').map((row) => row.chain),
        rows,
      };
    });
  });
}

function toMarkdown(comparisons: Comparison[]): string {
  const lines = [
    '# Application deployment coverage',
    '',
    'Compared with local deployment JSON files. LISTED is inventory coverage only; bytecode, signer, floor, pathway configuration and application DVN selection are not checked.',
    '',
  ];
  for (const comparison of comparisons) {
    lines.push(
      `## ${comparison.application} — ${comparison.tier}`,
      '',
      `${comparison.listed}/${comparison.required} listed. Missing: ${comparison.missing.join(', ') || 'none'}.`,
      '',
      `Requirements: ${comparison.source}`,
      '',
      '| Chain | Deployment key | Products | Status | Address | Listed in other tier |',
      '|---|---|---|---|---|---|',
    );
    for (const row of comparison.rows) {
      const listedInOtherTier = row.otherTierAddress ? 'yes' : 'no';
      const cells = [row.chain, row.key, row.products.join(', '), row.status, row.address ?? '—', listedInOtherTier];
      lines.push(`| ${cells.join(' | ')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content + '\n');
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  if (options === 'help') {
    console.log(HELP);
    return 0;
  }

  const comparisons = compare(options);
  const markdown = toMarkdown(comparisons);
  console.log(markdown);

  if (options.outMd) writeFile(options.outMd, markdown);
  if (options.outJson) {
    const report = { generatedAt: new Date().toISOString(), scope: 'local deployment inventory', comparisons };
    writeFile(options.outJson, JSON.stringify(report, null, 2));
  }
  return comparisons.some((comparison) => comparison.missing.length > 0) ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
}
