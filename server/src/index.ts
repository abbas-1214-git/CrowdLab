import { createServer } from 'node:http';
import { config } from './config.js';
import { createApp } from './app.js';
import { PredictionStore } from './predictions.js';
import { ExperimentGame } from './game.js';
import { TwitchChat } from './twitch.js';

let broadcast = () => {};
const predictionStore = new PredictionStore(config.minPrediction, config.maxPrediction);
const game = new ExperimentGame(predictionStore, () => broadcast());
const twitch = new TwitchChat(config, game, () => broadcast());
const server = createServer();
const { app, realtime } = createApp({ game, twitch, clientOrigin: config.clientOrigin, localTestMode: config.localTestMode, httpServer: server });
broadcast = () => realtime?.broadcast();
server.on('request', app);
server.listen(config.port, '127.0.0.1', () => {
  console.log(`CrowdLab API listening at http://127.0.0.1:${config.port}`);
  console.log(config.localTestMode ? 'Mode: local-test (Twitch disabled)' : config.configured ? 'Mode: Twitch connection available; authorize from the interface.' : 'Mode: disconnected (configure Twitch settings in .env).');
});

function shutdown() {
  twitch.shutdown();
  game.shutdown();
  realtime?.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
