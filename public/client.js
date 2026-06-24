const app = document.getElementById('app');
const params = new URLSearchParams(window.location.search);
const role = params.get('role');
const roomParam = params.get('room');
const seatParam = params.get('seat');
const preview = params.get('preview') === '1' || params.get('preview') === 'true';

const seatLabels = ['South', 'West', 'North', 'East'];
const suitSymbols = { S: '♠', H: '♥', D: '♦', C: '♣' };
const suitNames = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
const teamOfSeat = seat => seat === 0 || seat === 2 ? 'blue' : 'red';
const seatAngle = { 2: 0, 3: 90, 0: 180, 1: 270 };

let socket = null;
let currentRoom = roomParam;
let mySeat = seatParam == null ? null : Number(seatParam);
let tableState = null;
let handState = null;
let selectedIndex = 0;
let lastDealSeq = null;
let previewHand = [];
let previewTeam = 'blue';
let toastTimer = null;

function qs(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function absoluteUrl(pathAndQuery) {
  return `${window.location.origin}${pathAndQuery}`;
}

function init() {
  if (preview) return initPreview();
  if (role === 'table') return initTable();
  if (role === 'hand') return initHand();
  renderLanding();
}

function connectSocket() {
  if (socket) return socket;
  socket = io();
  socket.on('toast', ({ message }) => showToast(message));
  socket.on('dealStart', handleDealStart);
  return socket;
}

function renderLanding() {
  const room = currentRoom || randomRoomHint();
  app.innerHTML = `
    <section class="landing">
      <div class="landing-card">
        <h1>Euchre Table</h1>
        <p>Use the iPad as the table. Each phone scans a seat QR code and becomes that player’s hand.</p>
        <div class="landing-actions">
          <a class="primary-link" href="/?${qs({ role: 'table', room })}">Open table view</a>
          <a class="secondary-link" href="/?${qs({ role: 'hand', preview: 1 })}">Open phone preview mode</a>
        </div>
        <p class="tiny">Deploy this on Railway, open the table URL on the iPad, then scan the four seat links.</p>
      </div>
    </section>
  `;
}

function randomRoomHint() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function initTable() {
  document.body.className = 'table-body';
  connectSocket();
  const requestedRoom = currentRoom || randomRoomHint();
  socket.emit('joinTable', { room: requestedRoom }, ({ room, state }) => {
    currentRoom = room;
    tableState = state;
    const url = new URL(window.location.href);
    url.search = qs({ role: 'table', room });
    window.history.replaceState({}, '', url);
    renderTable();
  });
  socket.on('tableState', state => {
    tableState = state;
    renderTable();
  });
}

function initHand() {
  if (!currentRoom || !Number.isInteger(mySeat) || mySeat < 0 || mySeat > 3) {
    app.innerHTML = `<section class="landing"><div class="landing-card"><h1>Bad hand link</h1><p>Scan one of the four QR codes on the table.</p></div></section>`;
    return;
  }
  document.body.className = `phone-body ${teamOfSeat(mySeat)}-phone`;
  connectSocket();
  socket.emit('joinSeat', { room: currentRoom, seat: mySeat }, res => {
    if (res && res.error) return showToast(res.error);
    handState = res.state;
    renderHand();
  });
  socket.on('handState', state => {
    if (state.seat !== mySeat) return;
    handState = state;
    selectedIndex = Math.min(selectedIndex, Math.max(0, state.hand.length - 1));
    renderHand();
  });
}

function initPreview() {
  document.body.className = 'phone-body blue-phone preview-phone';
  previewHand = shuffle(makeDeck()).slice(0, 5);
  selectedIndex = 2;
  renderPreviewHand();
}

function renderTable() {
  if (!tableState) return;
  const state = tableState;
  const tableUrl = absoluteUrl(`/?${qs({ role: 'table', room: state.room })}`);
  const turnArrow = state.turn != null ? `<div class="turn-arrow" style="--turn-angle:${seatAngle[state.turn]}deg"></div>` : '';
  const upCardHtml = state.upCard ? cardHtml(state.upCard, 'table-card up-card') : `<div class="card-back table-card up-card"></div>`;
  const played = state.trickCards.map(play => `
    <div class="played-card played-seat-${play.seat}">${cardHtml(play.card, 'table-card')}</div>
  `).join('');
  const qrSeats = [2, 3, 0, 1].map(seat => qrForSeat(state, seat)).join('');
  const seatZones = [0, 1, 2, 3].map(seat => seatZone(state, seat)).join('');
  const controls = tableControls(state);

  app.innerHTML = `
    <section id="table" class="table-screen phase-${state.phase}">
      <div class="felt"></div>
      <div class="scorecard">
        <div class="score blue-score"><span>Blue</span><strong>${state.score.blue}</strong></div>
        <div class="score red-score"><span>Red</span><strong>${state.score.red}</strong></div>
      </div>
      <div class="room-badge">Room ${state.room}</div>
      <div class="state-banner">${escapeHtml(state.message || '')}</div>
      ${turnArrow}
      <div class="center-area">
        <div class="kitty-stack">
          <div class="card-back table-card kitty-back"></div>
          ${state.phase === 'ordering1' || state.phase === 'ordering2' || state.phase === 'discard' ? upCardHtml : ''}
        </div>
        <div class="trump-label">${state.trump ? `Trump: ${suitSymbols[state.trump]} ${state.trumpName}` : 'Trump not chosen'}</div>
        ${state.alone && state.maker != null ? `<div class="alone-pill">${seatLabels[state.maker]} is going alone</div>` : ''}
      </div>
      <div class="played-layer">${played}</div>
      ${seatZones}
      <div class="qr-layer">${qrSeats}</div>
      ${controls}
      <div class="table-link">${escapeHtml(tableUrl)}</div>
      <div id="dealLayer" class="deal-layer"></div>
    </section>
  `;

  const startBtn = document.querySelector('[data-start-hand]');
  if (startBtn) startBtn.addEventListener('click', () => socket.emit('startHand', { room: state.room }));
  const resetBtn = document.querySelector('[data-reset-game]');
  if (resetBtn) resetBtn.addEventListener('click', () => socket.emit('resetGame', { room: state.room }));
}

function qrForSeat(state, seat) {
  const team = teamOfSeat(seat);
  const link = absoluteUrl(`/?${qs({ role: 'hand', room: state.room, seat })}`);
  const qrSrc = `/qr?url=${encodeURIComponent(link)}`;
  const connected = state.seats.find(s => s.seat === seat)?.connected;
  return `
    <div class="seat-qr seat-qr-${seat} ${team}-border ${connected ? 'connected' : ''}">
      <img src="${qrSrc}" alt="Join ${seatLabels[seat]}" />
      <div class="qr-caption">${seatLabels[seat]} • ${team}</div>
      ${connected ? '<div class="connected-dot">joined</div>' : ''}
    </div>
  `;
}

function seatZone(state, seat) {
  const seatState = state.seats.find(s => s.seat === seat) || {};
  const team = teamOfSeat(seat);
  const isTurn = state.turn === seat;
  const pileCount = state.trickPiles?.[seat] || 0;
  const dealer = state.dealer === seat ? '<span class="dealer-chip">D</span>' : '';
  const sitOut = state.sitOut === seat ? '<span class="sitout-chip">sitting out</span>' : '';
  return `
    <div class="seat-zone seat-zone-${seat} ${team}-seat ${isTurn ? 'turn-seat' : ''}">
      <div class="seat-name">${dealer}${seatLabels[seat]} ${sitOut}</div>
      <div class="seat-status">${seatState.connected ? 'phone connected' : 'scan QR to join'}</div>
      <div class="trick-pile" aria-label="tricks won">
        ${Array.from({ length: Math.min(pileCount, 5) }, (_, i) => `<div class="mini-back" style="--pile-i:${i}"></div>`).join('')}
      </div>
    </div>
  `;
}

function tableControls(state) {
  const canStart = state.phase === 'lobby' || state.phase === 'betweenHands';
  return `
    <div class="table-controls">
      ${canStart ? `<button data-start-hand>${state.phase === 'lobby' ? 'Start Hand' : 'Next Hand'}</button>` : ''}
      <button data-reset-game class="ghost-btn">Reset</button>
      <a class="ghost-link" href="/?${qs({ role: 'hand', preview: 1 })}" target="_blank">Phone Preview</a>
    </div>
  `;
}

function handleDealStart(deal) {
  if (role === 'table') animateTableDeal(deal);
  if (role === 'hand' && deal.sequence) animatePhoneDeal(deal);
}

function animateTableDeal(deal) {
  lastDealSeq = deal.seq;
  setTimeout(() => {
    const layer = document.getElementById('dealLayer');
    if (!layer) return;
    layer.innerHTML = '';
    const startDelay = Math.max(0, deal.startedAt - Date.now());
    deal.sequence.forEach((entry, i) => {
      const el = document.createElement('div');
      el.className = `deal-card card-back deal-to-${entry.seat}`;
      el.style.animationDelay = `${startDelay + i * deal.intervalMs}ms`;
      layer.appendChild(el);
    });
    const up = document.createElement('div');
    up.className = 'deal-up-card';
    up.innerHTML = cardHtml(deal.upCard, 'table-card');
    up.style.animationDelay = `${startDelay + deal.sequence.length * deal.intervalMs + 100}ms`;
    layer.appendChild(up);
  }, 60);
}

function animatePhoneDeal(deal) {
  if (!Number.isInteger(mySeat)) return;
  const mine = deal.sequence.filter(entry => entry.seat === mySeat);
  const layer = document.querySelector('.phone-deal-layer');
  if (!layer) return;
  layer.innerHTML = '';
  const startDelay = Math.max(0, deal.startedAt - Date.now());
  mine.forEach((entry, i) => {
    const el = document.createElement('div');
    el.className = 'incoming-card';
    el.innerHTML = cardHtml(entry.card, 'phone-card mini-incoming');
    el.style.animationDelay = `${startDelay + entry.index * deal.intervalMs + 220}ms`;
    layer.appendChild(el);
  });
}

function renderHand() {
  if (!handState) return;
  const state = handState;
  document.body.className = `phone-body ${state.team}-phone`;
  const cards = state.phase === 'dealing' ? [] : (state.hand || []);
  selectedIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, cards.length - 1));
  app.innerHTML = `
    <section class="phone-screen">
      <div class="phone-deal-layer"></div>
      ${actionPanel(state)}
      <div id="fan" class="card-fan" style="--count:${cards.length}">
        ${cards.map((card, index) => cardInFan(card, index, cards.length, state)).join('')}
      </div>
      <div id="toast" class="toast"></div>
    </section>
  `;
  attachFanHandlers(cards, false);
}

function renderPreviewHand() {
  const cards = previewHand;
  selectedIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, cards.length - 1));
  app.innerHTML = `
    <section class="phone-screen">
      <div class="preview-hint">Preview mode — swipe sideways through the fan, swipe up to throw a card.</div>
      <div id="fan" class="card-fan preview-fan" style="--count:${cards.length}">
        ${cards.map((card, index) => cardInFan(card, index, cards.length, { legalCardIds: cards.map(c => c.id), canAct: true, actionType: 'play' })).join('')}
      </div>
      <div id="toast" class="toast"></div>
    </section>
  `;
  attachFanHandlers(cards, true);
}

function actionPanel(state) {
  if (!state.canAct) {
    if (state.actionType === 'sitOut') return `<div class="action-panel quiet">${escapeHtml(state.actionText)}</div>`;
    return '';
  }
  if (state.actionType === 'ordering1') {
    const label = state.dealer === state.seat ? 'Pick up' : 'Order up';
    return `
      <div class="action-panel">
        <div class="action-text">${escapeHtml(state.actionText)}</div>
        <div class="action-buttons">
          <button data-trump-action="pass">Pass</button>
          <button data-trump-action="orderUp">${label}</button>
          <button data-trump-action="orderAlone">${label} alone</button>
        </div>
      </div>
    `;
  }
  if (state.actionType === 'ordering2') {
    return `
      <div class="action-panel suit-panel">
        <div class="action-text">${escapeHtml(state.actionText)}</div>
        <div class="action-buttons wrap">
          <button data-trump-action="pass">Pass</button>
          ${state.suitOptions.map(opt => `<button data-choose-suit="${opt.suit}">${opt.symbol} ${opt.name}</button>`).join('')}
          ${state.suitOptions.map(opt => `<button data-choose-suit-alone="${opt.suit}">${opt.symbol} Alone</button>`).join('')}
        </div>
      </div>
    `;
  }
  if (state.actionType === 'discard' || state.actionType === 'play') {
    return `<div class="action-panel swipe-panel">${escapeHtml(state.actionText)}</div>`;
  }
  return '';
}

function cardInFan(card, index, count, state) {
  const offset = index - selectedIndex;
  const angle = Math.max(-36, Math.min(36, offset * 9));
  const shift = Math.max(-110, Math.min(110, offset * 34));
  const raise = index === selectedIndex ? -18 : 0;
  const scale = index === selectedIndex ? 1.04 : 0.96;
  const legalIds = state.legalCardIds || [];
  const isIllegal = state.canAct && state.actionType === 'play' && legalIds.length && !legalIds.includes(card.id);
  return `
    <div class="fan-slot ${index === selectedIndex ? 'selected' : ''} ${isIllegal ? 'illegal-card' : ''}"
      data-index="${index}"
      data-card-id="${card.id}"
      style="--angle:${angle}deg; --shift:${shift}px; --raise:${raise}px; --scale:${scale}; --z:${100 + index + (index === selectedIndex ? 50 : 0)}">
      ${cardHtml(card, 'phone-card')}
    </div>
  `;
}

function attachFanHandlers(cards, isPreview) {
  const fan = document.getElementById('fan');
  if (!fan) return;
  let startX = 0;
  let startY = 0;
  let activeIndex = null;
  let didGesture = false;

  fan.querySelectorAll('.fan-slot').forEach(slot => {
    slot.addEventListener('pointerdown', event => {
      event.preventDefault();
      slot.setPointerCapture(event.pointerId);
      startX = event.clientX;
      startY = event.clientY;
      activeIndex = Number(slot.dataset.index);
      didGesture = false;
    });
    slot.addEventListener('pointerup', event => {
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      const idx = activeIndex ?? Number(slot.dataset.index);
      const card = cards[idx];
      activeIndex = null;
      if (!card) return;
      if (dy < -90 && Math.abs(dy) > Math.abs(dx) * 1.1) {
        didGesture = true;
        playOrPreviewCard(card, isPreview);
        return;
      }
      if (Math.abs(dx) > 38 && Math.abs(dx) > Math.abs(dy)) {
        didGesture = true;
        selectedIndex = clamp(selectedIndex + (dx < 0 ? 1 : -1), 0, cards.length - 1);
        rerenderFanOnly(cards, isPreview);
        return;
      }
      selectedIndex = idx;
      rerenderFanOnly(cards, isPreview);
    });
    slot.addEventListener('click', () => {
      if (didGesture) return;
      selectedIndex = Number(slot.dataset.index);
      rerenderFanOnly(cards, isPreview);
    });
  });

  document.querySelectorAll('[data-trump-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.trumpAction;
      if (kind === 'pass') socket.emit('trumpAction', { room: handState.room, seat: mySeat, action: 'pass' });
      if (kind === 'orderUp') socket.emit('trumpAction', { room: handState.room, seat: mySeat, action: 'orderUp', alone: false });
      if (kind === 'orderAlone') socket.emit('trumpAction', { room: handState.room, seat: mySeat, action: 'orderUp', alone: true });
    });
  });
  document.querySelectorAll('[data-choose-suit]').forEach(btn => {
    btn.addEventListener('click', () => socket.emit('trumpAction', { room: handState.room, seat: mySeat, action: 'chooseSuit', suit: btn.dataset.chooseSuit, alone: false }));
  });
  document.querySelectorAll('[data-choose-suit-alone]').forEach(btn => {
    btn.addEventListener('click', () => socket.emit('trumpAction', { room: handState.room, seat: mySeat, action: 'chooseSuit', suit: btn.dataset.chooseSuitAlone, alone: true }));
  });
}

function rerenderFanOnly(cards, isPreview) {
  const fan = document.getElementById('fan');
  if (!fan) return;
  const state = isPreview
    ? { legalCardIds: cards.map(c => c.id), canAct: true, actionType: 'play' }
    : handState;
  fan.innerHTML = cards.map((card, index) => cardInFan(card, index, cards.length, state)).join('');
  attachFanHandlers(cards, isPreview);
}

function playOrPreviewCard(card, isPreview) {
  if (isPreview) {
    const idx = previewHand.findIndex(c => c.id === card.id);
    if (idx >= 0) {
      const [removed] = previewHand.splice(idx, 1);
      showToast(`Played ${removed.label}`);
      selectedIndex = Math.min(selectedIndex, Math.max(0, previewHand.length - 1));
      setTimeout(() => {
        previewHand.push(removed);
        selectedIndex = Math.min(2, previewHand.length - 1);
        renderPreviewHand();
      }, 900);
      renderPreviewHand();
    }
    return;
  }
  if (!handState?.canAct || !['play', 'discard'].includes(handState.actionType)) {
    showToast('You can only swipe a card up on your turn.');
    return;
  }
  socket.emit('cardSwipe', { room: handState.room, seat: mySeat, cardId: card.id });
}

function cardHtml(card, className = '') {
  if (!card) return '';
  const red = card.suit === 'H' || card.suit === 'D';
  return `
    <div class="playing-card ${className} ${red ? 'red-card' : 'black-card'}" data-card="${card.id}">
      <div class="corner top"><span>${card.rank}</span><span>${suitSymbols[card.suit]}</span></div>
      <div class="card-center"><span>${card.rank}</span><span>${suitSymbols[card.suit]}</span></div>
      <div class="corner bottom"><span>${card.rank}</span><span>${suitSymbols[card.suit]}</span></div>
    </div>
  `;
}

function makeDeck() {
  const ranks = ['9', '10', 'J', 'Q', 'K', 'A'];
  const suits = ['S', 'H', 'D', 'C'];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) deck.push({ id: `${rank}${suit}`, rank, suit, label: `${rank}${suitSymbols[suit]}` });
  }
  return deck;
}

function shuffle(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function showToast(message) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

init();
