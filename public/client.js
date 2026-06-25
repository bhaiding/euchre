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
let myName = (() => { try { return localStorage.getItem('euchreName') || ''; } catch (e) { return ''; } })();
let tablePlaySeen = new Set(); // played cards already on the table, so only new ones fly in
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
  if (role === 'phoneplay') return initPhonePlay();
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
          <a class="primary-link" href="/?${qs({ role: 'phoneplay', room })}">Phone Play (no iPad)</a>
          <a class="secondary-link" href="/?${qs({ role: 'hand', preview: 1 })}">Open phone preview mode</a>
        </div>
        <p class="tiny">Table view: open on the iPad and scan the four seat links. Phone Play: four phones open the same link and pick their seats — no iPad needed.</p>
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
  socket.emit('joinSeat', { room: currentRoom, seat: mySeat, name: myName || undefined }, res => {
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

// Phone Play: a phone is both a table observer (for the mini board) and a seat
// (for its own hand). No iPad required; players pick a seat from the phone.
function initPhonePlay() {
  document.body.className = 'phone-body phoneplay blue-phone';
  connectSocket();
  const requestedRoom = currentRoom || randomRoomHint();
  socket.emit('joinTable', { room: requestedRoom }, ({ room, state }) => {
    currentRoom = room;
    tableState = state;
    const url = new URL(window.location.href);
    url.search = qs({ role: 'phoneplay', room });
    window.history.replaceState({}, '', url);
    if (mySeat == null) renderSeatPicker(); else renderPhonePlay();
  });
  socket.on('tableState', state => {
    tableState = state;
    if (mySeat == null) {
      const inp = document.getElementById('ppName');
      if (inp) myName = inp.value; // keep what they're typing across re-renders
      renderSeatPicker();
    } else {
      renderPhonePlay();
    }
  });
  socket.on('handState', state => {
    if (state.seat !== mySeat) return;
    handState = state;
    selectedIndex = Math.min(selectedIndex, Math.max(0, state.hand.length - 1));
    renderPhonePlay();
  });
}

function copyInviteLink() {
  const link = absoluteUrl(`/?${qs({ role: 'phoneplay', room: currentRoom })}`);
  const done = () => showToast('Invite link copied!');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(done).catch(() => fallbackCopy(link, done));
  } else {
    fallbackCopy(link, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { showToast('Could not copy — copy the URL manually.'); }
  document.body.removeChild(ta);
}

function renderSeatPicker() {
  document.body.className = 'phone-body phoneplay blue-phone';
  const seats = tableState ? tableState.seats : [];
  app.innerHTML = `
    <section class="phone-screen seat-picker">
      <div class="seat-picker-card">
        <h2>Phone Play</h2>
        <p>Room ${currentRoom || '…'} — pick your seat</p>
        <input id="ppName" type="text" maxlength="16" placeholder="Your name" autocomplete="off" autocapitalize="words" value="${escapeHtml(myName)}" />
        <div class="seat-grid">
          ${[2, 1, 3, 0].map(seat => {
            const s = seats.find(x => x.seat === seat) || {};
            const taken = !!s.connected;
            return `<button class="seat-pick ${teamOfSeat(seat)}-pick ${taken ? 'taken' : ''}" data-pick-seat="${seat}" ${taken ? 'disabled' : ''}>
              <span class="sp-label">${seatLabels[seat]}</span>
              <span class="sp-team">${teamOfSeat(seat)} team</span>
              <span class="sp-status">${taken ? escapeHtml(s.name || 'taken') : 'tap to sit'}</span>
            </button>`;
          }).join('')}
        </div>
        <button class="copy-link-btn" id="ppCopy">📋 Copy invite link</button>
        <p class="pp-hint">Share the link, then everyone picks a seat.</p>
      </div>
      <div id="toast" class="toast"></div>
    </section>
  `;
  const copyBtn = document.getElementById('ppCopy');
  if (copyBtn) copyBtn.addEventListener('click', copyInviteLink);
  const nameInput = document.getElementById('ppName');
  document.querySelectorAll('[data-pick-seat]').forEach(btn => {
    btn.addEventListener('click', () => {
      const seat = Number(btn.dataset.pickSeat);
      const v = (nameInput.value || '').trim();
      if (!v) { nameInput.focus(); return showToast('Enter your name first.'); }
      myName = v.slice(0, 16);
      try { localStorage.setItem('euchreName', myName); } catch (e) {}
      socket.emit('joinSeat', { room: currentRoom, seat, name: myName }, res => {
        if (res && res.error) return showToast(res.error);
        mySeat = seat;
        handState = res.state;
        renderPhonePlay();
      });
    });
  });
}

function renderPhonePlay() {
  if (!tableState) return;
  if (mySeat == null) return renderSeatPicker();
  if (!handState) return;
  const state = handState;
  document.body.className = `phone-body phoneplay ${state.team}-phone`;
  const cards = state.phase === 'dealing' ? [] : (state.hand || []);
  selectedIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, cards.length - 1));
  const panel = actionPanel(state);
  app.innerHTML = `
    <section class="phone-screen phoneplay-screen">
      <div class="mini-table">${tableMarkup(tableState, true, mySeat)}</div>
      <div class="phone-deal-layer"></div>
      ${panel}
      ${panel ? '' : `<div class="phone-message">${escapeHtml(state.message || '')}</div>`}
      ${state.canEndEarly ? '<button class="end-early-btn" data-end-early>End Early — claim the win 👑</button>' : ''}
      ${state.canFarmer ? "<button class=\"farmer-btn\" data-farmer>Farmer's Hand — swap your 9s 🌾</button>" : ''}
      <div id="fan" class="card-fan spread" style="--count:${cards.length}">
        ${cards.map((card, index) => cardInFan(card, index, cards.length, state)).join('')}
      </div>
      <div id="toast" class="toast"></div>
    </section>
  `;
  attachFanGestures(cards, false);
  attachActionButtons();
  attachTableHandlers(tableState); // the mini board's Start/Next button
}

function renderTable() {
  if (!tableState) return;
  app.innerHTML = tableMarkup(tableState, false);
  attachTableHandlers(tableState);
}

function attachTableHandlers(state) {
  const startBtn = document.querySelector('[data-start-hand]');
  if (startBtn) startBtn.addEventListener('click', () => socket.emit('startHand', { room: state.room }));
  const resetBtn = document.querySelector('[data-reset-game]');
  if (resetBtn) resetBtn.addEventListener('click', () => socket.emit('resetGame', { room: state.room }));
}

// Builds the full table layout. `mini` trims iPad-only chrome (QR codes,
// controls, link) so the same board can be embedded above a player's cards in
// Phone Play mode.
function tableMarkup(state, mini, viewSeat) {
  // Rotate seats to visual slots so a given player sits at the bottom. Slot 0 is
  // bottom, matching the default seat-0 position, so this is identity for the iPad.
  const rot = viewSeat == null ? 0 : viewSeat;
  const slot = s => (s == null ? s : (s - rot + 4) % 4);
  const tableUrl = absoluteUrl(`/?${qs({ role: 'table', room: state.room })}`);
  const turnArrow = state.turn != null ? `<div class="turn-arrow" style="--turn-angle:${seatAngle[slot(state.turn)]}deg"></div>` : '';
  const upCardHtml = state.upCard ? cardHtml(state.upCard, 'table-card up-card') : `<div class="card-back table-card up-card"></div>`;
  const played = state.trickCards.map(play => {
    const key = `${play.seat}:${play.card.id}`;
    const fresh = !tablePlaySeen.has(key); // just played this update -> fly it in from the seat
    return `<div class="played-card played-seat-${slot(play.seat)}${fresh ? ' fly-in' : ''}">${cardHtml(play.card, 'table-card')}</div>`;
  }).join('');
  tablePlaySeen = new Set(state.trickCards.map(p => `${p.seat}:${p.card.id}`));
  const showQr = state.phase === 'lobby' && !mini; // only before the hand starts; never in mini mode
  const makerName = state.maker != null ? ((state.seats.find(s => s.seat === state.maker) || {}).name || seatLabels[state.maker]) : '';
  const dealerPuck = state.dealer != null ? `<div class="seat-puck dealer-puck dealer-at-${slot(state.dealer)}">D</div>` : '';
  const makerPuck = state.maker != null ? `<div class="seat-puck maker-puck maker-at-${slot(state.maker)}" title="Called trump">♛</div>` : '';
  const trumpIsRed = state.trump === 'H' || state.trump === 'D';
  const revealLayer = (state.phase === 'reveal' && Array.isArray(state.revealHands))
    ? `<div class="reveal-banner">${escapeHtml(state.message || '')}</div>
       <div class="reveal-layer">${state.revealHands.map(h => `
         <div class="reveal-hand reveal-hand-${slot(h.seat)}">
           <div class="reveal-name">${escapeHtml(h.name)}</div>
           <div class="reveal-cards">${h.cards.map(c => cardHtml(c, 'table-card reveal-card')).join('')}</div>
         </div>`).join('')}</div>`
    : '';
  const wonPiles = [0, 1, 2, 3].map(seat => {
    const n = state.trickPiles?.[seat] || 0;
    if (!n) return '';
    const cards = Array.from({ length: Math.min(n, 5) }, (_, i) => `<div class="tp-card card-back" style="--i:${i}"></div>`).join('');
    return `<div class="won-pile won-pile-${slot(seat)}">${cards}</div>`;
  }).join('');
  const qrSeats = [2, 3, 0, 1].map(seat => qrForSeat(state, seat)).join('');
  const seatZones = [0, 1, 2, 3].map(seat => seatZone(state, seat, slot(seat))).join('');
  // Phone Play: print each player's name onto the felt at their (rotated) seat.
  const nameTags = mini ? [0, 1, 2, 3].map(seat => {
    const s = state.seats.find(x => x.seat === seat) || {};
    const nm = s.name || seatLabels[seat];
    return `<div class="seat-name-tag tag-at-${slot(seat)} ${teamOfSeat(seat)}-tag ${state.turn === seat ? 'tag-turn' : ''}">${escapeHtml(nm)}</div>`;
  }).join('') : '';
  const controls = tableControls(state);
  const centerAction = (state.phase === 'lobby' || state.phase === 'betweenHands')
    ? `<button class="center-action${state.phase === 'betweenHands' ? ' counting' : ''}" data-start-hand><span>${state.phase === 'lobby' ? 'Start Hand' : 'Next Hand'}</span></button>`
    : '';

  const inPlay = state.phase !== 'lobby';
  return `
    <section class="table-screen phase-${state.phase} ${inPlay ? 'in-play' : ''} ${mini ? 'mini' : ''}">
      <div class="felt"></div>
      <div class="scorecard">
        <div class="score blue-score"><span>Blue</span><strong>${state.score.blue}</strong></div>
        <div class="score red-score"><span>Red</span><strong>${state.score.red}</strong></div>
      </div>
      <div class="room-badge">Room ${state.room}</div>
      ${turnArrow}
      ${dealerPuck}
      ${makerPuck}
      <div class="center-area">
        ${state.trump
          ? `<div class="trump-emblem ${trumpIsRed ? 'red-suit' : 'black-suit'}"><span>${suitSymbols[state.trump]}</span></div>`
          : `<div class="kitty-stack">
              <div class="card-back table-card kitty-back"></div>
              ${state.phase === 'ordering1' || state.phase === 'ordering2' ? upCardHtml : ''}
            </div>`}
        ${state.alone && state.maker != null ? `<div class="alone-pill">${escapeHtml(makerName)} is going alone</div>` : ''}
      </div>
      <div class="played-layer">${played}</div>
      <div class="won-layer">${wonPiles}</div>
      ${revealLayer}
      ${seatZones}
      ${nameTags}
      ${showQr ? `<div class="qr-layer">${qrSeats}</div>` : ''}
      ${centerAction}
      ${mini ? '' : controls}
      ${mini ? '' : `<div class="table-link">${escapeHtml(tableUrl)}</div>`}
      <div id="dealLayer" class="deal-layer"></div>
    </section>
  `;
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

function seatZone(state, seat, slotPos = seat) {
  const seatState = state.seats.find(s => s.seat === seat) || {};
  const team = teamOfSeat(seat);
  const isTurn = state.turn === seat;
  const pileCount = state.trickPiles?.[seat] || 0;
  const dealer = state.dealer === seat ? '<span class="dealer-chip">D</span>' : '';
  const sitOut = state.sitOut === seat ? '<span class="sitout-chip">sitting out</span>' : '';
  return `
    <div class="seat-zone seat-zone-${slotPos} ${team}-seat ${isTurn ? 'turn-seat' : ''}">
      <div class="seat-name">${dealer}${escapeHtml(seatState.name || seatLabels[seat])} ${sitOut}</div>
      <div class="seat-status">${seatState.connected ? 'phone connected' : 'scan QR to join'}</div>
      <div class="trick-pile" aria-label="tricks won">
        ${Array.from({ length: Math.min(pileCount, 5) }, (_, i) => `<div class="mini-back" style="--pile-i:${i}"></div>`).join('')}
      </div>
    </div>
  `;
}

function tableControls(state) {
  return `
    <div class="table-controls">
      <button data-reset-game class="ghost-btn">Reset</button>
      <a class="ghost-link" href="/?${qs({ role: 'hand', preview: 1 })}" target="_blank">Phone Preview</a>
    </div>
  `;
}

function handleDealStart(deal) {
  if (role === 'table') animateTableDeal(deal);
  if (role === 'hand' && deal.sequence) animatePhoneDeal(deal);
  if (role === 'phoneplay') {
    animateTableDeal(deal, mySeat);            // mini board, rotated to the local view
    if (deal.sequence) animatePhoneDeal(deal); // cards drop into the hand below
  }
}

function animateTableDeal(deal, viewSeat) {
  lastDealSeq = deal.seq;
  const rot = viewSeat == null ? 0 : viewSeat;
  const slot = s => (s - rot + 4) % 4; // fly cards to the rotated seat positions
  setTimeout(() => {
    const layer = document.getElementById('dealLayer');
    if (!layer) return;
    layer.innerHTML = '';
    const startDelay = Math.max(0, deal.startedAt - Date.now());
    deal.sequence.forEach((entry, i) => {
      const el = document.createElement('div');
      el.className = `deal-card card-back deal-to-${slot(entry.seat)}`;
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

function renderNamePrompt() {
  document.body.className = `phone-body ${teamOfSeat(mySeat)}-phone`;
  app.innerHTML = `
    <section class="phone-screen name-prompt">
      <div class="name-card">
        <h2>What's your name?</h2>
        <p>${seatLabels[mySeat]} seat · ${teamOfSeat(mySeat)} team</p>
        <input id="nameInput" type="text" maxlength="16" placeholder="Your name" autocomplete="off" autocapitalize="words" />
        <button id="nameGo">Join game</button>
      </div>
    </section>
  `;
  const input = document.getElementById('nameInput');
  const submit = () => {
    const v = input.value.trim();
    if (!v) return input.focus();
    myName = v.slice(0, 16);
    try { localStorage.setItem('euchreName', myName); } catch (e) {}
    socket.emit('setName', { room: currentRoom, seat: mySeat, name: myName });
    renderHand();
  };
  document.getElementById('nameGo').addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  setTimeout(() => input.focus(), 50);
}

function renderHand() {
  if (!handState) return;
  if (!myName) return renderNamePrompt();
  const state = handState;
  document.body.className = `phone-body ${state.team}-phone`;
  const cards = state.phase === 'dealing' ? [] : (state.hand || []);
  selectedIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, cards.length - 1));
  const panel = actionPanel(state);
  app.innerHTML = `
    <section class="phone-screen">
      <div class="phone-deal-layer"></div>
      ${panel}
      ${panel ? '' : `<div class="phone-message">${escapeHtml(state.message || '')}</div>`}
      ${state.canEndEarly ? '<button class="end-early-btn" data-end-early>End Early — claim the win 👑</button>' : ''}
      ${state.canFarmer ? "<button class=\"farmer-btn\" data-farmer>Farmer's Hand — swap your 9s 🌾</button>" : ''}
      <div id="fan" class="card-fan spread" style="--count:${cards.length}">
        ${cards.map((card, index) => cardInFan(card, index, cards.length, state)).join('')}
      </div>
      <div id="toast" class="toast"></div>
    </section>
  `;
  attachFanGestures(cards, false);
  attachActionButtons();
}

function renderPreviewHand() {
  const cards = previewHand;
  selectedIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, cards.length - 1));
  app.innerHTML = `
    <section class="phone-screen">
      <div class="preview-hint">Preview mode — swipe sideways through the fan, swipe up to throw a card.</div>
      <div id="fan" class="card-fan preview-fan spread" style="--count:${cards.length}">
        ${cards.map((card, index) => cardInFan(card, index, cards.length, { legalCardIds: cards.map(c => c.id), canAct: true, actionType: 'play' })).join('')}
      </div>
      <div id="toast" class="toast"></div>
    </section>
  `;
  attachFanGestures(cards, true);
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

// Geometry of one card in the held-hand fan. `centerFloat` is the (possibly
// fractional) focused position. The card closest to center is the apex: lifted
// highest, scaled up, and with extra gap to its neighbours so you can read it
// and peek at the cards on either side. Stacking order is fixed by physical
// index (set separately) so the fan never re-stacks while you scroll.
// Every card equally separated, full size, so you can see the whole hand at once.
function fanGeometry(index, centerFloat) {
  const offset = index - centerFloat;
  const vw = (window.innerWidth || 390) / 100;
  const prox = Math.exp(-(offset * offset) / 1.2);
  const angle = clamp(offset * 8, -38, 38);
  const shift = offset * 8 * vw; // even, tight spacing — full-size cards close together
  const arc = Math.exp(-(offset * offset) / 7); // gentle, broad arc
  const raise = -16 * arc + Math.abs(offset) * 2;
  const scale = 0.96 + 0.06 * prox; // slight lift on the focused card
  return { angle, shift, raise, scale };
}

function cardInFan(card, index, count, state) {
  const g = fanGeometry(index, selectedIndex);
  const legalIds = state.legalCardIds || [];
  const isIllegal = state.canAct && state.actionType === 'play' && legalIds.length && !legalIds.includes(card.id);
  return `
    <div class="fan-slot ${index === selectedIndex ? 'selected' : ''} ${isIllegal ? 'illegal-card' : ''}"
      data-index="${index}"
      data-card-id="${card.id}"
      style="--angle:${g.angle}deg; --shift:${g.shift}px; --raise:${g.raise}px; --scale:${g.scale}; --z:${10 + index}">
      ${cardHtml(card, 'phone-card')}
    </div>
  `;
}

// Live layout: positions every slot directly from a (possibly fractional) center
// index plus an optional vertical lift on the selected card. No DOM rebuild, so
// CSS transitions can carry the motion and it tracks the finger during a drag.
function applyFanLayout(centerFloat, liftAmount, liftIndex) {
  const fan = document.getElementById('fan');
  if (!fan) return;
  const slots = fan.querySelectorAll('.fan-slot');
  const selInt = clamp(Math.round(centerFloat), 0, Math.max(0, slots.length - 1));
  const liftAt = liftIndex == null ? selInt : liftIndex; // lift the card under the finger
  slots.forEach(slot => {
    const index = Number(slot.dataset.index);
    const g = fanGeometry(index, centerFloat);
    const isSel = index === selInt;
    const raise = g.raise + (index === liftAt ? (liftAmount || 0) : 0);
    slot.style.setProperty('--angle', `${g.angle}deg`);
    slot.style.setProperty('--shift', `${g.shift}px`);
    slot.style.setProperty('--raise', `${raise}px`);
    slot.style.setProperty('--scale', g.scale);
    slot.style.setProperty('--z', 10 + index); // rightmost on top, leftmost on bottom — fixed
    slot.classList.toggle('selected', isSel);
  });
}

function attachFanGestures(cards, isPreview) {
  const fan = document.getElementById('fan');
  if (!fan) return;
  const SPACING = Math.max(46, (window.innerWidth || 390) * 0.16); // drag distance to advance one card
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let axis = null;
  let downSlot = null;
  let touchedIndex = null;

  fan.addEventListener('pointerdown', event => {
    event.preventDefault();
    downSlot = event.target.closest('.fan-slot');
    touchedIndex = downSlot ? Number(downSlot.dataset.index) : null;
    startX = event.clientX;
    startY = event.clientY;
    dragging = true;
    axis = null;
    fan.setPointerCapture(event.pointerId);
    fan.classList.add('dragging');
  });

  fan.addEventListener('pointermove', event => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!axis) {
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      else return;
    }
    if (axis === 'x') {
      const center = clamp(selectedIndex - dx / SPACING, 0, cards.length - 1);
      applyFanLayout(center, 0);
    } else {
      // lift the card actually under the finger (may not be the centred one)
      const li = touchedIndex != null ? touchedIndex : selectedIndex;
      if (downSlot) downSlot.classList.add('lifting'); // ride above the panels while rising
      applyFanLayout(selectedIndex, Math.min(0, dy), li);
    }
  });

  const finish = event => {
    if (!dragging) return;
    dragging = false;
    fan.classList.remove('dragging');
    if (downSlot) downSlot.classList.remove('lifting');
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (axis === 'y' && dy < -80) {
      // play the card the finger is actually on (usually the centered apex)
      const card = cards[touchedIndex != null ? touchedIndex : selectedIndex];
      if (card) return flingAndPlay(card, isPreview);
    }
    if (axis === 'x') {
      selectedIndex = clamp(Math.round(selectedIndex - dx / SPACING), 0, cards.length - 1);
    } else if (axis === null && downSlot) {
      selectedIndex = Number(downSlot.dataset.index); // tap to select
    }
    applyFanLayout(selectedIndex, 0); // snap to rest with transition
  };
  fan.addEventListener('pointerup', finish);
  fan.addEventListener('pointercancel', finish);
}

function attachActionButtons() {
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
  document.querySelectorAll('[data-end-early]').forEach(btn => {
    btn.addEventListener('click', () => socket.emit('endEarly', { room: handState.room, seat: mySeat }));
  });
  document.querySelectorAll('[data-farmer]').forEach(btn => {
    btn.addEventListener('click', () => socket.emit('farmersHand', { room: handState.room, seat: mySeat }));
  });
}

// Animate the selected card up and out, then commit the play. Guards illegal
// plays up front so a card never flies away and then snaps back.
function flingAndPlay(card, isPreview) {
  if (!isPreview) {
    if (!handState?.canAct || !['play', 'discard'].includes(handState.actionType)) {
      showToast('You can only swipe a card up on your turn.');
      applyFanLayout(selectedIndex, 0);
      return;
    }
    if (handState.actionType === 'play') {
      const legal = handState.legalCardIds || [];
      if (legal.length && !legal.includes(card.id)) {
        showToast('That card is not legal to play right now.');
        applyFanLayout(selectedIndex, 0);
        return;
      }
    }
  }
  const fan = document.getElementById('fan');
  const slot = fan && fan.querySelector(`.fan-slot[data-card-id="${card.id}"]`);
  if (slot) {
    slot.classList.add('flinging');
    slot.style.setProperty('--raise', '-130vh');
    slot.style.setProperty('--scale', '1.06');
  }
  setTimeout(() => playOrPreviewCard(card, isPreview), 170);
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
