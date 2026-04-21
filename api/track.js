/**
 * Meta Conversions API — Serverless Endpoint
 * ==========================================
 * Deploy: Vercel (funciona automaticamente em /api/track)
 *         Netlify: mover para netlify/functions/track.js e ajustar path no frontend
 *
 * Fluxo:
 *   Frontend chama POST /api/track com { eventName, eventId, userData, customData, ... }
 *   Aqui: faz SHA-256 nos PII, enriquece com IP + UA, envia ao Graph API do Meta
 *   Retorna 200 rápido — fire-and-forget do frontend
 *
 * Env vars necessárias:
 *   META_PIXEL_ID        — seu pixel id (público ok)
 *   META_ACCESS_TOKEN    — token CAPI (SEGREDO! nunca no frontend)
 *   META_TEST_EVENT_CODE — opcional, só para Test Events no Events Manager
 *   META_API_VERSION     — opcional, default v21.0
 */

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────
// Hashing helpers
// ─────────────────────────────────────────────────────────
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// Normaliza: lowercase, trim, remove acentos
function normalize(value) {
  if (!value) return '';
  return String(value)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function hashIfPresent(value, normalizer = normalize) {
  const v = normalizer(value);
  return v ? sha256(v) : undefined;
}

// Telefone: só dígitos (já vem com DDI do frontend)
function normalizePhone(value) {
  if (!value) return '';
  return String(value).replace(/\D/g, '');
}

// ─────────────────────────────────────────────────────────
// IP extraction
// ─────────────────────────────────────────────────────────
function getClientIp(req) {
  const h = req.headers || {};
  const chain =
    h['cf-connecting-ip'] ||
    h['x-forwarded-for'] ||
    h['x-real-ip'] ||
    (req.socket && req.socket.remoteAddress) ||
    '';
  // x-forwarded-for pode vir como "ip1, ip2, ip3" — pega o primeiro
  return String(chain).split(',')[0].trim();
}

// ─────────────────────────────────────────────────────────
// Retry com backoff exponencial (1s, 2s, 4s — máx 3 tentativas)
// ─────────────────────────────────────────────────────────
async function fetchWithRetry(url, opts, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok) return await res.json().catch(() => ({}));
      // 4xx não faz retry — é erro de payload
      if (res.status >= 400 && res.status < 500) {
        const body = await res.text().catch(() => '');
        throw new Error(`Meta API ${res.status}: ${body}`);
      }
      lastErr = new Error(`Meta API ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────
// Handler principal (Vercel/Next.js style)
// ─────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS — ajuste o origin em produção se necessário
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const PIXEL_ID = process.env.META_PIXEL_ID;
  const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
  const TEST_EVENT_CODE = process.env.META_TEST_EVENT_CODE || '';
  const API_VERSION = process.env.META_API_VERSION || 'v21.0';

  if (!PIXEL_ID || !ACCESS_TOKEN) {
    console.error('[CAPI] Missing META_PIXEL_ID or META_ACCESS_TOKEN env vars');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const {
    eventName,
    eventId,
    eventTime,
    eventSourceUrl,
    userData = {},
    customData = {},
  } = body || {};

  if (!eventName || !eventId) {
    return res.status(400).json({ error: 'eventName and eventId required' });
  }

  // ─────────────────────────────────────────────────────
  // Monta user_data com hashes (PII sempre SHA-256)
  // ─────────────────────────────────────────────────────
  const ua = req.headers['user-agent'] || '';
  const ip = getClientIp(req);

  const hashedUserData = {
    em: hashIfPresent(userData.em),
    ph: hashIfPresent(userData.ph, normalizePhone),
    fn: hashIfPresent(userData.fn),
    ln: hashIfPresent(userData.ln),
    ct: hashIfPresent(userData.ct),
    st: hashIfPresent(userData.st),
    zp: hashIfPresent(userData.zp),
    country: hashIfPresent(userData.country),
    external_id: hashIfPresent(userData.external_id),
    // estes NÃO são hasheados (cookies/id técnicos)
    fbp: userData.fbp || undefined,
    fbc: userData.fbc || undefined,
    client_ip_address: ip || undefined,
    client_user_agent: ua || undefined,
  };

  // Remove undefined
  Object.keys(hashedUserData).forEach(k => {
    if (hashedUserData[k] === undefined || hashedUserData[k] === '') delete hashedUserData[k];
  });

  // ─────────────────────────────────────────────────────
  // Payload final
  // ─────────────────────────────────────────────────────
  const event = {
    event_name: eventName,
    event_time: eventTime || Math.floor(Date.now() / 1000),
    event_id: eventId,                   // MESMO id do Pixel → deduplica
    event_source_url: eventSourceUrl || '',
    action_source: 'website',
    user_data: hashedUserData,
    custom_data: customData,
  };

  const payload = { data: [event] };
  if (TEST_EVENT_CODE) payload.test_event_code = TEST_EVENT_CODE;

  const url = `https://graph.facebook.com/${API_VERSION}/${PIXEL_ID}/events?access_token=${encodeURIComponent(ACCESS_TOKEN)}`;

  try {
    const result = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.status(200).json({ ok: true, meta: result });
  } catch (err) {
    console.error('[CAPI] send failed:', err.message);
    // Nunca falhe o frontend: retorna 200 para não travar UX
    return res.status(200).json({ ok: false, error: err.message });
  }
};
