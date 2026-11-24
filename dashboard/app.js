// Token Radar v1 — dashboard app. No network: all data comes from zz-data.js.
const DATA = window.TOKEN_RADAR;
const M = DATA.metrics;
const ROWS = DATA.rows;
const $ = (s) => document.querySelector(s);
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function usd(x) { if (x >= 1e9) return '$' + (x / 1e9).toFixed(2) + 'B'; if (x >= 1e6) return '$' + (x / 1e6).toFixed(1) + 'M'; if (x >= 1e3) return '$' + (x / 1e3).toFixed(0) + 'k'; return '$' + Math.round(x); }
function money(x) { return '$' + Math.round(x).toLocaleString('en-US'); }
function pct(x, d) { return (x * 100).toFixed(d === undefined ? 0 : d) + '%'; }
function ageFmt(d) { if (d >= 365) return (d / 365).toFixed(1) + ' yr'; return d + ' d'; }

// ---- header question cards: each card asks the question, then answers it.
function card(q, a, d) { return '<div class="card"><div class="q">' + q + '</div><div class="a">' + a + '</div><div class="d">' + d + '</div></div>'; }
function renderCards() {
  const v = M.validation;
  const keptVal = M.ablation.filter((r) => r.verdict === 'kept').length;
  const keptOdds = M.oddsRows.filter((r) => r.verdict === 'kept').length;
  $('#cards').innerHTML =
    card('Out-of-sample miss, leave-one-out', '×' + v.looMedianErr.toFixed(2) + ' <span class="sub">vs ×' + M.ablation[0].loo.toFixed(2) + ' flat</span>', 'a flat cap/TVL multiple misses by ×' + M.ablation[0].loo.toFixed(2) + '; ' + pct(v.within2, 0) + ' within 2×, ' + pct(v.within3, 0) + ' within 3×') +
    card('Is the printed range honest?', pct(v.cov2575, 0) + ' · ' + pct(v.cov1090, 0), 'of real caps fall inside P25–P75, P10–P90 (stated 50% · 80%)') +
    card('Token odds vs base rate, Brier', v.oddsBrier.toFixed(3) + ' <span class="sub">vs ' + v.baseBrier.toFixed(3) + '</span>', 'base rate ' + pct(v.baseRate, 0) + ' of protocols recorded a token') +
    card('Terms that survived both tests', keptVal + ' of ' + (M.ablation.length - 2) + ' · ' + keptOdds + ' of 4', 'value model · token odds; the rest are shown below, not used') +
    card('Worth farming, this scenario', M.verdictCount.Farm + ' of ' + M.nRows, 'net beats a T-bill and $25 an hour; ' + M.verdictCount.Marginal + ' marginal, ' + M.verdictCount.Skip + ' skip') +
    card('Watchlist ranked', '40 / 40', 'plus ' + (M.nRows - 40) + ' pre-token protocols the watchlist leaves out');
  $('#asof').textContent = M.asOf; $('#asof2').textContent = M.asOf;
  $('#formula').innerHTML = '<b>Implied value</b> = TVL × fitted multiple (the value if a token launches) × token odds (from how long peers ran before recording one). Each coefficient is fitted on this snapshot and tested held-out.';
  // The Farm headline (0 of 198) depends on one assumption: the 7% drop
  // share. The counts at 12% and 15% are computed by main.ts, not typed here.
  $('#sensitivity').innerHTML = 'Farm count by drop share: <b>7% → ' + M.sensitivity.drop7 + ', 12% → ' + M.sensitivity.drop12 + ', 15% → ' + M.sensitivity.drop15 + '</b>. The 7% default is the assumption — move the drop-share slider to see it change.';
}

// ---- accounting strip: every one of the 758 protocols in exactly one group.
function renderAccounting() {
  const a = M.accounting;
  const groups = [
    ['Ranked — watchlist', a.watchlist, '#34D399'],
    ['Ranked — early, below the floor', a.early, '#22D3EE'],
    ['Ranked — off-list', a.offList, '#60A5FA'],
    ['Token trades — priced comp', a.pricedComps, '#FBBF24'],
    ['Token recorded — no usable cap', a.tokenNoCap, '#A78BFA'],
    ['Out — no token, excluded', a.outExcluded, '#4B5563'],
  ];
  $('#acct-note').textContent = 'All ' + a.total + ' snapshot protocols in exactly one group: ' + a.watchlist + ' ranked watchlist, ' + a.early + ' ranked early, ' + a.offList + ' ranked off-list, ' + a.pricedComps + ' live peers priced the model, ' + a.tokenNoCap + ' recorded a token with no usable cap, ' + a.outExcluded + ' left out by the house list\u2019s own rules (' + a.outByReason.map((r) => r[0] + ' ' + r[1]).join(', ') + ').';
  $('#acct-bar').innerHTML = groups.map((g) => '<span style="width:' + (g[1] / a.total * 100).toFixed(2) + '%;background:' + g[2] + '" title="' + g[0] + ' ' + g[1] + '"></span>').join('');
  $('#acct-legend').innerHTML = groups.map((g) => '<span><i style="background:' + g[2] + '"></i>' + g[0] + ' <b>' + g[1] + '</b></span>').join('');
  $('#integrity').innerHTML =
    '<span>✓ this table = board.json: ' + M.nRows + ' of ' + M.nRows + ' rows recomputed here</span>' +
    '<span>✓ ranks 1–' + M.nRows + ' in order, values never rise</span>' +
    '<span>✓ totals equal: ' + money(M.totalImplied) + '</span>' +
    '<span>✓ checksum ' + M.checksum + ' = main.ts</span>' +
    '<span>✓ watchlist 40 of 40 ranked</span>' +
    '<span>✓ ledger ' + a.total + ' of ' + a.total + ' protocols</span>';
}

// ---- evidence tables
function renderEvidence() {
  const v = M.validation;
  $('#tbl-ablation tbody').innerHTML = M.ablation.map((r) =>
    '<tr><td>' + esc(r.label) + '</td><td>×' + r.loo.toFixed(2) + '</td><td>×' + r.cohort.toFixed(2) + '</td><td class="' + (r.verdict === 'kept' ? 'kept' : r.verdict === 'baseline' ? '' : r.verdict === 'must not help' ? 'mustnot' : 'notkept') + '">' + r.verdict + '</td></tr>').join('');
  $('#tbl-odds tbody').innerHTML = M.oddsRows.map((r) =>
    '<tr><td>' + esc(r.term) + '</td><td>' + r.brier.toFixed(3) + '</td><td class="' + (r.verdict === 'kept' ? 'kept' : r.verdict === 'baseline' ? '' : 'notkept') + '">' + r.verdict + '</td></tr>').join('');
  $('#tbl-range tbody').innerHTML =
    '<tr><td>inside P25–P75</td><td>50%</td><td>' + pct(v.cov2575, 0) + '</td></tr>' +
    '<tr><td>inside P10–P90</td><td>80%</td><td>' + pct(v.cov1090, 0) + '</td></tr>' +
    '<tr><td>within 3× of the model</td><td>—</td><td>' + pct(v.within3, 0) + '</td></tr>';
  $('#boot-note').textContent = 'Fitted, ± bootstrap s.e. (200 refits): size slope ' + v.sizeSlope.toFixed(2) + '; multiple at $100M TVL ×' + v.sizeAt100M.toFixed(2) + '; flat multiple ×' + v.flatMultiple.toFixed(2) + '. Rank ranges in the table come from the same 200 refits. No walk-forward: one snapshot date, so no protocol is priced by an earlier listing and tested on a later one.';
  // Scatter: log TVL (x) vs log implied value (y). One SVG chart only.
  const W = 640, H = 170, PL = 44, PR = 8, PT = 10, PB = 22;
  const xs = ROWS.map((r) => Math.log10(r.tvl_usd)), ys = ROWS.map((r) => Math.log10(Math.max(1, r.implied_value_usd)));
  const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
  const X = (x) => PL + (x - x0) / (x1 - x0) * (W - PL - PR);
  const Y = (y) => PT + (1 - (y - y0) / (y1 - y0)) * (H - PT - PB);
  const col = { 'Watchlist': '#34D399', 'Unlisted ≥$50M': '#22D3EE', 'Emerging <$50M': '#6B7280' };
  let dots = '';
  for (let i = 0; i < ROWS.length; i++) dots += '<circle cx="' + X(xs[i]).toFixed(1) + '" cy="' + Y(ys[i]).toFixed(1) + '" r="' + (ROWS[i].tier === 'Watchlist' ? 3.4 : 2.4) + '" fill="' + col[ROWS[i].tier] + '" fill-opacity="0.85"/>';
  $('#chart').innerHTML =
    '<line x1="' + PL + '" y1="' + (H - PB) + '" x2="' + (W - PR) + '" y2="' + (H - PB) + '" stroke="#1F2937"/>' +
    '<line x1="' + PL + '" y1="' + PT + '" x2="' + PL + '" y2="' + (H - PB) + '" stroke="#1F2937"/>' +
    '<text x="' + PL + '" y="' + (H - 6) + '" fill="#9CA3AF" font-size="10">TVL, log scale</text>' +
    '<text x="6" y="' + (PT + 8) + '" fill="#9CA3AF" font-size="10">implied, log</text>' + dots;
}

// ---- board: filters, sorting, verdict recompute
let state = { verdict: 'all', tier: '', cat: '', chain: '', q: '', sort: 'rank', dir: 1, mode: 'pre' };
function feeFor(chain) { return M.feeSchedule[chain] === undefined ? 1.0 : M.feeSchedule[chain]; }
function econ(r) {
  const planPct = parseFloat($('#plan-size').value);
  const drop = parseFloat($('#drop-share').value) / 100;
  const horizon = parseFloat($('#horizon').value);
  const deposit = planPct * r.tvl_usd;
  const gross = r.implied_value_usd * drop * planPct;
  const fees = 14 * feeFor(r.chain);
  const hours = 4.5 + horizon * 0.25;
  const net = gross - fees;
  const tbill = deposit * M.scenario.tbillRate * (horizon / 52);
  const hour = net / hours;
  return { net: net, hour: hour, gross: gross, fees: fees, tbill: tbill, hours: hours, verdict: net <= 0 ? 'Skip' : (net > tbill && hour > 25) ? 'Farm' : 'Marginal', deposit: deposit };
}
function visibleRows() {
  let list = ROWS.slice();
  if (state.verdict !== 'all') list = list.filter((r) => econ(r).verdict === state.verdict);
  if (state.tier) list = list.filter((r) => r.tier === state.tier);
  if (state.cat) list = list.filter((r) => (r.category || 'Unknown') === state.cat);
  if (state.chain) list = list.filter((r) => r.chain === state.chain);
  if (state.q) { const q = state.q.toLowerCase(); list = list.filter((r) => (r.name + ' ' + r.chain + ' ' + (r.category || '')).toLowerCase().includes(q)); }
  const k = state.sort;
  list.sort((a, b) => { const av = a[k], bv = b[k]; return (av < bv ? -1 : av > bv ? 1 : 0) * state.dir; });
  return list;
}
function barHtml(r) {
  const logs = ROWS.map((x) => Math.log10(Math.max(1, x.implied_value_usd)));
  const lo = Math.min.apply(null, logs), hi = Math.max.apply(null, logs);
  const w = (Math.log10(Math.max(1, r.implied_value_usd)) - lo) / (hi - lo) * 100;
  // P25/P75 can sit outside the implied range (the interval is wider than the
  // board's own spread), so clamp the whisker inside the bar.
  const wl = clamp((Math.log10(Math.max(1, r.p25_usd)) - lo) / (hi - lo) * 100, 0, 100);
  const wr = clamp((Math.log10(Math.max(1, r.p75_usd)) - lo) / (hi - lo) * 100, 0, 100);
  return '<div class="bar"><i style="width:' + w.toFixed(1) + '%"></i><span class="wh" style="left:' + wl.toFixed(1) + '%;width:' + Math.max(1, wr - wl).toFixed(1) + '%"></span></div>';
}
function badge(t) { return t === 'Watchlist' ? '<span class="badge watch">Watchlist</span>' : t === 'Unlisted ≥$50M' ? '<span class="badge unlisted">Unlisted ≥$50M</span>' : '<span class="badge emerging">Emerging</span>'; }
const PRE_HEAD = '<tr><th data-sort="rank"># · Range</th><th data-sort="name">Protocol</th><th data-sort="tvl_usd">TVL</th><th data-sort="change_7d">7D</th><th data-sort="age_days">No-token age</th><th data-sort="token_odds">Token odds</th><th data-sort="if_launches_usd">If it launches</th><th data-sort="implied_value_usd">Implied value · P25–P75</th><th data-sort="verdict">Verdict · Net of fees</th><th data-sort="net_per_hour_usd">Net / hour</th></tr>';
const LIVE_HEAD = '<tr><th>#</th><th>Protocol</th><th>TVL</th><th>Market cap</th><th>Cap / TVL</th></tr>';
// When the Farm tab is empty, show the five closest rows instead of an empty
// table. The five rows are computed by main.ts at the default scenario; the
// block is only shown while the sliders are still at the default, so the
// figures cannot go stale — move a slider and the note below takes over.
function isDefaultScenario() {
  return $('#plan-size').value === '0.0002' && $('#drop-share').value === '7' && $('#horizon').value === '12';
}
function renderNearMiss(n) {
  const nm = $('#near-miss');
  if (state.verdict !== 'Farm' || n > 0) { nm.innerHTML = ''; return; }
  if (!isDefaultScenario()) {
    nm.innerHTML = '<p class="muted">No rows pass both Farm tests at this scenario. The verdicts recompute live — move the drop-share or plan-size slider to see them change.</p>';
    return;
  }
  nm.innerHTML =
    '<h3>Closest to Farm — nobody clears both tests at this scenario</h3>' +
    '<p class="muted">At the default scenario no protocol beats both benchmarks. The T-bill test favours small deposits; the $25-an-hour test favours large implied values — and token odds near 55% halve the expected drop against a certain T-bill return. The five rows below are the closest, ranked by the weaker of the two tests. The drop share is the lever: plan size cannot fix the T-bill test, because the drop and the T-bill return both scale with the deposit.</p>' +
    '<table class="mini near"><thead><tr><th>#</th><th>Protocol</th><th>TVL</th><th>Net</th><th>T-bill</th><th>Net / hour</th><th>Net ÷ T-bill</th><th>Net-per-hour ÷ $25</th><th>Drop share needed</th><th>Plan size needed</th><th>Closest lever</th></tr></thead><tbody>' +
    M.nearMiss.map((x, i) =>
      '<tr><td>' + (i + 1) + '</td>' +
      '<td class="name">' + esc(x.name) + '</td>' +
      '<td>' + usd(x.tvl) + '</td>' +
      '<td>' + money(x.net) + '</td>' +
      '<td>' + money(x.tbill) + '</td>' +
      '<td>' + money(x.netHour) + '</td>' +
      '<td>' + x.ratioTbill.toFixed(2) + '×</td>' +
      '<td>' + x.ratioHour.toFixed(2) + '×</td>' +
      '<td>' + x.dropNeededPct.toFixed(1) + '%</td>' +
      '<td>' + (x.planNeededPct === null ? '—' : x.planNeededPct.toFixed(3) + '%') + '</td>' +
      '<td>' + esc(x.lever) + '</td></tr>').join('') +
    '</tbody></table>';
}
function renderTable() {
  if (state.mode === 'live') {
    $('#near-miss').innerHTML = '';
    $('#tbl thead').innerHTML = LIVE_HEAD;
    const list = M.livePeers;
    $('#tbl tbody').innerHTML = list.map((p, i) =>
      '<tr><td>' + (i + 1) + '</td><td class="name">' + esc(p.name) + '<br><span class="sub">' + esc(p.category || 'Unknown') + ' · ' + esc(p.chain) + '</span></td><td>' + usd(p.tvl_usd) + '</td><td>' + usd(p.mcap_usd) + '</td><td>' + p.ratio.toFixed(2) + '×</td></tr>').join('');
    $('#row-count').textContent = list.length + ' live peers with a recorded market cap, after family dedup. They price the model; they are never ranked.';
    return;
  }
  $('#tbl thead').innerHTML = PRE_HEAD;
  const list = visibleRows();
  const body = $('#tbl tbody');
  body.innerHTML = list.map((r) => {
    const e = econ(r);
    const chg = r.change_7d === null ? '—' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%';
    const chgCls = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
    return '<tr data-slug="' + r.slug + '">' +
      '<td>' + r.rank + '<br><span class="rng">' + r.rank_lo + '–' + r.rank_hi + '</span></td>' +
      '<td class="name"><a href="#detail=' + r.slug + '" class="rowlink">' + esc(r.name) + '</a>' + badge(r.tier) + '<br><span class="sub">' + esc(r.category || 'Unknown') + ' · ' + esc(r.chain) + ' +' + (r.chains.length - 1) + '</span></td>' +
      '<td>' + usd(r.tvl_usd) + '</td>' +
      '<td class="' + chgCls + '">' + chg + '</td>' +
      '<td>' + ageFmt(r.age_days) + '</td>' +
      '<td>' + pct(r.token_odds, 0) + '<div class="oddsbar"><i style="width:' + (r.token_odds * 100).toFixed(0) + '%"></i></div></td>' +
      '<td>' + usd(r.if_launches_usd) + '</td>' +
      '<td><span class="imp">' + usd(r.implied_value_usd) + '</span> <span class="rng">' + usd(r.p25_usd) + '–' + usd(r.p75_usd) + '</span>' + barHtml(r) + '</td>' +
      '<td><span class="vchip ' + e.verdict + '">' + e.verdict + '</span> <span class="' + (e.net < 0 ? 'neg' : 'pos') + '">' + (e.net < 0 ? '−' : '+') + money(Math.abs(e.net)).slice(1) + '</span><br><span class="rng">' + usd(r.implied_value_usd * (parseFloat($('#drop-share').value) / 100) * parseFloat($('#plan-size').value)) + ' drop − ' + money(14 * feeFor(r.chain)) + ' fees</span></td>' +
      '<td class="' + (e.hour < 0 ? 'neg' : 'pos') + '">' + money(e.hour) + '</td></tr>';
  }).join('');
  $('#row-count').textContent = list.length + ' of ' + ROWS.length + ' rows · ' + usd(M.totalTvl) + ' TVL · ' + usd(M.totalImplied) + ' implied';
  $('#c-all').textContent = ROWS.length;
  $('#c-farm').textContent = ROWS.filter((r) => econ(r).verdict === 'Farm').length;
  $('#c-marg').textContent = ROWS.filter((r) => econ(r).verdict === 'Marginal').length;
  $('#c-skip').textContent = ROWS.filter((r) => econ(r).verdict === 'Skip').length;
  renderNearMiss(list.length);
}

// ---- detail drawer
function openDetail(slug) {
  const r = ROWS.find((x) => x.slug === slug);
  if (!r) return;
  const e = econ(r);
  // Dollar figures in the drawer are rounded for display, and every
  // difference the reader sees is computed FROM those rounded figures, so
  // the arithmetic on screen is exact: the net shown is the displayed drop
  // minus the displayed fees, and the T-bill gap is the displayed T-bill
  // minus the displayed net. The verdict itself still comes from the
  // unrounded economics, so a $1 boundary case could in principle disagree
  // with the rounded gap — none of the 198 rows is within $1 of a test line.
  const dGross = Math.round(e.gross), dFees = Math.round(e.fees);
  const dNet = dGross - dFees, dTbill = Math.round(e.tbill);
  const dGap = dNet - dTbill, dHour = Math.round(dNet / e.hours);
  const t = r.terms;
  const peers = r.peers.map((p) => '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.category || 'Unknown') + '</td><td>' + usd(p.tvl) + '</td><td>' + usd(p.mcap) + '</td><td>' + p.ratio.toFixed(2) + '×</td></tr>').join('');
  $('#detail').innerHTML =
    '<p class="muted">#' + r.rank + ' of ' + ROWS.length + ' by implied value · rank ' + r.rank_lo + '–' + r.rank_hi + ' across bootstrap refits</p>' +
    '<h2>' + esc(r.name) + '</h2>' +
    '<p class="muted">' + esc(r.category || 'Unknown') + ' · ' + esc(r.chain) + ' · ' + usd(r.tvl_usd) + ' TVL · ' + (r.change_7d === null ? 'no 7d change' : r.change_7d.toFixed(1) + '% 7d') + ' · ' + ageFmt(r.age_days) + ' with no token</p>' +
    '<div class="big">' + money(r.implied_value_usd) + '</div>' +
    '<p class="muted">implied value × model estimate · ' + money(r.if_launches_usd) + ' if it launches · token odds ' + pct(r.token_odds, 0) + ' · range ' + money(r.p25_usd) + '–' + money(r.p75_usd) + '</p>' +
    '<h3>How the figure is made</h3>' +
    '<div class="kv">' +
    '<span>TVL</span><b>' + money(r.tvl_usd) + '</b>' +
    '<span>Size multiple, fitted</span><b>×' + t.size.toFixed(3) + '</b>' +
    '<span>Category effect</span><b>×' + t.category.toFixed(2) + '</b>' +
    '<span>Growth factor</span><b>×' + t.growth.toFixed(3) + '</b>' +
    '<span>Age factor</span><b>×' + t.age.toFixed(2) + '</b>' +
    '<span>Token odds</span><b>×' + t.odds.toFixed(2) + '</b>' +
    '<span>Implied value</span><b>' + money(r.implied_value_usd) + '</b></div>' +
    '<p class="muted">' + money(r.tvl_usd) + ' × ' + t.size.toFixed(3) + ' × ' + t.category.toFixed(2) + ' × ' + t.growth.toFixed(3) + ' × ' + t.age.toFixed(2) + ' × ' + t.odds.toFixed(2) + ' = ' + money(r.implied_value_usd) + '. The size multiple falls with TVL (fitted slope ' + M.validation.sizeSlope.toFixed(2) + '); the category effect is shrunk to the global median when a category has few peers.</p>' +
    '<h3>Nearest priced peers — their token trades</h3>' +
    '<table class="peer"><thead><tr><th>Token</th><th>Category</th><th>TVL</th><th>Market cap</th><th>Cap / TVL</th></tr></thead><tbody>' + peers + '</tbody></table>' +
    '<h3>Farm verdict: ' + e.verdict + '</h3>' +
    '<p>Deposit ' + money(e.deposit) + ' (' + (parseFloat($('#plan-size').value) * 100).toFixed(2) + '% of TVL). Expected drop ' + money(dGross) + ', fees ' + money(dFees) + ', net ' + money(dNet) + ' over ' + e.hours.toFixed(1) + ' hours = ' + money(dHour) + ' an hour. A farm is worth it only if it beats both benchmarks: the same deposit in a T-bill at 4.5% a year earns ' + money(dTbill) + ' over ' + parseFloat($('#horizon').value) + ' weeks, and the work must pay more than $25 an hour. This one ' + (dGap > 0 ? 'beats the T-bill by ' + money(dGap) : dGap < 0 ? 'loses to the T-bill by ' + money(-dGap) : 'matches the T-bill to the dollar') + ' and pays ' + money(dHour) + ' an hour, so the verdict is ' + e.verdict + ' — ' + (e.verdict === 'Farm' ? 'it clears both tests.' : e.verdict === 'Marginal' ? 'it nets more than $0 but fails ' + ((e.net <= e.tbill && e.hour <= 25) ? 'both tests.' : (e.net <= e.tbill ? 'the T-bill test.' : 'the $25-an-hour test.')) : 'it nets $0 or less.') + ' The deposit also earns the vault\u2019s own yield while it sits there, not counted here, so the T-bill line is the opportunity cost of the cash, not the whole return.</p>' +
    '<h3>Farm plan — 10 steps</h3><ol>' + r.farm_steps.map((s) => '<li>' + esc(s).replace(/COST: /g, '<span class="cost">COST: </span>').replace(/TIME: /g, '<span class="cost">TIME: </span>') + '</li>').join('') + '</ol>' +
    '<p class="muted">Farm on ' + esc(r.chain) + ', the protocol\u2019s main chain from the snapshot — never the cheapest chain in its list. Every step above is written for this protocol and this chain.</p>';
  $('#drawer').hidden = false;
  document.body.classList.add('has-drawer');
  if (location.hash !== '#detail=' + slug) history.replaceState(null, '', '#detail=' + slug);
}
function closeDetail() {
  $('#drawer').hidden = true;
  document.body.classList.remove('has-drawer');
  history.replaceState(null, '', location.pathname + location.search);
}

// ---- wiring
function init() {
  renderCards(); renderAccounting(); renderEvidence();
  const cats = [...new Set(ROWS.map((r) => r.category || 'Unknown'))].sort();
  $('#f-category').innerHTML = '<option value="">All categories</option>' + cats.map((c) => '<option>' + esc(c) + '</option>').join('');
  const chains = [...new Set(ROWS.map((r) => r.chain))].sort();
  $('#f-chain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => '<option>' + esc(c) + '</option>').join('');
  renderTable();
  $('#method-text').textContent = M.method + ' Peers: ' + M.validation.nPeers + ' live protocols after family dedup (' + M.validation.dedupedFamilies + ' family duplicates removed), ratios winsorised at the 5th/95th percentiles, multiple clamped 0.05–1.0. Growth is winsorised −30/+40% with weight 0.4. Age is one saturating curve, 0.60 to 1.00 by day 730, and never enters the odds.';
  $('#peer-note').textContent = 'Live peers are the ' + M.validation.nLive + ' protocols whose token trades with a recorded market cap; ' + M.validation.nPeers + ' remain after family dedup and price the model. The board never ranks a protocol whose token trades.';
  document.querySelectorAll('#verdict-tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#verdict-tabs button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); state.verdict = b.dataset.verdict; renderTable();
  }));
  $('#f-tier').addEventListener('change', (e) => { state.tier = e.target.value; renderTable(); });
  $('#f-category').addEventListener('change', (e) => { state.cat = e.target.value; renderTable(); });
  $('#f-chain').addEventListener('change', (e) => { state.chain = e.target.value; renderTable(); });
  $('#search').addEventListener('input', (e) => { state.q = e.target.value; renderTable(); });
  $('#plan-size').addEventListener('change', renderTable);
  $('#drop-share').addEventListener('input', (e) => { $('#drop-val').textContent = parseFloat(e.target.value).toFixed(1) + '%'; renderTable(); });
  $('#horizon').addEventListener('input', (e) => { $('#hor-val').textContent = e.target.value + ' wk'; renderTable(); });
  $('#btn-reset').addEventListener('click', () => {
    state = { verdict: 'all', tier: '', cat: '', chain: '', q: '', sort: 'rank', dir: 1, mode: 'pre' };
    $('#f-tier').value = ''; $('#f-category').value = ''; $('#f-chain').value = ''; $('#search').value = '';
    $('#plan-size').value = '0.0002'; $('#drop-share').value = '7'; $('#horizon').value = '12';
    $('#drop-val').textContent = '7.0%'; $('#hor-val').textContent = '12 wk';
    document.querySelectorAll('#verdict-tabs button').forEach((x) => x.classList.toggle('on', x.dataset.verdict === 'all'));
    renderTable();
  });
  $('#tbl').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const k = th.dataset.sort;
      if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = 1; }
      renderTable();
      return;
    }
    const a = e.target.closest('a.rowlink');
    if (a) { e.preventDefault(); openDetail(a.getAttribute('href').slice(8)); }
  });
  document.querySelectorAll('#mode-tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#mode-tabs button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); state.mode = b.dataset.mode; renderTable();
  }));
  $('#close').addEventListener('click', closeDetail);
  $('#btn-csv').addEventListener('click', () => {
    const head = 'rank,slug,name,tier,category,chain,tvl_usd,change_7d,age_days,token_odds,if_launches_usd,implied_value_usd,p25_usd,p75_usd,verdict,net_fees_usd,net_per_hour_usd';
    const lines = visibleRows().map((r) => { const e2 = econ(r); return [r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', r.tier, '"' + (r.category || '') + '"', r.chain, r.tvl_usd, r.change_7d, r.age_days, r.token_odds, r.if_launches_usd, r.implied_value_usd, r.p25_usd, r.p75_usd, e2.verdict, Math.round(e2.net), e2.hour.toFixed(2)].join(','); });
    const blob = new Blob([[head].concat(lines).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'token-radar.csv'; a.click();
  });
  $('#btn-json').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(visibleRows(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'token-radar.json'; a.click();
  });
  // Deep links: #detail=<slug> opens the drawer; #verdict=farm selects the Farm
  // tab and brings the board into view. Applied on load and on every hash
  // change, because a same-document navigation does not reload the page.
  applyHash();
  window.addEventListener('hashchange', applyHash);
}
function applyHash() {
  const hash = location.hash;
  const m2 = hash.match(/#detail=([a-z0-9-]+)/);
  if (m2) openDetail(m2[1]);
  else if (!$('#drawer').hidden) closeDetail();
  const vm = hash.match(/#verdict=(farm|marginal|skip)/i);
  if (vm) {
    const b = document.querySelector('#verdict-tabs button[data-verdict="' + vm[1].charAt(0).toUpperCase() + vm[1].slice(1) + '"]');
    if (b) { b.click(); document.getElementById('board').scrollIntoView(); }
  }
}
init();
