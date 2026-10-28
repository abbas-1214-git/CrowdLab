import { describe, expect, it } from 'vitest';
import { parsePrediction, PredictionStore } from './predictions.js';

describe('prediction parser', () => {
  const parse = (value: string) => parsePrediction(value, -273.15, 1000);
  it('accepts an integer', () => expect(parse('!predict 85')).toEqual({ ok: true, value: 85 }));
  it('accepts a decimal', () => expect(parse('!predict 21.75')).toEqual({ ok: true, value: 21.75 }));
  it('handles command casing', () => expect(parse('!PrEdIcT 12')).toEqual({ ok: true, value: 12 }));
  it('trims surrounding whitespace', () => expect(parse('  !predict   85  ')).toEqual({ ok: true, value: 85 }));
  it('rejects a missing value', () => expect(parse('!predict')).toMatchObject({ ok: false }));
  it('rejects non-numeric values', () => expect(parse('!predict hot')).toMatchObject({ ok: false }));
  it.each(['!predict NaN', '!predict Infinity', '!predict -Infinity', '!predict 1e999'])('rejects invalid or infinite numbers: %s', (value) => expect(parse(value)).toMatchObject({ ok: false }));
  it('rejects values below or above the configured range', () => {
    expect(parse('!predict -273.16')).toMatchObject({ ok: false });
    expect(parse('!predict 1000.01')).toMatchObject({ ok: false });
  });
});

describe('prediction store', () => {
  it('accepts one prediction per Twitch user ID, allowing other users', () => {
    const store = new PredictionStore(-273.15, 1000);
    expect(store.submit({ userId: 'u-1', username: 'Ada', text: '!predict 85', source: 'twitch' }).accepted).toBe(true);
    expect(store.submit({ userId: 'u-1', username: 'AdaRenamed', text: '!predict 90', source: 'twitch' })).toMatchObject({ accepted: false });
    expect(store.submit({ userId: 'u-2', username: 'Grace', text: '!predict 85.5', source: 'twitch' }).accepted).toBe(true);
    expect(store.state.predictions).toHaveLength(2);
    expect(new Set(store.state.predictions.map((prediction) => prediction.userId)).size).toBe(2);
  });

  it('never inserts invalid messages and labels local test events', () => {
    const store = new PredictionStore(-273.15, 1000);
    expect(store.submit({ userId: 'u-1', username: 'Ada', text: '!predict nope', source: 'twitch' }).accepted).toBe(false);
    expect(store.state.predictions).toHaveLength(0);
    expect(store.submit({ userId: 'local-1', username: 'Tester', text: '!predict 42', source: 'local-test' })).toMatchObject({ accepted: true, prediction: { source: 'local-test', acceptanceStatus: 'accepted', unit: '°C' } });
  });
});
