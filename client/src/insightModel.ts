export type InsightsInput = {
  experiment: { min: number; max: number };
  round: { status: string; actualValue: unknown };
  predictions: readonly { userId: string; username: string; value: unknown; acceptanceStatus: string }[];
  leaderboard: readonly {
    rank: unknown;
    absoluteError: unknown;
    prediction: { userId: string; username: string; value: unknown };
  }[];
};

export type ClosestPrediction = { userId: string; username: string; value: number; absoluteError: number };
export type LiveInsights = {
  predictionCount: number;
  meanPrediction: number | null;
  actualValue: number | null;
  resultStatus: 'waiting' | 'valid' | 'invalid';
  crowdAbsoluteError: number | null;
  crowdDifference: number | null;
  closest: ClosestPrediction[];
  closestStatus: 'waiting' | 'empty' | 'available' | 'unavailable';
};

function isInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

export function getLiveInsights(state: InsightsInput): LiveInsights {
  const { min, max } = state.experiment;
  const predictions = state.predictions.filter((prediction) =>
    prediction.acceptanceStatus === 'accepted' && isInRange(prediction.value, min, max),
  );
  const predictionCount = predictions.length;
  const meanPrediction = predictionCount > 0
    ? predictions.reduce((total, prediction) => total + (prediction.value as number), 0) / predictionCount
    : null;

  const resultStatus: LiveInsights['resultStatus'] = state.round.status !== 'completed'
    ? 'waiting'
    : isInRange(state.round.actualValue, min, max) ? 'valid' : 'invalid';
  const actualValue = resultStatus === 'valid' ? state.round.actualValue as number : null;
  const crowdDifference = meanPrediction !== null && actualValue !== null ? meanPrediction - actualValue : null;
  const crowdAbsoluteError = crowdDifference === null ? null : Math.abs(crowdDifference);

  const acceptedUserIds = new Set(predictions.map((prediction) => prediction.userId));
  const closest = resultStatus === 'valid' && predictionCount > 0
    ? state.leaderboard
      .filter((entry) => entry.rank === 1 && acceptedUserIds.has(entry.prediction.userId) &&
        typeof entry.prediction.username === 'string' && entry.prediction.username.trim().length > 0 &&
        isInRange(entry.prediction.value, min, max) && typeof entry.absoluteError === 'number' &&
        Number.isFinite(entry.absoluteError) && entry.absoluteError >= 0)
      .map((entry) => ({
        userId: entry.prediction.userId,
        username: entry.prediction.username,
        value: entry.prediction.value as number,
        absoluteError: entry.absoluteError as number,
      }))
    : [];
  const closestStatus: LiveInsights['closestStatus'] = resultStatus !== 'valid'
    ? 'waiting'
    : predictionCount === 0 ? 'empty' : closest.length > 0 ? 'available' : 'unavailable';

  return { predictionCount, meanPrediction, actualValue, resultStatus, crowdAbsoluteError, crowdDifference, closest, closestStatus };
}
