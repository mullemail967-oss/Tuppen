/**
 * Tuppen Bot AI Engine
 * 
 * Taktische Heuristiken für Bots im traditionellen Spiel Tuppen:
 * - Ziel: Den 4. und letzten Stich gewinnen.
 * - 10er und 9er für den entscheidenden 4. Stich schonen.
 * - Kluges Klopfen & Reagieren (Mitgehen vs. Passen).
 * - "4 Bilder" ansagen (und bluffen) sowie Herausfordern.
 * - Armut-Entscheidung (Mitspielen vs. Passen).
 */

const {
  SUITS,
  RANKS,
  RANK_POWER,
  isCardPlayable,
  evaluateTrick,
  canPlayerKnock,
  hasFourPictures
} = require('./tuppen-rules');

/**
 * Bewertet die absolute Spielstärke einer Hand für Tuppen.
 * 10er sind die stärksten Karten, gefolgt von 9ern und 8ern.
 */
function evaluateHandStrength(hand) {
  if (!hand || hand.length === 0) return 0;
  let score = 0;
  for (const card of hand) {
    const power = RANK_POWER[card.rank] || 0;
    if (card.rank === '10') score += 35;
    else if (card.rank === '9') score += 20;
    else if (card.rank === '8') score += 12;
    else if (card.rank === '7') score += 7;
    else if (card.rank === 'A') score += 4;
    else if (card.rank === 'K') score += 2;
    else if (card.rank === 'Q') score += 1;
    else score += 0; // J = 0
  }
  return score;
}

/**
 * Wählt taktisch die beste spielbare Karte aus der Hand des Bots.
 * 
 * @param {Array<object>} hand - Eigene Handkarten
 * @param {Array<object>} currentTrick - Aktuell gespielte Karten im Stich
 * @param {number} trickIndex - Stichnummer (0 bis 3)
 * @param {number} botIndex - Sitzplatz des Bots
 * @returns {object} Die ausgewählte Karte
 */
function chooseCardToPlay(hand, currentTrick, trickIndex, botIndex, foldedIndices = []) {
  if (!hand || hand.length === 0) return null;

  const playable = hand.filter(c => isCardPlayable(c, hand, currentTrick));
  if (playable.length === 0) return hand[0];
  if (playable.length === 1) return playable[0];

  const isLastTrick = (trickIndex === 3 || hand.length === 1);

  // --------------------------------------------------------------------------
  // SITUATION A: DER 4. UND LETZTE STICH (ENTSCHEIDENDER STICH!)
  // --------------------------------------------------------------------------
  if (isLastTrick) {
    // 1. Ausspiel im 4. Stich: Höchste verfügbare Karte spielen!
    if (!currentTrick || currentTrick.length === 0) {
      return sortCardsByPowerDesc(playable)[0];
    }

    // 2. Bedienen im 4. Stich: Wenn möglich den Stich gewinnen!
    const leadSuit = currentTrick[0].card.suit;
    const currentWinner = evaluateTrick(currentTrick, foldedIndices);
    const bestPowerSoFar = RANK_POWER[currentWinner.winningCard.rank] || 0;

    // Gewinner-Karten ermitteln
    const winningCards = playable.filter(c => c.suit === leadSuit && RANK_POWER[c.rank] > bestPowerSoFar);

    if (winningCards.length > 0) {
      // Sparsamster Sieg: Die niedrigste gewinnende Karte nehmen
      return sortCardsByPowerAsc(winningCards)[0];
    }

    // Kann nicht gewinnen: Niedrigste Karte abwerfen
    return sortCardsByPowerAsc(playable)[0];
  }

  // --------------------------------------------------------------------------
  // SITUATION B: STICHE 1 BIS 3 (VORBEREITUNG AUF DEN 4. STICH)
  // --------------------------------------------------------------------------
  const hasLead = (!currentTrick || currentTrick.length === 0);

  // Fall B1: Bot spielt aus (Lead) in Stich 1, 2 oder 3
  if (hasLead) {
    // In Stich 3: Wenn Bot eine unschlagbare 10 für Stich 4 in Reserve hat,
    // versucht er gerne Stich 3 zu gewinnen, um auch in Stich 4 auszuspielen!
    const tensCount = hand.filter(c => c.rank === '10').length;
    const ninesCount = hand.filter(c => c.rank === '9').length;

    // Wenn Bot schwächere Karten hat (J, Q, K, A), spielt er diese zuerst an,
    // um die hohen Karten der Gegner zu locken und seine 10er/9er zu schonen
    const lowCards = playable.filter(c => ['J', 'Q', 'K', 'A'].includes(c.rank));
    if (lowCards.length > 0 && (tensCount > 0 || ninesCount > 0)) {
      return sortCardsByPowerAsc(lowCards)[0];
    }

    // Ansonsten niedrigste verfügbare Karte spielen
    return sortCardsByPowerAsc(playable)[0];
  }

  // Fall B2: Bot bedient oder wirft ab in Stich 1, 2 oder 3
  const leadSuit = currentTrick[0].card.suit;
  const currentWinner = evaluateTrick(currentTrick, foldedIndices);
  const bestPowerSoFar = RANK_POWER[currentWinner.winningCard.rank] || 0;

  // Kann der Bot mitgehen/gewinnen?
  const matchingCards = playable.filter(c => c.suit === leadSuit);

  if (matchingCards.length > 0) {
    // Bot MUSS bedienen!
    const winningCards = matchingCards.filter(c => RANK_POWER[c.rank] > bestPowerSoFar);

    // Wenn Stich 1 oder 2:
    if (trickIndex < 2) {
      // Wenn der Führende bereits mit 10 oder 9 führt: Eigene 10 nicht verschwenden, kleinste Karte zugeben!
      if (bestPowerSoFar >= RANK_POWER['9']) {
        return sortCardsByPowerAsc(matchingCards)[0];
      }

      // Wenn wir mit einer kleinen Karte (z.B. 7 oder 8) billig stechen können:
      const cheapWins = winningCards.filter(c => c.rank !== '10');
      if (cheapWins.length > 0) {
        return sortCardsByPowerAsc(cheapWins)[0];
      }

      // 10er für Stich 4 schonen!
      return sortCardsByPowerAsc(matchingCards)[0];
    }

    // Wenn Stich 3:
    // Hier lohnt sich ein Stichgewinn, wenn man für Stich 4 eine starke Karte (10 oder 9) hat!
    if (winningCards.length > 0) {
      const remainingTenOrNine = hand.filter(c => (c.rank === '10' || c.rank === '9') && !winningCards.includes(c));
      if (remainingTenOrNine.length > 0) {
        // Gewinne Stich 3 mit der kleinstmöglichen gewinnenden Karte!
        return sortCardsByPowerAsc(winningCards)[0];
      }
    }

    // Ansonsten kleinste Karte bedienen
    return sortCardsByPowerAsc(matchingCards)[0];
  }

  // Kann nicht bedienen: Niedrigste unbrauchbare Karte abwerfen (Abwurf/Schnorren)
  return sortCardsByPowerAsc(playable)[0];
}

/**
 * Entscheidet, ob der Bot klopfen (bzw. nachklopfen) soll.
 * 
 * @param {Array<object>} hand - Eigene Handkarten
 * @param {number} currentStake - Aktueller Runden-Einsatz (1, 2, 3...)
 * @param {number} botScore - Aktuelle Strafpunkte des Bots
 * @param {Array<number>} activeScores - Strafpunkte aller aktiven Spieler
 * @param {number} botIndex - Sitz des Bots
 * @param {number|null} lastKnocker - Wer zuletzt geklopft hat
 * @returns {boolean}
 */
function shouldBotKnock(hand, currentStake, botScore, activeScores, botIndex, lastKnocker, activePlayerIndices) {
  const activeIndices = activePlayerIndices || (Array.isArray(activeScores) ? activeScores.map((_, i) => i) : Object.keys(activeScores).map(Number));
  if (!canPlayerKnock(activeScores, activeIndices, currentStake, botIndex, lastKnocker)) {
    return false;
  }

  const strength = evaluateHandStrength(hand);
  const tens = hand.filter(c => c.rank === '10').length;
  const nines = hand.filter(c => c.rank === '9').length;

  // Stufe 1 -> 2:
  if (currentStake === 1) {
    // Bot hat mindestens zwei 10er ODER eine 10 und einen 9er: Sehr stark!
    if (tens >= 2 || (tens >= 1 && nines >= 1)) {
      return true;
    }
    // Handstärke über 45 und Bot hat noch genügend Leben (>= 3)
    if (strength >= 45 && botScore >= 3 && Math.random() < 0.75) {
      return true;
    }
    // Bluff-Chance: 6%
    if (botScore >= 3 && Math.random() < 0.06) {
      return true;
    }
  }

  // Nachklopfen (Stufe 2 -> 3 oder höher):
  if (currentStake >= 2) {
    // Nur bei exzellenter Hand nachklopfen (mind. zwei 10er oder 10 + 9 + 8)
    if (tens >= 2 || (tens >= 1 && nines >= 2)) {
      return true;
    }
    if (strength >= 70 && botScore >= 3 && Math.random() < 0.5) {
      return true;
    }
  }

  return false;
}

/**
 * Entscheidet, ob der Bot auf ein fremdes Klopfen mitgehen ('call') oder passen ('fold') soll.
 * 
 * @param {Array<object>} hand - Eigene Handkarten
 * @param {number} currentStake - Bisheriger Einsatz (den man beim Passen als Leben verliert)
 * @param {number} nextStake - Neuer Einsatz (den man beim Mitgehen im Verlustfall riskiert)
 * @param {number} botScore - Eigene verbleibende Leben
 * @returns {'call'|'fold'}
 */
function shouldBotFoldOrCall(hand, currentStake, nextStake, botScore) {
  // Wichtigste Überlebensregel:
  // Wenn der Bot beim PASSEN (currentStake Leben) ohnehin auf <= 0 Leben fällt
  // und somit ausscheiden würde (botScore <= currentStake),
  // MUSS der Bot immer MITGEHEN ('call')!
  // Denn beim Passen ist er sicher tot, beim Mitgehen hat er noch eine Siegchance.
  if (botScore <= currentStake) {
    return 'call';
  }

  const strength = evaluateHandStrength(hand);
  const tens = hand.filter(c => c.rank === '10').length;
  const nines = hand.filter(c => c.rank === '9').length;

  // Starke Hände gehen fast immer mit
  if (tens >= 1 || nines >= 2 || strength >= 35) {
    return 'call';
  }

  // Mittlere Hände (mindestens eine 9 oder 8er-Kombination)
  if (nines >= 1 || strength >= 20) {
    // Wenn der Bot noch viele Leben hat, traut er sich eher
    if (botScore >= 3) {
      return Math.random() < 0.7 ? 'call' : 'fold';
    }
    return Math.random() < 0.4 ? 'call' : 'fold';
  }

  // Schwache Hand (nur Bilder J, Q, K oder niedrige 7er):
  // Lieber für currentStake passen als nextStake zu riskieren!
  return 'fold';
}

/**
 * Entscheidet, ob der Bot zu Beginn der Runde "4 Bilder" ansagen soll.
 * Bilderkarten: Bube, Dame, König, Ass.
 */
function shouldBotDeclare4Pictures(hand) {
  // Wenn der Bot wirklich 4 Bilder hat: IMMER ansagen und gegen frische Karten tauschen!
  if (hasFourPictures(hand)) {
    return true;
  }

  // Bluff-Möglichkeit: Hat der Bot 3 Bilder und eine schwache 7?
  // Gelegentlich (8%) bluffen, um bessere Karten zu ziehen
  if (hand && hand.length === 4) {
    const picCount = hand.filter(c => ['J', 'Q', 'K', 'A'].includes(c.rank)).length;
    if (picCount === 3 && Math.random() < 0.08) {
      return true;
    }
  }

  return false;
}

/**
 * Entscheidet, ob der Bot die 4-Bilder-Ansage eines Gegners herausfordern soll.
 */
function shouldBotChallenge4Pictures(botScore) {
  // Wenn der Bot bei einer Fehlentscheidung (1 Leben) ausscheiden würde (botScore <= 1):
  // Niemals herausfordern!
  if (botScore <= 1) {
    return false;
  }

  // Die meisten 4-Bilder-Ansagen sind echt.
  // Challenge nur mit ca. 12% Wahrscheinlichkeit bei komfortablen Leben (>= 3)
  if (botScore >= 3 && Math.random() < 0.12) {
    return true;
  }

  return false;
}

/**
 * Entscheidet, ob der Bot in der Klöpper-Phase (ein Mitspieler hat 1 Leben)
 * mitspielen ('play') oder passen ('fold') soll.
 */
function shouldBotPlayUnderPoverty(hand, botScore) {
  // Wer passt, verliert 1 Leben. Wer mitspielt und verliert, verliert den Klöpper-Einsatz.
  // Wenn Passen zum Ausscheiden führt: Immer mitspielen!
  if (botScore <= 1) {
    return 'play';
  }

  const strength = evaluateHandStrength(hand);
  const tens = hand.filter(c => c.rank === '10').length;
  const nines = hand.filter(c => c.rank === '9').length;

  // Wenn Bot eine 10 oder 9 hat: Gerne mitspielen (Siegchancen gut)
  if (tens >= 1 || nines >= 1 || strength >= 25) {
    return 'play';
  }

  // Bei schwachen Karten lieber 1 Leben abgeben als den Klöpper-Einsatz zu riskieren
  return 'fold';
}

function sortCardsByPowerAsc(cards) {
  return [...cards].sort((a, b) => (RANK_POWER[a.rank] || 0) - (RANK_POWER[b.rank] || 0));
}

function sortCardsByPowerDesc(cards) {
  return [...cards].sort((a, b) => (RANK_POWER[b.rank] || 0) - (RANK_POWER[a.rank] || 0));
}

module.exports = {
  evaluateHandStrength,
  chooseCardToPlay,
  shouldBotKnock,
  shouldBotFoldOrCall,
  shouldBotDeclare4Pictures,
  shouldBotChallenge4Pictures,
  shouldBotPlayUnderPoverty
};
