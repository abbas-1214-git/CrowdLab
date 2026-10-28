import { parseNumericValue, PredictionStore, type CompletedRound, type ExperimentState, type LeaderboardEntry, type Prediction, type PredictionSource } from './predictions.js';

export class GameActionError extends Error {
  constructor(message: string, readonly statusCode: 409 | 422) { super(message); }
}

type SubmitInput = { userId: string; username: string; text: string; source: PredictionSource };

export class ExperimentGame {
  private timer?: ReturnType<typeof setTimeout>;
  private shuttingDown = false;
  private readonly now: () => number;

  constructor(
    readonly store: PredictionStore,
    private readonly onChange: () => void,
    private readonly durationMs = 60_000,
    now: () => number = Date.now,
  ) { this.now = now; }

  getState(): ExperimentState {
    const now = this.now();
    const round = this.store.state.round;
    if (!this.shuttingDown && round.status === 'open' && round.deadlineAt !== null && now >= round.deadlineAt) {
      this.clearTimer();
      this.store.state.round = { ...round, status: 'locked', lockedAt: now };
      this.onChange();
    }
    this.store.state.serverNow = now;
    return this.store.state;
  }

  startRound(): ExperimentState {
    const round = this.store.state.round;
    if (round.status !== 'ready' && round.status !== 'completed') throw new GameActionError('A round can start only when the experiment is ready or the previous round is complete.', 409);
    const nextRound = round.status === 'completed' ? round.number + 1 : round.number;
    if (round.status === 'completed') this.store.resetForRound(nextRound);
    const openedAt = this.now();
    this.store.state.round = { number: nextRound, status: 'open', openedAt, deadlineAt: openedAt + this.durationMs, lockedAt: null, actualValue: null, completedAt: null };
    this.clearTimer();
    this.timer = setTimeout(() => {
      if (this.store.state.round.status === 'open') this.lockRound();
    }, this.durationMs);
    this.onChange();
    return this.getState();
  }

  lockRound(): ExperimentState {
    if (this.store.state.round.status !== 'open') throw new GameActionError('Only an open prediction round can be locked.', 409);
    this.clearTimer();
    this.store.state.round = { ...this.store.state.round, status: 'locked', lockedAt: this.now() };
    this.onChange();
    return this.getState();
  }

  submit(input: SubmitInput): { accepted: true; prediction: Prediction } | { accepted: false; reason: string } {
    const round = this.store.state.round;
    if (round.status === 'open' && round.deadlineAt !== null && this.now() >= round.deadlineAt) this.lockRound();
    if (this.store.state.round.status !== 'open') return { accepted: false, reason: `Predictions are ${this.store.state.round.status}.` };
    const result = this.store.submit(input);
    if (result.accepted) this.onChange();
    return result;
  }

  recordResult(rawValue: unknown): ExperimentState {
    if (this.store.state.round.status !== 'locked') throw new GameActionError('Lock predictions before recording the measured result.', 409);
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number') throw new GameActionError('Enter a numerical measurement.', 422);
    const parsed = parseNumericValue(String(rawValue), this.store.state.experiment.min, this.store.state.experiment.max);
    if (!parsed.ok) throw new GameActionError(parsed.reason, 422);

    const experimentId = this.store.state.experiment.id;
    const predictions = [...this.store.state.predictions];
    if (predictions.some((prediction) => prediction.experimentId !== experimentId)) throw new Error('Cannot score a prediction from a different experiment round.');
    const scoreScale = predictions.reduce((scale, prediction) => Math.max(scale, Math.abs(prediction.value)), Math.abs(parsed.value));
    // Subtraction of decimal chat values can differ by a few ULPs even when the decimal errors are equal.
    const errorTieTolerance = Number.EPSILON * Math.max(1, scoreScale) * 2;
    const ranked = predictions
      .map((prediction) => ({ prediction, absoluteError: Math.abs(prediction.value - parsed.value), unit: '°C' as const }))
      .sort((a, b) => a.absoluteError - b.absoluteError || a.prediction.username.localeCompare(b.prediction.username) || a.prediction.submittedAt.localeCompare(b.prediction.submittedAt));
    let previousError: number | undefined;
    let previousRank = 0;
    const leaderboard: LeaderboardEntry[] = ranked.map((entry, index) => {
      const rank = index > 0 && previousError !== undefined && Math.abs(entry.absoluteError - previousError) <= errorTieTolerance ? previousRank : index + 1;
      previousError = entry.absoluteError;
      previousRank = rank;
      return { ...entry, rank };
    });
    const completedAt = this.now();
    this.store.state.round = { ...this.store.state.round, status: 'completed', actualValue: parsed.value, completedAt };
    this.store.state.leaderboard = leaderboard;
    const summary: CompletedRound = { experimentId, roundNumber: this.store.state.round.number, actualValue: parsed.value, completedAt, predictionCount: predictions.length, leaderboard };
    this.store.state.completedRounds.push(summary);
    this.onChange();
    return this.getState();
  }

  shutdown(): void { this.shuttingDown = true; this.clearTimer(); }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
