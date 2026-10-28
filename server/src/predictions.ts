export type PredictionSource = 'twitch' | 'local-test';
export type Prediction = {
  experimentId: string;
  userId: string;
  username: string;
  value: number;
  unit: '°C';
  submittedAt: string;
  source: PredictionSource;
  acceptanceStatus: 'accepted';
};

export type ExperimentState = {
  serverNow: number;
  experiment: { id: string; title: string; unit: '°C'; command: '!predict'; min: number; max: number };
  round: { number: number; status: 'ready' | 'open' | 'locked' | 'completed'; openedAt: number | null; deadlineAt: number | null; lockedAt: number | null; actualValue: number | null; completedAt: number | null };
  predictions: Prediction[];
  leaderboard: LeaderboardEntry[];
  completedRounds: CompletedRound[];
};

export type LeaderboardEntry = { rank: number; prediction: Prediction; absoluteError: number; unit: '°C' };
export type CompletedRound = { experimentId: string; roundNumber: number; actualValue: number; completedAt: number; predictionCount: number; leaderboard: LeaderboardEntry[] };

export type ParseResult = { ok: true; value: number } | { ok: false; reason: string };

export function parsePrediction(text: string, min: number, max: number): ParseResult {
  const trimmed = text.trim();
  const match = /^!predict(?:\s+(.+))?$/i.exec(trimmed);
  if (!match) return { ok: false, reason: 'Use !predict followed by one number.' };
  const raw = match[1]?.trim();
  if (!raw) return { ok: false, reason: 'Add a numerical prediction after !predict.' };
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return { ok: false, reason: 'Prediction must be a finite number.' };
  return parseNumericValue(raw, min, max);
}

export function parseNumericValue(raw: string, min: number, max: number): ParseResult {
  const valueText = raw.trim();
  if (!valueText) return { ok: false, reason: 'Enter a numerical value.' };
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(valueText)) return { ok: false, reason: 'Value must be a finite number.' };
  const value = Number(valueText);
  if (!Number.isFinite(value)) return { ok: false, reason: 'Prediction must be a finite number.' };
  if (value < min || value > max) return { ok: false, reason: `Value must be between ${min} and ${max} °C.` };
  return { ok: true, value };
}

export class PredictionStore {
  readonly state: ExperimentState;
  private readonly acceptedByUser = new Map<string, Prediction>();

  constructor(min: number, max: number) {
    this.state = {
      serverNow: Date.now(),
      experiment: { id: 'temperature-round-1', title: 'Predict the final temperature', unit: '°C', command: '!predict', min, max },
      round: { number: 1, status: 'ready', openedAt: null, deadlineAt: null, lockedAt: null, actualValue: null, completedAt: null },
      predictions: [], leaderboard: [], completedRounds: [],
    };
  }

  resetForRound(roundNumber: number): void {
    this.acceptedByUser.clear();
    this.state.experiment.id = `temperature-round-${roundNumber}`;
    this.state.round = { number: roundNumber, status: 'ready', openedAt: null, deadlineAt: null, lockedAt: null, actualValue: null, completedAt: null };
    this.state.predictions = [];
    this.state.leaderboard = [];
  }

  submit(input: { userId: string; username: string; text: string; source: PredictionSource }): { accepted: true; prediction: Prediction } | { accepted: false; reason: string } {
    const userId = input.userId.trim();
    const username = input.username.trim();
    if (!userId || !username) return { accepted: false, reason: 'The sender identity is missing.' };
    const parsed = parsePrediction(input.text, this.state.experiment.min, this.state.experiment.max);
    if (!parsed.ok) return { accepted: false, reason: parsed.reason };
    if (this.acceptedByUser.has(userId)) return { accepted: false, reason: 'You already submitted a prediction this round.' };
    const prediction: Prediction = { experimentId: this.state.experiment.id, userId, username, value: parsed.value, unit: '°C', submittedAt: new Date().toISOString(), source: input.source, acceptanceStatus: 'accepted' };
    this.acceptedByUser.set(userId, prediction);
    this.state.predictions.unshift(prediction);
    return { accepted: true, prediction };
  }
}
