// app/lib/aiTradeAnalysis.js
// Couche de vérification contextuelle par IA, appelée uniquement au moment où le score
// technique (scoreEngine) décide d'ouvrir une position. Ne remplace jamais le score —
// agit comme un filtre de bon sens supplémentaire basé sur l'actualité macro/marché,
// la cohérence du signal, et désormais une lecture qualitative des dernières bougies.
// Utilise l'API Anthropic (Claude) avec recherche web, PAS claude.ai.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

// Formate les dernières bougies en texte compact, pour une LECTURE QUALITATIVE uniquement
// (mèches longues, séquence de bougies, essoufflement). L'IA ne doit jamais recalculer
// d'indicateurs (EMA/RSI/MACD/ADX) à partir de ces chiffres bruts — ce travail précis est
// déjà fait en amont par scoreEngine.js, et une ré-estimation par l'IA serait moins fiable.
function formatCandles(recentCandles) {
  if (!recentCandles || recentCandles.length === 0) return null;
  return recentCandles
    .slice(-15)
    .map(c => {
      const time = new Date(c.time).toISOString().slice(11, 16);
      return `${time} O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)}`;
    })
    .join('\n');
}

const DAY_LABELS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

// Calcule le winrate/P&L historique pour le créneau jour-de-semaine + heure UTC exact où
// on s'apprête à trader — même logique que le bilan par heure du dashboard, mais interrogé
// ici en amont de la décision plutôt qu'affiché après coup.
function getHistoricalHourStats(trades, dayOfWeek, hourUTC) {
  if (!trades || trades.length === 0) return null;

  const matching = trades.filter(t => {
    if (t.status !== 'closed' || !t.openedAt || t.score === undefined || t.score === null) return false;
    const d = new Date(t.openedAt);
    return d.getUTCDay() === dayOfWeek && d.getUTCHours() === hourUTC;
  });

  if (matching.length === 0) return null;

  const wins = matching.filter(t => t.pnl > 0).length;
  const pnl = matching.reduce((sum, t) => sum + t.pnl, 0);

  return {
    count: matching.length,
    winRate: Math.round((wins / matching.length) * 1000) / 10,
    pnl: Math.round(pnl * 100) / 100,
  };
}

/**
 * Interroge l'IA pour vérifier s'il existe un risque contextuel majeur (actualité,
 * événement macro imminent) qui justifierait de ne PAS ouvrir de position maintenant,
 * même si le score technique est favorable — donne aussi un second avis qualitatif sur
 * la cohérence du signal technique, l'allure des dernières bougies, et la performance
 * historique connue pour ce créneau jour/heure précis.
 *
 * @param {string} symbol - 'XAU/USD' ou 'EUR/USD'
 * @param {'BUY'|'SELL'} direction
 * @param {Object} scoreSummary - résumé du calcul déjà fait par scoreEngine.js (v2Result)
 *   { score, adx, threshold, breakdown: { trend, macd, rsi, h1Confirmation, volatility } }
 * @param {Array} [recentCandles] - ~15 dernières bougies 5min {time, open, high, low, close},
 *   pour lecture qualitative uniquement (pas de recalcul d'indicateurs)
 * @param {Array} [trades] - historique de trades clos (state.trades), pour calculer la
 *   performance connue de ce créneau jour/heure précis
 * @returns {Promise<{available: boolean, riskLevel: 'low'|'medium'|'high', note: string}>}
 */
export async function checkTradeContext(symbol, direction, scoreSummary = null, recentCandles = null, trades = []) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    // Pas de clé configurée : on n'écrase jamais la décision du score technique.
    // On retourne un statut "indisponible" plutôt que de bloquer par défaut.
    return { available: false, riskLevel: 'low', note: 'Clé ANTHROPIC_API_KEY non configurée — vérification IA ignorée.' };
  }

  // Construction d'un résumé lisible du score, si fourni — l'IA ne reçoit JAMAIS les
  // bougies brutes pour en tirer des calculs (les LLM ne sont pas fiables pour ça),
  // seulement l'interprétation déjà calculée par scoreEngine.js.
  let scoreSummaryText = '';
  if (scoreSummary) {
    const { score, adx, threshold, breakdown } = scoreSummary;
    scoreSummaryText = `
Résumé du signal technique déjà calculé (ne le recalcule pas, sers-t-en comme contexte) :
- Score global : ${score}/100 (seuil requis pour trader : ${threshold})
- ADX : ${adx !== null ? adx.toFixed(1) : 'indisponible'}
- Tendance (EMA) : ${breakdown.trend.points}pts, direction ${breakdown.trend.direction}
- MACD : ${breakdown.macd.points}pts, direction ${breakdown.macd.direction}
- RSI : ${breakdown.rsi.points.toFixed(1)}pts, direction ${breakdown.rsi.direction}
- Confirmation H1 : ${breakdown.h1Confirmation.points}pts, direction ${breakdown.h1Confirmation.direction}
- Volatilité (ATR) : ${breakdown.volatility.points.toFixed(1)}pts
`;
  }

  const candlesText = formatCandles(recentCandles);
  const candlesSection = candlesText
    ? `
Dernières bougies 5min (UTC, plus ancienne en premier) — LECTURE QUALITATIVE UNIQUEMENT :
${candlesText}
Ne recalcule aucun indicateur (EMA/RSI/MACD/ADX) à partir de ces chiffres. Utilise-les seulement
pour repérer un pattern visuel évident : mèches longues suggérant un rejet, essoufflement d'une
séquence de bougies dans le même sens, indécision marquée juste avant l'entrée.
`
    : '';

  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const hourUTC = now.getUTCHours();
  const histStats = getHistoricalHourStats(trades, dayOfWeek, hourUTC);
  const historicalSection = histStats
    ? `
Historique connu pour ce créneau précis (${DAY_LABELS[dayOfWeek]}, ${hourUTC}h-${(hourUTC + 1) % 24}h UTC) :
${histStats.count} trades, ${histStats.winRate}% gagnants, P&L cumulé ${histStats.pnl >= 0 ? '+' : ''}${histStats.pnl}$.
${histStats.count < 15 ? "Échantillon petit (< 15 trades) — ne doit PAS peser lourd dans le verdict, mentionne-le comme faible indice seulement." : ''}
`
    : `
Aucun historique disponible pour ce créneau précis (${DAY_LABELS[dayOfWeek]}, ${hourUTC}h UTC) — n'invente rien à ce sujet.
`;

  const prompt = `Tu donnes un second avis avant l'ouverture d'une position de trading ${direction} sur ${symbol}.
${scoreSummaryText}${candlesSection}${historicalSection}
Fais ces vérifications :
1. Recherche s'il existe, dans les prochaines 24 heures ou dans l'actualité très récente, un événement susceptible d'invalider ce signal : annonce de banque centrale (Fed, BCE), publication économique majeure (NFP, CPI), déclaration géopolitique soudaine, ou mouvement de marché anormal en cours.
2. Si un résumé de score est fourni ci-dessus, donne un avis qualitatif bref sur sa cohérence : est-ce que les composantes se contredisent de façon suspecte, ou le signal te semble-t-il raisonnablement solide ?
3. Si des bougies récentes sont fournies ci-dessus, indique si leur allure visuelle (mèches, séquence) contredit clairement le signal ou non.
4. Si un historique jour/heure est fourni ci-dessus avec un échantillon suffisant (≥15 trades) et une performance nettement négative, mentionne-le comme facteur ; sinon ignore ce point.

Réponds UNIQUEMENT au format JSON strict, sans aucun texte avant ou après :
{"riskLevel": "low" | "medium" | "high", "note": "une ou deux phrases courtes combinant les points pertinents"}

"high" = événement majeur imminent/en cours, signal technique manifestement incohérent, pattern de bougies contredisant clairement le signal, OU historique nettement négatif sur ce créneau avec échantillon suffisant (≥15 trades) — position déconseillée.
"medium" = un facteur à surveiller, sans être bloquant.
"low" = rien de particulier détecté, signal cohérent avec le contexte disponible.`;

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `Erreur API Anthropic (${response.status})`);
    }

    // Récupère le dernier bloc texte de la réponse (après d'éventuels blocs d'outil/recherche)
    const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
    const rawText = textBlocks.join('\n').trim();

    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      available: true,
      riskLevel: parsed.riskLevel || 'low',
      note: parsed.note || 'Analyse IA reçue sans détail.',
    };
  } catch (err) {
    // En cas d'échec (parsing, réseau, quota) : on ne bloque jamais le trade sur une
    // erreur technique de l'IA — on le signale juste comme indisponible ce cycle-là.
    return { available: false, riskLevel: 'low', note: `Vérification IA échouée : ${err.message}` };
  }
}
