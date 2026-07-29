// Saf okey kuralları — hem sunucu hem (kopya olarak) istemci aynı mantığı kullanır.
export const pv = n => (n === 1 ? 11 : n);
export const K = (c, n) => c * 14 + n;

export function makeCtx(okeyC, okeyN) {
  const eC = t => (t.f ? okeyC : t.c);
  const eN = t => (t.f ? okeyN : t.n);
  const isJok = t => !t.f && t.c === okeyC && t.n === okeyN;
  return { okeyC, okeyN, eC, eN, isJok };
}

export function newDeck() {
  const d = []; let id = 0;
  for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) for (let n = 1; n <= 13; n++) d.push({ id: id++, c, n, f: 0 });
  d.push({ id: id++, c: null, n: null, f: 1 });
  d.push({ id: id++, c: null, n: null, f: 1 });
  for (let i = d.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

export function checkMeld(ts, X) {
  if (ts.length < 3) return null;
  const J = ts.filter(X.isJok).length, real = ts.filter(t => !X.isJok(t));
  if (!real.length) return null;
  let best = null;
  const n0 = X.eN(real[0]);
  if (ts.length <= 4 && real.every(t => X.eN(t) === n0)) {
    const cols = new Set(real.map(X.eC));
    if (cols.size === real.length) best = { type: 'set', points: pv(n0) * ts.length };
  }
  const c0 = X.eC(real[0]);
  if (real.every(t => X.eC(t) === c0)) {
    for (const hi of [false, true]) {
      const nums = real.map(t => (hi && X.eN(t) === 1 ? 14 : X.eN(t)));
      if (new Set(nums).size !== nums.length) continue;
      const mn = Math.min(...nums), mx = Math.max(...nums), span = mx - mn + 1;
      if (span > ts.length) continue;
      const need = span - real.length;
      if (need > J) continue;
      let left = J - need, lo = mn, hg = mx, cap = hi ? 14 : 13;
      while (left > 0) { if (hg < cap) { hg++; left--; } else if (lo > 1) { lo--; left--; } else break; }
      if (left > 0 || hg - lo + 1 !== ts.length) continue;
      let p = 0; for (let x = lo; x <= hg; x++) p += (x === 14 || x === 1) ? 11 : x;
      if (!best || p > best.points) best = { type: 'run', points: p, lo, hg, c: c0 };
    }
  }
  return best;
}

export function meldLayout(ts, X) {
  const info = checkMeld(ts, X);
  if (!info) return ts.map(t => ({ t, rep: null }));
  const joks = ts.filter(X.isJok), real = ts.filter(t => !X.isJok(t));
  if (info.type === 'set') {
    const n = X.eN(real[0]), used = new Set(real.map(X.eC));
    const miss = [0, 1, 2, 3].filter(c => !used.has(c));
    const all = real.map(t => ({ c: X.eC(t), t }));
    joks.forEach((j, k) => all.push({ c: miss[k], t: j }));
    all.sort((a, b) => a.c - b.c);
    return all.map(x => ({ t: x.t, rep: { c: x.c, n } }));
  }
  const hiRun = info.hg === 14, map = new Map();
  real.forEach(t => map.set(hiRun && X.eN(t) === 1 ? 14 : X.eN(t), t));
  const out = []; let ji = 0;
  for (let x = info.lo; x <= info.hg; x++) out.push({ t: map.has(x) ? map.get(x) : joks[ji++], rep: { c: info.c, n: x === 14 ? 1 : x } });
  return out.filter(o => o.t);
}
export function sortMeld(ts, X) { const l = meldLayout(ts, X); return l.length === ts.length ? l.map(x => x.t) : ts; }

export function isPair(ts, X) {
  if (ts.length !== 2) return false;
  if (ts.some(X.isJok)) return true;
  return X.eC(ts[0]) === X.eC(ts[1]) && X.eN(ts[0]) === X.eN(ts[1]);
}

const CANDS = (() => {
  const a = [], CB = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3], [0, 1, 2, 3]];
  for (let n = 1; n <= 13; n++) for (const cols of CB) a.push({ t: 's', n, cols, pts: pv(n) * cols.length, len: cols.length });
  for (let c = 0; c < 4; c++) for (let lo = 1; lo <= 12; lo++) for (let hg = lo + 2; hg <= 14; hg++) {
    if (hg === 14 && lo === 1) continue; if (hg - lo + 1 > 13) continue;
    let p = 0; for (let x = lo; x <= hg; x++) p += (x === 14 || x === 1) ? 11 : x;
    a.push({ t: 'r', c, lo, hg, pts: p, len: hg - lo + 1 });
  }
  return a;
})();

export function bestDecomp(tiles, X, mode) {
  const joks = tiles.filter(X.isJok);
  const stacks = new Map();
  for (const t of tiles) { if (X.isJok(t)) continue; const k = K(X.eC(t), X.eN(t)); if (!stacks.has(k)) stacks.set(k, []); stacks.get(k).push(t); }
  const cnt = new Int8Array(60); stacks.forEach((v, k) => (cnt[k] = v.length));
  const J = joks.length;
  const cs = CANDS.filter(cd => {
    let miss = 0;
    if (cd.t === 's') { for (const c of cd.cols) if (cnt[K(c, cd.n)] <= 0) miss++; }
    else for (let x = cd.lo; x <= cd.hg; x++) { const nn = x === 14 ? 1 : x; if (cnt[K(cd.c, nn)] <= 0) miss++; }
    return miss <= J;
  }).sort((a, b) => b.pts - a.pts).slice(0, 120);

  function apply(cd, jLeft) {
    const keys = []; let ju = 0;
    const put = k => { if (cnt[k] > 0) { cnt[k]--; keys.push(k); } else ju++; };
    if (cd.t === 's') for (const c of cd.cols) put(K(c, cd.n));
    else for (let x = cd.lo; x <= cd.hg; x++) put(K(cd.c, x === 14 ? 1 : x));
    if (ju > jLeft) { for (const k of keys) cnt[k]++; return null; }
    return { keys, ju };
  }
  let best = { pts: 0, used: 0, pick: [] }, nodes = 0;
  (function rec(i, jLeft, pts, used, pick) {
    if (nodes++ > 25000) return;
    const better = mode === 'tiles' ? (used > best.used || (used === best.used && pts > best.pts))
                                    : (pts > best.pts || (pts === best.pts && used > best.used));
    if (better) best = { pts, used, pick: pick.slice() };
    for (let k = i; k < cs.length; k++) {
      const r = apply(cs[k], jLeft); if (!r) continue;
      pick.push(k); rec(k + 1, jLeft - r.ju, pts + cs[k].pts, used + cs[k].len, pick); pick.pop();
      for (const kk of r.keys) cnt[kk]++;
    }
  })(0, J, 0, 0, []);

  const jp = joks.slice(), melds = [];
  for (const idx of best.pick) {
    const cd = cs[idx], grp = [];
    const take = k => { const st = stacks.get(k); if (st && st.length) grp.push(st.pop()); else if (jp.length) grp.push(jp.pop()); };
    if (cd.t === 's') for (const c of cd.cols) take(K(c, cd.n));
    else for (let x = cd.lo; x <= cd.hg; x++) take(K(cd.c, x === 14 ? 1 : x));
    if (grp.length === cd.len) melds.push(grp);
  }
  const u = new Set(); melds.forEach(m => m.forEach(t => u.add(t.id)));
  return { pts: best.pts, melds, used: u.size, left: tiles.filter(t => !u.has(t.id)) };
}

export function pairPlan(tiles, X) {
  const joks = tiles.filter(X.isJok).slice(), map = new Map();
  for (const t of tiles) { if (X.isJok(t)) continue; const k = K(X.eC(t), X.eN(t)); if (!map.has(k)) map.set(k, []); map.get(k).push(t); }
  const pairs = [], singles = [];
  map.forEach(v => { while (v.length >= 2) pairs.push([v.pop(), v.pop()]); if (v.length) singles.push(v.pop()); });
  singles.sort((a, b) => X.eN(b) - X.eN(a));
  while (joks.length && singles.length) pairs.push([singles.pop(), joks.pop()]);
  while (joks.length >= 2) pairs.push([joks.pop(), joks.pop()]);
  return pairs;
}
