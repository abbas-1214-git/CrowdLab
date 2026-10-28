import 'dotenv/config';

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number.`);
  return parsed;
}

const minPrediction = numberEnv('PREDICTION_MIN', -273.15);
const maxPrediction = numberEnv('PREDICTION_MAX', 1000);
if (minPrediction >= maxPrediction) throw new Error('PREDICTION_MIN must be less than PREDICTION_MAX.');

export const config = {
  port: numberEnv('SERVER_PORT', 3001),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  clientId: process.env.TWITCH_CLIENT_ID ?? '',
  clientSecret: process.env.TWITCH_CLIENT_SECRET ?? '',
  redirectUri: process.env.TWITCH_REDIRECT_URI ?? 'http://localhost:3001/auth/twitch/callback',
  channelLogin: process.env.TWITCH_CHANNEL_LOGIN?.trim().toLowerCase() ?? '',
  configured: Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET && process.env.TWITCH_CHANNEL_LOGIN),
  minPrediction,
  maxPrediction,
  localTestMode: process.env.LOCAL_TEST_MODE === 'true',
};
