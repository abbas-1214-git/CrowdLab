export type OverlayConnection = {
  status: 'disconnected' | 'connecting' | 'authenticated' | 'subscribed' | 'reconnecting' | 'error';
  mode: 'twitch' | 'local-test' | 'unconfigured';
  message: string;
  channel?: string;
};

export type OverlayPrediction = { userId: string; username: string; value: number; source: 'twitch' | 'local-test' };
export type OverlayEntry = { rank: number; prediction: OverlayPrediction; absoluteError: number; unit: string };
export type OverlaySnapshot = {
  state: {
    serverNow: number;
    experiment: { title: string; command: string; unit: string };
    round: { number: number; status: 'ready' | 'open' | 'locked' | 'completed'; deadlineAt: number | null; actualValue: number | null };
    predictions: OverlayPrediction[];
    leaderboard: OverlayEntry[];
  };
  connection: OverlayConnection;
};

export type OverlayScene =
  | { phase: 'ready'; roundNumber: number; predictionCount: number }
  | { phase: 'open'; roundNumber: number; predictionCount: number; secondsLeft: number }
  | { phase: 'locked'; roundNumber: number; predictionCount: number }
  | { phase: 'completed'; roundNumber: number; predictionCount: number; actualValue: number | null; podium: OverlayEntry[] };

export function getPodium(leaderboard: OverlayEntry[]): OverlayEntry[] {
  const podium = leaderboard.slice(0, 3);
  const cutoffRank = podium[podium.length - 1]?.rank;
  if (cutoffRank === undefined) return podium;
  let index = podium.length;
  while (leaderboard[index]?.rank === cutoffRank) podium.push(leaderboard[index++]!);
  return podium;
}

export function getOverlayScene(snapshot: OverlaySnapshot, estimatedServerNow = snapshot.state.serverNow): OverlayScene {
  const { round, predictions, leaderboard } = snapshot.state;
  const base = { roundNumber: round.number, predictionCount: predictions.length };
  if (round.status === 'open') {
    const secondsLeft = round.deadlineAt === null ? 0 : Math.max(0, Math.ceil((round.deadlineAt - estimatedServerNow) / 1000));
    return { ...base, phase: 'open', secondsLeft };
  }
  if (round.status === 'locked') return { ...base, phase: 'locked' };
  if (round.status === 'completed') return { ...base, phase: 'completed', actualValue: round.actualValue, podium: getPodium(leaderboard) };
  return { ...base, phase: 'ready' };
}
