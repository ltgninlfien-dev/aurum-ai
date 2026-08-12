/**
 * poissonModel.js
 * Modèle Poisson bivarié (Dixon-Coles) calculé à partir de stats saisies manuellement.
 * Sort les probabilités 1X2, Over/Under, BTTS, et top scores exacts.
 *
 * Aucune dépendance externe — branchable direct dans une API route Next.js.
 */

// ---------------------------------------------------------------------------
// 1. FORCES ATTAQUE / DÉFENSE
// ---------------------------------------------------------------------------

/**
 * @param homeTeam { avgGoalsScoredHome, avgGoalsConcededHome }
 * @param awayTeam { avgGoalsScoredAway, avgGoalsConcededAway }
 * @param leagueAvg { goalsHome, goalsAway } — moyennes de la ligue (défaut Europe standard)
 */
function computeLambdas(homeTeam, awayTeam, leagueAvg = { goalsHome: 1.5, goalsAway: 1.1 }) {
  const homeAttack = homeTeam.avgGoalsScoredHome / leagueAvg.goalsHome;
  const homeDefenseWeakness = homeTeam.avgGoalsConcededHome / leagueAvg.goalsAway;

  const awayAttack = awayTeam.avgGoalsScoredAway / leagueAvg.goalsAway;
  const awayDefenseWeakness = awayTeam.avgGoalsConcededAway / leagueAvg.goalsHome;

  const lambdaHome = homeAttack * awayDefenseWeakness * leagueAvg.goalsHome;
  const lambdaAway = awayAttack * homeDefenseWeakness * leagueAvg.goalsAway;

  return { lambdaHome, lambdaAway };
}

// ---------------------------------------------------------------------------
// 2. POISSON + CORRECTION DIXON-COLES (corrélation scores faibles)
// ---------------------------------------------------------------------------

function poissonPmf(k, lambda) {
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

function factorial(n) {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

/**
 * Fonction tau de Dixon-Coles : ajuste les probas des scores 0-0, 1-0, 0-1, 1-1
 * pour corriger la sous-estimation du modèle Poisson indépendant sur ces scores.
 * rho ≈ -0.10 typique en football (corrélation légèrement négative)
 */
function dixonColesTau(x, y, lambdaHome, lambdaAway, rho = -0.1) {
  if (x === 0 && y === 0) return 1 - lambdaHome * lambdaAway * rho;
  if (x === 0 && y === 1) return 1 + lambdaHome * rho;
  if (x === 1 && y === 0) return 1 + lambdaAway * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/**
 * Construit la matrice de probabilité des scores exacts (0-0 à maxGoals-maxGoals)
 */
function buildScoreMatrix(lambdaHome, lambdaAway, maxGoals = 8, rho = -0.1) {
  const matrix = [];
  for (let h = 0; h <= maxGoals; h++) {
    const row = [];
    for (let a = 0; a <= maxGoals; a++) {
      const base = poissonPmf(h, lambdaHome) * poissonPmf(a, lambdaAway);
      const tau = dixonColesTau(h, a, lambdaHome, lambdaAway, rho);
      row.push(base * tau);
    }
    matrix.push(row);
  }

  // Renormaliser pour que la somme totale reste à 1 après ajustement tau
  const total = matrix.flat().reduce((a, b) => a + b, 0);
  return matrix.map((row) => row.map((p) => p / total));
}

// ---------------------------------------------------------------------------
// 3. MARCHÉS DÉRIVÉS
// ---------------------------------------------------------------------------

function derivedMarkets(matrix) {
  let home = 0,
    draw = 0,
    away = 0;
  let btts = 0;
  const overUnder = {}; // clé "2.5" -> { over, under }
  const scoreProbs = [];

  const lines = [0.5, 1.5, 2.5, 3.5, 4.5];
  lines.forEach((l) => (overUnder[l] = { over: 0, under: 0 }));

  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      const p = matrix[h][a];
      const totalGoals = h + a;

      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;

      if (h > 0 && a > 0) btts += p;

      lines.forEach((l) => {
        if (totalGoals > l) overUnder[l].over += p;
        else overUnder[l].under += p;
      });

      scoreProbs.push({ score: `${h}-${a}`, prob: p });
    }
  }

  scoreProbs.sort((x, y) => y.prob - x.prob);

  return {
    matchResult: { home: round(home), draw: round(draw), away: round(away) },
    btts: { yes: round(btts), no: round(1 - btts) },
    overUnder: Object.fromEntries(
      Object.entries(overUnder).map(([line, v]) => [
        line,
        { over: round(v.over), under: round(v.under) },
      ])
    ),
    topScores: scoreProbs.slice(0, 5).map((s) => ({ ...s, prob: round(s.prob) })),
  };
}

function round(x) {
  return Math.round(x * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// 4. FONCTION PRINCIPALE
// ---------------------------------------------------------------------------

/**
 * @param homeTeam { avgGoalsScoredHome, avgGoalsConcededHome }
 * @param awayTeam { avgGoalsScoredAway, avgGoalsConcededAway }
 * @param options  { leagueAvg, maxGoals, rho }
 */
function predictMatch(homeTeam, awayTeam, options = {}) {
  const { leagueAvg, maxGoals = 8, rho = -0.1 } = options;

  const { lambdaHome, lambdaAway } = computeLambdas(homeTeam, awayTeam, leagueAvg);
  const matrix = buildScoreMatrix(lambdaHome, lambdaAway, maxGoals, rho);
  const markets = derivedMarkets(matrix);

  return {
    lambdas: { home: round(lambdaHome), away: round(lambdaAway) },
    ...markets,
  };
}

// ---------------------------------------------------------------------------
// EXEMPLE D'USAGE
// ---------------------------------------------------------------------------
/*
const homeTeam = { avgGoalsScoredHome: 1.8, avgGoalsConcededHome: 0.9 };
const awayTeam = { avgGoalsScoredAway: 1.1, avgGoalsConcededAway: 1.4 };

const prediction = predictMatch(homeTeam, awayTeam, {
  leagueAvg: { goalsHome: 1.5, goalsAway: 1.1 },
});

console.log(prediction);
// -> { lambdas, matchResult: {home, draw, away}, btts, overUnder, topScores }
*/

module.exports = {
  computeLambdas,
  buildScoreMatrix,
  derivedMarkets,
  predictMatch,
};
