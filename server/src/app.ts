import express from 'express';
import cors from 'cors';
import type { Server } from 'node:http';
import { GameActionError, type ExperimentGame } from './game.js';
import type { TwitchChat } from './twitch.js';
import { createRealtimeServer } from './realtime.js';

export function createApp(options: {
  game: ExperimentGame;
  twitch: TwitchChat;
  clientOrigin: string;
  localTestMode: boolean;
  httpServer?: Server;
}) {
  const app = express();
  app.use(cors({ origin: [options.clientOrigin, 'http://localhost:5173', 'http://127.0.0.1:5173'] }));
  app.use(express.json({ limit: '8kb' }));
  const publicState = () => ({ state: options.game.getState(), connection: options.twitch.getStatus() });
  const realtime = options.httpServer ? createRealtimeServer(options.httpServer, publicState) : undefined;

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/state', (_req, res) => res.json(publicState()));
  const requireLocalControl: express.RequestHandler = (req, res, next) => {
    if (!isLocalControlRequest(req.get('origin'), req.socket.remoteAddress, options.clientOrigin)) return res.status(403).json({ error: 'Round controls are available only from the local CrowdLab dashboard.' });
    next();
  };
  const requireJsonObject = (allowedKeys: string[]): express.RequestHandler => (req, res, next) => {
    if (!isJsonObjectBody(req.is('application/json') ? 'application/json' : undefined, req.body)) return res.status(415).json({ error: 'Send a JSON object using Content-Type: application/json.' });
    if (Object.keys(req.body as object).some((key) => !allowedKeys.includes(key))) return res.status(400).json({ error: 'Request contains an unexpected field.' });
    next();
  };
  app.post('/api/round/start', requireLocalControl, requireJsonObject([]), (_req, res) => {
    try { return res.json({ state: options.game.startRound() }); }
    catch (error) { return gameError(res, error); }
  });
  app.post('/api/round/lock', requireLocalControl, requireJsonObject([]), (_req, res) => {
    try { return res.json({ state: options.game.lockRound() }); }
    catch (error) { return gameError(res, error); }
  });
  app.post('/api/round/result', requireLocalControl, requireJsonObject(['actualValue']), (req, res) => {
    try { return res.json({ state: options.game.recordResult(req.body?.actualValue) }); }
    catch (error) { return gameError(res, error); }
  });
  app.get('/auth/twitch', (_req, res) => {
    try {
      const auth = options.twitch.newAuthorization();
      res.redirect(auth.url);
    } catch (error) { res.status(503).send(error instanceof Error ? error.message : 'Twitch authentication is unavailable.'); }
  });
  app.get('/auth/twitch/callback', async (req, res) => {
    const code = req.query.code;
    const state = req.query.state;
    if (req.query.error) return res.status(400).send('Twitch authorization was declined or failed. Return to CrowdLab and try again.');
    if (typeof code !== 'string' || typeof state !== 'string') return res.status(400).send('Twitch did not return an authorization code. Return to CrowdLab and try again.');
    try {
      await options.twitch.completeAuthorization(code, state);
      res.redirect(options.clientOrigin);
    } catch {
      res.redirect(options.clientOrigin);
    }
  });
  app.post('/api/local-test', requireLocalControl, requireJsonObject(['username', 'userId', 'text']), (req, res) => {
    if (!options.localTestMode) return res.status(404).json({ error: 'Local-test mode is disabled.' });
    const userId = typeof req.body?.userId === 'string' ? req.body.userId.slice(0, 80) : '';
    const username = typeof req.body?.username === 'string' ? req.body.username.slice(0, 50) : '';
    const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 200) : '';
    const result = options.game.submit({ userId, username, text, source: 'local-test' });
    if (!result.accepted) return res.status(422).json({ accepted: false, error: result.reason });
    return res.status(201).json({ accepted: true, prediction: result.prediction });
  });
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(400).json({ error: 'Request could not be processed.' }));
  return { app, realtime, broadcast: () => realtime?.broadcast(), publicState };
}

function gameError(res: express.Response, error: unknown) {
  if (error instanceof GameActionError) return res.status(error.statusCode).json({ error: error.message });
  return res.status(500).json({ error: 'The round action could not be completed.' });
}

export function isLocalControlRequest(origin: string | undefined, remoteAddress: string | undefined, clientOrigin: string): boolean {
  const allowedOrigins = new Set([clientOrigin, 'http://localhost:5173', 'http://127.0.0.1:5173']);
  const isLoopback = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
  return isLoopback && Boolean(origin && allowedOrigins.has(origin));
}

export function isJsonObjectBody(contentType: string | undefined, body: unknown): boolean {
  return contentType === 'application/json' && Boolean(body) && typeof body === 'object' && !Array.isArray(body);
}
