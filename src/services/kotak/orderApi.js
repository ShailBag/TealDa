'use strict';

const https = require('https');

const DEFAULT_HOST = 'mis.kotaksecurities.com';
const ORDERS_LIST_PATH = '/quick/user/orders';

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

module.exports = { fetchOrders };
