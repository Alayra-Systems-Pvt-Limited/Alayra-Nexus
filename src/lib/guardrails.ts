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

// ── Guardrails / safety hooks ─────────────────────────────────────────────────
// Optional, pluggable content filtering for prompts and responses. Off by default
// — an enterprise checkbox, not a forced tax. Operators bring their own rules (a
// regex ruleset here, or a moderation-model call-out layered on the same
// interface); Nexus hard-codes no policy. Input-side filtering rides the Phase 2
// admission path (inspect/redact/reject before forwarding); output-side filtering
// is applied to non-streaming responses, or to streams only in explicit
// buffered-safe mode (see completionsProxy) so the zero-buffer streaming path is
// never silently broken.

export type GuardrailAction   = 'block' | 'redact';
export type GuardrailDirection = 'input' | 'output' | 'both';

export interface GuardrailRule {
  /** Human-readable identifier, surfaced when a rule fires. */
  name:        string;
  /** Regex source (matched case-insensitively unless `flags` override). */
  pattern:     string;
  flags?:      string;
  /** `block` rejects the whole request/response; `redact` masks the match. */
  action:      GuardrailAction;
  /** Which side(s) the rule applies to. Defaults to `both`. */
  appliesTo?:  GuardrailDirection;
  /** Replacement text for a redact rule. Defaults to `[REDACTED]`. */
  replacement?: string;
}

export interface CompiledRule extends GuardrailRule {
  regex: RegExp;
}

export interface TextVerdict {
  decision: 'allow' | 'block' | 'redact';
  text:     string;         // redacted text (unchanged when allow/block)
  matched:  string[];       // names of rules that fired
}

// Upper bound on characters scanned per field, so a pathological rule or a huge
// prompt cannot turn filtering into a denial of service on the request path.
export const MAX_SCAN_CHARS = 100_000;
const DEFAULT_REPLACEMENT   = '[REDACTED]';

/**
 * Ready-made rules operators can opt into by name. Deliberately conservative —
 * they are examples/starting points, and none is active unless the operator adds
 * it to their configuration.
 */
export const PRESET_RULES: Record<string, GuardrailRule> = {
  email:       { name: 'email',       pattern: '[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}', action: 'redact', appliesTo: 'both', replacement: '[REDACTED_EMAIL]' },
  'us-phone':  { name: 'us-phone',    pattern: '\\b(?:\\+?1[ .-]?)?\\(?\\d{3}\\)?[ .-]?\\d{3}[ .-]?\\d{4}\\b', action: 'redact', appliesTo: 'both', replacement: '[REDACTED_PHONE]' },
  'credit-card': { name: 'credit-card', pattern: '\\b(?:\\d[ -]?){13,16}\\b', action: 'redact', appliesTo: 'both', replacement: '[REDACTED_CARD]' },
  ssn:         { name: 'ssn',         pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b', action: 'redact', appliesTo: 'both', replacement: '[REDACTED_SSN]' },
  'api-key':   { name: 'api-key',     pattern: '\\b(?:sk|pk|rk)-[a-z0-9]{16,}\\b', action: 'redact', appliesTo: 'input', replacement: '[REDACTED_KEY]' },
  'prompt-injection': { name: 'prompt-injection', pattern: 'ignore (?:all |the |your )?(?:previous|prior|above) (?:instructions|prompts?)', action: 'block', appliesTo: 'input' },
};

/**
 * Longest pattern we will compile. Real rules are short; a very long one is either a mistake or an
 * attempt to build something expensive out of alternation.
 */
export const MAX_PATTERN_CHARS = 1_000;

/**
 * Reject patterns that can backtrack catastrophically, before they ever reach `new RegExp`.
 *
 * ── Why a rule's own text is a risk ───────────────────────────────────────────────────────────
 *
 * These patterns come from operator configuration, so the regex the request path runs is, in the
 * end, a string somebody typed. `try/catch` already covers a pattern that will not COMPILE. It does
 * nothing about one that compiles perfectly and then takes exponential time to match — the classic
 * `(a+)+$` shape, where every quantified group nested inside another quantifier doubles the ways the
 * engine can split the same input. On a single-threaded gateway that is not a slow request; it is a
 * stalled event loop, and every other request in flight stops with it.
 *
 * ── What this does and does not promise ───────────────────────────────────────────────────────
 *
 * It looks for a quantifier applied to a group that itself contains a quantifier or an alternation
 * of overlapping branches — which is what every textbook ReDoS shares. That is a heuristic, not a
 * proof: JavaScript has no way to bound a regex's running time, and the only real fix is a
 * linear-time engine like RE2, which is a native dependency this package cannot take on and still
 * install cleanly from `npx`.
 *
 * So the honest statement of the guarantee is: the shapes that cause this in practice are refused,
 * guardrail rules remain admin-only, and `MAX_SCAN_CHARS` bounds how much text any of them sees.
 */
export function isSafePattern(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_CHARS) return false;

  // A quantifier — *, +, {n,} — applied to a group whose body also contains one. `(\w+)*`, `(a|b+)+`,
  // `([0-9]{2,}){3,}`. The inner body is matched non-greedily and without nested parens of its own,
  // so this looks one level deep, which is the level that matters.
  const NESTED_QUANTIFIER = /\((?![?]:?[=!<])[^()]*[*+]|\{\d+,\d*\}[^()]*\)[*+{]/;
  if (NESTED_QUANTIFIER.test(pattern) && /[)][*+]|[)]\{\d+,\d*\}/.test(pattern)) return false;

  // An alternation of branches that can match the same text, under a quantifier: `(a|a)*`, `(\d|\w)+`.
  // Overlap is undecidable in general; identical branches are the case that actually gets written.
  const alternationGroups = pattern.match(/\([^()]*\|[^()]*\)[*+]/g) ?? [];
  for (const group of alternationGroups) {
    const branches = group.slice(1, group.lastIndexOf(')')).split('|');
    if (new Set(branches).size < branches.length) return false;
  }

  return true;
}

/**
 * Compile rules to RegExp, skipping any that are malformed or unsafe rather than throwing —
 * one bad operator rule must not take the whole filter (or the request path) down.
 *
 * Skipping is deliberate over throwing, and the trade is worth naming: a rule that is silently
 * dropped is a filter the operator believes is running and is not. That is why `compileRules`
 * returns only what compiled and the caller can compare counts — a rejected rule is visible as a
 * missing one, where a thrown error would have taken every other rule down with it.
 */
export function compileRules(rules: GuardrailRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    if (!rule?.pattern || !rule?.name) continue;
    if (!isSafePattern(rule.pattern)) continue;
    try {
      const flags = rule.flags ?? 'gi';
      compiled.push({ ...rule, regex: new RegExp(rule.pattern, flags.includes('g') ? flags : `${flags}g`) });
    } catch { /* skip invalid pattern */ }
  }
  return compiled;
}

function appliesToDirection(rule: GuardrailRule, dir: 'input' | 'output'): boolean {
  const a = rule.appliesTo ?? 'both';
  return a === 'both' || a === dir;
}

/**
 * Evaluate a single string against the compiled rules for one direction. A `block`
 * rule short-circuits; `redact` rules mask every match. Scanning is capped at
 * MAX_SCAN_CHARS to bound cost.
 */
export function evaluateText(text: string, rules: CompiledRule[], dir: 'input' | 'output'): TextVerdict {
  const scan = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  const matched: string[] = [];
  let out = text;
  let redacted = false;

  for (const rule of rules) {
    if (!appliesToDirection(rule, dir)) continue;
    rule.regex.lastIndex = 0;
    if (!rule.regex.test(scan)) continue;
    matched.push(rule.name);
    if (rule.action === 'block') return { decision: 'block', text, matched };
    // redact
    rule.regex.lastIndex = 0;
    out = out.replace(rule.regex, rule.replacement ?? DEFAULT_REPLACEMENT);
    redacted = true;
  }

  return { decision: redacted ? 'redact' : 'allow', text: out, matched };
}

/** Extract a message's textual content (string, or an array of `{text}` parts). */
function readContent(content: unknown): { text: string; kind: 'string' | 'parts' | 'other' } {
  if (typeof content === 'string') return { text: content, kind: 'string' };
  if (Array.isArray(content)) {
    const text = content.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('');
    return { text, kind: 'parts' };
  }
  return { text: '', kind: 'other' };
}

/** Apply a redaction to a message's content, preserving its shape. */
function writeContent(content: unknown, redactOne: (s: string) => string): unknown {
  if (typeof content === 'string') return redactOne(content);
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string'
      ? { ...(p as object), text: redactOne((p as { text: string }).text) }
      : p));
  }
  return content;
}

export interface MessagesVerdict {
  decision: 'allow' | 'block' | 'redact';
  messages: unknown[];
  matched:  string[];
}

/**
 * Evaluate every message's content against the input rules. A block on any message
 * blocks the whole request; otherwise redactions are applied in place (by shape).
 */
export function evaluateMessages(messages: unknown[], rules: CompiledRule[]): MessagesVerdict {
  const matched = new Set<string>();
  let anyRedacted = false;
  const out: unknown[] = [];

  for (const m of messages) {
    if (!m || typeof m !== 'object' || !('content' in m)) { out.push(m); continue; }
    const { text } = readContent((m as { content: unknown }).content);
    const verdict = evaluateText(text, rules, 'input');
    verdict.matched.forEach((n) => matched.add(n));
    if (verdict.decision === 'block') return { decision: 'block', messages, matched: [...matched] };
    if (verdict.decision === 'redact') {
      anyRedacted = true;
      const newContent = writeContent((m as { content: unknown }).content, (s) => evaluateText(s, rules, 'input').text);
      out.push({ ...(m as object), content: newContent });
    } else {
      out.push(m);
    }
  }

  return { decision: anyRedacted ? 'redact' : 'allow', messages: out, matched: [...matched] };
}
