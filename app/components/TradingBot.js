"use client";
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { TrendingUp, TrendingDown, Target, RefreshCw, Server, ShieldCheck, History, Brain, AlertTriangle, CalendarDays, CalendarClock, ChevronDown, ChevronRight, Clock } from 'lucide-react';

const STARTING_CAPITAL = 10000;
const REFRESH_INTERVAL = 30000;
const ACCENT = '#D4AF37';
const ACCENT_DARK = '#B8860B';

const STATUS_LABELS = {
  sl_fixe: { label: 'Stop-loss fixe', color: '#e5555a' },
  breakeven_actif: { label: 'Break-even actif', color: '#D4AF37' },
  trailing_actif: { label: 'Trailing actif', color: '#4ade80' },
  profit_securise: { label: 'Profit sécurisé', color: '#4ade80' },
};

function getPositionStatus(position) {
  if (!position) return null;
  if (position.profitSecured) return 'profit_securise';
  if (position.trailingActive) return 'trailing_actif';
  if (position.breakEvenTriggered) return 'breakeven_actif';
  return 'sl_fixe';
}

function formatDuration(openedAt, closedAt) {
  const minutes = Math.round((closedAt - openedAt) / 60000);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hours}h${rem}` : `${hours}h`;
}

function getPeriodBounds() {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const dayOfWeek = startOfToday.getDay();
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - diffToMonday);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  return {
    startOfToday: startOfToday.getTime(),
    startOfWeek: startOfWeek.getTime(),
    startOfMonth: startOfMonth.getTime(),
  };
}

function computePeriodStats(closedTrades, startTime) {
  const periodTrades = closedTrades.filter(t => t.closedAt >= startTime);
  if (periodTrades.length === 0) return { count: 0, totalPnl: 0, winRate: 0 };
  const wins = periodTrades.filter(t => t.pnl > 0).length;
  const totalPnl = periodTrades.reduce((sum, t) => sum + t.pnl, 0);
  const winRate = Math.round((wins / periodTrades.length) * 1000) / 10;
  return { count: periodTrades.length, totalPnl, winRate };
}

// Regroupe les trades V2 (présence du champ `score`) par jour civil, du plus récent au plus ancien.
function computeDailyBreakdown(closedTrades) {
  const v2Trades = closedTrades.filter(t => t.score !== undefined && t.score !== null);

  const groups = {};
  v2Trades.forEach(t => {
    const d = new Date(t.closedAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!groups[key]) {
      groups[key] = {
        key,
        label: d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }),
        count: 0,
        pnl: 0,
      };
    }
    groups[key].count++;
    groups[key].pnl += t.pnl;
  });

  return Object.values(groups).sort((a, b) => b.key.localeCompare(a.key));
}

// Régime ADX à l'ouverture — mêmes seuils que statsEngine.js (getAdxRegime)
function getAdxRegime(entryAdx) {
  if (entryAdx === undefined || entryAdx === null) return 'inconnu';
  if (entryAdx > 30) return 'tendance_forte';
  if (entryAdx > 20) return 'tendance_moderee';
  return 'range';
}

const REGIME_LABELS = {
  tendance_forte: { label: 'Tendance forte', color: '#4ade80' },
  tendance_moderee: { label: 'Tendance modérée', color: '#D4AF37' },
  range: { label: 'Range', color: '#e5555a' },
  inconnu: { label: 'ADX inconnu', color: '#5a5a68' },
};

// Résume un sous-ensemble de trades en {count, pnl, winRate}
function summarizeTrades(trades) {
  if (trades.length === 0) return { count: 0, pnl: 0, winRate: null };
  const wins = trades.filter(t => t.pnl > 0).length;
  const pnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  return { count: trades.length, pnl, winRate: Math.round((wins / trades.length) * 1000) / 10 };
}

// Regroupe les trades V2 par jour de la SEMAINE (tous les lundis ensemble, etc.),
// agrégé sur tout l'historique — pour repérer si un jour est structurellement meilleur.
// Ajoute une répartition par régime ADX à l'intérieur de chaque jour, pour distinguer
// un vrai effet "jour" d'un effet "plus de cycles en régime range ce jour-là".
function computeWeekdayBreakdown(closedTrades) {
  const v2Trades = closedTrades.filter(t => t.score !== undefined && t.score !== null);
  const dayLabels = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const order = [1, 2, 3, 4, 5, 6, 0]; // Lundi -> Dimanche, ordre de lecture naturel

  const groups = {};
  v2Trades.forEach(t => {
    const d = new Date(t.closedAt);
    const dow = d.getDay();
    if (!groups[dow]) {
      groups[dow] = { dow, label: dayLabels[dow], count: 0, pnl: 0, wins: 0, trades: [] };
    }
    groups[dow].count++;
    groups[dow].pnl += t.pnl;
    if (t.pnl > 0) groups[dow].wins++;
    groups[dow].trades.push(t);
  });

  return order.map(dow => {
    const g = groups[dow];
    if (!g) return { dow, label: dayLabels[dow], count: 0, pnl: 0, winRate: null, trades: [], byRegime: {} };

    const sortedTrades = [...g.trades].sort((a, b) => b.closedAt - a.closedAt);
    const byRegime = {
      tendance_forte: summarizeTrades(g.trades.filter(t => getAdxRegime(t.entryAdx) === 'tendance_forte')),
      tendance_moderee: summarizeTrades(g.trades.filter(t => getAdxRegime(t.entryAdx) === 'tendance_moderee')),
      range: summarizeTrades(g.trades.filter(t => getAdxRegime(t.entryAdx) === 'range')),
    };

    return {
      dow,
      label: g.label,
      count: g.count,
      pnl: g.pnl,
      winRate: Math.round((g.wins / g.count) * 1000) / 10,
      trades: sortedTrades,
      byRegime,
    };
  });
}

// Regroupe les trades V2 par HEURE UTC d'OUVERTURE (pas de clôture) — pour repérer
// si un jour "faible" cache en fait un effet horaire (ex: session Londres vs NY),
// plutôt qu'un vrai effet calendaire.
function computeHourlyBreakdown(closedTrades) {
  const v2Trades = closedTrades.filter(t => t.score !== undefined && t.score !== null && t.openedAt);

  const groups = {};
  v2Trades.forEach(t => {
    const hour = new Date(t.openedAt).getUTCHours();
    if (!groups[hour]) {
      groups[hour] = { hour, count: 0, pnl: 0, wins: 0, trades: [] };
    }
    groups[hour].count++;
    groups[hour].pnl += t.pnl;
    if (t.pnl > 0) groups[hour].wins++;
    groups[hour].trades.push(t);
  });

  const hours = [];
  for (let h = 0; h < 24; h++) {
    const g = groups[h];
    if (!g) {
      hours.push({ hour: h, count: 0, pnl: 0, winRate: null, trades: [] });
    } else {
      hours.push({
        hour: h,
        count: g.count,
        pnl: g.pnl,
        winRate: Math.round((g.wins / g.count) * 1000) / 10,
        trades: [...g.trades].sort((a, b) => b.closedAt - a.closedAt),
      });
    }
  }
  return hours;
}

// Regroupe les trades V2 par RÉGIME ADX (tendance forte / modérée / range), et à
// l'intérieur de chaque régime, par heure UTC d'ouverture — pour repérer précisément
// à quelles heures un régime donné (ex: tendance forte) est réellement rentable.
function computeRegimeBreakdown(closedTrades) {
  const v2Trades = closedTrades.filter(t => t.score !== undefined && t.score !== null);
  const regimes = ['tendance_forte', 'tendance_moderee', 'range'];

  return regimes.map(regime => {
    const regimeTrades = v2Trades.filter(t => getAdxRegime(t.entryAdx) === regime);
    const summary = summarizeTrades(regimeTrades);
    const hourly = computeHourlyBreakdown(regimeTrades).filter(h => h.count > 0);
    return { regime, ...summary, hourly };
  });
}

function interpretTrade(trade) {
  const won = trade.pnl >= 0;
  switch (trade.closeReason) {
    case 'stop_loss':
      return won
        ? "Sortie sur stop-loss avec un léger gain — probablement un mouvement de prix entre deux vérifications."
        : "Sortie sur stop-loss initial (1.5×ATR). Le marché est allé à l'encontre de la position sans jamais atteindre le seuil de break-even.";
    case 'breakeven_stop':
      return "Position sortie proche de l'équilibre : le trade est parti en profit, le stop a été remonté à l'entrée, puis le marché s'est retourné.";
    case 'trailing_stop':
      return won
        ? "Gain sécurisé par le trailing stop ATR après un mouvement favorable prolongé."
        : "Le trailing s'était activé mais le marché s'est retourné plus vite que le stop ne pouvait suivre.";
    case 'profit_secured_stop':
      return won
        ? `Gain protégé par le Profit Sécurisé progressif — le SL a suivi le pic de profit atteint (${trade.peakUnrealizedPnl != null ? '$' + trade.peakUnrealizedPnl.toFixed(2) : 'pic non enregistré'}) sans jamais redescendre.`
        : "Sortie via le Profit Sécurisé malgré une perte finale — cas rare, probablement un décalage d'exécution (vérification périodique, pas en continu).";
    case 'no_traction_exit':
      return "Sortie rapide : le trade n'a montré aucun signe de traction favorable dans les 30 premières minutes et perdait déjà — coupé plus tôt qu'un stop-loss complet.";
    case 'take_profit':
      return "Take-profit fixe atteint (3×ATR) avant que le trailing ou le PS n'ait eu l'occasion de s'activer.";
    case 'engine_migration_close':
      return "Position fermée automatiquement lors de la bascule du moteur V1 vers V2 — garde-fou de migration, pas une décision de trading.";
    case 'manual_close':
      return won ? "Fermé manuellement en profit." : "Fermé manuellement en perte.";
    case 'target':
      return "Trade V1 — fermé sur l'objectif de profit fixe (+1.5%).";
    case 'stop':
      return "Trade V1 — fermé sur le stop-loss fixe (-0.8%).";
    case 'signal_reversal':
      return "Trade V1 — fermé sur retournement de signal confirmé sur 2 cycles consécutifs.";
    default:
      return "Raison de clôture non reconnue.";
  }
}

function TradeRow({ t }) {
  return (
    <div style={{ padding: '14px 20px', borderBottom: '1px solid #242430' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: t.direction === 'BUY' ? '#4ade80' : '#e5555a' }}>{t.direction}</span>
          <span className="body-font" style={{ fontSize: 12, color: '#b5b5c0' }}>@ ${t.entryPrice.toFixed(2)} → ${t.exitPrice.toFixed(2)}</span>
          <span className="body-font" style={{ fontSize: 10, color: '#8a8a95', padding: '2px 6px', background: '#0B0B0F', borderRadius: 4 }}>{t.closeReason}</span>
        </div>
        <span style={{ fontSize: 13, fontWeight: 600, color: t.pnl >= 0 ? '#4ade80' : '#e5555a' }}>{t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}</span>
      </div>
      {t.openedAt && t.closedAt && (
        <div className="body-font" style={{ fontSize: 11, color: '#8a8a95', marginBottom: 6 }}>
          Ouvert le {new Date(t.openedAt).toLocaleString('fr-FR')} &middot; Fermé le {new Date(t.closedAt).toLocaleString('fr-FR')} &middot; Durée : {formatDuration(t.openedAt, t.closedAt)}
        </div>
      )}
      <div className="body-font" style={{ fontSize: 12, color: '#b5b5c0', lineHeight: 1.5, fontStyle: 'italic' }}>{interpretTrade(t)}</div>
    </div>
  );
}

function DailyPnlRow({ day }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px', borderBottom: '1px solid #242430' }}>
      <div className="body-font" style={{ fontSize: 13, color: '#FFFFFF', textTransform: 'capitalize' }}>{day.label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span className="body-font" style={{ fontSize: 11, color: '#8a8a95' }}>{day.count} trade{day.count > 1 ? 's' : ''}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: day.pnl >= 0 ? '#4ade80' : '#e5555a', minWidth: 70, textAlign: 'right' }}>
          {day.pnl >= 0 ? '+' : ''}${day.pnl.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

function WeekdayPnlRow({ day }) {
  const [expanded, setExpanded] = useState(false);
  const noData = day.count === 0;

  return (
    <div style={{ borderBottom: '1px solid #242430' }}>
      <div
        onClick={() => !noData && setExpanded(e => !e)}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px', cursor: noData ? 'default' : 'pointer' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!noData && (expanded ? <ChevronDown size={14} color="#8a8a95" /> : <ChevronRight size={14} color="#8a8a95" />)}
          <div className="body-font" style={{ fontSize: 13, color: noData ? '#5a5a68' : '#FFFFFF' }}>{day.label}</div>
        </div>
        {noData ? (
          <span className="body-font" style={{ fontSize: 11, color: '#5a5a68' }}>Aucun trade</span>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <span className="body-font" style={{ fontSize: 11, color: '#8a8a95' }}>{day.count} trade{day.count > 1 ? 's' : ''} &middot; {day.winRate}% win</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: day.pnl >= 0 ? '#4ade80' : '#e5555a', minWidth: 70, textAlign: 'right' }}>
              {day.pnl >= 0 ? '+' : ''}${day.pnl.toFixed(2)}
            </span>
          </div>
        )}
      </div>
      {expanded && !noData && (
        <div style={{ background: '#0B0B0F' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, padding: '12px 20px' }}>
            {['tendance_forte', 'tendance_moderee', 'range'].map(regime => {
              const r = day.byRegime?.[regime];
              const info = REGIME_LABELS[regime];
              return (
                <div key={regime} style={{ background: '#1A1A22', border: `1px solid ${info.color}33`, borderRadius: 8, padding: '8px 10px' }}>
                  <div className="body-font" style={{ fontSize: 9, color: info.color, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 4 }}>{info.label}</div>
                  {!r || r.count === 0 ? (
                    <div className="body-font" style={{ fontSize: 10, color: '#5a5a68' }}>Aucun trade</div>
                  ) : (
                    <>
                      <div className="body-font" style={{ fontSize: 10, color: '#8a8a95' }}>{r.count} trade{r.count > 1 ? 's' : ''} &middot; {r.winRate}% win</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: r.pnl >= 0 ? '#4ade80' : '#e5555a' }}>{r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2)}</div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          {day.trades.map(t => <TradeRow key={t.id} t={t} />)}
        </div>
      )}
    </div>
  );
}

function HourlyPnlRow({ hourData }) {
  const [expanded, setExpanded] = useState(false);
  const hourLabel = `${String(hourData.hour).padStart(2, '0')}h–${String((hourData.hour + 1) % 24).padStart(2, '0')}h UTC`;

  return (
    <div style={{ borderBottom: '1px solid #242430' }}>
      <div
        onClick={() => setExpanded(e => !e)}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 20px', cursor: 'pointer' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {expanded ? <ChevronDown size={14} color="#8a8a95" /> : <ChevronRight size={14} color="#8a8a95" />}
          <div className="body-font" style={{ fontSize: 13, color: '#FFFFFF' }}>{hourLabel}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span className="body-font" style={{ fontSize: 11, color: '#8a8a95' }}>{hourData.count} trade{hourData.count > 1 ? 's' : ''} &middot; {hourData.winRate}% win</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: hourData.pnl >= 0 ? '#4ade80' : '#e5555a', minWidth: 70, textAlign: 'right' }}>
            {hourData.pnl >= 0 ? '+' : ''}${hourData.pnl.toFixed(2)}
          </span>
        </div>
      </div>
      {expanded && (
        <div style={{ background: '#0B0B0F' }}>
          {hourData.trades.map(t => <TradeRow key={t.id} t={t} />)}
        </div>
      )}
    </div>
  );
}

// Carte de régime cliquable — déplie la répartition par heure UTC à l'intérieur
// de ce régime, pour repérer précisément quelles heures sont rentables quand le
// marché est en tendance forte (par exemple), toutes journées confondues.
function RegimeCard({ data }) {
  const [expanded, setExpanded] = useState(false);
  const info = REGIME_LABELS[data.regime];
  const noData = data.count === 0;

  return (
    <div style={{ background: '#1A1A22', border: `1px solid ${info.color}33`, borderRadius: 10, overflow: 'hidden' }}>
      <div
        onClick={() => !noData && setExpanded(e => !e)}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', cursor: noData ? 'default' : 'pointer' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!noData && (expanded ? <ChevronDown size={14} color="#8a8a95" /> : <ChevronRight size={14} color="#8a8a95" />)}
          <div className="body-font" style={{ fontSize: 12, color: info.color, textTransform: 'uppercase', letterSpacing: 0.3 }}>{info.label}</div>
        </div>
        {noData ? (
          <span className="body-font" style={{ fontSize: 11, color: '#5a5a68' }}>Aucun trade</span>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="body-font" style={{ fontSize: 11, color: '#8a8a95' }}>{data.count} trade{data.count > 1 ? 's' : ''} &middot; {data.winRate}% win</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: data.pnl >= 0 ? '#4ade80' : '#e5555a', minWidth: 60, textAlign: 'right' }}>
              {data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(2)}
            </span>
          </div>
        )}
      </div>
      {expanded && !noData && (
        <div style={{ borderTop: `1px solid ${info.color}33` }}>
          {data.hourly.length === 0 ? (
            <div className="body-font" style={{ padding: '12px 16px', fontSize: 11, color: '#5a5a68' }}>Pas d'heure d'ouverture enregistrée.</div>
          ) : (
            data.hourly.map(h => <HourlyPnlRow key={h.hour} hourData={h} />)
          )}
        </div>
      )}
    </div>
  );
}

export default function TradingBot({ apiPath = '/api/state', symbolLabel = 'XAU/USD' }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('live');
  const intervalRef = useRef(null);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch(apiPath, { cache: 'no-store' });
      const data = await res.json();
      setState(data);
      setError(null);
    } catch (e) {
      setError('Impossible de contacter le serveur : ' + e.message);
    } finally {
      setLoading(false);
    }
  }, [apiPath]);

  useEffect(() => {
    fetchState();
    intervalRef.current = setInterval(fetchState, REFRESH_INTERVAL);
    return () => clearInterval(intervalRef.current);
  }, [fetchState]);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: '#0B0B0F', color: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Montserrat', sans-serif" }}>
        <div>Chargement...</div>
      </div>
    );
  }

  const trades = state?.trades || [];
  const account = state?.account || { balance: STARTING_CAPITAL };
  const openPosition = state?.openPosition || null;
  const lastCheckedAt = state?.lastCheckedAt || null;
  const priceHistory = state?.priceHistory || [];
  const shadowLog = state?.shadowLog || [];
  const thresholdAdjustment = state?.params?.thresholdAdjustment ?? 0;

  const closedTrades = trades.filter(t => t.status === 'closed');
  const winRate = closedTrades.length > 0 ? (closedTrades.filter(t => t.pnl > 0).length / closedTrades.length * 100).toFixed(1) : '—';
  const totalPnl = closedTrades.reduce((sum, t) => sum + t.pnl, 0);
  const equityCurve = closedTrades.reduce((acc, t) => {
    const last = acc.length > 0 ? acc[acc.length - 1].equity : STARTING_CAPITAL;
    acc.push({ trade: acc.length + 1, equity: last + t.pnl });
    return acc;
  }, [{ trade: 0, equity: STARTING_CAPITAL }]);

  const recent20 = closedTrades.slice(-20);
  const recentWinRate = recent20.length > 0 ? Math.round((recent20.filter(t => t.pnl > 0).length / recent20.length) * 1000) / 10 : null;

  const { startOfToday, startOfWeek, startOfMonth } = getPeriodBounds();
  const periodSummary = {
    today: computePeriodStats(closedTrades, startOfToday),
    thisWeek: computePeriodStats(closedTrades, startOfWeek),
    thisMonth: computePeriodStats(closedTrades, startOfMonth),
  };
  const todayClosedTrades = [...closedTrades].filter(t => t.closedAt >= startOfToday).reverse();
  const dailyBreakdown = computeDailyBreakdown(closedTrades);
  const weekdayBreakdown = computeWeekdayBreakdown(closedTrades);
  const hourlyBreakdownAll = computeHourlyBreakdown(closedTrades);
  const hourlyBreakdown = hourlyBreakdownAll.filter(h => h.count > 0);
  const regimeBreakdown = computeRegimeBreakdown(closedTrades);

  const lastCycle = shadowLog.length > 0 ? shadowLog[shadowLog.length - 1] : null;
  const lastV2Result = lastCycle?.v2Result || null;

  const minutesSinceCheck = lastCheckedAt ? Math.round((Date.now() - lastCheckedAt) / 60000) : null;
  const positionStatusKey = getPositionStatus(openPosition);
  const statusInfo = positionStatusKey ? STATUS_LABELS[positionStatusKey] : null;

  const currentPrice = priceHistory.length > 0 ? priceHistory[priceHistory.length - 1].price : null;
  const livePnl = openPosition && currentPrice !== null
    ? (() => {
        const pnlPct = openPosition.direction === 'BUY'
          ? (currentPrice - openPosition.entryPrice) / openPosition.entryPrice
          : (openPosition.entryPrice - currentPrice) / openPosition.entryPrice;
        return { pnlPct, pnl: openPosition.positionSize * pnlPct };
      })()
    : null;

  const showTP = openPosition && !openPosition.trailingActive && !openPosition.profitSecured;

  return (
    <div style={{ minHeight: '100vh', background: '#0B0B0F', color: '#FFFFFF', fontFamily: "'Montserrat', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Montserrat:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        .body-font { font-family: 'Montserrat', sans-serif; }
        .title-font { font-family: 'Cinzel', serif; letter-spacing: 0.5px; }
        button:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 2px; }
      `}</style>

      <div style={{ borderBottom: '1px solid #2c2c38', padding: '20px 28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 38, height: 38, borderRadius: 8, background: `linear-gradient(135deg, ${ACCENT}, ${ACCENT_DARK})`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Target size={20} color="#0B0B0F" />
          </div>
          <div>
            <div className="title-font" style={{ fontSize: 18, fontWeight: 700 }}>AURUM AI <span style={{ color: ACCENT }}>90MM</span></div>
            <div className="body-font" style={{ fontSize: 11, color: '#8a8a95', letterSpacing: 1 }}>{symbolLabel} &middot; BOT RÉEL</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Server size={14} color="#4ade80" />
          <span className="body-font" style={{ fontSize: 12, color: '#b5b5c0' }}>
            {minutesSinceCheck !== null ? `Dernière vérif. : il y a ${minutesSinceCheck} min` : 'En attente du premier cycle serveur'}
          </span>
          <button onClick={fetchState} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
            <RefreshCw size={14} color="#8a8a95" />
          </button>
        </div>
      </div>

      <div style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto' }}>
        {error && (
          <div style={{ background: '#2a1a1a', border: '1px solid #4a2229', borderRadius: 8, padding: '12px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
            <AlertTriangle size={16} color="#e5555a" />
            <span className="body-font" style={{ fontSize: 13, color: '#e8a8a8' }}>{error}</span>
          </div>
        )}

        <div style={{ display: 'flex', gap: 4, background: '#1A1A22', border: '1px solid #2c2c38', borderRadius: 8, padding: 4, marginBottom: 20, width: 'fit-content' }}>
          {['live', 'historique', 'memoire'].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              style={{ padding: '8px 16px', background: activeTab === tab ? '#2c2c38' : 'transparent', border: 'none', borderRadius: 6, color: activeTab === tab ? '#FFFFFF' : '#8a8a95', fontFamily: 'Montserrat', fontSize: 12, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize' }}>
              {tab}
            </button>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
          <StatCard label="Capital" value={`$${account.balance.toFixed(2)}`} accent={account.balance >= STARTING_CAPITAL ? '#4ade80' : '#e5555a'} />
          <StatCard label="P&L Total" value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`} accent={totalPnl >= 0 ? '#4ade80' : '#e5555a'} />
          <StatCard label="Win Rate" value={`${winRate}${winRate !== '—' ? '%' : ''}`} accent={ACCENT} />
          <StatCard label="Trades clos" value={closedTrades.length} accent="#b5b5c0" />
          <StatCard label="Décalage seuil (V2)" value={`${thresholdAdjustment >= 0 ? '+' : ''}${thresholdAdjustment}`} accent="#b5b5c0" />
        </div>

        <div style={{ marginBottom: 24 }}>
          <div className="body-font" style={{ fontSize: 11, color: '#8a8a95', marginBottom: 10, letterSpacing: 0.5 }}>BILAN PAR PÉRIODE</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            <PeriodCard label="Aujourd'hui" data={periodSummary.today} />
            <PeriodCard label="Cette semaine" data={periodSummary.thisWeek} />
            <PeriodCard label="Ce mois" data={periodSummary.thisMonth} />
          </div>
        </div>

        {activeTab === 'live' && (
          <>
            {priceHistory.length > 0 && (
              <div style={{ background: '#1A1A22', border: '1px solid #2c2c38', borderRadius: 12, padding: 20, marginBottom: 20 }}>
                <div className="body-font" style={{ fontSize: 12, color: '#8a8a95', marginBottom: 14, letterSpacing: 0.5 }}>{symbolLabel} &middot; 5 MIN (dernier cycle serveur)</div>
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={priceHistory}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2c2c38" />
                    <XAxis dataKey="time" stroke="#5a5a68" fontSize={10} tick={{ fill: '#8a8a95' }} />
                    <YAxis domain={['auto', 'auto']} stroke="#5a5a68" fontSize={10} tick={{ fill: '#8a8a95' }} />
                    <Tooltip contentStyle={{ background: '#0B0B0F', border: '1px solid #2c2c38', borderRadius: 8, fontSize: 12 }} />
                    <Line type="monotone" dataKey="price" stroke={ACCENT} strokeWidth={2} dot={false} />
                    {openPosition && <ReferenceLine y={openPosition.entryPrice} stroke="#4a90d9" strokeDasharray="4 4" label={{ value: 'Entrée', fill: '#4a90d9', fontSize: 10 }} />}
                    {openPosition && <ReferenceLine y={openPosition.stopLoss} stroke="#e5555a" strokeDasharray="4 4" label={{ value: 'SL', fill: '#e5555a', fontSize: 10 }} />}
                    {showTP && <ReferenceLine y={openPosition.takeProfit} stroke="#4ade80" strokeDasharray="4 4" label={{ value: 'TP', fill: '#4ade80', fontSize: 10 }} />}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
              <div style={{ background: '#1A1A22', border: '1px solid #2c2c38', borderRadius: 12, padding: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                  <TrendingUp size={15} color={ACCENT} />
                  <span className="body-font" style={{ fontSize: 12, color: '#8a8a95', letterSpacing: 0.5 }}>DERNIER SIGNAL (serveur)</span>
                </div>
                {lastV2Result ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                      {lastV2Result.direction === 'BUY' ? <TrendingUp color="#4ade80" size={22} /> : <TrendingDown color="#e5555a" size={22} />}
                      <span style={{ fontSize: 20, fontWeight: 700, color: lastV2Result.direction === 'BUY' ? '#4ade80' : '#e5555a' }}>{lastV2Result.direction}</span>
                      <span className="body-font" style={{ fontSize: 11, color: '#8a8a95' }}>score {lastV2Result.score?.toFixed(1)} / seuil {lastV2Result.threshold}</span>
                    </div>
                    <div className="body-font" style={{ fontSize: 12, color: '#b5b5c0' }}>ADX : {lastV2Result.adx != null ? lastV2Result.adx.toFixed(1) : '—'}</div>
                    {lastV2Result.blockedByRangeRegime && <div className="body-font" style={{ fontSize: 12, color: ACCENT, marginTop: 4 }}>⚠ Bloqué : hors tendance forte (ADX≤30)</div>}
                    {lastV2Result.blockedByNoMomentum && <div className="body-font" style={{ fontSize: 12, color: ACCENT, marginTop: 4 }}>⚠ Bloqué : pas de momentum d'entrée</div>}
                  </>
                ) : <div className="body-font" style={{ fontSize: 13, color: '#8a8a95' }}>Pas encore de cycle enregistré.</div>}
              </div>

              <div style={{ background: '#1A1A22', border: '1px solid #2c2c38', borderRadius: 12, padding: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                  <Target size={15} color={ACCENT} />
                  <span className="body-font" style={{ fontSize: 12, color: '#8a8a95', letterSpacing: 0.5 }}>POSITION OUVERTE</span>
                </div>
                {openPosition ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 18, fontWeight: 700, color: openPosition.direction === 'BUY' ? '#4ade80' : '#e5555a' }}>{openPosition.direction}</span>
                      <span className="body-font" style={{ fontSize: 12, color: '#b5b5c0' }}>@ ${openPosition.entryPrice.toFixed(2)}</span>
                      {statusInfo && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: statusInfo.color, padding: '3px 8px', background: '#0B0B0F', border: `1px solid ${statusInfo.color}`, borderRadius: 4 }}>
                          <ShieldCheck size={11} />
                          {statusInfo.label}
                        </span>
                      )}
                    </div>
                    {livePnl !== null && (
                      <div style={{ marginBottom: 10 }}>
                        <span style={{ fontSize: 16, fontWeight: 700, color: livePnl.pnl >= 0 ? '#4ade80' : '#e5555a' }}>{livePnl.pnl >= 0 ? '+' : ''}${livePnl.pnl.toFixed(2)}</span>
                        <span className="body-font" style={{ fontSize: 11, color: '#8a8a95', marginLeft: 6 }}>({livePnl.pnlPct >= 0 ? '+' : ''}{(livePnl.pnlPct * 100).toFixed(2)}%, non réalisé)</span>
                      </div>
                    )}
                    <div className="body-font" style={{ fontSize: 12, color: '#b5b5c0' }}>Taille: ${openPosition.positionSize.toFixed(2)}</div>
                    <div className="body-font" style={{ fontSize: 12, color: '#b5b5c0' }}>Score V2 à l'ouverture: {openPosition.score ?? '—'}</div>
                    {openPosition.peakUnrealizedPnl > 0 && (
                      <div className="body-font" style={{ fontSize: 12, color: '#b5b5c0' }}>Pic de profit atteint: ${openPosition.peakUnrealizedPnl.toFixed(2)}</div>
                    )}
                    <div className="body-font" style={{ fontSize: 12, color: '#b5b5c0' }}>Ouvert: {new Date(openPosition.openedAt).toLocaleString('fr-FR')}</div>
                    <div style={{ display: 'flex', gap: 20, marginTop: 12, paddingTop: 12, borderTop: '1px solid #2c2c38', flexWrap: 'wrap' }}>
                      <div>
                        <div className="body-font" style={{ fontSize: 10, color: '#8a8a95', textTransform: 'uppercase' }}>Stop-loss actuel</div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#e5555a' }}>${openPosition.stopLoss.toFixed(2)}</div>
                      </div>
                      {showTP && (
                        <div>
                          <div className="body-font" style={{ fontSize: 10, color: '#8a8a95', textTransform: 'uppercase' }}>Take-profit</div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#4ade80' }}>${openPosition.takeProfit.toFixed(2)}</div>
                        </div>
                      )}
                    </div>
                  </>
                ) : <div className="body-font" style={{ fontSize: 13, color: '#8a8a95' }}>Aucune position. Le serveur attend un signal fiable.</div>}
              </div>
            </div>

            <div style={{ background: '#1A1A22', border: '1px solid #2c2c38', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 20px', borderBottom: '1px solid #2c2c38' }}>
                <History size={15} color={ACCENT} />
                <span className="body-font" style={{ fontSize: 12, color: '#8a8a95', letterSpacing: 0.5 }}>TRADES DU JOUR ({todayClosedTrades.length})</span>
              </div>
              {todayClosedTrades.length === 0 ? (
                <div className="body-font" style={{ padding: 24, fontSize: 13, color: '#8a8a95' }}>Aucun trade clos aujourd'hui pour l'instant.</div>
              ) : (
                todayClosedTrades.map(t => <TradeRow key={t.id} t={t} />)
              )}
            </div>
          </>
        )}

        {activeTab === 'memoire' && (
          <div style={{ background: '#1A1A22', border: '1px solid #2c2c38', borderRadius: 12, padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
              <Brain size={16} color={ACCENT} />
              <span className="body-font" style={{ fontSize: 13, fontWeight: 600 }}>Ce que le bot a appris (V2)</span>
            </div>
            <p className="body-font" style={{ fontSize: 13, color: '#b5b5c0', lineHeight: 1.7, marginBottom: 20 }}>
              Après chaque trade clos, le décalage de seuil est recalculé selon le winrate des 20 derniers trades, et appliqué directement (contrairement au shadow, en mode observation seule).
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>
              <ParamCard label="Décalage de seuil appliqué" value={`${thresholdAdjustment >= 0 ? '+' : ''}${thresholdAdjustment}`} />
              <ParamCard label="Winrate (20 derniers)" value={recentWinRate !== null ? `${recentWinRate}%` : '—'} />
            </div>
            {closedTrades.length < 5 && (
              <div className="body-font" style={{ fontSize: 12, color: '#8a8a95', marginTop: 18, fontStyle: 'italic' }}>
                L'ajustement automatique s'active après 5 trades clos. ({closedTrades.length}/5)
              </div>
            )}
          </div>
        )}

        {activeTab === 'historique' && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <TrendingUp size={15} color={ACCENT} />
                <span className="body-font" style={{ fontSize: 12, color: '#8a8a95', letterSpacing: 0.5 }}>RÉGIME ADX — HEURES RENTABLES (TOUS JOURS CONFONDUS)</span>
              </div>
              <div style={{ display: 'grid', gap: 8 }}>
                {regimeBreakdown.map(r => <RegimeCard key={r.regime} data={r} />)}
              </div>
            </div>

            <div style={{ background: '#1A1A22', border: '1px solid #2c2c38', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 20px', borderBottom: '1px solid #2c2c38' }}>
                <CalendarClock size={15} color={ACCENT} />
                <span className="body-font" style={{ fontSize: 12, color: '#8a8a95', letterSpacing: 0.5 }}>BILAN PAR JOUR DE LA SEMAINE — CUMULÉ DEPUIS LE PASSAGE EN V2</span>
              </div>
              {weekdayBreakdown.map(day => <WeekdayPnlRow key={day.dow} day={day} />)}
            </div>

            <div style={{ background: '#1A1A22', border: '1px solid #2c2c38', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 20px', borderBottom: '1px solid #2c2c38' }}>
                <Clock size={15} color={ACCENT} />
                <span className="body-font" style={{ fontSize: 12, color: '#8a8a95', letterSpacing: 0.5 }}>BILAN PAR HEURE D'OUVERTURE (UTC) — CUMULÉ DEPUIS LE PASSAGE EN V2</span>
              </div>
              {hourlyBreakdown.length === 0 ? (
                <div className="body-font" style={{ padding: 24, fontSize: 13, color: '#8a8a95' }}>Aucun trade V2 clos pour l'instant.</div>
              ) : (
                hourlyBreakdown.map(h => <HourlyPnlRow key={h.hour} hourData={h} />)
              )}
            </div>

            <div style={{ background: '#1A1A22', border: '1px solid #2c2c38', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 20px', borderBottom: '1px solid #2c2c38' }}>
                <CalendarDays size={15} color={ACCENT} />
                <span className="body-font" style={{ fontSize: 12, color: '#8a8a95', letterSpacing: 0.5 }}>BILAN PAR JOUR — DEPUIS LE PASSAGE EN V2</span>
              </div>
              {dailyBreakdown.length === 0 ? (
                <div className="body-font" style={{ padding: 24, fontSize: 13, color: '#8a8a95' }}>Aucun trade V2 clos pour l'instant.</div>
              ) : (
                dailyBreakdown.map(day => <DailyPnlRow key={day.key} day={day} />)
              )}
            </div>

            {equityCurve.length > 1 && (
              <div style={{ background: '#1A1A22', border: '1px solid #2c2c38', borderRadius: 12, padding: 20, marginBottom: 16 }}>
                <div className="body-font" style={{ fontSize: 12, color: '#8a8a95', marginBottom: 14 }}>COURBE D'ÉQUITÉ</div>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={equityCurve}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2c2c38" />
                    <XAxis dataKey="trade" stroke="#5a5a68" fontSize={10} />
                    <YAxis stroke="#5a5a68" fontSize={10} domain={['auto', 'auto']} />
                    <Tooltip contentStyle={{ background: '#0B0B0F', border: '1px solid #2c2c38', borderRadius: 8 }} />
                    <ReferenceLine y={STARTING_CAPITAL} stroke="#5a5a68" strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="equity" stroke={ACCENT} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
            <div style={{ background: '#1A1A22', border: '1px solid #2c2c38', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 20px', borderBottom: '1px solid #2c2c38' }}>
                <History size={15} color={ACCENT} />
                <span className="body-font" style={{ fontSize: 12, color: '#8a8a95', letterSpacing: 0.5 }}>JOURNAL DES TRADES</span>
              </div>
              {trades.length === 0 ? (
                <div className="body-font" style={{ padding: 24, fontSize: 13, color: '#8a8a95' }}>Aucun trade pour l'instant.</div>
              ) : (
                [...trades].reverse().map(t => (
                  <div key={t.id} style={{ padding: '14px 20px', borderBottom: '1px solid #161c26' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: t.direction === 'BUY' ? '#4ade80' : '#e5555a' }}>{t.direction}</span>
                        <span className="body-font" style={{ fontSize: 12, color: '#b5b5c0' }}>@ ${t.entryPrice.toFixed(2)}{t.status === 'closed' ? ` → $${t.exitPrice.toFixed(2)}` : ''}</span>
                        {t.status === 'open' ? (
                          <span className="body-font" style={{ fontSize: 11, color: '#4a90d9', padding: '3px 8px', background: '#12203a', borderRadius: 4 }}>OUVERT</span>
                        ) : (
                          <span className="body-font" style={{ fontSize: 10, color: '#8a8a95', padding: '2px 6px', background: '#0B0B0F', borderRadius: 4 }}>{t.closeReason}</span>
                        )}
                      </div>
                      {t.status === 'closed' && (
                        <span style={{ fontSize: 13, fontWeight: 600, color: t.pnl >= 0 ? '#4ade80' : '#e5555a' }}>{t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}</span>
                      )}
                    </div>
                    {t.status === 'closed' && t.openedAt && t.closedAt && (
                      <div className="body-font" style={{ fontSize: 11, color: '#8a8a95', marginBottom: 6 }}>
                        Ouvert le {new Date(t.openedAt).toLocaleString('fr-FR')} &middot; Fermé le {new Date(t.closedAt).toLocaleString('fr-FR')} &middot; Durée : {formatDuration(t.openedAt, t.closedAt)}
                      </div>
                    )}
                    {t.status === 'closed' && (
                      <div className="body-font" style={{ fontSize: 12, color: '#b5b5c0', lineHeight: 1.5, fontStyle: 'italic' }}>{interpretTrade(t)}</div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, accent }) {
  return (
    <div style={{ background: '#1A1A22', border: '1px solid #2c2c38', borderRadius: 10, padding: '14px 16px' }}>
      <div className="body-font" style={{ fontSize: 10, color: '#8a8a95', letterSpacing: 0.5, marginBottom: 6, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: accent }}>{value}</div>
    </div>
  );
}

function PeriodCard({ label, data }) {
  if (!data || data.count === 0) {
    return (
      <div style={{ background: '#1A1A22', border: '1px solid #2c2c38', borderRadius: 10, padding: '12px 14px' }}>
        <div className="body-font" style={{ fontSize: 10, color: '#8a8a95', marginBottom: 6 }}>{label}</div>
        <div className="body-font" style={{ fontSize: 12, color: '#8a8a95' }}>Aucun trade</div>
      </div>
    );
  }

  return (
    <div style={{ background: '#1A1A22', border: '1px solid #2c2c38', borderRadius: 10, padding: '12px 14px' }}>
      <div className="body-font" style={{ fontSize: 10, color: '#8a8a95', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: data.totalPnl >= 0 ? '#4ade80' : '#e5555a', marginBottom: 2 }}>
        {data.totalPnl >= 0 ? '+' : ''}${data.totalPnl.toFixed(2)}
      </div>
      <div className="body-font" style={{ fontSize: 10, color: '#8a8a95' }}>{data.count} trade{data.count > 1 ? 's' : ''} &middot; {data.winRate}% win</div>
    </div>
  );
}

function ParamCard({ label, value }) {
  return (
    <div style={{ background: '#0B0B0F', border: '1px solid #2c2c38', borderRadius: 8, padding: '14px 16px', textAlign: 'center' }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#D4AF37', marginBottom: 4 }}>{value}</div>
      <div className="body-font" style={{ fontSize: 10, color: '#8a8a95' }}>{label}</div>
    </div>
  );
}
