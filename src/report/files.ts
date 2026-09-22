/** The report files: report.md for people, report.json for tooling and --rerun. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Expected } from '../config.js';
import type { ChainResult, Finding } from '../types.js';
import { byName, isConfigOnly, isNotable, median, pathwayStats, totals, usd } from './summary.js';

export function writeReport(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function chainTableRow(result: ChainResult): string {
  if (result.status === 'SKIPPED') {
    return `| skip | ${result.name} | - | \`${result.address}\` | - | - | - | - | ${result.skipReason ?? ''} |`;
  }
  let status = result.status.toLowerCase();
  if (result.status === 'OK') status = isConfigOnly(result) ? 'config only' : 'pass';

  const stats = pathwayStats(result);
  const cells = [
    status,
    result.name,
    result.eid ?? '?',
    `\`${result.address}\``,
    result.worker?.quorum ?? '?',
    result.worker?.signerSize ?? '?',
    `${stats.configured}/${stats.total}`,
    stats.nonZeroFloor,
    usd(median(stats.feesUsd)),
  ];
  return `| ${cells.join(' | ')} |`;
}

function findingLine(finding: Finding): string {
  return (
    `- **${finding.severity}** \`${finding.check}\`${finding.dst ? ` → ${finding.dst}` : ''}` +
    (finding.expected !== undefined ? ` — expected \`${finding.expected}\`` : '') +
    (finding.actual !== undefined ? `, got \`${finding.actual}\`` : '') +
    (finding.detail ? ` _(${finding.detail})_` : '')
  );
}

export function toMarkdown(results: ChainResult[], expected: Expected): string {
  const t = totals(results);
  const lines = [
    `# Canary DVN verification — \`${expected.deployment}\``,
    '',
    `Generated ${new Date().toISOString()}`,
    ...(results.some(isConfigOnly) ? ['Configuration-only results exclude live fee verification.'] : []),
    '',
    `**${t.ok} pass · ${t.fail} fail · ${t.error} error · ${t.skipped} skipped** — ` +
      `${t.pathwaysConfigured}/${t.pathways} pathways configured, ${t.failFindings} failing check(s).`,
    '',
    '## Expected',
    '',
    `- Quorum: \`${expected.quorum}\` of ${expected.signers.length} signer(s)`,
    ...expected.signers.map((signer) => `- Signer: \`${signer}\``),
    `- floorMarginUSD: \`${expected.dst.default.floorMarginUSD ?? 'not asserted'}\` (sponsored = gas only)`,
    '',
    '## Chains',
    '',
    '| status | chain | eid | DVN | quorum | signers | dst configured | non-zero floor | median fee |',
    '|---|---|---|---|---|---|---|---|---|',
    ...byName(results).map(chainTableRow),
  ];

  const withFindings = results.filter((r) => r.findings.some(isNotable));
  if (withFindings.length > 0) {
    lines.push('', '## Findings');
    for (const result of withFindings) {
      lines.push('', `### ${result.name}`, '', ...result.findings.filter(isNotable).map(findingLine));
    }
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export function toJson(results: ChainResult[], expected: Expected): string {
  const report = {
    deployment: expected.deployment,
    generatedAt: new Date().toISOString(),
    expected: {
      signers: expected.signers,
      quorum: expected.quorum,
      worker: expected.worker,
      quote: expected.quote,
      usdDenominator: expected.usdDenominator,
      dstOverrides: expected.dst.overrides,
      dstDefault: expected.dst.default,
    },
    totals: totals(results),
    chains: results,
  };
  // bigints (wei amounts, floors, quorum) become decimal strings
  return JSON.stringify(report, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2);
}
