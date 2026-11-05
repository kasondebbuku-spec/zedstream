import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  siteName: env.SITE_NAME || 'ZedStream',
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  jwtSecret: env.JWT_SECRET || 'dev-only-secret-change-me',
  adminEmail: env.ADMIN_EMAIL,
  adminPassword: env.ADMIN_PASSWORD,
  lipila: {
    // mock    = no network calls, simulated payments (for local development)
    // sandbox = Lipila test environment (api.lipila.dev, keys start with lsk_)
    // live    = real money (blz.lipila.io, keys start with lpk_)
    mode: (env.LIPILA_MODE || (env.LIPILA_API_KEY ? 'sandbox' : 'mock')).toLowerCase(),
    apiKey: env.LIPILA_API_KEY || '',
    webhookSecret: env.LIPILA_WEBHOOK_SECRET || '',
    sandboxUrl: env.LIPILA_SANDBOX_URL || 'https://api.lipila.dev/api/v1',
    liveUrl: env.LIPILA_LIVE_URL || 'https://blz.lipila.io/api/v1',
  },
  currency: 'ZMW',
};

if (config.jwtSecret === 'dev-only-secret-change-me' && env.NODE_ENV === 'production') {
  throw new Error('Set JWT_SECRET in production.');
}
