import { describe, expect, it } from 'vitest';
import { isJsonObjectBody, isLocalControlRequest } from './app.js';

describe('local control boundary', () => {
  const origin = 'http://localhost:5173';
  it('allows the configured dashboard over a loopback connection', () => {
    expect(isLocalControlRequest(origin, '127.0.0.1', origin)).toBe(true);
    expect(isLocalControlRequest('http://127.0.0.1:5173', '::ffff:127.0.0.1', origin)).toBe(true);
  });
  it('rejects missing or foreign origins and non-loopback connections', () => {
    expect(isLocalControlRequest(undefined, '127.0.0.1', origin)).toBe(false);
    expect(isLocalControlRequest('https://attacker.example', '127.0.0.1', origin)).toBe(false);
    expect(isLocalControlRequest(origin, '203.0.113.4', origin)).toBe(false);
  });
});

describe('JSON request boundary', () => {
  it('accepts only application/json objects for state-changing requests', () => {
    expect(isJsonObjectBody('application/json', {})).toBe(true);
    expect(isJsonObjectBody('text/plain', {})).toBe(false);
    expect(isJsonObjectBody(undefined, {})).toBe(false);
    expect(isJsonObjectBody('application/json', null)).toBe(false);
    expect(isJsonObjectBody('application/json', [])).toBe(false);
  });
});
