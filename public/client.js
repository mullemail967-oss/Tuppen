/* ==========================================================================
   TUPPEN - CLIENT APPLICATION (WIR vs SIE, BELGIAN SVG & TRICK INSPECTOR)
   ========================================================================== */

const socket = io({
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000
});

// Lokaler Client-Status
let currentRoomCode = null;
let mySeatIndex = -1;
let gameState = null;
let soundEnabled = true;
let svgSpriteLoaded = false;

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Audio-Synthesizer via Web Audio API (Lazy Init on Mobile)
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      try {
        audioCtx = new AudioContextClass();
      } catch (e) {
        console.warn('AudioContext init failed:', e);
      }
    }
  }
  return audioCtx;
}

function playSound(type) {
  if (!soundEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    const now = ctx.currentTime;

    if (type === 'card_play') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(110, now + 0.08);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.08);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.08);
    } else if (type === 'trick_won') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.setValueAtTime(659.25, now + 0.08);
      osc.frequency.setValueAtTime(783.99, now + 0.16);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.28);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.28);
    } else if (type === 'trump_fanfare') {
      [587.33, 739.99, 880].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + i * 0.1);
        gain.gain.setValueAtTime(0.25, now + i * 0.1);
        gain.gain.linearRampToValueAtTime(0.01, now + i * 0.1 + 0.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.1);
        osc.stop(now + i * 0.1 + 0.2);
      });
    } else if (type === 'contra_sound') {
      [440, 330, 220, 165].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, now + i * 0.08);
        gain.gain.setValueAtTime(0.2, now + i * 0.08);
        gain.gain.linearRampToValueAtTime(0.01, now + i * 0.08 + 0.16);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.08);
        osc.stop(now + i * 0.08 + 0.16);
      });
    } else if (type === 'turn') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(440, now + 0.1);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.1);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.1);
    } else if (type === 'victory') {
      [523.25, 659.25, 783.99, 1046.50].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + i * 0.15);
        gain.gain.setValueAtTime(0.3, now + i * 0.15);
        gain.gain.linearRampToValueAtTime(0.01, now + i * 0.15 + 0.4);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.15);
        osc.stop(now + i * 0.15 + 0.4);
      });
    } else if (type === 'emote') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(550, now);
      osc.frequency.exponentialRampToValueAtTime(1100, now + 0.12);
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.12);
    }
  } catch (e) {
    console.warn('Audio play error:', e);
  }
}

// SVG Sprite Loader (WebKit/Safari kompatibel ohne display:none)
async function initSvgSprite() {
  try {
    const res = await fetch('svg-cards.svg');
    const text = await res.text();
    let container = document.getElementById('svgSpriteContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'svgSpriteContainer';
      container.setAttribute('aria-hidden', 'true');
      container.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;opacity:0;z-index:-9999;';
      document.body.appendChild(container);
    }
    container.innerHTML = text;
    svgSpriteLoaded = true;
    if (gameState) renderUI();
  } catch (err) {
    console.error('Failed to load Belgian SVG sprite:', err);
  }
}

// --------------------------------------------------------------------------
// DOM & EVENT INITIALISIERUNG
// --------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initSvgSprite();
  setupEventListeners();
  checkUrlParams();
});

function setupEventListeners() {
  document.getElementById('createRoomBtn').addEventListener('click', handleCreateRoom);
  document.getElementById('joinRoomBtn').addEventListener('click', handleJoinRoom);
  document.getElementById('startGameBtn').addEventListener('click', handleStartGame);
  document.getElementById('fillBotsBtn').addEventListener('click', handleFillBots);
  document.getElementById('copyInviteBtn').addEventListener('click', copyInviteLink);

  document.getElementById('soundToggleBtn').addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    document.getElementById('soundToggleBtn').textContent = soundEnabled ? '🔊' : '🔇';
    showToast(soundEnabled ? 'Ton aktiviert' : 'Ton stummgeschaltet');
  });

  // Klick außerhalb des Emote-Pickers schließt ihn
  document.addEventListener('click', (e) => {
    const picker = document.getElementById('emotePickerPopup');
    const trigger = document.getElementById('openEmoteBtn');
    if (picker && !picker.classList.contains('hidden')) {
      if (!picker.contains(e.target) && (!trigger || !trigger.contains(e.target))) {
        picker.classList.add('hidden');
      }
    }
  });

  const roomCodeInput = document.getElementById('roomCodeInput');
  if (roomCodeInput) {
    roomCodeInput.addEventListener('input', () => {
      roomCodeInput.value = roomCodeInput.value.toUpperCase();
      updateLobbyButtonsState();
    });
    roomCodeInput.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') handleJoinRoom();
    });
  }
}

function updateLobbyButtonsState() {
  const codeInput = document.getElementById('roomCodeInput');
  const createBtn = document.getElementById('createRoomBtn');
  const joinBtn = document.getElementById('joinRoomBtn');
  if (!codeInput || !createBtn || !joinBtn) return;

  const hasCode = codeInput.value.trim().length > 0;
  if (hasCode) {
    createBtn.disabled = true;
    createBtn.classList.add('btn-create-disabled');
    createBtn.title = 'Raumcode eingegeben: Klicke auf "Beitreten"';
    joinBtn.classList.remove('btn-secondary');
    joinBtn.classList.add('btn-primary', 'btn-glow');
  } else {
    createBtn.disabled = false;
    createBtn.classList.remove('btn-create-disabled');
    createBtn.title = 'Neuen Raum erstellen';
    joinBtn.classList.remove('btn-primary', 'btn-glow');
    joinBtn.classList.add('btn-secondary');
  }
}

function checkUrlParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const room = urlParams.get('room');
  if (room) {
    const codeInput = document.getElementById('roomCodeInput');
    if (codeInput) {
      codeInput.value = room.toUpperCase();
      updateLobbyButtonsState();
    }
  }
}

function getPlayerName() {
  const input = document.getElementById('playerNameInput');
  return (input.value || '').trim() || 'Spieler ' + Math.floor(Math.random() * 100);
}

function showToast(message) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

// --------------------------------------------------------------------------
// LOBBY & RAUM-AKTIONEN
// --------------------------------------------------------------------------
let isCreatingRoom = false;
function handleCreateRoom() {
  if (isCreatingRoom) return;
  const codeInput = document.getElementById('roomCodeInput');
  if (codeInput && codeInput.value.trim().length > 0) {
    showToast('Du hast einen Raumcode eingegeben! Klicke auf Beitreten.');
    return;
  }
  isCreatingRoom = true;
  setTimeout(() => { isCreatingRoom = false; }, 2500);
  const playerName = getPlayerName();
  socket.emit('create_room', { playerName, settings: currentSettings });
}

let isJoiningRoom = false;
function handleJoinRoom() {
  if (isJoiningRoom) return;
  const codeInput = document.getElementById('roomCodeInput');
  const code = codeInput ? codeInput.value.trim().toUpperCase() : '';
  if (!code) {
    return showToast('Bitte gib einen Raumcode ein.');
  }
  isJoiningRoom = true;
  setTimeout(() => { isJoiningRoom = false; }, 2500);
  const playerName = getPlayerName();
  socket.emit('join_room', { roomCode: code, playerName });
}

function copyInviteLink() {
  if (!currentRoomCode) return;
  const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${currentRoomCode}`;
  navigator.clipboard.writeText(inviteUrl).then(() => {
    const msg = document.getElementById('copySuccessMsg');
    if (msg) {
      msg.classList.remove('hidden');
      setTimeout(() => msg.classList.add('hidden'), 2500);
    }
    showToast(`📋 Link kopiert! (Code: ${currentRoomCode})`);
  }).catch(() => {
    showToast(`Einladungslink: ${inviteUrl}`);
  });
}

function switchSeat(seatIndex) {
  socket.emit('switch_seat', { targetSeat: seatIndex });
}

function toggleBot(seatIndex) {
  if (!gameState) return;
  const seat = gameState.players[seatIndex];
  if (seat && seat.isBot) {
    socket.emit('remove_bot', { seatIndex });
  } else if (!seat) {
    socket.emit('add_bot', { seatIndex });
  }
}

function confirmKickLobby(seatIndex) {
  if (!gameState || !gameState.players) return;
  const seat = gameState.players[seatIndex];
  if (!seat || seat.isBot) return;

  const ok = confirm(`Möchtest du Spieler "${seat.name}" wirklich aus der Lobby kicken?`);
  if (ok) {
    socket.emit('kick_lobby_player', { targetSeat: seatIndex });
  }
}

function handleFillBots() {
  if (!gameState || !gameState.players) return;
  const occupiedCount = gameState.players.filter(s => s !== null).length;
  // Füllt leere Plätze bis mindestens 4 auf, oder fügt bei >=4 den nächsten Bot hinzu (bis max. 6)
  const targetCount = occupiedCount < 4 ? 4 : Math.min(6, occupiedCount + 1);
  for (let i = 0; i < 6; i++) {
    const currentOccupied = gameState.players.filter(s => s !== null).length;
    if (currentOccupied >= targetCount) break;
    if (!gameState.players[i]) {
      socket.emit('add_bot', { seatIndex: i });
    }
  }
}

function handleStartGame() {
  socket.emit('start_game');
}

// --------------------------------------------------------------------------
// SPIEL-AKTIONEN
// --------------------------------------------------------------------------


// Helper: Berechnet relative Sitzposition relativ zu Du (Bottom)
function getRelativePosition(targetSeatIndex, mySeatIndex) {
  const t = typeof targetSeatIndex === 'number' ? targetSeatIndex : 0;
  const m = typeof mySeatIndex === 'number' ? mySeatIndex : 0;

  let seatedIndices = [];
  if (gameState && gameState.players) {
    for (let i = 0; i < gameState.players.length; i++) {
      if (gameState.players[i]) seatedIndices.push(i);
    }
  }
  if (seatedIndices.length === 0) {
    const maxP = gameState && gameState.settings ? (gameState.settings.playerCount || 4) : 4;
    for (let i = 0; i < maxP; i++) seatedIndices.push(i);
  }

  const seatedCount = seatedIndices.length;
  const isSpectator = Boolean(gameState && gameState.you && gameState.you.isSpectator);
  const baseSeat = (isSpectator || m < 0) ? seatedIndices[0] : m;

  let mIdx = seatedIndices.indexOf(baseSeat);
  if (mIdx === -1) mIdx = 0;
  let tIdx = seatedIndices.indexOf(t);
  if (tIdx === -1) tIdx = t % seatedCount;

  const diff = (tIdx - mIdx + seatedCount) % seatedCount;
  if (diff === 0) return 'Bottom';

  if (seatedCount === 2) {
    return 'Top';
  } else if (seatedCount === 3) {
    if (diff === 1) return 'TopLeft';
    if (diff === 2) return 'TopRight';
    return 'Top';
  } else if (seatedCount === 4) {
    if (diff === 1) return 'Left';
    if (diff === 2) return 'Top';
    if (diff === 3) return 'Right';
    return 'Top';
  } else if (seatedCount === 5) {
    if (diff === 1) return 'BottomLeft';
    if (diff === 2) return 'TopLeft';
    if (diff === 3) return 'TopRight';
    if (diff === 4) return 'BottomRight';
    return 'Top';
  } else {
    if (diff === 1) return 'BottomLeft';
    if (diff === 2) return 'TopLeft';
    if (diff === 3) return 'Top';
    if (diff === 4) return 'TopRight';
    if (diff === 5) return 'BottomRight';
    return 'Top';
  }
}

// Clash Royale Ragebait Emotes mit Spam-Schutz & dynamischem Cooldown
let lastEmoteTime = 0;
let emoteSpamCount = 0;
let emoteCooldownUntil = 0;

function toggleEmotePicker() {
  const popup = document.getElementById('emotePickerPopup');
  popup.classList.toggle('hidden');
}

// Emote-Picker mit Escape schließen (N3)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const popup = document.getElementById('emotePickerPopup');
    if (popup && !popup.classList.contains('hidden')) {
      popup.classList.add('hidden');
    }
  }
});

function sendEmote(emoji) {
  const now = Date.now();
  if (now < emoteCooldownUntil) {
    const remainingSec = Math.ceil((emoteCooldownUntil - now) / 1000);
    showToast(`⏳ Bitte kurz warten (${remainingSec}s)...`);
    return;
  }

  if (now - lastEmoteTime < 2500) {
    emoteSpamCount++;
  } else {
    emoteSpamCount = 0;
  }

  let cooldownMs = 1200; // Normaler Cooldown: 1,2s
  if (emoteSpamCount >= 3) {
    cooldownMs = 4000; // Verlängerter Cooldown bei Spam: 4s
    showToast('🤫 Nicht spammen! 4s Cooldown.');
  }

  lastEmoteTime = now;
  emoteCooldownUntil = now + cooldownMs;

  socket.emit('send_emote', { emote: emoji });
  document.getElementById('emotePickerPopup').classList.add('hidden');
}

function showEmoteBubble(seatIndex, emote) {
  const mySeat = gameState && gameState.you ? gameState.you.seatIndex : 0;
  const relativePos = getRelativePosition(seatIndex, mySeat); // 'Bottom', 'Left', 'Top', 'Right'
  const containerId = 'emoteBubble' + relativePos;
  const container = document.getElementById(containerId);
  if (!container) return;

  const bubble = document.createElement('div');
  bubble.className = 'clash-emote-bubble';
  bubble.textContent = emote;
  container.appendChild(bubble);

  setTimeout(() => {
    bubble.remove();
  }, 2200);
}

function knock() {
  socket.emit('knock');
  playSound('contra_sound');
  const banner = document.getElementById('mitActionBanner');
  if (banner) banner.classList.add('hidden');
}
window.knock = knock;

function handleTopKnock() {
  if (!gameState || !gameState.you) return;
  if (gameState.phase === 'KNOCK_DECISION' && gameState.you.isKnockDecisionTurn) {
    knockResponse('counter_knock');
  } else if (gameState.phase === 'PLAY_TRICK' && gameState.you.canKnock) {
    knock();
  }
}
window.handleTopKnock = handleTopKnock;

function knockResponse(decision) {
  socket.emit('knock_response', { decision });
  const banner = document.getElementById('mitActionBanner');
  if (banner) banner.classList.add('hidden');
}
window.knockResponse = knockResponse;

function povertyResponse(decision) {
  socket.emit('poverty_response', { decision });
  const banner = document.getElementById('mitActionBanner');
  if (banner) banner.classList.add('hidden');
}
window.povertyResponse = povertyResponse;

function declareFourPictures() {
  fourPicturesDismissedRound = -1;
  socket.emit('declare_four_pictures');
  playSound('trump_fanfare');
}
window.declareFourPictures = declareFourPictures;

function challengeFourPictures(challenge) {
  socket.emit('challenge_four_pictures', { challenge });
  const banner = document.getElementById('mitActionBanner');
  if (banner) banner.classList.add('hidden');
}
window.challengeFourPictures = challengeFourPictures;

function challengeSpecificStack(stackId) {
  if (!gameState) return;
  if (gameState.phase === 'FOUR_PICTURES_REVEAL') return;
  const stacks = gameState.fourPicturesStacks || [];
  const stack = stacks.find(s => s.id === stackId);
  if (!stack) return;
  if (stack.declarerIndex === mySeatIndex) {
    showToast('Das sind deine eigenen abgelegten 4 Karten.');
    return;
  }
  if (!stack.canChallenge) {
    showToast('Dieser Stapel kann derzeit nicht geprüft werden.');
    return;
  }
  socket.emit('challenge_four_pictures_stack', { stackId });
  playSound('contra_sound');
}
window.challengeSpecificStack = challengeSpecificStack;

function challengeLaidPile(posKey) {
  if (!gameState) return;
  if (gameState.phase === 'FOUR_PICTURES_REVEAL') return;

  const stacks = gameState.fourPicturesStacks || [];
  for (const st of stacks) {
    if (getRelativePosition(st.declarerIndex, mySeatIndex) === posKey) {
      if (st.declarerIndex === mySeatIndex) {
        showToast('Das sind deine eigenen abgelegten 4 Karten.');
        return;
      }
      if (st.canChallenge) {
        challengeSpecificStack(st.id);
        return;
      } else {
        showToast('Dieser Stapel kann derzeit nicht geprüft werden.');
        return;
      }
    }
  }

  for (let sIdx = 0; sIdx < 6; sIdx++) {
    if (getRelativePosition(sIdx, mySeatIndex) === posKey) {
      if (sIdx === mySeatIndex) {
        showToast('Das sind deine eigenen abgelegten 4 Karten.');
        return;
      }
    }
  }
  showToast('Kein prüfbarer 4-Bilder Stapel an dieser Position.');
}
window.challengeLaidPile = challengeLaidPile;

function dismissMitBanner() {
  const banner = document.getElementById('mitActionBanner');
  if (banner) banner.classList.add('hidden');
}

function isCardPlayableClient(cardToPlay, playerHand, currentTrick) {
  if (!cardToPlay || !playerHand || playerHand.length === 0) return false;
  let leadCard = null;
  if (Array.isArray(currentTrick)) {
    if (currentTrick.length === 0) return true;
    leadCard = currentTrick[0].card;
  } else if (currentTrick && currentTrick.card) {
    leadCard = currentTrick.card;
  }
  if (!leadCard) return true;
  const leadSuit = leadCard.suit;
  const hasLeadSuit = playerHand.some(c => c.suit === leadSuit);
  if (hasLeadSuit) {
    return cardToPlay.suit === leadSuit;
  }
  return true;
}

function playCard(cardId) {
  if (!gameState) return;
  if (gameState.phase !== 'PLAY_TRICK') return;
  if (gameState.currentTurn !== mySeatIndex) return;

  if (gameState.you && gameState.you.fourPicturesLockActive) {
    const rem = gameState.you.fourPicturesLockRemainingSec || 1;
    showToast(`⏱️ Noch ${rem}s Bedenkzeit nach 4 Bilder vor dem 1. Stich!`);
    return;
  }

  const hand = (gameState.you && gameState.you.hand) || [];
  const card = hand.find(c => c.id === cardId);
  if (!card) return;

  let isPlayable = true;
  if (gameState.you && gameState.you.playableMap && Object.keys(gameState.you.playableMap).length > 0) {
    isPlayable = !!gameState.you.playableMap[cardId];
  } else {
    isPlayable = isCardPlayableClient(card, hand, gameState.currentTrick);
  }

  if (!isPlayable) {
    showToast('Diese Karte darf gemäß Stichregeln (Farbzwang) nicht gespielt werden!');
    return;
  }

  socket.emit('play_card', { cardId });
  playSound('card_play');
}

function nextRound() {
  socket.emit('next_round');
  document.getElementById('roundSummaryModal').classList.add('hidden');
}

function restartGame() {
  socket.emit('restart_game');
  document.getElementById('gameOverModal').classList.add('hidden');
}

function leaveLobby() {
  socket.emit('leave_room');
  sessionStorage.removeItem('tuppen_session');
  currentRoomCode = null;
  mySeatIndex = -1;
  gameState = null;
  document.getElementById('lobbyWaitingRoom').classList.add('hidden');
  document.getElementById('lobbyInitialOptions').classList.remove('hidden');
  document.getElementById('gameScreen').classList.remove('active');
  document.getElementById('lobbyScreen').classList.add('active');
  showToast('Du hast die Lobby verlassen.');
}

function confirmLeaveGame() {
  const isMoney = Boolean(gameState && gameState.settings && gameState.settings.moneyMode);
  const promptText = isMoney
    ? '⚠️ GELDSPIEL VERLASSEN:\n\nMöchtest du die Geldpartie wirklich verlassen?\nDein Einsatz bleibt im Pot und du scheidest automatisch aus (0 Leben)!'
    : 'Möchtest du das Spiel wirklich verlassen? Dein Platz wird sofort von einem Bot übernommen, damit die Partie weitergehen kann.';
  const confirmLeave = confirm(promptText);
  if (confirmLeave) {
    socket.emit('leave_game');
    sessionStorage.removeItem('tuppen_session');
    currentRoomCode = null;
    mySeatIndex = -1;
    gameState = null;
    document.getElementById('lobbyWaitingRoom').classList.add('hidden');
    document.getElementById('lobbyInitialOptions').classList.remove('hidden');
    document.getElementById('gameScreen').classList.remove('active');
    document.getElementById('lobbyScreen').classList.add('active');
    closeHostMenu();
    showToast(isMoney ? 'Du hast die Geldpartie verlassen und scheidest aus.' : 'Du hast das Spiel verlassen. Ein Bot hat übernommen.');
  }
}

function returnToLobby() {
  if (!gameState || !gameState.you || !gameState.you.isHost) return;
  const confirmReturn = confirm('Möchtest du die laufende Partie wirklich beenden und mit allen Spielern zurück in die Lobby wechseln?');
  if (confirmReturn) {
    socket.emit('return_to_lobby');
    closeHostMenu();
  }
}

// --------------------------------------------------------------------------
// SPIELLEITER-MENÜ & SPIELER-VERWALTUNG (KICKEN)
// --------------------------------------------------------------------------
function openHostMenu() {
  if (!gameState || !gameState.you || !gameState.you.isHost) return;
  const codeEl = document.getElementById('hostModalRoomCode');
  if (codeEl) {
    codeEl.textContent = currentRoomCode || '----';
  }
  syncSettingsUI();
  renderHostPendingRequests();
  renderHostPlayerList();
  document.getElementById('hostControlModal').classList.remove('hidden');
}

function closeHostMenu() {
  document.getElementById('hostControlModal').classList.add('hidden');
}

function renderHostPlayerList() {
  const container = document.getElementById('hostPlayerList');
  if (!container || !gameState) return;
  container.innerHTML = '';

  const maxPlayers = gameState.settings ? (gameState.settings.playerCount || 4) : 4;
  const sectionTitle = document.getElementById('hostPlayerSectionTitle');
  if (sectionTitle) {
    sectionTitle.textContent = `👥 Spieler-Verwaltung (${maxPlayers} Plätze)`;
  }

  for (let i = 0; i < maxPlayers; i++) {
    const player = gameState.players[i];
    const row = document.createElement('div');
    row.className = 'host-player-row';

    const isMe = (i === gameState.you.seatIndex);
    const isBot = player && player.isBot;
    const teamLabel = player ? player.name : `Platz ${i + 1}`;

    let tagHTML = '';
    let actionHTML = '';

    if (!player) {
      tagHTML = '<span class="host-player-tag tag-bot">Frei</span>';
    } else if (isMe) {
      tagHTML = '<span class="host-player-tag tag-host">Spielleiter (Du)</span>';
    } else if (isBot) {
      tagHTML = '<span class="host-player-tag tag-bot">🤖 Bot</span>';
    } else {
      tagHTML = '<span class="host-player-tag tag-player">👤 Spieler</span>';
      actionHTML = `<button class="btn-kick" onclick="kickPlayer(${i}, '${player.name}')">👢 Kicken (Bot)</button>`;
    }

    const pName = player ? player.name : 'Leerer Platz';

    row.innerHTML = `
      <div class="host-player-info">
        <span class="host-player-seat">P${i + 1}</span>
        <span class="host-player-name">${pName}</span>
        ${tagHTML}
      </div>
      <div>
        ${actionHTML}
      </div>
    `;

    container.appendChild(row);
  }
}

function kickPlayer(seatIndex, playerName) {
  const confirmKick = confirm(`Möchtest du ${playerName || 'diesen Spieler'} wirklich aus der Partie entfernen und durch einen Bot ersetzen?`);
  if (confirmKick) {
    socket.emit('kick_player', { targetSeat: seatIndex });
    setTimeout(() => {
      renderHostPlayerList();
    }, 300);
  }
}

function openLastTrickModal() {
  if (!gameState || !gameState.lastTrick) {
    return showToast('In dieser Runde wurde noch kein Stich gespielt.');
  }

  const lt = gameState.lastTrick;
  const mySeat = gameState.you ? gameState.you.seatIndex : -1;
  const isMe = (lt.winnerIndex === mySeat);

  document.getElementById('lastTrickHeaderTag').textContent = `Stich #${lt.trickNumber}`;
  document.getElementById('lastTrickHeaderTitle').textContent = `Stich #${lt.trickNumber} Übersicht`;
  document.getElementById('lastTrickWinnerNote').textContent = 
    `Gewonnen von ${lt.winnerName}!`;

  const grid = document.getElementById('lastTrickCardsGrid');
  grid.innerHTML = '';

  lt.cards.forEach(entry => {
    const isWinnerCard = (entry.playerIndex === lt.winnerIndex);
    const cardHTML = createCardHTML(entry.card, false, true);
    
    grid.innerHTML += `
      <div class="last-trick-card-entry ${isWinnerCard ? 'winner' : ''}">
        <span class="last-trick-player-label">${entry.playerName}${isWinnerCard ? ' 🏆' : ''}</span>
        ${cardHTML}
      </div>
    `;
  });

  document.getElementById('lastTrickModal').classList.remove('hidden');
}

function closeLastTrickModal() {
  document.getElementById('lastTrickModal').classList.add('hidden');
}

// --------------------------------------------------------------------------
// SOCKET.IO EVENT-HANDLER & AUTO-RECONNECT
// --------------------------------------------------------------------------
socket.on('connect', () => {
  console.log('Connected to Tuppen Server.');
  socket.emit('get_public_rooms');
  const savedSession = sessionStorage.getItem('tuppen_session');
  if (savedSession) {
    try {
      const { roomCode, playerName, seatIndex } = JSON.parse(savedSession);
      if (roomCode) {
        socket.emit('reconnect_player', { roomCode, playerName, seatIndex });
      }
    } catch (e) {}
  }
});

socket.on('room_disbanded', ({ message }) => {
  sessionStorage.removeItem('tuppen_session');
  currentRoomCode = null;
  mySeatIndex = -1;
  gameState = null;
  document.getElementById('lobbyWaitingRoom').classList.add('hidden');
  document.getElementById('lobbyInitialOptions').classList.remove('hidden');
  document.getElementById('gameScreen').classList.remove('active');
  document.getElementById('lobbyScreen').classList.add('active');
  alert(message || 'Die Lobby wurde aufgelöst.');
  refreshPublicRooms();
});

socket.on('left_room', () => {
  isCreatingRoom = false;
  isJoiningRoom = false;
  sessionStorage.removeItem('tuppen_session');
  currentRoomCode = null;
  mySeatIndex = -1;
  gameState = null;
  document.getElementById('lobbyWaitingRoom').classList.add('hidden');
  document.getElementById('lobbyInitialOptions').classList.remove('hidden');
  document.getElementById('gameScreen').classList.remove('active');
  document.getElementById('lobbyScreen').classList.add('active');
  refreshPublicRooms();
});

socket.on('kicked_from_room', ({ message }) => {
  sessionStorage.removeItem('tuppen_session');
  currentRoomCode = null;
  mySeatIndex = -1;
  gameState = null;
  document.getElementById('lobbyWaitingRoom').classList.add('hidden');
  document.getElementById('lobbyInitialOptions').classList.remove('hidden');
  document.getElementById('gameScreen').classList.remove('active');
  document.getElementById('lobbyScreen').classList.add('active');
  closeHostMenu();
  alert(message || 'Du wurdest vom Spielleiter aus der Partie entfernt.');
  refreshPublicRooms();
});

// Öffentliche Räume / Aktive Lobbys empfangen
socket.on('public_rooms_update', (rooms) => {
  renderPublicRooms(rooms);
});

// Beitrittsanfrage (Nachjoinen) Events auf Client-Seite
socket.on('join_request_sent', ({ roomCode, hostName }) => {
  showToast(`⏳ Anfrage an ${hostName} gesendet. Bitte warten...`);
});

socket.on('join_request_cooldown', ({ remainingSec }) => {
  showToast(`⏳ Bitte warte noch ${remainingSec} Sekunden vor der nächsten Anfrage.`);
});

socket.on('join_request_rejected', ({ message }) => {
  showToast(message || 'Der Spielleiter hat deine Anfrage abgelehnt.');
});

socket.on('join_request_accepted', ({ roomCode, seatIndex }) => {
  currentRoomCode = roomCode;
  mySeatIndex = seatIndex;
  const nameInput = document.getElementById('playerNameInput');
  const playerName = nameInput ? nameInput.value.trim() : 'Spieler';
  sessionStorage.setItem('tuppen_session', JSON.stringify({ roomCode, seatIndex, playerName }));
  socket.emit('confirm_midgame_join', { roomCode, seatIndex });
  document.getElementById('lobbyScreen').classList.remove('active');
  document.getElementById('gameScreen').classList.add('active');
  showToast('🎉 Du bist der Partie beigetreten!');
});

socket.on('join_request_accepted_spectator', ({ roomCode, name }) => {
  currentRoomCode = roomCode;
  mySeatIndex = -1;
  socket.emit('confirm_spectator_joined', { roomCode });
  document.getElementById('lobbyScreen').classList.remove('active');
  document.getElementById('gameScreen').classList.add('active');
  showToast('🎉 Anfrage angenommen! Du bist als Zuschauer dabei und steigst zur nächsten Partie automatisch mit Karten ein.');
});

// Beim Spielleiter: Dezent registrierte Beitrittsanfragen (kein blockierendes Riesen-Popup)
const pendingJoinRequests = new Map();

socket.on('join_request_received', ({ requestId, playerName, asSpectator, canSpectate, nextPlayerNumber, availableBots }) => {
  pendingJoinRequests.set(requestId, { requestId, playerName, asSpectator, canSpectate, nextPlayerNumber, availableBots });
  playSound('trump_fanfare');
  const numInfo = nextPlayerNumber ? ` (Platz ${nextPlayerNumber})` : '';
  showToast(`🙋 ${playerName} möchte beitreten${numInfo} (👑 Menü)`);
  updateHostMenuBadge();
  const hostModal = document.getElementById('hostControlModal');
  if (hostModal && !hostModal.classList.contains('hidden')) {
    renderHostPendingRequests();
  }
});

socket.on('join_request_resolved', ({ requestId }) => {
  pendingJoinRequests.delete(requestId);
  updateHostMenuBadge();
  const hostModal = document.getElementById('hostControlModal');
  if (hostModal && !hostModal.classList.contains('hidden')) {
    renderHostPendingRequests();
  }
});

function refreshPublicRooms() {
  socket.emit('get_public_rooms');
}

function renderPublicRooms(rooms) {
  const list = document.getElementById('activeRoomsList');
  if (!list) return;

  if (!rooms || rooms.length === 0) {
    list.innerHTML = `<div class="active-rooms-empty">Keine aktiven Runden. Erstelle die erste!</div>`;
    return;
  }

  list.innerHTML = '';
  rooms.forEach(r => {
    const isLobby = (r.phase === 'LOBBY');
    const item = document.createElement('div');
    item.className = 'active-room-item';

    const activeCount = typeof r.activePlayers === 'number' ? r.activePlayers : (r.connectedHumans || 2);
    const maxCapacity = 6;
    let statusBadge = '';
    let actionBtn = '';

    if (isLobby) {
      statusBadge = `<span class="room-status-badge badge-lobby">🟢 Lobby (${activeCount}/${maxCapacity})</span>`;
      actionBtn = `<button class="btn btn-sm btn-primary" onclick="joinPublicRoom('${r.code}', false)">Beitreten</button>`;
    } else {
      if (activeCount < maxCapacity) {
        if (r.hasBots) {
          statusBadge = `<span class="room-status-badge badge-running">🟡 Im Spiel • ${r.botCount} Bot${r.botCount > 1 ? 's' : ''}</span>`;
          actionBtn = `<button class="btn btn-sm btn-outline btn-join-request" onclick="joinPublicRoom('${r.code}', true)">🙋 Nachjoinen</button>`;
        } else {
          statusBadge = `<span class="room-status-badge badge-running">🟡 Im Spiel (${activeCount}/${maxCapacity})</span>`;
          actionBtn = `<button class="btn btn-sm btn-outline btn-join-request" onclick="joinPublicRoom('${r.code}', true)" title="Als Zuschauer beitreten und nächste Partie mitspielen">👁️ Zuschauen</button>`;
        }
      } else {
        statusBadge = `<span class="room-status-badge badge-full">⚪ Voll (${activeCount}/${maxCapacity})</span>`;
        actionBtn = `<button class="btn btn-sm btn-outline" disabled>Voll</button>`;
      }
    }

    item.innerHTML = `
      <div class="active-room-info">
        <div class="active-room-main">
          <span class="active-room-code">${r.code}</span>
          <span class="active-room-host">Runde von <strong>${r.hostName}</strong></span>
        </div>
        <div class="active-room-meta">
          ${statusBadge}
        </div>
      </div>
      <div class="active-room-action">
        ${actionBtn}
      </div>
    `;

    list.appendChild(item);
  });
}

function joinPublicRoom(code, isMidGame) {
  const nameInput = document.getElementById('playerNameInput');
  let name = nameInput ? nameInput.value.trim() : '';
  if (!name) {
    name = prompt('Bitte gib deinen Spielernamen ein:') || '';
    name = name.trim();
    if (!name) return;
    if (nameInput) nameInput.value = name;
  }
  sessionStorage.setItem('tuppen_name', name);

  if (isMidGame) {
    socket.emit('request_join_room', { roomCode: code, playerName: name });
  } else {
    const codeInput = document.getElementById('roomCodeInput');
    if (codeInput) codeInput.value = code;
    handleJoinRoom();
  }
}

function updateHostMenuBadge() {
  const count = pendingJoinRequests.size;
  const badge = document.getElementById('hostMenuReqBadge');
  const btn = document.getElementById('hostMenuBtn');
  if (badge) {
    badge.textContent = count;
    if (count > 0) {
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
  if (btn) {
    if (count > 0) {
      btn.classList.add('has-requests');
    } else {
      btn.classList.remove('has-requests');
    }
  }
  const modalCount = document.getElementById('pendingReqCount');
  if (modalCount) modalCount.textContent = count;
}

function renderHostPendingRequests() {
  const section = document.getElementById('hostPendingRequestsSection');
  const listEl = document.getElementById('hostPendingRequestsList');
  if (!section || !listEl) return;

  const count = pendingJoinRequests.size;
  const modalCount = document.getElementById('pendingReqCount');
  if (modalCount) modalCount.textContent = count;

  if (count === 0) {
    section.classList.add('hidden');
    listEl.innerHTML = '';
    return;
  }

  section.classList.remove('hidden');
  listEl.innerHTML = '';

  const myTeam = gameState && gameState.you ? gameState.you.team : 0;

  pendingJoinRequests.forEach(req => {
    const card = document.createElement('div');
    card.className = 'host-req-card';

    const header = document.createElement('div');
    header.className = 'host-req-card-header';
    header.innerHTML = `<span class="host-req-card-title">🙋 <strong>${escapeHtml(req.playerName)}</strong> möchte der Runde beitreten:</span>`;
    card.appendChild(header);

    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'host-req-actions';
    actionsContainer.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin-top:8px;';

    const hasBots = req.availableBots && req.availableBots.length > 0;
    const canSpectate = (req.canSpectate !== false);

    // Option 1: Bot sofort im laufenden Spiel ersetzen (falls Bots vorhanden)
    if (hasBots) {
      const botSection = document.createElement('div');
      botSection.className = 'host-req-section';
      botSection.innerHTML = `<div style="font-size:0.78rem; font-weight:600; color:var(--text-muted); margin-bottom:4px;">🤖 Sofort einsteigen & Bot ersetzen:</div>`;

      const botGrid = document.createElement('div');
      botGrid.className = 'host-req-bots-grid';
      req.availableBots.forEach(bot => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-sm btn-bot-replace';
        btn.innerHTML = `<span>🤖 <strong>${escapeHtml(bot.name)}</strong></span> <small>ersetzen</small>`;
        btn.onclick = () => resolveJoinRequest(req.requestId, true, bot.seatIndex);
        botGrid.appendChild(btn);
      });
      botSection.appendChild(botGrid);
      actionsContainer.appendChild(botSection);
    }

    // Option 2: Als Zuschauer vormerken (steigt zur nächsten Partie als weiterer Spieler ein)
    if (canSpectate) {
      const specSection = document.createElement('div');
      specSection.className = 'host-req-section';
      const playerNumText = req.nextPlayerNumber ? `als ${req.nextPlayerNumber}. Spieler` : 'als weiterer Spieler';
      specSection.innerHTML = `<div style="font-size:0.78rem; font-weight:600; color:var(--text-muted); margin-bottom:4px;">👁️ Als Zuschauer vormerken (${playerNumText} in der nächsten Partie):</div>`;

      const specBtn = document.createElement('button');
      specBtn.type = 'button';
      specBtn.className = 'btn btn-sm btn-primary';
      specBtn.style.cssText = 'width:100%; text-align:center; padding:7px 10px; font-weight:600;';
      specBtn.innerHTML = `<span>👁️ Als Zuschauer annehmen (${playerNumText})</span>`;
      specBtn.onclick = () => resolveJoinRequest(req.requestId, true, -1);
      specSection.appendChild(specBtn);
      actionsContainer.appendChild(specSection);
    }

    // Falls weder Bot noch Zuschauerplatz frei
    if (!hasBots && !canSpectate) {
      const fullNotice = document.createElement('div');
      fullNotice.style.cssText = 'color:var(--danger); font-size:0.85rem; font-weight:600;';
      fullNotice.textContent = '⚠️ Kein freier Platz am Tisch (maximal 6 Spieler erreicht).';
      actionsContainer.appendChild(fullNotice);
    }

    // Option 3: Ablehnen
    const rejectRow = document.createElement('div');
    rejectRow.style.cssText = 'margin-top:4px; display:flex; justify-content:flex-end;';
    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'btn btn-xs btn-outline btn-reject-req';
    rejectBtn.innerHTML = '✕ Ablehnen';
    rejectBtn.onclick = () => resolveJoinRequest(req.requestId, false);
    rejectRow.appendChild(rejectBtn);
    actionsContainer.appendChild(rejectRow);

    card.appendChild(actionsContainer);
    listEl.appendChild(card);
  });
}

function resolveJoinRequest(requestId, accept, seatIndex) {
  socket.emit('resolve_join_request', {
    requestId,
    accept: !!accept,
    targetSeat: seatIndex
  });
  pendingJoinRequests.delete(requestId);
  updateHostMenuBadge();
  renderHostPendingRequests();
}

function toggleQuickPrivacy() {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) return;
  const toggle = document.getElementById('hostQuickPrivacyToggle');
  const isPublic = toggle ? toggle.checked : true;
  currentSettings.isPublic = isPublic;
  socket.emit('toggle_room_privacy', { isPublic });
  syncSettingsUI();
}

// Auffälliges Banner im Spielfeld, wenn jemand die Mit' ansagt
let mitNotificationTimer = null;
socket.on('mit_announced', ({ playerName, seatIndex }) => {
  const banner = document.getElementById('mitFieldNotification');
  const textEl = document.getElementById('mitPopText');
  if (banner && textEl) {
    const isMe = (seatIndex === mySeatIndex);
    const displayName = isMe ? `${playerName} (Du)` : playerName;
    textEl.textContent = `${displayName} sagt die MIT' an!`;
    banner.classList.remove('hidden');
    banner.classList.remove('fade-out');

    if (mitNotificationTimer) clearTimeout(mitNotificationTimer);
    mitNotificationTimer = setTimeout(() => {
      banner.classList.add('fade-out');
      setTimeout(() => {
        banner.classList.add('hidden');
        banner.classList.remove('fade-out');
      }, 500);
    }, 2800);
  }
  playSound('trump_fanfare');
});

// Schlankes Banner im Spielfeld, wenn jemand klopft: "Name hat 🔨"
let contraNotificationTimer = null;
socket.on('knock_announced', ({ knockerName, knockerIndex }) => {
  const banner = document.getElementById('contraFieldNotification');
  const textEl = document.getElementById('contraPopText');
  if (banner && textEl) {
    const isMe = (knockerIndex === mySeatIndex);
    const msg = isMe ? 'Du hast 🔨' : `${knockerName} hat 🔨`;
    textEl.textContent = msg;
    banner.classList.remove('hidden');
    banner.classList.remove('fade-out');

    if (contraNotificationTimer) clearTimeout(contraNotificationTimer);
    contraNotificationTimer = setTimeout(() => {
      banner.classList.add('fade-out');
      setTimeout(() => {
        banner.classList.add('hidden');
        banner.classList.remove('fade-out');
      }, 400);
    }, 2000);
  }
  playSound('contra_sound');
});

socket.on('contra_announced', ({ playerName, seatIndex }) => {
  const banner = document.getElementById('contraFieldNotification');
  const textEl = document.getElementById('contraPopText');
  if (banner && textEl) {
    const isMe = (seatIndex === mySeatIndex);
    const msg = isMe ? 'Du hast 🔨' : `${playerName} hat 🔨`;
    textEl.textContent = msg;
    banner.classList.remove('hidden');
    banner.classList.remove('fade-out');

    if (contraNotificationTimer) clearTimeout(contraNotificationTimer);
    contraNotificationTimer = setTimeout(() => {
      banner.classList.add('fade-out');
      setTimeout(() => {
        banner.classList.add('hidden');
        banner.classList.remove('fade-out');
      }, 400);
    }, 2000);
  }
  playSound('contra_sound');
});

// Auffälliges Banner im Spielfeld, wenn jemand Kontra-Re (Re) gibt
let contraReNotificationTimer = null;
socket.on('contra_re_announced', ({ playerName, seatIndex }) => {
  const banner = document.getElementById('contraReFieldNotification');
  const textEl = document.getElementById('contraRePopText');
  if (banner && textEl) {
    const isMe = (seatIndex === mySeatIndex);
    const displayName = isMe ? `${playerName} (Du)` : playerName;
    textEl.textContent = `${displayName} gibt RE (KONTRA-RE)!`;
    banner.classList.remove('hidden');
    banner.classList.remove('fade-out');

    if (contraReNotificationTimer) clearTimeout(contraReNotificationTimer);
    contraReNotificationTimer = setTimeout(() => {
      banner.classList.add('fade-out');
      setTimeout(() => {
        banner.classList.add('hidden');
        banner.classList.remove('fade-out');
      }, 500);
    }, 2800);
  }
  playSound('contra_sound');
});

// Auffälliges Banner im Spielfeld, wenn jemand Karten wegschmeißt (Dead Hand Fold)
let cardsThrownNotificationTimer = null;
socket.on('cards_thrown', ({ playerIndex, playerName, count }) => {
  const banner = document.getElementById('cardsThrownNotification');
  const textEl = document.getElementById('cardsThrownPopText');
  if (banner && textEl) {
    const isMe = (playerIndex === mySeatIndex);
    const displayName = isMe ? `${playerName} (Du)` : playerName;
    textEl.textContent = `${displayName} hat die Karten weggeschmissen!`;
    banner.classList.remove('hidden');
    banner.classList.remove('fade-out');

    if (cardsThrownNotificationTimer) clearTimeout(cardsThrownNotificationTimer);
    cardsThrownNotificationTimer = setTimeout(() => {
      banner.classList.add('fade-out');
      setTimeout(() => {
        banner.classList.add('hidden');
        banner.classList.remove('fade-out');
      }, 500);
    }, 2800);
  }
  playSound('card_play');
});

socket.on('room_created', ({ roomCode, seatIndex }) => {
  isCreatingRoom = false;
  isJoiningRoom = false;
  currentRoomCode = roomCode;
  mySeatIndex = seatIndex;
  document.getElementById('lobbyInitialOptions').classList.add('hidden');
  document.getElementById('lobbyWaitingRoom').classList.remove('hidden');
  document.getElementById('displayRoomCode').textContent = roomCode;

  const pName = getPlayerName();
  sessionStorage.setItem('tuppen_session', JSON.stringify({
    roomCode: roomCode,
    playerName: pName,
    seatIndex: seatIndex
  }));
});

let cooldownTickerInterval = null;
function startCooldownTicker() {
  if (cooldownTickerInterval) clearInterval(cooldownTickerInterval);
  cooldownTickerInterval = setInterval(() => {
    if (!gameState || !gameState.fourPicturesLockUntil) {
      clearInterval(cooldownTickerInterval);
      cooldownTickerInterval = null;
      return;
    }
    const remMs = gameState.fourPicturesLockUntil - Date.now();
    if (remMs <= 0) {
      clearInterval(cooldownTickerInterval);
      cooldownTickerInterval = null;
      if (gameState.you) {
        gameState.you.fourPicturesLockActive = false;
        gameState.you.fourPicturesLockRemainingSec = 0;
      }
      handleModals();
      renderStatusTicker();
      return;
    }
    const remSec = Math.ceil(remMs / 1000);
    if (gameState.you) {
      gameState.you.fourPicturesLockActive = true;
      gameState.you.fourPicturesLockRemainingSec = remSec;
    }
    const badges = document.querySelectorAll('.cooldown-ticker-badge');
    badges.forEach(b => {
      b.textContent = `⏱️ ${remSec}s`;
    });
    const ticker = document.getElementById('statusMessage');
    if (ticker && ticker.getAttribute('data-is-cooldown') === 'true') {
      ticker.textContent = `⏱️ 4-Bilder Bedenkzeit: ${remSec}s (Karten spielen kurz pausiert)...`;
    }
  }, 250);
}

let roundEndCountdownInterval = null;
function startRoundEndCountdown() {
  if (roundEndCountdownInterval) clearInterval(roundEndCountdownInterval);
  const updateSec = () => {
    if (!gameState || gameState.phase !== 'ROUND_END' || !gameState.roundEndAutoUntil) {
      if (roundEndCountdownInterval) {
        clearInterval(roundEndCountdownInterval);
        roundEndCountdownInterval = null;
      }
      return;
    }
    const remMs = gameState.roundEndAutoUntil - Date.now();
    const remSec = Math.max(0, Math.ceil(remMs / 1000));
    const secEl = document.getElementById('roundEndAutoSec');
    if (secEl) {
      secEl.textContent = remSec;
    }
    if (remMs <= 0) {
      if (roundEndCountdownInterval) {
        clearInterval(roundEndCountdownInterval);
        roundEndCountdownInterval = null;
      }
    }
  };
  updateSec();
  roundEndCountdownInterval = setInterval(updateSec, 250);
}

socket.on('game_state', (state) => {
  isCreatingRoom = false;
  isJoiningRoom = false;
  const previousPhase = gameState ? gameState.phase : null;
  const previousTurn = gameState ? gameState.currentTurn : null;
  const previousTrickCount = gameState ? gameState.trickCount : 0;
  const previousRoundNumber = gameState ? gameState.roundNumber : 0;

  gameState = state;
  mySeatIndex = state.you.seatIndex;
  currentRoomCode = state.roomCode;

  if (state.roundNumber !== previousRoundNumber) {
    revealedStackSounds.clear();
  }

  if (state.fourPicturesLockUntil && state.fourPicturesLockUntil > Date.now()) {
    startCooldownTicker();
  } else if (cooldownTickerInterval) {
    clearInterval(cooldownTickerInterval);
    cooldownTickerInterval = null;
  }

  if (state.phase === 'ROUND_END' && state.roundEndAutoUntil && state.roundEndAutoUntil > Date.now()) {
    startRoundEndCountdown();
  } else if (roundEndCountdownInterval) {
    clearInterval(roundEndCountdownInterval);
    roundEndCountdownInterval = null;
  }

  // Sitzung für Reconnection bei Verbindungsabbrüchen speichern
  const myPlayer = state.players[state.you.seatIndex];
  if (myPlayer) {
    sessionStorage.setItem('tuppen_session', JSON.stringify({
      roomCode: state.roomCode,
      playerName: myPlayer.name,
      seatIndex: state.you.seatIndex
    }));
  }

  // Sound-Effekte bei Phasen-/Zugwechsel
  if (state.phase === 'PLAY_TRICK' && state.currentTurn === mySeatIndex && previousTurn !== mySeatIndex) {
    playSound('turn');
  }
  if (state.trickCount > previousTrickCount) {
    playSound('trick_won');
  }

  renderUI();
});

socket.on('error_message', (msg) => {
  isCreatingRoom = false;
  isJoiningRoom = false;
  showToast(msg);
});

socket.on('player_emote', ({ seatIndex, emote }) => {
  showEmoteBubble(seatIndex, emote);
});

socket.on('spectator_joined', ({ roomCode, isSpectator, name }) => {
  isCreatingRoom = false;
  isJoiningRoom = false;
  currentRoomCode = roomCode;
  mySeatIndex = -1;
  showToast(`👁️ Als Zuschauer beigetreten (${name}). Du steigst in der nächsten Partie ein!`);
});

socket.on('spectator_promoted_to_player', ({ seatIndex, roomCode }) => {
  currentRoomCode = roomCode;
  mySeatIndex = seatIndex;
  socket.emit('confirm_spectator_promoted', { roomCode, seatIndex });
  if (gameState && gameState.you) {
    gameState.you.isSpectator = false;
    gameState.you.seatIndex = seatIndex;
  }
  const nameInput = document.getElementById('playerNameInput');
  const pName = (nameInput && nameInput.value.trim()) || (gameState && gameState.players && gameState.players[seatIndex] && gameState.players[seatIndex].name) || 'Spieler';
  sessionStorage.setItem('tuppen_session', JSON.stringify({ roomCode, seatIndex, playerName: pName }));
  showToast('🎉 Du nimmst nun als aktiver Spieler am Tisch Platz!');
});

socket.on('money_ledger_data', (data) => {
  renderMoneyLedgerModal(data);
});

socket.on('money_ledger_reset', () => {
  showToast('💰 Kasse wurde auf 0 zurückgesetzt.');
  const modal = document.getElementById('moneyLedgerModal');
  if (modal && !modal.classList.contains('hidden')) {
    socket.emit('get_money_ledger');
  }
});

// --------------------------------------------------------------------------
// UI-RENDERING (WIR vs SIE & BELGISCHE SVG KARTEN)
// --------------------------------------------------------------------------
function renderUI() {
  if (!gameState) return;

  if (gameState.phase === 'LOBBY') {
    document.getElementById('lobbyScreen').classList.add('active');
    document.getElementById('gameScreen').classList.remove('active');
    renderLobby();
  } else {
    document.getElementById('lobbyScreen').classList.remove('active');
    document.getElementById('gameScreen').classList.add('active');
    renderGameScreen();
  }

  handleModals();
}

function renderLobby() {
  document.getElementById('lobbyInitialOptions').classList.add('hidden');
  document.getElementById('lobbyWaitingRoom').classList.remove('hidden');
  document.getElementById('displayRoomCode').textContent = gameState.roomCode;

  const isMoney = Boolean(gameState.settings && gameState.settings.moneyMode);
  const moneyBadge = document.getElementById('lobbyMoneyBadge');
  const moneyText = document.getElementById('lobbyMoneyText');
  const fillBotsBtn = document.getElementById('fillBotsBtn');

  if (isMoney) {
    if (moneyBadge) moneyBadge.classList.remove('hidden');
    const stakeVal = (typeof gameState.settings.moneyStake === 'number') ? gameState.settings.moneyStake : 5.0;
    if (moneyText) moneyText.innerHTML = `Geldspiel aktiv: <strong>${stakeVal.toFixed(2)} € Einsatz pro Spieler</strong> (Bots gesperrt)`;
    if (fillBotsBtn) {
      fillBotsBtn.disabled = true;
      fillBotsBtn.style.opacity = '0.35';
      fillBotsBtn.title = 'Im Geldspiel sind keine Bots erlaubt';
    }
  } else {
    if (moneyBadge) moneyBadge.classList.add('hidden');
    if (fillBotsBtn) {
      fillBotsBtn.disabled = false;
      fillBotsBtn.style.opacity = '1';
      fillBotsBtn.title = '';
    }
  }

  let totalOccupied = 0;
  let humanCount = 0;
  for (let i = 0; i < 6; i++) {
    const slotEl = document.getElementById(`seatSlot${i}`);
    if (!slotEl) continue;
    slotEl.classList.remove('hidden');

    const seat = gameState.players ? gameState.players[i] : null;
    const nameEl = slotEl.querySelector('.player-name');
    const joinBtn = slotEl.querySelector('.btn-seat-join');
    const botBtn = slotEl.querySelector('.btn-seat-bot');
    const kickBtn = slotEl.querySelector('.btn-seat-kick');

    if (seat) {
      totalOccupied++;
      if (!seat.isBot) humanCount++;
      const isMe = (i === mySeatIndex);
      nameEl.textContent = `${seat.name}${isMe ? ' (Du)' : ''}`;
      nameEl.style.color = isMe ? 'var(--team-we-gold)' : '#fff';
      slotEl.classList.add('occupied');
      slotEl.classList.toggle('is-me', isMe);
      joinBtn.classList.add('hidden');

      if (isMoney) {
        botBtn.classList.add('hidden');
      } else {
        botBtn.textContent = seat.isBot ? '✕ Bot' : '';
        botBtn.classList.toggle('hidden', !seat.isBot);
      }

      if (kickBtn) {
        // Spielleiter kann andere menschliche Spieler in der Lobby kicken
        const canKick = Boolean(gameState.you && gameState.you.isHost && !seat.isBot && !isMe);
        kickBtn.classList.toggle('hidden', !canKick);
      }
    } else {
      nameEl.textContent = 'Frei';
      nameEl.style.color = 'var(--text-muted)';
      slotEl.classList.remove('occupied', 'is-me');
      joinBtn.classList.remove('hidden');

      if (isMoney) {
        botBtn.classList.add('hidden');
      } else {
        botBtn.textContent = '+ Bot';
        botBtn.classList.remove('hidden');
      }
      if (kickBtn) kickBtn.classList.add('hidden');
    }
  }

  const startBtn = document.getElementById('startGameBtn');
  if (gameState.you && gameState.you.isHost) {
    startBtn.classList.remove('hidden');
    if (isMoney) {
      if (humanCount >= 2) {
        startBtn.disabled = false;
        startBtn.textContent = `💰 Geldspiel starten (${humanCount} Spieler)`;
      } else {
        startBtn.disabled = true;
        startBtn.textContent = `⏳ Mindestens 2 echte Spieler erforderlich (${humanCount}/2)...`;
      }
    } else {
      if (totalOccupied >= 2) {
        startBtn.disabled = false;
        startBtn.textContent = `🎮 Spiel jetzt starten (${totalOccupied} Spieler)`;
      } else {
        startBtn.disabled = true;
        startBtn.textContent = `⏳ Mindestens 2 Spieler erforderlich (${totalOccupied}/2)...`;
      }
    }
  } else {
    startBtn.classList.remove('hidden');
    startBtn.disabled = true;
    startBtn.textContent = `Warte auf Spielleiter (${totalOccupied} Spieler am Tisch)...`;
  }

  syncSettingsUI();
}

function renderGameScreen() {
  const startLives = gameState.settings ? (gameState.settings.initialLives || gameState.settings.maxPenalty || 7) : 7;
  const myScore = (gameState.you && typeof gameState.you.score === 'number') ? gameState.you.score : (gameState.scores ? gameState.scores[mySeatIndex] : startLives);
  const currentStake = gameState.currentStake || 1;

  // Header Scoreboard (Deine Leben / Einsatz)
  const scoreWeEl = document.getElementById('scoreWe');
  const scoreTheyEl = document.getElementById('scoreThey');
  const tricksWeEl = document.getElementById('tricksWe');
  const tricksTheyEl = document.getElementById('tricksThey');
  const labelWe = document.getElementById('labelWe');
  const labelWeMax = document.getElementById('labelWeMax');

  const isSpectator = Boolean(gameState.you && gameState.you.isSpectator);
  if (isSpectator) {
    if (scoreWeEl) scoreWeEl.textContent = '👁️';
    if (labelWe) labelWe.textContent = 'ZUSCHAUER';
    if (labelWeMax) labelWeMax.textContent = '';
  } else {
    if (scoreWeEl) scoreWeEl.textContent = myScore;
    if (labelWe) labelWe.textContent = 'DEINE LEBEN';
    if (labelWeMax) labelWeMax.textContent = `/ ${startLives}`;
  }

  if (scoreTheyEl) scoreTheyEl.textContent = currentStake;
  if (tricksWeEl) tricksWeEl.textContent = `${gameState.trickCount || 0} / 4`;
  if (tricksTheyEl) tricksTheyEl.textContent = `4. Stich`;

  // Geld-Badge im Header
  const moneyBadgeBtn = document.getElementById('moneyBadgeBtn');
  const moneyBadgeText = document.getElementById('moneyBadgeText');
  if (gameState.moneyMode) {
    if (moneyBadgeBtn) moneyBadgeBtn.classList.remove('hidden');
    const pot = (typeof gameState.currentPot === 'number') ? gameState.currentPot : 0;
    const potStr = (pot % 1 === 0) ? `${pot} €` : `${pot.toFixed(2)} €`;
    if (moneyBadgeText) moneyBadgeText.textContent = `💰 Pot: ${potStr}`;
  } else {
    if (moneyBadgeBtn) moneyBadgeBtn.classList.add('hidden');
  }

  // Zuschauer-Banner
  const spectatorBanner = document.getElementById('spectatorBanner');
  if (spectatorBanner) {
    spectatorBanner.classList.toggle('hidden', !isSpectator);
  }

  // Letzter Stich Button Sichtbarkeit
  const viewLastTrickBtn = document.getElementById('viewLastTrickBtn');
  if (gameState.lastTrick) {
    viewLastTrickBtn.classList.remove('hidden');
  } else {
    viewLastTrickBtn.classList.add('hidden');
  }

  // Runde & Einsatz-Badge
  document.getElementById('roundNumberDisplay').textContent = gameState.roundNumber;
  const trumpBadge = document.getElementById('trumpBadge');
  const trumpText = document.getElementById('trumpBadgeText');
  if (trumpBadge) {
    trumpBadge.className = 'trump-badge tuppen-stake-badge';
    const iconEl = trumpBadge.querySelector('.trump-icon');
    if (iconEl) iconEl.textContent = '🔨';
    if (trumpText) trumpText.textContent = `${currentStake} Leben`;
  }

  const announceContraBtn = document.getElementById('announceContraBtn');
  if (announceContraBtn) {
    const you = gameState.you;
    if (!you) {
      announceContraBtn.classList.add('hidden');
      announceContraBtn.classList.remove('btn-contra-counter');
    } else if (gameState.phase === 'KNOCK_DECISION') {
      const canCounterKnock = Boolean(you.isKnockDecisionTurn && you.canKnock);
      announceContraBtn.classList.toggle('hidden', !canCounterKnock);
      if (canCounterKnock) {
        announceContraBtn.classList.add('btn-contra-counter');
        const nextStake = (gameState.currentStake || 1) + 1;
        announceContraBtn.textContent = '🔨 Gegen (+1)';
        announceContraBtn.title = `Gegenklopfen: Rundeneinsatz auf ${nextStake} Leben erhöhen`;
      } else {
        announceContraBtn.classList.remove('btn-contra-counter');
      }
    } else if (gameState.phase === 'PLAY_TRICK') {
      announceContraBtn.classList.toggle('hidden', !you.canKnock);
      announceContraBtn.classList.remove('btn-contra-counter');
      announceContraBtn.textContent = '🔨 Klopfen';
      announceContraBtn.title = 'Klopfen: Rundeneinsatz um 1 Leben erhöhen';
    } else {
      announceContraBtn.classList.add('hidden');
      announceContraBtn.classList.remove('btn-contra-counter');
    }
  }

  const fourPicsBtn = document.getElementById('declareFourPicsBtn');
  if (fourPicsBtn) {
    fourPicsBtn.classList.add('hidden');
  }

  const hostMenuBtn = document.getElementById('hostMenuBtn');
  const isHost = gameState.you ? gameState.you.isHost : false;
  if (hostMenuBtn) {
    hostMenuBtn.classList.toggle('hidden', !isHost);
  }

  const hostModal = document.getElementById('hostControlModal');
  if (hostModal && !hostModal.classList.contains('hidden')) {
    renderHostPlayerList();
  }

  // Status Ticker
  renderStatusTicker();

  // Spieler am Tisch rendern (relativ zur eigenen Position)
  renderTablePlayers();

  // 4-Bilder Tischstapel rendern
  renderFourPicsTablePiles();

  // Stich im Zentrum rendern
  renderTrickCenter();

  // Eigene Handkarten rendern
  renderMyHand();
}



function renderStatusTicker() {
  const ticker = document.getElementById('statusMessage');
  if (!ticker) return;

  const isSpectator = Boolean(gameState.you && gameState.you.isSpectator);
  if (isSpectator) {
    ticker.textContent = '👁️ Du schaust als Zuschauer zu. Sobald diese Partie gewonnen wurde, steigst du in das nächste Spiel ein!';
    return;
  }

  if (gameState.phase === 'POVERTY_CHECK') {
    ticker.textContent = '⚠️ Armuts-Entscheidung läuft (Mitspielen oder Passen)...';
  } else if (gameState.phase === 'KNOCK_DECISION') {
    const knocker = gameState.players ? gameState.players[gameState.knockerIndex] : null;
    const knockerName = knocker ? knocker.name : 'Ein Spieler';
    if (gameState.you && gameState.you.folded) {
      ticker.textContent = `🚪 Du bist ausgestiegen. Warte auf Ende der Runde...`;
    } else if (gameState.you && gameState.you.isKnockDecisionTurn) {
      ticker.textContent = `🔨 ${knockerName} hat auf ${gameState.currentStake} Leben geklopft! Wähle: Dabei oder Raus?`;
    } else if (gameState.knockerIndex === mySeatIndex) {
      ticker.textContent = `🔨 Du hast auf ${gameState.currentStake} Leben geklopft! Warte auf Mitspieler...`;
    } else {
      ticker.textContent = `🔨 ${knockerName} hat auf ${gameState.currentStake} Leben geklopft! Entscheidungen laufen...`;
    }
  } else if (gameState.phase === 'FOUR_PICTURES_CHALLENGE') {
    ticker.textContent = '🎴 4 Bilder auf dem Tisch! Klicke auf die verdeckten Karten zum Aufdecken & Prüfen...';
  } else if (gameState.phase === 'FOUR_PICTURES_REVEAL') {
    ticker.textContent = '🔍 4 Bilder werden aufgedeckt & geprüft...';
  } else if (gameState.phase === 'PLAY_TRICK') {
    const currentTurnPlayer = gameState.players[gameState.currentTurn];
    if (gameState.you && gameState.you.fourPicturesLockActive) {
      ticker.setAttribute('data-is-cooldown', 'true');
      ticker.textContent = `⏱️ 4-Bilder Bedenkzeit: ${gameState.you.fourPicturesLockRemainingSec}s (Karten spielen kurz pausiert)...`;
    } else {
      ticker.removeAttribute('data-is-cooldown');
      if (gameState.currentTurn === mySeatIndex) {
        ticker.textContent = '⚡ Du bist am Zug!';
      } else {
        ticker.textContent = `${currentTurnPlayer ? currentTurnPlayer.name : 'Spieler'} ist am Zug...`;
      }
    }
  } else if (gameState.phase === 'EVALUATING_TRICK') {
    ticker.textContent = 'Stich wird ausgewertet...';
  } else if (gameState.phase === 'ROUND_END') {
    ticker.textContent = 'Runde beendet!';
  } else if (gameState.phase === 'GAME_OVER') {
    ticker.textContent = 'Partie entschieden!';
  }
}

function renderTablePlayers() {
  let seatedIndices = [];
  if (gameState && gameState.players) {
    for (let i = 0; i < gameState.players.length; i++) {
      if (gameState.players[i]) seatedIndices.push(i);
    }
  }
  if (seatedIndices.length === 0) {
    const maxP = gameState && gameState.settings ? (gameState.settings.playerCount || 4) : 4;
    for (let i = 0; i < maxP; i++) seatedIndices.push(i);
  }
  const seatedCount = Math.max(2, seatedIndices.length);

  const feltTable = document.getElementById('feltTable');
  if (feltTable) {
    feltTable.classList.remove('mode-2p', 'mode-3p', 'mode-4p', 'mode-5p', 'mode-6p');
    feltTable.classList.add(`mode-${seatedCount}p`);
  }

  // Alle nicht-bottom Spieler-Boxen vorab ausblenden
  const allBoxes = ['Top', 'Left', 'Right', 'TopLeft', 'BottomLeft', 'TopRight', 'BottomRight'];
  allBoxes.forEach(pos => {
    const el = document.getElementById(`player${pos}`);
    if (el) el.classList.add('hidden');
  });

  const isSpectator = Boolean(gameState.you && gameState.you.isSpectator);
  const baseSeat = isSpectator ? seatedIndices[0] : (typeof mySeatIndex === 'number' && mySeatIndex >= 0 ? mySeatIndex : seatedIndices[0]);
  let baseIdx = seatedIndices.indexOf(baseSeat);
  if (baseIdx === -1) baseIdx = 0;

  let activePositions = [];
  if (seatedCount === 2) {
    activePositions = [
      { key: 'Bottom', seatIdx: seatedIndices[baseIdx] },
      { key: 'Top', seatIdx: seatedIndices[(baseIdx + 1) % 2] }
    ];
  } else if (seatedCount === 3) {
    activePositions = [
      { key: 'Bottom', seatIdx: seatedIndices[baseIdx] },
      { key: 'TopLeft', seatIdx: seatedIndices[(baseIdx + 1) % 3] },
      { key: 'TopRight', seatIdx: seatedIndices[(baseIdx + 2) % 3] }
    ];
  } else if (seatedCount === 4) {
    activePositions = [
      { key: 'Bottom', seatIdx: seatedIndices[baseIdx] },
      { key: 'Left', seatIdx: seatedIndices[(baseIdx + 1) % 4] },
      { key: 'Top', seatIdx: seatedIndices[(baseIdx + 2) % 4] },
      { key: 'Right', seatIdx: seatedIndices[(baseIdx + 3) % 4] }
    ];
  } else if (seatedCount === 5) {
    activePositions = [
      { key: 'Bottom', seatIdx: seatedIndices[baseIdx] },
      { key: 'BottomLeft', seatIdx: seatedIndices[(baseIdx + 1) % 5] },
      { key: 'TopLeft', seatIdx: seatedIndices[(baseIdx + 2) % 5] },
      { key: 'TopRight', seatIdx: seatedIndices[(baseIdx + 3) % 5] },
      { key: 'BottomRight', seatIdx: seatedIndices[(baseIdx + 4) % 5] }
    ];
  } else {
    activePositions = [
      { key: 'Bottom', seatIdx: seatedIndices[baseIdx] },
      { key: 'BottomLeft', seatIdx: seatedIndices[(baseIdx + 1) % 6] },
      { key: 'TopLeft', seatIdx: seatedIndices[(baseIdx + 2) % 6] },
      { key: 'Top', seatIdx: seatedIndices[(baseIdx + 3) % 6] },
      { key: 'TopRight', seatIdx: seatedIndices[(baseIdx + 4) % 6] },
      { key: 'BottomRight', seatIdx: seatedIndices[(baseIdx + 5) % 6] }
    ];
  }

  activePositions.forEach(({ key, seatIdx }) => {
    const playerBox = document.getElementById(`player${key}`);
    if (playerBox) playerBox.classList.remove('hidden');

    const player = gameState.players ? gameState.players[seatIdx] : null;
    if (!player) return;

    const isMe = !isSpectator && (seatIdx === mySeatIndex);

    // Name
    const nameEl = document.getElementById(`name${key}`);
    const declarerPill = document.getElementById(`declarerPill${key}`);

    if (nameEl) {
      nameEl.textContent = isMe ? `${player.name} (Du)` : player.name;
    }

    // Klöpper-Pill ausblenden (verhindert dreifache redundante Anzeige und spart Platz)
    if (declarerPill) declarerPill.classList.add('hidden');

    const mitPill = document.getElementById(`mitPill${key}`);
    if (mitPill) mitPill.classList.add('hidden');

    const thrownPill = document.getElementById(`thrownPill${key}`);
    if (thrownPill) thrownPill.classList.add('hidden');

    // Lebens-Tag
    const tagEl = document.getElementById(`tag${key}`);
    const startLives = gameState.settings ? (gameState.settings.initialLives || gameState.settings.maxPenalty || 7) : 7;
    const lives = (player.score !== undefined) ? player.score : startLives;
    if (tagEl) {
      if (player.eliminated || lives <= 0) {
        tagEl.textContent = '💀 Ausgeschieden';
        tagEl.className = 'team-tag tag-eliminated';
      } else if (player.folded) {
        tagEl.textContent = '🚪 Gepasst';
        tagEl.className = 'team-tag tag-folded';
      } else if (lives === 1) {
        tagEl.textContent = '❤️ 1 Leben';
        tagEl.className = 'team-tag tag-danger';
      } else {
        tagEl.textContent = `❤️ ${lives} Leben`;
        if (lives <= 2) tagEl.className = 'team-tag tag-warn';
        else tagEl.className = 'team-tag tag-safe';
      }
    }

    // Geber Badge
    const dealerBadge = document.getElementById(`dealer${key}`);
    if (dealerBadge) dealerBadge.classList.toggle('hidden', !player.isDealer);

    // Turn Glow am Avatar
    const avatarBox = playerBox ? playerBox.querySelector('.player-avatar-box') : null;
    if (avatarBox) {
      avatarBox.classList.toggle('player-turn-glow', player.isTurn);

      // Lebens Mini-Badge unter Avatar
      let penBadge = avatarBox.querySelector('.player-penalty-badge');
      if (!penBadge) {
        penBadge = document.createElement('div');
        penBadge.className = 'player-penalty-badge';
        penBadge.style.position = 'absolute';
        penBadge.style.bottom = '-10px';
        penBadge.style.left = '50%';
        penBadge.style.transform = 'translateX(-50%)';
        avatarBox.appendChild(penBadge);
      }
      if (player.eliminated || lives <= 0) {
        penBadge.textContent = '💀';
        penBadge.className = 'player-penalty-badge penalty-eliminated';
      } else if (lives === 1) {
        penBadge.textContent = '🔨 1';
        penBadge.className = 'player-penalty-badge penalty-danger';
      } else {
        penBadge.textContent = `❤️ ${lives}`;
        if (lives <= 2) penBadge.className = 'player-penalty-badge penalty-warn';
        else penBadge.className = 'player-penalty-badge penalty-safe';
      }
      penBadge.style.position = 'absolute';
      penBadge.style.bottom = '-10px';
      penBadge.style.left = '50%';
      penBadge.style.transform = 'translateX(-50%)';
    }

    // Mini Card Backs für Gegner & Partner
    if (key !== 'Bottom') {
      const cardsContainer = document.getElementById(`cards${key}`);
      if (cardsContainer) {
        cardsContainer.innerHTML = '';
        for (let c = 0; c < player.cardCount; c++) {
          const mini = document.createElement('div');
          mini.className = 'mini-card-back';
          cardsContainer.appendChild(mini);
        }
      }
    }
  });

  // Turn Indicator für Spieler unten
  const isMyTurn = (gameState.currentTurn === mySeatIndex && gameState.phase === 'PLAY_TRICK');
  document.getElementById('turnIndicator').classList.toggle('hidden', !isMyTurn);
}

function renderTrickCenter() {
  let seatedIndices = [];
  if (gameState && gameState.players) {
    for (let i = 0; i < gameState.players.length; i++) {
      if (gameState.players[i]) seatedIndices.push(i);
    }
  }
  if (seatedIndices.length === 0) {
    const maxP = gameState && gameState.settings ? (gameState.settings.playerCount || 4) : 4;
    for (let i = 0; i < maxP; i++) seatedIndices.push(i);
  }
  const seatedCount = Math.max(2, seatedIndices.length);

  const allSlotKeys = ['Top', 'Left', 'Right', 'TopLeft', 'BottomLeft', 'TopRight', 'BottomRight', 'Bottom'];
  allSlotKeys.forEach(pos => {
    const el = document.getElementById(`trickSlot${pos}`);
    if (el) {
      el.classList.add('hidden');
      el.innerHTML = '<div class="card-placeholder"></div>';
      el.classList.remove('has-multi-cards');
    }
  });

  let activeKeys = [];
  if (seatedCount === 2) activeKeys = ['Bottom', 'Top'];
  else if (seatedCount === 3) activeKeys = ['Bottom', 'TopLeft', 'TopRight'];
  else if (seatedCount === 4) activeKeys = ['Bottom', 'Left', 'Top', 'Right'];
  else if (seatedCount === 5) activeKeys = ['Bottom', 'BottomLeft', 'TopLeft', 'TopRight', 'BottomRight'];
  else activeKeys = ['Bottom', 'BottomLeft', 'TopLeft', 'Top', 'TopRight', 'BottomRight'];

  activeKeys.forEach(pos => {
    const el = document.getElementById(`trickSlot${pos}`);
    if (el) el.classList.remove('hidden');
  });

  // Group cards in trick by seat position
  const cardsByPos = {};
  (gameState.currentTrick || []).forEach(trickItem => {
    const pos = getRelativePosition(trickItem.playerIndex, mySeatIndex);
    if (!cardsByPos[pos]) cardsByPos[pos] = [];
    cardsByPos[pos].push(trickItem);
  });

  activeKeys.forEach(pos => {
    const slot = document.getElementById(`trickSlot${pos}`);
    if (!slot) return;
    const items = cardsByPos[pos] || [];
    if (items.length === 0) {
      slot.innerHTML = '<div class="card-placeholder"></div>';
    } else if (items.length === 1) {
      slot.innerHTML = createCardHTML(items[0].card, false, true);
    } else {
      slot.classList.add('has-multi-cards');
      slot.innerHTML = `
        <div class="trick-multi-cards-group">
          ${items.map(it => createCardHTML(it.card, false, true)).join('')}
        </div>
      `;
    }
  });

  const banner = document.getElementById('trickBanner');
  const info = gameState.trickWinnerInfo || gameState.lastTrick;
  if (gameState.phase === 'EVALUATING_TRICK' && info) {
    banner.classList.remove('hidden');
    const isMe = (info.winnerIndex === mySeatIndex);
    const winnerLabel = isMe ? 'Du hast den Stich!' : `Stich geht an ${info.winnerName}!`;
    const tNum = gameState.currentTrickNumber || '';
    const tSuffix = tNum ? ` (Stich ${tNum}/4)` : '';
    document.getElementById('trickWinnerText').textContent = `🏆 ${winnerLabel}${tSuffix}`;
  } else {
    banner.classList.add('hidden');
  }
}

let revealedStackSounds = new Set();

/**
 * Rendert die abgelegten 4-Bilder Kartenstapel vor den jeweiligen Spielern auf dem Tisch.
 * Unterstützt mehrere Ansagen (Stapel nebeneinander aufgereiht) und individuelles Aufdecken.
 */
function renderFourPicsTablePiles() {
  const allPositions = ['Top', 'Left', 'Right', 'TopLeft', 'BottomLeft', 'TopRight', 'BottomRight', 'Bottom'];
  const stacks = (gameState && gameState.fourPicturesStacks) || [];

  // Wenn keine Stapel vorhanden sind oder Stich 1 vorbei ist, alles ausblenden
  if (stacks.length === 0 || !gameState || gameState.trickCount > 0) {
    allPositions.forEach(pos => {
      const container = document.getElementById('laidPile' + pos);
      if (container) {
        container.classList.add('hidden');
        container.innerHTML = '';
      }
    });
    return;
  }

  allPositions.forEach(pos => {
    const container = document.getElementById('laidPile' + pos);
    if (!container) return;

    let targetSeatIndex = -1;
    for (let sIdx = 0; sIdx < 6; sIdx++) {
      if (getRelativePosition(sIdx, mySeatIndex) === pos) {
        targetSeatIndex = sIdx;
        break;
      }
    }

    if (targetSeatIndex === -1) {
      container.classList.add('hidden');
      container.innerHTML = '';
      return;
    }

    const playerStacks = stacks.filter(st => st.declarerIndex === targetSeatIndex);
    if (playerStacks.length === 0) {
      container.classList.add('hidden');
      container.innerHTML = '';
      return;
    }

    container.classList.remove('hidden');
    const isMe = (targetSeatIndex === mySeatIndex);

    const stacksHtml = playerStacks.map((st, stackIdx) => {
      const stackNum = stackIdx + 1;
      const canChallenge = Boolean(st.canChallenge);

      if (st.isRevealed) {
        if (!revealedStackSounds.has(st.id)) {
          revealedStackSounds.add(st.id);
          if (st.isGenuine) {
            playSound('trump_fanfare');
          } else {
            playSound('contra_sound');
          }
        }

        const badgeText = st.isGenuine
          ? `✓ ${stackNum} 🎴`
          : `🚨 ${stackNum} 🎴`;
        const badgeClass = st.isGenuine ? 'badge-genuine' : 'badge-bluff';

        let cardsHtml = '';
        if (Array.isArray(st.revealedCards)) {
          cardsHtml = st.revealedCards.map((card, cIdx) => `
            <div class="laid-card-item" style="animation-delay: ${cIdx * 0.08}s">
              ${createCardHTML(card, false)}
            </div>
          `).join('');
        }

        return `
          <div class="four-pics-single-stack is-revealed" data-stack-id="${st.id}">
            <div class="laid-pile-badge ${badgeClass}">${badgeText}</div>
            <div class="laid-cards-fan">
              ${cardsHtml}
            </div>
          </div>
        `;
      } else {
        let badgeHtml = '';
        let stackClass = 'four-pics-single-stack';
        let clickAttr = '';
        let titleAttr = '';

        if (canChallenge) {
          stackClass += ' can-challenge';
          badgeHtml = `<div class="laid-pile-badge badge-challenge-hint">👆 Aufdecken</div>`;
          clickAttr = `onclick="event.stopPropagation(); challengeSpecificStack(${st.id})"`;
          titleAttr = `title="Klicken zum Aufdecken & Prüfen von Stapel #${stackNum} (+1 Strafpunkt Risiko)"`;
        } else if (isMe) {
          badgeHtml = `<div class="laid-pile-badge">${stackNum} 🎴</div>`;
          titleAttr = `title="Deine abgelegten 4 Karten (Stapel #${stackNum})"`;
        } else {
          badgeHtml = `<div class="laid-pile-badge">${stackNum} 🎴</div>`;
          titleAttr = `title="Abgelegter Stapel #${stackNum} von ${st.declarerName || 'Spieler'}"`;
        }

        const backsHtml = `
          <div class="laid-card-item"><div class="laid-card-back">🎴</div></div>
          <div class="laid-card-item"><div class="laid-card-back">🎴</div></div>
          <div class="laid-card-item"><div class="laid-card-back">🎴</div></div>
          <div class="laid-card-item"><div class="laid-card-back">🎴</div></div>
        `;

        return `
          <div class="${stackClass}" data-stack-id="${st.id}" ${clickAttr} ${titleAttr}>
            ${badgeHtml}
            <div class="laid-cards-fan">
              ${backsHtml}
            </div>
          </div>
        `;
      }
    }).join('');

    container.innerHTML = `<div class="four-pics-stacks-row">${stacksHtml}</div>`;
  });
}

function renderMyHand() {
  const fan = document.getElementById('myHandFan');
  fan.innerHTML = '';

  if (gameState.you && gameState.you.isSpectator) {
    fan.setAttribute('data-card-count', 0);
    const specNote = document.createElement('div');
    specNote.className = 'my-hand-thrown-note';
    specNote.innerHTML = `<span>👁️ Du schaust zu – Teilnahme startet bei nächster Partie</span>`;
    fan.appendChild(specNote);
    return;
  }

  if (gameState.you && gameState.you.hasThrownCards) {
    fan.setAttribute('data-card-count', 0);
    const thrownNote = document.createElement('div');
    thrownNote.className = 'my-hand-thrown-note';
    thrownNote.innerHTML = `<span>🗑️ Karten in den Stich weggeschmissen</span>`;
    fan.appendChild(thrownNote);
    return;
  }

  const hand = gameState.you.hand || [];
  const total = hand.length;
  fan.setAttribute('data-card-count', total);
  const isMyTurn = (gameState.currentTurn === mySeatIndex && gameState.phase === 'PLAY_TRICK');

  // Bei 3 oder weniger Karten flacher Fächer mit extra Abstand
  const useRotation = total > 3;

  hand.forEach((card, index) => {
    let isPlayable = true;
    if (isMyTurn) {
      if (gameState.you && gameState.you.playableMap && Object.keys(gameState.you.playableMap).length > 0) {
        isPlayable = !!gameState.you.playableMap[card.id];
      } else {
        isPlayable = isCardPlayableClient(card, hand, gameState.currentTrick);
      }
    }
    const cardEl = document.createElement('div');

    const rot = useRotation ? ((index - (total - 1) / 2) * 4) : 0;
    const ty = useRotation ? (Math.abs(index - (total - 1) / 2) * 2) : 0;

    cardEl.innerHTML = createCardHTML(card, !isPlayable && isMyTurn, true);
    const cardChild = cardEl.firstElementChild;
    cardChild.style.transform = `rotate(${rot}deg) translateY(${ty}px)`;

    if (isPlayable && isMyTurn) {
      cardChild.addEventListener('click', () => playCard(card.id));
    }

    fan.appendChild(cardChild);
  });
}

/**
 * Erzeugt das SVG-HTML für eine Spielkarte im belgischen Carta Mundi Vektor-Design.
 */
function createCardHTML(card, isDisabled = false) {
  const svgId = getSvgCardId(card);
  return `
    <div class="playing-card ${isDisabled ? 'disabled' : ''}" data-id="${card.id}">
      <svg class="card-svg-element" viewBox="0 0 169.075 244.640" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
        <use href="#${svgId}" xlink:href="#${svgId}"></use>
      </svg>
    </div>
  `;
}



function getSvgCardId(card) {
  const suitMap = {
    clubs: 'club',
    spades: 'spade',
    hearts: 'heart',
    diamonds: 'diamond'
  };

  const rankMap = {
    'A': '1',
    'K': 'king',
    'Q': 'queen',
    'J': 'jack',
    '10': '10',
    '9': '9',
    '8': '8',
    '7': '7'
  };

  const s = suitMap[card.suit] || 'club';
  const r = rankMap[card.rank] || '1';
  return `${s}_${r}`;
}

let fourPicturesDismissedRound = -1;

function dismissFourPictures() {
  if (gameState) fourPicturesDismissedRound = gameState.roundNumber;
  handleModals();
}
window.dismissFourPictures = dismissFourPictures;

function handleModals() {
  const mitBanner = document.getElementById('mitActionBanner');
  const roundModal = document.getElementById('roundSummaryModal');
  const gameOverModal = document.getElementById('gameOverModal');

  // Interaktives Aktions-Banner (Klopfen, Armut, 4 Bilder)
  if (mitBanner) {
    if (gameState.you && gameState.you.isSpectator) {
      mitBanner.classList.add('hidden');
    } else if (gameState.phase === 'FOUR_PICTURES_REVEAL' && gameState.fourPicturesTablePile) {
      mitBanner.classList.remove('hidden');
      const pile = gameState.fourPicturesTablePile;
      const isGenuine = Boolean(pile.isGenuine);
      const declarer = gameState.players ? gameState.players[pile.declarerIndex] : null;
      const dName = declarer ? declarer.name : 'Spieler';
      const cName = pile.challengerName || 'Herausforderer';
      mitBanner.innerHTML = `
        <div class="mit-banner-buttons">
          <span style="font-size:0.82rem; font-weight:700; color:${isGenuine ? '#4ade80' : '#f87171'}; align-self:center;">
            ${isGenuine ? `✓ ECHT! ${dName} hatte wirklich 4 Bilder! (💔 -1 Leben für Prüfer ${cName})` : `🚨 BLUFF! Keine 4 Bilder! (💔 -1 Leben für ${dName})`}
          </span>
        </div>
      `;
    } else if (gameState.you && gameState.you.isFourPicturesChallengeTurn) {
      mitBanner.classList.add('hidden');
    } else if (gameState.you && gameState.you.isPovertyDecisionTurn) {
      mitBanner.classList.remove('hidden');
      const stake = gameState.currentStake || 2;
      const heartsStr = stake <= 4 ? '❤️'.repeat(stake) : `❤️ × ${stake}`;
      const can4Pics = Boolean(gameState.you && gameState.you.canDeclare4Pictures);
      let pButtonsHtml = `
        <span class="knock-hearts-badge" title="Klöpper-Einsatz: ${stake} Leben">${heartsStr}</span>
        <button class="btn-compact-dabei" onclick="povertyResponse('play')" title="Mitgehen (${stake} Leben)">
          Dabei
        </button>
        <button class="btn-compact-raus" onclick="povertyResponse('fold')" title="Passen (-1 Leben)">
          Passen
        </button>
      `;
      if (can4Pics) {
        pButtonsHtml += `
          <button class="btn-four-pics-compact" onclick="declareFourPictures()" title="4 Karten gegen frische tauschen (vor Stich 1)">
            🎴 4 Bilder
          </button>
        `;
      }
      if (gameState.you && gameState.you.fourPicturesLockActive) {
        const remSec = gameState.you.fourPicturesLockRemainingSec || 1;
        pButtonsHtml += `
          <span class="cooldown-ticker-badge" title="Bedenkzeit nach 4-Bilder-Ansage vor Stich 1">
            ⏱️ ${remSec}s
          </span>
        `;
      }
      mitBanner.innerHTML = `
        <div class="mit-banner-buttons">
          ${pButtonsHtml}
        </div>
      `;
    } else {
      const isKnockTurn = Boolean(gameState.you && gameState.you.isKnockDecisionTurn);
      const can4Pics = Boolean(gameState.you && gameState.you.canDeclare4Pictures);
      const isLockActive = Boolean(gameState.you && gameState.you.fourPicturesLockActive);

      if (isKnockTurn || can4Pics || isLockActive) {
        mitBanner.classList.remove('hidden');
        let buttonsHtml = '';

        if (isKnockTurn) {
          const stake = gameState.currentStake || 2;
          const heartsStr = stake <= 4 ? '❤️'.repeat(stake) : `❤️ × ${stake}`;
          buttonsHtml += `
            <span class="knock-hearts-badge" title="Rundeneinsatz: ${stake} Leben">${heartsStr}</span>
            <button class="btn-compact-dabei" onclick="knockResponse('call')" title="Mitgehen (${stake} Leben)">
              Dabei
            </button>
            <button class="btn-compact-raus" onclick="knockResponse('fold')" title="Rausgehen / Passen">
              Raus
            </button>
          `;
        }

        if (can4Pics) {
          buttonsHtml += `
            <button class="btn-four-pics-compact" onclick="declareFourPictures()" title="4 Karten gegen frische tauschen (vor Stich 1)">
              🎴 4 Bilder
            </button>
          `;
        }

        if (isLockActive) {
          const remSec = gameState.you.fourPicturesLockRemainingSec || 1;
          buttonsHtml += `
            <span class="cooldown-ticker-badge" title="Bedenkzeit nach 4-Bilder-Ansage vor Stich 1">
              ⏱️ ${remSec}s
            </span>
          `;
        }

        mitBanner.innerHTML = `
          <div class="mit-banner-buttons">
            ${buttonsHtml}
          </div>
        `;
      } else {
        mitBanner.classList.add('hidden');
      }
    }
  }

  // Karten wegschmeißen Banner (im Tuppen nicht verwendet)
  const throwCardsBanner = document.getElementById('throwCardsBanner');
  if (throwCardsBanner) throwCardsBanner.classList.add('hidden');

  // Rundenabrechnungs-Modal
  if (gameState.phase === 'ROUND_END' && gameState.roundSummary) {
    roundModal.classList.remove('hidden');
    renderRoundSummary(gameState.roundSummary);
  } else {
    roundModal.classList.add('hidden');
  }

  // Game Over Modal
  if (gameState.phase === 'GAME_OVER' && gameState.roundSummary) {
    gameOverModal.classList.remove('hidden');
    const isHost = gameState.you ? gameState.you.isHost : true;
    const isMeWinner = (gameState.roundSummary.winnerIndex === mySeatIndex);

    document.getElementById('gameOverTitle').textContent = isMeWinner
      ? '🏆 DU HAST DAS TUPPEN-TURNIER GEWONNEN!'
      : `👑 ${gameState.roundSummary.winnerName} HAT GEWONNEN!`;

    document.getElementById('gameOverTrophy').textContent = isMeWinner ? '🏆' : '👑';

    const subtitleEl = document.getElementById('gameOverSubtitle');
    if (subtitleEl) {
      subtitleEl.textContent = `${gameState.roundSummary.winnerName} ist der letzte überlebende Spieler mit verbleibenden Leben!`;
    }

    const goGrid = document.getElementById('gameOverPlayersGrid');
    if (goGrid) {
      goGrid.innerHTML = '';
      const players = gameState.players || [];
      players.forEach((p, idx) => {
        const isChamp = (idx === gameState.roundSummary.winnerIndex);
        const lives = (p.score !== undefined) ? p.score : 0;
        const col = document.createElement('div');
        col.className = `tuppen-score-col ${isChamp ? 'winner-col' : 'elim-col'}`;
        col.innerHTML = `
          <span class="p-name">${idx === mySeatIndex ? 'Du (' + p.name + ')' : p.name}</span>
          <span class="p-score">${isChamp ? `❤️ ${lives} Leben` : '💀 0 Leben'}</span>
          <span class="elim-badge">${isChamp ? '🏆 CHAMPION' : '💀 Ausgeschieden'}</span>
        `;
        goGrid.appendChild(col);
      });
    }

    // Game Over Trinkspiel Tasks
    const goDrinkBox = document.getElementById('gameOverDrinkingBox');
    const dMode = (gameState.settings && gameState.settings.drinkingMode) || 'off';
    if (goDrinkBox) {
      if (dMode !== 'off' && gameState.roundSummary && gameState.roundSummary.drinkingTasks) {
        goDrinkBox.classList.remove('hidden');
        const goTasks = gameState.roundSummary.drinkingTasks.tasks || [];
        const myGoTask = goTasks.find(t => t.playerIndex === mySeatIndex) || { sipsToDrink: 0, sipsToDistribute: 0, distributedSips: 0, reasons: [] };
        const goTextEl = document.getElementById('gameOverDrinkingText');
        const goSipsList = document.getElementById('gameOverDrinkingSips');
        const goDistArea = document.getElementById('gameOverDistributeArea');
        const goDistButtons = document.getElementById('gameOverDistributeButtons');

        const remainingToDist = myGoTask.sipsToDistribute - (myGoTask.distributedSips || 0);

        if (myGoTask.isWinner) {
          goDrinkBox.classList.remove('we-drink');
          if (goTextEl) {
            goTextEl.innerHTML = `👑 <strong>TURNIERSIEG! Du trinkst 0 Schlücke${remainingToDist > 0 ? ` & darfst noch ${remainingToDist} Ehren-Schlücke verteilen!` : '!'}</strong>`;
          }
        } else {
          goDrinkBox.classList.add('we-drink');
          if (goTextEl) {
            goTextEl.innerHTML = `💀 <strong>AUSGESCHIEDEN! Du musst ${myGoTask.sipsToDrink} Schluck${myGoTask.sipsToDrink > 1 ? 'e' : ''} trinken!</strong>`;
          }
        }

        if (goSipsList) {
          goSipsList.innerHTML = '';
          goTasks.forEach(gt => {
            const row = document.createElement('div');
            row.className = 'drinking-sip-row';
            const isMe = (gt.playerIndex === mySeatIndex);
            row.innerHTML = `
              <span class="drinking-sip-name">${isMe ? '👉 Du (' + gt.playerName + ')' : gt.playerName}</span>
              <span class="drinking-sip-count ${gt.sipsToDrink > 0 ? 'danger' : ''}">${gt.sipsToDrink} Schluck${gt.sipsToDrink !== 1 ? 'e' : ''} ${gt.sipsToDrink > 0 ? '🍺'.repeat(Math.min(gt.sipsToDrink, 8)) : '🏆 0'}</span>
            `;
            goSipsList.appendChild(row);
          });
        }

        if (goDistArea && goDistButtons) {
          if (myGoTask.isWinner && remainingToDist > 0) {
            goDistArea.classList.remove('hidden');
            goDistButtons.innerHTML = '';
            const otherTargets = goTasks.filter(gt => gt.playerIndex !== mySeatIndex);
            otherTargets.forEach(ot => {
              const btn = document.createElement('button');
              btn.className = 'btn-distribute-sip';
              btn.textContent = `+1 an ${ot.playerName} 🍺`;
              btn.onclick = () => distributeSip(ot.playerIndex);
              goDistButtons.appendChild(btn);
            });
          } else {
            goDistArea.classList.add('hidden');
          }
        }
      } else {
        goDrinkBox.classList.add('hidden');
      }
    }

    // Game Over Geldspiel Abrechnung
    const goMoneyBox = document.getElementById('gameOverMoneyBox');
    const moneySettlement = (gameState.roundSummary && gameState.roundSummary.moneySettlement) ? gameState.roundSummary.moneySettlement : null;
    if (goMoneyBox) {
      if (moneySettlement) {
        goMoneyBox.classList.remove('hidden');
        const isMeWinner = (moneySettlement.winnerSeatIndex === mySeatIndex);
        const myDelta = isMeWinner ? moneySettlement.winnerNetGain : -moneySettlement.moneyStake;

        let transfersHtml = '';
        if (moneySettlement.debtTransfers && moneySettlement.debtTransfers.length > 0) {
          transfersHtml = `
            <div class="go-transfers-sub">
              <strong style="display:block; margin-bottom: 6px; font-size: 0.9rem;">💸 Wer zahlt wem wie viel? (Ausgleichszahlungen):</strong>
              <div class="go-transfers-list">
                ${moneySettlement.debtTransfers.map(t => `
                  <div class="debt-transfer-card">
                    <span class="debtor-pill">💸 <strong>${t.from}</strong></span>
                    <span class="transfer-arrow">zahlt <strong>${t.amount.toFixed(2)} €</strong> an ➔</span>
                    <span class="creditor-pill">📥 <strong>${t.to}</strong></span>
                  </div>
                `).join('')}
              </div>
            </div>
          `;
        } else {
          transfersHtml = `<div class="empty-hint">Keine offenen Schulden vorhanden. Alle Salden ausgeglichen!</div>`;
        }

        let outcomeText = '';
        if (mySeatIndex === -1) {
          outcomeText = `👁️ Du hast als Zuschauer zugesehen. Sieger <strong>${moneySettlement.winnerName}</strong> gewinnt den Pot (+${moneySettlement.winnerNetGain.toFixed(2)} € netto)!`;
        } else if (isMeWinner) {
          outcomeText = `🎉 <strong>Turniersieg!</strong> Reingewinn: <strong>+${moneySettlement.winnerNetGain.toFixed(2)} €</strong> (Gesamter Pot: ${moneySettlement.pot.toFixed(2)} €)`;
        } else {
          outcomeText = `💸 Einsatz verloren: <strong>-${moneySettlement.moneyStake.toFixed(2)} €</strong> an den Pot.`;
        }

        goMoneyBox.innerHTML = `
          <div class="go-money-header">
            <span class="go-money-tag">💰 GELDSPIEL-ABRECHNUNG</span>
            <span class="go-money-pot">Pot: <strong>${moneySettlement.pot.toFixed(2)} €</strong></span>
          </div>
          <div class="go-money-outcome ${isMeWinner ? 'win' : (mySeatIndex === -1 ? 'neutral' : 'loss')}">
            <span class="go-outcome-text">${outcomeText}</span>
          </div>
          ${transfersHtml}
          <div style="text-align: center; margin-top: 10px;">
            <button type="button" class="btn btn-sm btn-outline" onclick="openMoneyLedgerModal()">📊 Gesamte Sitzungs-Kasse öffnen</button>
          </div>
        `;
      } else {
        goMoneyBox.classList.add('hidden');
      }
    }

    const restartBtn = document.getElementById('restartGameBtn');
    const goWaitingNote = document.getElementById('gameOverWaitingNote');
    if (restartBtn && goWaitingNote) {
      if (isHost) {
        restartBtn.classList.remove('hidden');
        restartBtn.disabled = false;
        goWaitingNote.classList.add('hidden');
      } else {
        restartBtn.classList.add('hidden');
        goWaitingNote.classList.remove('hidden');
      }
    }

    if (isMeWinner) playSound('victory');
  } else {
    gameOverModal.classList.add('hidden');
  }
}

function renderRoundSummary(summary) {
  const isHost = gameState.you ? gameState.you.isHost : true;

  document.getElementById('summaryRoundTag').textContent = `Runde ${summary.roundNumber} beendet`;

  const winnerBanner = document.getElementById('summaryWinnerBanner');
  const isMeWinner = (summary.winnerIndex === mySeatIndex);
  if (isMeWinner) {
    winnerBanner.textContent = `🎉 DU GEWINNST DIE RUNDE! (0 Leben verloren)`;
    winnerBanner.className = 'summary-winner-banner we-won';
    playSound('victory');
  } else {
    winnerBanner.textContent = `🏆 ${summary.winnerName} GEWINNT DIE RUNDE!`;
    winnerBanner.className = 'summary-winner-banner they-won';
  }

  // Reason text
  const reasonEl = document.getElementById('summaryReason');
  if (reasonEl) reasonEl.textContent = summary.reason || '';

  // Render individual players grid
  const grid = document.getElementById('summaryPlayersGrid');
  if (grid) {
    grid.innerHTML = '';
    const players = gameState.players || [];
    players.forEach((p, idx) => {
      const isWinner = (idx === summary.winnerIndex);
      const isElim = summary.eliminated ? summary.eliminated[idx] : p.isEliminated;
      const oldScore = summary.oldScores ? summary.oldScores[idx] : 0;
      const newScore = summary.newScores ? summary.newScores[idx] : (p.score || 0);
      const livesLost = oldScore - newScore;

      const col = document.createElement('div');
      col.className = `tuppen-score-col ${isWinner ? 'winner-col' : ''} ${isElim ? 'elim-col' : ''}`;
      col.innerHTML = `
        <span class="p-name">${idx === mySeatIndex ? 'Du (' + p.name + ')' : p.name}</span>
        <span class="p-score">${newScore === 1 ? '🔨 1 Leben' : `❤️ ${newScore} Leben`}</span>
        <span class="p-delta ${livesLost > 0 ? 'bad-delta' : 'good-delta'}">${livesLost > 0 ? '-' + livesLost + ' Leben' : '±0 Leben'}</span>
        ${isElim ? '<span class="elim-badge">💀 Ausgeschieden</span>' : ''}
        ${isWinner ? '<span style="font-size:0.7rem; color:#f59e0b; font-weight:700;">👑 Runden-Sieger</span>' : ''}
      `;
      grid.appendChild(col);
    });
  }

  // Stock reveal ausblenden
  const stockRevealBox = document.querySelector('.stock-reveal-box');
  if (stockRevealBox) stockRevealBox.classList.add('hidden');

  // Trinkspiel-Aufgaben rendern
  const drinkingBox = document.getElementById('drinkingTaskBox');
  const dMode = (gameState.settings && gameState.settings.drinkingMode) || 'off';
  const hasDrinking = (dMode !== 'off' && summary.drinkingTasks && summary.drinkingTasks.tasks);

  if (drinkingBox) {
    if (hasDrinking) {
      drinkingBox.classList.remove('hidden');
      const dTasks = summary.drinkingTasks.tasks;
      const myTask = dTasks.find(t => t.playerIndex === mySeatIndex) || { sipsToDrink: 0, sipsToDistribute: 0, distributedSips: 0, reasons: [] };
      const dTextEl = document.getElementById('drinkingTaskText');
      const dIconEl = document.getElementById('drinkingTaskIcon');
      const dSipsList = document.getElementById('drinkingPlayersSips');
      const dDistArea = document.getElementById('drinkingDistributeArea');
      const dDistButtons = document.getElementById('drinkingDistributeButtons');

      const remainingToDistribute = myTask.sipsToDistribute - (myTask.distributedSips || 0);

      if (myTask.sipsToDrink > 0) {
        drinkingBox.classList.add('we-drink');
        if (dIconEl) dIconEl.textContent = '🍺💥';
        if (dTextEl) {
          dTextEl.innerHTML = `🚨 <strong>DU MUSST ${myTask.sipsToDrink} SCHLUCK${myTask.sipsToDrink > 1 ? 'E' : ''} TRINKEN!</strong><br><small style="opacity:0.9;">(${myTask.reasons.join(' • ')})</small>`;
        }
      } else if (myTask.isWinner) {
        drinkingBox.classList.remove('we-drink');
        if (dIconEl) dIconEl.textContent = '👑🍺';
        if (dTextEl) {
          dTextEl.innerHTML = `👑 <strong>RUNDENSIEG! Du trinkst 0 Schlücke${remainingToDistribute > 0 ? ` & darfst noch ${remainingToDistribute} Schluck${remainingToDistribute > 1 ? 'e' : ''} verteilen!` : '!'}</strong>`;
        }
      } else {
        drinkingBox.classList.remove('we-drink');
        if (dIconEl) dIconEl.textContent = '🍻';
        if (dTextEl) {
          dTextEl.innerHTML = `✨ <strong>0 Schlücke:</strong> Du kommst diese Runde ungeschoren davon!`;
        }
      }

      // Alle Spieler auflisten
      if (dSipsList) {
        dSipsList.innerHTML = '';
        dTasks.forEach(dt => {
          const row = document.createElement('div');
          row.className = 'drinking-sip-row';
          const isMe = (dt.playerIndex === mySeatIndex);
          const sips = dt.sipsToDrink;
          const sipsBeers = sips > 0 ? '🍺'.repeat(Math.min(sips, 8)) + (sips > 8 ? ` (${sips})` : '') : '🛡️ 0';
          row.innerHTML = `
            <span class="drinking-sip-name">${isMe ? '👉 Du (' + dt.playerName + ')' : dt.playerName}</span>
            <span class="drinking-sip-count ${sips > 0 ? 'danger' : ''}">${sips} Schluck${sips !== 1 ? 'e' : ''} <small style="font-weight:normal; opacity:0.8;">${sipsBeers}</small></span>
          `;
          dSipsList.appendChild(row);
        });
      }

      // Verteiler-Buttons für den Gewinner
      if (dDistArea && dDistButtons) {
        if (myTask.isWinner && remainingToDistribute > 0) {
          dDistArea.classList.remove('hidden');
          dDistButtons.innerHTML = '';
          const otherTargets = dTasks.filter(dt => dt.playerIndex !== mySeatIndex);
          otherTargets.forEach(ot => {
            const btn = document.createElement('button');
            btn.className = 'btn-distribute-sip';
            btn.textContent = `+1 an ${ot.playerName} 🍺`;
            btn.onclick = () => distributeSip(ot.playerIndex);
            dDistButtons.appendChild(btn);
          });
        } else {
          dDistArea.classList.add('hidden');
        }
      }
    } else {
      drinkingBox.classList.add('hidden');
    }
  }

  // Next round button control & Cooldown/Auto-Countdown
  const nextBtn = document.getElementById('nextRoundBtn');
  const waitingNote = document.getElementById('waitingForHostNote');
  if (nextBtn && waitingNote) {
    const isAlive = Boolean(gameState.you && !gameState.you.eliminated && gameState.you.score > 0);
    const canTriggerNext = isHost || isAlive;

    if (hasDrinking) {
      // Trinkspiel aktiv: KEIN automatischer Timer, sondern 7s Trinkpause
      const lockSec = (gameState.nextRoundLockedUntil && gameState.nextRoundLockedUntil > Date.now())
        ? Math.max(0, Math.ceil((gameState.nextRoundLockedUntil - Date.now()) / 1000))
        : (gameState.nextRoundLockedRemainingSec || 0);

      if (lockSec > 0) {
        nextBtn.classList.remove('hidden');
        nextBtn.disabled = true;
        nextBtn.classList.add('btn-locked');
        nextBtn.textContent = `🍺 Trinkpause... (${lockSec}s)`;
        waitingNote.innerHTML = `🍺 <em>Trinkspiel-Modus: Erst austrinken, dann geht's weiter!</em>`;
        waitingNote.classList.remove('hidden');
      } else {
        if (canTriggerNext) {
          nextBtn.classList.remove('hidden');
          nextBtn.disabled = false;
          nextBtn.classList.remove('btn-locked');
          nextBtn.textContent = 'Nächste Runde starten ➜';
        } else {
          nextBtn.classList.add('hidden');
        }
        waitingNote.innerHTML = `🍺 <em>Ausgetrunken? Dann kann die nächste Runde starten!</em>`;
        waitingNote.classList.remove('hidden');
      }
    } else {
      // Normaler Modus: 5s Auto-Countdown & Sofort weiter
      nextBtn.classList.remove('btn-locked');
      const remSec = (gameState.roundEndAutoUntil && gameState.roundEndAutoUntil > Date.now())
        ? Math.max(0, Math.ceil((gameState.roundEndAutoUntil - Date.now()) / 1000))
        : 5;

      waitingNote.innerHTML = `⏱️ Nächste Runde startet automatisch in <strong id="roundEndAutoSec">${remSec}</strong>s...`;
      waitingNote.classList.remove('hidden');

      if (canTriggerNext) {
        nextBtn.classList.remove('hidden');
        nextBtn.disabled = false;
        nextBtn.textContent = '⏩ Sofort weiter';
      } else {
        nextBtn.classList.add('hidden');
      }
    }
  }
}

function formatDelta(val) {
  if (val > 0) return `+${val}`;
  if (val < 0) return `${val}`;
  return '0';
}

// --------------------------------------------------------------------------
// SPIELEINSTELLUNGEN & REGEL-MODAL (⚙️)
// --------------------------------------------------------------------------
let currentSettings = {
  playerCount: 4,
  initialLives: 7,
  maxPenalty: 7,
  allowKloepper: true,
  allowPoverty: true,
  kloepperStakeMode: 'fixed',
  allowFourPictures: true,
  fourPicturesCooldownSeconds: 5,
  allowBlindKnock: true,
  trickDisplaySeconds: 2.5,
  dealAndTurnDelaySeconds: 1.0,
  isPublic: true,
  drinkingMode: 'off',
  moneyMode: false,
  moneyStake: 5.0
};

function openSettingsModal() {
  if (gameState && gameState.settings) {
    currentSettings = { ...gameState.settings };
  }
  syncSettingsUI();
  document.getElementById('settingsModal').classList.remove('hidden');
}

function closeSettingsModal() {
  document.getElementById('settingsModal').classList.add('hidden');
}

function syncSettingsUI() {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;

  // Privatsphäre Hebel (Lobby-Einstellungen & In-Game Spielleiter-Menü)
  const isPublicInput = document.getElementById('settingIsPublic');
  if (isPublicInput) {
    isPublicInput.checked = currentSettings.isPublic !== false;
    isPublicInput.disabled = !isHost;
  }
  const hostQuickToggle = document.getElementById('hostQuickPrivacyToggle');
  const hostPrivacyTitle = document.getElementById('hostPrivacyTitle');
  const hostPrivacyDesc = document.getElementById('hostPrivacyDesc');
  if (hostQuickToggle) {
    hostQuickToggle.checked = currentSettings.isPublic !== false;
    hostQuickToggle.disabled = !isHost;
  }
  if (hostPrivacyTitle) {
    hostPrivacyTitle.textContent = (currentSettings.isPublic !== false) ? '🌐 Öffentliche Runde' : '🔒 Private Runde';
  }
  if (hostPrivacyDesc) {
    hostPrivacyDesc.textContent = (currentSettings.isPublic !== false) ? 'In aktiver Liste sichtbar & Nachjoinen aktiv' : 'Aus Liste entfernt & Beitritt gesperrt';
  }

  // Startleben Segmented Control (5, 7, 10, 12)
  const initLives = currentSettings.initialLives || currentSettings.maxPenalty || 7;
  const seg5 = document.getElementById('segInitialLives5');
  const seg7 = document.getElementById('segInitialLives7');
  const seg10 = document.getElementById('segInitialLives10');
  const seg12 = document.getElementById('segInitialLives12');
  if (seg5) { seg5.classList.toggle('active', initLives === 5); seg5.disabled = !isHost; }
  if (seg7) { seg7.classList.toggle('active', initLives === 7); seg7.disabled = !isHost; }
  if (seg10) { seg10.classList.toggle('active', initLives === 10); seg10.disabled = !isHost; }
  if (seg12) { seg12.classList.toggle('active', initLives === 12); seg12.disabled = !isHost; }

  // Trinkspiel Segmented Control ('off', 'mild', 'medium', 'extreme')
  const drinkMode = currentSettings.drinkingMode || 'off';
  const segDrinkOff = document.getElementById('segDrinkOff');
  const segDrinkMild = document.getElementById('segDrinkMild');
  const segDrinkMed = document.getElementById('segDrinkMedium');
  const segDrinkExt = document.getElementById('segDrinkExtreme');
  if (segDrinkOff) { segDrinkOff.classList.toggle('active', drinkMode === 'off'); segDrinkOff.disabled = !isHost; }
  if (segDrinkMild) { segDrinkMild.classList.toggle('active', drinkMode === 'mild'); segDrinkMild.disabled = !isHost; }
  if (segDrinkMed) { segDrinkMed.classList.toggle('active', drinkMode === 'medium'); segDrinkMed.disabled = !isHost; }
  if (segDrinkExt) { segDrinkExt.classList.toggle('active', drinkMode === 'extreme'); segDrinkExt.disabled = !isHost; }

  // Geldspiel Toggle & Einsatzhöhe
  const moneyModeInput = document.getElementById('settingMoneyMode');
  const isMoney = currentSettings.moneyMode === true;
  if (moneyModeInput) {
    moneyModeInput.checked = isMoney;
    moneyModeInput.disabled = !isHost;
  }
  const moneyStakeRow = document.getElementById('settingMoneyStakeRow');
  if (moneyStakeRow) {
    moneyStakeRow.classList.toggle('hidden', !isMoney);
  }
  const stakeVal = (typeof currentSettings.moneyStake === 'number') ? currentSettings.moneyStake : 5.0;
  [1, 2, 5, 10, 20].forEach(preset => {
    const btn = document.getElementById(`segStake${preset}`);
    if (btn) {
      btn.classList.toggle('active', stakeVal === preset);
      btn.disabled = !isHost || !isMoney;
    }
  });
  const customStakeInput = document.getElementById('settingCustomStake');
  if (customStakeInput) {
    customStakeInput.value = stakeVal.toFixed(2);
    customStakeInput.disabled = !isHost || !isMoney;
  }

  // Klöpper-Regel
  const allowKloepperInput = document.getElementById('settingAllowKloepper');
  const isKloepper = currentSettings.allowKloepper !== false && currentSettings.allowPoverty !== false;
  if (allowKloepperInput) {
    allowKloepperInput.checked = isKloepper;
    allowKloepperInput.disabled = !isHost;
  }

  // Klöpper-Einsatz Segmented Control ('fixed' vs 'per_player')
  const stakeMode = currentSettings.kloepperStakeMode || 'fixed';
  const segStakeFixed = document.getElementById('segKloepperStakeFixed');
  const segStakePerPlayer = document.getElementById('segKloepperStakePerPlayer');
  if (segStakeFixed) { segStakeFixed.classList.toggle('active', stakeMode === 'fixed'); segStakeFixed.disabled = !isHost || !isKloepper; }
  if (segStakePerPlayer) { segStakePerPlayer.classList.toggle('active', stakeMode === 'per_player'); segStakePerPlayer.disabled = !isHost || !isKloepper; }

  // 4-Bilder-Regel
  const allowFourPicsInput = document.getElementById('settingAllowFourPictures');
  if (allowFourPicsInput) {
    allowFourPicsInput.checked = currentSettings.allowFourPictures !== false;
    allowFourPicsInput.disabled = !isHost;
  }

  // 4-Bilder Bedenkzeit Cooldown (0 bis 10s, Standard 5s)
  const cdVal = (typeof currentSettings.fourPicturesCooldownSeconds === 'number') ? currentSettings.fourPicturesCooldownSeconds : 5;
  const sliderCd = document.getElementById('sliderFourPicsCooldown');
  if (sliderCd) {
    sliderCd.value = cdVal;
    sliderCd.disabled = !isHost || !allowFourPicsInput || !allowFourPicsInput.checked;
  }
  const dispCd = document.getElementById('displayFourPicsCooldown');
  if (dispCd) {
    dispCd.textContent = cdVal === 0 ? '0s (Sofort)' : `${cdVal}s`;
  }
  const btnCdMinus = document.getElementById('btn4PicsCdMinus');
  if (btnCdMinus) btnCdMinus.disabled = !isHost || !allowFourPicsInput || !allowFourPicsInput.checked || cdVal <= 0;
  const btnCdPlus = document.getElementById('btn4PicsCdPlus');
  if (btnCdPlus) btnCdPlus.disabled = !isHost || !allowFourPicsInput || !allowFourPicsInput.checked || cdVal >= 10;

  [0, 3, 5, 7, 10].forEach(sec => {
    const btn = document.getElementById(`seg4PicsCd${sec}`);
    if (btn) {
      btn.classList.toggle('active', cdVal === sec);
      btn.disabled = !isHost || !allowFourPicsInput || !allowFourPicsInput.checked;
    }
  });
  const cdRow = document.getElementById('settingFourPicsCooldownRow');
  if (cdRow) {
    cdRow.style.opacity = (allowFourPicsInput && !allowFourPicsInput.checked) ? '0.5' : '1';
    cdRow.style.pointerEvents = (allowFourPicsInput && !allowFourPicsInput.checked) ? 'none' : 'auto';
  }

  // Blindklopfen vor Stich 1
  const allowBlindKnockInput = document.getElementById('settingAllowBlindKnock');
  if (allowBlindKnockInput) {
    allowBlindKnockInput.checked = currentSettings.allowBlindKnock !== false;
    allowBlindKnockInput.disabled = !isHost;
  }

  // Speed / Delays Display
  const dispTrick = document.getElementById('displayTrickDelay');
  const dispDeal = document.getElementById('displayDealDelay');
  if (dispTrick) {
    const trickVal = (typeof currentSettings.trickDisplaySeconds === 'number') ? currentSettings.trickDisplaySeconds : 2.5;
    dispTrick.textContent = `${trickVal.toFixed(1)}s`;
  }
  if (dispDeal) {
    const dealVal = (typeof currentSettings.dealAndTurnDelaySeconds === 'number') ? currentSettings.dealAndTurnDelaySeconds : 1.0;
    dispDeal.textContent = `${dealVal.toFixed(1)}s`;
  }
}

function setDrinkingModeSetting(mode) {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) {
    showToast('Nur der Raum-Ersteller kann Einstellungen ändern.');
    return;
  }
  currentSettings.drinkingMode = mode;
  syncSettingsUI();
  saveRuleSettings();
}
window.setDrinkingModeSetting = setDrinkingModeSetting;

function toggleMoneyModeSetting() {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) {
    showToast('Nur der Raum-Ersteller kann Einstellungen ändern.');
    return;
  }
  const moneyModeInput = document.getElementById('settingMoneyMode');
  currentSettings.moneyMode = moneyModeInput ? moneyModeInput.checked : !currentSettings.moneyMode;
  syncSettingsUI();
  saveRuleSettings();
}
window.toggleMoneyModeSetting = toggleMoneyModeSetting;

function setMoneyStakeSetting(val) {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) {
    showToast('Nur der Raum-Ersteller kann Einstellungen ändern.');
    return;
  }
  currentSettings.moneyStake = Math.round(Number(val) * 100) / 100;
  syncSettingsUI();
  saveRuleSettings();
}
window.setMoneyStakeSetting = setMoneyStakeSetting;

function onCustomStakeChange() {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) return;
  const input = document.getElementById('settingCustomStake');
  if (!input) return;
  let val = parseFloat(input.value);
  if (isNaN(val) || val <= 0) val = 1.0;
  if (val > 500) val = 500.0;
  currentSettings.moneyStake = Math.round(val * 100) / 100;
  syncSettingsUI();
  saveRuleSettings();
}
window.onCustomStakeChange = onCustomStakeChange;

function setInitialLivesSetting(val) {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) {
    showToast('Nur der Raum-Ersteller kann Einstellungen ändern.');
    return;
  }
  currentSettings.initialLives = val;
  currentSettings.maxPenalty = val;
  syncSettingsUI();
  saveRuleSettings();
}
window.setInitialLivesSetting = setInitialLivesSetting;
window.setMaxPenaltySetting = setInitialLivesSetting;

function setKloepperStakeSetting(mode) {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) {
    showToast('Nur der Raum-Ersteller kann Einstellungen ändern.');
    return;
  }
  currentSettings.kloepperStakeMode = mode;
  syncSettingsUI();
  saveRuleSettings();
}
window.setKloepperStakeSetting = setKloepperStakeSetting;

function setFourPicsCooldownSetting(val) {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) {
    showToast('Nur der Raum-Ersteller kann Einstellungen ändern.');
    return;
  }
  let num = parseInt(val, 10);
  if (isNaN(num)) num = 5;
  if (num < 0) num = 0;
  if (num > 10) num = 10;
  currentSettings.fourPicturesCooldownSeconds = num;
  syncSettingsUI();
  saveRuleSettings();
}
window.setFourPicsCooldownSetting = setFourPicsCooldownSetting;

function adjustFourPicsCooldownSetting(delta) {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) {
    showToast('Nur der Raum-Ersteller kann Einstellungen ändern.');
    return;
  }
  const cur = (typeof currentSettings.fourPicturesCooldownSeconds === 'number') ? currentSettings.fourPicturesCooldownSeconds : 5;
  setFourPicsCooldownSetting(cur + delta);
}
window.adjustFourPicsCooldownSetting = adjustFourPicsCooldownSetting;

function onFourPicsCooldownSlider(val) {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) return;
  setFourPicsCooldownSetting(val);
}
window.onFourPicsCooldownSlider = onFourPicsCooldownSlider;

function adjustSpeedSetting(type, delta) {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) {
    showToast('Nur der Raum-Ersteller kann Einstellungen ändern.');
    return;
  }
  if (type === 'trickDelay') {
    let val = ((typeof currentSettings.trickDisplaySeconds === 'number') ? currentSettings.trickDisplaySeconds : 2.5) + delta;
    val = Math.round(val * 10) / 10;
    if (val < 0.8) val = 0.8;
    if (val > 7.0) val = 7.0;
    currentSettings.trickDisplaySeconds = val;
  } else if (type === 'dealDelay') {
    let val = ((typeof currentSettings.dealAndTurnDelaySeconds === 'number') ? currentSettings.dealAndTurnDelaySeconds : 1.0) + delta;
    val = Math.round(val * 10) / 10;
    if (val < 0.3) val = 0.3;
    if (val > 5.0) val = 5.0;
    currentSettings.dealAndTurnDelaySeconds = val;
  }
  syncSettingsUI();
  saveRuleSettings();
}

function setSpeedPreset(trickSec, dealSec) {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) {
    showToast('Nur der Raum-Ersteller kann Einstellungen ändern.');
    return;
  }
  currentSettings.trickDisplaySeconds = trickSec;
  currentSettings.dealAndTurnDelaySeconds = dealSec;
  syncSettingsUI();
  saveRuleSettings();
}

function saveRuleSettings() {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) return;

  const isPublicInput = document.getElementById('settingIsPublic');
  const allowKloepperInput = document.getElementById('settingAllowKloepper');
  const allowFourPicsInput = document.getElementById('settingAllowFourPictures');
  const allowBlindKnockInput = document.getElementById('settingAllowBlindKnock');
  const moneyModeInput = document.getElementById('settingMoneyMode');

  const isKloepperChecked = allowKloepperInput ? allowKloepperInput.checked : (currentSettings.allowKloepper !== false);
  const isMoneyChecked = moneyModeInput ? moneyModeInput.checked : (currentSettings.moneyMode === true);

  const settingsPayload = {
    playerCount: currentSettings.playerCount || 4,
    initialLives: currentSettings.initialLives || 7,
    maxPenalty: currentSettings.initialLives || 7,
    drinkingMode: currentSettings.drinkingMode || 'off',
    moneyMode: isMoneyChecked,
    moneyStake: (typeof currentSettings.moneyStake === 'number') ? currentSettings.moneyStake : 5.0,
    allowKloepper: isKloepperChecked,
    allowPoverty: isKloepperChecked,
    kloepperStakeMode: currentSettings.kloepperStakeMode || 'fixed',
    allowFourPictures: allowFourPicsInput ? allowFourPicsInput.checked : (currentSettings.allowFourPictures !== false),
    fourPicturesCooldownSeconds: (typeof currentSettings.fourPicturesCooldownSeconds === 'number') ? currentSettings.fourPicturesCooldownSeconds : 5,
    allowBlindKnock: allowBlindKnockInput ? allowBlindKnockInput.checked : (currentSettings.allowBlindKnock !== false),
    trickDisplaySeconds: (typeof currentSettings.trickDisplaySeconds === 'number') ? currentSettings.trickDisplaySeconds : 2.5,
    dealAndTurnDelaySeconds: (typeof currentSettings.dealAndTurnDelaySeconds === 'number') ? currentSettings.dealAndTurnDelaySeconds : 1.0,
    isPublic: isPublicInput ? isPublicInput.checked : (currentSettings.isPublic !== undefined ? currentSettings.isPublic : true)
  };

  currentSettings = { ...settingsPayload };
  if (currentRoomCode) {
    socket.emit('update_settings', { settings: settingsPayload });
  }
}

function distributeSip(targetSeatIndex) {
  if (socket) {
    socket.emit('distribute_sips', { targetSeatIndex });
  }
}
window.distributeSip = distributeSip;

// --------------------------------------------------------------------------
// SITZUNGS-KASSE & GELD-MODAL (💰)
// --------------------------------------------------------------------------
function openMoneyLedgerModal() {
  const modal = document.getElementById('moneyLedgerModal');
  if (!modal) return;
  modal.classList.remove('hidden');

  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  const resetBtn = document.getElementById('resetLedgerBtn');
  if (resetBtn) {
    resetBtn.classList.toggle('hidden', !isHost);
  }

  // Aktuelle Daten vom Server abrufen
  if (socket) {
    socket.emit('get_money_ledger');
  }

  // Vorab rendern mit lokalem Stand falls vorhanden
  if (gameState) {
    renderMoneyLedgerModal({
      moneyMode: gameState.moneyMode,
      moneyStake: gameState.moneyStake,
      currentPot: gameState.currentPot,
      matchHistory: (gameState.moneyLedger && gameState.moneyLedger.matchHistory) || [],
      sessionBalances: (gameState.moneyLedger && gameState.moneyLedger.sessionBalances) || {},
      debtTransfers: []
    });
  }
}
window.openMoneyLedgerModal = openMoneyLedgerModal;

function closeMoneyLedgerModal() {
  const modal = document.getElementById('moneyLedgerModal');
  if (modal) modal.classList.add('hidden');
}
window.closeMoneyLedgerModal = closeMoneyLedgerModal;

function confirmResetMoneyLedger() {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) {
    showToast('Nur der Spielleiter kann die Kasse zurücksetzen.');
    return;
  }
  if (confirm('Möchtest du die gesamte Kasse und alle Salden für diesen Raum wirklich auf 0,00 € zurücksetzen?')) {
    if (socket) socket.emit('reset_money_ledger');
  }
}
window.confirmResetMoneyLedger = confirmResetMoneyLedger;

function renderMoneyLedgerModal(data) {
  if (!data) return;

  const stakeDisp = document.getElementById('ledgerStakeDisplay');
  const potDisp = document.getElementById('ledgerCurrentPotDisplay');
  const countDisp = document.getElementById('ledgerMatchCountDisplay');

  const stakeVal = typeof data.moneyStake === 'number' ? data.moneyStake : 5.0;
  const potVal = typeof data.currentPot === 'number' ? data.currentPot : 0.0;
  const matches = data.matchHistory || [];

  if (stakeDisp) stakeDisp.textContent = `${stakeVal.toFixed(2)} €`;
  if (potDisp) potDisp.textContent = `${potVal.toFixed(2)} €`;
  if (countDisp) countDisp.textContent = `${matches.length}`;

  // 1. Wer zahlt wem wie viel? (Minimale Ausgleichszahlungen)
  const debtContainer = document.getElementById('ledgerDebtTransfersList');
  if (debtContainer) {
    debtContainer.innerHTML = '';
    const transfers = data.debtTransfers || [];
    if (transfers.length === 0) {
      debtContainer.innerHTML = `<div class="empty-hint">Keine offenen Zahlungen fällig. Alle Salden sind ausgeglichen!</div>`;
    } else {
      transfers.forEach(t => {
        const card = document.createElement('div');
        card.className = 'debt-transfer-card';
        card.innerHTML = `
          <div class="debtor-pill">💸 <strong>${t.from}</strong></div>
          <div class="transfer-arrow">zahlt <strong>${t.amount.toFixed(2)} €</strong> an ➔</div>
          <div class="creditor-pill">📥 <strong>${t.to}</strong></div>
        `;
        debtContainer.appendChild(card);
      });
    }
  }

  // 2. Gesamt-Salden aller Teilnehmer
  const balancesGrid = document.getElementById('ledgerBalancesGrid');
  if (balancesGrid) {
    balancesGrid.innerHTML = '';
    const balances = data.sessionBalances || {};
    const names = Object.keys(balances);
    if (names.length === 0) {
      balancesGrid.innerHTML = `<div class="empty-hint">Noch keine Spieler in der Bilanz erfasst.</div>`;
    } else {
      names.sort((a, b) => balances[b] - balances[a]);
      names.forEach(name => {
        const val = balances[name];
        const card = document.createElement('div');
        card.className = `balance-card ${val > 0 ? 'pos' : (val < 0 ? 'neg' : 'zero')}`;
        card.innerHTML = `
          <div class="b-name">${name}</div>
          <div class="b-val">${val > 0 ? '+' : ''}${val.toFixed(2)} €</div>
          <div class="b-status">${val > 0 ? 'Gewinn' : (val < 0 ? 'Verlust' : 'Ausgeglichen')}</div>
        `;
        balancesGrid.appendChild(card);
      });
    }
  }

  // 3. Historie aller Partien
  const historyList = document.getElementById('ledgerMatchHistoryList');
  if (historyList) {
    historyList.innerHTML = '';
    if (matches.length === 0) {
      historyList.innerHTML = `<div class="empty-hint">Noch keine abgeschlossenen Partien in dieser Sitzung.</div>`;
    } else {
      const reversed = [...matches].reverse();
      reversed.forEach(m => {
        const item = document.createElement('div');
        item.className = 'match-history-card';
        const dateStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        item.innerHTML = `
          <div class="mh-header">
            <span class="mh-title">Partie #${m.matchNumber}</span>
            <span class="mh-time">${dateStr}</span>
          </div>
          <div class="mh-body">
            <div class="mh-winner">
              👑 Sieger: <strong>${m.winnerName}</strong> (+${m.winnerNetGain.toFixed(2)} €)
            </div>
            <div class="mh-pot">Pot: <strong>${m.pot.toFixed(2)} €</strong> (${m.participants ? m.participants.length : 0} Spieler à ${m.stake.toFixed(2)} €)</div>
          </div>
        `;
        historyList.appendChild(item);
      });
    }
  }
}
window.renderMoneyLedgerModal = renderMoneyLedgerModal;
