/**
 * Tuppen Rule Engine
 * 
 * Traditionelles Kartenspiel Tuppen:
 * - 32-Karten Piquet-Deck (7, 8, 9, 10, J, Q, K, A)
 * - Rangfolge (niedrig nach hoch): Bube, Dame, König, Ass, 7, 8, 9, 10
 * - Reiner Farbzwang (Bedienpflicht). Kein Trumpf!
 * - 4 Handkarten, genau 4 Stiche pro Runde.
 * - Ziel: Den 4. und letzten Stich gewinnen.
 * - Strafpunkte 0 bis 10. Wer 10 Punkte erreicht, scheidet aus.
 */

const SUITS = {
  CLUBS: 'clubs',       // Kreuz ♣
  SPADES: 'spades',     // Pik ♠
  HEARTS: 'hearts',     // Herz ♥
  DIAMONDS: 'diamonds'  // Karo ♦
};

// Rangfolge von niedrig nach hoch: Bube (1) bis 10 (8)
const RANKS = ['J', 'Q', 'K', 'A', '7', '8', '9', '10'];

const RANK_POWER = {
  'J': 1,   // Bube (am schwächsten)
  'Q': 2,   // Dame
  'K': 3,   // König
  'A': 4,   // Ass
  '7': 5,   // 7
  '8': 6,   // 8
  '9': 7,   // 9
  '10': 8   // 10 (am stärksten!)
};

// Bilderkarten für die "4 Bilder"-Regel: Bube, Dame, König, Ass
const PICTURE_RANKS = ['J', 'Q', 'K', 'A'];

/**
 * Prüft, ob eine Karte eine Bilderkarte (Bube, Dame, König, Ass) ist.
 */
function isPictureCard(card) {
  if (!card) return false;
  return PICTURE_RANKS.includes(card.rank);
}

/**
 * Prüft, ob eine Hand aus genau 4 echten Bilderkarten besteht.
 */
function hasFourPictures(hand) {
  if (!hand || hand.length !== 4) return false;
  return hand.every(c => isPictureCard(c));
}

/**
 * Erstellt ein neues 32-Karten Piquet-Deck (7 bis 10, J, Q, K, A in 4 Farben).
 */
function createDeck() {
  const deck = [];
  for (const suit of Object.values(SUITS)) {
    for (const rank of RANKS) {
      deck.push({
        id: `${suit}_${rank}`,
        suit: suit,
        rank: rank,
        power: RANK_POWER[rank]
      });
    }
  }
  return deck;
}

/**
 * Mischt das Deck (Fisher-Yates Shuffle).
 */
function shuffleDeck(deck) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Prüft, ob ein Spieler eine bestimmte Karte regelkonform spielen darf.
 * 
 * Tuppen-Stichregeln:
 * 1. Wird eine Karte angespielt, bestimmt ihre Farbe die Bedienpflicht (Farbzwang).
 * 2. Hat der Spieler mindestens eine Karte der angespielten Farbe, MUSS er diese bedienen.
 * 3. Kann der Spieler nicht bedienen, darf er JEDE beliebige Karte spielen.
 * 4. Es gibt keinen Trumpf und keinen Überstichzwang.
 */
function isCardPlayable(cardToPlay, playerHand, currentTrick) {
  if (!cardToPlay || !playerHand || playerHand.length === 0) {
    return false;
  }

  // Die Karte muss sich auf der Hand befinden
  const cardInHand = playerHand.some(c => 
    cardToPlay.id ? c.id === cardToPlay.id : (c.suit === cardToPlay.suit && c.rank === cardToPlay.rank)
  );
  if (!cardInHand) {
    return false;
  }

  // Wenn noch keine Karte im Stich liegt (Ausspiel): Jede Karte ist erlaubt
  let leadCard = null;
  if (Array.isArray(currentTrick)) {
    if (currentTrick.length === 0) return true;
    leadCard = currentTrick[0].card;
  } else if (currentTrick && currentTrick.card) {
    leadCard = currentTrick.card;
  } else if (currentTrick && currentTrick.suit) {
    leadCard = currentTrick;
  }

  if (!leadCard) {
    return true;
  }

  const leadSuit = leadCard.suit;
  const hasLeadSuit = playerHand.some(c => c.suit === leadSuit);

  if (hasLeadSuit) {
    // Spieler besitzt Karten der angespielten Farbe -> Muss bedienen!
    return cardToPlay.suit === leadSuit;
  }

  // Hat die angespielte Farbe nicht: Jede beliebige Karte darf gespielt werden
  return true;
}

/**
 * Ermittelt den Gewinner eines Stichs in Tuppen.
 * 
 * Regel:
 * - Nur Karten, die dieselbe Farbe wie die angespielte Karte (leadCard) haben, können gewinnen.
 * - Unter allen kartenkonformen Beiträgen gewinnt die Karte mit der höchsten RANK_POWER.
 * 
 * @param {Array<{playerIndex: number, card: object}>} trick
/**
 * Wertet einen Stich nach den offiziellen Tuppen-Regeln aus.
 * 
 * Regeln:
 * - Keine Trümpfe.
 * - Es herrscht strikter Farbzwang zur zuerst ausgespielten Karte (leadSuit).
 * - Nur eine Karte derselben Farbe wie die angespielte Farbe kann den Stich gewinnen.
 * - Unter mehreren Karten der angespielten Farbe gewinnt die Karte mit der höchsten Rangstärke.
 * - WICHTIG: Spieler, die gepasst haben (foldedIndices), sind aus der Runde ausgeschieden.
 *   Ihre Karten können den Stich NIEMALS gewinnen!
 * - Falls der Ausspieler der Runde gepasst hat, bestimmt seine Karte zwar weiterhin die
 *   angespielte Farbe (Farbzwang), aber gewonnen wird der Stich von der höchsten Karte
 *   der angespielten Farbe eines NOCH AKTIVEN (nicht gepassten) Spielers.
 * - Falls kein aktiver Spieler die angespielte Farbe bedienen konnte, gewinnt die Karte
 *   des ersten aktiven Spielers, der zu diesem Stich gelegt hat.
 * 
 * @param {Array<{playerIndex: number, card: object}>} trick - Die gelegten Karten im Stich
 * @param {Array<number>|Set<number>} [foldedIndices=[]] - Indizes der Spieler, die gepasst haben
 * @returns {{winnerIndex: number, winningCard: object}}
 */
function evaluateTrick(trick, foldedIndices = []) {
  if (!trick || trick.length === 0) {
    throw new Error('Stich ist leer.');
  }

  const foldedSet = Array.isArray(foldedIndices)
    ? new Set(foldedIndices)
    : (foldedIndices instanceof Set ? foldedIndices : new Set());

  // Alle Einträge von Spielern, die NICHT gepasst haben
  const activeEntries = trick.filter(entry => !foldedSet.has(entry.playerIndex));

  // Fallback: Wenn alle gelegt habenden Spieler gepasst haben sollten (extrem selten)
  if (activeEntries.length === 0) {
    return {
      winnerIndex: trick[0].playerIndex,
      winningCard: trick[0].card
    };
  }

  // Die angespielte Farbe wird immer von der ALLERERSTEN Karte des Stichs bestimmt
  const leadCard = trick[0].card;
  const leadSuit = leadCard.suit;

  // Aktive Karten in der angespielten Farbe
  const leadSuitEntries = activeEntries.filter(entry => entry.card.suit === leadSuit);

  if (leadSuitEntries.length > 0) {
    let bestEntry = leadSuitEntries[0];
    let bestPower = RANK_POWER[bestEntry.card.rank] || 0;

    for (let i = 1; i < leadSuitEntries.length; i++) {
      const entry = leadSuitEntries[i];
      const power = RANK_POWER[entry.card.rank] || 0;
      if (power > bestPower) {
        bestPower = power;
        bestEntry = entry;
      }
    }

    return {
      winnerIndex: bestEntry.playerIndex,
      winningCard: bestEntry.card
    };
  }

  // Falls kein aktiver Spieler die angespielte Farbe bedienen konnte:
  // Erste aktive Karte im Stich gewinnt (da Fehlfarben ohne Trumpf nicht stechen können)
  return {
    winnerIndex: activeEntries[0].playerIndex,
    winningCard: activeEntries[0].card
  };
}

/**
 * Prüft, ob ein Klopfen / Nachklopfen für einen Spieler zulässig ist.
 * 
 * Regeln:
 * 1. Spieler ist noch aktiv in der Runde.
 * 2. Spieler hat nicht als letztes selbst geklopft.
 * 3. Wer am Klöpper steht (<= 1 Leben), kann NICHT klopfen (kein Überklopfen).
 * 4. Der neue Rundeneinsatz (currentStake + 1) darf die verbleibenden Leben der aktiven Spieler
 *    (die mehr als 1 Leben haben) nicht übersteigen.
 *    (Ein Spieler am Klöpper mit 1 Leben ist all-in und begrenzt das Klopfen der anderen nicht).
 * 
 * @param {Array<number>} playerLives - Aktuelle Leben aller Spieler
 * @param {Array<number>} activePlayerIndices - Indizes der in der Runde aktiven Spieler
 * @param {number} currentStake - Aktueller Runden-Einsatz
 * @param {number} playerIndex - Spieler, der klopfen möchte
 * @param {number|null} lastKnocker - Wer hat zuletzt geklopft
 * @returns {boolean}
 */
function canPlayerKnock(playerLives, activePlayerIndices, currentStake, playerIndex, lastKnocker) {
  if (!activePlayerIndices.includes(playerIndex)) return false;
  if (lastKnocker === playerIndex) return false;

  // Wer am Klöpper steht (<= 1 Leben), kann nicht klopfen
  const myLives = playerLives[playerIndex] || 0;
  if (myLives <= 1) return false;

  const nextStake = currentStake + 1;

  // Der Knocker selbst muss genügend Leben haben
  if (nextStake > myLives) return false;

  // Mindestens ein aktiver Gegenspieler muss ebenfalls genügend Leben haben (>= nextStake).
  // Spieler mit weniger Leben (z. B. 1 oder 2 Leben) sind all-in bzw. können nur ihre Restleben verlieren
  // und blockieren nicht das gegenseitige Hochklopfen der Spieler mit mehr Leben.
  const hasOpponentWithEnoughLives = activePlayerIndices.some(idx => {
    if (idx === playerIndex) return false;
    return (playerLives[idx] || 0) >= nextStake;
  });

  if (!hasOpponentWithEnoughLives) return false;

  return true;
}

/**
 * Sortiert Handkarten für Tuppen:
 * Nach Farben geordnet und innerhalb der Farbe nach Rang (10 zuerst, dann 9..7, Ass..Bube).
 */
function sortHand(hand) {
  const suitOrder = { [SUITS.HEARTS]: 0, [SUITS.DIAMONDS]: 1, [SUITS.SPADES]: 2, [SUITS.CLUBS]: 3 };

  hand.sort((a, b) => {
    if (a.suit !== b.suit) {
      return (suitOrder[a.suit] || 99) - (suitOrder[b.suit] || 99);
    }
    // Höhere Stärke (10) vor niedrigerer Stärke (J)
    return (RANK_POWER[b.rank] || 0) - (RANK_POWER[a.rank] || 0);
  });
}

module.exports = {
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
};
