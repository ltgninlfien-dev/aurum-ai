// app/lib/shadowEngine.js
// Moteur de "shadow trading" — simule des positions complètes avec le moteur V2
// (scoreEngine + positionManager), en paper trading fictif totalement séparé du bot réel.
// Objectif : accumuler un historique de trades V2 pour calculer des statistiques fiables
// avant de basculer le vrai bot dessus.

import { calculateScore } from './scoreEngine';
import { createPosition, evaluatePosition } from './positionManager';
import { checkTradeContext } from './aiTradeAnalysis';
import { adjustV2ThresholdFromHistory } from './v2LearningEngine';
import {
  getRiskPause,
  getPositionSizeMultiplier,
  STARTING_CAPITAL,
  RISK_PER_TRADE,
  MAX_JUDGMENT_LOG_SIZE,
} from './tradingEngine';

// Ajoute une entrée au journal shadow, avec rotation (même principe que judgmentLog réel)
function logShadowEntry(log, entry) {
  const updated = [...(log || []), entry];
  return updated.length > MAX_JUDGMENT_LOG_SIZE
    ? updated.slice(updated.length - MAX_JUDGMENT_LOG_SIZE)
    : updated;
}

// Marché XAU/USD fermé de vendredi 21h UTC à dimanche 24h UTC (dimanche inclus en entier) —
// pendant cette fenêtre, aucun mouvement de prix réel n'a lieu. On ferme toute position
// ouverte à l'entrée de la fenêtre pour éviter un risque de gap au lundi, et on n'ouvre
// aucune nouvelle position tant que le marché n'a pas rouvert. S'applique TOUJOURS,
// bot réel et shadow, puisque le marché est réellement fermé pour les deux.
function isWeekendClosureWindow(date = new Date()) {
  const day = date.getUTCDay(); // 0 = Dimanche ... 5 = Vendredi, 6 = Samedi
  const hour = date.getUTCHours();
  if (day === 5 && hour >= 21) return true; // Vendredi dès 21h UTC
  if (day === 6) return true; // Samedi toute la journée
  if (day === 0) return true; // Dimanche toute la journée
  return false;
}

// Fenêtre d'observation étendue : de vendredi 21h UTC à mardi 23h UTC, le bot RÉEL
// n'ouvre aucune nouvelle position — il continue de calculer le score et de logger
// chaque cycle, mais reste en pure observation pendant la réouverture du marché
// (période jugée plus imprévisible : gaps, faible liquidité en début de semaine).
// Optionnelle : seul le bot réel l'applique (via options.applyObservationWindow),
// le shadow continue de trader normalement pour garder une base de comparaison.
function isObservationWindow(date = new Date()) {
  const day = date.getUTCDay(); // 0 = Dimanche ... 5 = Vendredi, 6 = Samedi
  const hour = date.getUTCHours();
  if (day === 5 && hour >= 21) return true; // Vendredi dès 21h UTC
  if (day === 6 || day === 0 || day === 1) return true; // Samedi, Dimanche, Lundi entiers
  if (day === 2 && hour < 23) return true; // Mardi jusqu'à 23h UTC
  return false;
}

/**
 * État shadow initial (à utiliser si aucune clé Redis n'existe encore)
 */
export function createInitialShadowState() {
  return {
    trades: [],
    openPosition: null,
    account: { balance: STARTING_CAPITAL, equity: STARTING_CAPITAL },
    shadowLog: [],
    params: { thresholdAdjustment: 0 },
    lastCheckedAt: null,
  };
}

/**
 * Exécute un cycle complet de shadow trading V2 : calcule le score, gère la position
 * ouverte s'il y en a une (break-even, trailing, clôture), ou envisage une ouverture.
 * @param {Object} state - état shadow courant (voir createInitialShadowState)
 * @param {Array} candles5min - bougies 5min (250 recommandé)
 * @param {Array} candles1h - bougies 1h
 * @param {string} symbol - 'XAU/USD' ou 'EUR/USD', nécessaire pour la vérification IA
 * @param {Object} [options]
 * @param {boolean} [options.applyObservationWindow] - si true, bloque toute nouvelle
 *   ouverture de vendredi 21h UTC à mardi 23h UTC (réservé au bot réel ; le shadow
 *   continue de trader normalement pour garder une base de comparaison)
 * @returns {Promise<Object>} nouvel état shadow à persister
 */
export async function runShadowCycle(state, candles5min, candles1h, symbol, options = {}) {
  const { applyObservationWindow = false } = options;
  const currentPrice = candles5min[candles5min.length - 1].close;
  const params = state.params || { thresholdAdjustment: 0 };

  let { trades, openPosition, account, shadowLog } = state;

  // --- Fermeture forcée avant le weekend (marché fermé) ---
  if (isWeekendClosureWindow()) {
    if (openPosition) {
      const pnlPct =
        openPosition.direction === 'BUY'
          ? (currentPrice - openPosition.entryPrice) / openPosition.entryPrice
          : (openPosition.entryPrice - currentPrice) / openPosition.entryPrice;

      const pnl = openPosition.positionSize * pnlPct;

      const closedTrade = {
        ...openPosition,
        status: 'closed',
        exitPrice: currentPrice,
        pnl,
        pnlPct,
        closedAt: Date.now(),
        closeReason: 'weekend_closure',
      };

      const newTrades = [...trades, closedTrade];
      const newAccount = { balance: account.balance + pnl, equity: account.balance + pnl };
      const learning = adjustV2ThresholdFromHistory(newTrades, params.thresholdAdjustment);
      const newParams = { ...params, thresholdAdjustment: learning.adjustment };

      return {
        trades: newTrades,
        openPosition: null,
        account: newAccount,
        params: newParams,
        shadowLog: logShadowEntry(shadowLog, {
          timestamp: Date.now(),
          outcome: 'closed',
          closeReason: 'weekend_closure',
          learning,
        }),
        lastCheckedAt: Date.now(),
      };
    }

    // Pas de position ouverte : on n'engage rien tant que le marché est fermé
    return {
      trades,
      openPosition: null,
      account,
      params,
      shadowLog: logShadowEntry(shadowLog, {
        timestamp: Date.now(),
        outcome: 'weekend_market_closed',
      }),
      lastCheckedAt: Date.now(),
    };
  }

  // Note : le décalage appris (params.thresholdAdjustment) n'est PAS encore appliqué ici.
  // Pour l'instant, la mémoire enregistre et observe seulement — elle n'influence pas
  // encore les décisions de trading. L'application effective viendra dans une étape
  // ultérieure, une fois le comportement de la mémoire validé par l'observation.
  const v2Result = calculateScore(candles5min, candles1h);
  const currentAtr = v2Result.breakdown.volatility.detail.atr;

  // --- Position déjà ouverte : on l'évalue (break-even / trailing / clôture) ---
  if (openPosition) {
    const { updatedPosition, shouldClose, closeReason } = evaluatePosition(openPosition, currentPrice);

    if (shouldClose) {
      const pnlPct =
        updatedPosition.direction === 'BUY'
          ? (currentPrice - updatedPosition.entryPrice) / updatedPosition.entryPrice
          : (updatedPosition.entryPrice - currentPrice) / updatedPosition.entryPrice;

      const pnl = updatedPosition.positionSize * pnlPct;

      const closedTrade = {
        ...updatedPosition,
        status: 'closed',
        exitPrice: currentPrice,
        pnl,
        pnlPct,
        closedAt: Date.now(),
        closeReason,
      };

      const newTrades = [...trades, closedTrade];
      const newAccount = { balance: account.balance + pnl, equity: account.balance + pnl };
      const learning = adjustV2ThresholdFromHistory(newTrades, params.thresholdAdjustment);
      const newParams = { ...params, thresholdAdjustment: learning.adjustment };

      return {
        trades: newTrades,
        openPosition: null,
        account: newAccount,
        params: newParams,
        shadowLog: logShadowEntry(shadowLog, {
          timestamp: Date.now(),
          v2Result,
          outcome: 'closed',
          closeReason,
          learning,
        }),
        lastCheckedAt: Date.now(),
      };
    }

    // Position toujours ouverte : on enregistre juste la mise à jour (break-even/trailing éventuel)
    return {
      trades,
      openPosition: updatedPosition,
      account,
      params,
      shadowLog: logShadowEntry(shadowLog, {
        timestamp: Date.now(),
        v2Result,
        outcome: 'held',
      }),
      lastCheckedAt: Date.now(),
    };
  }

  // --- Aucune position ouverte : on envisage une ouverture si le score le permet ---
  if (v2Result.shouldTrade && v2Result.direction !== 'NEUTRAL') {
    if (applyObservationWindow && isObservationWindow()) {
      return {
        trades,
        openPosition: null,
        account,
        params,
        shadowLog: logShadowEntry(shadowLog, {
          timestamp: Date.now(),
          v2Result,
          outcome: 'skipped_observation_window',
        }),
        lastCheckedAt: Date.now(),
      };
    }

    const risk = getRiskPause(trades);

    if (risk.paused) {
      return {
        trades,
        openPosition: null,
        account,
        params,
        shadowLog: logShadowEntry(shadowLog, {
          timestamp: Date.now(),
          v2Result,
          outcome: 'skipped_risk_pause',
          reason: risk.reason,
        }),
        lastCheckedAt: Date.now(),
      };
    }

    const sizeMultiplier = getPositionSizeMultiplier(trades);

    // Vérification contextuelle IA — uniquement à ce moment précis (pas à chaque cycle),
    // pour rester sobre en coût. N'écrase jamais un signal technique sur une simple hésitation ;
    // ne bloque que si un risque "high" est détecté (événement macro majeur imminent/en cours).
    const recentCandles = candles5min.slice(-15);
    const aiCheck = await checkTradeContext(symbol, v2Result.direction, v2Result, recentCandles, trades);

    if (aiCheck.riskLevel === 'high') {
      return {
        trades,
        openPosition: null,
        account,
        params,
        shadowLog: logShadowEntry(shadowLog, {
          timestamp: Date.now(),
          v2Result,
          outcome: 'skipped_ai_risk',
          aiCheck,
        }),
        lastCheckedAt: Date.now(),
      };
    }

    // Taille basée sur le risque par trade rapporté à la distance du SL (cohérent avec positionManager)
    const slDistance = currentAtr * 1.5; // doit rester aligné avec SL_ATR_MULTIPLIER de positionManager.js
    const riskAmount = account.balance * RISK_PER_TRADE;
    const basePositionSize = (riskAmount / slDistance) * currentPrice;
    const positionSize = Math.min(basePositionSize * sizeMultiplier, account.balance * 0.5);

    const newPosition = {
      ...createPosition(currentPrice, v2Result.direction, currentAtr),
      id: Date.now(),
      positionSize,
      sizeMultiplier,
      score: v2Result.score,
      entryAdx: v2Result.adx,
      entryThreshold: v2Result.threshold,
      aiCheck,
      status: 'open',
      openedAt: Date.now(),
    };

    return {
      trades,
      openPosition: newPosition,
      account,
      params,
      shadowLog: logShadowEntry(shadowLog, {
        timestamp: Date.now(),
        v2Result,
        outcome: 'opened',
      }),
      lastCheckedAt: Date.now(),
    };
  }

  // --- Rien à faire ce cycle ---
  return {
    trades,
    openPosition,
    account,
    params,
    shadowLog: logShadowEntry(shadowLog, {
      timestamp: Date.now(),
      v2Result,
      outcome: 'no_action',
    }),
    lastCheckedAt: Date.now(),
  };
}
