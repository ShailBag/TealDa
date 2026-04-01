'use strict';

const https = require('https');

const DEFAULT_HOST = 'mis.kotaksecurities.com';
const ORDERS_LIST_PATH = '/quick/user/orders';
const PLACE_ORDER_PATH = '/quick/order/rule/ms/place';

function placeOrder(opts) {
  const { accessToken, validatedToken, sid, body } = opts;
  const host = DEFAULT_HOST;
  const path = PLACE_ORDER_PATH;

  const rawBody = typeof body === 'object' ? body : JSON.parse(body || '{}');
  const filtered = Object.fromEntries(Object.entries(rawBody).filter(([, v]) => v !== null && v !== undefined && v !== ''));
  const postData = 'jData=' + JSON.stringify(filtered);
  const maskedHeaders = {
    authorization: accessToken ? 'Bearer ***' : '',
    auth: validatedToken ? '***' : '',
    sid: sid ? '***' : '',
    'neo-fin-key': process.env.KOTAK_NEO_FIN_KEY || 'neotradeapi',
    accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  console.log('[kotak-place-order] outgoing request', {
    url: `https://${host}${path}`,
    headers: maskedHeaders,
    body: filtered
  });

  const neoFinKey = process.env.KOTAK_NEO_FIN_KEY || 'neotradeapi';
  const headers = {
    authorization: 'Bearer ' + accessToken,
    auth: validatedToken,
    sid: sid,
    'neo-fin-key': neoFinKey,
    accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(postData)
  };

  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        console.log('[kotak-place-order] response received', { statusCode: res.statusCode, body: data });
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            const err = new Error((json.errMsg || json.message || json.error || data || ('HTTP ' + res.statusCode)));
            err.statusCode = res.statusCode;
            reject(err);
          }
        } catch (e) {
          reject(new Error(data || e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function fetchOrders(opts) {
  const { accessToken, validatedToken, sid } = opts;
  const host = DEFAULT_HOST;
  const path = ORDERS_LIST_PATH;

  const neoFinKey = process.env.KOTAK_NEO_FIN_KEY || 'neotradeapi';
  const headers = {
    authorization: 'Bearer ' + accessToken,
    auth: validatedToken,
    sid: sid,
    'neo-fin-key': neoFinKey,
    accept: 'application/json'
  };

  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            const err = new Error((json.errMsg || json.message || json.error || data || ('HTTP ' + res.statusCode)));
            err.statusCode = res.statusCode;
            reject(err);
          }
        } catch (e) {
          reject(new Error(data || e.message));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { fetchOrders, placeOrder };
