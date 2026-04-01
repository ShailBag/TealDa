'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const speakeasy = require('speakeasy');

const { fetchOrders } = require('./orderApi');
const { hasDbConfig, readAuthFromDb, updateAuthInDb } = require('./authStore');

function decodeJwtExp(token) {
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    return decoded.exp || 0;
  } catch (_) {
    return 0;
  }
}

function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const payload = JSON.stringify(body);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + (urlObj.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON: ' + data.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function testSession(token, sid, env) {
  try {
    const resp = await fetchOrders({ accessToken: token, validatedToken: token, sid });
    const stCode = resp && (resp.stCode ?? resp.statusCode);
    if (stCode === 401 || stCode === 40101 || stCode === 40102) return false;
    if (resp && resp.stat === 'Not_Ok') return false;
    return true;
  } catch (err) {
    const isAuthErr = err.statusCode === 401 || err.statusCode === 403 ||
      (err.message && /auth|token|session|unauthori/i.test(err.message));
    if (isAuthErr) return false;
    return false;
  }
}

function loadSession(sessionPath) {
  try {
    if (!sessionPath || !fs.existsSync(sessionPath)) return null;
    const { token, sid } = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    if (!token || !sid) return null;
    const exp = decodeJwtExp(token);
    const nowSec = Math.floor(Date.now() / 1000);
    if (exp > 0 && nowSec < exp - 60) return { token, sid };
    return null;
  } catch (_) {
    return null;
  }
}

function saveSession(sessionPath, token, sid) {
  if (!sessionPath) return;
  try {
    const dir = path.dirname(sessionPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify({ token, sid }, null, 2), 'utf8');
  } catch (_) {}
}

/**
 * Full login: TOTP + MPIN via Kotak tradeApiLogin / tradeApiValidate.
 * Returns tokens needed for REST + WebSockets.
 */
async function login(env) {
  if (hasDbConfig(env)) {
    try {
      const dbAuth = await readAuthFromDb(env);
      if (dbAuth) {
        const valid = await testSession(dbAuth.token, dbAuth.sid, env);
        if (valid) {
          return {
            token: dbAuth.token,
            sid: dbAuth.sid,
            accessToken: dbAuth.accessToken || dbAuth.token,
            validatedToken: dbAuth.validatedToken || dbAuth.token,
            raw: {
              token: dbAuth.token,
              sid: dbAuth.sid,
              AccessToken: dbAuth.accessToken || dbAuth.token,
              ValidatedToken: dbAuth.validatedToken || dbAuth.token
            },
            source: 'mysql'
          };
        }
      }
    } catch (_) {}
  }

  const sessionPath = env.KOTAK_SESSION_PATH || '';
  const saved = loadSession(sessionPath);
  if (saved) {
    const valid = await testSession(saved.token, saved.sid, env);
    if (valid) {
      return buildAuthFromValidate(
        { token: saved.token, sid: saved.sid },
        { token: saved.token, sid: saved.sid, ValidatedToken: saved.token, AccessToken: saved.token }
      );
    }
  }

  const mobileNumber = env.KOTAK_MOBILE_NUMBER;
  const ucc = env.KOTAK_UCC;
  const mpin = env.KOTAK_MPIN;
  const totpSecret = env.KOTAK_TOTP_SECRET;
  const neoFinKey = env.KOTAK_NEO_FIN_KEY || 'neotradeapi';
  const authorization = env.KOTAK_AUTHORIZATION;

  const missing = [];
  if (!authorization) missing.push('KOTAK_AUTHORIZATION');
  if (!mobileNumber) missing.push('KOTAK_MOBILE_NUMBER');
  if (!ucc) missing.push('KOTAK_UCC');
  if (!mpin) missing.push('KOTAK_MPIN');
  if (!totpSecret) missing.push('KOTAK_TOTP_SECRET');
  if (missing.length) {
    throw new Error(
      'Missing KOTAK_* credentials: ' + missing.join(', ') +
        ' (or configure MySQL DB_* + valid tokens, or a valid KOTAK_SESSION_PATH file)'
    );
  }

  const commonHeaders = { 'neo-fin-key': neoFinKey, Authorization: authorization };
  const totp = speakeasy.totp({ secret: totpSecret, encoding: 'base32' });

  const loginResp = await postJson(
    'https://mis.kotaksecurities.com/login/1.0/tradeApiLogin',
    commonHeaders,
    { mobileNumber, ucc, totp }
  );
  const loginData = loginResp.data;
  if (!loginData || !loginData.token || !loginData.sid) {
    throw new Error('tradeApiLogin failed: ' + JSON.stringify(loginResp));
  }

  const validateResp = await postJson(
    'https://mis.kotaksecurities.com/login/1.0/tradeApiValidate',
    { ...commonHeaders, sid: loginData.sid, Auth: loginData.token },
    { mpin }
  );
  const validateData = validateResp.data;
  if (!validateData || !validateData.token || !validateData.sid) {
    throw new Error('tradeApiValidate failed: ' + JSON.stringify(validateResp));
  }

  saveSession(sessionPath, validateData.token, validateData.sid);
  const auth = buildAuthFromValidate(validateData, validateData);
  if (hasDbConfig(env)) {
    try {
      await updateAuthInDb(env, auth);
    } catch (_) {}
  }
  return auth;
}

function buildAuthFromValidate(validateData, raw) {
  const token = validateData.token;
  const sid = validateData.sid;
  const tokenKey = process.env.KOTAK_HSI_TOKEN_KEY || 'ValidatedToken';
  const validatedToken = raw[tokenKey] ?? raw.ValidatedToken ?? raw.validatedToken ?? token;
  const accessToken = raw.AccessToken ?? raw.accessToken ?? token;
  return {
    token,
    sid,
    accessToken: accessToken || validatedToken,
    validatedToken: validatedToken ? String(validatedToken) : String(token),
    raw
  };
}

module.exports = {
  login,
  testSession,
  loadSession,
  saveSession,
  decodeJwtExp
};
