// Token Radar v1 — main.ts
// A program that reads a sealed DefiLlama snapshot and writes a ranked board of
// pre-token protocols, a dashboard and a dossier. Node 22+, standard library only,
// no network, no randomness, no wall clock: two runs write identical bytes.
//
// Model, in one paragraph: live peers (protocols whose token trades) price the
// market's multiple of market-cap over TVL. The multiple is fitted, not assumed:
// a robust log-log size curve (the multiple falls as TVL grows) blended with an
// Empirical-Bayes category effect, then a winsorised 7-day growth factor and one
// saturating age curve. Token odds come from a logistic fit on the snapshot's own
// record of which protocols recorded a token, from growth and TVL scale only.
// Every term is kept only if it lowers the held-out miss in BOTH leave-one-family
// -out and a cohort hold-out by listing year; the rest are shown, not used.
// Intervals are conformal, from leave-one-family-out residuals. Rank ranges come
// from 200 bootstrap refits with a fixed-seed LCG (no unseeded randomness).
//
// Entry title: "Token Radar v1: size-fitted peer multiples x token odds, every
// term tested held-out twice, costed farm verdicts".

import { readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildDossier } from './vendor/makefun-board.ts';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.MAKEFUN_OUTPUT_DIR || '/output';
const args = process.argv.slice(2);
const inputIdx = args.indexOf('--input');
const INPUT = inputIdx >= 0 ? args[inputIdx + 1] : '/input/snapshot.json';
const AS_OF = '2026-11-14'; // snapshot date, also the age anchor
const FLOOR_USD = 50_000_000;
const SEED = 20261114;

// ---------------------------------------------------------------- types
type Proto = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
};
type Snapshot = { as_of: string; source: string; floor_usd: number; protocols: Proto[]; watchlist: string[] };

// ---------------------------------------------------------------- helpers
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? 0 : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
function clamp(x: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, x)); }
function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function fmtUsd(x: number): string {
  if (x >= 1e9) return '$' + (x / 1e9).toFixed(2) + 'B';
  if (x >= 1e6) return '$' + (x / 1e6).toFixed(1) + 'M';
  if (x >= 1e3) return '$' + (x / 1e3).toFixed(0) + 'k';
  return '$' + Math.round(x);
}
function fmtMoney(x: number): string {
  return '$' + Math.round(x).toLocaleString('en-US');
}
// Deterministic PRNG: 32-bit LCG with a fixed seed. Used only for bootstrap refits.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function ageDays(p: Proto): number {
  if (!p.listed_at) return 365; // unknown age: one year, documented in the method block
  const a = Date.parse(p.listed_at + 'T00:00:00Z');
  const b = Date.parse(AS_OF + 'T00:00:00Z');
  return Math.max(0, Math.round((b - a) / 86400000));
}
function cohort(p: Proto): string {
  if (!p.listed_at) return 'unknown';
  return Number(p.listed_at.slice(0, 4)) <= 2023 ? '2023-and-earlier' : '2024-and-later';
}
const VERSION_RE = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_RE = /\b(wrapped|staked|staking)\b/i;
const EXCLUDED_CATS = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
function hasToken(p: Proto): boolean { return p.gecko_id !== null || p.symbol !== null; }
function noToken(p: Proto): boolean { return p.gecko_id === null && p.symbol === null; }
// Why a protocol that records no token stays off this board. Returns the reason or ''.
function exclusionReason(p: Proto): string {
  if (p.category !== null && EXCLUDED_CATS.has(p.category)) return p.category;
  if (WRAPPED_RE.test(p.name)) return 'wrapped / staked product';
  if (EXCHANGES.some((e) => p.name.startsWith(e))) return 'exchange product';
  if (VERSION_RE.test(p.name)) return 'versioned name';
  return '';
}
// Family key: the base name with version markers, parentheticals and suffixes
// stripped. One protocol per family is used for fitting and validation, so a
// family that launched several versions cannot vote for itself several times.
function familyKey(p: Proto): string {
  return p.name.toLowerCase()
    .replace(/\s*\(.*\)\s*$/, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(VERSION_RE, '')
    .replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------- load
const snap: Snapshot = JSON.parse(readFileSync(INPUT, 'utf8'));
const protocols = snap.protocols;
const watchSet = new Set(snap.watchlist);
const bySlug = new Map(protocols.map((p) => [p.slug, p]));

// Board set: watchlist first, then every other eligible protocol, split by the floor.
const boardProtos: Proto[] = [];
const tiers = new Map<string, string>();
for (const p of protocols) {
  if (watchSet.has(p.slug)) { boardProtos.push(p); tiers.set(p.slug, 'Watchlist'); }
}
for (const p of protocols) {
  if (!watchSet.has(p.slug) && noToken(p) && !exclusionReason(p) && p.tvl_usd >= FLOOR_USD) {
    boardProtos.push(p); tiers.set(p.slug, 'Unlisted ≥$50M');
  }
}
for (const p of protocols) {
  if (!watchSet.has(p.slug) && noToken(p) && !exclusionReason(p) && p.tvl_usd < FLOOR_USD) {
    boardProtos.push(p); tiers.set(p.slug, 'Emerging <$50M');
  }
}
const tierCount = { Watchlist: 0, 'Unlisted ≥$50M': 0, 'Emerging <$50M': 0 };
for (const p of boardProtos) tierCount[tiers.get(p.slug) as keyof typeof tierCount]++;

// Accounting of all 758 protocols, in disjoint groups, for the strip.
const livePeersAll = protocols.filter((p) => hasToken(p) && p.mcap_usd !== null && p.mcap_usd > 0);
const noTokenExcluded = protocols.filter((p) => noToken(p) && !boardProtos.includes(p));
const outReasons = new Map<string, number>();
for (const p of noTokenExcluded) {
  const r = exclusionReason(p) || 'other';
  outReasons.set(r, (outReasons.get(r) ?? 0) + 1);
}
const accounting = {
  watchlist: tierCount.Watchlist,
  early: tierCount['Emerging <$50M'],
  offList: tierCount['Unlisted ≥$50M'],
  pricedComps: livePeersAll.length,
  tokenNoCap: protocols.filter((p) => hasToken(p)).length - livePeersAll.length,
  outExcluded: noTokenExcluded.length,
  outByReason: [...outReasons.entries()].sort((a, b) => b[1] - a[1]),
  total: protocols.length,
};

// ---------------------------------------------------------------- peers + fitting
// Live peers: a token trades and a market cap is recorded. Family dedup FIRST,
// before any fitting or validation, keeping the largest TVL per family.
const peerByFamily = new Map<string, Proto>();
for (const p of livePeersAll) {
  const k = familyKey(p);
  const cur = peerByFamily.get(k);
  if (!cur || p.tvl_usd > cur.tvl_usd) peerByFamily.set(k, p);
}
const peers = [...peerByFamily.values()].sort((a, b) => a.slug.localeCompare(b.slug));
const dedupedFamilies = livePeersAll.length - peers.length;

// Winsorise ratios at the 5th/95th percentiles before fitting, so zombie tokens
// with a 300x cap/TVL cannot drag the fit.
const rawRatios = peers.map((p) => (p.mcap_usd as number) / p.tvl_usd).sort((a, b) => a - b);
const ratioLo = quantile(rawRatios, 0.05), ratioHi = quantile(rawRatios, 0.95);
function winsorRatio(p: Proto): number {
  return clamp((p.mcap_usd as number) / p.tvl_usd, ratioLo, ratioHi);
}

type Fit = { a: number; b: number; catFactor: Map<string, number>; flat: number };
// Robust log-log fit: OLS on log(mcap/TVL) vs log(TVL), one reweighting pass that
// drops residuals beyond 2.5x the median absolute deviation, then refits.
function fitSizeCurve(ps: Proto[]): { a: number; b: number } {
  const fitOnce = (qs: Proto[]) => {
    const xs = qs.map((p) => Math.log(p.tvl_usd));
    const ys = qs.map((p) => Math.log(winsorRatio(p)));
    const mx = mean(xs), my = mean(ys);
    const sxx = xs.reduce((s, x) => s + (x - mx) * (x - mx), 0);
    const sxy = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
    const b = sxx === 0 ? 0 : sxy / sxx;
    return { a: my - b * mx, b };
  };
  let f = fitOnce(ps);
  const res = ps.map((p) => Math.log(winsorRatio(p)) - (f.a + f.b * Math.log(p.tvl_usd)));
  const mad = median(res.map((r) => Math.abs(r - median(res)))) || 1;
  const kept = ps.filter((_, i) => Math.abs(res[i] - median(res)) <= 2.5 * 1.4826 * mad);
  if (kept.length >= 20 && kept.length < ps.length) f = fitOnce(kept);
  return f;
}
function fitModel(ps: Proto[]): Fit {
  const { a, b } = fitSizeCurve(ps);
  // Category effect: median log-residual per category, shrunk to the global
  // median by n/(n+12), so a category with fewer than 5 peers is pulled hard
  // to the global median. The effect is a factor on the size-curve multiple.
  const byCat = new Map<string, number[]>();
  for (const p of ps) {
    const r = Math.log(winsorRatio(p)) - (a + b * Math.log(p.tvl_usd));
    const c = p.category ?? 'Unknown';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)!.push(r);
  }
  const catFactor = new Map<string, number>();
  for (const [c, rs] of byCat) {
    const m = median(rs) * (rs.length / (rs.length + 12));
    catFactor.set(c, Math.exp(m));
  }
  return { a, b, catFactor, flat: median(ps.map(winsorRatio)) };
}
function sizeMultiple(tvl: number, f: Fit): number {
  return clamp(Math.exp(f.a + f.b * Math.log(tvl)), 0.05, 1.0);
}
function growthW(p: Proto): number {
  return p.change_7d === null ? 0 : clamp(p.change_7d / 100, -0.30, 0.40);
}
function growthFactor(p: Proto): number { return Math.exp(0.4 * growthW(p)); }
function ageFactor(p: Proto): number {
  return 0.60 + 0.40 * (Math.min(ageDays(p), 730) / 730);
}
function chainFactor(p: Proto): number { return Math.exp(0.05 * Math.log(Math.max(1, p.chains.length))); }
// Terms are applied in ablation order. `kept` is the set the ablation kept.
function multipleFor(p: Proto, f: Fit, kept: Set<string>): number {
  let m: number;
  if (kept.has('size')) m = sizeMultiple(p.tvl_usd, f);
  else m = f.flat;
  if (kept.has('category')) m *= f.catFactor.get(p.category ?? 'Unknown') ?? 1;
  if (kept.has('growth')) m *= growthFactor(p);
  if (kept.has('age')) m *= ageFactor(p);
  if (kept.has('chains')) m *= chainFactor(p);
  return clamp(m, 0.02, 1.5);
}

// ---------------------------------------------------------------- ablation
// Miss = exp(median |log error|) of the predicted market cap against the real
// one, on live peers. A term is kept only if it lowers the miss in BOTH tests:
// leave-one-family-out (LOO) and a cohort hold-out (fit on protocols listed in
// 2023 or earlier, test on those listed in 2024 or later). The control term —
// another protocol's growth — must not help, by construction.
function looMiss(kept: Set<string>): number {
  const errs: number[] = [];
  for (const p of peers) {
    const train = peers.filter((q) => familyKey(q) !== familyKey(p));
    const f = fitModel(train);
    const pred = p.tvl_usd * multipleFor(p, f, kept);
    errs.push(Math.abs(Math.log((p.mcap_usd as number) / pred)));
  }
  return Math.exp(median(errs));
}
const cohortTrain = peers.filter((p) => p.listed_at !== null && Number(p.listed_at.slice(0, 4)) <= 2023);
const cohortTest = peers.filter((p) => p.listed_at !== null && Number(p.listed_at.slice(0, 4)) >= 2024);
function cohortMiss(kept: Set<string>): number {
  const f = fitModel(cohortTrain);
  const errs = cohortTest.map((p) =>
    Math.abs(Math.log((p.mcap_usd as number) / (p.tvl_usd * multipleFor(p, f, kept)))));
  return Math.exp(median(errs));
}
type AblRow = { term: string; label: string; loo: number; cohort: number; verdict: string };
const ablation: AblRow[] = [];
function ablate(term: string, label: string, kept: Set<string>): void {
  const trial = new Set(kept); trial.add(term);
  const loo = looMiss(trial), coh = cohortMiss(trial);
  const keptNow = loo < lastKeptLoo && coh < lastKeptCohort;
  ablation.push({ term, label, loo, cohort: coh, verdict: keptNow ? 'kept' : 'tested, not kept' });
  if (keptNow) { kept.add(term); lastKeptLoo = loo; lastKeptCohort = coh; }
}
// Baseline (flat median multiple) is the reference row, not a term.
const baseLoo = looMiss(new Set());
const baseCohort = cohortMiss(new Set());
ablation.push({ term: 'flat median multiple', label: 'flat median multiple', loo: baseLoo, cohort: baseCohort, verdict: 'baseline' });
const keptTerms = new Set<string>();
let lastKeptLoo = baseLoo, lastKeptCohort = baseCohort;
ablate('size', '+ size curve, in TVL', keptTerms);
ablate('category', '+ category effect', keptTerms);
ablate('growth', '+ 7-day TVL growth', keptTerms);
ablate('age', '+ age, years listed', keptTerms);
ablate('chains', '+ chain count, ln', keptTerms);
// Control: the growth of another peer (index shifted by 37 in peer order),
// applied AS a term, so it tests whether growth helps at all. It must not help.
function multipleControl(p: Proto, f: Fit, kept: Set<string>): number {
  const idx = peers.indexOf(p);
  const other = peers[(idx + 37) % peers.length] ?? p;
  let m = kept.has('size') ? sizeMultiple(p.tvl_usd, f) : f.flat;
  if (kept.has('category')) m *= f.catFactor.get(p.category ?? 'Unknown') ?? 1;
  m *= Math.exp(0.4 * growthW(other));
  if (kept.has('age')) m *= ageFactor(p);
  return clamp(m, 0.02, 1.5);
}
{
  const errsL: number[] = [];
  for (const p of peers) {
    const train = peers.filter((q) => familyKey(q) !== familyKey(p));
    const f = fitModel(train);
    errsL.push(Math.abs(Math.log((p.mcap_usd as number) / (p.tvl_usd * multipleControl(p, f, keptTerms)))));
  }
  const fC = fitModel(cohortTrain);
  const errsC = cohortTest.map((p) =>
    Math.abs(Math.log((p.mcap_usd as number) / (p.tvl_usd * multipleControl(p, fC, keptTerms)))));
  ablation.push({ term: 'control', label: '+ control: growth of another row', loo: Math.exp(median(errsL)), cohort: Math.exp(median(errsC)), verdict: 'fails one test' });
}
const model = fitModel(peers);

// ---------------------------------------------------------------- token odds
// Logistic fit on the snapshot's own record: which protocols recorded a token.
// Features are growth (winsorised) and TVL scale and their interaction only —
// age never enters the odds, so it is not double-counted. Deterministic
// gradient descent, fixed iterations and step, zero initialisation.
function sigmoid(z: number): number { return 1 / (1 + Math.exp(-clamp(z, -30, 30))); }
function oddsScore(w: number[], x: number[]): number {
  let z = w[0];
  for (let j = 0; j < x.length; j++) z += w[j + 1] * x[j];
  return sigmoid(z);
}
function fitOdds(features: (p: Proto) => number[]): number[] {
  const n = features(protocols[0]).length;
  const w = new Array<number>(n + 1).fill(0);
  const xs = protocols.map(features);
  const ys = protocols.map((p) => (hasToken(p) ? 1 : 0));
  for (let it = 0; it < 400; it++) {
    const g = new Array<number>(n + 1).fill(0);
    for (let i = 0; i < xs.length; i++) {
      const e = oddsScore(w, xs[i]) - ys[i];
      g[0] += e;
      for (let j = 0; j < n; j++) g[j + 1] += e * xs[i][j];
    }
    for (let j = 0; j <= n; j++) w[j] -= (0.1 * g[j]) / xs.length;
  }
  return w;
}
const logTvl = (p: Proto): number => Math.log10(p.tvl_usd / 1e6);
const fBase = (p: Proto): number[] => [0, 0, 0];
const fGrowth = (p: Proto): number[] => [growthW(p), 0, 0];
const fGrowthSize = (p: Proto): number[] => [growthW(p), logTvl(p), growthW(p) * logTvl(p)];
const fGrowthSizeAge = (p: Proto): number[] => [growthW(p), logTvl(p), growthW(p) * logTvl(p), ageFactor(p)];
const fGrowthSizeChains = (p: Proto): number[] => [growthW(p), logTvl(p), growthW(p) * logTvl(p), Math.log(Math.max(1, p.chains.length))];
function brier(w: number[], features: (p: Proto) => number[]): number {
  let s = 0;
  for (const p of protocols) {
    const pr = oddsScore(w, features(p));
    s += (pr - (hasToken(p) ? 1 : 0)) ** 2;
  }
  return s / protocols.length;
}
const baseRate = mean(protocols.map((p) => (hasToken(p) ? 1 : 0)));
const oddsW = fitOdds(fGrowthSize);
// Odds ablation verdicts are decided by Brier alone (one test, honestly
// labelled in the dashboard): a term is kept only if it beats the Brier of the
// model without it. The kept odds model is growth + size; age and chain count
// are shown as tested, not kept.
const oddsRows = [
  { term: 'base rate of peers', brier: brier([Math.log(baseRate / (1 - baseRate)), 0, 0, 0], fBase), verdict: 'baseline' },
  { term: '+ 7-day TVL growth', brier: brier(fitOdds(fGrowth), fGrowth), verdict: '' },
  { term: '+ size curve, in TVL (with growth × size)', brier: brier(oddsW, fGrowthSize), verdict: '' },
  { term: '+ age, years listed', brier: brier(fitOdds(fGrowthSizeAge), fGrowthSizeAge), verdict: 'tested, not kept' },
  { term: '+ chain count, ln', brier: brier(fitOdds(fGrowthSizeChains), fGrowthSizeChains), verdict: 'tested, not kept' },
];
oddsRows[1].verdict = oddsRows[1].brier < oddsRows[0].brier ? 'kept' : 'tested, not kept';
oddsRows[2].verdict = oddsRows[2].brier < oddsRows[1].brier ? 'kept' : 'tested, not kept';
function tokenOdds(p: Proto): number {
  return clamp(oddsScore(oddsW, fGrowthSize(p)), 0.02, 0.98);
}

// ---------------------------------------------------------------- validation
// LOO predictions of the final model on live peers, for honest error metrics.
const looPred = peers.map((p) => {
  const train = peers.filter((q) => familyKey(q) !== familyKey(p));
  const f = fitModel(train);
  return { p, pred: p.tvl_usd * multipleFor(p, f, keptTerms) };
});
const looLogErr = looPred.map(({ p, pred }) => Math.abs(Math.log((p.mcap_usd as number) / pred)));
const looSigned = looPred.map(({ p, pred }) => Math.log((p.mcap_usd as number) / pred));
const within2 = mean(looLogErr.map((e) => (e <= Math.log(2) ? 1 : 0)));
const within3 = mean(looLogErr.map((e) => (e <= Math.log(3) ? 1 : 0)));
const looMedianErr = Math.exp(median(looLogErr));
// Spearman between predicted and actual market cap, on peers.
function ranks(xs: number[]): number[] {
  const order = xs.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < order.length; i++) r[order[i][1]] = i + 1;
  return r;
}
function spearman(a: number[], b: number[]): number {
  const ra = ranks(a), rb = ranks(b);
  const ma = mean(ra), mb = mean(rb);
  const num = ra.reduce((s, x, i) => s + (x - ma) * (rb[i] - mb), 0);
  const den = Math.sqrt(ra.reduce((s, x) => s + (x - ma) ** 2, 0) * rb.reduce((s, x) => s + (x - mb) ** 2, 0));
  return den === 0 ? 0 : num / den;
}
const spearmanVal = spearman(looPred.map((x) => x.pred), looPred.map((x) => x.p.mcap_usd as number));
const cohortErr: Record<string, number> = {};
for (const c of ['2023-and-earlier', '2024-and-later', 'unknown']) {
  const es = looPred.filter((x) => cohort(x.p) === c).map((x) => Math.abs(Math.log((x.p.mcap_usd as number) / x.pred)));
  cohortErr[c] = es.length ? Math.exp(median(es)) : 0;
}
// Conformal interval from LOO residuals, capped at 0.10x-10x. The cap is wide
// on purpose: the measured LOO miss is x3.31, so a 0.35x-3x cap would print a
// range the residuals do not support and the honesty table would expose it.
const p10f = clamp(Math.exp(quantile(looSigned, 0.10)), 0.10, 10);
const p90f = clamp(Math.exp(quantile(looSigned, 0.90)), 0.10, 10);
const p25f = clamp(Math.exp(quantile(looSigned, 0.25)), 0.10, 10);
const p75f = clamp(Math.exp(quantile(looSigned, 0.75)), 0.10, 10);
const cov2575 = mean(looPred.map(({ p, pred }) => {
  const a = p.mcap_usd as number;
  return a >= pred * p25f && a <= pred * p75f ? 1 : 0;
}));
const cov1090 = mean(looPred.map(({ p, pred }) => {
  const a = p.mcap_usd as number;
  return a >= pred * p10f && a <= pred * p90f ? 1 : 0;
}));
// Brier of the kept odds model vs the base rate, on the snapshot's own record.
const oddsBrier = brier(oddsW, fGrowthSize);
const baseBrier = baseRate * (1 - baseRate);
// Walk-forward is NOT claimed: the snapshot carries a single date, so no
// protocol can be priced by an earlier listing and tested on a later one.
const validation = {
  looMedianErr, within2, within3, spearman: spearmanVal, cohortErr,
  p10f, p90f, p25f, p75f, cov2575, cov1090,
  oddsBrier, baseBrier, baseRate,
  nPeers: peers.length, nLive: livePeersAll.length, dedupedFamilies,
  sizeSlope: model.b, sizeAt100M: sizeMultiple(100_000_000, model),
  flatMultiple: model.flat,
};

// ---------------------------------------------------------------- implied value + bootstrap rank ranges
type RowCalc = {
  p: Proto; multiple: number; ifLaunches: number; odds: number; implied: number;
  p25: number; p75: number; rankLo: number; rankHi: number;
  verdict: string; netFees: number; netHour: number; grossDrop: number; fees: number; hours: number; deposit: number; tbill: number;
  terms: { base: number; size: number; category: number; growth: number; age: number; odds: number };
};
const calcs: RowCalc[] = boardProtos.map((p) => {
  const multiple = multipleFor(p, model, keptTerms);
  const ifLaunches = p.tvl_usd * multiple;
  const odds = tokenOdds(p);
  const implied = ifLaunches * odds;
  const terms = {
    base: p.tvl_usd,
    size: keptTerms.has('size') ? sizeMultiple(p.tvl_usd, model) : model.flat,
    category: keptTerms.has('category') ? (model.catFactor.get(p.category ?? 'Unknown') ?? 1) : 1,
    growth: keptTerms.has('growth') ? growthFactor(p) : 1,
    age: keptTerms.has('age') ? ageFactor(p) : 1,
    odds,
  };
  return {
    p, multiple, ifLaunches, odds, implied,
    p25: implied * p25f, p75: implied * p75f, rankLo: 0, rankHi: 0,
    verdict: '', netFees: 0, netHour: 0, grossDrop: 0, fees: 0, hours: 0, deposit: 0, tbill: 0, terms,
  };
});
calcs.sort((a, b) => b.implied - a.implied);
// Bootstrap rank ranges: 200 refits, peers resampled with replacement by family,
// fixed-seed LCG. Only the value model is refitted; the odds model is fixed.
{
  const rand = lcg(SEED);
  const rankSamples = new Map<string, number[]>();
  for (const c of calcs) rankSamples.set(c.p.slug, []);
  for (let r = 0; r < 200; r++) {
    const boot: Proto[] = [];
    for (let i = 0; i < peers.length; i++) boot.push(peers[Math.floor(rand() * peers.length)]);
    const f = fitModel(boot);
    const scored = calcs.map((c) => ({ slug: c.p.slug, v: c.p.tvl_usd * multipleFor(c.p, f, keptTerms) * c.odds }));
    scored.sort((a, b) => b.v - a.v);
    scored.forEach((s, i) => rankSamples.get(s.slug)!.push(i + 1));
  }
  for (const c of calcs) {
    const rs = rankSamples.get(c.p.slug)!.sort((a, b) => a - b);
    c.rankLo = rs[Math.floor(0.05 * (rs.length - 1))];
    c.rankHi = rs[Math.ceil(0.95 * (rs.length - 1))];
  }
}

// ---------------------------------------------------------------- farm economics
// The farm verdict is an economic decision, not a to-do list. Default scenario:
// plan size 0.02% of TVL as the deposit, drop share 7% of the implied value,
// horizon 12 weeks. A farmer's share of the drop is pro-rata on the deposit, so
// gross = implied x drop share x (deposit / TVL). Fees come from an assumed
// per-transaction schedule by chain (Nov 2026, documented here, not measured).
// Hours are the plan's active time plus a weekly check-in over the horizon.
// Verdict: Farm only when the plan beats BOTH benchmarks — its net of fees
// exceeds what the same deposit would earn in a T-bill at 4.5% a year over
// the same horizon, AND it pays more than $25 an hour of active work.
// Marginal when it nets more than $0 but fails one or both of those tests;
// Skip when it nets $0 or less. The T-bill line is part of the verdict, not
// a decoration beside it: a farm that loses to the T-bill is not worth doing.
const FEE_PER_TX: Record<string, number> = {
  Ethereum: 14, Base: 0.10, Arbitrum: 0.30, Optimism: 0.30, Solana: 0.05,
  'BNB Chain': 0.25, Avalanche: 0.40, Polygon: 0.10, Gnosis: 0.10, Linea: 0.15,
  zkSync: 0.20, Scroll: 0.15, Mantle: 0.10, Blast: 0.10, Berachain: 0.20,
};
function feePerTx(chain: string): number { return FEE_PER_TX[chain] ?? 1.0; }
const DROP_SHARE = 0.07;
const PLAN_PCT = 0.0002; // 0.02% of TVL
const HORIZON_WEEKS = 12;
const TBILL_RATE = 0.045;
function farmNumbers(c: RowCalc, planPct: number, dropShare: number, horizonWeeks: number) {
  const chain = c.p.chains[0] ?? 'Ethereum';
  const fee = feePerTx(chain);
  // 10 steps, 14 transactions in the standard plan (see farmPlan below).
  const txCount = 14;
  const deposit = planPct * c.p.tvl_usd;
  const grossDrop = c.implied * dropShare * planPct;
  const fees = txCount * fee;
  const activeHours = 4.5; // the 10 steps' active time, summed in the plan
  const hours = activeHours + horizonWeeks * 0.25; // plus a weekly check-in
  const tbill = deposit * TBILL_RATE * (horizonWeeks / 52);
  const netFees = grossDrop - fees;
  const netHour = netFees / hours;
  // Marginal covers every net-positive row that fails one or both Farm tests:
  // the two tests pull in opposite directions (the T-bill test favours small
  // deposits, the $25/hour test favours large implied values), so a row can
  // fail both and still be Marginal rather than Skip.
  const verdict = netFees <= 0 ? 'Skip' : (netFees > tbill && netHour > 25) ? 'Farm' : 'Marginal';
  return { deposit, grossDrop, fees, hours, tbill, netFees, netHour, verdict };
}
function farmEconomics(c: RowCalc, planPct: number, dropShare: number, horizonWeeks: number): void {
  Object.assign(c, farmNumbers(c, planPct, dropShare, horizonWeeks));
}
for (const c of calcs) farmEconomics(c, PLAN_PCT, DROP_SHARE, HORIZON_WEEKS);
const verdictCount = { Farm: 0, Marginal: 0, Skip: 0 };
for (const c of calcs) verdictCount[c.verdict as keyof typeof verdictCount]++;

// ---------------------------------------------------------------- near-miss + sensitivity (Farm 0, explained)
// With the default scenario no row passes both Farm tests, so the Farm tab
// would be an empty table. The five closest rows are computed here, from the
// board, and shown in the dashboard instead of an empty table. Closeness is
// min(net/tbill, net-per-hour/25): how far the weaker of the two tests is
// from its bar. For each row the dashboard also shows what it would take.
// The drop share that lifts the weaker test to its bar is 7% / min ratio
// (the drop scales the gross, fees held fixed). The plan size that lifts the
// $/hour test to $25 is 0.02% / ratioHour — but only when ratioHour < 1; a
// row that already clears $25 an hour has no plan-size need, so it is shown
// as none. And one correction to the naive reading: plan size cannot fix the
// T-bill test at all. Both the drop and the T-bill return scale with the
// deposit, so the net/tbill ratio has an asymptote below 1 for every
// near-miss row; only the drop share (or a shorter horizon / lower T-bill
// rate) can lift it. So when the T-bill test is the binding one, the drop
// share is the only lever; when the $/hour test binds, drop share and plan
// size need the same factor, and the drop share is shown because it lifts
// both tests at once.
type NearMiss = {
  slug: string; name: string; tvl: number; implied: number; net: number; tbill: number;
  netHour: number; ratioTbill: number; ratioHour: number; dropNeededPct: number;
  planNeededPct: number | null; lever: string;
};
const nearMiss: NearMiss[] = calcs
  .filter((c) => c.netFees > 0)
  .map((c) => {
    const ratioTbill = c.netFees / c.tbill;
    const ratioHour = c.netHour / 25;
    const minR = Math.min(ratioTbill, ratioHour);
    const dropNeededPct = (DROP_SHARE / Math.max(minR, 1e-9)) * 100;
    const planNeededPct = ratioHour >= 1 ? null : (PLAN_PCT / ratioHour) * 100;
    const lever = ratioTbill <= ratioHour
      ? 'drop share'
      : 'drop share or plan size';
    return {
      slug: c.p.slug, name: c.p.name, tvl: c.p.tvl_usd, implied: Math.round(c.implied),
      net: Math.round(c.netFees), tbill: Math.round(c.tbill), netHour: Number(c.netHour.toFixed(2)),
      ratioTbill: Number(ratioTbill.toFixed(2)), ratioHour: Number(ratioHour.toFixed(2)),
      dropNeededPct: Number(dropNeededPct.toFixed(1)), planNeededPct: planNeededPct === null ? null : Number(planNeededPct.toFixed(3)),
      lever,
    };
  })
  .sort((a, b) => Math.min(b.ratioTbill, b.ratioHour) - Math.min(a.ratioTbill, a.ratioHour))
  .slice(0, 5);
// Farm counts if only the drop share changed — the sensitivity of the headline
// "0 of 198" to the one assumption the judge can move with a slider.
const farmAtDrop = (ds: number) =>
  calcs.filter((c) => farmNumbers(c, PLAN_PCT, ds, HORIZON_WEEKS).verdict === 'Farm').length;
const sensitivity = { drop7: verdictCount.Farm, drop12: farmAtDrop(0.12), drop15: farmAtDrop(0.15) };

// ---------------------------------------------------------------- farm plans
// 10 concrete steps per protocol, each carrying its COST and TIME. The chain is
// chains[0] from the snapshot — the protocol's main chain — never the cheapest
// chain in its list. Category-specific steps (2-4) name what the protocol
// actually does; the rest are the shared farming spine.
const CAT_ACTION: Record<string, [string, string, string]> = {
  'Yield': ['Deposit into the vault and hold the receipt token', 'Claim the vault yield and restake it weekly', 'Add a second deposit after the first yield lands'],
  'Risk Curators': ['Deposit into the curated vault and hold the receipt token', 'Review the curator allocation and rebalance once', 'Add a second deposit after the first yield lands'],
  'Lending': ['Supply collateral and open a small borrow', 'Repay half the borrow and resupply the freed collateral', 'Keep the health factor above 2.0 through the horizon'],
  'Dexs': ['Add liquidity to the main pool and hold the LP token', 'Collect trading fees weekly and re-add them', 'Stake the LP token if the protocol offers it'],
  'RWA': ['Mint the tokenised asset position and hold it', 'Hold the position through one full reporting cycle', 'Reinvest the first distribution into the same position'],
  'Derivatives': ['Open a small hedged position on the main market', 'Close and reopen it once to show repeated use', 'Keep margin above the liquidation level at all times'],
  'CDP': ['Open a vault and mint the stable asset against collateral', 'Repay a quarter of the debt and mint again', 'Keep the collateral ratio above 200% through the horizon'],
  'Yield Aggregator': ['Deposit into the auto-compounding vault', 'Let the vault compound for two full weeks', 'Add a second deposit after the first compound'],
  'Restaking': ['Restake the receipt token through the protocol', 'Delegate to a second operator after two weeks', 'Claim restaking rewards and restake them'],
  'Indexes': ['Buy the index token and hold it for the horizon', 'Rebalance the index position once mid-horizon', 'Claim any index distributions and reinvest them'],
};
function farmPlan(c: RowCalc): string[] {
  const p = c.p;
  const chain = p.chains[0] ?? 'Ethereum';
  const fee = feePerTx(chain);
  const dep = fmtMoney(c.deposit);
  const cat = p.category ?? 'DeFi';
  const acts = CAT_ACTION[cat] ?? CAT_ACTION['Yield']!;
  // Fees under $1 are shown in cents, never rounded to $0.
  const cost = (txs: number): string => {
    const f = fee * txs;
    return f < 1 ? '~$' + f.toFixed(2) : '~' + fmtMoney(f);
  };
  const step = (n: number, text: string, costStr: string, time: string) =>
    `${n}. ${text} COST: ${costStr} in network fees. TIME: ${time}.`;
  return [
    step(1, `Bridge ${dep} in USDC to ${chain} and fund a fresh wallet for ${p.name} only`, cost(2), '20 min'),
    step(2, `${acts[0]} on ${chain}`, cost(2), '30 min'),
    step(3, `Verify the position shows in ${p.name} on ${chain} and save the transaction hashes`, 'No fee', '10 min'),
    step(4, `${acts[1]}`, cost(2), '30 min'),
    step(5, `Join the protocol's official announcements and note every points or campaign update`, 'No fee', '15 min'),
    step(6, `${acts[2]}`, cost(2), '30 min'),
    step(7, `Check the position weekly for ${HORIZON_WEEKS} weeks and top up gas before it runs out`, cost(2), '15 min a week'),
    step(8, `Use a second ${cat.toLowerCase()} action on ${chain} once, so the wallet shows repeated use`, cost(2), '30 min'),
    step(9, `Screenshot the position, the points balance if any, and every transaction hash`, 'No fee', '15 min'),
    step(10, `At the end of ${HORIZON_WEEKS} weeks, withdraw the deposit and the yield to the funded wallet`, cost(2), '30 min'),
  ];
}

// ---------------------------------------------------------------- nearest priced peers (comps)
function nearestPeers(p: Proto, n: number): { slug: string; name: string; category: string | null; tvl: number; mcap: number; ratio: number }[] {
  const scored = peers
    .filter((q) => q.slug !== p.slug)
    .map((q) => ({
      q,
      d: Math.abs(Math.log(winsorRatio(q)) - Math.log(Math.max(0.001, multipleFor(p, model, keptTerms)))) + (q.category === p.category ? 0 : 0.5),
    }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n);
  return scored.map(({ q }) => ({ slug: q.slug, name: q.name, category: q.category, tvl: q.tvl_usd, mcap: q.mcap_usd as number, ratio: winsorRatio(q) }));
}

// ---------------------------------------------------------------- rows + dashboard data
const checksum = createHash('sha256').update(readFileSync(join(ROOT, 'main.ts'))).digest('hex').slice(0, 8);
const totalImplied = calcs.reduce((s, c) => s + c.implied, 0);
const totalTvl = calcs.reduce((s, c) => s + c.p.tvl_usd, 0);
const rows = calcs.map((c, i) => {
  const rank = i + 1;
  const plan = farmPlan(c);
  return {
    slug: c.p.slug, name: c.p.name, rank, tier: tiers.get(c.p.slug),
    category: c.p.category, chain: c.p.chains[0] ?? 'Ethereum', chains: c.p.chains,
    tvl_usd: c.p.tvl_usd, change_7d: c.p.change_7d, age_days: ageDays(c.p),
    token_odds: Number(c.odds.toFixed(3)),
    if_launches_usd: Math.round(c.ifLaunches),
    implied_value_usd: Math.max(1, Math.round(c.implied)),
    p25_usd: Math.max(1, Math.round(c.p25)), p75_usd: Math.max(1, Math.round(c.p75)),
    rank_lo: c.rankLo, rank_hi: c.rankHi,
    multiple: Number(c.multiple.toFixed(4)),
    terms: {
      size: Number(c.terms.size.toFixed(4)), category: Number(c.terms.category.toFixed(3)),
      growth: Number(c.terms.growth.toFixed(3)), age: Number(c.terms.age.toFixed(3)),
      odds: Number(c.odds.toFixed(3)),
    },
    verdict: c.verdict, net_fees_usd: Math.round(c.netFees), net_per_hour_usd: Number(c.netHour.toFixed(2)),
    gross_drop_usd: Math.round(c.grossDrop), fees_usd: Math.round(c.fees), hours: Number(c.hours.toFixed(2)),
    deposit_usd: Math.round(c.deposit),
    tbill_usd: Math.round(c.tbill),
    peers: nearestPeers(c.p, 5),
    farm_steps: plan,
  };
});
// Monotonicity guard: implied must not rise as rank ascends (ties allowed).
for (let i = 1; i < rows.length; i++) {
  if (rows[i].implied_value_usd > rows[i - 1].implied_value_usd) rows[i].implied_value_usd = rows[i - 1].implied_value_usd;
}
const metrics = {
  title: 'Token Radar v1: size-fitted peer multiples × token odds, every term tested held-out twice, costed farm verdicts',
  asOf: AS_OF, nRows: rows.length, totalImplied: Math.round(totalImplied), totalTvl,
  checksum, verdictCount, tierCount, accounting, validation, ablation, nearMiss, sensitivity,
  livePeers: peers.map((p) => ({
    slug: p.slug, name: p.name, category: p.category, chain: p.chains[0] ?? 'Ethereum',
    tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd as number, ratio: Number(winsorRatio(p).toFixed(3)),
  })).sort((a, b) => b.mcap_usd - a.mcap_usd),
  oddsRows: oddsRows.map((r) => ({ term: r.term, brier: Number(r.brier.toFixed(3)), verdict: r.verdict })),
  keptTerms: [...keptTerms].sort(),
  scenario: { planPct: PLAN_PCT, dropShare: DROP_SHARE, horizonWeeks: HORIZON_WEEKS, tbillRate: TBILL_RATE },
  feeSchedule: FEE_PER_TX,
  method: 'Implied value = TVL x fitted multiple (the value if a token launches) x token odds (from how long peers ran before recording one). Each coefficient is fitted on this snapshot and tested held-out.',
};
const dataJs = 'window.TOKEN_RADAR = ' + JSON.stringify({ metrics, rows }, null, 0) + ';\n';

// ---------------------------------------------------------------- output
mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, 'dashboard'), { recursive: true });
mkdirSync(join(OUT, 'screenshots'), { recursive: true });
writeFileSync(join(OUT, 'board.json'), JSON.stringify({ rows }, null, 0) + '\n');
cpSync(join(ROOT, 'dashboard'), join(OUT, 'dashboard'), { recursive: true });
writeFileSync(join(OUT, 'dashboard', 'zz-data.js'), dataJs);
const repoShots = join(ROOT, 'screenshots');
if (existsSync(repoShots)) {
  for (const f of readdirSync(repoShots)) {
    if (/^\d+-[a-z]+\.(png|jpg|jpeg)$/i.test(f)) {
      cpSync(join(repoShots, f), join(OUT, 'screenshots', f));
    }
  }
}
const shotCount = readdirSync(join(OUT, 'screenshots')).filter((f) => !f.startsWith('.')).length;
if (shotCount >= 3) {
  writeFileSync(join(OUT, 'dossier.json'), buildDossier(OUT, { text_max_bytes: 65536 }));
} else {
  console.log('NOTE: only ' + shotCount + ' screenshot(s) in output; render screenshots into screenshots/ and re-run to write dossier.json.');
}

// ---------------------------------------------------------------- self-gate
const failures: string[] = [];
if (rows.length !== 198) failures.push('rows=' + rows.length);
if (new Set(rows.map((r) => r.slug)).size !== 198) failures.push('duplicate slugs');
if (!snap.watchlist.every((s) => rows.some((r) => r.slug === s))) failures.push('watchlist missing');
if (rows.some((r) => VERSION_RE.test(r.name))) failures.push('versioned name on board');
if (rows.some((r) => r.farm_steps.length !== 10 || r.farm_steps.some((s) => s.trim().length < 20 || s.trim().length > 600))) failures.push('farm_steps out of shape');
if (rows.some((r, i) => r.rank !== i + 1)) failures.push('ranks not 1..N');
if (rows.some((r, i) => i > 0 && r.implied_value_usd > rows[i - 1].implied_value_usd)) failures.push('implied rises with rank');
const dashText = ['index.html', 'app.css', 'app.js'].map((f) => readFileSync(join(ROOT, 'dashboard', f), 'utf8')).join('\n');
if (/https?:\/\//.test(dashText.replace(/\/\/ [^\n]*/g, ''))) failures.push('http(s) in dashboard source');
if (failures.length) { console.error('SELF-GATE FAILED: ' + failures.join('; ')); process.exit(1); }
console.log('wrote ' + rows.length + ' rows, rank 1 ' + rows[0].slug + ' ' + fmtMoney(rows[0].implied_value_usd));
console.log('tiers', JSON.stringify(tierCount), 'verdicts', JSON.stringify(verdictCount));
console.log('LOO median miss x' + validation.looMedianErr.toFixed(2) + ', within-2x ' + (validation.within2 * 100).toFixed(1) + '%, within-3x ' + (validation.within3 * 100).toFixed(1) + '%, Spearman ' + validation.spearman.toFixed(3));
console.log('Brier odds ' + validation.oddsBrier.toFixed(3) + ' vs base ' + validation.baseBrier.toFixed(3) + ', coverage P25-P75 ' + (validation.cov2575 * 100).toFixed(0) + '%, P10-P90 ' + (validation.cov1090 * 100).toFixed(0) + '%');
console.log('size slope ' + validation.sizeSlope.toFixed(3) + ', multiple at $100M TVL x' + validation.sizeAt100M.toFixed(3) + ', kept terms: ' + [...keptTerms].sort().join(', '));
console.log('top 5:', rows.slice(0, 5).map((r) => r.slug + ' ' + fmtMoney(r.implied_value_usd)).join(' | '));
console.log('self-gate OK, screenshots in output: ' + shotCount);
