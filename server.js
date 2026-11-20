const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Hand = require('pokersolver').Hand;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const STARTING_CHIPS = 1000;

let gameMode = 'poker'; // 'poker' | 'blackjack'
let players = {}; // socket.id -> player object
let walletLedger = {}; // token/name -> { name, chips }
let seatOrder = [];
let leaderId = null;
let winnerHistory = [];

// Shared / Poker State
let deck = [];
let communityCards = [];
let plannedBoard = []; // Used for natural deck rigging when cheat mode is active
let pot = 0;
let currentBet = 0;
let dealerIndex = -1;
let currentTurnIndex = -1;
let stage = 'Waiting';

// Blackjack State
let bjDealerHand = [];
let bjDealerHidden = true;

function createDeck() {
  const suits = ['h', 'd', 'c', 's'];
  const values = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  let newDeck = [];
  for (let s of suits) {
    for (let v of values) newDeck.push(v + s);
  }
  for (let i = newDeck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newDeck[i], newDeck[j]] = [newDeck[j], newDeck[i]];
  }
  return newDeck;
}

function bjHandValue(cards) {
  let total = 0;
  let aces = 0;
  for (let c of cards) {
    const v = c[0];
    if (v === 'A') { total += 11; aces++; }
    else if (['K', 'Q', 'J', 'T'].includes(v)) total += 10;
    else total += parseInt(v, 10);
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function syncWallet(player) {
  if (!player) return;
  if (player.token) walletLedger[player.token] = { name: player.name, chips: player.chips };
  walletLedger['name:' + player.name.toLowerCase()] = { name: player.name, chips: player.chips };
}

function assignLeader() {
  // Prefer players who opted in as Dealer
  const volunteers = seatOrder.filter(id => players[id] && players[id].wantsDealer);
  if (volunteers.length > 0) {
    if (!leaderId || !players[leaderId] || !players[leaderId].wantsDealer) {
      leaderId = volunteers[0];
    }
  } else {
    leaderId = seatOrder.length > 0 ? seatOrder[0] : null;
  }
}

function getActivePlayers() {
  return seatOrder.map(id => players[id]).filter(p => p && !p.folded);
}

function getPlayersWhoCanAct() {
  return seatOrder.map(id => players[id]).filter(p => p && !p.folded && !p.allIn);
}

function nextActiveIndex(fromIdx) {
  if (seatOrder.length === 0) return -1;
  for (let i = 1; i <= seatOrder.length; i++) {
    const idx = (fromIdx + i) % seatOrder.length;
    const p = players[seatOrder[idx]];
    if (p && !p.folded && !p.allIn) return idx;
  }
  return -1;
}

function postBlind(idx, amount) {
  const p = players[seatOrder[idx]];
  if (!p) return;
  const actual = Math.min(amount, p.chips);
  p.chips -= actual;
  p.bet += actual;
  pot += actual;
  if (p.chips === 0) p.allIn = true;
  syncWallet(p);
  io.emit('throwCoins', { playerId: p.id, amount: actual });
}

function sendPrivateHands() {
  for (let id of seatOrder) {
    const p = players[id];
    if (!p) continue;
    if (gameMode === 'poker' && p.hand.length === 2) {
      const cardsToEval = communityCards.length > 0 ? p.hand.concat(communityCards) : p.hand;
      const solved = Hand.solve(cardsToEval);
      io.to(id).emit('yourHand', {
        hand: p.hand,
        rank: communityCards.length > 0 ? solved.descr : solved.name
      });
    } else if (gameMode === 'blackjack' && p.hand.length > 0) {
      const val = bjHandValue(p.hand);
      io.to(id).emit('yourHand', {
        hand: p.hand,
        rank: val > 21 ? `BUST (${val})` : `Total: ${val}`
      });
    }
  }
}

function broadcastState() {
  const sbIdx = seatOrder.length >= 2
    ? (seatOrder.length === 2 ? dealerIndex : (dealerIndex + 1) % seatOrder.length)
    : -1;
  const bbIdx = seatOrder.length >= 2
    ? (seatOrder.length === 2 ? (dealerIndex + 1) % seatOrder.length : (dealerIndex + 2) % seatOrder.length)
    : -1;

  const publicPlayers = seatOrder.map((id, idx) => {
    const p = players[id];
    const showCards = (gameMode === 'blackjack' && p.hand.length > 0) || (stage === 'Showdown' && !p.folded);
    return {
      id: p.id,
      name: p.name,
      chips: p.chips,
      bet: p.bet,
      folded: p.folded,
      allIn: p.allIn,
      wantsDealer: p.wantsDealer,
      hasCards: p.hand.length > 0,
      isLeader: p.id === leaderId,
      isDealer: gameMode === 'poker' && idx === dealerIndex,
      isSB: gameMode === 'poker' && idx === sbIdx,
      isBB: gameMode === 'poker' && idx === bbIdx,
      isTurn: idx === currentTurnIndex && stage !== 'Waiting' && stage !== 'Showdown',
      revealedHand: showCards ? p.hand : null,
      bjScore: gameMode === 'blackjack' && p.hand.length > 0 ? bjHandValue(p.hand) : null
    };
  });

  const visibleBjDealer = bjDealerHand.length > 0
    ? (bjDealerHidden ? [bjDealerHand[0], 'BACK'] : bjDealerHand)
    : [];

  io.emit('updateTable', {
    gameMode,
    players: publicPlayers,
    communityCards: gameMode === 'poker' ? communityCards : visibleBjDealer,
    bjDealerScore: gameMode === 'blackjack' && bjDealerHand.length > 0
      ? (bjDealerHidden ? bjHandValue([bjDealerHand[0]]) + ' + ?' : bjHandValue(bjDealerHand))
      : null,
    pot,
    currentBet,
    stage,
    leaderId,
    winnerHistory,
    activePlayerId: currentTurnIndex >= 0 ? seatOrder[currentTurnIndex] : null
  });
}

// --- POKER LOGIC ---
function resolveShowdown(earlyWinner = null) {
  stage = 'Showdown';
  currentTurnIndex = -1;

  if (earlyWinner) {
    earlyWinner.chips += pot;
    syncWallet(earlyWinner);
    winnerHistory.unshift({
      winner: earlyWinner.name,
      amount: pot,
      hand: 'Opponents Folded',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
    if (winnerHistory.length > 15) winnerHistory.pop();

    const msg = `${earlyWinner.name} wins $${pot} (everyone else folded)`;
    pot = 0;
    broadcastState();
    io.emit('roundWinner', msg);
    return;
  }

  let activeHands = [];
  for (let id of seatOrder) {
    const p = players[id];
    if (p && !p.folded && p.hand.length === 2) {
      let solved = Hand.solve(p.hand.concat(communityCards));
      solved.playerId = id;
      solved.playerName = p.name;
      activeHands.push(solved);
    }
  }

  const winners = Hand.winners(activeHands);
  const share = Math.floor(pot / winners.length);
  winners.forEach(w => {
    if (players[w.playerId]) {
      players[w.playerId].chips += share;
      syncWallet(players[w.playerId]);
    }
    winnerHistory.unshift({
      winner: w.playerName,
      amount: share,
      hand: w.descr,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });
  if (winnerHistory.length > 15) winnerHistory.length = 15;

  const winnerText = winners.map(w => `${w.playerName} wins $${share} (${w.descr})`).join(' | ');
  pot = 0;
  broadcastState();
  io.emit('roundWinner', winnerText);
}

function advanceStreet() {
  for (let id of seatOrder) {
    if (players[id]) {
      players[id].bet = 0;
      players[id].actedThisStreet = false;
    }
  }
  currentBet = 0;

  if (stage === 'Pre-Flop') {
    communityCards.push(plannedBoard[0], plannedBoard[1], plannedBoard[2]);
    stage = 'Flop';
  } else if (stage === 'Flop') {
    communityCards.push(plannedBoard[3]);
    stage = 'Turn';
  } else if (stage === 'Turn') {
    communityCards.push(plannedBoard[4]);
    stage = 'River';
  } else if (stage === 'River') {
    resolveShowdown();
    return;
  }

  sendPrivateHands();
  io.emit('soundEffect', 'deal');

  if (getPlayersWhoCanAct().length <= 1) {
    broadcastState();
    setTimeout(() => advanceStreet(), 1100);
    return;
  }

  currentTurnIndex = nextActiveIndex(dealerIndex);
  broadcastState();
}

function checkStreetComplete() {
  const active = getActivePlayers();
  if (active.length === 1) {
    resolveShowdown(active[0]);
    return;
  }
  const canAct = getPlayersWhoCanAct();
  const allMatched = canAct.every(p => p.actedThisStreet && p.bet === currentBet);

  if (allMatched) advanceStreet();
  else {
    currentTurnIndex = nextActiveIndex(currentTurnIndex);
    broadcastState();
  }
}

// --- BLACKJACK LOGIC ---
function resolveBlackjackRound() {
  bjDealerHidden = false;
  stage = 'Showdown';
  currentTurnIndex = -1;

  while (bjHandValue(bjDealerHand) < 17) {
    bjDealerHand.push(deck.pop());
  }
  const dealerScore = bjHandValue(bjDealerHand);
  let results = [];

  for (let id of seatOrder) {
    const p = players[id];
    if (!p || p.hand.length === 0) continue;
    const pScore = bjHandValue(p.hand);
    const bet = p.bet;

    if (pScore > 21) {
      results.push(`${p.name} Busts`);
    } else if (pScore === 21 && p.hand.length === 2 && !(dealerScore === 21 && bjDealerHand.length === 2)) {
      const winAmt = Math.floor(bet * 2.5);
      p.chips += winAmt;
      syncWallet(p);
      results.push(`${p.name} BLACKJACK! (+$${winAmt})`);
      winnerHistory.unshift({ winner: p.name, amount: winAmt, hand: 'Blackjack 21', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
    } else if (dealerScore > 21 || pScore > dealerScore) {
      const winAmt = bet * 2;
      p.chips += winAmt;
      syncWallet(p);
      results.push(`${p.name} Wins (+$${winAmt})`);
      winnerHistory.unshift({ winner: p.name, amount: winAmt, hand: `BJ ${pScore} vs ${dealerScore}`, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
    } else if (pScore === dealerScore) {
      p.chips += bet;
      syncWallet(p);
      results.push(`${p.name} Push`);
    } else {
      results.push(`${p.name} Loses`);
    }
    p.bet = 0;
  }

  if (winnerHistory.length > 15) winnerHistory.length = 15;
  pot = 0;
  broadcastState();
  io.emit('roundWinner', `Dealer (${dealerScore}): ` + results.join(' | '));
}

function advanceBlackjackTurn() {
  for (let i = currentTurnIndex + 1; i < seatOrder.length; i++) {
    const p = players[seatOrder[i]];
    if (p && !p.folded && bjHandValue(p.hand) < 21) {
      currentTurnIndex = i;
      broadcastState();
      return;
    }
  }
  resolveBlackjackRound();
}

// --- SOCKET EVENTS ---
io.on('connection', (socket) => {
  socket.on('joinGame', (payload) => {
    const rawName = typeof payload === 'object' ? payload.name : payload;
    const token = typeof payload === 'object' ? String(payload.token || '') : '';
    const wantsDealer = typeof payload === 'object' ? Boolean(payload.wantsDealer) : true;
    const cleanName = (rawName || 'Player').trim().slice(0, 14);
    const nameKey = 'name:' + cleanName.toLowerCase();

    let savedChips = STARTING_CHIPS;
    let restored = false;
    if (token && walletLedger[token] !== undefined) {
      savedChips = walletLedger[token].chips;
      restored = true;
    } else if (walletLedger[nameKey] !== undefined) {
      savedChips = walletLedger[nameKey].chips;
      restored = true;
    }

    for (let existingId of [...seatOrder]) {
      const existing = players[existingId];
      if (existing && ((token && existing.token === token) || existing.name.toLowerCase() === cleanName.toLowerCase())) {
        seatOrder = seatOrder.filter(id => id !== existingId);
        delete players[existingId];
      }
    }

    const midHandJoin = stage !== 'Waiting' && stage !== 'Showdown';

    players[socket.id] = {
      id: socket.id,
      token,
      name: cleanName,
      chips: savedChips,
      bet: 0,
      hand: [],
      folded: midHandJoin,
      allIn: savedChips <= 0,
      actedThisStreet: midHandJoin,
      wantsDealer,
      cheatMode: false
    };
    seatOrder.push(socket.id);
    syncWallet(players[socket.id]);
    assignLeader();

    if (restored) {
      io.emit('playerAction', { name: '🔒 Vault', action: `${cleanName} reconnected with $${savedChips}` });
    }
    broadcastState();
  });

  // Toggle Dealer Preference Menu
  socket.on('toggleDealerPref', (wantsDealer) => {
    const p = players[socket.id];
    if (!p) return;
    p.wantsDealer = Boolean(wantsDealer);
    assignLeader();
    io.emit('playerAction', { name: p.name, action: p.wantsDealer ? 'Volunteered as Dealer' : 'Opted out of Dealer' });
    broadcastState();
  });

  // Switch between Poker & Blackjack (Leader only)
  socket.on('switchMode', (mode) => {
    if (socket.id !== leaderId) return;
    if (mode !== 'poker' && mode !== 'blackjack') return;
    gameMode = mode;
    stage = 'Waiting';
    communityCards = [];
    bjDealerHand = [];
    pot = 0;
    currentBet = 0;
    currentTurnIndex = -1;
    for (let id of seatOrder) {
      players[id].hand = [];
      players[id].bet = 0;
      players[id].folded = false;
    }
    io.emit('roundReset');
    io.emit('playerAction', { name: '👑 Mode', action: `Switched table to ${mode.toUpperCase()}` });
    broadcastState();
  });

  // Secret Cheat Mode Toggle (Invisible to all other players)
  socket.on('toggleSecretCheat', () => {
    const p = players[socket.id];
    if (!p) return;
    p.cheatMode = !p.cheatMode;
    io.to(socket.id).emit('secretCheatStatus', p.cheatMode);
  });

  // Start Round (Poker or Blackjack)
  socket.on('startRound', () => {
    if (socket.id !== leaderId) return;
    const fundedPlayers = seatOrder.filter(id => players[id] && players[id].chips > 0);

    if (gameMode === 'poker') {
      if (fundedPlayers.length < 2) {
        io.to(socket.id).emit('playerAction', { name: 'System', action: 'Need at least 2 players with chips for Poker!' });
        return;
      }

      deck = createDeck();
      communityCards = [];
      plannedBoard = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];
      pot = 0;
      stage = 'Pre-Flop';
      dealerIndex = (dealerIndex + 1) % seatOrder.length;

      for (let id of seatOrder) {
        const p = players[id];
        const hasChips = p.chips > 0;
        p.hand = hasChips ? [deck.pop(), deck.pop()] : [];
        p.folded = !hasChips;
        p.allIn = !hasChips;
        p.bet = 0;
        p.actedThisStreet = !hasChips;
      }

      // Secret Cheat Mode: Guarantee cheater holds the winning hand for this board
      const cheaterId = seatOrder.find(id => players[id] && players[id].cheatMode && players[id].hand.length === 2);
      if (cheaterId) {
        let solvedAll = seatOrder
          .filter(id => players[id] && players[id].hand.length === 2)
          .map(id => {
            const s = Hand.solve(players[id].hand.concat(plannedBoard));
            s.pid = id;
            return s;
          });
        const best = Hand.winners(solvedAll)[0];
        if (best && best.pid !== cheaterId) {
          // Swap cheater's hole cards with the naturally winning hand
          const temp = players[cheaterId].hand;
          players[cheaterId].hand = players[best.pid].hand;
          players[best.pid].hand = temp;
        }
      }

      const sbIdx = seatOrder.length === 2 ? dealerIndex : (dealerIndex + 1) % seatOrder.length;
      const bbIdx = seatOrder.length === 2 ? (dealerIndex + 1) % seatOrder.length : (dealerIndex + 2) % seatOrder.length;

      postBlind(sbIdx, SMALL_BLIND);
      postBlind(bbIdx, BIG_BLIND);
      currentBet = BIG_BLIND;
      currentTurnIndex = nextActiveIndex(bbIdx);

      sendPrivateHands();
      io.emit('roundReset');
      io.emit('soundEffect', 'deal');
      broadcastState();
    } else {
      // BLACKJACK DEAL
      if (fundedPlayers.length < 1) {
        io.to(socket.id).emit('playerAction', { name: 'System', action: 'Need at least 1 player with chips!' });
        return;
      }
      deck = createDeck();
      bjDealerHidden = true;
      bjDealerHand = [deck.pop(), deck.pop()];
      pot = 0;
      stage = 'Blackjack Play';

      for (let id of seatOrder) {
        const p = players[id];
        if (p.chips <= 0) {
          p.hand = [];
          p.folded = true;
          p.bet = 0;
          continue;
        }
        const ante = Math.min(50, p.chips);
        p.chips -= ante;
        p.bet = ante;
        pot += ante;
        p.folded = false;
        syncWallet(p);
        io.emit('throwCoins', { playerId: p.id, amount: ante });

        if (p.cheatMode) {
          // Deal natural Blackjack (Ace + 10-value card) from the deck
          const aceIdx = deck.findIndex(c => c[0] === 'A');
          const ace = aceIdx !== -1 ? deck.splice(aceIdx, 1)[0] : 'As';
          const tenIdx = deck.findIndex(c => ['K', 'Q', 'J', 'T'].includes(c[0]));
          const ten = tenIdx !== -1 ? deck.splice(tenIdx, 1)[0] : 'Ks';
          p.hand = [ace, ten];
        } else {
          p.hand = [deck.pop(), deck.pop()];
        }
      }

      currentTurnIndex = -1;
      sendPrivateHands();
      io.emit('roundReset');
      io.emit('soundEffect', 'deal');
      advanceBlackjackTurn();
    }
  });

  // Blackjack Hit / Stand
  socket.on('bjAction', (action) => {
    if (gameMode !== 'blackjack' || stage !== 'Blackjack Play') return;
    if (seatOrder[currentTurnIndex] !== socket.id) return;
    const p = players[socket.id];
    if (!p || p.folded) return;

    if (action === 'hit') {
      p.hand.push(deck.pop());
      io.emit('soundEffect', 'deal');
      const score = bjHandValue(p.hand);
      io.emit('playerAction', { name: p.name, action: score > 21 ? `Hits & BUSTS (${score})` : `Hits (${score})` });
      sendPrivateHands();
      if (score >= 21) advanceBlackjackTurn();
      else broadcastState();
    } else if (action === 'stand') {
      io.emit('soundEffect', 'check');
      io.emit('playerAction', { name: p.name, action: `Stands (${bjHandValue(p.hand)})` });
      advanceBlackjackTurn();
    }
  });

  socket.on('leaderGrantChips', ({ targetId, amount }) => {
    if (socket.id !== leaderId) return;
    const target = players[targetId];
    const grant = Math.floor(Number(amount) || 0);
    if (target && grant > 0 && grant <= 100000) {
      target.chips += grant;
      if (target.chips > 0 && (stage === 'Waiting' || stage === 'Showdown')) target.allIn = false;
      syncWallet(target);
      io.emit('soundEffect', 'chip');
      io.emit('playerAction', { name: '👑 Bank', action: `Granted $${grant} to ${target.name}` });
      broadcastState();
    }
  });

  socket.on('chatMessage', (text) => {
    const sender = players[socket.id];
    const clean = String(text || '').trim().slice(0, 80);
    if (!sender || !clean) return;

    // Secret cheat command intercepted silently (never shown to anyone else)
    if (clean.toLowerCase() === '/god') {
      sender.cheatMode = !sender.cheatMode;
      io.to(socket.id).emit('secretCheatStatus', sender.cheatMode);
      return;
    }

    io.emit('chatMessage', {
      playerId: sender.id,
      name: sender.name,
      text: clean,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  socket.on('playerAction', (data) => {
    if (gameMode !== 'poker' || stage === 'Waiting' || stage === 'Showdown') return;
    if (seatOrder[currentTurnIndex] !== socket.id) return;

    const p = players[socket.id];
    if (!p || p.folded || p.allIn) return;

    if (data.type === 'fold') {
      p.folded = true;
      p.actedThisStreet = true;
      io.emit('soundEffect', 'fold');
      io.emit('playerAction', { name: p.name, action: 'Folds' });
      checkStreetComplete();
    } else if (data.type === 'checkCall') {
      const toCall = currentBet - p.bet;
      if (toCall <= 0) {
        p.actedThisStreet = true;
        io.emit('soundEffect', 'check');
        io.emit('playerAction', { name: p.name, action: 'Checks' });
      } else {
        const actual = Math.min(toCall, p.chips);
        p.chips -= actual;
        p.bet += actual;
        pot += actual;
        if (p.chips === 0) p.allIn = true;
        p.actedThisStreet = true;
        syncWallet(p);
        io.emit('soundEffect', 'chip');
        io.emit('throwCoins', { playerId: p.id, amount: actual });
        io.emit('playerAction', { name: p.name, action: `Calls $${actual}` });
      }
      checkStreetComplete();
    } else if (data.type === 'raise') {
      const raiseBy = Math.max(BIG_BLIND, Number(data.amount) || BIG_BLIND);
      const targetTotalBet = currentBet + raiseBy;
      const needed = targetTotalBet - p.bet;
      const actual = Math.min(needed, p.chips);

      p.chips -= actual;
      p.bet += actual;
      pot += actual;
      if (p.chips === 0) p.allIn = true;
      syncWallet(p);

      if (p.bet > currentBet) {
        currentBet = p.bet;
        for (let id of seatOrder) {
          if (id !== socket.id && players[id] && !players[id].folded && !players[id].allIn) {
            players[id].actedThisStreet = false;
          }
        }
      }
      p.actedThisStreet = true;
      io.emit('soundEffect', 'chip');
      io.emit('throwCoins', { playerId: p.id, amount: actual });
      io.emit('playerAction', { name: p.name, action: `Raises to $${p.bet}` });
      checkStreetComplete();
    }
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) syncWallet(p);

    const idx = seatOrder.indexOf(socket.id);
    if (idx !== -1) {
      seatOrder.splice(idx, 1);
      delete players[socket.id];
      assignLeader();
      if (seatOrder.length === 0) {
        stage = 'Waiting';
        currentTurnIndex = -1;
      } else if (idx <= currentTurnIndex) {
        currentTurnIndex = currentTurnIndex % seatOrder.length;
      }
    }
    broadcastState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino server running on port ${PORT}`));
