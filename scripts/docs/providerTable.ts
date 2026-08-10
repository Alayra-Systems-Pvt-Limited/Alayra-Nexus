/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Alayra Nexus™ is a trademark of Alayra Systems. Use of the name or logo
 * is not granted by the software license below.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF
 * ANY KIND, either express or implied. See the License for details.
 */

// ── The README's provider table, generated ────────────────────────────────────────────────────
//
//   npm run docs:providers           rewrite the table in README.md
//   npm run docs:providers -- --check exit 1 if it is out of date (CI)
//
// ── Why this exists ───────────────────────────────────────────────────────────────────────────
//
// The table said six providers were verified because someone typed six ticks. That claim is the
// most load-bearing sentence in the README — it is the thing a reader decides on — and it was the
// one thing in the repository with no mechanism behind it. `npm run verify:providers` measures
// providers and commits dated evidence; nothing connected that evidence to what the public reads.
// So the day a provider stopped serving, the harness would say so, the evidence file would record
// it, and the README would go on claiming a tick indefinitely.
//
// ── The two sources, and which is authoritative for what ──────────────────────────────────────
//
//   src/data/providers.ts        what Nexus SHIPS  — label, base URL, whether the provider is
//                                claimed to publish prices. Facts about our own code.
//   docs/provider-verification/  what was MEASURED — whether a real completion came back, on what
//                                date, against a live key. Facts about the world.
//
// Neither alone is enough: the evidence does not know a base URL is account-scoped, and the
// presets cannot know that Cerebras started charging. The table is the join, and no cell in it is
// written by a human.
//
// ── Newest evidence per provider, not the newest file ─────────────────────────────────────────
//
// The obvious implementation reads the most recent JSON. It is wrong, and wrong in the direction
// that destroys the claim: a run only measures providers whose key is in that machine's .env, so
// the newest file is the newest run, not the newest knowledge. A maintainer holding four of the
// nine keys would regenerate the table into demoting five providers they never probed.
//
// So evidence is selected per provider — the most recent run in which THAT provider was actually
// measured — and each row carries the date it was measured. A row that has quietly not been
// re-checked for a year says so in public, which is the whole point.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PROVIDER_PRESETS, type ProviderPreset } from '../../src/data/providers';
import type { Result } from '../verify-providers';

const ROOT     = resolve(__dirname, '..', '..');
const README   = resolve(ROOT, 'README.md');
const EVIDENCE = resolve(ROOT, 'docs', 'provider-verification');

export const BEGIN = '<!-- BEGIN GENERATED PROVIDER TABLE — npm run docs:providers -->';
export const END   = '<!-- END GENERATED PROVIDER TABLE -->';

/** One committed evidence file. Mirrors what verify-providers.ts writes. */
export interface EvidenceFile {
  generatedAt: string;
  results: Result[];
}

/** The measurement a row is built from, plus when it was taken. */
export interface Measurement {
  result: Result;
  /** ISO date only. What the row publishes, so staleness is visible rather than inferred. */
  date: string;
}

/**
 * The most recent run in which each provider was actually measured.
 *
 * `skipped` is not a measurement — it is the record of a machine that had no key for this provider
 * — so it never displaces an older run that did probe it. Without that rule a colleague running the
 * harness with two keys would silently retract seven verifications.
 */
export function newestPerProvider(files: EvidenceFile[]): Map<string, Measurement> {
  const best = new Map<string, Measurement>();
  // Oldest first, so a later file simply overwrites — one rule instead of a comparison per entry.
  const ordered = [...files].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  for (const file of ordered) {
    for (const result of file.results) {
      if (result.status === 'skipped') continue;
      best.set(result.slug, { result, date: file.generatedAt.slice(0, 10) });
    }
  }
  return best;
}

const VERIFIED_CELL: Record<Result['status'], string> = {
  chat:        '✅ Completion',
  models:      '⚠️ Model list only',
  unreachable: '❌ Did not answer',
  // Unreachable in practice — newestPerProvider drops skipped entries, because a machine without
  // that provider's key measured nothing. Mapped anyway so this table is total and no cast is
  // needed to index it.
  skipped:     '⚪ Preset only',
};

/** `https://api.groq.com/openai/v1` → `api.groq.com/openai/v1`, placeholders left intact. */
function endpointCell(preset: ProviderPreset): string {
  if (!preset.baseUrl) return 'whatever you point it at';
  return `\`${preset.baseUrl.replace(/^https?:\/\//, '')}\``;
}

function verifiedCell(preset: ProviderPreset, m: Measurement | undefined): string {
  if (!preset.baseUrl) return '⚪ You configure it';
  if (!m) return '⚪ Preset only';
  const cell = `${VERIFIED_CELL[m.result.status]} · ${m.date}`;
  // Only when something less than a completion came back — a verified row has nothing to explain.
  return m.result.status !== 'chat' && preset.verifyNote ? `${cell} — ${preset.verifyNote}` : cell;
}

/**
 * Measured pricing beats claimed pricing.
 *
 * `publishesPricing` in the presets is an assertion about a provider's list response; the evidence
 * is that same question answered by the provider on a given day. When they disagree the world wins
 * — and the harness has already exited non-zero telling someone to fix the preset.
 */
function pricingCell(preset: ProviderPreset, m: Measurement | undefined): string {
  if (!preset.baseUrl) return 'Depends on the endpoint';
  const publishes = m?.result.pricingPublished ?? preset.publishesPricing;
  const base = publishes ? '✅ Yes, per model' : '❌ Set prices yourself';
  return preset.billingNote ? `${base} — ${preset.billingNote}` : base;
}

/**
 * Reachable through a Custom pool, with no preset of their own.
 *
 * Editorial rather than measured, and deliberately inside the generated block: a hand-maintained
 * row sitting immediately under a generated table is a row that gets orphaned by the first edit
 * that changes the table's shape.
 */
const VIA_CUSTOM = '| Azure OpenAI · Bedrock · Vertex | ⚪ Via **Custom** | your endpoint | '
  + 'Reachable today through a Custom pool if the endpoint speaks OpenAI\'s schema; first-class '
  + 'presets are on the [roadmap](#roadmap) |';

/**
 * The block between the markers. Pure — no filesystem — so the interesting cases can be tested
 * without committing an evidence file for each of them.
 */
export function renderTable(presets: ProviderPreset[], measured: Map<string, Measurement>): string {
  // Verified first, then models-only, then failed, then never-measured: the reader's question is
  // "what works", and answering it should not take reading ten rows. Within a group, providers that
  // publish prices come first — those are the ones Nexus can cost without the operator doing
  // anything, which is a mechanical fact about capability, not an opinion about vendors. Preset
  // order breaks any remaining tie, so the sort is stable and reviewable.
  const rank = (p: ProviderPreset) => {
    if (!p.baseUrl) return 4;
    const s = measured.get(p.slug)?.result.status;
    return s === 'chat' ? 0 : s === 'models' ? 1 : s === 'unreachable' ? 2 : 3;
  };
  const publishes = (p: ProviderPreset) =>
    measured.get(p.slug)?.result.pricingPublished ?? p.publishesPricing;
  const rows = [...presets]
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p)
      || Number(publishes(b.p)) - Number(publishes(a.p))
      || a.i - b.i)
    .map(({ p }) => {
      const m = measured.get(p.slug);
      return `| **${p.label}** | ${verifiedCell(p, m)} | ${endpointCell(p)} | ${pricingCell(p, m)} |`;
    });

  const chatVerified = presets.filter((p) => measured.get(p.slug)?.result.status === 'chat');
  const priced = presets.filter(publishes);
  // One date when every row was measured on the same day; a range once they diverge. A range is the
  // honest form as soon as rows age at different speeds, which is what per-provider evidence causes.
  const dates = [...measured.values()].map((m) => m.date).sort();
  const when = !dates.length ? ''
    : dates[0] === dates[dates.length - 1] ? ` — measured ${dates[0]}`
    : ` — measured between ${dates[0]} and ${dates[dates.length - 1]}`;

  return [
    BEGIN,
    '',
    `**${chatVerified.length} providers have served a real completion through these presets**${when}.`,
    '',
    '| Provider | Verified | Endpoint | Publishes prices? |',
    '|---|---|---|---|',
    ...rows,
    VIA_CUSTOM,
    '',
    '<sub>**Verified** is measured, never asserted. ✅ Completion means `npm run verify:providers` '
      + 'listed that provider\'s models, sent a real request against a live key and got usage back, '
      + 'on the date shown. ⚪ Preset only means never probed — an absence of evidence, not a claim '
      + 'that it is broken. The dated evidence is committed under '
      + '[`docs/provider-verification/`](docs/provider-verification/), and this table is generated '
      + 'from it by `npm run docs:providers`. Editing it by hand is undone by the next run, and CI '
      + 'fails if it drifts.</sub>',
    '',
    `<sub>**Publishes prices** decides whether Nexus can cost a request without you. Only `
      + `${priced.map((p) => `**${p.label}**`).join(' and ')} return per-model prices in their own `
      + 'API; everywhere else a model arrives with no price, which Nexus flags rather than assuming '
      + 'zero — on the model row, when you add the pool, and on the Analytics page.</sub>',
    '',
    END,
  ].join('\n');
}

/** Every committed evidence file, newest last. */
export function readEvidence(dir = EVIDENCE): EvidenceFile[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  return files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as EvidenceFile);
}

/**
 * Fail when the shipped table has been edited since it was last measured.
 *
 * `claimed` is what src/data/providers.ts said at measurement time. If it no longer matches, someone
 * has promoted or demoted a provider by hand — exactly the move this whole chain exists to prevent,
 * and one that would otherwise be laundered into the README by this generator.
 */
export function claimMismatches(presets: ProviderPreset[], measured: Map<string, Measurement>): string[] {
  return presets.flatMap((p) => {
    const m = measured.get(p.slug);
    if (!m || m.result.claimed === p.verified) return [];
    return [`${p.slug}: src/data/providers.ts says verified: ${JSON.stringify(p.verified)}, but the `
      + `${m.date} measurement was taken against ${JSON.stringify(m.result.claimed)}`];
  });
}

/** Splice a rendered block between the markers. Throws rather than appending — a README missing its
 *  markers is a README somebody restructured, and guessing where the table goes would be worse. */
export function splice(readme: string, block: string): string {
  const start = readme.indexOf(BEGIN);
  const end   = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md is missing the generated-table markers:\n  ${BEGIN}\n  ${END}`);
  }
  return readme.slice(0, start) + block + readme.slice(end + END.length);
}

const sameIgnoringLineEndings = (a: string, b: string): boolean =>
  a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

function main(): void {
  const check = process.argv.includes('--check');

  const files = readEvidence();
  if (!files.length) {
    console.error(`No evidence in ${EVIDENCE}. Run \`npm run verify:providers\` first.`);
    process.exit(1);
  }

  const measured  = newestPerProvider(files);
  const mismatches = claimMismatches(PROVIDER_PRESETS, measured);
  if (mismatches.length) {
    console.error('src/data/providers.ts has been edited since these providers were measured:\n');
    for (const m of mismatches) console.error(`  ${m}`);
    console.error('\nRe-run `npm run verify:providers` so the claim rests on a measurement.');
    process.exit(1);
  }

  const current  = readFileSync(README, 'utf8');
  const expected = splice(current, renderTable(PROVIDER_PRESETS, measured));

  if (check) {
    if (!sameIgnoringLineEndings(current, expected)) {
      console.error('The provider table in README.md is out of date with docs/provider-verification/.');
      console.error('Run `npm run docs:providers` and commit the result.');
      process.exit(1);
    }
    console.log('README.md provider table matches the committed evidence.');
    return;
  }

  writeFileSync(README, expected);
  console.log(`Wrote the provider table into ${README}`);
}

if (require.main === module) main();
