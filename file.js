const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomInt } = require('crypto');
const { WebSocketServer } = require('ws');

const START_CHIPS = 1000, SB = 10, BB = 20, MAX_PLAYERS = 5;
const HAND = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight',
              'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

let players = []; // seat order = join order
let g = { phase: 'lobby', community: [], deck: [], dealer: -1, turn: -1,
          currentBet: 0, minRaise: BB, log: [], reveal: false };
let timer = null;

/* ---------- helpers ---------- */
const say = m => { g.log.push(m); if (g.log.length > 40) g.log.shift(); };
const betting = () => ['preflop', 'flop', 'turn', 'river'].includes(g.phase);
const totalPot = () => players.reduce((s, p) => s + p.total, 0);

function newDeck() {
  const d = [];
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) d.push({ r, s });
  return d;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function nextSeat(from, pred) {
  const n = players.length;
  for (let i = 1; i <= n; i++) {
    const k = (((from + i) % n) + n) % n;
    if (pred(players[k])) return k;
  }
  return -1;
}
function put(p, n) {
  p.chips -= n; p.bet += n; p.total += n;
  if (p.chips === 0) p.allIn = true;
}

/* ---------- hand evaluation ---------- */
function cmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}
function rank5(cards) {
  const rs = cards.map(c => c.r).sort((a, b) => b - a);
  const flush = cards.every(c => c.s === cards[0].s);
  let straight = 0;
  if (new Set(rs).size === 5) {
    if (rs[0] - rs[4] === 4) straight = rs[0];
    else if (rs[0] === 14 && rs[1] === 5) straight = 5; // wheel A-2-3-4-5
  }
  const counts = {};
  rs.forEach(r => counts[r] = (counts[r] || 0) + 1);
  const groups = Object.entries(counts).map(([r, c]) => [c, +r])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  let cat;
  if (straight && flush) cat = 8;
  else if (groups[0][0] === 4) cat = 7;
  else if (groups[0][0] === 3 && groups[1][0] === 2) cat = 6;
  else if (flush) cat = 5;
  else if (straight) cat = 4;
  else if (groups[0][0] === 3) cat = 3;
  else if (groups[0][0] === 2 && groups[1][0] === 2) cat = 2;
  else if (groups[0][0] === 2) cat = 1;
  else cat = 0;
  return { score: [cat, ...(straight ? [straight] : groups.map(g => g[1]))] };
}
function best7(cards) {
  let best = null;
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length; j++) {
      const e = rank5(cards.filter((_, k) => k !== i && k !== j));
      if (!best || cmp(e.score, best.score) > 0) best = e;
    }
  return best;
}

/* ---------- game flow ---------- */
function startGame() {
  clearTimeout(timer);
  players = players.filter(p => p.connected);
  if (players.length < 2) return;
  players.forEach(p => { p.chips = START_CHIPS; p.hand = []; });
  g.dealer = -1; g.log = [];
  say(`New game: ${players.length} players, ${START_CHIPS} chips each.`);
  startHand();
}

function startHand() {
  clearTimeout(timer);
  if (players.every(p => !p.connected)) {
    players = []; g.phase = 'lobby'; g.log = []; return;
  }
  const live = players.filter(p => p.chips > 0);
  if (live.length < 2) {
    g.phase = 'gameover'; g.turn = -1; g.reveal = false;
    say(`🏆 ${live[0].name} wins the game with ${live[0].chips} chips!`);
    return broadcast();
  }
  g.deck = shuffle(newDeck());
  g.community = []; g.reveal = false;
  g.phase = 'preflop';
  players.forEach(p => {
    Object.assign(p, { hand: [], bet: 0, total: 0, folded: false, allIn: false,
                       acted: false, won: false, eval: null, inHand: p.chips > 0 });
    if (p.inHand) p.hand = [g.deck.pop(), g.deck.pop()];
  });
  g.dealer = nextSeat(g.dealer, p => p.inHand);
  const sb = nextSeat(g.dealer, p => p.inHand);
  const bb = nextSeat(sb, p => p.inHand);
  put(players[sb], Math.min(SB, players[sb].chips));
  put(players[bb], Math.min(BB, players[bb].chips));
  g.currentBet = Math.max(players[sb].bet, players[bb].bet);
  g.minRaise = BB;
  g.turn = bb;
  say(`--- New hand. ${players[sb].name} posts SB ${SB}, ${players[bb].name} posts BB ${BB} ---`);
  proceed();
}

function proceed() {
  for (;;) {
    const alive = players.filter(p => p.inHand && !p.folded);
    if (alive.length < 2) return settle();
    const canAct = alive.filter(p => !p.allIn).length;
    const idx = nextSeat(g.turn, p =>
      p.inHand && !p.folded && !p.allIn &&
      !(p.acted && p.bet === g.currentBet) &&
      !(canAct < 2 && p.bet >= g.currentBet));

    if (idx !== -1) {
      g.turn = idx;
      const p = players[idx];
      if (!p.connected) { p.folded = true; say(`${p.name} is offline and folds`); continue; }
      return broadcast();
    }
    // betting round finished
    if (g.phase === 'river') return settle();
    players.forEach(p => { p.bet = 0; p.acted = false; });
    g.currentBet = 0; g.minRaise = BB;
    g.phase = { preflop: 'flop', flop: 'turn', turn: 'river' }[g.phase];
    const n = g.phase === 'flop' ? 3 : 1;
    for (let i = 0; i < n; i++) g.community.push(g.deck.pop());
    g.turn = g.dealer;
  }
}

function onAction(p, type, amount) {
  if (!betting() || players[g.turn] !== p) return;
  const toCall = g.currentBet - p.bet;

  if (type === 'fold') {
    p.folded = true; say(`${p.name} folds`);
  } else if (type === 'call') {
    const n = Math.min(toCall, p.chips);
    put(p, n);
    say(n === 0 ? `${p.name} checks` : `${p.name} calls ${n}${p.allIn ? ' (all-in)' : ''}`);
  } else if (type === 'raise') {
    const max = p.bet + p.chips;
    const to = Math.min(Math.floor(+amount) || 0, max);
    if (to < g.currentBet + g.minRaise && to < max) return; // illegal raise
    const verb = g.currentBet === 0 ? 'bets' : 'raises to';
    put(p, to - p.bet);
    if (p.bet > g.currentBet) {
      const inc = p.bet - g.currentBet;
      if (inc >= g.minRaise) g.minRaise = inc;
      g.currentBet = p.bet;
      players.forEach(o => { if (o !== p) o.acted = false; });
      say(`${p.name} ${verb} ${p.bet}${p.allIn ? ' (all-in)' : ''}`);
    } else say(`${p.name} calls ${to - 0} (all-in)`);
  } else return;

  p.acted = true;
  proceed();
}

function settle() {
  g.phase = 'showdown'; g.turn = -1;
  const alive = players.filter(p => p.inHand && !p.folded);

  if (alive.length === 1) {
    const w = alive[0], pot = totalPot();
    w.chips += pot; w.won = true; g.reveal = false;
    say(`${w.name} wins ${pot} (everyone else folded)`);
  } else {
    g.reveal = true;
    alive.forEach(p => p.eval = best7(p.hand.concat(g.community)));
    const levels = [...new Set(alive.map(p => p.total))].sort((a, b) => a - b);
    let prev = 0;
    levels.forEach((lv, i) => {
      const pot = players.reduce((s, p) => s + Math.max(0, Math.min(p.total, lv) - prev), 0);
      prev = lv;
      const elig = alive.filter(p => p.total >= lv);
      let top = elig[0].eval.score, ws = [];
      elig.forEach(p => {
        const c = cmp(p.eval.score, top);
        if (c > 0) { top = p.eval.score; ws = [p]; }
        else if (c === 0) ws.push(p);
      });
      if (!ws.length) ws = [elig[0]];
      const share = Math.floor(pot / ws.length), rem = pot - share * ws.length;
      ws.forEach((w, k) => { w.chips += share + (k === 0 ? rem : 0); w.won = true; });
      const label = levels.length > 1 ? (i === 0 ? ' (main pot)' : ' (side pot)') : '';
      say(`${ws.map(w => w.name).join(' & ')} ${ws.length > 1 ? 'split' : 'wins'} ${pot}${label} with ${HAND[top[0]]}`);
    });
  }
  broadcast();
  timer = setTimeout(startHand, 7000);
}

/* ---------- networking ---------- */
function view(p) {
  return {
    t: 'state',
    phase: g.phase, community: g.community, pot: totalPot(),
    currentBet: g.currentBet, minRaise: g.minRaise,
    turn: g.turn, dealer: g.dealer, log: g.log,
    you: players.indexOf(p), isHost: p === players[0],
    players: players.map(q => ({
      name: q.name, chips: q.chips, bet: q.bet, folded: q.folded, allIn: q.allIn,
      inHand: q.inHand, connected: q.connected, won: q.won,
      cards: q.hand && q.hand.length && !q.folded
        ? (q === p || (g.reveal && g.phase === 'showdown') ? q.hand : 'back') : null,
      handName: g.reveal && g.phase === 'showdown' && !q.folded && q.eval ? HAND[q.eval.score[0]] : null
    }))
  };
}
function broadcast() {
  players.forEach(p => {
    if (p.connected && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(view(p)));
  });
}

const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
    res.writeHead(e ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(e ? 'Error' : d);
  });
});
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  let me = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'join') {
      me = players.find(p => p.token === m.token);
      if (me) { me.ws = ws; me.connected = true; }
      else if (g.phase === 'lobby' && players.length < MAX_PLAYERS) {
        const name = String(m.name || 'Player').trim().slice(0, 14) || 'Player';
        me = { token: String(m.token), name, ws, connected: true, chips: START_CHIPS,
               hand: [], bet: 0, total: 0, folded: false, allIn: false, acted: false, inHand: false };
        players.push(me);
        say(`${name} sat down`);
      } else {
        return ws.send(JSON.stringify({ t: 'error', msg: 'Table is full or a game is already in progress.' }));
      }
      return broadcast();
    }
    if (!me) return;
    if (m.t === 'start' && me === players[0] && ['lobby', 'gameover'].includes(g.phase)) startGame();
    if (m.t === 'act') onAction(me, m.type, m.amount);
  });

  ws.on('close', () => {
    if (!me || me.ws !== ws) return;
    me.connected = false;
    if (g.phase === 'lobby') { players = players.filter(p => p !== me); return broadcast(); }
    if (betting() && players[g.turn] === me) {
      me.folded = true; me.acted = true; say(`${me.name} left and folds`); proceed();
    } else broadcast();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Poker table running on http://localhost:${PORT}`));
