'use strict';

const ORD_ST = {
  OPEN: 'open',
  COMPLETE: 'complete',
  CANCELLED: 'cancelled',
  VALIDATION_PENDING: 'validation pending'
};

function normalizeOrdSt(ordSt) {
  if (ordSt == null) return '';
  const s = String(ordSt).toLowerCase().trim();
  if (s === 'complete' || s === 'completed' || s === 'filled' || s === 'executed') return ORD_ST.COMPLETE;
  if (s === 'open' || s === 'pending' || s === 'trigger pending') return ORD_ST.OPEN;
  if (s === 'cancel' || s === 'cancelled' || s === 'rejected') return ORD_ST.CANCELLED;
  if (s.indexOf('validation') >= 0) return ORD_ST.VALIDATION_PENDING;
  return s;
}

function pick(obj, ...keys) {
  if (obj == null) return '';
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return typeof v === 'string' ? v : String(v);
  }
  return '';
}

function getOrderList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const arr = parsed.data ?? parsed.orders ?? parsed.order ?? parsed.result ?? parsed.body ?? parsed.message;
    if (Array.isArray(arr)) return arr;
    if (arr && typeof arr === 'object') return [arr];
    return [parsed];
  }
  return [];
}

function unwrapOrder(raw) {
  return raw && (raw.order ?? raw.data ?? raw);
}

function instrumentKey(o) {
  const ex = String(o.exSeg ?? o.exchSeg ?? o.exchangeSegment ?? o.es ?? '').trim();
  const tok = String(o.tok ?? o.token ?? o.instToken ?? o.instrumentToken ?? '').trim();
  if (!ex || !tok) return '';
  return ex + '|' + tok;
}

function isFoIndexOption(o) {
  const es = String(o.exSeg ?? o.exchSeg ?? o.es ?? '').toLowerCase();
  if (!es.includes('fo')) return false;
  const sym = String(o.trdSym ?? o.tsym ?? '').toUpperCase();
  return /(SENSEX|NIFTY)/.test(sym) && /(CE|PE)$/.test(sym);
}

function getOrderPrice(o) {
  const ordSt = normalizeOrdSt(o.ordSt ?? o.orderStatus ?? o.status ?? o.st);

  const openCandidates = [
    o.prc,
    o.pr,
    o.price,
    o.orderPrice,
    o.lmtPrc,
    o.limitPrice,
    o.trgPrc,
    o.triggerPrice,
    o.tp,
    o.avgPrc,
    o.fillPrc,
    o.avgPrice,
    o.executedPrice,
    o.flPr
  ];
  const completeCandidates = [
    o.avgPrc,
    o.fillPrc,
    o.avgPrice,
    o.executedPrice,
    o.flPr,
    o.prc,
    o.pr,
    o.price,
    o.orderPrice
  ];

  const candidates = ordSt === ORD_ST.COMPLETE ? completeCandidates : openCandidates;
  let sawZero = false;
  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    if (typeof c === 'string' && c.trim() === '') continue;
    const n = parseFloat(String(c));
    if (!Number.isFinite(n)) continue;
    if (n > 0) return n;
    if (n === 0) sawZero = true;
  }
  return sawZero ? 0 : NaN;
}

function getOrderQtyRaw(o) {
  return o.ordQty ?? o.orderQty ?? o.qt ?? o.qty ?? o.quantity ?? o.fillQty ?? o.filledQty;
}

function getLotSizeForOrder(o, env) {
  const es = String(o.exSeg ?? o.exchSeg ?? o.es ?? '').toLowerCase();
  const sym = String(o.trdSym ?? o.tsym ?? '').toUpperCase();
  const sensex = Number(env.KOTAK_SENSEX_LOT_SIZE || 20);
  const nifty = Number(env.KOTAK_NIFTY_LOT_SIZE || 25);
  if (es.includes('bse') && es.includes('fo')) return sensex;
  if (es.includes('nse') && es.includes('fo')) return nifty;
  if (sym.includes('SENSEX')) return sensex;
  if (sym.includes('NIFTY')) return nifty;
  return nifty;
}

function effectiveUnits(o, env) {
  const raw = getOrderQtyRaw(o);
  const q = raw != null ? Number(raw) : NaN;
  if (!Number.isFinite(q)) return 0;
  const lot = getLotSizeForOrder(o, env);
  const qtyIsLots = String(env.KOTAK_QTY_IS_LOTS || 'true').toLowerCase() === 'true';
  return qtyIsLots ? q * lot : q;
}

module.exports = {
  ORD_ST,
  normalizeOrdSt,
  pick,
  getOrderList,
  unwrapOrder,
  instrumentKey,
  isFoIndexOption,
  getOrderPrice,
  getOrderQtyRaw,
  getLotSizeForOrder,
  effectiveUnits
};
