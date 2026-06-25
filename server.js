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

function startHand(game) {
  clearTimeout(game.autoNextTimer);
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
      if (!suits.includes(suit) || suit === game.upCard.suit) return announceError(socket, 'That suit is not available.');
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

  if (game.phase === 'discard') {
    removeCard(game.hands[seat], cardId);
    game.buriedCard = card;
    beginPlaying(game, `${nameOf(game, seat)} discarded. ${nameOf(game, nextTurn(game, game.dealer))} leads the first trick.`);
    return;
  }

  if (game.phase === 'playing') {
    if (!isLegalPlay(game, seat, card)) {
      return announceError(socket, `You must follow ${suitNames[effectiveSuit(game.trickCards[0].card, game.trump)]} if you can.`);
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
