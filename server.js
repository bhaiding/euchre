const express = require('express');
const http = require('http');
const path = require('path');
const QRCode = require('qrcode');
const { customAlphabet } = require('nanoid');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const nanoid = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 6);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/qr', async (req, res) => {
  try {
    const url = String(req.query.url || '');
    if (!/^https?:\/\//.test(url)) return res.status(400).send('Missing absolute URL');
    const svg = await QRCode.toString(url, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#111111', light: '#ffffff' }
    });
    res.setHeader('content-type', 'image/svg+xml');
    res.send(svg);
  } catch (err) {
    res.status(500).send('QR generation failed');
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const games = new Map();
const seats = [0, 1, 2, 3];
const suitNames = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
const suitSymbols = { S: '♠', H: '♥', D: '♦', C: '♣' };
const seatLabels = ['South', 'West', 'North', 'East'];
const ranks = ['9', '10', 'J', 'Q', 'K', 'A'];
const suits = ['S', 'H', 'D', 'C'];
const teamOfSeat = seat => seat === 0 || seat === 2 ? 'blue' : 'red';
const partnerOf = seat => (seat + 2) % 4;
const leftOf = seat => (seat + 1) % 4;
const sameColorSuit = suit => ({ S: 'C', C: 'S', H: 'D', D: 'H' }[suit]);
const BOT_NAMES = ['Mike', 'Mike Jr.', 'Michael'];
const ALL_CARDS = (() => {
  const list = [];
  for (const suit of suits) {
    for (const rank of ranks) list.push({ id: `${rank}${suit}`, rank, suit, label: `${rank}${suitSymbols[suit]}` });
  }
  return list;
})();

function cardLabel(card) {
  return `${card.rank}${suitSymbols[card.suit]}`;
}

function newDeck() {
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ id: `${rank}${suit}`, rank, suit, label: `${rank}${suitSymbols[suit]}` });
    }
  }
  return shuffle(deck);
}

function shuffle(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function getGame(room) {
  if (!games.has(room)) games.set(room, createGame(room));
  return games.get(room);
}

function createGame(room) {
  return {
    room,
    createdAt: Date.now(),
    seatSockets: [new Set(), new Set(), new Set(), new Set()],
    tableSockets: new Set(),
    names: ['', '', '', ''],
    isBot: [false, false, false, false],
    knownVoid: [new Set(), new Set(), new Set(), new Set()],
    botTimer: null,
    dealer: 0,
    phase: 'lobby',
    handNumber: 0,
    score: { blue: 0, red: 0 },
    hands: [[], [], [], []],
    kitty: [],
    upCard: null,
    buriedCard: null,
    trump: null,
    maker: null,
    alone: false,
    sitOut: null,
    turn: null,
    round: 0,
    passes: 0,
    leader: null,
    trickCards: [],
    trickPiles: [0, 0, 0, 0],
    tricksWon: { blue: 0, red: 0 },
    trickNumber: 0,
    message: 'Scan a seat QR code to join. Press Start Hand when everyone is ready.',
    dealing: false,
    dealSeq: 0,
    lastTrickWinner: null,
    revealHands: null,
    autoNextTimer: null,
    playedCards: [],
    upCardOut: false,
    farmerUsed: [false, false, false, false]
  };
}

function nameOf(game, seat) {
  return (game.names && game.names[seat]) ? game.names[seat] : seatLabels[seat];
}

function connectionSnapshot(game) {
  return seats.map(seat => ({
    seat,
    label: seatLabels[seat],
    name: nameOf(game, seat),
    team: teamOfSeat(seat),
    connected: game.seatSockets[seat].size > 0,
    bot: !!game.isBot[seat],
    dealer: game.dealer === seat,
    sitOut: game.sitOut === seat
  }));
}

function publicState(game) {
  return {
    room: game.room,
    seats: connectionSnapshot(game),
    phase: game.phase,
    dealer: game.dealer,
    turn: game.turn,
    round: game.round,
    score: game.score,
    upCard: game.upCard,
    trump: game.trump,
    trumpName: game.trump ? suitNames[game.trump] : null,
    maker: game.maker,
    alone: game.alone,
    sitOut: game.sitOut,
    leader: game.leader,
    trickCards: game.trickCards,
    trickPiles: game.trickPiles,
    tricksWon: game.tricksWon,
    trickNumber: game.trickNumber,
    message: game.message,
    dealing: game.dealing,
    handNumber: game.handNumber,
    lastTrickWinner: game.lastTrickWinner,
    revealHands: game.revealHands || null
  };
}

function privateState(game, seat) {
  const actions = getActions(game, seat);
  return {
    room: game.room,
    seat,
    label: seatLabels[seat],
    team: teamOfSeat(seat),
    hand: sortedHand(game.hands[seat], game.trump),
    phase: game.phase,
    dealer: game.dealer,
    turn: game.turn,
    round: game.round,
    upCard: game.upCard,
    trump: game.trump,
    trumpName: game.trump ? suitNames[game.trump] : null,
    maker: game.maker,
    alone: game.alone,
    sitOut: game.sitOut,
    canAct: actions.canAct,
    actionType: actions.type,
    actionText: actions.text,
    suitOptions: actions.suitOptions || [],
    legalCardIds: getLegalCardIds(game, seat),
    canEndEarly: canClaimRemaining(game, seat),
    canFarmer: canFarmersHand(game, seat),
    message: game.message,
    score: game.score
  };
}

function emitState(game) {
  io.to(game.room).emit('tableState', publicState(game));
  for (const seat of seats) {
    io.to(`${game.room}:seat:${seat}`).emit('handState', privateState(game, seat));
  }
  scheduleBotMove(game);
}

// ---- Bot turn scheduling ----

function isBotTurn(game) {
  const seat = game.turn;
  if (seat == null || !game.isBot[seat]) return false;
  return ['ordering1', 'ordering2', 'discard', 'playing'].includes(game.phase);
}

function scheduleBotMove(game) {
  if (game.botTimer) {
    clearTimeout(game.botTimer);
    game.botTimer = null;
  }
  if (!isBotTurn(game)) return;
  const seat = game.turn;
  const phase = game.phase;
  const handNumber = game.handNumber;
  const delay = 650 + Math.random() * 900; // feels like a person thinking, not instant
  game.botTimer = setTimeout(() => {
    game.botTimer = null;
    if (games.get(game.room) !== game) return; // game was reset/replaced
    if (game.turn !== seat || game.phase !== phase || game.handNumber !== handNumber) return; // stale
    if (!game.isBot[seat]) return; // a human took the seat in the meantime
    performBotMove(game, seat);
  }, delay);
}

function performBotMove(game, seat) {
  if (game.phase === 'ordering1') return botOrdering1(game, seat);
  if (game.phase === 'ordering2') return botOrdering2(game, seat);
  if (game.phase === 'discard') return botDiscard(game, seat);
  if (game.phase === 'playing') {
    const card = botChooseCard(game, seat);
    if (card) applyCardSwipe(game, seat, card.id);
    return;
  }
}

function announceError(socket, message) {
  socket.emit('toast', { message });
}

function sortedHand(hand, trump) {
  const suitOrder = { S: 0, H: 1, D: 2, C: 3 };
  return hand.slice().sort((a, b) => {
    if (trump) {
      const ea = effectiveSuit(a, trump);
      const eb = effectiveSuit(b, trump);
      if (ea === trump && eb !== trump) return -1;
      if (eb === trump && ea !== trump) return 1;
      if (ea !== eb) return suitOrder[ea] - suitOrder[eb];
      return cardPower(a, ea, trump) - cardPower(b, eb, trump);
    }
    if (a.suit !== b.suit) return suitOrder[a.suit] - suitOrder[b.suit];
    return ranks.indexOf(a.rank) - ranks.indexOf(b.rank);
  });
}

function getActions(game, seat) {
  if (game.sitOut === seat) return { canAct: false, type: 'sitOut', text: 'Your partner is going alone. You sit out this hand.' };
  if (game.phase === 'ordering1' && game.turn === seat) {
    const dealerText = game.dealer === seat ? 'pick it up' : `tell ${nameOf(game, game.dealer)} to pick it up`;
    return { canAct: true, type: 'ordering1', text: `${cardLabel(game.upCard)} is up. Pass, ${dealerText}, or go alone.` };
  }
  if (game.phase === 'ordering2' && game.turn === seat) {
    return {
      canAct: true,
      type: 'ordering2',
      text: `Choose trump or pass. ${suitNames[game.upCard.suit]} is not available.`,
      suitOptions: suits.filter(s => s !== game.upCard.suit).map(s => ({ suit: s, name: suitNames[s], symbol: suitSymbols[s] }))
    };
  }
  if (game.phase === 'discard' && game.turn === seat) {
    return { canAct: true, type: 'discard', text: `Swipe one card up to discard. Trump is ${suitNames[game.trump]}.` };
  }
  if (game.phase === 'playing' && game.turn === seat) {
    return { canAct: true, type: 'play', text: 'Your turn. Swipe a card up to play it.' };
  }
  if (game.phase === 'betweenHands') return { canAct: false, type: 'betweenHands', text: 'Hand complete. Watch the table for the next hand.' };
  return { canAct: false, type: 'waiting', text: 'Waiting.' };
}

function fillBotSeats(game) {
  const used = new Set();
  seats.forEach(s => { if (game.isBot[s] && game.names[s]) used.add(game.names[s]); });
  let nameIdx = 0;
  for (const seat of seats) {
    if (game.isBot[seat]) continue;
    if (game.seatSockets[seat].size > 0) continue; // a human is connected here
    while (nameIdx < BOT_NAMES.length && used.has(BOT_NAMES[nameIdx])) nameIdx++;
    const name = BOT_NAMES[nameIdx] || `Bot ${seat + 1}`;
    nameIdx++;
    used.add(name);
    game.isBot[seat] = true;
    game.names[seat] = name;
  }
}

function startHand(game) {
  clearTimeout(game.autoNextTimer);
  fillBotSeats(game);
  clearHand(game);
  game.phase = 'dealing';
  game.dealing = true;
  game.handNumber += 1;
  const deck = newDeck();
  const first = leftOf(game.dealer);
  const order = [first, leftOf(first), leftOf(leftOf(first)), game.dealer];
  const sequence = [];

  for (let round = 0; round < 5; round++) {
    for (const seat of order) {
      const card = deck.pop();
      game.hands[seat].push(card);
      sequence.push({ seat, card, index: sequence.length });
    }
  }
  game.kitty = deck.splice(deck.length - 4, 4);
  game.upCard = game.kitty[0];
  game.message = `Dealing. ${cardLabel(game.upCard)} will be turned up for trump.`;
  game.dealSeq += 1;

  emitState(game);
  io.to(game.room).emit('dealStart', {
    seq: game.dealSeq,
    dealer: game.dealer,
    order,
    sequence,
    upCard: game.upCard,
    startedAt: Date.now() + 400,
    intervalMs: 150
  });

  const delay = 400 + sequence.length * 150 + 650;
  setTimeout(() => {
    if (game.phase !== 'dealing') return;
    game.phase = 'ordering1';
    game.dealing = false;
    game.round = 1;
    game.turn = leftOf(game.dealer);
    game.passes = 0;
    game.message = `${nameOf(game, game.turn)} needs to decide to pass or pick up ${cardLabel(game.upCard)}.`;
    emitState(game);
  }, delay);
}

function clearHand(game) {
  game.hands = [[], [], [], []];
  game.kitty = [];
  game.upCard = null;
  game.buriedCard = null;
  game.trump = null;
  game.maker = null;
  game.alone = false;
  game.sitOut = null;
  game.turn = null;
  game.round = 0;
  game.passes = 0;
  game.leader = null;
  game.trickCards = [];
  game.trickPiles = [0, 0, 0, 0];
  game.tricksWon = { blue: 0, red: 0 };
  game.trickNumber = 0;
  game.lastTrickWinner = null;
  game.revealHands = null;
  game.playedCards = [];
  game.upCardOut = false;
  game.farmerUsed = [false, false, false, false];
  game.knownVoid = [new Set(), new Set(), new Set(), new Set()];
}

function nextTurn(game, fromSeat = game.turn) {
  let next = leftOf(fromSeat);
  while (game.sitOut === next) next = leftOf(next);
  return next;
}

function activePlayerCount(game) {
  return game.sitOut == null ? 4 : 3;
}

function handleTrumpAction(socket, payload) {
  const { room, seat, action, suit, alone } = payload || {};
  const game = games.get(room);
  if (!game || typeof seat !== 'number') return;
  if (game.turn !== seat) return announceError(socket, 'Not your turn.');
  applyTrumpAction(game, seat, { action, suit, alone });
}

function applyTrumpAction(game, seat, { action, suit, alone }) {
  if (game.phase === 'ordering1') {
    if (action === 'pass') {
      game.passes += 1;
      if (game.passes >= 4) {
        game.phase = 'ordering2';
        game.round = 2;
        game.turn = leftOf(game.dealer);
        game.passes = 0;
        game.upCardOut = true; // up-card is turned down and out of play for round 2
        game.message = `${nameOf(game, game.turn)} needs to choose one of the remaining suits or pass.`;
      } else {
        game.turn = nextTurn(game, seat);
        game.message = `${nameOf(game, game.turn)} needs to decide to pass or pick up ${cardLabel(game.upCard)}.`;
      }
      return emitState(game);
    }
    if (action === 'orderUp') {
      game.trump = game.upCard.suit;
      game.maker = seat;
      game.alone = !!alone;
      game.sitOut = game.alone ? partnerOf(seat) : null;
      game.phase = 'discard';
      game.turn = game.dealer;
      game.hands[game.dealer].push(game.upCard);
      game.message = `${nameOf(game, seat)} made ${suitNames[game.trump]} trump${game.alone ? ' and is going alone' : ''}. ${nameOf(game, game.dealer)} must discard.`;
      return emitState(game);
    }
  }

  if (game.phase === 'ordering2') {
    if (action === 'pass') {
      game.passes += 1;
      if (game.passes >= 4) {
        const oldDealer = game.dealer;
        game.dealer = leftOf(game.dealer);
        game.phase = 'betweenHands';
        game.turn = null;
        game.message = `Everyone passed. Misdeal. Dealer moves from ${nameOf(game, oldDealer)} to ${nameOf(game, game.dealer)}.`;
        emitState(game);
        scheduleAutoNext(game);
        return;
      }
      game.turn = nextTurn(game, seat);
      game.message = `${nameOf(game, game.turn)} needs to choose one of the remaining suits or pass.`;
      return emitState(game);
    }
    if (action === 'chooseSuit') {
      if (!suits.includes(suit) || suit === game.upCard.suit) return; // not a legal suit; ignore
      game.trump = suit;
      game.maker = seat;
      game.alone = !!alone;
      game.sitOut = game.alone ? partnerOf(seat) : null;
      beginPlaying(game, `${nameOf(game, seat)} made ${suitNames[suit]} trump${game.alone ? ' and is going alone' : ''}.`);
      return;
    }
  }
}

function handleCardSwipe(socket, payload) {
  const { room, seat, cardId } = payload || {};
  const game = games.get(room);
  if (!game || typeof seat !== 'number' || !cardId) return;
  if (game.sitOut === seat) return announceError(socket, 'You are sitting out this hand.');
  if (game.turn !== seat) return announceError(socket, 'Not your turn.');
  const card = game.hands[seat].find(c => c.id === cardId);
  if (!card) return announceError(socket, 'That card is not in your hand.');
  if (game.phase === 'playing' && !isLegalPlay(game, seat, card)) {
    return announceError(socket, `You must follow ${suitNames[effectiveSuit(game.trickCards[0].card, game.trump)]} if you can.`);
  }
  applyCardSwipe(game, seat, cardId);
}

function applyCardSwipe(game, seat, cardId) {
  const card = game.hands[seat].find(c => c.id === cardId);
  if (!card) return;

  if (game.phase === 'discard') {
    removeCard(game.hands[seat], cardId);
    game.buriedCard = card;
    beginPlaying(game, `${nameOf(game, seat)} discarded. ${nameOf(game, nextTurn(game, game.dealer))} leads the first trick.`);
    return;
  }

  if (game.phase === 'playing') {
    if (!isLegalPlay(game, seat, card)) return; // safety net; callers should only offer legal cards
    if (game.trickCards.length > 0) {
      const ledSuit = effectiveSuit(game.trickCards[0].card, game.trump);
      if (effectiveSuit(card, game.trump) !== ledSuit) {
        game.knownVoid[seat].add(ledSuit); // proven void: server enforces follow-suit, so this is certain
      }
    }
    removeCard(game.hands[seat], cardId);
    game.trickCards.push({ seat, card, team: teamOfSeat(seat) });
    game.playedCards.push(card); // public record of everything played this hand
    if (game.trickCards.length >= activePlayerCount(game)) {
      const winner = resolveTrick(game);
      const winningTeam = teamOfSeat(winner);
      game.tricksWon[winningTeam] += 1;
      game.trickPiles[winner] += 1;
      game.lastTrickWinner = winner;
      game.phase = 'trickComplete';
      game.turn = null;
      game.message = `${nameOf(game, winner)} wins the trick.`;
      emitState(game);
      setTimeout(() => finishTrick(game, winner), 1400);
      return;
    }
    game.turn = nextTurn(game, seat);
    game.message = `${nameOf(game, game.turn)} needs to play a card.`;
    return emitState(game);
  }
}

function beginPlaying(game, prefix) {
  game.phase = 'playing';
  game.round = 0;
  game.leader = nextTurn(game, game.dealer);
  game.turn = game.leader;
  game.trickCards = [];
  game.trickNumber = 0;
  game.message = `${prefix} ${nameOf(game, game.turn)} leads.`;
  emitState(game);
}

function finishTrick(game, winner) {
  if (game.phase !== 'trickComplete') return;
  const completedTricks = game.trickNumber + 1;
  if (completedTricks >= 5) {
    scoreHand(game);
    return;
  }
  game.trickNumber = completedTricks;
  game.trickCards = [];
  game.leader = winner;
  game.turn = winner;
  // The point outcome can be locked in before all five tricks are played
  // (a team has 3 with no march possible, or the makers are euchred). End early.
  if (isHandDetermined(game)) return endHandEarly(game, null);
  game.phase = 'playing';
  game.message = `${nameOf(game, winner)} leads trick ${game.trickNumber + 1}.`;
  emitState(game);
}

// True once remaining tricks can no longer change the points awarded.
function isHandDetermined(game) {
  if (game.maker == null) return false;
  const makerTeam = teamOfSeat(game.maker);
  const defTeam = makerTeam === 'blue' ? 'red' : 'blue';
  const mk = game.tricksWon[makerTeam];
  const df = game.tricksWon[defTeam];
  if (df >= 3) return true;            // makers are euchred
  if (mk >= 3 && df >= 1) return true; // makers have it, but march is off the table
  return false;
}

// How many tricks a player on lead can PROVABLY win, using public info only:
// the run of top trumps they hold where every higher trump is already accounted
// for (in their hand, already played, or the turned-down up-card). Any higher
// trump that hasn't been seen could sit with an opponent and stops the run.
// Leading these in order, the lead returns to them each time, so each is a
// guaranteed trick. Off-suit winners aren't counted (an opponent might trump).
function guaranteedTricks(game, seat) {
  const trump = game.trump;
  if (!trump) return 0;
  const seen = new Set(game.hands[seat].map(c => c.id));
  for (const c of game.playedCards) seen.add(c.id);
  if (game.upCardOut && game.upCard) seen.add(game.upCard.id);
  const mine = new Set(game.hands[seat].map(c => c.id));

  const trumpIds = ranks.map(r => `${r}${trump}`);
  trumpIds.push(`J${sameColorSuit(trump)}`);
  const ordered = trumpIds
    .map(id => ({ id, power: cardPower({ rank: id.slice(0, -1), suit: id.slice(-1) }, trump, trump) }))
    .sort((a, b) => b.power - a.power);

  let count = 0;
  for (const t of ordered) {
    if (mine.has(t.id)) { count++; continue; } // I hold the current top trump -> sure trick
    if (!seen.has(t.id)) break;                // unseen higher trump could be against me
    // otherwise it's already gone; keep scanning downward
  }
  return Math.min(count, game.hands[seat].length);
}

// A player on lead may claim once they can guarantee enough tricks to lock the
// hand: reach 3 for their team. They don't need every remaining trick — at 2-1
// one guaranteed trick is enough; at 1-1, two. The exception is when the makers
// could still march (they've lost no tricks): then only a full guaranteed sweep
// is offered, so claiming early never forfeits the extra march point.
function canClaimRemaining(game, seat) {
  if (game.phase !== 'playing' || game.turn !== seat) return false;
  if (game.trickCards.length !== 0) return false; // must be leading a fresh trick
  if (game.sitOut === seat) return false;
  if (isHandDetermined(game)) return false;
  const myTeam = teamOfSeat(seat);
  const oppTeam = myTeam === 'blue' ? 'red' : 'blue';
  const T = game.tricksWon[myTeam];
  const O = game.tricksWon[oppTeam];
  const remaining = 5 - T - O;
  const needed = 3 - T;
  if (remaining <= 0 || needed <= 0) return false;
  const guaranteed = Math.min(guaranteedTricks(game, seat), remaining);
  if (guaranteed <= 0) return false;
  const marchAtRisk = myTeam === teamOfSeat(game.maker) && O === 0; // makers could still sweep
  return marchAtRisk ? guaranteed >= remaining : guaranteed >= needed;
}

// Farmer's hand: dealt three 9s, before trump is chosen, swap them for the
// three buried kitty cards.
function canFarmersHand(game, seat) {
  if (game.trump) return false;
  if (game.phase !== 'ordering1' && game.phase !== 'ordering2') return false;
  if (game.sitOut === seat) return false;
  if (game.farmerUsed[seat]) return false;
  if (game.kitty.length < 4) return false;
  return game.hands[seat].filter(c => c.rank === '9').length >= 3;
}

function settleHand(game) {
  const makerTeam = teamOfSeat(game.maker);
  const defenderTeam = makerTeam === 'blue' ? 'red' : 'blue';
  const makerTricks = game.tricksWon[makerTeam];
  let points, scoringTeam, summary;
  if (makerTricks >= 3) {
    points = makerTricks === 5 ? (game.alone ? 4 : 2) : 1;
    scoringTeam = makerTeam;
    summary = `${makerTeam.toUpperCase()} made it with ${makerTricks} trick${makerTricks === 1 ? '' : 's'} for ${points} point${points === 1 ? '' : 's'}.`;
  } else {
    scoringTeam = defenderTeam;
    points = 2;
    summary = `${makerTeam.toUpperCase()} was euchred. ${defenderTeam.toUpperCase()} gets 2 points.`;
  }
  game.score[scoringTeam] += points;
  game.dealer = leftOf(game.dealer);
  return summary;
}

// Reveal everyone's remaining cards, score, then auto-deal the next hand.
function endHandEarly(game, claimSeat) {
  if (claimSeat != null) {
    const myTeam = teamOfSeat(claimSeat);
    const oppTeam = myTeam === 'blue' ? 'red' : 'blue';
    const T = game.tricksWon[myTeam];
    const O = game.tricksWon[oppTeam];
    const remaining = 5 - T - O;
    const marchAtRisk = myTeam === teamOfSeat(game.maker) && O === 0;
    // Award the claimer the tricks they guaranteed (a full sweep when going for
    // the march); any non-guaranteed remaining tricks go to the opponents. The
    // point outcome is already locked, so this distribution only sets the count.
    const take = marchAtRisk ? remaining : Math.min(guaranteedTricks(game, claimSeat), remaining);
    const giveOpp = remaining - take;
    if (take > 0) {
      game.tricksWon[myTeam] += take;
      game.trickPiles[claimSeat] += take;
    }
    if (giveOpp > 0) {
      game.tricksWon[oppTeam] += giveOpp;
      const oppSeat = [0, 1, 2, 3].find(s => teamOfSeat(s) === oppTeam && game.sitOut !== s);
      if (oppSeat != null) game.trickPiles[oppSeat] += giveOpp;
    }
  }
  game.revealHands = [0, 1, 2, 3].map(s => ({
    seat: s,
    name: nameOf(game, s),
    team: teamOfSeat(s),
    cards: sortedHand(game.hands[s], game.trump)
  }));
  const summary = settleHand(game);
  game.phase = 'reveal';
  game.turn = null;
  game.trickCards = [];
  const reason = claimSeat != null ? `${nameOf(game, claimSeat)} claimed the hand.` : 'Outcome decided early.';
  game.message = `${reason} ${summary}`;
  emitState(game);
  clearTimeout(game.autoNextTimer);
  game.autoNextTimer = setTimeout(() => { if (game.phase === 'reveal') startHand(game); }, 5000);
}

function scheduleAutoNext(game) {
  clearTimeout(game.autoNextTimer);
  game.autoNextTimer = setTimeout(() => { if (game.phase === 'betweenHands') startHand(game); }, 10000);
}

function scoreHand(game) {
  const summary = settleHand(game);
  game.phase = 'betweenHands';
  game.turn = null;
  game.message = `${summary} Next hand starts shortly…`;
  emitState(game);
  scheduleAutoNext(game);
}

function removeCard(hand, cardId) {
  const idx = hand.findIndex(c => c.id === cardId);
  if (idx >= 0) return hand.splice(idx, 1)[0];
  return null;
}

function effectiveSuit(card, trump) {
  if (!trump) return card.suit;
  if (card.rank === 'J' && card.suit === sameColorSuit(trump)) return trump;
  return card.suit;
}

function isRightBower(card, trump) {
  return card.rank === 'J' && card.suit === trump;
}

function isLeftBower(card, trump) {
  return card.rank === 'J' && card.suit === sameColorSuit(trump);
}

function cardPower(card, ledSuit, trump) {
  if (trump) {
    if (isRightBower(card, trump)) return 200;
    if (isLeftBower(card, trump)) return 199;
  }
  const eff = effectiveSuit(card, trump);
  if (eff === trump) {
    const order = { A: 196, K: 195, Q: 194, '10': 193, '9': 192, J: 191 };
    return order[card.rank] || 190;
  }
  if (eff === ledSuit) {
    const order = { A: 100, K: 99, Q: 98, J: 97, '10': 96, '9': 95 };
    return order[card.rank] || 0;
  }
  return 0;
}

function resolveTrick(game) {
  const ledSuit = effectiveSuit(game.trickCards[0].card, game.trump);
  let best = game.trickCards[0];
  let bestPower = cardPower(best.card, ledSuit, game.trump);
  for (const play of game.trickCards.slice(1)) {
    const power = cardPower(play.card, ledSuit, game.trump);
    if (power > bestPower) {
      best = play;
      bestPower = power;
    }
  }
  return best.seat;
}

function isLegalPlay(game, seat, card) {
  if (!game.trickCards.length) return true;
  const ledSuit = effectiveSuit(game.trickCards[0].card, game.trump);
  const hasLedSuit = game.hands[seat].some(c => effectiveSuit(c, game.trump) === ledSuit);
  if (!hasLedSuit) return true;
  return effectiveSuit(card, game.trump) === ledSuit;
}

function getLegalCardIds(game, seat) {
  if (game.phase !== 'playing' || game.turn !== seat) return [];
  return game.hands[seat].filter(card => isLegalPlay(game, seat, card)).map(card => card.id);
}

// ---- Bot strategy: bidding & discard (point-count hand evaluation) ----
// Point values follow standard euchre strategy-guide tables: bowers and trump
// are worth the most, a lone off-suit ace is a likely trick, and empty/short
// side suits are worth extra because they let you ruff later.

function cardBidValue(card, trump) {
  if (isRightBower(card, trump)) return 10;
  if (isLeftBower(card, trump)) return 9;
  const eff = effectiveSuit(card, trump);
  if (eff === trump) {
    return { A: 7, K: 6, Q: 5, '10': 4, '9': 3 }[card.rank] ?? 3;
  }
  if (card.rank === 'A') return 4;
  if (card.rank === 'K') return 2;
  if (card.rank === 'Q') return 1;
  return 0;
}

function handBidScore(hand, trump) {
  let score = 0;
  const suitCounts = { S: 0, H: 0, D: 0, C: 0 };
  let trumpCount = 0;
  for (const card of hand) {
    score += cardBidValue(card, trump);
    const eff = effectiveSuit(card, trump);
    suitCounts[eff] += 1;
    if (eff === trump) trumpCount += 1;
  }
  if (trumpCount >= 3) score += 2;
  if (trumpCount >= 4) score += 4;
  for (const s of suits) {
    if (s === trump) continue;
    if (suitCounts[s] === 0) score += 1.5; // void: free ruffing later
    else if (suitCounts[s] === 1) score += 0.5; // easy to void quickly
  }
  return score;
}

function bestDiscard(cards, trump) {
  let best = null;
  for (const candidate of cards) {
    const remaining = cards.filter(c => c !== candidate);
    const score = handBidScore(remaining, trump);
    if (!best || score > best.score) best = { discard: candidate, score };
  }
  return best.discard;
}

// Non-dealer callers weigh whether ordering-up hands a free trump card to the
// dealer's team (if the dealer is on the other side) or their own (if the
// dealer is their partner) - that risk shifts the bar for calling trump.
function botOrdering1(game, seat) {
  const upSuit = game.upCard.suit;
  const isDealer = seat === game.dealer;
  const dealerIsPartner = teamOfSeat(seat) === teamOfSeat(game.dealer);
  let score;
  if (isDealer) {
    const withUp = [...game.hands[seat], game.upCard];
    let best = null;
    for (const candidate of withUp) {
      const remaining = withUp.filter(c => c !== candidate);
      const s = handBidScore(remaining, upSuit);
      if (best == null || s > best) best = s;
    }
    score = best;
  } else {
    score = handBidScore(game.hands[seat], upSuit);
  }
  const threshold = isDealer ? 13 : (dealerIsPartner ? 12 : 15);
  const aloneThreshold = isDealer ? 19 : (dealerIsPartner ? 18 : 20);
  if (score >= threshold) {
    return applyTrumpAction(game, seat, { action: 'orderUp', alone: score >= aloneThreshold });
  }
  return applyTrumpAction(game, seat, { action: 'pass' });
}

function botOrdering2(game, seat) {
  const options = suits.filter(s => s !== game.upCard.suit);
  let best = null;
  for (const suit of options) {
    const s = handBidScore(game.hands[seat], suit);
    if (!best || s > best.score) best = { suit, score: s };
  }
  const threshold = 12;
  const aloneThreshold = 18;
  if (best && best.score >= threshold) {
    return applyTrumpAction(game, seat, { action: 'chooseSuit', suit: best.suit, alone: best.score >= aloneThreshold });
  }
  return applyTrumpAction(game, seat, { action: 'pass' });
}

function botDiscard(game, seat) {
  const discard = bestDiscard(game.hands[seat], game.trump);
  if (discard) applyCardSwipe(game, seat, discard.id);
}

// ---- Bot strategy: card play (determinized Monte Carlo simulation) ----
// The bot only ever looks at its own hand, cards already played, the up-card,
// and (if it's the dealer) its own discard - never at another seat's real
// hand. Hidden hands are randomly reconstructed ("determinized") consistent
// with public knowledge, including suits players have proven void by failing
// to follow. Many random reconstructions are simulated to the end of the
// hand using a simple heuristic policy, and the legal card with the best
// average outcome for the bot's team is chosen - a lightweight ISMCTS bot.

function mustFollowSuit(hand, trickCardsSoFar, trump) {
  if (!trickCardsSoFar.length) return null;
  const led = effectiveSuit(trickCardsSoFar[0].card, trump);
  return hand.some(c => effectiveSuit(c, trump) === led) ? led : null;
}

function legalCardsFor(hand, trickCardsSoFar, trump) {
  const led = mustFollowSuit(hand, trickCardsSoFar, trump);
  if (!led) return hand.slice();
  return hand.filter(c => effectiveSuit(c, trump) === led);
}

function chooseLead(hand, trump) {
  const trumpCards = hand.filter(c => effectiveSuit(c, trump) === trump);
  if (trumpCards.length >= 3) {
    return trumpCards.slice().sort((a, b) => cardPower(b, trump, trump) - cardPower(a, trump, trump))[0];
  }
  const suitCounts = { S: 0, H: 0, D: 0, C: 0 };
  hand.forEach(c => { suitCounts[effectiveSuit(c, trump)] += 1; });
  const safeAces = hand.filter(c => c.rank === 'A' && effectiveSuit(c, trump) !== trump && suitCounts[effectiveSuit(c, trump)] >= 2);
  if (safeAces.length) return safeAces[0];
  const singleton = hand.filter(c => effectiveSuit(c, trump) !== trump && suitCounts[effectiveSuit(c, trump)] === 1 && trumpCards.length > 0);
  if (singleton.length) return singleton[0];
  const nonTrump = hand.filter(c => effectiveSuit(c, trump) !== trump);
  const pool = nonTrump.length ? nonTrump : hand;
  return pool.slice().sort((a, b) => cardPower(a, a.suit, trump) - cardPower(b, b.suit, trump))[0];
}

function chooseFollow(hand, legal, trickCardsSoFar, trump, seat) {
  const ledSuit = effectiveSuit(trickCardsSoFar[0].card, trump);
  let bestPlay = trickCardsSoFar[0];
  let bestPower = cardPower(bestPlay.card, ledSuit, trump);
  for (const p of trickCardsSoFar.slice(1)) {
    const pw = cardPower(p.card, ledSuit, trump);
    if (pw > bestPower) { bestPlay = p; bestPower = pw; }
  }
  const myTeam = teamOfSeat(seat);
  const winningTeam = teamOfSeat(bestPlay.seat);
  const sortedLow = legal.slice().sort((a, b) => cardPower(a, ledSuit, trump) - cardPower(b, ledSuit, trump));
  if (winningTeam === myTeam) {
    return sortedLow[0]; // partner (or myself) already winning - conserve strength
  }
  const winners = sortedLow.filter(c => cardPower(c, ledSuit, trump) > bestPower);
  if (winners.length) return winners[0]; // cheapest card that still wins
  return sortedLow[0]; // can't win - throw the least valuable legal card
}

function heuristicChoosePlay(hand, trickCardsSoFar, trump, seat) {
  if (!trickCardsSoFar.length) return chooseLead(hand, trump);
  const legal = legalCardsFor(hand, trickCardsSoFar, trump);
  return chooseFollow(hand, legal, trickCardsSoFar, trump, seat);
}

function nextTurnGeneric(seat, sitOut) {
  let n = leftOf(seat);
  while (sitOut != null && n === sitOut) n = leftOf(n);
  return n;
}

function rolloutHand(startHands, trump, sitOut, startTrickCards, startTrickNumber, startTricksWon, startTurn) {
  const hands = startHands.map(h => h.slice());
  let trickCards = startTrickCards.map(p => ({ seat: p.seat, card: p.card }));
  const tricksWon = { blue: startTricksWon.blue, red: startTricksWon.red };
  let trickNumber = startTrickNumber;
  let turn = startTurn;
  const activeCount = sitOut != null ? 3 : 4;
  while (trickNumber < 5) {
    while (trickCards.length < activeCount) {
      const hand = hands[turn];
      const card = heuristicChoosePlay(hand, trickCards, trump, turn);
      if (!card) break; // safety net against a bad determinization
      const idx = hand.findIndex(c => c.id === card.id);
      if (idx >= 0) hand.splice(idx, 1);
      trickCards.push({ seat: turn, card });
      turn = nextTurnGeneric(turn, sitOut);
    }
    if (!trickCards.length) break;
    const ledSuit = effectiveSuit(trickCards[0].card, trump);
    let best = trickCards[0];
    let bestPower = cardPower(best.card, ledSuit, trump);
    for (const p of trickCards.slice(1)) {
      const pw = cardPower(p.card, ledSuit, trump);
      if (pw > bestPower) { best = p; bestPower = pw; }
    }
    tricksWon[teamOfSeat(best.seat)] += 1;
    trickNumber += 1;
    trickCards = [];
    turn = best.seat;
  }
  return tricksWon;
}

// Randomly reconstruct a full, consistent deal from one seat's point of view.
function determinizeHands(game, mySeat) {
  const trump = game.trump;
  const known = new Set();
  for (const c of game.hands[mySeat]) known.add(c.id);
  for (const c of game.playedCards) known.add(c.id);
  if (game.buriedCard && mySeat === game.dealer) known.add(game.buriedCard.id);

  let upCardOwner = null;
  if (game.upCard && !known.has(game.upCard.id)) {
    if (game.upCardOut) {
      known.add(game.upCard.id); // turned down, permanently out of play
    } else if (mySeat === game.dealer) {
      known.add(game.upCard.id); // I'm the dealer; my real hand already accounts for it
    } else {
      upCardOwner = game.dealer; // presumed still live in the dealer's hand
    }
  }

  const pool = shuffle(ALL_CARDS.filter(c => !known.has(c.id) && !(upCardOwner != null && c.id === game.upCard.id)));

  const result = new Array(4).fill(null);
  result[mySeat] = game.hands[mySeat].slice();
  const remaining = {};
  for (const seat of seats) {
    if (seat === mySeat) continue;
    if (game.sitOut === seat) { result[seat] = []; continue; }
    result[seat] = [];
    remaining[seat] = game.hands[seat].length;
    if (upCardOwner === seat) {
      result[seat].push(game.upCard);
      remaining[seat] -= 1;
    }
  }

  for (const card of pool) {
    const eff = effectiveSuit(card, trump);
    let candidates = Object.keys(remaining).map(Number).filter(s => remaining[s] > 0 && !game.knownVoid[s].has(eff));
    if (!candidates.length) candidates = Object.keys(remaining).map(Number).filter(s => remaining[s] > 0);
    if (!candidates.length) continue; // extra unseen card (e.g. the buried card) - simply unused
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    result[pick].push(card);
    remaining[pick] -= 1;
  }
  return result;
}

function scoreDelta(tricksWon, myTeam, maker, alone) {
  const makerTeam = teamOfSeat(maker);
  const defTeam = makerTeam === 'blue' ? 'red' : 'blue';
  const makerTricks = tricksWon[makerTeam];
  let points, scoringTeam;
  if (makerTricks >= 3) {
    points = makerTricks === 5 ? (alone ? 4 : 2) : 1;
    scoringTeam = makerTeam;
  } else {
    points = 2;
    scoringTeam = defTeam;
  }
  return scoringTeam === myTeam ? points : -points;
}

function botChooseCard(game, seat) {
  const hand = game.hands[seat];
  const legalIds = getLegalCardIds(game, seat);
  const legalCards = hand.filter(c => legalIds.includes(c.id));
  if (legalCards.length <= 1) return legalCards[0] || hand[0] || null;

  const trials = 50;
  const myTeam = teamOfSeat(seat);
  const totals = new Map(legalCards.map(c => [c.id, 0]));

  for (let t = 0; t < trials; t++) {
    const det = determinizeHands(game, seat);
    for (const card of legalCards) {
      const trickCards = game.trickCards.map(p => ({ seat: p.seat, card: p.card }));
      trickCards.push({ seat, card });
      const handsCopy = det.map((h, s) => (s === seat ? hand.filter(c => c.id !== card.id) : h.slice()));
      const nextSeat = nextTurnGeneric(seat, game.sitOut);
      const tricksWon = rolloutHand(handsCopy, game.trump, game.sitOut, trickCards, game.trickNumber, game.tricksWon, nextSeat);
      totals.set(card.id, totals.get(card.id) + scoreDelta(tricksWon, myTeam, game.maker, game.alone));
    }
  }

  let bestCard = legalCards[0];
  let bestScore = -Infinity;
  for (const card of legalCards) {
    const avg = totals.get(card.id);
    if (avg > bestScore) { bestScore = avg; bestCard = card; }
  }
  return bestCard;
}

io.on('connection', socket => {
  socket.on('createRoom', cb => {
    const room = nanoid();
    const game = getGame(room);
    socket.join(room);
    game.tableSockets.add(socket.id);
    socket.data.room = room;
    socket.data.role = 'table';
    cb && cb({ room, state: publicState(game) });
    emitState(game);
  });

  socket.on('joinTable', ({ room } = {}, cb) => {
    if (!room) room = nanoid();
    const game = getGame(room);
    socket.join(room);
    game.tableSockets.add(socket.id);
    socket.data.room = room;
    socket.data.role = 'table';
    cb && cb({ room, state: publicState(game) });
    emitState(game);
  });

  socket.on('joinSeat', ({ room, seat, name } = {}, cb) => {
    if (!room || typeof seat !== 'number' || seat < 0 || seat > 3) {
      cb && cb({ error: 'Invalid room or seat.' });
      return;
    }
    const game = getGame(room);
    socket.join(room);
    socket.join(`${room}:seat:${seat}`);
    game.seatSockets[seat].add(socket.id);
    game.isBot[seat] = false; // a human is claiming this seat, bot steps aside
    if (typeof name === 'string' && name.trim()) game.names[seat] = name.trim().slice(0, 16);
    socket.data.room = room;
    socket.data.seat = seat;
    socket.data.role = 'hand';
    cb && cb({ room, seat, state: privateState(game, seat) });
    game.message = game.phase === 'lobby'
      ? 'Players are joining. Press Start Hand when everyone is ready.'
      : game.message;
    emitState(game);
  });

  socket.on('startHand', ({ room } = {}) => {
    const game = games.get(room || socket.data.room);
    if (!game) return;
    if (!['lobby', 'betweenHands'].includes(game.phase)) return;
    startHand(game);
  });

  socket.on('resetGame', ({ room } = {}) => {
    const old = games.get(room || socket.data.room);
    if (!old) return;
    clearTimeout(old.autoNextTimer);
    clearTimeout(old.botTimer);
    const newGame = createGame(old.room);
    newGame.seatSockets = old.seatSockets;
    newGame.tableSockets = old.tableSockets;
    games.set(old.room, newGame);
    emitState(newGame);
  });

  socket.on('setName', ({ room, seat, name } = {}) => {
    const game = games.get(room || socket.data.room);
    if (!game || typeof seat !== 'number' || seat < 0 || seat > 3) return;
    if (typeof name === 'string' && name.trim()) {
      game.names[seat] = name.trim().slice(0, 16);
      emitState(game);
    }
  });

  socket.on('farmersHand', ({ room, seat } = {}) => {
    const game = games.get(room || socket.data.room);
    if (!game || typeof seat !== 'number') return;
    if (!canFarmersHand(game, seat)) return announceError(socket, "Farmer's hand isn't available.");
    const nines = game.hands[seat].filter(c => c.rank === '9').slice(0, 3);
    const buried = game.kitty.slice(1, 4);
    nines.forEach(n => removeCard(game.hands[seat], n.id));
    game.hands[seat].push(...buried);
    game.kitty = [game.kitty[0], ...nines];
    game.farmerUsed[seat] = true;
    game.message = `${nameOf(game, seat)} declared a farmer's hand and swapped three 9s.`;
    emitState(game);
  });

  socket.on('endEarly', ({ room, seat } = {}) => {
    const game = games.get(room || socket.data.room);
    if (!game || typeof seat !== 'number') return;
    if (!canClaimRemaining(game, seat)) return announceError(socket, 'You can no longer claim the rest.');
    endHandEarly(game, seat);
  });

  socket.on('trumpAction', payload => handleTrumpAction(socket, payload));
  socket.on('cardSwipe', payload => handleCardSwipe(socket, payload));

  socket.on('disconnect', () => {
    const { room, role, seat } = socket.data || {};
    const game = room ? games.get(room) : null;
    if (!game) return;
    if (role === 'table') game.tableSockets.delete(socket.id);
    if (role === 'hand' && typeof seat === 'number') game.seatSockets[seat].delete(socket.id);
    emitState(game);
  });
});

server.listen(PORT, () => {
  console.log(`Euchre app listening on port ${PORT}`);
});
