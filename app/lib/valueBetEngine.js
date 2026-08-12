/**
 * valueBetEngine.js
 * Module de détection de value bets — à brancher sur PrédireFoot (Poisson bivarié)
 *
 * Entrée attendue :
 *  - modelProbs : probabilités sorties par ton modèle Poisson
 *      { home: 0.42, draw: 0.28, away: 0.30 }  (doit sommer à 1)
 *  - marketOdds : cotes brutes du bookmaker pour le même marché
 *      { home: 2.10, draw: 3.40, away: 3.60 }
 *
 * Sortie : liste triée par EV décroissant avec edge, EV, et score ajusté confiance
 */

// ---------------------------------------------------------------------------
// 1. DÉVIGORATION DES COTES (retirer la marge bookmaker)
// ---------------------------------------------------------------------------

/**
 * Méthode proportionnelle (simple, rapide) :
 * on normalise les probabilités implicites brutes pour qu'elles somment à 1.
 */
function devigProportional(oddsObj) {
  const implied = {};
  let overround = 0;

  for (const key in oddsObj) {
    implied[key] = 1 / oddsObj[key];
    overround += implied[key];
  }

  const fair = {};
  for (const key in implied) {
    fair[key] = implied[key] / overround;
  }

  return { fair, overround }; // overround > 1 = marge du bookmaker
}

/**
 * Méthode "power" (plus précise sur marchés à forte marge, ex: petites ligues) :
 * cherche l'exposant k tel que sum((1/odds)^k) = 1
 */
function devigPower(oddsObj, tolerance = 1e-6, maxIter = 100) {
  const rawImplied = Object.values(oddsObj).map((o) => 1 / o);

  let k = 1;
  let low = 0.01;
  let high = 5;

  for (let i = 0; i < maxIter; i++) {
    k = (low + high) / 2;
    const sum = rawImplied.reduce((acc, p) => acc + Math.pow(p, k), 0);

    if (Math.abs(sum - 1) < tolerance) break;
    if (sum > 1) {
      low = k;
    } else {
      high = k;
    }
  }

  const fair = {};
  const keys = Object.keys(oddsObj);
  keys.forEach((key, i) => {
    fair[key] = Math.pow(rawImplied[i], k);
  });

  return { fair, exponent: k };
}

// ---------------------------------------------------------------------------
// 2. EDGE ET EXPECTED VALUE
// ---------------------------------------------------------------------------

/**
 * Edge = écart entre ta probabilité modèle et la probabilité "juste" du marché
 * Exprimé en points de pourcentage
 */
function calculateEdge(modelProb, fairMarketProb) {
  return modelProb - fairMarketProb;
}

/**
 * EV (Expected Value) par unité misée, basé sur la cote BRUTE du bookmaker
 * (c'est la cote réelle qui paie, pas la cote "fair")
 */
function calculateEV(modelProb, rawOdds) {
  return modelProb * rawOdds - 1;
}

// ---------------------------------------------------------------------------
// 3. PONDÉRATION CONFIANCE (éviter les faux positifs sur données faibles)
// ---------------------------------------------------------------------------

/**
 * Facteur de confiance basé sur la taille d'échantillon disponible
 * (nb de confrontations H2H, nb de matchs de forme récente utilisés)
 *
 * Retourne un multiplicateur entre 0 et 1 appliqué à l'edge/EV
 */
function confidenceWeight({ h2hCount = 0, recentFormCount = 0 }) {
  const H2H_TARGET = 6;   // nb de H2H jugé "suffisant"
  const FORM_TARGET = 10; // nb de matchs de forme jugé "suffisant"

  const h2hFactor = Math.min(h2hCount / H2H_TARGET, 1);
  const formFactor = Math.min(recentFormCount / FORM_TARGET, 1);

  // Pondération : la forme récente compte un peu plus que le H2H (plus fiable statistiquement)
  return 0.4 * h2hFactor + 0.6 * formFactor;
}

// ---------------------------------------------------------------------------
// 4. MOTEUR PRINCIPAL
// ---------------------------------------------------------------------------

/**
 * @param modelProbs   { home, draw, away } — sortie de ton modèle Poisson
 * @param marketOdds   { home, draw, away } — cotes brutes bookmaker
 * @param options
 *    - devigMethod: 'proportional' | 'power' (défaut: 'power')
 *    - edgeThreshold: seuil minimum d'edge pour flag value bet (défaut: 0.03 = 3%)
 *    - evThreshold: seuil minimum d'EV pour flag value bet (défaut: 0.02)
 *    - confidence: { h2hCount, recentFormCount }
 */
function evaluateValueBets(modelProbs, marketOdds, options = {}) {
  const {
    devigMethod = "power",
    edgeThreshold = 0.03,
    evThreshold = 0.02,
    confidence = {},
  } = options;

  const { fair, overround, exponent } =
    devigMethod === "power" ? devigPower(marketOdds) : devigProportional(marketOdds);

  const confFactor = confidenceWeight(confidence);

  const results = [];

  for (const outcome in modelProbs) {
    const modelProb = modelProbs[outcome];
    const rawOdds = marketOdds[outcome];
    const fairProb = fair[outcome];

    const edge = calculateEdge(modelProb, fairProb);
    const ev = calculateEV(modelProb, rawOdds);

    const adjustedEdge = edge * confFactor;
    const adjustedEV = ev * confFactor;

    results.push({
      outcome,
      modelProb: round(modelProb),
      fairMarketProb: round(fairProb),
      rawOdds,
      edge: round(edge),
      ev: round(ev),
      confidenceFactor: round(confFactor),
      adjustedEdge: round(adjustedEdge),
      adjustedEV: round(adjustedEV),
      isValueBet: adjustedEdge >= edgeThreshold && adjustedEV >= evThreshold,
    });
  }

  results.sort((a, b) => b.adjustedEV - a.adjustedEV);

  return {
    results,
    marketInfo: {
      overround: overround ? round(overround) : undefined,
      exponent: exponent ? round(exponent) : undefined,
      bookmakerMargin: overround ? round((overround - 1) * 100) + "%" : undefined,
    },
  };
}

function round(x) {
  return Math.round(x * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// EXEMPLE D'USAGE
// ---------------------------------------------------------------------------
/*
const modelProbs = { home: 0.42, draw: 0.28, away: 0.30 };
const marketOdds = { home: 2.10, draw: 3.40, away: 3.60 };

const output = evaluateValueBets(modelProbs, marketOdds, {
  devigMethod: "power",
  edgeThreshold: 0.03,
  evThreshold: 0.02,
  confidence: { h2hCount: 5, recentFormCount: 8 },
});

console.log(output);
*/

module.exports = {
  devigProportional,
  devigPower,
  calculateEdge,
  calculateEV,
  confidenceWeight,
  evaluateValueBets,
};
