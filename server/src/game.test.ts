import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExperimentGame, GameActionError } from './game.js';
import { PredictionStore } from './predictions.js';

describe('server-authoritative experiment round', () => {
  let game: ExperimentGame;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T12:00:00.000Z'));
    game = new ExperimentGame(new PredictionStore(-273.15, 1000), () => {}, 60_000, Date.now);
  });
  afterEach(() => { game.shutdown(); vi.useRealTimers(); });

  it('starts a new round in the open state with a server deadline', () => {
    expect(game.getState().round.status).toBe('ready');
    const state = game.startRound();
    expect(state.round).toMatchObject({ number: 1, status: 'open', openedAt: Date.now(), deadlineAt: Date.now() + 60_000 });
    expect(state.serverNow).toBe(Date.now());
    expect(() => game.startRound()).toThrow(GameActionError);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('clears the countdown when the server shuts down', () => {
    game.startRound();
    expect(vi.getTimerCount()).toBe(1);
    game.shutdown();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(game.getState().round.status).toBe('open');
  });

  it('accepts valid predictions only during an open round', () => {
    expect(game.submit({ userId: 'before', username: 'Before', text: '!predict 85', source: 'twitch' }).accepted).toBe(false);
    game.startRound();
    expect(game.submit({ userId: 'one', username: 'One', text: '!predict 85.5', source: 'twitch' }).accepted).toBe(true);
    expect(game.submit({ userId: 'bad', username: 'Bad', text: '!predict hot', source: 'twitch' })).toMatchObject({ accepted: false });
    expect(game.submit({ userId: 'one', username: 'OneAgain', text: '!predict 90', source: 'twitch' })).toMatchObject({ accepted: false, reason: 'You already submitted a prediction this round.' });
    expect(game.submit({ userId: 'two', username: 'Two', text: '!predict 90', source: 'twitch' }).accepted).toBe(true);
    expect(game.getState().predictions).toHaveLength(2);
  });

  it('manual locking closes prediction intake and clears the timer', () => {
    game.startRound();
    game.submit({ userId: 'one', username: 'One', text: '!predict 85', source: 'twitch' });
    expect(game.lockRound().round.status).toBe('locked');
    expect(game.submit({ userId: 'late', username: 'Late', text: '!predict 86', source: 'twitch' })).toMatchObject({ accepted: false });
    vi.advanceTimersByTime(60_000);
    expect(game.getState().round.status).toBe('locked');
    expect(game.getState().predictions).toHaveLength(1);
  });

  it('automatically locks when the countdown expires', () => {
    game.startRound();
    vi.advanceTimersByTime(59_999);
    expect(game.getState().round.status).toBe('open');
    vi.advanceTimersByTime(1);
    expect(game.getState().round.status).toBe('locked');
  });

  it('rejects a delayed chat message at the authoritative deadline even before the timer callback runs', () => {
    game.startRound();
    vi.setSystemTime(Date.now() + 60_000);
    expect(game.submit({ userId: 'late', username: 'Late', text: '!predict 86', source: 'twitch' })).toMatchObject({ accepted: false });
    expect(game.getState().round.status).toBe('locked');
    expect(game.getState().predictions).toHaveLength(0);
  });

  it('reports the round as locked at the deadline even when the timer callback is delayed', () => {
    game.startRound();
    vi.setSystemTime(Date.now() + 60_000);
    expect(game.getState().round.status).toBe('locked');
  });

  it('requires locking and a valid in-range measurement before finalizing', () => {
    game.startRound();
    expect(() => game.recordResult('82')).toThrow(GameActionError);
    game.lockRound();
    for (const value of ['', 'hot', 'Infinity', '1001', '-274']) expect(() => game.recordResult(value)).toThrow(GameActionError);
    expect(game.getState().round.status).toBe('locked');
    expect(() => game.recordResult('82')).not.toThrow();
  });

  it('calculates absolute errors, ranks closest first, and gives equal ranks to ties', () => {
    game.startRound();
    game.submit({ userId: 'a', username: 'Ada', text: '!predict 85', source: 'twitch' });
    game.submit({ userId: 'b', username: 'Bea', text: '!predict 78', source: 'twitch' });
    game.submit({ userId: 'c', username: 'Cy', text: '!predict 91', source: 'twitch' });
    game.submit({ userId: 'd', username: 'Dee', text: '!predict 82', source: 'twitch' });
    game.submit({ userId: 'e', username: 'Eve', text: '!predict 79', source: 'twitch' });
    game.lockRound();
    game.recordResult('82');
    expect(game.getState().leaderboard.map(({ rank, prediction, absoluteError }) => ({ rank, name: prediction.username, absoluteError }))).toEqual([
      { rank: 1, name: 'Dee', absoluteError: 0 },
      { rank: 2, name: 'Ada', absoluteError: 3 },
      { rank: 2, name: 'Eve', absoluteError: 3 },
      { rank: 4, name: 'Bea', absoluteError: 4 },
      { rank: 5, name: 'Cy', absoluteError: 9 },
    ]);
  });

  it('ranks decimal predictions with mathematically equal errors as a tie', () => {
    game.startRound();
    game.submit({ userId: 'low', username: 'Low', text: '!predict 0.1', source: 'twitch' });
    game.submit({ userId: 'high', username: 'High', text: '!predict 0.3', source: 'twitch' });
    game.lockRound();
    const completed = game.recordResult('0.2');
    expect(completed.leaderboard.map(({ rank }) => rank)).toEqual([1, 1]);
  });

  it('does not expose rankings before the actual result and prevents rescoring', () => {
    game.startRound();
    game.submit({ userId: 'a', username: 'Ada', text: '!predict 85', source: 'twitch' });
    expect(game.getState().leaderboard).toHaveLength(0);
    game.lockRound();
    game.recordResult(82);
    expect(game.getState().round.status).toBe('completed');
    expect(() => game.recordResult(90)).toThrow(GameActionError);
    expect(game.getState().completedRounds).toHaveLength(1);
  });

  it('starts the next round with fresh predictions while preserving completed results', () => {
    game.startRound();
    game.submit({ userId: 'a', username: 'Ada', text: '!predict 85', source: 'twitch' });
    game.lockRound();
    game.recordResult(82);
    const next = game.startRound();
    expect(next.round).toMatchObject({ number: 2, status: 'open' });
    expect(next.experiment.id).toBe('temperature-round-2');
    expect(next.predictions).toHaveLength(0);
    expect(next.leaderboard).toHaveLength(0);
    expect(next.completedRounds).toHaveLength(1);
    expect(next.completedRounds[0]?.actualValue).toBe(82);
    expect(game.submit({ userId: 'a', username: 'Ada', text: '!predict 86', source: 'twitch' }).accepted).toBe(true);
  });
});
