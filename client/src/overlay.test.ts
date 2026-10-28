import { describe, expect, it } from 'vitest';
import { getOverlayScene, getPodium, type OverlaySnapshot } from './overlayModel';

const makeSnapshot = (status: OverlaySnapshot['state']['round']['status']): OverlaySnapshot => ({
  state: {
    serverNow: 1_000,
    experiment: { title: 'Predict the final temperature', command: '!predict', unit: '°C' },
    round: { number: 3, status, deadlineAt: status === 'open' ? 61_000 : null, actualValue: status === 'completed' ? 82 : null },
    predictions: [{ userId: 'a', username: 'Ada', value: 85, source: 'twitch' }],
    leaderboard: [{ rank: 2, prediction: { userId: 'a', username: 'Ada', value: 85, source: 'twitch' }, absoluteError: 3, unit: '°C' }],
  },
  connection: { status: 'subscribed', mode: 'twitch', message: 'Receiving chat.' },
});

describe('stream overlay model', () => {
  it('uses the server deadline to show countdown and never rounds below zero', () => {
    const snapshot = makeSnapshot('open');
    expect(getOverlayScene(snapshot, 1_000)).toMatchObject({ phase: 'open', secondsLeft: 60 });
    expect(getOverlayScene(snapshot, 61_000)).toMatchObject({ phase: 'open', secondsLeft: 0 });
  });

  it('shows the backend leaderboard only after completion and preserves its scores', () => {
    const snapshot = makeSnapshot('completed');
    const scene = getOverlayScene(snapshot);
    expect(scene).toMatchObject({ phase: 'completed', actualValue: 82, podium: [{ rank: 2, absoluteError: 3 }] });
  });

  it('keeps all viewers tied at the third-place cutoff in the reveal', () => {
    const snapshot = makeSnapshot('completed');
    const tied = Array.from({ length: 5 }, (_, index) => ({
      rank: index < 2 ? 1 : index + 1,
      prediction: { userId: `u${index}`, username: `Viewer${index}`, value: 82 + index, source: 'twitch' as const },
      absoluteError: index < 2 ? 0 : index,
      unit: '°C',
    }));
    snapshot.state.leaderboard = tied;
    expect(getOverlayScene(snapshot)).toMatchObject({ phase: 'completed', podium: tied.slice(0, 3) });
    const fourthPlaceTie = [...tied.slice(0, 2), { ...tied[2]!, rank: 3 }, { ...tied[3]!, rank: 3 }, { ...tied[4]!, rank: 5 }];
    expect(getPodium(fourthPlaceTie)).toHaveLength(4);
  });

  it('does not expose a winner while locked', () => {
    expect(getOverlayScene(makeSnapshot('locked'))).toMatchObject({ phase: 'locked', predictionCount: 1 });
  });

  it('shows the measured result when a completed round has no predictions', () => {
    const snapshot = makeSnapshot('completed');
    snapshot.state.predictions = [];
    snapshot.state.leaderboard = [];
    expect(getOverlayScene(snapshot)).toMatchObject({ phase: 'completed', actualValue: 82, predictionCount: 0, podium: [] });
  });
});
