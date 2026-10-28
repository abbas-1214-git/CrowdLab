import { describe, expect, it } from 'vitest';
import { getLiveInsights, type InsightsInput } from './insightModel';

const makeState = (status: string, actualValue: unknown = null): InsightsInput => ({
  experiment: { min: -273.15, max: 1000 },
  round: { status, actualValue },
  predictions: [],
  leaderboard: [],
});

const prediction = (userId: string, username: string, value: unknown, acceptanceStatus = 'accepted') => ({ userId, username, value, acceptanceStatus });
const entry = (userId: string, username: string, value: unknown, rank: unknown, absoluteError: unknown) => ({ rank, absoluteError, prediction: { userId, username, value } });

describe('live experiment insights', () => {
  it('counts accepted in-range values and keeps full precision through mean and error calculations', () => {
    const state = makeState('completed', 85);
    state.predictions = [prediction('1', 'Ada', 80.1234), prediction('2', 'Bea', 90.1234)];
    state.leaderboard = [entry('1', 'Ada', 80.1234, 1, 4.8766)];
    const insights = getLiveInsights(state);

    expect(insights).toMatchObject({ predictionCount: 2, actualValue: 85, resultStatus: 'valid' });
    expect(insights.meanPrediction).toBeCloseTo(85.1234, 12);
    expect(insights.crowdDifference).toBeCloseTo(85.1234 - 85, 12);
    expect(insights.crowdAbsoluteError).toBeCloseTo(Math.abs(85.1234 - 85), 12);
    expect(insights.closest).toEqual([{ userId: '1', username: 'Ada', value: 80.1234, absoluteError: 4.8766 }]);
  });

  it('handles an empty open round without inventing a mean or result', () => {
    const insights = getLiveInsights(makeState('open'));
    expect(insights).toMatchObject({ predictionCount: 0, meanPrediction: null, actualValue: null, resultStatus: 'waiting', crowdAbsoluteError: null, crowdDifference: null, closest: [], closestStatus: 'waiting' });
  });

  it('does not reveal a supplied measurement before the round is completed', () => {
    const state = makeState('locked', 82);
    state.predictions = [prediction('1', 'Ada', 80)];
    state.leaderboard = [entry('1', 'Ada', 80, 1, 2)];
    expect(getLiveInsights(state)).toMatchObject({ actualValue: null, resultStatus: 'waiting', crowdAbsoluteError: null, crowdDifference: null, closest: [], closestStatus: 'waiting' });
  });

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY, 1001, -274])('rejects missing or invalid completed measurements (%s)', (actualValue) => {
    const state = makeState('completed', actualValue);
    state.predictions = [prediction('1', 'Ada', 80)];
    expect(getLiveInsights(state)).toMatchObject({ resultStatus: 'invalid', actualValue: null, crowdAbsoluteError: null, crowdDifference: null, closest: [], closestStatus: 'waiting' });
  });

  it('keeps a valid actual result visible for a completed round with no predictions', () => {
    expect(getLiveInsights(makeState('completed', 82))).toMatchObject({ resultStatus: 'valid', actualValue: 82, predictionCount: 0, meanPrediction: null, crowdAbsoluteError: null, closestStatus: 'empty' });
  });

  it('ignores rejected, non-finite and out-of-range predictions', () => {
    const state = makeState('open');
    state.predictions = [prediction('1', 'Ada', 85), prediction('2', 'Bea', 90, 'rejected'), prediction('3', 'Cy', Number.NaN), prediction('4', 'Dee', 1001)];
    expect(getLiveInsights(state)).toMatchObject({ predictionCount: 1, meanPrediction: 85 });
  });

  it('shows every server-ranked closest tie and excludes entries outside the accepted prediction set', () => {
    const state = makeState('completed', 82);
    state.predictions = [prediction('1', 'Ada', 80), prediction('2', 'Bea', 84), prediction('3', 'Cy', 90)];
    state.leaderboard = [entry('1', 'Ada', 80, 1, 2), entry('2', 'Bea', 84, 1, 2), entry('3', 'Cy', 90, 3, 8), entry('unknown', 'Dee', 82, 1, 0)];
    expect(getLiveInsights(state).closest).toEqual([
      { userId: '1', username: 'Ada', value: 80, absoluteError: 2 },
      { userId: '2', username: 'Bea', value: 84, absoluteError: 2 },
    ]);
  });
});
