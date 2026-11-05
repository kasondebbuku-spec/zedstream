// Lipila mobile money client (Zambia: MTN, Airtel, Zamtel).
// Docs: https://docs.lipila.dev/docs/collections/momocollections.html
import crypto from 'node:crypto';
import { config } from './config.js';

const { lipila } = config;
const baseUrl = () => (lipila.mode === 'live' ? lipila.liveUrl : lipila.sandboxUrl);

/** Turns 0977123456 / +260977123456 / 977123456 into 260977123456. Returns null if invalid. */
export function normalizePhone(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.startsWith('260')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  if (!/^[79][5-7]\d{7}$/.test(d)) return null;
  return '260' + d;
}

/** Zambian prefixes: 096/076 MTN, 097/077 Airtel, 095/075 Zamtel. */
export function detectOperator(msisdn) {
  const p = msisdn.slice(3, 5);
  if (p === '96' || p === '76') return 'MTN';
  if (p === '97' || p === '77') return 'Airtel';
  if (p === '95' || p === '75') return 'Zamtel';
  return 'Unknown';
}

/** Maps Lipila's status strings to pending | successful | failed. */
export function normalizeStatus(s) {
  const v = String(s || '').toLowerCase();
  if (/success|complete|paid|approved/.test(v)) return 'successful';
  if (/fail|reject|cancel|declin|expire|error|insufficient|timeout/.test(v)) return 'failed';
  return 'pending';
}

async function call(method, path, { body, headers = {} } = {}) {
  const res = await fetch(baseUrl() + path, {
    method,
    headers: {
      'x-api-key': lipila.apiKey,
      accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data.message || data.title || data.error || `Lipila HTTP ${res.status}`;
    const err = new Error(Array.isArray(msg) ? msg.join(', ') : msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---- Mock mode (no API key): simulates the phone PIN prompt. ----
// Uses the same test numbers as the Lipila sandbox:
//   0977000002 -> fails, 0977000003 -> stays pending, anything else succeeds after ~6s.
const mockStore = new Map();
function mockCollect({ referenceId, accountNumber }) {
  mockStore.set(referenceId, { created: Date.now(), accountNumber });
  return { referenceId, status: 'Pending', message: 'Mock: approve on your phone', identifier: 'MOCK-' + referenceId.slice(-8) };
}
function mockStatus(referenceId) {
  const t = mockStore.get(referenceId);
  if (!t) return { referenceId, status: 'Failed', message: 'Unknown reference (server restarted?)' };
  const elapsed = Date.now() - t.created;
  if (t.accountNumber.endsWith('000003') || elapsed < 6000) return { referenceId, status: 'Pending', message: 'Waiting for customer PIN' };
  if (t.accountNumber.endsWith('000002')) return { referenceId, status: 'Failed', message: 'Insufficient funds (mock)' };
  return { referenceId, status: 'Successful', message: 'Payment received (mock)' };
}

/** Starts a mobile money collection. The customer gets a PIN prompt on their phone. */
export async function createCollection({ referenceId, amount, phone, narration, email }) {
  const body = { referenceId, amount, narration, accountNumber: phone, currency: config.currency };
  if (email) body.email = email;
  if (lipila.mode === 'mock') return mockCollect(body);
  return call('POST', '/collections/mobile-money', {
    body,
    // Lipila reads the callback URL from a header.
    headers: { callbackUrl: `${config.publicUrl}/api/webhooks/lipila` },
  });
}

/** Asks Lipila for the current state of a collection. */
export async function checkCollection(referenceId) {
  if (lipila.mode === 'mock') return mockStatus(referenceId);
  return call('GET', `/collections/check-status?referenceId=${encodeURIComponent(referenceId)}`);
}

/**
 * Verifies a webhook signature (Standard Webhooks style):
 * HMAC-SHA256 over "{webhook-id}.{webhook-timestamp}.{raw body}", header "v1,<base64>".
 * Returns true when no secret is configured, because we never trust the payload anyway:
 * the server re-checks the status with Lipila before unlocking a movie.
 */
export function verifyWebhook(headers, rawBody) {
  if (!lipila.webhookSecret) return true;
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const sigHeader = headers['webhook-signature'] || '';
  if (!id || !ts || !sigHeader) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  let secret = lipila.webhookSecret;
  const key = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret);
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest();
  return sigHeader.split(' ').some((part) => {
    const [, sig] = part.split(',');
    if (!sig) return false;
    const got = Buffer.from(sig, 'base64');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

export const lipilaMode = () => lipila.mode;
