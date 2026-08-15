// app/lib/scoreEngine.js
// Moteur de score V2 — score pondéré sur 100 points, seuil dynamique basé sur ADX
// Dépend de indicators.js (EMA, ADX, ATR)
// Ne remplace pas encore tradingEngine.js — module autonome, à intégrer ensuite

import { calculateEMA, calculateADX, calculateATR } from './indicators';

// --- Poids des composantes (total = 100) ---
const WEIGHTS = {
  TREND: 40,
  MACD: 20,
  RSI: 15,
  H1_CONFIRMATION: 15,
  VOLATILITY: 10,
};

// Seuils dynamiques selon régime de marché (ADX)
const ADX_THRESHOLDS = {
  STRONG_TREND: { min: 30, threshold: 35 },   // ADX > 30 → tendance forte, seuil plus permissif
  MODERATE_TREND: { min: 20, threshold: 45 }, // ADX 20-30 → tendance modérée
  RANGE: { min: 0, threshold: 60 },           // ADX < 20 → range, très sélectif
};

// Volatilité minimum (ATR en % du prix) en dessous de laquelle on considère le marché trop calme
const VOLATILITY_MIN_PERCENT = 0.05; // à calibrer avec l'historique réel XAU/USD et EUR/USD

// ---------- Indicateurs internes (RSI, MACD) ----------
// Non présents dans indicators.js (qui contient EMA/ADX/ATR) — calculés ici pour garder scoreEngine.js autonome

function calculateRSI(candles, period = 14) {
  const closes = candles.map(c => c.close);
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;

  const gains = [];
  const losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? Math.abs(diff) : 0);
  }

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result[period] = 100 - 100 / (1 + rs0);

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result[i + 1] = 100 - 100 / (1 + rs);
  }

  return result;
}

function calculateMACD(candles, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = calculateEMA(candles, fast);
  const emaSlow = calculateEMA(candles, slow);

  const macdLine = candles.map((_, i) => {
    if (emaFast[i] === null || emaSlow[i] === null) return null;
    return emaFast[i] - emaSlow[i];
  });

  // Signal = EMA9 de la ligne MACD (sur les valeurs non-null uniquement)
  const firstValid = macdLine.findIndex(v => v !== null);
  const signalLine = new Array(candles.length).fill(null);
  const histogram = new Array(candles.length).fill(null);

  if (firstValid !== -1) {
    const macdValues = macdLine.slice(firstValid).map(v => ({ close: v }));
    const signalRaw = calculateEMA(macdValues, signalPeriod);
    for (let i = 0; i < signalRaw.length; i++) {
      if (signalRaw[i] !== null) {
        const idx = firstValid + i;
        signalLine[idx] = signalRaw[i];
        histogram[idx] = macdLine[idx] - signalRaw[i];
      }
    }
  }

  return { macdLine, signalLine, histogram };
}

// ---------- Composantes du score ----------

function scoreTrend(candles) {
  const ema20 = calculateEMA(candles, 20);
  const ema50 = calculateEMA(candles, 50);
  const ema200 = calculateEMA(candles, 200);

  const last = candles.length - 1;
  const price = candles[last].close;
  const e20 = ema20[last];
  const e50 = ema50[last];
  const e200 = ema200[last];

  if (e20 === null || e50 === null) {
    return { points: 0, direction: 'NEUTRAL', detail: 'EMA insuffisantes' };
  }

  let bullish = 0;
  let bearish = 0;

  price > e20 ? (bullish += 10) : (bearish += 10);
  e20 > e50 ? (bullish += 15) : (bearish += 15);

  if (e200 !== null) {
    e50 > e200 ? (bullish += 15) : (bearish += 15);
  }
  // si EMA200 indisponible, ce sous-test est simplement omis (score sur 25 au lieu de 40 ce cycle-là)

  const direction = bullish >= bearish ? 'BUY' : 'SELL';
  const points = Math.max(bullish, bearish);

  return { points, direction, detail: { price, e20, e50, e200 } };
}

function scoreMACD(candles) {
  const { macdLine, signalLine, histogram } = calculateMACD(candles);
  const last = candles.length - 1;

  if (macdLine[last] === null || signalLine[last] === null || histogram[last] === null || histogram[last - 1] === null) {
    return { points: 0, direction: 'NEUTRAL', detail: 'MACD insuffisant' };
  }

  const macdBullish = macdLine[last] > signalLine[last];
  const histogramRising = histogram[last] > histogram[last - 1];

  let bullish = 0;
  let bearish = 0;

  macdBullish ? (bullish += 12) : (bearish += 12);
  histogramRising ? (bullish += 8) : (bearish += 8);

  const direction = bullish >= bearish ? 'BUY' : 'SELL';
  const points = Math.max(bullish, bearish);

  return { points, direction, detail: { macd: macdLine[last], signal: signalLine[last], histogram: histogram[last] } };
}

function scoreRSI(candles) {
  const rsiValues = calculateRSI(candles);
  const last = candles.length - 1;
  const rsi = rsiValues[last];

  if (rsi === null) {
    return { points: 0, direction: 'NEUTRAL', detail: 'RSI insuffisant' };
  }

  let points, direction;

  if (rsi <= 30) {
    points = 15;
    direction = 'BUY';
  } else if (rsi >= 70) {
    points = 15;
    direction = 'SELL';
  } else if (rsi < 50) {
    points = ((50 - rsi) / 20) * 15;
    direction = 'BUY';
  } else {
    points = ((rsi - 50) / 20) * 15;
    direction = 'SELL';
  }

  return { points, direction, detail: { rsi } };
}

function scoreH1Confirmation(candles1h, direction5min) {
  if (!candles1h || candles1h.length < 50) {
    return { points: 0, direction: 'NEUTRAL', detail: 'Données H1 insuffisantes' };
  }

  const ema20 = calculateEMA(candles1h, 20);
  const ema50 = calculateEMA(candles1h, 50);
  const last = candles1h.length - 1;

  if (ema20[last] === null || ema50[last] === null) {
    return { points: 0, direction: 'NEUTRAL', detail: 'EMA H1 insuffisantes' };
  }

  const price = candles1h[last].close;
  const bullishH1 = price > ema20[last] && ema20[last] > ema50[last];
  const bearishH1 = price < ema20[last] && ema20[last] < ema50[last];

  const directionH1 = bullishH1 ? 'BUY' : bearishH1 ? 'SELL' : 'NEUTRAL';
  const points = directionH1 === direction5min && directionH1 !== 'NEUTRAL' ? 15 : 0;

  return { points, direction: directionH1, detail: { price, ema20: ema20[last], ema50: ema50[last] } };
}

function scoreVolatility(candles) {
  const atrValues = calculateATR(candles);
  const last = candles.length - 1;
  const atr = atrValues[last];
  const price = candles[last].close;

  if (atr === null) {
    return { points: 0, detail: 'ATR insuffisant' };
  }

  const atrPercent = (atr / price) * 100;
  const points = Math.min(WEIGHTS.VOLATILITY, (atrPercent / VOLATILITY_MIN_PERCENT) * WEIGHTS.VOLATILITY);

  return { points, detail: { atr, atrPercent } };
}

// Fenêtre de bougies utilisée pour vérifier qu'un momentum est déjà visible dans le sens
// du signal avant d'ouvrir — évite d'entrer sur un signal techniquement valide mais dont
// le prix ne montre encore aucun mouvement réel dans la direction attendue.
const ENTRY_MOMENTUM_LOOKBACK = 3; // 3 bougies 5min = 15 minutes en arrière

/**
 * Vérifie qu'un mouvement de prix récent va déjà dans le sens du signal, avant d'ouvrir.
 * @param {Array} candles - bougies 5min
 * @param {'BUY'|'SELL'} direction
 * @returns {boolean} true si le momentum récent confirme la direction du signal
 */
function checkEntryMomentum(candles, direction) {
  if (candles.length < ENTRY_MOMENTUM_LOOKBACK + 1) return true; // pas assez de données, on ne bloque pas par défaut

  const last = candles.length - 1;
  const priceNow = candles[last].close;
  const priceBefore = candles[last - ENTRY_MOMENTUM_LOOKBACK].close;

  return direction === 'BUY' ? priceNow > priceBefore : priceNow < priceBefore;
}

function getDynamicThreshold(adx) {
  if (adx === null) return ADX_THRESHOLDS.MODERATE_TREND.threshold; // valeur par défaut prudente
  if (adx > ADX_THRESHOLDS.STRONG_TREND.min) return ADX_THRESHOLDS.STRONG_TREND.threshold;
  if (adx > ADX_THRESHOLDS.MODERATE_TREND.min) return ADX_THRESHOLDS.MODERATE_TREND.threshold;
  return ADX_THRESHOLDS.RANGE.threshold;
}

// ---------- Fonction principale ----------

/**
 * Calcule le score V2 complet pour un cycle de décision
 * @param {Array} candles - bougies 5min, triées ancien -> récent (250 recommandé pour EMA200)
 * @param {Array} candles1h - bougies 1h pour confirmation multi-timeframe
 * @param {number} thresholdAdjustment - décalage appliqué au seuil dynamique, calculé par
 *   v2LearningEngine.js à partir de l'historique de trades (0 par défaut, pas d'ajustement)
 * @returns {Object} { score, direction, threshold, shouldTrade, breakdown }
 */
export function calculateScore(candles, candles1h, thresholdAdjustment = 0) {
  const trend = scoreTrend(candles);
  const macd = scoreMACD(candles);
  const rsi = scoreRSI(candles);

  // Direction provisoire avant confirmation H1 : majorité des 3 composantes déjà calculées
  const votes = [trend.direction, macd.direction, rsi.direction].filter(d => d !== 'NEUTRAL');
  const buyVotes = votes.filter(d => d === 'BUY').length;
  const sellVotes = votes.filter(d => d === 'SELL').length;
  const provisionalDirection = buyVotes >= sellVotes ? 'BUY' : 'SELL';

  const h1 = scoreH1Confirmation(candles1h, provisionalDirection);
  const volatility = scoreVolatility(candles);

  // Accumulation des points par camp
  let bullishTotal = 0;
  let bearishTotal = 0;

  [trend, macd, rsi].forEach(component => {
    if (component.direction === 'BUY') bullishTotal += component.points;
    else if (component.direction === 'SELL') bearishTotal += component.points;
  });

  if (h1.direction === 'BUY') bullishTotal += h1.points;
  else if (h1.direction === 'SELL') bearishTotal += h1.points;

  // Volatilité n'est pas directionnelle : ajoutée au camp gagnant (confirme qu'il y a assez de mouvement pour agir)
  const direction = bullishTotal >= bearishTotal ? 'BUY' : 'SELL';
  const winningTotal = Math.max(bullishTotal, bearishTotal);
  const score = Math.min(100, winningTotal + volatility.points);

  const { adx } = calculateADX(candles);
  const currentADX = adx[adx.length - 1];
  const baseThreshold = getDynamicThreshold(currentADX);
  const threshold = Math.min(100, baseThreshold + thresholdAdjustment);

  // Blocage en régime "range" OU "tendance modérée" : confirmé sur ~246 trades V2 réels que
  // tendance_forte (ADX>30) fait +$97.49 (43.4% win) contre tendance_moderee -$55.78 (36.3% win)
  // sur volume comparable (122 vs 124 trades). Le bot ne trade désormais qu'en tendance forte.
  const isRangeRegime = currentADX !== null && currentADX <= ADX_THRESHOLDS.STRONG_TREND.min;

  // Vérification de traction immédiate : le signal doit déjà être accompagné d'un mouvement
  // de prix récent dans le même sens. Évite d'ouvrir sur un score techniquement favorable
  // mais dont le marché ne montre encore aucune conviction réelle dans cette direction.
  const hasEntryMomentum = checkEntryMomentum(candles, direction);

  const shouldTrade = !isRangeRegime && hasEntryMomentum && score >= threshold;

  return {
    score: Math.round(score * 100) / 100,
    direction,
    adx: currentADX,
    threshold,
    shouldTrade,
    blockedByRangeRegime: isRangeRegime,
    blockedByNoMomentum: !hasEntryMomentum,
    breakdown: { trend, macd, rsi, h1Confirmation: h1, volatility },
  };
}
