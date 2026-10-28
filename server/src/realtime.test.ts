import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import { createRealtimeServer, type PublicState } from './realtime.js';
import { PredictionStore } from './predictions.js';

describe('frontend state recovery', () => {
  let server: ReturnType<typeof createServer> | undefined;
  let realtime: ReturnType<typeof createRealtimeServer> | undefined;
  let client: WebSocket | undefined;

  afterEach(async () => {
    client?.close();
    realtime?.close();
    if (server?.listening) { server.close(); await once(server, 'close'); }
    server = undefined; realtime = undefined; client = undefined;
  });

  it('sends the current experiment state to a newly connected frontend client', async () => {
    const store = new PredictionStore(-273.15, 1000);
    store.submit({ userId: 'viewer-1', username: 'Ada', text: '!predict 85', source: 'twitch' });
    const state: PublicState = { state: store.state, connection: { status: 'subscribed', mode: 'twitch', message: 'Receiving Twitch chat.', channel: 'crowdlab' } };
    server = createServer();
    realtime = createRealtimeServer(server, () => state);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
    const url = `ws://127.0.0.1:${address.port}/ws`;
    client = new WebSocket(url);
    const firstMessage = once(client, 'message');
    await once(client, 'open');
    await firstMessage;
    const firstClose = once(client, 'close');
    client.close();
    await firstClose;

    client = new WebSocket(url);
    const messagePromise = once(client, 'message');
    await once(client, 'open');
    const [raw] = await messagePromise as [RawData];
    const message = JSON.parse(raw.toString()) as { type: string; data: PublicState };
    expect(message.type).toBe('state');
    expect(message.data.state.predictions).toHaveLength(1);
    expect(message.data.state.predictions[0]?.username).toBe('Ada');
    expect(message.data.connection.status).toBe('subscribed');
    state.state.round.status = 'open';
    state.state.round.deadlineAt = Date.now() + 60_000;
    realtime.broadcast();
    const [updateRaw] = await once(client, 'message') as [RawData];
    const update = JSON.parse(updateRaw.toString()) as { type: string; data: PublicState };
    expect(update.data.state.round.status).toBe('open');
  });
});
