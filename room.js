import { DurableObject } from 'cloudflare:workers';
import { makeCtx, newDeck, checkMeld, sortMeld, meldLayout, isPair, bestDecomp, pairPlan, pv, K } from './engine.js';

const NAMES = ['Oyuncu 1', 'Oyuncu 2', 'Oyuncu 3', 'Oyuncu 4'];
const BOT = ['Ayla', 'Kerem', 'Deniz', 'Selin'];

export class OkeyRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.seats = [null, null, null, null];   // {id,name,bot}
    this.cfg = { mode: 'klasik', esli: 0, hands: 5, lvl: 1, rdraw: 'kapali', pen: 1 };
    this.g = null;
    this.log = [];
    this.host = null;
    this.timer = null;
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket bekleniyor', { status: 426 });
    const url = new URL(req.url);
    const name = (url.searchParams.get('ad') || '').slice(0, 12) || 'Oyuncu';
    const pair = new WebSocketPair();
    const ws = pair[1];
    this.ctx.acceptWebSocket(ws);

    const seat = this.seats.findIndex(s => !s || s.bot);
    if (seat < 0) { ws.send(JSON.stringify({ t: 'err', m: 'Oda dolu' })); ws.close(1000); return new Response(null, { status: 101, webSocket: pair[0] }); }
    const id = crypto.randomUUID();
    ws.serializeAttachment({ id, seat });
    this.seats[seat] = { id, name, bot: false };
    if (this.host === null) this.host = id;
    this.note(name + ' katıldı');
    this.broadcast();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketClose(ws) { this.drop(ws); }
  webSocketError(ws) { this.drop(ws); }
  drop(ws) {
    const a = ws.deserializeAttachment(); if (!a) return;
    const s = this.seats[a.seat];
    if (s && s.id === a.id) {
      if (this.g) { s.bot = true; this.note(s.name + ' ayrıldı, yerine bot geçti'); }
      else { this.seats[a.seat] = null; this.note(s.name + ' ayrıldı'); }
    }
    if (this.host === a.id) this.host = (this.seats.find(x => x && !x.bot) || {}).id ?? null;
    this.broadcast();
    if (this.g) this.maybeBot();
  }

  async webSocketMessage(ws, raw) {
    const a = ws.deserializeAttachment(); if (!a) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    const k = a.seat;
    try { this.handle(k, a.id, m, ws); }
    catch (e) { ws.send(JSON.stringify({ t: 'err', m: String(e.message || e) })); }
    this.broadcast();
    this.maybeBot();
  }

  /* ---------------- oyun kurulumu ---------------- */
  handle(k, id, m, ws) {
    if (m.t === 'cfg') { if (id !== this.host || this.g) return; Object.assign(this.cfg, m.cfg || {}); return; }
    if (m.t === 'start') {
      if (id !== this.host || this.g) return;
      for (let i = 0; i < 4; i++) if (!this.seats[i]) this.seats[i] = { id: 'bot' + i, name: BOT[i], bot: true };
      this.newGame(); return;
    }
    if (!this.g || this.g.over) return;
    const G = this.g;
    if (k !== G.turn) throw new Error('Sıra sende değil');
    const X = this.X();
    const own = ids => ids.map(i => { const t = G.hands[k].find(x => x.id === i); if (!t) throw new Error('O taş sende değil'); return t; });

    switch (m.t) {
      case 'draw': {
        if (G.phase !== 'draw') throw new Error('Zaten çektin');
        if (!G.pile.length) return this.endHand(null, {});
        G.hands[k].push(G.pile.pop()); G.phase = 'discard'; break;
      }
      case 'take': {
        if (G.phase !== 'draw') throw new Error('Zaten çektin');
        const lp = (k + 3) % 4, d = G.disc[lp];
        if (!d.length) throw new Error('Solda taş yok');
        if (!G.opened[k] && this.cfg.rdraw === 'kapali') throw new Error('Açmadan yerden alamazsın');
        const t = d.pop(); G.hands[k].push(t); G.took = t.id; G.phase = 'discard';
        if (!G.opened[k]) G.mustOpen = k;
        break;
      }
      case 'open': case 'lay': {
        if (G.phase !== 'discard') throw new Error('Önce taş çek');
        const groups = (m.melds || []).map(own);
        if (m.pairs) {
          if (G.opened[k] && !G.pairs[k]) throw new Error('Çift koyamazsın');
          if (!G.opened[k] && groups.length < 5) throw new Error('Çift açmak için 5 çift gerek');
          for (const gp of groups) if (!isPair(gp, X)) throw new Error('Geçersiz çift');
          if (groups.flat().length >= G.hands[k].length) throw new Error('Atacak taş kalmalı');
          groups.forEach(gp => { this.pull(k, gp); G.melds[k].push({ tiles: gp, pair: 1 }); });
          G.opened[k] = 1; G.pairs[k] = 1; G.justOpened[k] = 1;
          this.note(this.nm(k) + ' çift açtı');
        } else {
          if (G.pairs[k]) throw new Error('Çift açan per koyamaz');
          let pts = 0;
          for (const gp of groups) { const v = checkMeld(gp, X); if (!v) throw new Error('Geçersiz per'); pts += v.points; }
          if (groups.flat().length >= G.hands[k].length) throw new Error('Atacak taş kalmalı');
          const need = G.opened[k] ? 0 : (this.cfg.mode === 'katlamali' ? G.baraj : 101);
          if (need && pts < need) throw new Error(need + ' puan gerek, sende ' + pts);
          groups.forEach(gp => { this.pull(k, gp); G.melds[k].push({ tiles: sortMeld(gp, X), pair: 0 }); });
          if (need) { G.opened[k] = 1; G.justOpened[k] = 1;
            if (this.cfg.mode === 'katlamali') G.baraj = Math.max(G.baraj, pts + 1);
            this.note(this.nm(k) + ' açtı (' + pts + ')'); }
          else this.note(this.nm(k) + ' yere per koydu');
        }
        break;
      }
      case 'add': {
        if (G.phase !== 'discard') throw new Error('Önce taş çek');
        if (!G.opened[k]) throw new Error('Önce açmalısın');
        if (G.justOpened[k]) throw new Error('Açtığın turda işleyemezsin');
        if (G.pairs[k]) throw new Error('Çift açan işleyemez');
        const md = G.melds[m.pi][m.mi]; if (!md || md.pair) throw new Error('Bu pere işlenemez');
        const [t] = own([m.id]);
        const nt = md.tiles.concat(t);
        if (!checkMeld(nt, X)) throw new Error('Bu taş bu pere işlenmez');
        md.tiles = sortMeld(nt, X); this.pull(k, [t]);
        break;
      }
      case 'swap': {
        if (G.phase !== 'discard') throw new Error('Önce taş çek');
        if (!G.opened[k]) throw new Error('Önce açmalısın');
        const md = G.melds[m.pi][m.mi]; if (!md) throw new Error('Per yok');
        const [t] = own([m.id]);
        if (X.isJok(t)) throw new Error('Okeyle okey alınmaz');
        const lay = md.pair ? this.pairLay(md.tiles, X) : meldLayout(md.tiles, X);
        const hit = lay.find(x => X.isJok(x.t) && x.rep && x.rep.c === X.eC(t) && x.rep.n === X.eN(t));
        if (!hit) throw new Error('Bu taş o okeyin yerine geçmiyor');
        md.tiles = md.tiles.map(y => (y.id === hit.t.id ? t : y));
        if (!md.pair) md.tiles = sortMeld(md.tiles, X);
        this.pull(k, [t]); G.hands[k].push(hit.t);
        if (this.cfg.pen && m.pi !== k) G.pen[m.pi] += 101;
        this.note(this.nm(k) + ', ' + this.nm(m.pi) + " okeyini aldı");
        break;
      }
      case 'discard': {
        if (G.phase !== 'discard') throw new Error('Önce taş çek');
        if (G.took === m.id) throw new Error('Yerden aldığın taşı aynı tur atamazsın');
        const [t] = own([m.id]);
        const fin = G.hands[k].length === 1 && G.opened[k];
        this.pull(k, [t]); G.disc[k].push(t);
        if (this.cfg.pen && !fin && this.islek(t)) { G.pen[k] += 101; this.note(this.nm(k) + ' işlek attı +101'); }
        if (this.cfg.pen && G.mustOpen === k && !G.opened[k]) { G.pen[k] += 101; this.note(this.nm(k) + ' alıp açamadı +101'); }
        G.mustOpen = null; G.took = null;
        this.note(this.nm(k) + ': ' + this.tn(t) + ' attı');
        if (!G.hands[k].length && G.opened[k]) return this.endHand(k, { okey: X.isJok(t), elden: !!G.justOpened[k], pairs: !!G.pairs[k] });
        G.turn = (k + 1) % 4; G.justOpened[G.turn] = 0; G.phase = 'draw';
        break;
      }
      case 'next': { if (id !== this.host) return; if (G.over) this.nextHand(); break; }
    }
  }

  /* ---------------- yardımcılar ---------------- */
  X() { return makeCtx(this.g.okeyC, this.g.okeyN); }
  nm(k) { return this.seats[k] ? this.seats[k].name : NAMES[k]; }
  tn(t) { return t.f ? '★' : (['K', 'S', 'M', 'Y'][t.c] + t.n); }
  note(m) { this.log.push(m); if (this.log.length > 20) this.log.shift(); }
  pull(k, ts) { const ids = new Set(ts.map(t => t.id)); this.g.hands[k] = this.g.hands[k].filter(t => !ids.has(t.id)); }
  pairLay(ts, X) {
    const j = ts.filter(X.isJok), r = ts.filter(t => !X.isJok(t));
    if (j.length === 1 && r.length === 1) return [{ t: r[0], rep: null }, { t: j[0], rep: { c: X.eC(r[0]), n: X.eN(r[0]) } }];
    return ts.map(t => ({ t, rep: null }));
  }
  islek(t) {
    const X = this.X();
    for (const ms of this.g.melds) for (const md of ms) if (!md.pair && checkMeld(md.tiles.concat(t), X)) return true;
    return false;
  }

  newGame() {
    this.g = { score: [0, 0, 0, 0], handNo: 1, starter: (Math.random() * 4) | 0, over: false };
    this.startHand();
  }
  nextHand() {
    const G = this.g;
    if (G.handNo >= this.cfg.hands) { this.g = null; this.log = ['Oyun bitti']; return; }
    G.handNo++; G.starter = (G.starter + 1) % 4; this.startHand();
  }
  startHand() {
    const G = this.g, deck = newDeck();
    const gi = deck.findIndex(t => !t.f), ind = deck.splice(gi, 1)[0];
    G.okeyC = ind.c; G.okeyN = ind.n === 13 ? 1 : ind.n + 1; G.ind = ind;
    G.hands = [[], [], [], []]; G.melds = [[], [], [], []]; G.disc = [[], [], [], []];
    G.opened = [0, 0, 0, 0]; G.pairs = [0, 0, 0, 0]; G.justOpened = [0, 0, 0, 0]; G.pen = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) { const c = i === G.starter ? 22 : 21; for (let x = 0; x < c; x++) G.hands[i].push(deck.pop()); }
    G.pile = deck; G.turn = G.starter; G.phase = 'discard';
    G.baraj = 101; G.took = null; G.mustOpen = null; G.over = false; G.result = null;
    this.log = ['El ' + G.handNo + ' başladı'];
  }
  endHand(win, inf) {
    const G = this.g, X = this.X();
    G.over = true;
    const mult = win !== null && inf.pairs ? 2 : 1, rows = [];
    for (let i = 0; i < 4; i++) {
      let d = G.pen[i];
      if (i === win) { let b = 101; if (inf.okey) b *= 2; if (inf.elden) b *= 2; d -= b; }
      else if (!G.opened[i]) d += 202 * mult;
      else { let v = 0; G.hands[i].forEach(t => { v += X.isJok(t) ? 101 : pv(X.eN(t)); }); d += v * mult; }
      G.score[i] += d; rows.push({ name: this.nm(i), d, s: G.score[i], win: i === win });
    }
    G.result = { win, rows, last: G.handNo >= this.cfg.hands, inf };
    this.note(win === null ? 'Deste bitti' : this.nm(win) + ' eli bitirdi');
  }

  /* ---------------- botlar ---------------- */
  maybeBot() {
    if (this.timer) return;
    const G = this.g;
    if (!G || G.over) return;
    const s = this.seats[G.turn];
    if (!s || !s.bot) return;
    this.timer = true;
    this.ctx.waitUntil((async () => {
      await new Promise(r => setTimeout(r, 700));
      this.timer = null;
      try { this.botMove(); } catch (e) { }
      this.broadcast();
      this.maybeBot();
    })());
  }
  botMove() {
    const G = this.g; if (!G || G.over) return;
    const k = G.turn, X = this.X(), H = () => G.hands[k];
    if (G.phase === 'draw') {
      const lp = (k + 3) % 4, d = G.disc[lp], top = d[d.length - 1];
      let take = false;
      if (top && (G.opened[k] || this.cfg.rdraw !== 'kapali')) {
        const a = bestDecomp(H(), X, 'points').pts, b = bestDecomp(H().concat(top), X, 'points').pts;
        take = b > a || X.isJok(top);
        if (!G.opened[k]) { const nd = this.cfg.mode === 'katlamali' ? G.baraj : 101;
          if (bestDecomp(H().concat(top), X, 'points').pts < nd) take = false; }
      }
      if (take) { d.pop(); H().push(top); G.took = top.id; if (!G.opened[k]) G.mustOpen = k; }
      else { if (!G.pile.length) return this.endHand(null, {}); H().push(G.pile.pop()); }
      G.phase = 'discard';
    }
    // açma / yere koyma
    const need = this.cfg.mode === 'katlamali' ? G.baraj : 101;
    if (!G.opened[k]) {
      const dd = bestDecomp(H(), X, 'points');
      if (dd.pts >= need && dd.melds.flat().length < H().length) {
        dd.melds.forEach(gp => { this.pull(k, gp); G.melds[k].push({ tiles: sortMeld(gp, X), pair: 0 }); });
        G.opened[k] = 1; G.justOpened[k] = 1;
        if (this.cfg.mode === 'katlamali') G.baraj = Math.max(G.baraj, dd.pts + 1);
        this.note(this.nm(k) + ' açtı (' + dd.pts + ')');
      }
    } else if (!G.pairs[k]) {
      const dd = bestDecomp(H(), X, 'tiles');
      if (dd.melds.length && dd.melds.flat().length < H().length)
        dd.melds.forEach(gp => { this.pull(k, gp); G.melds[k].push({ tiles: sortMeld(gp, X), pair: 0 }); });
      if (!G.justOpened[k]) {
        let go = true;
        while (go && H().length > 1) {
          go = false;
          for (const t of H().slice()) {
            for (let pi = 0; pi < 4 && !go; pi++) for (let mi = 0; mi < G.melds[pi].length; mi++) {
              const md = G.melds[pi][mi]; if (md.pair) continue;
              const nt = md.tiles.concat(t);
              if (checkMeld(nt, X)) { md.tiles = sortMeld(nt, X); this.pull(k, [t]); go = true; break; }
            }
            if (go) break;
          }
        }
      }
    } else {
      const prs = pairPlan(H(), X);
      let ms = prs.slice();
      while (ms.length && ms.flat().length >= H().length) ms.pop();
      ms.forEach(gp => { this.pull(k, gp); G.melds[k].push({ tiles: gp, pair: 1 }); });
    }
    // atma
    let pool = bestDecomp(H(), X, 'points').left; if (!pool.length) pool = H().slice();
    let cand = pool.filter(t => t.id !== G.took && !X.isJok(t));
    if (!cand.length) cand = pool.filter(t => t.id !== G.took);
    if (!cand.length) cand = H().slice();
    const fin = H().length === 1 && G.opened[k];
    if (!fin) { const safe = cand.filter(t => !this.islek(t)); if (safe.length) cand = safe; }
    const conn = t => H().reduce((s, o) => s + (o.id === t.id ? 0 :
      (X.isJok(o) ? 2 : ((X.eN(o) === X.eN(t) && X.eC(o) !== X.eC(t)) ? 2 : 0) +
        ((X.eC(o) === X.eC(t) && Math.abs(X.eN(o) - X.eN(t)) === 1) ? 2 : 0))), 0);
    cand.sort((a, b) => conn(a) - conn(b) || X.eN(b) - X.eN(a));
    const t = cand[0];
    this.pull(k, [t]); G.disc[k].push(t);
    if (this.cfg.pen && !fin && this.islek(t)) G.pen[k] += 101;
    if (this.cfg.pen && G.mustOpen === k && !G.opened[k]) G.pen[k] += 101;
    G.mustOpen = null; G.took = null;
    this.note(this.nm(k) + ': ' + this.tn(t) + ' attı');
    if (!H().length && G.opened[k]) return this.endHand(k, { okey: X.isJok(t), elden: !!G.justOpened[k], pairs: !!G.pairs[k] });
    G.turn = (k + 1) % 4; G.justOpened[G.turn] = 0; G.phase = 'draw';
  }

  /* ---------------- yayın ---------------- */
  snapshot(k) {
    const G = this.g;
    const base = {
      t: 'state', you: k, host: this.seats[k] && this.seats[k].id === this.host,
      cfg: this.cfg, log: this.log,
      seats: this.seats.map((s, i) => ({ name: s ? s.name : null, bot: s ? !!s.bot : false })),
      started: !!G
    };
    if (!G) return base;
    return Object.assign(base, {
      hand: G.hands[k],
      counts: G.hands.map(h => h.length),
      melds: G.melds, opened: G.opened, pairs: G.pairs, pen: G.pen, score: G.score,
      disc: G.disc.map(d => ({ n: d.length, top: d[d.length - 1] || null })),
      pile: G.pile.length, ind: G.ind, okeyC: G.okeyC, okeyN: G.okeyN,
      turn: G.turn, phase: G.phase, baraj: G.baraj, took: G.took,
      handNo: G.handNo, hands: this.cfg.hands, over: G.over, result: G.result
    });
  }
  broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment(); if (!a) continue;
      try { ws.send(JSON.stringify(this.snapshot(a.seat))); } catch { }
    }
  }
}
