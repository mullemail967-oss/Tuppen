const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const {
  SUITS,
  RANKS,
  RANK_POWER,
  PICTURE_RANKS,
  isPictureCard,
  hasFourPictures,
  createDeck,
  shuffleDeck,
  isCardPlayable,
  evaluateTrick,
  canPlayerKnock,
  sortHand
} = require('./engine/tuppen-rules');

const {
  evaluateHandStrength,
  chooseCardToPlay,
  shouldBotKnock,
  shouldBotFoldOrCall,
  shouldBotDeclare4Pictures,
  shouldBotChallenge4Pictures,
  shouldBotPlayUnderPoverty
} = require('./engine/tuppen-bot-ai');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Eindeutige Build-ID pro Server-Start / Deployment (Render Git Commit oder Zeitstempel)
const APP_BUILD_ID = process.env.RENDER_GIT_COMMIT || Date.now().toString(36);
console.log(`[Version] Tuppen Server Build ID: ${APP_BUILD_ID}`);

// 1. API Route für periodisches Versions-Polling & Live-Updates
app.get('/api/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.json({ buildId: APP_BUILD_ID, timestamp: Date.now() });
});

// 2. Dynamische Auslieferung von index.html mit Cache-Busting (injiziert aktuellen APP_BUILD_ID)
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');

  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) {
      return res.status(500).send('Fehler beim Laden der Seite');
    }
    const updatedHtml = html
      .replace(/href="style\.css(\?[^"]*)?"/g, `href="style.css?v=${APP_BUILD_ID}"`)
      .replace(/src="client\.js(\?[^"]*)?"/g, `src="client.js?v=${APP_BUILD_ID}"`)
      .replace('</head>', `  <script>window.APP_BUILD_ID = "${APP_BUILD_ID}";</script>\n</head>`);

    res.send(updatedHtml);
  });
});

// Statische Dateien aus dem public-Ordner bereitstellen (ohne Caching für sofortige Updates)
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
}));

// In-Memory Raum-Verwaltung & Cooldowns
const rooms = new Map();
const joinCooldowns = new Map(); // key: `${clientIp}_${roomCode}`, value: timestamp (expiry)

// Periodische Bereinigung abgelaufener Cooldowns (alle 60 Sekunden)
setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of joinCooldowns.entries()) {
    if (expiry <= now) joinCooldowns.delete(key);
  }
}, 60000);

function getPublicRoomsData() {
  const list = [];
  for (const [code, room] of rooms.entries()) {
    const seatedPlayers = room.seats.filter(s => s !== null);
    const seatedCount = seatedPlayers.length;
    const botSeats = seatedPlayers.filter(s => s.isBot);
    const humanSeats = seatedPlayers.filter(s => !s.isBot);
    const connectedHumans = humanSeats.filter(s => s.connected).length;
    if (connectedHumans === 0) continue;
    if (room.settings && room.settings.isPublic === false) continue;

    const hostPlayer = seatedPlayers.find(s => !s.isBot && s.socketId === room.hostSocketId) || humanSeats[0];
    const hostName = hostPlayer ? hostPlayer.name : 'Spielleiter';
    const openSeats = 6 - seatedCount; // Maximale Tischanzahl ist immer 6 Plätze

    list.push({
      code,
      hostName,
      phase: room.phase,
      isMoneyMode: Boolean(room.settings && room.settings.moneyMode),
      playerCount: 6,
      activePlayers: seatedCount,
      connectedHumans,
      botCount: botSeats.length,
      openSeats,
      hasBots: botSeats.length > 0,
      canJoin: seatedCount < 6,
      spectatorCount: (room.spectators || []).length,
      roundNumber: room.roundNumber || 1,
      scores: room.scores
    });
  }
  return list;
}

function broadcastPublicRooms() {
  const data = getPublicRoomsData();
  io.emit('public_rooms_update', data);
}

function getJoinCooldownRemaining(socket, roomCode, playerName) {
  const now = Date.now();
  if (socket.joinCooldownExpiry && socket.joinCooldownExpiry > now) {
    return Math.ceil((socket.joinCooldownExpiry - now) / 1000);
  }
  if (playerName) {
    const key = `${playerName.trim().toLowerCase()}_${roomCode}`;
    const expiry = joinCooldowns.get(key);
    if (expiry && expiry > now) {
      return Math.ceil((expiry - now) / 1000);
    }
  }
  return 0;
}

function setJoinCooldown(socket, roomCode, playerName, seconds = 45) {
  const now = Date.now();
  const expiry = now + (seconds * 1000);
  socket.joinCooldownExpiry = expiry;
  if (playerName) {
    const key = `${playerName.trim().toLowerCase()}_${roomCode}`;
    joinCooldowns.set(key, expiry);
  }
}

// API-Endpunkt für aktive öffentliche Lobbys
app.get('/api/rooms', (req, res) => {
  res.json(getPublicRoomsData());
});

// Fallback-Route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Kurze Bot-Namen
const SHORT_BOT_NAMES = [
  'Max', 'Leo', 'Pit', 'Sam', 'Kai', 'Luc', 'Ben', 'Tom', 'Tim', 'Jan',
  'Pol', 'Guy', 'Dan', 'Rob', 'Marc', 'Nico', 'Finn', 'Paul', 'Noah', 'Alex',
  'Mia', 'Lea', 'Eva', 'Zoe', 'Lina', 'Emma', 'Lara', 'Sara', 'Jule', 'Nele'
];

function getRandomBotName(room) {
  const currentNames = (room && room.seats)
    ? room.seats.filter(s => s && s.name).map(s => s.name.toLowerCase().trim())
    : [];

  const available = SHORT_BOT_NAMES.filter(n => {
    const lower = n.toLowerCase();
    return !currentNames.includes(`bot ${lower}`) && !currentNames.includes(lower);
  });

  const pool = available.length > 0 ? available : SHORT_BOT_NAMES;
  const picked = pool[Math.floor(Math.random() * pool.length)];
  return `Bot ${picked}`;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

/**
 * Erstellt ein neues Raum-Objekt für Tuppen.
 */
function createRoom(roomCode, hostName, hostSocketId, initialSettings) {
  const room = {
    code: roomCode,
    hostSocketId: hostSocketId,
    createdAt: Date.now(),
    seats: [
      { index: 0, name: hostName || 'Spieler 1', socketId: hostSocketId, isBot: false, connected: true },
      null,
      null,
      null,
      null,
      null
    ],
    settings: {
      playerCount: 4,               // Standard bei Start (2 bis 6 dynamisch)
      initialLives: 7,              // Standard 7 Leben (einstellbar z. B. 5, 7, 10, 12)
      maxPenalty: 7,                // Alias für Rückwärtskompatibilität
      allowKloepper: true,          // Klöpper-Regel (wenn genau 1 Leben übrig)
      allowPoverty: true,           // Alias
      kloepperStakeMode: 'fixed',   // 'fixed' (immer 2) oder 'per_player' (+1 pro Klöpper)
      allowFourPictures: true,      // 4 Bilder tauschen erlaubt
      fourPicturesCooldownSeconds: 5, // Bedenkzeit nach 4-Bilder Ansage (0 bis 10 Sek., Standard 5)
      allowBlindKnock: true,        // Blindklopfen vor Stich 1 erlaubt
      trickDisplaySeconds: 2.5,     // Anzeigedauer des fertigen Stichs
      dealAndTurnDelaySeconds: 1.0, // Pause bei Bot-Zügen
      isPublic: true,               // Öffentliche Lobby
      drinkingMode: 'off',          // 'off', 'mild', 'medium', 'extreme' (Trinkspielmodus Stufen)
      moneyMode: false,             // Spielen um Geld (Echtgeld-Abrechnung)
      moneyStake: 5.0,              // Einsatz pro Partie in Euro (z.B. 1, 2, 5, 10, 20)
      ...(initialSettings || {})
    },
    scores: [7, 7, 7, 7, 7, 7],     // Aktuelle Leben pro Spieler (Standard 7)
    eliminated: [false, false, false, false, false, false], // Wer ausgeschieden ist
    previouslyEliminated: [false, false, false, false, false, false], // Stand vor Rundenbeginn
    foldedThisRound: [false, false, false, false, false, false], // In dieser Runde gepasst
    dealerIndex: 0,                 // Gewinner der Vorrunde gibt die Karten
    phase: 'LOBBY',                 // LOBBY, POVERTY_CHECK, KNOCK_DECISION, PLAY_TRICK, EVALUATING_TRICK, ROUND_END, GAME_OVER
    roundNumber: 0,
    roundEndNextRoundLockedUntil: 0, // Sperrfrist für Weiter-Button bei Trinkspiel
    drinkingIncidents: [],          // Bluff- und Challenge-Vorfälle dieser Runde
    currentStake: 1,                // Aktueller Rundeneinsatz (1, 2, 3...)
    lastKnocker: null,              // Wer hat zuletzt geklopft
    knockerIndex: null,             // Wer hat in dieser Klopf-Sequenz geklopft
    pendingKnockQueue: [],          // Wer muss auf Klopfen reagieren
    pendingPovertyQueue: [],        // Wer muss in der Klöpper-Phase reagieren
    fourPicturesStacks: [],         // Abgelegte 4-Bilder-Stapel dieser Runde
    fourPicturesLockUntil: 0,       // Ausspielsperre / Bedenkzeit-Timestamp
    nextFourPicturesStackId: 1,
    fourPicturesDeclarer: null,     // Legacy-Alias
    fourPicturesLaidCards: null,
    pendingFourPicturesQueue: [],   // Wer darf prüfen
    spectators: [],                 // [{ socketId, name, joinedAt }] - Zuschauer im Geldspiel
    moneyLedger: {                  // Fortlaufende Kasse über mehrere Partien
      sessionBalances: {},          // { [playerName]: number } - Salden (+/- Euro)
      matchHistory: [],             // Gespielte Geldpartien
      currentMatchParticipants: []  // Teilnehmer der aktuellen Partie
    },
    deck: [],
    hands: [[], [], [], [], [], []],
    stock: [],
    currentTrick: [],               // [{ playerIndex, card, playerName }]
    currentTurn: 0,
    trickCount: 0,                  // 0 bis 4 Stiche
    tricksWon: [0, 0, 0, 0, 0, 0],
    lastTrick: null,
    trickWinnerInfo: null,
    roundSummary: null,
    roundEndAutoUntil: 0,
    nextRoundAutoTimer: null,
    actionLog: [`Raum ${roomCode} erstellt durch ${hostName}.`],
    chatMessages: [],
    botTimer: null
  };
  return room;
}

/**
 * Berechnet die minimale Anzahl von Ausgleichszahlungen (Schulden-Minimierung / Optimal Debt Settlement)
 * basierend auf den Netto-Salden aller Teilnehmer.
 * @param {Object} sessionBalances - { [playerName]: number }
 * @returns {Array<{ from: string, to: string, amount: number }>}
 */
function calculateDebtSettlement(sessionBalances) {
  const creditors = []; // Haben Guthaben (bekommen Geld)
  const debtors = [];   // Haben Schulden (müssen zahlen)

  for (const [name, rawBal] of Object.entries(sessionBalances || {})) {
    const bal = Math.round(rawBal * 100) / 100;
    if (bal > 0.009) {
      creditors.push({ name, amount: bal });
    } else if (bal < -0.009) {
      debtors.push({ name, amount: -bal }); // Positiver Betrag zum Abbuchen
    }
  }

  // Sortiere absteigend nach Betrag für optimale Paarung
  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const transactions = [];
  let cIdx = 0;
  let dIdx = 0;

  while (cIdx < creditors.length && dIdx < debtors.length) {
    const creditor = creditors[cIdx];
    const debtor = debtors[dIdx];
    const transferAmount = Math.min(creditor.amount, debtor.amount);
    const roundedTransfer = Math.round(transferAmount * 100) / 100;

    if (roundedTransfer > 0.009) {
      transactions.push({
        from: debtor.name,
        to: creditor.name,
        amount: roundedTransfer
      });
    }

    creditor.amount = Math.round((creditor.amount - roundedTransfer) * 100) / 100;
    debtor.amount = Math.round((debtor.amount - roundedTransfer) * 100) / 100;

    if (creditor.amount <= 0.009) cIdx++;
    if (debtor.amount <= 0.009) dIdx++;
  }

  return transactions;
}

function logAction(room, message) {
  room.actionLog.push(message);
  if (room.actionLog.length > 50) {
    room.actionLog.shift();
  }
}

/**
 * Befördert wartende Zuschauer auf freie Plätze (bis maximal 6 Spieler am Tisch).
 * Weist Startleben zu, initialisiert Hände und aktualisiert die Geldspiel-Teilnehmer.
 */
function promoteWaitingSpectators(room) {
  if (!room || !room.spectators || room.spectators.length === 0) return false;

  let promotedCount = 0;
  const startLives = (room.settings && (room.settings.initialLives || room.settings.maxPenalty)) || 7;

  // Suche nach freien Sitzen (0 bis 5)
  for (let i = 0; i < 6 && room.spectators.length > 0; i++) {
    if (!room.seats[i]) {
      const spec = room.spectators.shift();
      room.seats[i] = {
        index: i,
        name: spec.name,
        socketId: spec.socketId,
        isBot: false,
        connected: true
      };
      room.scores[i] = startLives;
      room.eliminated[i] = false;
      room.foldedThisRound[i] = false;
      room.hands[i] = [];
      room.tricksWon[i] = 0;

      const specSocket = io.sockets.sockets.get(spec.socketId);
      if (specSocket) {
        specSocket.roomCode = room.code;
        specSocket.seatIndex = i;
        specSocket.currentRoomCode = room.code;
        specSocket.currentSeatIndex = i;
        specSocket.emit('spectator_promoted_to_player', { seatIndex: i, roomCode: room.code });
      }
      logAction(room, `👥 Zuschauer ${spec.name} steigt als aktiver Spieler auf Platz ${i + 1} ein!`);
      promotedCount++;
    }
  }

  if (promotedCount > 0) {
    const seatedPlayers = room.seats.filter(s => s !== null);
    room.settings.playerCount = seatedPlayers.length;

    // Geldspiel-Aktualisierung
    if (room.settings && room.settings.moneyMode) {
      if (!room.moneyLedger) {
        room.moneyLedger = { sessionBalances: {}, matchHistory: [], currentMatchParticipants: [] };
      }
      room.moneyLedger.currentMatchParticipants = seatedPlayers.map(s => s.name);
      for (const pName of room.moneyLedger.currentMatchParticipants) {
        if (typeof room.moneyLedger.sessionBalances[pName] !== 'number') {
          room.moneyLedger.sessionBalances[pName] = 0;
        }
      }
      const stakeVal = (typeof room.settings.moneyStake === 'number') ? room.settings.moneyStake : 5.0;
      logAction(room, `💰 Kasse aktualisiert: ${seatedPlayers.length} Spieler um je ${stakeVal.toFixed(2)} € (Pot: ${(seatedPlayers.length * stakeVal).toFixed(2)} €).`);
    }
    return true;
  }
  return false;
}

/**
 * Ermittelt, ob ein Spieler noch im Spiel ist (Leben > 0 und nicht eliminiert).
 */
function isPlayerAlive(room, playerIndex) {
  if (playerIndex < 0 || playerIndex >= 6) return false;
  const seat = room.seats[playerIndex];
  if (!seat) return false;
  return !room.eliminated[playerIndex] && (room.scores[playerIndex] > 0);
}

/**
 * Ermittelt alle aktuell noch im Gesamtspiel befindlichen Spieler (< 10 Strafpunkte).
 */
function getAlivePlayers(room) {
  const list = [];
  for (let i = 0; i < 6; i++) {
    if (isPlayerAlive(room, i)) list.push(i);
  }
  return list;
}

/**
 * Ermittelt alle Spieler, die in der aktuellen Runde aktiv mitspielen (nicht gepasst).
 */
function getActiveRoundPlayers(room) {
  const alive = getAlivePlayers(room);
  return alive.filter(i => !room.foldedThisRound[i]);
}

/**
 * Findet den nächsten lebendigen Spieler im Uhrzeigersinn.
 */
function getNextAlivePlayerIndex(room, fromIndex) {
  const seatedIndices = [];
  for (let i = 0; i < 6; i++) {
    if (room.seats[i] !== null) seatedIndices.push(i);
  }
  if (seatedIndices.length === 0) return 0;

  let currentPos = seatedIndices.indexOf(fromIndex);
  if (currentPos === -1) currentPos = 0;
  for (let step = 1; step <= seatedIndices.length; step++) {
    const idx = seatedIndices[(currentPos + step) % seatedIndices.length];
    if (isPlayerAlive(room, idx)) return idx;
  }
  return fromIndex;
}

/**
 * Findet den nächsten in dieser Runde aktiven Spieler im Uhrzeigersinn.
 */
function getNextActivePlayerIndex(room, fromIndex) {
  const seatedIndices = [];
  for (let i = 0; i < 6; i++) {
    if (room.seats[i] !== null) seatedIndices.push(i);
  }
  if (seatedIndices.length === 0) return 0;

  let currentPos = seatedIndices.indexOf(fromIndex);
  if (currentPos === -1) currentPos = 0;
  for (let step = 1; step <= seatedIndices.length; step++) {
    const idx = seatedIndices[(currentPos + step) % seatedIndices.length];
    if (isPlayerAlive(room, idx) && !room.foldedThisRound[idx] && (room.hands[idx] && room.hands[idx].length > 0)) {
      return idx;
    }
  }
  return fromIndex;
}

/**
 * Findet den nächsten in dieser Runde aktiven Spieler im Uhrzeigersinn,
 * der im aktuellen Stich NOCH KEINE Karte gelegt hat.
 */
function getNextTrickPlayerIndex(room, fromIndex) {
  const seatedIndices = [];
  for (let i = 0; i < 6; i++) {
    if (room.seats[i] !== null) seatedIndices.push(i);
  }
  if (seatedIndices.length === 0) return 0;

  const alreadyPlayedSet = new Set(room.currentTrick.map(e => e.playerIndex));
  let currentPos = seatedIndices.indexOf(fromIndex);
  if (currentPos === -1) currentPos = 0;
  for (let step = 1; step <= seatedIndices.length; step++) {
    const idx = seatedIndices[(currentPos + step) % seatedIndices.length];
    if (isPlayerAlive(room, idx) && !room.foldedThisRound[idx] && !alreadyPlayedSet.has(idx)) {
      return idx;
    }
  }
  return fromIndex;
}

/**
 * Filtert sensible Kartendaten für den jeweiligen Client.
 */
function sanitizeStateForPlayer(room, seatIndex) {
  let activeHost = room.seats.find(s => s && !s.isBot && s.socketId && s.socketId === room.hostSocketId && s.connected !== false);
  if (!activeHost) {
    const nextHuman = room.seats.find(s => s && !s.isBot && s.socketId && s.connected !== false);
    if (nextHuman) {
      room.hostSocketId = nextHuman.socketId;
    }
  }

  const maxPlayers = room.settings.playerCount || 4;
  const maxLives = room.settings.initialLives || room.settings.maxPenalty || 7;
  const isKloepperAllowed = room.settings.allowKloepper !== false && room.settings.allowPoverty !== false;
  const isBlindKnockAllowed = room.settings.allowBlindKnock !== false;
  const isFourPicsAllowed = room.settings.allowFourPictures !== false;
  const activeRoundPlayers = getActiveRoundPlayers(room);

  const playersInfo = room.seats.map((seat, idx) => {
    if (!seat) return null;
    const currentLives = (room.scores[idx] !== undefined) ? room.scores[idx] : maxLives;
    const isKloepper = (currentLives === 1);
    return {
      index: idx,
      name: seat.name,
      score: currentLives,
      eliminated: Boolean(room.eliminated[idx]),
      folded: Boolean(room.foldedThisRound[idx]),
      isArm: Boolean(isKloepperAllowed && isKloepper),
      isKloepper: Boolean(isKloepperAllowed && isKloepper),
      isBot: seat.isBot,
      connected: seat.connected,
      cardCount: room.hands[idx] ? room.hands[idx].length : 0,
      isDealer: room.dealerIndex === idx,
      isTurn: room.currentTurn === idx,
      isHost: (seat.socketId === room.hostSocketId),
      hasKnocked: room.lastKnocker === idx
    };
  });

  const isSpectator = (seatIndex === -1);
  const myHand = (!isSpectator && room.hands[seatIndex]) ? [...room.hands[seatIndex]] : [];

  // Berechne spielbare Karten für den Spieler
  const playableMap = {};
  if (!isSpectator && room.phase === 'PLAY_TRICK' && room.currentTurn === seatIndex) {
    for (const card of myHand) {
      playableMap[card.id] = isCardPlayable(card, myHand, room.currentTrick);
    }
  }

  const isMeHost = (!isSpectator && room.seats[seatIndex] && room.seats[seatIndex].socketId === room.hostSocketId);
  const isKnockDecisionTurn = (!isSpectator && room.phase === 'KNOCK_DECISION' && (room.pendingKnockQueue || []).includes(seatIndex));
  const isPovertyDecisionTurn = (!isSpectator && room.phase === 'POVERTY_CHECK' && (room.pendingPovertyQueue || []).includes(seatIndex));
  const canKnockNow = !isSpectator && (
    (room.phase === 'PLAY_TRICK' && (isBlindKnockAllowed || room.trickCount > 0)) ||
    isKnockDecisionTurn
  ) && canPlayerKnock(room.scores, activeRoundPlayers, room.currentStake, seatIndex, room.lastKnocker);

  const hasRealFourPics = !isSpectator && hasFourPictures(myHand);
  const hasPlayedInTrick1 = Boolean(!isSpectator && room.currentTrick && room.currentTrick.some(e => e.playerIndex === seatIndex));
  const canDeclare4Pic = !isSpectator && (
    (room.phase === 'PLAY_TRICK' || room.phase === 'KNOCK_DECISION' || room.phase === 'POVERTY_CHECK') &&
    room.trickCount === 0 &&
    !hasPlayedInTrick1 &&
    myHand.length === 4 &&
    isFourPicsAllowed &&
    !room.eliminated[seatIndex] &&
    !room.foldedThisRound[seatIndex] &&
    (room.stock && room.stock.length >= 4)
  );

  const isTrick1 = (room.trickCount === 0);

  const fourPicsStacks = isTrick1 ? (room.fourPicturesStacks || []).filter(st => {
    if (room.phase === 'FOUR_PICTURES_REVEAL' && st.isRevealed) return true;
    const declarerPlayed = (room.currentTrick || []).some(e => e.playerIndex === st.declarerIndex);
    return !declarerPlayed && !st.isRevealed;
  }).map(st => ({
    id: st.id,
    declarerIndex: st.declarerIndex,
    declarerName: st.declarerName,
    cardCount: 4,
    isRevealed: st.isRevealed,
    revealedCards: st.isRevealed ? st.cards : null,
    isGenuine: st.isGenuine,
    challengerIndex: st.challengerIndex,
    challengerName: st.challengerName,
    canChallenge: (
      !isSpectator &&
      room.phase !== 'FOUR_PICTURES_REVEAL' &&
      !st.isRevealed &&
      st.declarerIndex !== seatIndex &&
      !room.foldedThisRound[seatIndex] &&
      !room.eliminated[seatIndex] &&
      room.trickCount === 0 &&
      !(room.currentTrick || []).some(e => e.playerIndex === st.declarerIndex)
    )
  })) : [];

  const isPlayLockActive = Boolean(
    room.fourPicturesLockUntil &&
    Date.now() < room.fourPicturesLockUntil &&
    room.trickCount === 0
  );

  const stakeAmount = (room.settings && typeof room.settings.moneyStake === 'number') ? room.settings.moneyStake : 5.0;
  const matchParts = (room.moneyLedger && room.moneyLedger.currentMatchParticipants) ? room.moneyLedger.currentMatchParticipants : [];
  const currentPot = (matchParts.length > 0) ? Math.round(matchParts.length * stakeAmount * 100) / 100 : 0;

  return {
    roomCode: room.code,
    phase: room.phase,
    settings: room.settings,
    roundNumber: room.roundNumber,
    scores: room.scores,
    eliminated: room.eliminated,
    foldedThisRound: room.foldedThisRound,
    dealerIndex: room.dealerIndex,
    currentStake: room.currentStake,
    lastKnocker: room.lastKnocker,
    knockerIndex: room.knockerIndex,
    currentTrick: room.currentTrick,
    currentTurn: room.currentTurn,
    trickCount: room.trickCount,
    lastTrick: room.lastTrick,
    trickWinnerInfo: room.trickWinnerInfo,
    roundSummary: room.roundSummary,
    roundEndAutoUntil: room.roundEndAutoUntil || 0,
    roundEndAutoRemainingSec: (room.phase === 'ROUND_END' && room.roundEndAutoUntil && room.roundEndAutoUntil > Date.now())
      ? Math.max(0, Math.ceil((room.roundEndAutoUntil - Date.now()) / 1000))
      : 0,
    nextRoundLockedUntil: room.roundEndNextRoundLockedUntil || 0,
    nextRoundLockedRemainingSec: (room.phase === 'ROUND_END' && room.roundEndNextRoundLockedUntil && room.roundEndNextRoundLockedUntil > Date.now())
      ? Math.max(0, Math.ceil((room.roundEndNextRoundLockedUntil - Date.now()) / 1000))
      : 0,
    actionLog: room.actionLog,
    chatMessages: room.chatMessages,
    players: playersInfo,
    fourPicturesStacks: fourPicsStacks,
    fourPicturesLockUntil: room.fourPicturesLockUntil || 0,
    fourPicturesTablePile: (isTrick1 && room.phase === 'FOUR_PICTURES_REVEAL' && room.fourPicturesTablePile) ? {
      declarerIndex: room.fourPicturesTablePile.declarerIndex,
      cardCount: room.fourPicturesTablePile.cardCount,
      isRevealed: room.fourPicturesTablePile.isRevealed,
      revealedCards: room.fourPicturesTablePile.isRevealed ? room.fourPicturesTablePile.revealedCards : null,
      challengerIndex: room.fourPicturesTablePile.challengerIndex,
      challengerName: room.fourPicturesTablePile.challengerName,
      isGenuine: room.fourPicturesTablePile.isGenuine
    } : null,
    moneyMode: Boolean(room.settings && room.settings.moneyMode),
    moneyStake: stakeAmount,
    currentPot: currentPot,
    moneyLedger: room.moneyLedger ? {
      sessionBalances: { ...(room.moneyLedger.sessionBalances || {}) },
      matchCount: (room.moneyLedger.matchHistory || []).length,
      currentMatchParticipants: [...(room.moneyLedger.currentMatchParticipants || [])]
    } : null,
    spectatorCount: (room.spectators || []).length,
    spectators: (room.spectators || []).map(s => ({ name: s.name })),
    you: {
      isSpectator: isSpectator,
      seatIndex: seatIndex,
      isHost: isMeHost,
      hand: myHand,
      playableMap: playableMap,
      score: (!isSpectator && room.scores[seatIndex] !== undefined) ? room.scores[seatIndex] : (isSpectator ? null : maxLives),
      eliminated: !isSpectator ? Boolean(room.eliminated[seatIndex]) : false,
      folded: !isSpectator ? Boolean(room.foldedThisRound[seatIndex]) : false,
      isArm: !isSpectator ? Boolean(isKloepperAllowed && room.scores[seatIndex] === 1) : false,
      isKloepper: !isSpectator ? Boolean(isKloepperAllowed && room.scores[seatIndex] === 1) : false,
      canKnock: canKnockNow,
      canDeclare4Pictures: canDeclare4Pic,
      hasRealFourPictures: hasRealFourPics,
      canChallengeLaidPile: fourPicsStacks.some(st => st.canChallenge),
      fourPicturesLockActive: isPlayLockActive,
      fourPicturesLockRemainingSec: isPlayLockActive ? Math.ceil((room.fourPicturesLockUntil - Date.now()) / 1000) : 0,
      isKnockDecisionTurn: isKnockDecisionTurn,
      isPovertyDecisionTurn: isPovertyDecisionTurn,
      isFourPicturesChallengeTurn: false // Kein blockierender Abfragedialog mehr!
    }
  };
}

function broadcastGameState(room) {
  const totalSeats = room.seats.length;
  for (let i = 0; i < totalSeats; i++) {
    const seat = room.seats[i];
    if (seat && !seat.isBot && seat.socketId) {
      const clientPayload = sanitizeStateForPlayer(room, i);
      io.to(seat.socketId).emit('game_state', clientPayload);
    }
  }
  if (room.spectators && room.spectators.length > 0) {
    for (const spec of room.spectators) {
      if (spec && spec.socketId) {
        const specPayload = sanitizeStateForPlayer(room, -1);
        specPayload.you.isHost = (spec.socketId === room.hostSocketId);
        io.to(spec.socketId).emit('game_state', specPayload);
      }
    }
  }
}

function isPlayerHost(room, socket) {
  if (!room || !socket) return false;
  if (room.hostSocketId && socket.id === room.hostSocketId) return true;
  const currentHost = room.seats.find(s => s && !s.isBot && s.socketId && s.socketId === room.hostSocketId && s.connected !== false);
  if (!currentHost) {
    const nextHuman = room.seats.find(s => s && !s.isBot && s.socketId && s.connected !== false);
    if (nextHuman) {
      room.hostSocketId = nextHuman.socketId;
      return nextHuman.socketId === socket.id;
    }
  }
  return false;
}

/**
 * Startet eine neue Tuppen-Runde (4 Karten pro lebendigem Spieler).
 */
function startNewRound(room) {
  const seatedCount = room.seats.filter(s => s !== null).length;
  room.settings.playerCount = Math.max(2, seatedCount);

  // Prüfen, ob nur noch 1 Spieler lebt (< 10 Strafpunkte)
  const alivePlayers = getAlivePlayers(room);
  if (alivePlayers.length <= 1) {
    room.phase = 'GAME_OVER';
    broadcastGameState(room);
    return;
  }

  if (room.nextRoundAutoTimer) {
    clearTimeout(room.nextRoundAutoTimer);
    room.nextRoundAutoTimer = null;
  }
  room.roundEndAutoUntil = 0;
  room.roundEndNextRoundLockedUntil = 0;
  room.drinkingIncidents = [];
  room.previouslyEliminated = [...room.eliminated];

  room.roundNumber++;
  room.currentTrick = [];
  room.trickCount = 0;
  room.currentStake = 1;
  room.lastKnocker = null;
  room.knockerIndex = null;
  room.pendingKnockQueue = [];
  room.pendingPovertyQueue = [];
  room.fourPicturesStacks = [];
  room.fourPicturesLockUntil = 0;
  room.nextFourPicturesStackId = 1;
  room.fourPicturesDeclarer = null;
  room.fourPicturesLaidCards = null;
  room.fourPicturesTablePile = null;
  room.phaseBeforeFourPics = null;
  room.savedTurnBeforeFourPics = null;
  room.pendingFourPicturesQueue = [];
  room.lastTrick = null;
  room.trickWinnerInfo = null;
  room.roundSummary = null;

  // Status "In Runde gepasst" für alle Lebenden zurücksetzen
  room.foldedThisRound = Array(6).fill(false);
  for (let i = 0; i < 6; i++) {
    if (!room.seats[i] || room.eliminated[i]) room.foldedThisRound[i] = true;
  }

  // 32-Karten Piquet-Deck mischen
  const freshDeck = shuffleDeck(createDeck());
  room.deck = freshDeck;

  // Genau 4 Karten an jeden noch aktiven Spieler einzeln austeilen
  room.hands = Array(6).fill(null).map(() => []);
  let deckPtr = 0;
  for (let cardNum = 0; cardNum < 4; cardNum++) {
    for (let s = 0; s < 6; s++) {
      if (isPlayerAlive(room, s)) {
        room.hands[s].push(freshDeck[deckPtr++]);
      }
    }
  }

  // Hände sortieren
  for (let s = 0; s < 6; s++) {
    if (room.hands[s] && room.hands[s].length > 0) {
      sortHand(room.hands[s]);
    }
  }

  // Restliche Karten verbleiben im Stock (für 4-Bilder-Tausch)
  room.stock = freshDeck.slice(deckPtr);

  // Der Geber ist der Gewinner der letzten Runde (oder Platz 0 bei Start)
  if (!isPlayerAlive(room, room.dealerIndex)) {
    room.dealerIndex = getNextAlivePlayerIndex(room, room.dealerIndex);
  }

  // Erster Ausspieler ist der nächste lebendige Spieler links vom Geber
  const firstLead = getNextAlivePlayerIndex(room, room.dealerIndex);
  room.currentTurn = firstLead;

  const dealerName = room.seats[room.dealerIndex] ? room.seats[room.dealerIndex].name : `Spieler ${room.dealerIndex + 1}`;
  const leadName = room.seats[firstLead] ? room.seats[firstLead].name : `Spieler ${firstLead + 1}`;

  logAction(room, `--- Runde ${room.roundNumber} beginnt --- Geber: ${dealerName}`);
  logAction(room, `Jeder aktive Spieler erhält 4 Karten (${room.stock.length} Karten im Stock).`);

  // KLÖPPER PRÜFEN: Hat ein aktiver Spieler genau 1 Leben übrig?
  const allowKloepper = room.settings.allowKloepper !== false && room.settings.allowPoverty !== false;
  const kloepperPlayers = allowKloepper ? alivePlayers.filter(idx => room.scores[idx] === 1) : [];

  if (kloepperPlayers.length > 0) {
    const kloepperNames = kloepperPlayers.map(idx => room.seats[idx].name).join(', ');
    let kloepperStake = 2;
    if (room.settings.kloepperStakeMode === 'per_player') {
      kloepperStake = 1 + kloepperPlayers.length;
    }
    room.currentStake = kloepperStake;

    logAction(room, `🔨 AM KLÖPPER! ${kloepperNames} hat nur noch 1 Leben! Einsatz startet bei ${kloepperStake} Leben.`);
    logAction(room, `Mitspieler mit mehr als 1 Leben müssen entscheiden: Mitgehen (${kloepperStake} Leben Risiko) oder Passen (1 Leben Verlust).`);

    // Alle Spieler mit > 1 Leben befragen (Klöpper-Spieler gehen automatisch mit!)
    room.pendingPovertyQueue = alivePlayers.filter(idx => room.scores[idx] > 1);

    if (room.pendingPovertyQueue.length > 0) {
      room.phase = 'POVERTY_CHECK';
      room.currentTurn = room.pendingPovertyQueue[0];
    } else {
      // Alle verbleibenden Spieler stehen am Klöpper
      room.phase = 'PLAY_TRICK';
      logAction(room, `Alle aktiven Spieler stehen am Klöpper! Showdown beginnt.`);
    }
  } else {
    room.currentStake = 1;
    room.phase = 'PLAY_TRICK';
    logAction(room, `${leadName} spielt zum 1. Stich aus.`);
  }

  broadcastGameState(room);
  checkBotAction(room);
}

/**
 * Führt das Ausspielen einer Karte aus.
 */
function handleCardPlay(room, playerIndex, cardId) {
  if (room.phase !== 'PLAY_TRICK') return;
  if (room.currentTurn !== playerIndex) return;

  // 4-Bilder Bedenkzeit prüfen (in Stich 1 kann niemand während des Cooldowns legen)
  if (room.fourPicturesLockUntil && Date.now() < room.fourPicturesLockUntil && room.trickCount === 0) {
    const seat = room.seats[playerIndex];
    if (seat && !seat.isBot && seat.socketId) {
      const remainingSec = Math.ceil((room.fourPicturesLockUntil - Date.now()) / 1000);
      const socket = io.sockets.sockets.get(seat.socketId);
      if (socket) socket.emit('error_message', `Bedenkzeit für 4 Bilder läuft noch (${remainingSec}s)...`);
    }
    return;
  }

  const playerHand = room.hands[playerIndex];
  if (!playerHand) return;
  const cardIndex = playerHand.findIndex(c => c.id === cardId);
  if (cardIndex === -1) return;

  const card = playerHand[cardIndex];

  // Stichregel prüfen (Farbzwang)
  if (!isCardPlayable(card, playerHand, room.currentTrick)) return;

  // Karte aus Hand entfernen und in Stich legen
  playerHand.splice(cardIndex, 1);
  const playerName = room.seats[playerIndex].name;
  room.currentTrick.push({
    playerIndex,
    card,
    playerName
  });

  // Sobald ein Spieler eine Karte legt, verschwinden seine unaufgedeckten 4-Bilder Stapel!
  if (room.trickCount === 0 && room.fourPicturesStacks && room.fourPicturesStacks.length > 0) {
    room.fourPicturesStacks = room.fourPicturesStacks.filter(st => st.declarerIndex !== playerIndex);
  }

  const suitIcons = { clubs: '♣', spades: '♠', hearts: '♥', diamonds: '♦' };
  const cardDisplay = `${suitIcons[card.suit]}${card.rank}`;
  logAction(room, `${playerName} spielt ${cardDisplay}`);

  // Prüfen, ob alle in dieser Runde noch aktiven Spieler in diesem Stich gelegt haben
  const activeRoundPlayers = getActiveRoundPlayers(room);
  const activePlayedCount = activeRoundPlayers.filter(idx => 
    room.currentTrick.some(e => e.playerIndex === idx)
  ).length;

  if (activePlayedCount >= activeRoundPlayers.length && activeRoundPlayers.length > 0) {
    triggerTrickEvaluation(room);
  } else {
    room.currentTurn = getNextTrickPlayerIndex(room, room.currentTurn);
    broadcastGameState(room);
    checkBotAction(room);
  }
}

/**
 * Leitet die Auswertung eines abgeschlossenen Stichs ein.
 */
function triggerTrickEvaluation(room) {
  room.phase = 'EVALUATING_TRICK';

  const foldedIndices = [];
  for (let i = 0; i < 6; i++) {
    if (room.foldedThisRound[i]) foldedIndices.push(i);
  }

  // WICHTIG: Gepasste Spieler können den Stich NIEMALS gewinnen!
  const result = evaluateTrick(room.currentTrick, foldedIndices);
  const winnerIndex = result.winnerIndex;
  const winnerName = room.seats[winnerIndex].name;

  room.trickWinnerInfo = {
    winnerIndex,
    winnerName,
    winningCard: result.winningCard
  };

  room.lastTrick = {
    trickNumber: room.trickCount + 1,
    cards: [...room.currentTrick],
    winnerIndex,
    winnerName,
    winningCard: result.winningCard
  };

  broadcastGameState(room);

  const trickDelay = (room.settings && typeof room.settings.trickDisplaySeconds === 'number')
    ? room.settings.trickDisplaySeconds * 1000
    : 2500;

  setTimeout(() => {
    resolveTrick(room, result);
  }, trickDelay);
}

/**
 * Wertet den Stich nach der Pause aus.
 */
function resolveTrick(room, result) {
  const winnerIndex = result.winnerIndex;
  const winnerName = room.seats[winnerIndex].name;

  room.trickCount++;
  if (room.trickCount >= 1) {
    room.fourPicturesStacks = [];
    room.fourPicturesTablePile = null;
  }
  room.tricksWon[winnerIndex]++;
  room.currentTrick = [];
  room.trickWinnerInfo = null;

  const suitIcons = { clubs: '♣', spades: '♠', hearts: '♥', diamonds: '♦' };
  const winCardDisplay = `${suitIcons[result.winningCard.suit]}${result.winningCard.rank}`;
  logAction(room, `🏆 Stich #${room.trickCount} geht an ${winnerName} (${winCardDisplay})`);

  // Wenn der 4. Stich gespielt wurde (oder niemand mehr Karten hat): RUNDENENDE!
  if (room.trickCount === 4) {
    resolveRound(room, winnerIndex);
  } else {
    // Stichgewinner spielt zum nächsten Stich aus
    room.currentTurn = winnerIndex;
    room.phase = 'PLAY_TRICK';
    broadcastGameState(room);
    checkBotAction(room);
  }
}

/**
 * Berechnet die Trinkaufgaben (Schlücke) für das Rundenende.
 * Nur aktiv, wenn room.settings.drinkingMode !== 'off'.
 * Stufen: 'mild' (Leicht), 'medium' (Mittel), 'extreme' (Schwer).
 */
function calculateDrinkingTasks(room, roundSummary) {
  const mode = room.settings.drinkingMode || 'off';
  if (mode === 'off') return null;

  const winnerIndex = roundSummary.winnerIndex;

  // Multiplikatoren je nach Modus
  const multPerLife = (mode === 'mild') ? 1 : (mode === 'medium') ? 2 : 3;
  const foldSips = (mode === 'mild') ? 1 : (mode === 'medium') ? 2 : 3;
  const bluffSips = (mode === 'mild') ? 1 : (mode === 'medium') ? 2 : 3;
  const wrongChallengeSips = (mode === 'mild') ? 1 : (mode === 'medium') ? 2 : 3;
  const elimSips = (mode === 'mild') ? 2 : (mode === 'medium') ? 4 : 6;
  const winnerDistribute = (mode === 'mild') ? 1 : (mode === 'medium') ? 2 : 3;

  const incidents = room.drinkingIncidents || [];

  const tasks = [];
  for (let i = 0; i < 6; i++) {
    const seat = room.seats[i];
    if (!seat) continue;

    const isWinner = (i === winnerIndex);
    const oldScore = roundSummary.oldScores ? roundSummary.oldScores[i] : 0;
    const newScore = roundSummary.newScores ? roundSummary.newScores[i] : 0;
    const livesLost = Math.max(0, oldScore - newScore);
    const wasFolded = Boolean(room.foldedThisRound && room.foldedThisRound[i]);
    const newlyEliminated = Boolean(roundSummary.eliminated && roundSummary.eliminated[i] && (!room.previouslyEliminated || !room.previouslyEliminated[i]));

    let sipsToDrink = 0;
    let sipsToDistribute = 0;
    const reasons = [];

    if (isWinner) {
      sipsToDistribute = winnerDistribute;
      reasons.push(`👑 Rundensieg: Darf ${winnerDistribute} Schluck${winnerDistribute > 1 ? 'e' : ''} verteilen!`);
    } else {
      if (wasFolded) {
        sipsToDrink += foldSips;
        reasons.push(`🚪 Gekniffen/Gepasst: ${foldSips} Schluck${foldSips > 1 ? 'e' : ''}`);
      } else if (livesLost > 0) {
        const lifeSips = livesLost * multPerLife;
        sipsToDrink += lifeSips;
        reasons.push(`💔 -${livesLost} Leben: ${lifeSips} Schluck${lifeSips > 1 ? 'e' : ''}`);
      }

      // Prüfungs-Vorfälle (Bluffs und unberechtigte Challenges)
      const bluffs = incidents.filter(inc => inc.type === 'BLUFF_CAUGHT' && inc.playerIndex === i).length;
      if (bluffs > 0) {
        const bSips = bluffs * bluffSips;
        sipsToDrink += bSips;
        reasons.push(`🚨 4-Bilder-Bluff erwischt: +${bSips} Schluck${bSips > 1 ? 'e' : ''}`);
      }

      const wrongChallenges = incidents.filter(inc => inc.type === 'WRONG_CHALLENGE' && inc.playerIndex === i).length;
      if (wrongChallenges > 0) {
        const wcSips = wrongChallenges * wrongChallengeSips;
        sipsToDrink += wcSips;
        reasons.push(`🔍 Echte 4 Bilder angezweifelt: +${wcSips} Schluck${wcSips > 1 ? 'e' : ''}`);
      }

      if (newlyEliminated) {
        sipsToDrink += elimSips;
        reasons.push(`💀 Ausgeschieden: +${elimSips} Schluck${elimSips > 1 ? 'e' : ''}`);
      }
    }

    tasks.push({
      playerIndex: i,
      playerName: seat.name,
      isWinner,
      sipsToDrink,
      sipsToDistribute,
      distributedSips: 0,
      receivedDistributedSips: 0,
      reasons
    });
  }

  return {
    mode,
    tasks
  };
}

/**
 * Berechnet Trinkaufgaben für das finale Turnierende (GAME_OVER).
 */
function calculateGameOverDrinkingTasks(room, ultimateWinnerIndex) {
  const mode = room.settings.drinkingMode || 'off';
  if (mode === 'off') return null;

  const elimSips = (mode === 'mild') ? 3 : (mode === 'medium') ? 5 : 7;
  const champDistribute = (mode === 'mild') ? 3 : (mode === 'medium') ? 5 : 7;

  const tasks = [];
  for (let i = 0; i < 6; i++) {
    const seat = room.seats[i];
    if (!seat) continue;
    const isChamp = (i === ultimateWinnerIndex);
    tasks.push({
      playerIndex: i,
      playerName: seat.name,
      isWinner: isChamp,
      sipsToDrink: isChamp ? 0 : elimSips,
      sipsToDistribute: isChamp ? champDistribute : 0,
      distributedSips: 0,
      receivedDistributedSips: 0,
      reasons: isChamp
        ? [`🏆 Turniersieger: Darf ${champDistribute} Ehren-Schlücke verteilen!`]
        : [`💀 Im Turnier ausgeschieden: ${elimSips} Schlücke`]
    });
  }
  return { mode, tasks };
}

/**
 * Verteilt automatisch die Schlücke eines Bot-Gewinners unter den Verlierern.
 */
function autoDistributeBotSips(room, drinkingTasks, winnerIndex) {
  if (!drinkingTasks || !drinkingTasks.tasks) return;
  const winnerTask = drinkingTasks.tasks.find(t => t.playerIndex === winnerIndex);
  if (!winnerTask || winnerTask.sipsToDistribute <= 0) return;

  const remaining = winnerTask.sipsToDistribute - winnerTask.distributedSips;
  if (remaining <= 0) return;

  const targets = drinkingTasks.tasks.filter(t => t.playerIndex !== winnerIndex);
  if (targets.length === 0) return;

  for (let s = 0; s < remaining; s++) {
    targets.sort((a, b) => b.sipsToDrink - a.sipsToDrink);
    const target = targets[s % targets.length];
    winnerTask.distributedSips += 1;
    target.receivedDistributedSips += 1;
    target.sipsToDrink += 1;
    target.reasons.push(`🎁 +1 Schluck von ${winnerTask.playerName} erhalten`);
  }
}

/**
 * Rechnet eine beendete Geldspiel-Partie (GAME_OVER) ab:
 * Pot = Teilnehmeranzahl * Einsatz. Der Turniersieger erhält den gesamten Pot.
 * Verlierer verlieren ihren Einsatz. Fortlaufende Salden und optimale Zahlungen werden berechnet.
 */
function settleMoneyGameAtGameOver(room, ultimateWinnerIndex) {
  if (!room.settings || !room.settings.moneyMode) return;
  const stake = (typeof room.settings.moneyStake === 'number' && room.settings.moneyStake > 0)
    ? Math.round(room.settings.moneyStake * 100) / 100
    : 5.0;

  const ultimateWinner = room.seats[ultimateWinnerIndex];
  const ultimateWinnerName = ultimateWinner ? ultimateWinner.name : 'Gewinner';

  const participants = (room.moneyLedger && room.moneyLedger.currentMatchParticipants && room.moneyLedger.currentMatchParticipants.length > 0)
    ? [...room.moneyLedger.currentMatchParticipants]
    : room.seats.filter(s => s !== null).map(s => s.name);

  if (participants.length === 0) return;

  const totalPot = Math.round(participants.length * stake * 100) / 100;
  const winnerNet = Math.round((totalPot - stake) * 100) / 100;

  if (!room.moneyLedger) {
    room.moneyLedger = { sessionBalances: {}, matchHistory: [], currentMatchParticipants: [] };
  }
  if (!room.moneyLedger.sessionBalances) {
    room.moneyLedger.sessionBalances = {};
  }

  const matchDeltas = [];
  for (const pName of participants) {
    if (typeof room.moneyLedger.sessionBalances[pName] !== 'number') {
      room.moneyLedger.sessionBalances[pName] = 0;
    }
    if (pName === ultimateWinnerName) {
      room.moneyLedger.sessionBalances[pName] = Math.round((room.moneyLedger.sessionBalances[pName] + winnerNet) * 100) / 100;
      matchDeltas.push({ name: pName, delta: winnerNet, isWinner: true });
    } else {
      room.moneyLedger.sessionBalances[pName] = Math.round((room.moneyLedger.sessionBalances[pName] - stake) * 100) / 100;
      matchDeltas.push({ name: pName, delta: -stake, isWinner: false });
    }
  }

  const debtTransfers = calculateDebtSettlement(room.moneyLedger.sessionBalances);

  const matchRecord = {
    matchNumber: (room.moneyLedger.matchHistory ? room.moneyLedger.matchHistory.length : 0) + 1,
    timestamp: Date.now(),
    stake,
    totalPot,
    winnerName: ultimateWinnerName,
    matchDeltas,
    sessionBalances: { ...room.moneyLedger.sessionBalances },
    debtTransfers
  };

  room.moneyLedger.matchHistory.push(matchRecord);

  if (room.roundSummary) {
    room.roundSummary.moneySettlement = {
      stake,
      totalPot,
      winnerName: ultimateWinnerName,
      matchDeltas,
      sessionBalances: { ...room.moneyLedger.sessionBalances },
      debtTransfers
    };
  }

  logAction(room, `💰 GELD-ABRECHNUNG: ${ultimateWinnerName} gewinnt den Pot von ${totalPot.toFixed(2)} € (+${winnerNet.toFixed(2)} € Reingewinn)!`);
}

/**
 * Wertet eine regulär beendete Tuppen-Runde nach Stich 4 aus.
 * Nur der Gewinner von Stich 4 gewinnt die Runde (0 Strafpunkte).
 * Alle anderen aktiven Spieler erhalten `currentStake` Strafpunkte.
 */
function resolveRound(room, winnerIndex) {
  const winnerName = room.seats[winnerIndex].name;
  const oldScores = [...room.scores];
  const stake = room.currentStake;

  logAction(room, `=== RUNDEN-ABRECHNUNG ===`);
  logAction(room, `🎉 ${winnerName} gewinnt den 4. und entscheidenden Stich! (verliert 0 Leben)`);

  for (let i = 0; i < 6; i++) {
    if (isPlayerAlive(room, i)) {
      if (i === winnerIndex) {
        // Gewinner verliert 0 Leben
      } else if (room.foldedThisRound[i]) {
        // Hat bereits Leben beim Passen verloren
      } else {
        // Hat die Runde mitgespielt und verloren -> verliert aktuellen Einsatz
        room.scores[i] = Math.max(0, room.scores[i] - stake);
        logAction(room, `❌ ${room.seats[i].name} verliert die Runde (-${stake} Leben, Restleben: ${room.scores[i]}).`);
      }
    }
  }

  // Ausscheiden bei 0 Leben prüfen
  for (let i = 0; i < 6; i++) {
    if (room.seats[i] && !room.eliminated[i] && room.scores[i] <= 0) {
      room.eliminated[i] = true;
      logAction(room, `💀 ${room.seats[i].name} hat alle Leben verloren und scheidet aus dem Spiel aus!`);
    }
  }

  // Lebende Spieler zählen
  const alivePlayers = getAlivePlayers(room);
  const isDrinkingActive = Boolean(room.settings && room.settings.drinkingMode && room.settings.drinkingMode !== 'off');

  room.roundSummary = {
    roundNumber: room.roundNumber,
    winnerIndex,
    winnerName,
    currentStake: stake,
    oldScores,
    newScores: [...room.scores],
    eliminated: [...room.eliminated],
    reason: `${winnerName} hat den 4. und letzten Stich gewonnen. Verlierer verlieren ${stake} Leben.`,
    isGameOver: alivePlayers.length <= 1
  };

  if (alivePlayers.length <= 1) {
    room.phase = 'GAME_OVER';
    const ultimateWinnerIndex = alivePlayers.length === 1 ? alivePlayers[0] : winnerIndex;
    const ultimateWinnerName = room.seats[ultimateWinnerIndex].name;
    logAction(room, `🏆🏆 PARTIE BEENDET! ${ultimateWinnerName} ist der letzte verbleibende Spieler und gewinnt das Tuppen-Turnier!`);

    settleMoneyGameAtGameOver(room, ultimateWinnerIndex);

    if (isDrinkingActive) {
      room.roundSummary.drinkingTasks = calculateGameOverDrinkingTasks(room, ultimateWinnerIndex);
      if (room.seats[ultimateWinnerIndex] && room.seats[ultimateWinnerIndex].isBot) {
        autoDistributeBotSips(room, room.roundSummary.drinkingTasks, ultimateWinnerIndex);
      }
    }
  } else {
    room.phase = 'ROUND_END';
    // Der Gewinner mischt und gibt die Karten für die nächste Runde!
    room.dealerIndex = winnerIndex;
    if (room.nextRoundAutoTimer) {
      clearTimeout(room.nextRoundAutoTimer);
      room.nextRoundAutoTimer = null;
    }

    if (isDrinkingActive) {
      // Trinkspiel aktiv: Schlücke berechnen, kein Auto-Timer, sondern 7s Trinkpause
      room.roundSummary.drinkingTasks = calculateDrinkingTasks(room, room.roundSummary);
      if (room.seats[winnerIndex] && room.seats[winnerIndex].isBot) {
        autoDistributeBotSips(room, room.roundSummary.drinkingTasks, winnerIndex);
      }
      room.roundEndAutoUntil = 0;
      room.roundEndNextRoundLockedUntil = Date.now() + 7000;
    } else {
      room.roundEndNextRoundLockedUntil = 0;
      room.roundEndAutoUntil = Date.now() + 5000;
      room.nextRoundAutoTimer = setTimeout(() => {
        room.nextRoundAutoTimer = null;
        room.roundEndAutoUntil = 0;
        const currentRoom = (rooms && rooms.get(room.code)) || room;
        if (currentRoom && currentRoom.phase === 'ROUND_END') {
          startNewRound(currentRoom);
        }
      }, 5000);
    }
  }

  broadcastGameState(room);
}

/**
 * Wertet die Runde vorzeitig aus, wenn alle anderen Spieler nach einem Klopfen gepasst haben.
 */
function resolveEarlyWin(room, winnerIndex) {
  const winnerName = room.seats[winnerIndex].name;
  const oldScores = [...room.scores];

  logAction(room, `=== RUNDEN-ABRECHNUNG (Vorzeitiger Sieg) ===`);
  logAction(room, `🎉 Alle anderen Spieler haben gepasst! ${winnerName} gewinnt die Runde kampflos (verliert 0 Leben)!`);

  // Ausscheiden bei 0 Leben prüfen
  for (let i = 0; i < 6; i++) {
    if (room.seats[i] && !room.eliminated[i] && room.scores[i] <= 0) {
      room.eliminated[i] = true;
      logAction(room, `💀 ${room.seats[i].name} hat alle Leben verloren und scheidet aus dem Spiel aus!`);
    }
  }

  const alivePlayers = getAlivePlayers(room);
  const isDrinkingActive = Boolean(room.settings && room.settings.drinkingMode && room.settings.drinkingMode !== 'off');

  room.roundSummary = {
    roundNumber: room.roundNumber,
    winnerIndex,
    winnerName,
    currentStake: room.currentStake,
    oldScores,
    newScores: [...room.scores],
    eliminated: [...room.eliminated],
    reason: `Alle anderen Spieler haben nach dem Klopfen gepasst. ${winnerName} gewinnt kampflos!`,
    isGameOver: alivePlayers.length <= 1
  };

  if (alivePlayers.length <= 1) {
    room.phase = 'GAME_OVER';
    const ultimateWinnerIndex = alivePlayers.length === 1 ? alivePlayers[0] : winnerIndex;
    const ultimateWinnerName = room.seats[ultimateWinnerIndex].name;
    logAction(room, `🏆🏆 PARTIE BEENDET! ${ultimateWinnerName} hat gewonnen!`);

    settleMoneyGameAtGameOver(room, ultimateWinnerIndex);

    if (isDrinkingActive) {
      room.roundSummary.drinkingTasks = calculateGameOverDrinkingTasks(room, ultimateWinnerIndex);
      if (room.seats[ultimateWinnerIndex] && room.seats[ultimateWinnerIndex].isBot) {
        autoDistributeBotSips(room, room.roundSummary.drinkingTasks, ultimateWinnerIndex);
      }
    }
  } else {
    room.phase = 'ROUND_END';
    room.dealerIndex = winnerIndex;
    if (room.nextRoundAutoTimer) {
      clearTimeout(room.nextRoundAutoTimer);
      room.nextRoundAutoTimer = null;
    }

    if (isDrinkingActive) {
      room.roundSummary.drinkingTasks = calculateDrinkingTasks(room, room.roundSummary);
      if (room.seats[winnerIndex] && room.seats[winnerIndex].isBot) {
        autoDistributeBotSips(room, room.roundSummary.drinkingTasks, winnerIndex);
      }
      room.roundEndAutoUntil = 0;
      room.roundEndNextRoundLockedUntil = Date.now() + 7000;
    } else {
      room.roundEndNextRoundLockedUntil = 0;
      room.roundEndAutoUntil = Date.now() + 5000;
      room.nextRoundAutoTimer = setTimeout(() => {
        room.nextRoundAutoTimer = null;
        room.roundEndAutoUntil = 0;
        const currentRoom = (rooms && rooms.get(room.code)) || room;
        if (currentRoom && currentRoom.phase === 'ROUND_END') {
          startNewRound(currentRoom);
        }
      }, 5000);
    }
  }

  broadcastGameState(room);
}

/**
 * Bereinigt den Spielzustand, wenn ein Spieler die Runde/das Spiel verlässt (Forfeit, Leave, Disconnect).
 * Sorgt dafür, dass Warteschlangen (Knock, Poverty) und der Spielzug nahtlos weiterlaufen,
 * ohne dass das Spiel jemals einfriert.
 */
function cleanupPlayerDeparture(room, leavingSeat) {
  if (!room) return false;

  // Hand leeren und für aktuelle Runde als gepasst markieren
  room.hands[leavingSeat] = [];
  room.foldedThisRound[leavingSeat] = true;

  // Aus Warteschlangen entfernen
  if (room.pendingKnockQueue) {
    room.pendingKnockQueue = room.pendingKnockQueue.filter(i => i !== leavingSeat);
  }
  if (room.pendingPovertyQueue) {
    room.pendingPovertyQueue = room.pendingPovertyQueue.filter(i => i !== leavingSeat);
  }

  // WICHTIG: 4-Bilder-Stacks des Spielers NICHT entfernen!
  // Andere Spieler sollen sie weiterhin aufdecken/challengen können.
  // Stacks verschwinden erst, wenn sie aufgedeckt werden oder der nächste Stich beginnt.

  // Prüfen, wie viele Spieler in der Runde noch aktiv sind
  const remainingActive = getActiveRoundPlayers(room);

  // Wenn nur noch 1 Spieler in der Runde aktiv ist -> Vorzeitiger Rundensieg!
  if (remainingActive.length <= 1) {
    // Alle Stacks des Spielers entfernen, da die Runde jetzt eh vorbei ist
    if (room.fourPicturesStacks) {
      room.fourPicturesStacks = room.fourPicturesStacks.filter(s => s.declarerIndex !== leavingSeat);
    }
    const winnerIdx = remainingActive.length === 1 ? remainingActive[0] : 0;
    resolveEarlyWin(room, winnerIdx);
    return true;
  }

  // Phase: FOUR_PICTURES_REVEAL (3.5s Timer läuft gerade)
  // Der Timer in handleChallengeFourPicturesStack erledigt die Auflösung.
  // Wir müssen nur sicherstellen, dass der currentTurn korrekt ist,
  // falls der verlassende Spieler der Declarer oder Challenger war.
  if (room.phase === 'FOUR_PICTURES_REVEAL') {
    // Nichts blockierendes tun – der setTimeout in handleChallengeFourPicturesStack
    // prüft bereits isPlayerAlive und räumt danach auf.
    return false;
  }

  // Phase: KNOCK_DECISION
  if (room.phase === 'KNOCK_DECISION') {
    if (room.pendingKnockQueue.length === 0) {
      // Alle verbleibenden haben geantwortet -> zurück zu PLAY_TRICK
      room.phase = 'PLAY_TRICK';
      const activePlayedCount = remainingActive.filter(idx => 
        room.currentTrick.some(e => e.playerIndex === idx)
      ).length;

      if (activePlayedCount >= remainingActive.length && remainingActive.length > 0) {
        logAction(room, `Klopf-Entscheidung beendet. Alle verbleibenden Spieler haben in diesem Stich bereits gelegt.`);
        triggerTrickEvaluation(room);
        return true;
      }

      const alreadyPlayedSet = new Set(room.currentTrick.map(e => e.playerIndex));
      if (remainingActive.includes(room.savedTurn) && !alreadyPlayedSet.has(room.savedTurn)) {
        room.currentTurn = room.savedTurn;
      } else {
        room.currentTurn = getNextTrickPlayerIndex(room, room.savedTurn);
      }
    } else {
      if (room.currentTurn === leavingSeat) {
        room.currentTurn = room.pendingKnockQueue[0];
      }
    }
  } else if (room.phase === 'POVERTY_CHECK') {
    if (room.pendingPovertyQueue.length === 0) {
      room.phase = 'PLAY_TRICK';
      room.currentTurn = getNextActivePlayerIndex(room, room.dealerIndex);
      logAction(room, `Klöpper-Entscheidungen abgeschlossen. Runde startet mit Einsatz ${room.currentStake} Leben.`);
    } else {
      if (room.currentTurn === leavingSeat) {
        room.currentTurn = room.pendingPovertyQueue[0];
      }
    }
  } else if (room.phase === 'PLAY_TRICK') {
    const activePlayedCount = remainingActive.filter(idx => 
      room.currentTrick.some(e => e.playerIndex === idx)
    ).length;

    if (activePlayedCount >= remainingActive.length && remainingActive.length > 0) {
      triggerTrickEvaluation(room);
      return true;
    }

    if (room.currentTurn === leavingSeat) {
      room.currentTurn = getNextTrickPlayerIndex(room, leavingSeat);
    }
  }

  return false;
}

/**
 * Verarbeitet die Klopf-Aktion eines Spielers (inklusive Gegenklopfen).
 */
function handleKnock(room, playerIndex) {
  const isNormalPlay = (room.phase === 'PLAY_TRICK');
  const isCounterKnock = (room.phase === 'KNOCK_DECISION' && (room.pendingKnockQueue || []).includes(playerIndex));
  if (!isNormalPlay && !isCounterKnock) return;

  if (isNormalPlay && room.settings.allowBlindKnock === false && room.trickCount === 0) return;
  const activeRoundPlayers = getActiveRoundPlayers(room);

  if (!canPlayerKnock(room.scores, activeRoundPlayers, room.currentStake, playerIndex, room.lastKnocker)) {
    return;
  }

  room.currentStake++;
  room.lastKnocker = playerIndex;
  room.knockerIndex = playerIndex;
  if (isNormalPlay) {
    room.savedTurn = room.currentTurn;
  }
  room.phase = 'KNOCK_DECISION';

  const knockerName = room.seats[playerIndex].name;
  if (isCounterKnock) {
    logAction(room, `🔨 ${knockerName} KLOPFT GEGEN! Einsatz steigt auf ${room.currentStake} Leben!`);
  } else {
    logAction(room, `🔨 ${knockerName} hat GEKLOPFT! Einsatz steigt auf ${room.currentStake} Leben!`);
  }

  // Alle anderen aktiven Spieler in Reihenfolge nach dem Klopfer befragen
  // Wer am Klöpper steht (<= 1 Leben), geht automatisch mit!
  const seatedIndices = [];
  for (let i = 0; i < 6; i++) {
    if (room.seats[i] !== null) seatedIndices.push(i);
  }
  const queue = [];
  const currentPos = seatedIndices.indexOf(playerIndex);
  for (let step = 1; step < seatedIndices.length; step++) {
    const idx = seatedIndices[(currentPos + step) % seatedIndices.length];
    if (activeRoundPlayers.includes(idx)) {
      if (room.scores[idx] > 1) {
        queue.push(idx);
      } else {
        logAction(room, `🔨 ${room.seats[idx].name} steht am Klöpper und geht automatisch mit!`);
      }
    }
  }

  if (queue.length > 0) {
    room.pendingKnockQueue = queue;
    room.currentTurn = queue[0];
  } else {
    room.phase = 'PLAY_TRICK';
  }

  io.to(room.code).emit('knock_announced', {
    knockerIndex: playerIndex,
    knockerName,
    newStake: room.currentStake
  });

  broadcastGameState(room);
  checkBotAction(room);
}

/**
 * Verarbeitet die Entscheidung eines Mitspielers auf ein Klopfen (Dabei vs. Raus vs. Gegenklopfen).
 */
function handleKnockResponse(room, playerIndex, decision) {
  if (room.phase !== 'KNOCK_DECISION') return;
  if (!room.pendingKnockQueue || !room.pendingKnockQueue.includes(playerIndex)) return;

  if (decision === 'counter_knock') {
    handleKnock(room, playerIndex);
    return;
  }

  const playerName = room.seats[playerIndex].name;
  const foldPenalty = room.currentStake - 1;

  if (decision === 'fold') {
    room.foldedThisRound[playerIndex] = true;
    room.hands[playerIndex] = [];
    room.scores[playerIndex] = Math.max(0, room.scores[playerIndex] - foldPenalty);
    logAction(room, `🚪 ${playerName} PASST und verliert ${foldPenalty} Leben (Restleben: ${room.scores[playerIndex]}).`);
    if (room.scores[playerIndex] <= 0) {
      room.eliminated[playerIndex] = true;
      logAction(room, `💀 ${playerName} hat keine Leben mehr und scheidet aus!`);
    }
  } else {
    logAction(room, `⚔️ ${playerName} GEHT MIT auf ${room.currentStake} Leben!`);
  }

  // Aus Warteschlange entfernen
  room.pendingKnockQueue = room.pendingKnockQueue.filter(i => i !== playerIndex);

  // Prüfen, ob alle anderen Spieler gepasst haben -> Klopfer gewinnt sofort!
  const remainingActive = getActiveRoundPlayers(room);
  if (remainingActive.length === 1) {
    resolveEarlyWin(room, remainingActive[0]);
    return;
  }

  if (room.pendingKnockQueue.length > 0) {
    room.currentTurn = room.pendingKnockQueue[0];
    broadcastGameState(room);
    checkBotAction(room);
  } else {
    // Alle haben entschieden: Spiel geht normal weiter
    room.phase = 'PLAY_TRICK';
    const activeRoundPlayers = getActiveRoundPlayers(room);

    // Prüfen, ob durch das Passen bereits alle verbleibenden aktiven Spieler gelegt haben!
    const activePlayedCount = activeRoundPlayers.filter(idx => 
      room.currentTrick.some(e => e.playerIndex === idx)
    ).length;

    if (activePlayedCount >= activeRoundPlayers.length && activeRoundPlayers.length > 0) {
      logAction(room, `Klopf-Entscheidung beendet. Alle verbleibenden Spieler haben in diesem Stich bereits gelegt.`);
      triggerTrickEvaluation(room);
      return;
    }

    const alreadyPlayedSet = new Set(room.currentTrick.map(e => e.playerIndex));
    if (activeRoundPlayers.includes(room.savedTurn) && !alreadyPlayedSet.has(room.savedTurn)) {
      room.currentTurn = room.savedTurn;
    } else {
      room.currentTurn = getNextTrickPlayerIndex(room, room.savedTurn);
    }
    logAction(room, `Klopf-Entscheidung beendet. Runde läuft weiter mit Einsatz ${room.currentStake} Pkt.`);
    broadcastGameState(room);
    checkBotAction(room);
  }
}

/**
 * Verarbeitet die Antwort auf die Klöpper-Abfrage zu Beginn der Runde.
 */
function handlePovertyResponse(room, playerIndex, decision) {
  if (room.phase !== 'POVERTY_CHECK') return;
  if (!room.pendingPovertyQueue || !room.pendingPovertyQueue.includes(playerIndex)) return;

  const playerName = room.seats[playerIndex].name;

  if (decision === 'fold') {
    room.foldedThisRound[playerIndex] = true;
    room.hands[playerIndex] = [];
    room.scores[playerIndex] = Math.max(0, room.scores[playerIndex] - 1);
    logAction(room, `🚪 ${playerName} passt beim Klöpper (-1 Leben, Restleben: ${room.scores[playerIndex]}).`);
    if (room.scores[playerIndex] <= 0) {
      room.eliminated[playerIndex] = true;
      logAction(room, `💀 ${playerName} hat keine Leben mehr und scheidet aus!`);
    }
  } else {
    logAction(room, `⚔️ ${playerName} geht beim Klöpper mit (Einsatz: ${room.currentStake} Leben).`);
  }

  room.pendingPovertyQueue = room.pendingPovertyQueue.filter(i => i !== playerIndex);

  const remainingActive = getActiveRoundPlayers(room);

  // Wenn nur noch 1 aktiver Spieler übrig ist, gewinnt er kampflos
  if (remainingActive.length === 1) {
    resolveEarlyWin(room, remainingActive[0]);
    return;
  }

  if (room.pendingPovertyQueue.length > 0) {
    room.currentTurn = room.pendingPovertyQueue[0];
    broadcastGameState(room);
    checkBotAction(room);
  } else {
    // Klöpper-Abfrage abgeschlossen: Runde läuft mit dem berechneten Einsatz weiter
    room.phase = 'PLAY_TRICK';
    room.currentTurn = getNextActivePlayerIndex(room, room.dealerIndex);
    logAction(room, `Klöpper-Entscheidungen abgeschlossen. Runde startet mit Einsatz ${room.currentStake} Leben.`);
    broadcastGameState(room);
    checkBotAction(room);
  }
}

/**
 * Verarbeitet die "4 Bilder"-Ansage eines Spielers.
 * Kann vor Stich 1 beliebig oft wiederholt werden, solange Stock >= 4 Karten hat.
 * Die abgelegten Karten werden als Stapel auf dem Tisch aufgereiht.
 * Die Spieler werden NICHT sequentiell gefragt, sondern das Spiel läuft non-blocking weiter,
 * abgesichert durch einen Cooldown-Timer (Bedenkzeit), während dem noch keine Karte gelegt werden kann.
 */
function handleDeclareFourPictures(room, playerIndex) {
  if (room.settings.allowFourPictures === false) return;
  if (room.phase !== 'PLAY_TRICK' && room.phase !== 'KNOCK_DECISION' && room.phase !== 'POVERTY_CHECK') return;
  if (room.trickCount !== 0) return;
  if (room.currentTrick && room.currentTrick.some(e => e.playerIndex === playerIndex)) return;
  if (!room.hands[playerIndex] || room.hands[playerIndex].length !== 4) return;
  if (!room.stock || room.stock.length < 4) return;
  if (room.eliminated[playerIndex] || room.foldedThisRound[playerIndex]) return;

  const playerName = room.seats[playerIndex].name;
  const laidCards = [...room.hands[playerIndex]];

  if (!room.fourPicturesStacks) room.fourPicturesStacks = [];
  if (!room.nextFourPicturesStackId) room.nextFourPicturesStackId = 1;

  const stackId = room.nextFourPicturesStackId++;
  const stack = {
    id: stackId,
    declarerIndex: playerIndex,
    declarerName: playerName,
    cards: laidCards,
    isRevealed: false,
    isGenuine: null,
    challengerIndex: null,
    challengerName: null,
    createdAt: Date.now()
  };
  room.fourPicturesStacks.push(stack);

  // 4 frische Karten aus dem Stock austeilen
  room.hands[playerIndex] = room.stock.splice(0, 4);
  sortHand(room.hands[playerIndex]);

  // Cooldown setzen (vor dem ersten Stich kann für X Sekunden niemand ausspielen)
  const cooldownSec = (typeof room.settings.fourPicturesCooldownSeconds === 'number') ? room.settings.fourPicturesCooldownSeconds : 5;
  if (cooldownSec > 0) {
    room.fourPicturesLockUntil = Date.now() + (cooldownSec * 1000);
  } else {
    room.fourPicturesLockUntil = 0;
  }

  const playerStacks = room.fourPicturesStacks.filter(s => s.declarerIndex === playerIndex);
  logAction(room, `🎴 ${playerName} erklärt 4 BILDER (Stapel #${playerStacks.length}) und tauscht 4 Karten!`);
  if (cooldownSec > 0) {
    logAction(room, `⏱️ Bedenkzeit: ${cooldownSec}s bis zum Ausspiel. Mitspieler können auf einen Stapel tippen zum Prüfen!`);
  } else {
    logAction(room, `⏱️ Sofortiges Ausspiel (0s Bedenkzeit). Mitspieler können auf einen Stapel tippen zum Prüfen!`);
  }

  broadcastGameState(room);

  if (room.botTimer) clearTimeout(room.botTimer);
  if (cooldownSec > 0) {
    room.botTimer = setTimeout(() => {
      const currentRoom = rooms.get(room.code);
      if (currentRoom) checkBotAction(currentRoom);
    }, (cooldownSec * 1000) + 200);
  } else {
    checkBotAction(room);
  }
}

/**
 * Verarbeitet die gezielte Herausforderung eines bestimmten 4-Bilder-Stapels durch Antippen auf dem Tisch.
 */
function handleChallengeFourPicturesStack(room, challengerIndex, stackId) {
  if (room.phase === 'FOUR_PICTURES_REVEAL') return;
  if (room.trickCount !== 0) return;
  if (room.eliminated[challengerIndex] || room.foldedThisRound[challengerIndex]) return;

  const stack = (room.fourPicturesStacks || []).find(s => s.id === stackId);
  if (!stack || stack.isRevealed) return;
  if (stack.declarerIndex === challengerIndex) return; // Nicht eigene Karten prüfen
  // Nur prüfen, ob Declarer schon im aktuellen Stich gelegt hat, wenn er noch im Spiel ist
  if (room.seats[stack.declarerIndex] && room.currentTrick && room.currentTrick.some(e => e.playerIndex === stack.declarerIndex)) return;

  const declarerIndex = stack.declarerIndex;
  const declarerName = (room.seats[declarerIndex] && room.seats[declarerIndex].name) || stack.declarerName || 'Unbekannt';
  const challengerName = room.seats[challengerIndex].name;

  const isGenuine = hasFourPictures(stack.cards);
  stack.isRevealed = true;
  stack.isGenuine = isGenuine;
  stack.challengerIndex = challengerIndex;
  stack.challengerName = challengerName;

  // Für Abwärtskompatibilität auch room.fourPicturesTablePile setzen
  room.fourPicturesTablePile = {
    declarerIndex,
    cardCount: 4,
    isRevealed: true,
    revealedCards: [...stack.cards],
    challengerIndex,
    challengerName,
    isGenuine
  };

  const prevPhase = room.phase;
  room.phaseBeforeReveal = prevPhase;
  room.phase = 'FOUR_PICTURES_REVEAL';

  if (isGenuine) {
    room.drinkingIncidents = room.drinkingIncidents || [];
    room.drinkingIncidents.push({ type: 'WRONG_CHALLENGE', playerIndex: challengerIndex });
    room.scores[challengerIndex] = Math.max(0, room.scores[challengerIndex] - 1);
    if (room.scores[challengerIndex] <= 0) {
      room.eliminated[challengerIndex] = true;
      logAction(room, `💀 ${challengerName} hat alle Leben verloren und scheidet aus!`);
    }
    logAction(room, `🔍 ${challengerName} deckt Stapel #${stack.id} auf: Die "4 Bilder" von ${declarerName} waren ECHT!`);
    logAction(room, `❌ ${challengerName} verliert 1 Leben für die unberechtigte Prüfung (${room.scores[challengerIndex]} Leben verbleibend).`);
  } else {
    room.drinkingIncidents = room.drinkingIncidents || [];
    room.drinkingIncidents.push({ type: 'BLUFF_CAUGHT', playerIndex: declarerIndex });
    // Nur Strafe anwenden, wenn der Declarer noch im Spiel ist
    if (!room.eliminated[declarerIndex] && !room.foldedThisRound[declarerIndex]) {
      room.scores[declarerIndex] = Math.max(0, room.scores[declarerIndex] - 1);
      if (room.scores[declarerIndex] <= 0) {
        room.eliminated[declarerIndex] = true;
        logAction(room, `💀 ${declarerName} hat alle Leben verloren und scheidet aus!`);
      }
      logAction(room, `🚨 BLUFF AUFGEDECKT! ${declarerName} hatte in Stapel #${stack.id} KEINE echten 4 Bilder!`);
      logAction(room, `❌ ${declarerName} verliert 1 Leben wegen Bluff (${room.scores[declarerIndex]} Leben verbleibend).`);
    } else {
      logAction(room, `🚨 BLUFF AUFGEDECKT! ${declarerName} hatte in Stapel #${stack.id} KEINE echten 4 Bilder! (bereits ausgeschieden)`);
    }
  }

  broadcastGameState(room);

  // Nach 3,5 Sekunden auswerten und Spiel fortsetzen
  setTimeout(() => {
    const currentRoom = (rooms && rooms.get(room.code)) || room;
    if (!currentRoom || currentRoom.phase !== 'FOUR_PICTURES_REVEAL') return;

    if (!isGenuine) {
      const declarerStillActive = !currentRoom.eliminated[declarerIndex] &&
                                   !currentRoom.foldedThisRound[declarerIndex] &&
                                   currentRoom.seats[declarerIndex] !== null;

      if (declarerStillActive) {
        // Gezogene Karten zurück in den Stock
        const drawnCards = currentRoom.hands[declarerIndex];
        if (drawnCards && drawnCards.length > 0) {
          currentRoom.stock.push(...drawnCards);
          shuffleDeck(currentRoom.stock);
        }
        // Bluff-Karten zurück in die Hand
        currentRoom.hands[declarerIndex] = [...stack.cards];
        sortHand(currentRoom.hands[declarerIndex]);
      } else {
        // Declarer ist bereits raus – alle Karten (Bluff + gezogene) zurück in den Stock
        const drawnCards = currentRoom.hands[declarerIndex];
        if (drawnCards && drawnCards.length > 0) {
          currentRoom.stock.push(...drawnCards);
        }
        currentRoom.stock.push(...stack.cards);
        shuffleDeck(currentRoom.stock);
        currentRoom.hands[declarerIndex] = [];
      }
    }

    // Aufgedeckten Stapel nach der Auswertung komplett vom Tisch entfernen!
    currentRoom.fourPicturesStacks = (currentRoom.fourPicturesStacks || []).filter(s => s.id !== stack.id);
    currentRoom.fourPicturesTablePile = null;

    const remainingAlive = currentRoom.seats.map((_, i) => i).filter(i => isPlayerAlive(currentRoom, i));
    if (remainingAlive.length <= 1) {
      resolveRound(currentRoom, remainingAlive[0] !== undefined ? remainingAlive[0] : 0);
      return;
    }

    const previousPhase = currentRoom.phaseBeforeReveal || 'PLAY_TRICK';
    currentRoom.phaseBeforeReveal = null;

    if (previousPhase === 'KNOCK_DECISION') {
      currentRoom.pendingKnockQueue = (currentRoom.pendingKnockQueue || []).filter(
        idx => isPlayerAlive(currentRoom, idx) && !currentRoom.foldedThisRound[idx]
      );
      const activeRemaining = getActiveRoundPlayers(currentRoom);
      if (activeRemaining.length <= 1) {
        resolveEarlyWin(currentRoom, activeRemaining[0] !== undefined ? activeRemaining[0] : 0);
        return;
      }
      if (currentRoom.pendingKnockQueue.length > 0) {
        currentRoom.phase = 'KNOCK_DECISION';
        currentRoom.currentTurn = currentRoom.pendingKnockQueue[0];
      } else {
        currentRoom.phase = 'PLAY_TRICK';
        const alreadyPlayedSet = new Set(currentRoom.currentTrick.map(e => e.playerIndex));
        if (activeRemaining.includes(currentRoom.savedTurn) && !alreadyPlayedSet.has(currentRoom.savedTurn)) {
          currentRoom.currentTurn = currentRoom.savedTurn;
        } else {
          currentRoom.currentTurn = getNextTrickPlayerIndex(currentRoom, currentRoom.savedTurn);
        }
      }
    } else if (previousPhase === 'POVERTY_CHECK') {
      currentRoom.pendingPovertyQueue = (currentRoom.pendingPovertyQueue || []).filter(
        idx => isPlayerAlive(currentRoom, idx) && !currentRoom.foldedThisRound[idx]
      );
      const activeRemaining = getActiveRoundPlayers(currentRoom);
      if (activeRemaining.length <= 1) {
        resolveEarlyWin(currentRoom, activeRemaining[0] !== undefined ? activeRemaining[0] : 0);
        return;
      }
      if (currentRoom.pendingPovertyQueue.length > 0) {
        currentRoom.phase = 'POVERTY_CHECK';
        currentRoom.currentTurn = currentRoom.pendingPovertyQueue[0];
      } else {
        currentRoom.phase = 'PLAY_TRICK';
        currentRoom.currentTurn = getNextActivePlayerIndex(currentRoom, currentRoom.dealerIndex);
      }
    } else {
      currentRoom.phase = 'PLAY_TRICK';
    }

    broadcastGameState(currentRoom);
    checkBotAction(currentRoom);
  }, 3500);
}

function handleChallengeFourPictures(room, challengerIndex, challenge) {
  if (!challenge) return;
  const unrevealed = (room.fourPicturesStacks || []).filter(s => !s.isRevealed && s.declarerIndex !== challengerIndex);
  if (unrevealed.length > 0) {
    handleChallengeFourPicturesStack(room, challengerIndex, unrevealed[unrevealed.length - 1].id);
  }
}

/**
 * Führt automatische Züge für Bots in Tuppen aus.
 */
function checkBotAction(room) {
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }

  const turnDelay = (room.settings && typeof room.settings.dealAndTurnDelaySeconds === 'number')
    ? room.settings.dealAndTurnDelaySeconds * 1000
    : 1000;

  const currentSeat = room.seats[room.currentTurn];
  if (!currentSeat || !currentSeat.isBot) return;

  const botIndex = room.currentTurn;
  const botHand = room.hands[botIndex] || [];
  const botScore = room.scores[botIndex] || 0;

  room.botTimer = setTimeout(() => {
    // Während Reveal-Pause keine Bot-Aktionen
    if (room.phase === 'FOUR_PICTURES_REVEAL') return;

    // 1. Armuts-Entscheidung
    if (room.phase === 'POVERTY_CHECK') {
      if (room.trickCount === 0 && room.currentTrick.length === 0 && botHand.length === 4 && shouldBotDeclare4Pictures(botHand)) {
        handleDeclareFourPictures(room, botIndex);
        return;
      }
      const decision = shouldBotPlayUnderPoverty(botHand, botScore);
      handlePovertyResponse(room, botIndex, decision);
      return;
    }

    // 2. Klopf-Entscheidung (Dabei vs. Raus)
    if (room.phase === 'KNOCK_DECISION') {
      if (room.trickCount === 0 && room.currentTrick.length === 0 && botHand.length === 4 && shouldBotDeclare4Pictures(botHand)) {
        handleDeclareFourPictures(room, botIndex);
        return;
      }
      const decision = shouldBotFoldOrCall(botHand, room.currentStake - 1, room.currentStake, botScore);
      handleKnockResponse(room, botIndex, decision);
      return;
    }

    // 3. Normaler Stich-Modus
    if (room.phase === 'PLAY_TRICK') {
      // 3a. Prüfen, ob der Bot 4 Bilder ansagen möchte (in Stich 1, bevor er gelegt hat)
      if (room.trickCount === 0 && botHand.length === 4 && !(room.currentTrick || []).some(e => e.playerIndex === botIndex) && shouldBotDeclare4Pictures(botHand)) {
        handleDeclareFourPictures(room, botIndex);
        return;
      }

      // 3b. Prüfen, ob der Bot einen unaufgedeckten 4-Bilder-Stapel eines Gegners herausfordern will
      if (room.trickCount === 0) {
        const unrevealed = (room.fourPicturesStacks || []).filter(s => !s.isRevealed && s.declarerIndex !== botIndex);
        if (unrevealed.length > 0 && shouldBotChallenge4Pictures(botScore)) {
          const target = unrevealed[Math.floor(Math.random() * unrevealed.length)];
          handleChallengeFourPicturesStack(room, botIndex, target.id);
          return;
        }
      }

      // Bedenkzeit-Sperre vor dem ersten Stich: Bot wartet mit Kartenausspiel
      if (room.fourPicturesLockUntil && Date.now() < room.fourPicturesLockUntil && room.trickCount === 0) {
        const waitMs = room.fourPicturesLockUntil - Date.now() + 200;
        room.botTimer = setTimeout(() => {
          const currentRoom = rooms.get(room.code);
          if (currentRoom) checkBotAction(currentRoom);
        }, waitMs);
        return;
      }

      // 3c. Prüfen, ob der Bot klopfen möchte
      const activeScores = getActiveRoundPlayers(room).map(i => room.scores[i]);
      if (shouldBotKnock(botHand, room.currentStake, botScore, activeScores, botIndex, room.lastKnocker)) {
        handleKnock(room, botIndex);
        return;
      }

      // 3d. Karte taktisch ausspielen
      const maxPlayers = room.settings.playerCount || 4;
      const foldedIndices = [];
      for (let i = 0; i < maxPlayers; i++) {
        if (room.foldedThisRound[i]) foldedIndices.push(i);
      }
      const chosenCard = chooseCardToPlay(botHand, room.currentTrick, room.trickCount, botIndex, foldedIndices);
      if (chosenCard) {
        handleCardPlay(room, botIndex, chosenCard.id);
      }
    }
  }, turnDelay);
}

// --------------------------------------------------------------------------
// SOCKET.IO EVENT HANDLING
// --------------------------------------------------------------------------
io.on('connection', (socket) => {
  // Sende aktuelle Server-Build-ID zur automatischen Update-Prüfung
  socket.emit('server_version', { buildId: APP_BUILD_ID });

  let currentRoomCode = null;
  let currentSeatIndex = -1;

  const getRoom = () => {
    if (socket.roomCode && rooms.has(socket.roomCode)) {
      currentRoomCode = socket.roomCode;
      return rooms.get(socket.roomCode);
    }
    if (currentRoomCode && rooms.has(currentRoomCode)) {
      socket.roomCode = currentRoomCode;
      return rooms.get(currentRoomCode);
    }
    for (const [code, r] of rooms.entries()) {
      if (r.seats && r.seats.some(s => s && s.socketId === socket.id)) {
        currentRoomCode = code;
        socket.roomCode = code;
        return r;
      }
    }
    for (const [code, r] of rooms.entries()) {
      if (r.spectators && r.spectators.some(s => s && s.socketId === socket.id)) {
        currentRoomCode = code;
        socket.roomCode = code;
        return r;
      }
    }
    return null;
  };

  const getMySeatIndex = (r) => {
    const activeRoom = r || getRoom();
    if (activeRoom && activeRoom.seats) {
      const idx = activeRoom.seats.findIndex(s => s && s.socketId === socket.id);
      if (idx !== -1) {
        currentSeatIndex = idx;
        socket.seatIndex = idx;
        return idx;
      }
    }
    if (typeof socket.seatIndex === 'number' && socket.seatIndex !== -1) {
      return socket.seatIndex;
    }
    return currentSeatIndex;
  };

  socket.on('confirm_spectator_promoted', ({ roomCode, seatIndex }) => {
    currentRoomCode = roomCode;
    currentSeatIndex = seatIndex;
    socket.roomCode = roomCode;
    socket.seatIndex = seatIndex;
  });

  socket.on('confirm_spectator_joined', ({ roomCode }) => {
    currentRoomCode = roomCode;
    currentSeatIndex = -1;
    socket.roomCode = roomCode;
    socket.seatIndex = -1;
  });

  // Raum erstellen
  socket.on('create_room', ({ playerName, settings }) => {
    if (currentRoomCode) handlePlayerLeave();

    const code = generateRoomCode();
    const room = createRoom(code, playerName || 'Spieler 1', socket.id);

    if (settings) {
      const initLives = settings.initialLives || settings.maxPenalty;
      if (typeof initLives === 'number' && [3, 5, 7, 10, 12].includes(initLives)) {
        room.settings.initialLives = initLives;
        room.settings.maxPenalty = initLives;
        room.scores = Array(6).fill(initLives);
      }
      if (typeof settings.allowKloepper === 'boolean') {
        room.settings.allowKloepper = settings.allowKloepper;
        room.settings.allowPoverty = settings.allowKloepper;
      } else if (typeof settings.allowPoverty === 'boolean') {
        room.settings.allowKloepper = settings.allowPoverty;
        room.settings.allowPoverty = settings.allowPoverty;
      }
      if (settings.kloepperStakeMode === 'fixed' || settings.kloepperStakeMode === 'per_player') {
        room.settings.kloepperStakeMode = settings.kloepperStakeMode;
      }
      if (typeof settings.allowFourPictures === 'boolean') {
        room.settings.allowFourPictures = settings.allowFourPictures;
      }
      if (typeof settings.fourPicturesCooldownSeconds === 'number' && settings.fourPicturesCooldownSeconds >= 0 && settings.fourPicturesCooldownSeconds <= 10) {
        room.settings.fourPicturesCooldownSeconds = Math.round(settings.fourPicturesCooldownSeconds);
      }
      if (typeof settings.allowBlindKnock === 'boolean') {
        room.settings.allowBlindKnock = settings.allowBlindKnock;
      }
      if (typeof settings.trickDisplaySeconds === 'number') {
        room.settings.trickDisplaySeconds = Math.round(settings.trickDisplaySeconds * 10) / 10;
      }
      if (typeof settings.dealAndTurnDelaySeconds === 'number') {
        room.settings.dealAndTurnDelaySeconds = Math.round(settings.dealAndTurnDelaySeconds * 10) / 10;
      }
      if (typeof settings.isPublic === 'boolean') {
        room.settings.isPublic = settings.isPublic;
      }
      if (['off', 'mild', 'medium', 'extreme'].includes(settings.drinkingMode)) {
        room.settings.drinkingMode = settings.drinkingMode;
      }
      if (typeof settings.moneyMode === 'boolean') {
        room.settings.moneyMode = settings.moneyMode;
      }
      if (typeof settings.moneyStake === 'number' && settings.moneyStake > 0) {
        room.settings.moneyStake = Math.round(settings.moneyStake * 100) / 100;
      }
    }

    rooms.set(code, room);
    currentRoomCode = code;
    currentSeatIndex = 0;
    socket.join(code);
    socket.emit('room_created', { roomCode: code, seatIndex: 0 });
    broadcastGameState(room);
    broadcastPublicRooms();
  });

  socket.on('get_public_rooms', () => {
    socket.emit('public_rooms_update', getPublicRoomsData());
  });

  const doNormalJoin = (sock, code, playerName, preferredSeat) => {
    const room = rooms.get(code);
    if (!room) return sock.emit('error_message', 'Raum nicht gefunden.');
    if (room.settings && room.settings.isPublic === false) {
      return sock.emit('error_message', 'Diese Partie ist privat.');
    }

    const maxSeats = room.phase === 'LOBBY' ? 6 : (room.settings.playerCount || 4);
    let targetSeat = -1;
    if (typeof preferredSeat === 'number' && preferredSeat >= 0 && preferredSeat < maxSeats && (!room.seats[preferredSeat] || room.seats[preferredSeat].isBot)) {
      targetSeat = preferredSeat;
    } else {
      targetSeat = room.seats.findIndex((s, idx) => idx < maxSeats && s === null);
      if (targetSeat === -1) {
        targetSeat = room.seats.findIndex((s, idx) => idx < maxSeats && s && s.isBot);
      }
    }

    if (targetSeat === -1) {
      return sock.emit('error_message', `Dieser Raum ist voll (maximal 6 Spieler).`);
    }

    const newSeat = {
      index: targetSeat,
      name: playerName || `Spieler ${targetSeat + 1}`,
      socketId: sock.id,
      isBot: false,
      connected: true
    };

    room.seats[targetSeat] = newSeat;
    currentRoomCode = code;
    currentSeatIndex = targetSeat;
    sock.join(code);

    logAction(room, `${newSeat.name} ist Platz ${targetSeat + 1} beigetreten.`);
    broadcastGameState(room);
    broadcastPublicRooms();
  };

  const handleJoinRequest = (requesterSocket, code, pName) => {
    const room = rooms.get(code);
    if (!room) return requesterSocket.emit('error_message', 'Raum nicht gefunden.');
    if (room.phase === 'LOBBY') return doNormalJoin(requesterSocket, code, pName);
    if (room.settings && room.settings.isPublic === false) {
      return requesterSocket.emit('error_message', 'Diese Partie ist privat.');
    }

    const seatedCount = room.seats.filter(s => s !== null).length;
    const botSeats = room.seats.filter(s => s && s.isBot);
    const waitingSpectatorsCount = (room.spectators || []).length;
    const canSpectate = ((seatedCount + waitingSpectatorsCount) < 6);

    if (botSeats.length === 0 && !canSpectate) {
      return requesterSocket.emit('error_message', 'Diese Partie ist voll (6 von 6 Spielern am Tisch).');
    }

    const asSpectator = (botSeats.length === 0);
    const nextPlayerNumber = seatedCount + waitingSpectatorsCount + 1;
    const reqName = (pName || 'Gast').trim().slice(0, 15);
    const hostSocket = io.sockets.sockets.get(room.hostSocketId);
    if (!hostSocket) return requesterSocket.emit('error_message', 'Spielleiter nicht erreichbar.');

    const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    if (!room.pendingJoinRequests) room.pendingJoinRequests = new Map();
    room.pendingJoinRequests.set(requestId, {
      requestId,
      playerName: reqName,
      socketId: requesterSocket.id,
      asSpectator,
      canSpectate,
      nextPlayerNumber,
      timestamp: Date.now()
    });

    // Auto-Ablehnung nach 60 Sekunden, wenn Host nicht reagiert
    setTimeout(() => {
      const r = rooms.get(code);
      if (r && r.pendingJoinRequests && r.pendingJoinRequests.has(requestId)) {
        r.pendingJoinRequests.delete(requestId);
        const reqSocket = io.sockets.sockets.get(requesterSocket.id);
        if (reqSocket) reqSocket.emit('error_message', 'Beitrittsanfrage abgelaufen (60s Timeout). Versuche es erneut.');
      }
    }, 60000);

    const availableBots = botSeats.map(b => ({
      seatIndex: b.index,
      name: b.name
    }));

    hostSocket.emit('join_request_received', {
      requestId,
      playerName: reqName,
      asSpectator,
      canSpectate,
      nextPlayerNumber,
      availableBots
    });

    const hostSeat = room.seats.find(s => s && s.socketId === room.hostSocketId);
    requesterSocket.emit('join_request_sent', {
      roomCode: code,
      hostName: hostSeat ? hostSeat.name : 'Spielleiter'
    });
  };

  socket.on('request_join_room', ({ roomCode, playerName }) => {
    const code = (roomCode || '').toUpperCase().trim();
    handleJoinRequest(socket, code, playerName);
  });

  socket.on('resolve_join_request', ({ requestId, accept, targetSeat }) => {
    const room = getRoom();
    if (!room || !isPlayerHost(room, socket)) return;
    if (!room.pendingJoinRequests || !room.pendingJoinRequests.has(requestId)) return;

    const req = room.pendingJoinRequests.get(requestId);
    room.pendingJoinRequests.delete(requestId);
    const requesterSocket = io.sockets.sockets.get(req.socketId);

    if (!accept) {
      if (requesterSocket) {
        requesterSocket.emit('join_request_rejected', { message: 'Der Spielleiter hat die Anfrage abgelehnt.' });
      }
      return socket.emit('join_request_resolved', { requestId, status: 'rejected' });
    }

    // Wenn als Zuschauer angenommen (targetSeat === -1 oder ungültig)
    if (targetSeat === -1 || typeof targetSeat !== 'number') {
      if (requesterSocket) {
        const specName = req.playerName.trim().slice(0, 15);
        if (!room.spectators) room.spectators = [];
        const existing = room.spectators.find(s => s.socketId === requesterSocket.id);
        if (!existing) {
          room.spectators.push({
            socketId: requesterSocket.id,
            name: specName,
            joinedAt: Date.now()
          });
        }
        requesterSocket.roomCode = room.code;
        requesterSocket.seatIndex = -1;
        requesterSocket.currentRoomCode = room.code;
        requesterSocket.currentSeatIndex = -1;
        requesterSocket.join(room.code);
        requesterSocket.emit('join_request_accepted_spectator', { roomCode: room.code, name: specName });
        requesterSocket.emit('spectator_joined', { roomCode: room.code, isSpectator: true, name: specName });
        const curSeated = room.seats.filter(s => s !== null).length;
        const totalWithSpec = curSeated + room.spectators.length;
        logAction(room, `👁️ ${specName} schaut als Zuschauer zu und steigt zur nächsten Partie als ${totalWithSpec}. Spieler ein!`);
        socket.emit('join_request_resolved', { requestId, status: 'accepted', asSpectator: true, playerName: specName });
        broadcastGameState(room);
        broadcastPublicRooms();
      }
      return;
    }

    const maxPlayers = room.settings.playerCount || 4;
    if (targetSeat < 0 || targetSeat >= maxPlayers) return;
    const targetSeatObj = room.seats[targetSeat];
    if (!targetSeatObj || !targetSeatObj.isBot || !requesterSocket) return;

    const oldBotName = targetSeatObj.name;
    room.seats[targetSeat] = {
      index: targetSeat,
      name: req.playerName,
      socketId: requesterSocket.id,
      isBot: false,
      connected: true
    };

    requesterSocket.roomCode = room.code;
    requesterSocket.seatIndex = targetSeat;
    requesterSocket.currentRoomCode = room.code;
    requesterSocket.currentSeatIndex = targetSeat;
    requesterSocket.join(room.code);
    requesterSocket.emit('join_request_accepted', { roomCode: room.code, seatIndex: targetSeat });
    logAction(room, `🎉 ${req.playerName} ist beigetreten und hat ${oldBotName} ersetzt!`);

    if (room.currentTurn === targetSeat && room.botTimer) {
      clearTimeout(room.botTimer);
      room.botTimer = null;
    }

    socket.emit('join_request_resolved', { requestId, status: 'accepted', seatIndex: targetSeat, playerName: req.playerName });
    broadcastGameState(room);
    broadcastPublicRooms();
    checkBotAction(room);
  });

  socket.on('confirm_midgame_join', ({ roomCode, seatIndex }) => {
    currentRoomCode = roomCode;
    currentSeatIndex = seatIndex;
  });

  socket.on('join_room', ({ roomCode, playerName, preferredSeat }) => {
    console.log(`[SERVER join_room] socket=${socket.id} roomCode=${roomCode} name=${playerName}`);
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) {
      console.log(`[SERVER join_room] Room not found: ${code}. Rooms:`, Array.from(rooms.keys()));
      return socket.emit('error_message', 'Raum nicht gefunden.');
    }

    let existingIndex = room.seats.findIndex(s => s && s.socketId === socket.id);
    if (existingIndex !== -1) {
      currentRoomCode = code;
      currentSeatIndex = existingIndex;
      room.seats[existingIndex].connected = true;
      socket.join(code);
      return broadcastGameState(room);
    }

    if (playerName) {
      const cleanName = playerName.trim().toLowerCase();
      const discIndex = room.seats.findIndex(s => s && !s.isBot && !s.connected && s.name.trim().toLowerCase() === cleanName);
      if (discIndex !== -1) {
        const restored = room.seats[discIndex];
        restored.socketId = socket.id;
        restored.connected = true;
        currentRoomCode = code;
        currentSeatIndex = discIndex;
        socket.join(code);
        logAction(room, `🔄 ${restored.name} wieder da.`);
        return broadcastGameState(room);
      }
    }

    if (room.phase !== 'LOBBY') {
      if (room.settings && room.settings.moneyMode) {
        // Im Geldspiel darf man mitten in einer laufenden Runde nur als Zuschauer rein!
        const specName = (playerName || 'Zuschauer').trim().slice(0, 15);
        if (!room.spectators) room.spectators = [];
        const existingSpec = room.spectators.find(s => s.socketId === socket.id);
        if (!existingSpec) {
          room.spectators.push({
            socketId: socket.id,
            name: specName,
            joinedAt: Date.now()
          });
        }
        currentRoomCode = code;
        currentSeatIndex = -1;
        socket.join(code);
        socket.emit('spectator_joined', { roomCode: code, isSpectator: true, name: specName });
        logAction(room, `👁️ ${specName} schaut der laufenden Geldspiel-Partie zu.`);
        broadcastGameState(room);
        return;
      }
      return handleJoinRequest(socket, code, playerName);
    }

    doNormalJoin(socket, code, playerName, preferredSeat);
  });

  socket.on('reconnect_player', ({ roomCode, playerName, seatIndex }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return;

    if (typeof seatIndex === 'number' && seatIndex >= 0 && room.seats[seatIndex]) {
      const seat = room.seats[seatIndex];
      seat.socketId = socket.id;
      seat.connected = true;
      currentRoomCode = code;
      currentSeatIndex = seatIndex;
      socket.join(code);
      logAction(room, `🔄 ${seat.name} wieder da.`);
      broadcastGameState(room);
      return;
    }

    if (playerName) {
      const cleanName = playerName.trim().toLowerCase();
      const discIndex = room.seats.findIndex(s => s && !s.isBot && s.name.trim().toLowerCase() === cleanName);
      if (discIndex !== -1) {
        const restored = room.seats[discIndex];
        restored.socketId = socket.id;
        restored.connected = true;
        currentRoomCode = code;
        currentSeatIndex = discIndex;
        socket.join(code);
        logAction(room, `🔄 ${restored.name} wieder da.`);
        return broadcastGameState(room);
      }

      if (room.spectators) {
        const spec = room.spectators.find(s => s && s.name && s.name.trim().toLowerCase() === cleanName);
        if (spec) {
          spec.socketId = socket.id;
          currentRoomCode = code;
          currentSeatIndex = -1;
          socket.join(code);
          return broadcastGameState(room);
        }
      }
    }
  });

  socket.on('switch_seat', ({ targetSeat }) => {
    const room = getRoom();
    if (!room || room.phase !== 'LOBBY') return;
    if (targetSeat < 0 || targetSeat >= 6) return;
    if (room.seats[targetSeat] && !room.seats[targetSeat].isBot) return;

    const mySeat = room.seats.find(s => s && s.socketId === socket.id);
    if (!mySeat) return;

    const oldIndex = mySeat.index;
    const targetOccupant = room.seats[targetSeat]; // Bot oder null

    // Swap: Bot auf den alten Platz verschieben statt löschen
    if (targetOccupant && targetOccupant.isBot) {
      targetOccupant.index = oldIndex;
      room.seats[oldIndex] = targetOccupant;
    } else {
      room.seats[oldIndex] = null;
    }

    mySeat.index = targetSeat;
    room.seats[targetSeat] = mySeat;
    currentSeatIndex = targetSeat;
    socket.seatIndex = targetSeat;

    logAction(room, `${mySeat.name} wechselt auf Platz ${targetSeat + 1}.`);
    broadcastGameState(room);
  });

  socket.on('add_bot', ({ seatIndex }) => {
    const room = getRoom();
    if (!room || room.phase !== 'LOBBY') return;
    if (room.settings && room.settings.moneyMode) {
      return socket.emit('error_message', 'Im Geldspiel-Modus sind keine Bots erlaubt.');
    }
    if (seatIndex < 0 || seatIndex >= 6) return;
    if (room.seats[seatIndex]) return;

    const botName = getRandomBotName(room);
    room.seats[seatIndex] = {
      index: seatIndex,
      name: botName,
      socketId: null,
      isBot: true,
      connected: true
    };

    logAction(room, `${botName} hinzugefügt.`);
    broadcastGameState(room);
  });

  socket.on('remove_bot', ({ seatIndex }) => {
    const room = getRoom();
    if (!room || room.phase !== 'LOBBY') return;
    if (seatIndex < 0 || seatIndex >= 6) return;
    if (room.seats[seatIndex] && room.seats[seatIndex].isBot) {
      logAction(room, `${room.seats[seatIndex].name} entfernt.`);
      room.seats[seatIndex] = null;
      broadcastGameState(room);
    }
  });

  socket.on('start_game', () => {
    const room = getRoom();
    if (!room || room.phase !== 'LOBBY') return;
    if (!isPlayerHost(room, socket)) return socket.emit('error_message', 'Nur der Spielleiter kann starten.');

    if (room.settings && room.settings.moneyMode) {
      // Keine Bots im Geldspiel!
      const hasBots = room.seats.some(s => s && s.isBot);
      if (hasBots) {
        room.seats = room.seats.map(s => (s && s.isBot) ? null : s);
        broadcastGameState(room);
        return socket.emit('error_message', 'Im Geldspiel sind keine Bots erlaubt. Bots wurden entfernt.');
      }
    }

    const occupiedSeats = room.seats.filter(s => s !== null);
    if (occupiedSeats.length < 2) {
      return socket.emit('error_message', room.settings.moneyMode
        ? 'Im Geldspiel werden mindestens 2 echte Spieler benötigt.'
        : 'Es werden mindestens 2 Spieler oder Bots benötigt.');
    }
    if (occupiedSeats.length > 6) {
      return socket.emit('error_message', 'Maximal 6 Spieler erlaubt.');
    }

    const playerCount = occupiedSeats.length;
    // Sitze kompakt von 0 bis playerCount-1 durchnummerieren
    room.seats = occupiedSeats.map((s, idx) => {
      s.index = idx;
      return s;
    });

    const startLives = room.settings.initialLives || room.settings.maxPenalty || 7;
    room.settings.playerCount = playerCount;
    room.scores = Array(playerCount).fill(startLives);
    room.eliminated = Array(playerCount).fill(false);
    room.foldedThisRound = Array(playerCount).fill(false);
    room.hands = Array(playerCount).fill(null).map(() => []);
    room.tricksWon = Array(playerCount).fill(0);
    room.dealerIndex = 0;

    // Im Geldspiel: Teilnehmer dieser Partie erfassen & Salden initialisieren
    if (room.settings && room.settings.moneyMode) {
      if (!room.moneyLedger) {
        room.moneyLedger = { sessionBalances: {}, matchHistory: [], currentMatchParticipants: [] };
      }
      room.moneyLedger.currentMatchParticipants = room.seats.filter(s => s !== null).map(s => s.name);
      for (const pName of room.moneyLedger.currentMatchParticipants) {
        if (typeof room.moneyLedger.sessionBalances[pName] !== 'number') {
          room.moneyLedger.sessionBalances[pName] = 0;
        }
      }
      const stakeVal = (typeof room.settings.moneyStake === 'number') ? room.settings.moneyStake : 5.0;
      logAction(room, `💰 Geldspiel gestartet: ${playerCount} Spieler um je ${stakeVal.toFixed(2)} € (Pot: ${(playerCount * stakeVal).toFixed(2)} €).`);
    }

    startNewRound(room);
    broadcastPublicRooms();
  });

  socket.on('restart_game', () => {
    const room = getRoom();
    if (!room || room.phase !== 'GAME_OVER') return;
    if (!isPlayerHost(room, socket)) return socket.emit('error_message', 'Nur der Spielleiter kann neu starten.');

    // Falls Zuschauer da sind und freie Plätze vorhanden sind (< 6), Zuschauer als Spieler einbinden
    promoteWaitingSpectators(room);

    const seatedPlayers = room.seats.filter(s => s !== null);
    const playerCount = seatedPlayers.length;
    room.settings.playerCount = playerCount;
    const startLives = (room.settings && (room.settings.initialLives || room.settings.maxPenalty)) || 7;
    room.scores = Array(6).fill(startLives);
    room.eliminated = Array(6).fill(false);
    room.foldedThisRound = Array(6).fill(false);
    room.hands = Array(6).fill(null).map(() => []);
    room.tricksWon = Array(6).fill(0);
    room.roundNumber = 0;
    room.dealerIndex = 0;

    if (room.settings && room.settings.moneyMode) {
      if (!room.moneyLedger) {
        room.moneyLedger = { sessionBalances: {}, matchHistory: [], currentMatchParticipants: [] };
      }
      room.moneyLedger.currentMatchParticipants = seatedPlayers.map(s => s.name);
      for (const pName of room.moneyLedger.currentMatchParticipants) {
        if (typeof room.moneyLedger.sessionBalances[pName] !== 'number') {
          room.moneyLedger.sessionBalances[pName] = 0;
        }
      }
      const stakeVal = (typeof room.settings.moneyStake === 'number') ? room.settings.moneyStake : 5.0;
      logAction(room, `💰 Neue Geldspiel-Partie gestartet: ${playerCount} Spieler um je ${stakeVal.toFixed(2)} € (Pot: ${(playerCount * stakeVal).toFixed(2)} €).`);
    }

    startNewRound(room);
    broadcastPublicRooms();
  });

  socket.on('next_round', () => {
    const room = getRoom();
    if (!room || room.phase !== 'ROUND_END') return;
    const mySeat = getMySeatIndex(room);
    const isHost = isPlayerHost(room, socket);
    const isAlive = (mySeat !== -1 && isPlayerAlive(room, mySeat));
    if (!isHost && !isAlive) {
      return socket.emit('error_message', 'Nur der Spielleiter oder aktive Spieler können die nächste Runde starten.');
    }

    if (room.roundEndNextRoundLockedUntil && Date.now() < room.roundEndNextRoundLockedUntil) {
      const remSec = Math.ceil((room.roundEndNextRoundLockedUntil - Date.now()) / 1000);
      return socket.emit('error_message', `Trinkpause läuft noch (${remSec}s)... Erst austrinken!`);
    }

    if (room.nextRoundAutoTimer) {
      clearTimeout(room.nextRoundAutoTimer);
      room.nextRoundAutoTimer = null;
    }
    room.roundEndAutoUntil = 0;
    room.roundEndNextRoundLockedUntil = 0;
    startNewRound(room);
  });

  // Trinkspiel: Gewinner verteilt Schlücke an Mitspieler
  socket.on('distribute_sips', ({ targetSeatIndex, count = 1 }) => {
    const room = getRoom();
    if (!room || (room.phase !== 'ROUND_END' && room.phase !== 'GAME_OVER')) return;
    if (!room.roundSummary || !room.roundSummary.drinkingTasks) return;

    const mySeat = getMySeatIndex(room);
    if (mySeat !== room.roundSummary.winnerIndex) {
      return socket.emit('error_message', 'Nur der Rundensieger darf Schlücke verteilen.');
    }

    const tasks = room.roundSummary.drinkingTasks.tasks;
    const winnerTask = tasks.find(t => t.playerIndex === mySeat);
    const targetTask = tasks.find(t => t.playerIndex === targetSeatIndex);

    if (!winnerTask || !targetTask || targetTask.playerIndex === mySeat) return;

    const remainingToDistribute = winnerTask.sipsToDistribute - winnerTask.distributedSips;
    if (remainingToDistribute <= 0) {
      return socket.emit('error_message', 'Du hast bereits alle Schlücke verteilt.');
    }

    const actualCount = Math.min(remainingToDistribute, Math.max(1, count));
    winnerTask.distributedSips += actualCount;
    targetTask.receivedDistributedSips += actualCount;
    targetTask.sipsToDrink += actualCount;
    targetTask.reasons.push(`🎁 +${actualCount} Schluck${actualCount > 1 ? 'e' : ''} von ${winnerTask.playerName} verteilt`);

    broadcastGameState(room);
  });

  // Tuppen Aktionen: Klopfen
  socket.on('knock', () => {
    const room = getRoom();
    if (!room) return;
    handleKnock(room, getMySeatIndex(room));
  });

  // Klopf-Antwort (Mitgehen vs. Passen)
  socket.on('knock_response', ({ decision }) => {
    const room = getRoom();
    if (!room) return;
    handleKnockResponse(room, getMySeatIndex(room), decision);
  });

  // Armuts-Antwort (Mitspielen vs. Passen)
  socket.on('poverty_response', ({ decision }) => {
    const room = getRoom();
    if (!room) return;
    handlePovertyResponse(room, getMySeatIndex(room), decision);
  });

  // 4 Bilder ansagen
  socket.on('declare_four_pictures', () => {
    const room = getRoom();
    if (!room) return;
    handleDeclareFourPictures(room, getMySeatIndex(room));
  });

  // 4 Bilder prüfen oder durchwinken
  socket.on('challenge_four_pictures', ({ challenge, stackId }) => {
    const room = getRoom();
    if (!room) return;
    if (challenge && stackId) {
      handleChallengeFourPicturesStack(room, getMySeatIndex(room), stackId);
    } else {
      handleChallengeFourPictures(room, getMySeatIndex(room), !!challenge);
    }
  });

  // Gezielten 4-Bilder Stapel prüfen
  socket.on('challenge_four_pictures_stack', ({ stackId }) => {
    const room = getRoom();
    if (!room) return;
    handleChallengeFourPicturesStack(room, getMySeatIndex(room), stackId);
  });

  // Karte spielen
  socket.on('play_card', ({ cardId }) => {
    const room = getRoom();
    if (!room) return;
    handleCardPlay(room, getMySeatIndex(room), cardId);
  });

  // Spieleinstellungen aktualisieren
  socket.on('update_settings', ({ settings }) => {
    const room = getRoom();
    if (!room || room.phase !== 'LOBBY') return;
    if (!isPlayerHost(room, socket)) return;

    if (settings) {
      const initLives = settings.initialLives || settings.maxPenalty;
      if (typeof initLives === 'number' && [3, 5, 7, 10, 12].includes(initLives)) {
        room.settings.initialLives = initLives;
        room.settings.maxPenalty = initLives;
        if (room.phase === 'LOBBY') {
          room.scores = Array(room.seats.length).fill(initLives);
        }
      }
      if (typeof settings.allowKloepper === 'boolean') {
        room.settings.allowKloepper = settings.allowKloepper;
        room.settings.allowPoverty = settings.allowKloepper;
      } else if (typeof settings.allowPoverty === 'boolean') {
        room.settings.allowKloepper = settings.allowPoverty;
        room.settings.allowPoverty = settings.allowPoverty;
      }
      if (settings.kloepperStakeMode === 'fixed' || settings.kloepperStakeMode === 'per_player') {
        room.settings.kloepperStakeMode = settings.kloepperStakeMode;
      }
      if (typeof settings.allowFourPictures === 'boolean') {
        room.settings.allowFourPictures = settings.allowFourPictures;
      }
      if (typeof settings.fourPicturesCooldownSeconds === 'number' && settings.fourPicturesCooldownSeconds >= 0 && settings.fourPicturesCooldownSeconds <= 10) {
        room.settings.fourPicturesCooldownSeconds = Math.round(settings.fourPicturesCooldownSeconds);
      }
      if (typeof settings.allowBlindKnock === 'boolean') {
        room.settings.allowBlindKnock = settings.allowBlindKnock;
      }
      if (typeof settings.trickDisplaySeconds === 'number') {
        room.settings.trickDisplaySeconds = Math.round(settings.trickDisplaySeconds * 10) / 10;
      }
      if (typeof settings.dealAndTurnDelaySeconds === 'number') {
        room.settings.dealAndTurnDelaySeconds = Math.round(settings.dealAndTurnDelaySeconds * 10) / 10;
      }
      if (typeof settings.isPublic === 'boolean') {
        room.settings.isPublic = settings.isPublic;
        broadcastPublicRooms();
      }
      if (['off', 'mild', 'medium', 'extreme'].includes(settings.drinkingMode)) {
        room.settings.drinkingMode = settings.drinkingMode;
      }
      if (typeof settings.moneyMode === 'boolean') {
        room.settings.moneyMode = settings.moneyMode;
        if (settings.moneyMode) {
          for (let i = 0; i < room.seats.length; i++) {
            if (room.seats[i] && room.seats[i].isBot) {
              room.seats[i] = null;
            }
          }
          logAction(room, '💰 Geldspiel-Modus aktiviert (alle Bots entfernt).');
        }
      }
      if (typeof settings.moneyStake === 'number' && settings.moneyStake > 0) {
        room.settings.moneyStake = Math.round(settings.moneyStake * 100) / 100;
      }
    }
    broadcastGameState(room);
  });

  // Kassen-Abfrage & Reset
  socket.on('get_money_ledger', () => {
    const room = getRoom();
    if (!room || !room.moneyLedger) return;
    const stake = (room.settings && typeof room.settings.moneyStake === 'number') ? room.settings.moneyStake : 5.0;
    const debtTransfers = calculateDebtSettlement(room.moneyLedger.sessionBalances);
    socket.emit('money_ledger_data', {
      stake,
      sessionBalances: room.moneyLedger.sessionBalances || {},
      matchHistory: room.moneyLedger.matchHistory || [],
      debtTransfers,
      currentMatchParticipants: room.moneyLedger.currentMatchParticipants || []
    });
  });

  socket.on('reset_money_ledger', () => {
    const room = getRoom();
    if (!room || !isPlayerHost(room, socket)) return;
    if (room.moneyLedger) {
      room.moneyLedger.sessionBalances = {};
      room.moneyLedger.matchHistory = [];
      logAction(room, '💰 Kasse wurde vom Spielleiter auf 0 zurückgesetzt.');
      broadcastGameState(room);
      io.to(room.code).emit('money_ledger_reset');
    }
  });

  // Emotes
  socket.on('send_emote', ({ emote }) => {
    const room = getRoom();
    if (!room) return;
    const sIdx = getMySeatIndex(room);
    if (sIdx === -1) return;
    if (!emote || typeof emote !== 'string') return;
    io.to(room.code).emit('player_emote', {
      seatIndex: sIdx,
      emote: emote.slice(0, 8)
    });
  });

  // Verlassen & Kicken
  function handlePlayerLeave() {
    const room = getRoom();
    if (!room) return;
    const currentCode = room.code;

    const mySeat = getMySeatIndex(room);
    if (mySeat === -1) {
      if (room.spectators) {
        const sIdx = room.spectators.findIndex(s => s.socketId === socket.id);
        if (sIdx !== -1) {
          const specName = room.spectators[sIdx].name;
          room.spectators.splice(sIdx, 1);
          logAction(room, `👁️ Zuschauer ${specName} hat das Spiel verlassen.`);
        }
      }
      socket.leave(currentCode);
      socket.emit('left_room');
      currentRoomCode = null;
      currentSeatIndex = -1;
      socket.roomCode = null;
      socket.seatIndex = -1;
      broadcastGameState(room);
      return;
    }

    const player = room.seats[mySeat];
    const playerName = player ? player.name : 'Ein Spieler';
    const leavingSeat = mySeat;
    const isHost = isPlayerHost(room, socket);

    if (room.phase === 'LOBBY') {
      if (isHost) {
        const nextHuman = room.seats.find(s => s && !s.isBot && s.socketId && s.index !== leavingSeat);
        if (nextHuman) {
          room.seats[leavingSeat] = null;
          room.hostSocketId = nextHuman.socketId;
          socket.leave(currentCode);
          socket.emit('left_room');
          broadcastGameState(room);
        } else {
          io.to(currentCode).emit('room_disbanded', { message: 'Der Spielleiter hat die Lobby verlassen.' });
          rooms.delete(currentCode);
          socket.leave(currentCode);
          socket.emit('left_room');
          broadcastPublicRooms();
        }
      } else {
        room.seats[leavingSeat] = null;
        socket.leave(currentCode);
        socket.emit('left_room');
        broadcastGameState(room);
        broadcastPublicRooms();
      }
    } else {
      const remainingHumans = room.seats.filter(s => s && !s.isBot && s.socketId && s.index !== leavingSeat);
      if (remainingHumans.length === 0) {
        if (room.botTimer) clearTimeout(room.botTimer);
        rooms.delete(currentCode);
        socket.leave(currentCode);
        socket.emit('left_room');
        broadcastPublicRooms();
        currentRoomCode = null;
        currentSeatIndex = -1;
        socket.roomCode = null;
        socket.seatIndex = -1;
        return;
      }

      if (room.settings && room.settings.moneyMode) {
        // Im Geldspiel scheidet der Spieler aus - keine Bots für Geld!
        room.seats[leavingSeat].connected = false;
        room.scores[leavingSeat] = 0;
        room.eliminated[leavingSeat] = true;
        logAction(room, `🚪 ${playerName} hat die Geldpartie verlassen und scheidet aus (Einsatz verloren).`);

        if (isHost) {
          room.hostSocketId = remainingHumans[0].socketId;
        }

        socket.leave(currentCode);
        socket.emit('left_room');
        currentRoomCode = null;
        currentSeatIndex = -1;
        socket.roomCode = null;
        socket.seatIndex = -1;

        const earlyWinResolved = cleanupPlayerDeparture(room, leavingSeat);
        const alive = getAlivePlayers(room);
        if (!earlyWinResolved && alive.length <= 1) {
          resolveEarlyWin(room, alive.length === 1 ? alive[0] : 0);
        } else if (!earlyWinResolved) {
          broadcastGameState(room);
          broadcastPublicRooms();
          checkBotAction(room);
        }
        return;
      }

      const newBotName = getRandomBotName(room);
      room.seats[leavingSeat] = {
        index: leavingSeat,
        name: newBotName,
        socketId: null,
        isBot: true,
        connected: true
      };

      if (isHost) {
        room.hostSocketId = remainingHumans[0].socketId;
      }

      socket.leave(currentCode);
      socket.emit('left_room');
      broadcastGameState(room);
      broadcastPublicRooms();
      checkBotAction(room);
    }

    currentRoomCode = null;
    currentSeatIndex = -1;
    socket.roomCode = null;
    socket.seatIndex = -1;
  }

  socket.on('leave_room', handlePlayerLeave);
  socket.on('leave_game', handlePlayerLeave);

  socket.on('kick_player', ({ targetSeat }) => {
    const room = getRoom();
    if (!room || !isPlayerHost(room, socket)) return;

    const target = room.seats[targetSeat];
    if (!target || target.isBot || target.socketId === socket.id) return;

    const kickedName = target.name;
    const kickedSocket = io.sockets.sockets.get(target.socketId);

    if (room.settings && room.settings.moneyMode) {
      // Geldspiel: Ausgeschieden, kein Bot
      room.seats[targetSeat].connected = false;
      room.foldedThisRound[targetSeat] = true;
      room.scores[targetSeat] = 0;
      room.eliminated[targetSeat] = true;
      if (kickedSocket) {
        kickedSocket.leave(room.code);
        kickedSocket.emit('kicked_from_room', { message: 'Du wurdest vom Spielleiter aus der Geldpartie entfernt.' });
      }
      logAction(room, `👢 ${kickedName} wurde aus dem Geldspiel entfernt.`);
      const alive = getAlivePlayers(room);
      if (alive.length <= 1) {
        resolveEarlyWin(room, alive.length === 1 ? alive[0] : 0);
      } else {
        broadcastGameState(room);
        broadcastPublicRooms();
        checkBotAction(room);
      }
      return;
    }

    const newBotName = getRandomBotName(room);
    room.seats[targetSeat] = {
      index: targetSeat,
      name: newBotName,
      socketId: null,
      isBot: true,
      connected: true
    };

    if (kickedSocket) {
      kickedSocket.leave(room.code);
      kickedSocket.emit('kicked_from_room', { message: 'Du wurdest vom Spielleiter aus dem Spiel entfernt.' });
    }

    logAction(room, `👢 ${kickedName} gekickt und durch ${newBotName} ersetzt.`);
    broadcastGameState(room);
    broadcastPublicRooms();
    checkBotAction(room);
  });

  socket.on('kick_lobby_player', ({ targetSeat }) => {
    const room = getRoom();
    if (!room || room.phase !== 'LOBBY' || !isPlayerHost(room, socket)) return;
    if (targetSeat < 0 || targetSeat >= 6) return;

    const target = room.seats[targetSeat];
    if (!target || target.isBot || target.socketId === socket.id) return;

    const kickedSocket = io.sockets.sockets.get(target.socketId);
    room.seats[targetSeat] = null;

    if (kickedSocket) {
      kickedSocket.leave(room.code);
      kickedSocket.emit('kicked_from_room', { message: 'Du wurdest vom Spielleiter aus der Lobby gekickt.' });
    }

    broadcastGameState(room);
    broadcastPublicRooms();
  });

  socket.on('return_to_lobby', () => {
    const room = getRoom();
    if (!room || !isPlayerHost(room, socket)) return;

    if (room.botTimer) clearTimeout(room.botTimer);

    room.phase = 'LOBBY';
    room.currentTrick = [];
    room.trickCount = 0;
    while (room.seats.length < 6) {
      room.seats.push(null);
    }

    // Falls Zuschauer da sind, freie Plätze in der Lobby anbieten
    promoteWaitingSpectators(room);

    room.hands = Array(6).fill(null).map(() => []);
    const startLives = (room.settings && (room.settings.initialLives || room.settings.maxPenalty)) || 7;
    room.scores = Array(6).fill(startLives);
    room.eliminated = Array(6).fill(false);
    room.roundNumber = 0;

    logAction(room, `🏠 Zurück in der Lobby.`);
    broadcastGameState(room);
    broadcastPublicRooms();
  });

  socket.on('disconnect', () => {
    const room = getRoom();
    if (!room) return;

    const mySeat = getMySeatIndex(room);
    if (mySeat === -1) {
      // Zuschauer hat die Verbindung getrennt
      if (room.spectators) {
        const sIdx = room.spectators.findIndex(s => s.socketId === socket.id);
        if (sIdx !== -1) {
          room.spectators.splice(sIdx, 1);
          broadcastGameState(room);
        }
      }
      return;
    }

    if (room.seats[mySeat]) {
      const seatIdx = mySeat;
      room.seats[seatIdx].connected = false;

      // Host-Transfer
      if (room.hostSocketId === socket.id) {
        const nextHuman = room.seats.find(s => s && !s.isBot && s.socketId && s.connected !== false && s.index !== seatIdx);
        if (nextHuman) room.hostSocketId = nextHuman.socketId;
      }

      const anyHuman = room.seats.some(s => s && !s.isBot && s.connected !== false);
      if (!anyHuman) {
        if (room.botTimer) clearTimeout(room.botTimer);
        rooms.delete(room.code);
        broadcastPublicRooms();
        return;
      }

      if (room.settings && room.settings.moneyMode) {
        // Im Geldspiel keinen Bot einsetzen!
        const activePhases = ['PLAY_TRICK', 'KNOCK_DECISION', 'POVERTY_CHECK', 'FOUR_PICTURES_CHALLENGE'];
        if (activePhases.includes(room.phase) && !room.eliminated[seatIdx] && !room.foldedThisRound[seatIdx]) {
          logAction(room, `📡 ${room.seats[seatIdx].name} hat die Verbindung verloren und scheidet aus.`);
          room.scores[seatIdx] = 0;
          room.eliminated[seatIdx] = true;
          const earlyWinResolved = cleanupPlayerDeparture(room, seatIdx);
          const alive = getAlivePlayers(room);
          if (!earlyWinResolved && alive.length <= 1) {
            resolveEarlyWin(room, alive.length === 1 ? alive[0] : 0);
          } else if (!earlyWinResolved) {
            broadcastGameState(room);
            checkBotAction(room);
          }
        } else {
          broadcastGameState(room);
        }
        broadcastPublicRooms();
        return;
      }

      // Mid-game auto-fold & bot replacement für normale Runden
      const activePhases = ['PLAY_TRICK', 'KNOCK_DECISION', 'POVERTY_CHECK', 'FOUR_PICTURES_CHALLENGE'];
      if (activePhases.includes(room.phase) && !room.eliminated[seatIdx] && !room.foldedThisRound[seatIdx]) {
        const playerName = room.seats[seatIdx].name;
        const botName = getRandomBotName(room);
        logAction(room, `📡 ${playerName} hat die Verbindung verloren und wird durch ${botName} (Bot) ersetzt.`);

        // Replace with bot
        room.seats[seatIdx] = {
          index: seatIdx,
          name: botName,
          socketId: null,
          isBot: true,
          connected: true
        };

        broadcastGameState(room);
        checkBotAction(room);
      } else {
        broadcastGameState(room);
      }
      broadcastPublicRooms();
    }
  });
});

// Server starten
server.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(` Tuppen Server läuft auf Port ${PORT}`);
  console.log(` Lokal: http://localhost:${PORT}`);
  console.log(`=========================================`);
});
