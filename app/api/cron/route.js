// app/api/cron/route.js
// Bot réel XAU/USD — moteur V2 (scoreEngine + positionManager via shadowEngine.runShadowCycle).
// Garde-fou : ferme automatiquement toute position V1 orpheline (sans champs V2)
// trouvée en ouvrant ce cycle, avant de laisser le V2 décider.
// Envoie un signal de vie à Healthchecks.io à chaque cycle réussi, pour détecter
// automatiquement si ce cron s'arrête de tourner (désactivé, quota épuisé, etc.).

import { Redis } from '@upstash/redis';
import { Resend } from 'resend';
import { runShadowCycle } from '../../lib/shadowEngine';
import { STARTING_CAPITAL } from '../../lib/tradingEngine';

const STATE_KEY = 'aria-bot-state';
const SYMBOL = 'XAU/USD';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
const HEALTHCHECK_URL = 'https://hc-ping.com/9e9d660f-be42-4010-8ad0-87bece495cf7';

function getRedis() {
  return new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN
  });
}

async function sendNotification(subject, html) {
  if (!process.env.RESEND_API_KEY || !NOTIFY_EMAIL) return;
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'ARIA Memory Bot <onboarding@resend.dev>',
      to: NOTIFY_EMAIL,
      subject,
      html
    });
  } catch (err) {
    console.error('Notification email échouée:', err.message);
  }
}

// Signal de vie envoyé à Healthchecks.io à chaque cycle réussi — permet de détecter
// automatiquement si le cron s'arrête de tourner (désactivé, quota épuisé, etc.),
// sans dépendre de notre propre code pour émettre l'alerte.
async function pingHealthcheck() {
  try {
    await fetch(HEALTHCHECK_URL, { cache: 'no-store' });
  } catch {
    // Jamais bloquant : un échec de ping ne doit pas interrompre le cycle de trading
  }
}

// Twelve Data renvoie le plus récent en premier, close/open/high/low en chaînes.
// indicators.js attend des objets { open, high, low, close } numériques, triés
// du plus ancien au plus récent.
function toCandles(values) {
  return values
    .map(v => ({
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      time: v.datetime,
    }))
    .reverse();
}

async function fetchCandles(symbol, interval, outputsize, apiKey) {
  const res = await fetch(
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${apiKey}`,
    { cache: 'no-store' }
  );
  const data = await res.json();
  if (data.status === 'error' || !data.values) {
    throw new Error(data.message || `Erreur Twelve Data (${interval})`);
  }
  return { candles: toCandles(data.values), raw: data.values };
}

function createInitialState() {
  return {
    trades: [],
    openPosition: null,
    account: { balance: STARTING_CAPITAL, equity: STARTING_CAPITAL },
    shadowLog: [],
    params: { thresholdAdjustment: 0 },
    lastCheckedAt: null,
  };
}

async function loadState(redis) {
  const state = await redis.get(STATE_KEY);
  if (!state) return createInitialState();

  return {
    trades: state.trades || [],
    openPosition: state.openPosition || null,
    account: state.account || { balance: STARTING_CAPITAL, equity: STARTING_CAPITAL },
    shadowLog: state.shadowLog || [],
    params:
      state.params && state.params.thresholdAdjustment !== undefined
        ? state.params
        : { thresholdAdjustment: 0 },
    lastCheckedAt: state.lastCheckedAt || null,
  };
}

async function saveState(redis, state) {
  await redis.set(STATE_KEY, state);
}

// Garde-fou migration : ferme toute position sans champs V2 (stopLoss undefined =
// ouverte sous l'ancien tradingEngine.js), au prix courant, avant toute décision V2.
async function closeOrphanV1Position(state, currentPrice) {
  const position = state.openPosition;
  if (!position || position.stopLoss !== undefined) return { state, closedTrade: null };

  const pnlPct =
    position.direction === 'BUY'
      ? (currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - currentPrice) / position.entryPrice;
  const pnl = position.positionSize * pnlPct;

  const closedTrade = {
    ...position,
    status: 'closed',
    exitPrice: currentPrice,
    pnl,
    pnlPct,
    closedAt: Date.now(),
    closeReason: 'engine_migration_close',
  };

  const newState = {
    ...state,
    trades: [...state.trades, closedTrade],
    account: { balance: state.account.balance + pnl, equity: state.account.balance + pnl },
    openPosition: null,
  };

  return { state: newState, closedTrade };
}

async function notifyEvents(prevState, newState, closedMigrationTrade) {
  if (closedMigrationTrade) {
    await sendNotification(
      `🔧 ARIA ${SYMBOL} — Position V1 fermée (migration V2)`,
      `<p>Position <strong>${closedMigrationTrade.direction}</strong> fermée automatiquement avant bascule vers le moteur V2.</p>
       <p>P&L: <strong>${closedMigrationTrade.pnl >= 0 ? '+' : ''}$${closedMigrationTrade.pnl.toFixed(2)}</strong></p>`
    );
  }

  if (!prevState.openPosition && newState.openPosition) {
    const p = newState.openPosition;
    await sendNotification(
      `📈 ARIA ${SYMBOL} — Position ${p.direction} ouverte (V2)`,
      `<p><strong>${p.direction}</strong> ${SYMBOL} @ $${p.entryPrice.toFixed(2)}</p>
       <p>Taille: $${p.positionSize.toFixed(2)} · Score V2: ${p.score?.toFixed(1) ?? '—'}</p>`
    );
  }

  const prevClosedCount = prevState.trades.filter(t => t.status === 'closed').length;
  const newClosedCount = newState.trades.filter(t => t.status === 'closed').length;
  if (newClosedCount > prevClosedCount) {
    const lastClosed = [...newState.trades]
      .filter(t => t.status === 'closed')
      .sort((a, b) => b.closedAt - a.closedAt)[0];
    if (lastClosed.closeReason !== 'engine_migration_close') {
      const emoji = lastClosed.pnl >= 0 ? '✅' : '❌';
      await sendNotification(
        `${emoji} ARIA ${SYMBOL} — Trade clos (V2) : ${lastClosed.pnl >= 0 ? '+' : ''}$${lastClosed.pnl.toFixed(2)}`,
        `<p><strong>${lastClosed.direction}</strong> @ $${lastClosed.entryPrice.toFixed(2)} → $${lastClosed.exitPrice.toFixed(2)}</p>
         <p>P&L: <strong>${lastClosed.pnl >= 0 ? '+' : ''}$${lastClosed.pnl.toFixed(2)}</strong> (${(lastClosed.pnlPct * 100).toFixed(2)}%)</p>
         <p>Raison de clôture: ${lastClosed.closeReason}</p>
         <p>Capital actuel: $${newState.account.balance.toFixed(2)}</p>`
      );
    }
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret');
  const apiKey = searchParams.get('apikey');

  if (secret !== process.env.CRON_SECRET) {
    return Response.json({ error: 'Non autorisé' }, { status: 401 });
  }
  if (!apiKey) {
    return Response.json({ error: 'apikey Twelve Data manquante' }, { status: 400 });
  }

  try {
    const redis = getRedis();
    let state = await loadState(redis);

    const { candles: candles5min, raw: raw5min } = await fetchCandles(SYMBOL, '5min', 250, apiKey);

    let closedMigrationTrade = null;
    if (state.openPosition) {
      const currentPriceForGuard = candles5min[candles5min.length - 1].close;
      const result = await closeOrphanV1Position(state, currentPriceForGuard);
      state = result.state;
      closedMigrationTrade = result.closedTrade;
    }

    let candles1h = [];
    try {
      const result1h = await fetchCandles(SYMBOL, '1h', 60, apiKey);
      candles1h = result1h.candles;
    } catch {
      // Pas bloquant : la confirmation H1 vaudra simplement 0 point ce cycle-là
    }

    const prevState = state;
    // { applyObservationWindow: true } — réservé au bot réel : aucune nouvelle position
    // n'est ouverte de vendredi 21h UTC à mardi 23h UTC (fermeture weekend incluse).
    // Le shadow (app/api/shadow/route.js) appelle la même fonction sans cette option,
    // et continue donc de trader normalement pour garder une base de comparaison.
    const newState = await runShadowCycle(state, candles5min, candles1h, SYMBOL, { applyObservationWindow: true });

    newState.priceHistory = raw5min
      .map(v => ({ time: v.datetime.slice(5, 16), price: parseFloat(v.close) }))
      .reverse();

    await notifyEvents(prevState, newState, closedMigrationTrade);
    await saveState(redis, newState);
    await pingHealthcheck();

    return Response.json({
      ok: true,
      symbol: SYMBOL,
      checkedAt: new Date().toISOString(),
      migrationClose: closedMigrationTrade,
      openPosition: newState.openPosition,
      balance: newState.account.balance,
      tradesCount: newState.trades.length,
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
