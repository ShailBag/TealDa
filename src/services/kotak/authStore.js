'use strict';

const mysql = require('mysql2/promise');

let pool = null;

function hasDbConfig(env) {
  return !!(env.DB_HOST && env.DB_USER && env.DB_PASSWORD && env.DB_NAME);
}

function getDbConfig(env) {
  return {
    host: env.DB_HOST,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    table: env.DB_AUTH_TABLE || 'TradeApiAuthKotak',
    rowId: Number(env.DB_AUTH_ROW_ID || 1)
  };
}

function getPool(cfg) {
  if (pool) return pool;
  pool = mysql.createPool({
    host: cfg.host,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0
  });
  return pool;
}

async function readAuthFromDb(env) {
  if (!hasDbConfig(env)) return null;
  const cfg = getDbConfig(env);
  const p = getPool(cfg);
  const sql = `SELECT AccessToken, SessionId, ValidatedToken FROM ${cfg.table} WHERE ID = ? LIMIT 1`;
  const [rows] = await p.execute(sql, [cfg.rowId]);
  const row = rows && rows[0];
  if (!row) return null;
  const token = row.ValidatedToken || row.AccessToken || '';
  const sid = row.SessionId || '';
  if (!token || !sid) return null;
  return {
    token: String(token),
    sid: String(sid),
    accessToken: String(row.AccessToken || token),
    validatedToken: String(row.ValidatedToken || token)
  };
}

async function updateAuthInDb(env, auth) {
  if (!hasDbConfig(env)) return false;
  const cfg = getDbConfig(env);
  const p = getPool(cfg);
  const sql = `UPDATE ${cfg.table} SET AccessToken = ?, SessionId = ?, ValidatedToken = ? WHERE ID = ?`;
  const params = [
    String(auth.accessToken || auth.token || ''),
    String(auth.sid || ''),
    String(auth.validatedToken || auth.token || ''),
    cfg.rowId
  ];
  await p.execute(sql, params);
  return true;
}

module.exports = {
  hasDbConfig,
  readAuthFromDb,
  updateAuthInDb
};
