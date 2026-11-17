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

let players = {}; // socket.id -> player object
let seatOrder = []; // ordered array of socket.ids
let deck = [];
let communityCards = [];
let pot = 0;
let currentBet = 0;
let dealerIndex = -1;
let currentTurnIndex = -1;
let stage = 'Waiting'; // Waiting, Pre-Flop, Flop, Turn, River, Showdown

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
}

function sendPrivateHands() {
  for (let id of seatOrder) {
    const p = players[id];
    if (p && p.hand.length === 2) {
      const cardsToEval = communityCards.length > 0 ? p.hand.concat(communityCards) : p.hand;
      const solved = Hand.solve(cardsToEval);
      io.to(id).emit('yourHand', {
        hand: p.hand,
        rank: communityCards.length > 0 ? solved.descr : solved.name
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
    return {
      id: p.id,
      name: p.name,
      chips: p.chips,
      bet: p.bet,
      folded: p.folded,
      allIn: p.allIn,
      hasCards: p.hand.length === 2,
      isDealer: idx === dealerIndex,
      isSB: idx === sbIdx,
      isBB: idx === bbIdx,
      isTurn: idx === currentTurnIndex && stage !== 'Waiting' && stage !== 'Showdown',
      revealedHand: stage === 'Showdown' && !p.folded ? p.hand : null
    };
  });

  io.emit('updateTable', {
    players: publicPlayers,
    communityCards,
    pot,
    currentBet,
    stage,
    activePlayerId: currentTurnIndex >= 0 ? seatOrder[currentTurnIndex] : null
  });
}

function resolveShowdown(earlyWinner = null) {
  stage = 'Showdown';
  currentTurnIndex = -1;

  if (earlyWinner) {
    earlyWinner.chips += pot;
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
    if (players[w.playerId]) players[w.playerId].chips += share;
  });

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
    communityCards.push(deck.pop(), deck.pop(), deck.pop());
    stage = 'Flop';
  } else if (stage === 'Flop') {
    communityCards.push(deck.pop());
    stage = 'Turn';
  } else if (stage === 'Turn') {
    communityCards.push(deck.pop());
    stage = 'River';
  } else if (stage === 'River') {
    resolveShowdown();
    return;
  }

  sendPrivateHands();
  io.emit('soundEffect', 'deal');

  // If 1 or fewer players can still bet (rest are all-in), run out remaining streets
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

  if (allMatched) {
    advanceStreet();
  } else {
    currentTurnIndex = nextActiveIndex(currentTurnIndex);
    broadcastState();
  }
}

io.on('connection', (socket) => {
  socket.on('joinGame', (name) => {
    if (!players[socket.id]) {
      players[socket.id] = {
        id: socket.id,
        name: (name || 'Player').trim().slice(0, 14),
        chips: 1000,
        bet: 0,
        hand: [],
        folded: false,
        allIn: false,
        actedThisStreet: false
      };
      seatOrder.push(socket.id);
    }
    broadcastState();
  });

  socket.on('startRound', () => {
    if (seatOrder.length < 2) {
      io.to(socket.id).emit('playerAction', { name: 'System', action: 'Need at least 2 players to deal!' });
      return;
    }

    deck = createDeck();
    communityCards = [];
    pot = 0;
    stage = 'Pre-Flop';
    dealerIndex = (dealerIndex + 1) % seatOrder.length;

    for (let id of seatOrder) {
      const p = players[id];
      if (p.chips <= 0) p.chips = 1000; // Auto rebuy
      p.hand = [deck.pop(), deck.pop()];
      p.folded = false;
      p.allIn = false;
      p.bet = 0;
      p.actedThisStreet = false;
    }

    // Post Small & Big Blinds (Heads-up rule: Dealer is SB)
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
  });

  socket.on('playerAction', (data) => {
    if (stage === 'Waiting' || stage === 'Showdown') return;
    if (seatOrder[currentTurnIndex] !== socket.id) return; // Enforce strict turn order

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
        io.emit('soundEffect', 'chip');
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

      if (p.bet > currentBet) {
        currentBet = p.bet;
        // Re-open betting action for other active players
        for (let id of seatOrder) {
          if (id !== socket.id && players[id] && !players[id].folded && !players[id].allIn) {
            players[id].actedThisStreet = false;
          }
        }
      }
      p.actedThisStreet = true;
      io.emit('soundEffect', 'chip');
      io.emit('playerAction', { name: p.name, action: `Raises to $${p.bet}` });
      checkStreetComplete();
    }
  });

  socket.on('disconnect', () => {
    const idx = seatOrder.indexOf(socket.id);
    if (idx !== -1) {
      seatOrder.splice(idx, 1);
      delete players[socket.id];
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
server.listen(PORT, () => console.log(`Poker server running on port ${PORT}`));