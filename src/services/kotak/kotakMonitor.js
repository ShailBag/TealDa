'use strict';

const WebSocket = require('ws');
const hsmProtocol = require('./hsmProtocol');
const hsmParser = require('./hsmParser');
const { fetchOrders, placeOrder } = require('./orderApi');
const { login } = require('./session');
const H = require('./orderHelpers');

const TR_BUY = new Set(['B', 'BUY']);
const TR_SELL = new Set(['S', 'SELL']);
const OPEN_SELL_STATES = ['open', 'trigger pending', 'modify pending', 'modified', 'validation pending', 'pending'];

function trnsTpNorm(o) {
  return String(o.trnsTp ?? o.transactionType ?? o.tt ?? '').toUpperCase();
}

function sortKey(o) {
  const n = Number(o.nOrdNo ?? o.ordNo ?? 0);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Number(o.ordTime ?? o.ordDt ?? o.reqTime ?? 0);
  return t;
}

function isOpenSell(o) {
  const st = H.normalizeOrdSt(H.pick(o, 'ordSt', 'orderStatus', 'status', 'st'));
  return OPEN_SELL_STATES.some((x) => st.includes(x));
}

class KotakMonitor {
  /**
   * @param {NodeJS.ProcessEnv} env
   * @param {import('socket.io').Server} io
   */
  constructor(env, io) {
    this.env = env;
    this.io = io;
    this.auth = null;
    /** @type {Map<string, object>} */
    this.ordersMap = new Map();
    this.hsiWs = null;
    this.hsmWs = null;
    this.hsmPingInterval = null;
    this.hsiHbTimer = null;
    this.pollTimer = null;
    this.monitoredScriptKey = null;
    this.hsmReady = false;
    this.hsmRecent = [];
    this.lastEmitJson = '';

    this.optionLtp = null;
    this.highLtpSinceEntry = null;
    this.lowLtpSinceEntry = null;
    this.trackedBuyNOrdNo = null;
    this.trackedBuyScriptKey = null;
    this.entryActive = false;

    this.latestBuy = null;
    this.openPositionBuy = null;
    this.latestSell = null;
    this.lastError = null;
    this.hsiConnected = false;
    this.hsmConnected = false;
    this.indexLtpCache = { nifty: null, sensex: null };
    this.running = false;
    this.hasOpenSellForCurrentBuy = false;
    this.hasCorrespondingSellForCurrentBuy = false;
    this.hasOpenPositionForCurrentBuy = false;
    this.onlyLiveLtp = false;
    this.lastCompletedSellForCurrentBuy = null;
    this.lastCompletedBuyForCurrentSell = null;
    /** Most recent completed F&O index buy (by order id/time); for LAST BUY ORDER card */
    this.lastCompletedBuy = null;
    this.lastIndexTicks = [];
    this.slHistory = [];
  }

  pushHsmRecent(msg) {
    this.hsmRecent.push(msg);
    if (this.hsmRecent.length > 10) this.hsmRecent.shift();
  }

  getSnapshot() {
    return this.buildSnapshot();
  }

  /**
   * Card shows open/pending buy when that is the newest buy; otherwise last completed buy
   * (so rejected/cancelled newer orders do not replace filled trade details).
   */
  pickBuyForDisplay() {
    const latest = this.latestBuy;
    if (!latest) return this.lastCompletedBuy;
    const st = H.normalizeOrdSt(H.pick(latest, 'ordSt', 'orderStatus', 'status', 'st'));
    if (st === H.ORD_ST.OPEN || st === H.ORD_ST.VALIDATION_PENDING) return latest;
    return this.lastCompletedBuy || latest;
  }

  emit() {
    const snapshot = this.buildSnapshot();
    const j = JSON.stringify(snapshot);
    if (j !== this.lastEmitJson) {
      this.lastEmitJson = j;
      this.io.emit('dashboard', snapshot);
    }
  }

  buildSnapshot() {
    const anchorBuy = this.latestBuy;
    const displayBuy = this.pickBuyForDisplay();
    const sell = this.latestSell;
    const buyPrice = anchorBuy ? H.getOrderPrice(anchorBuy) : NaN;
    const ltp = this.optionLtp != null ? Number(this.optionLtp) : null;
    const lotSize = anchorBuy ? H.getLotSizeForOrder(anchorBuy, this.env) : Number(this.env.KOTAK_NIFTY_LOT_SIZE || 25);
    const qtyRaw = anchorBuy ? H.getOrderQtyRaw(anchorBuy) : null;
    const qty = qtyRaw != null ? Number(qtyRaw) : 0;
    const units = Number.isFinite(qty) ? qty : 0;
    const pointDiff = ltp != null && Number.isFinite(buyPrice) ? ltp - buyPrice : null;
    const totalPnlRs =
      pointDiff != null && Number.isFinite(units) && units > 0 ? pointDiff * units : null;

    const completedSell = this.lastCompletedSellForCurrentBuy;
    const matchedBuyForCompletedSell = this.lastCompletedBuyForCurrentSell || anchorBuy;
    const realizedBuyPrice = matchedBuyForCompletedSell ? H.getOrderPrice(matchedBuyForCompletedSell) : NaN;
    const completedSellPrice = completedSell ? H.getOrderPrice(completedSell) : NaN;
    const pointsTaken =
      Number.isFinite(realizedBuyPrice) && Number.isFinite(completedSellPrice) ? (completedSellPrice - realizedBuyPrice) : null;
    const lastTradePnlRs =
      pointsTaken != null && Number.isFinite(units) && units > 0 ? pointsTaken * units : null;

    const buySt = displayBuy ? H.normalizeOrdSt(H.pick(displayBuy, 'ordSt', 'orderStatus', 'status', 'st')) : '';
    const sellSt = sell ? H.normalizeOrdSt(H.pick(sell, 'ordSt', 'orderStatus', 'status', 'st')) : '';

    const pt = sell
      ? String(
        sell.pt ??
        sell.prcTp ??
        sell.productType ??
        sell.priceType ??
        ''
      ).toUpperCase()
      : '';
    const isLimit = pt === 'L';
    const isSl = pt === 'SL';

    let buyPayload = null;
    if (displayBuy) {
      const dp = H.getOrderPrice(displayBuy);
      const dq = H.getOrderQtyRaw(displayBuy);
      buyPayload = {
        nOrdNo: String(displayBuy.nOrdNo ?? displayBuy.ordNo ?? ''),
        status: buySt,
        symbol: H.pick(displayBuy, 'trdSym', 'tsym', 'sym', 'symbol'),
        price: Number.isFinite(dp) ? dp : null,
        qty: dq != null ? Number(dq) : null,
        qtyDisplay: dq != null ? String(dq) : '—',
        avgPrc: displayBuy.avgPrc != null ? Number(displayBuy.avgPrc) : null,
        instrumentKey: H.instrumentKey(displayBuy)
      };
    }

    return {
      ts: Date.now(),
      loginOk: !!this.auth,
      lastError: this.lastError,
      connections: { hsi: this.hsiConnected, hsm: this.hsmConnected },
      position: {
        hasOpenPosition: this.hasOpenPositionForCurrentBuy,
        hasCorrespondingSell: this.hasCorrespondingSellForCurrentBuy
      },
      buy: buyPayload,
      sell: sell
        ? {
            nOrdNo: String(sell.nOrdNo ?? sell.ordNo ?? ''),
            status: sellSt,
            orderType: isSl ? 'SL' : isLimit ? 'LIMIT' : pt || '—',
            limitPrice: isLimit ? numOrNull(H.pick(sell, 'pr', 'prc', 'avgPrc', 'price')) : null,
            triggerPrice: isSl ? numOrNull(H.pick(sell, 'tp', 'trgPrc', 'triggerPrice')) : null,
            price: numOrNull(H.pick(sell, 'pr', 'prc', 'avgPrc', 'price')),
            symbol: H.pick(sell, 'trdSym', 'tsym', 'sym', 'symbol')
          }
        : null,
      pnl: {
        liveLtp: ltp,
        buyPrice: Number.isFinite(buyPrice) ? buyPrice : null,
        realizedBuyPrice: Number.isFinite(realizedBuyPrice) ? realizedBuyPrice : null,
        pointDiff,
        pointDiffColor: pointDiff == null ? null : pointDiff >= 0 ? 'green' : 'red',
        totalPnlRs,
        pointsTaken,
        lastTradePnlRs,
        sellPrice: Number.isFinite(completedSellPrice) ? completedSellPrice : null,
        highLtpSinceEntry: this.highLtpSinceEntry,
        lowLtpSinceEntry: this.lowLtpSinceEntry,
        lotSize,
        effectiveUnits: units,
        entryActive: this.entryActive,
        onlyLiveLtp: this.onlyLiveLtp,
        scriptName: anchorBuy
          ? (anchorBuy.trdSym ?? anchorBuy.tsym ?? anchorBuy.sym ?? anchorBuy.symbol ?? anchorBuy.scripName ?? '')
          : '',
        realizedAvailable: !this.hasOpenPositionForCurrentBuy && (pointsTaken != null) && (lastTradePnlRs != null)
      },
      slHistory: this.slHistory,
      indices: this.indexLtpCache || { nifty: null, sensex: null }
    };
  }

  recomputeFromOrderMap() {
    const all = [...this.ordersMap.values()].filter(H.isFoIndexOption);
    const buys = all.filter((o) => TR_BUY.has(trnsTpNorm(o)));
    const sells = all.filter((o) => TR_SELL.has(trnsTpNorm(o)));
    buys.sort((a, b) => sortKey(b) - sortKey(a));
    sells.sort((a, b) => sortKey(b) - sortKey(a));

    const completedBuys = buys.filter(
      (b) => H.normalizeOrdSt(H.pick(b, 'ordSt', 'orderStatus', 'status', 'st')) === H.ORD_ST.COMPLETE
    );
    this.lastCompletedBuy = completedBuys[0] || null;

    this.latestBuy = buys[0] || null;

    const ikey = this.latestBuy ? H.instrumentKey(this.latestBuy) : '';
    if (ikey) {
      const buyK = sortKey(this.latestBuy);
      const sameAll = sells.filter((s) => H.instrumentKey(s) === ikey);
      // Only consider sells that occurred after (or equal to) the latest buy.
      const same = sameAll.filter((s) => sortKey(s) >= buyK);
      const sameOpen = same.find(isOpenSell);

      this.hasCorrespondingSellForCurrentBuy = same.length > 0;
      this.hasOpenSellForCurrentBuy = !!sameOpen;

      // Prefer: open sell for this buy; else latest sell after this buy; else global fallback.
      this.latestSell = sameOpen || same[0] || sells.find(isOpenSell) || sells[0] || null;

      const buySt = H.normalizeOrdSt(H.pick(this.latestBuy, 'ordSt', 'orderStatus', 'status', 'st'));
      const completedSells = same.filter((s) =>
        H.normalizeOrdSt(H.pick(s, 'ordSt', 'orderStatus', 'status', 'st')) === H.ORD_ST.COMPLETE
      );
      completedSells.sort((a, b) => sortKey(b) - sortKey(a));
      this.lastCompletedSellForCurrentBuy = completedSells[0] || null;
      this.lastCompletedBuyForCurrentSell = null;
      if (this.lastCompletedSellForCurrentBuy) {
        const sellK = sortKey(this.lastCompletedSellForCurrentBuy);
        const priorBuys = buys
          .filter((b) => H.instrumentKey(b) === ikey && sortKey(b) <= sellK)
          .sort((a, b) => sortKey(b) - sortKey(a));
        this.lastCompletedBuyForCurrentSell = priorBuys[0] || null;
      }
      const hasCompleteSellForSame = completedSells.length > 0;
      const buyIsActive = buySt === H.ORD_ST.COMPLETE || buySt === H.ORD_ST.OPEN || buySt === H.ORD_ST.VALIDATION_PENDING;
      this.hasOpenPositionForCurrentBuy = buyIsActive && !hasCompleteSellForSame;
      this.openPositionBuy = this.hasOpenPositionForCurrentBuy ? this.latestBuy : null;

      // Keep track of SL trigger prices we observe for the current script.
      // Considered "successfully modified" once we can observe the new trigger price in HSI/REST.
      const slOpen = same.find((s) => {
        const pt = String((s.pt ?? s.prcTp ?? '')).toUpperCase();
        return pt === 'SL' && isOpenSell(s);
      });
      if (slOpen) {
        const tpRaw = H.pick(slOpen, 'tp', 'trgPrc', 'triggerPrice');
        const tp = tpRaw !== '' ? Number(tpRaw) : NaN;
        if (Number.isFinite(tp) && tp > 0) {
          const last = this.slHistory.length ? this.slHistory[this.slHistory.length - 1] : null;
          if (!last || Number(last.triggerPrice) !== tp) {
            this.slHistory.push({
              ts: Date.now(),
              orderNo: String(slOpen.nOrdNo ?? slOpen.ordNo ?? ''),
              status: H.normalizeOrdSt(H.pick(slOpen, 'ordSt', 'orderStatus', 'status', 'st')),
              triggerPrice: tp
            });
            if (this.slHistory.length > 20) this.slHistory.shift();
          }
        }
      }
    } else {
      this.hasCorrespondingSellForCurrentBuy = false;
      this.hasOpenSellForCurrentBuy = !!sells.find(isOpenSell);
      this.latestSell = sells.find(isOpenSell) || sells[0] || null;
      this.hasOpenPositionForCurrentBuy = false;
      this.openPositionBuy = null;
      this.lastCompletedSellForCurrentBuy = null;
      this.lastCompletedBuyForCurrentSell = null;
      this.slHistory = [];
    }

    const sellSt = this.latestSell
      ? H.normalizeOrdSt(H.pick(this.latestSell, 'ordSt', 'orderStatus', 'status', 'st'))
      : '';
    this.onlyLiveLtp = sellSt === H.ORD_ST.COMPLETE && !this.hasOpenSellForCurrentBuy;

    this.syncEntryTracking();
    this.syncMonitoredScript();
  }

  syncEntryTracking() {
    const buy = this.latestBuy;
    if (!buy) {
      this.trackedBuyNOrdNo = null;
      this.trackedBuyScriptKey = null;
      this.entryActive = false;
      this.highLtpSinceEntry = null;
      this.lowLtpSinceEntry = null;
      return;
    }
    const n = String(buy.nOrdNo ?? buy.ordNo ?? '');
    const scriptKey = H.instrumentKey(buy);
    const st = H.normalizeOrdSt(H.pick(buy, 'ordSt', 'orderStatus', 'status', 'st'));
    if (st === H.ORD_ST.COMPLETE) {
      if (this.trackedBuyNOrdNo !== n || this.trackedBuyScriptKey !== scriptKey) {
        this.trackedBuyNOrdNo = n;
        this.trackedBuyScriptKey = scriptKey;
        this.highLtpSinceEntry = null;
        this.lowLtpSinceEntry = null;
        this.optionLtp = null;
        this.slHistory = [];
      }
      this.entryActive = true;
    } else {
      this.entryActive = false;
    }
  }

  syncMonitoredScript() {
    // Keep LTP on the script that was actually traded:
    // open position first, otherwise last completed buy.
    const buy = this.openPositionBuy || this.lastCompletedBuy || this.latestBuy;
    if (!buy) {
      this.monitoredScriptKey = null;
      return;
    }
    const ex = String(buy.exSeg ?? buy.exchSeg ?? buy.es ?? '').trim();
    const tok = String(buy.tok ?? buy.token ?? '').trim();
    if (!ex || !tok) {
      this.monitoredScriptKey = null;
      return;
    }
    const key = ex + '|' + tok;
    if (key !== this.monitoredScriptKey) {
      this.monitoredScriptKey = key;
      this.resubscribeHsmScript();
    }
  }

  applyLtpUpdate(n) {
    if (!Number.isFinite(n)) return;
    this.optionLtp = n;
    if (!this.entryActive) return;
    if (this.highLtpSinceEntry == null || n > this.highLtpSinceEntry) this.highLtpSinceEntry = n;
    if (this.lowLtpSinceEntry == null || n < this.lowLtpSinceEntry) this.lowLtpSinceEntry = n;
  }

  onHsmParsed(parsed) {
    if (!parsed) return;
    let arr = null;
    try {
      arr = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
    } catch (_) {
      return;
    }
    if (!Array.isArray(arr)) return;

    const niftySub = (this.env.KOTAK_NIFTY_TOPIC_SUBSTR || 'Nifty').toLowerCase();
    const sensexSub = (this.env.KOTAK_SENSEX_TOPIC_SUBSTR || 'Sensex').toLowerCase();

    for (const item of arr) {
      if (!item) continue;
      const topic = String(item.topicName || '');
      const ts = String(item.ts || '').toLowerCase();
      const exField = String(item.e || '').toLowerCase();
      const iv = item.iv != null ? parseFloat(String(item.iv)) : NaN;

      if (topic.startsWith('if|') || (item.iv != null && item.ltp == null)) {
        if (Number.isFinite(iv)) {
          // Keep a small rolling window for debugging mapping issues.
          this.lastIndexTicks.push({
            topicName: topic,
            e: item.e ?? null,
            ts: item.ts ?? null,
            iv
          });
          if (this.lastIndexTicks.length > 20) this.lastIndexTicks.shift();

          const tn = topic.toLowerCase();
          if (tn.includes(niftySub) || ts.includes(niftySub)) {
            this.indexLtpCache.nifty = iv;
          } else if (tn.includes(sensexSub) || ts.includes(sensexSub)) {
            this.indexLtpCache.sensex = iv;
          } else if (exField.includes('nse_cm')) {
            this.indexLtpCache.nifty = iv;
          } else if (exField.includes('bse_cm')) {
            this.indexLtpCache.sensex = iv;
          } else if (tn.includes('nse_cm')) {
            // Fallback for feed variants where topic text omits "Nifty".
            this.indexLtpCache.nifty = iv;
          } else if (tn.includes('bse_cm')) {
            // Fallback for feed variants where topic text omits "Sensex".
            this.indexLtpCache.sensex = iv;
          }
        }
        continue;
      }

      if (item.ltp == null || this.monitoredScriptKey == null) continue;
      const parts = this.monitoredScriptKey.split('|');
      const monSeg = parts[0];
      const monTok = parts[1];
      const expectedTopic = 'sf|' + monSeg + '|' + monTok;
      const match =
        item.topicName === expectedTopic ||
        (item.name === 'sf' && String(item.tk) === monTok && String(item.e) === monSeg);
      if (!match) continue;
      const ltpVal = item.ltp != null && item.ltp !== '' ? parseFloat(String(item.ltp)) : NaN;
      if (!Number.isFinite(ltpVal)) continue;
      this.applyLtpUpdate(ltpVal);
    }
  }

  ingestOrderMessage(str) {
    try {
      const parsed = JSON.parse(str);
      const list = H.getOrderList(parsed);
      for (const raw of list) {
        const o = H.unwrapOrder(raw);
        const n = o.nOrdNo ?? o.ordNo;
        if (n) this.ordersMap.set(String(n), o);
      }
    } catch (_) {}
    this.recomputeFromOrderMap();
    this.emit();
  }

  async pollOrdersRest() {
    if (!this.auth) return;
    try {
      const resp = await fetchOrders({
        accessToken: this.auth.accessToken,
        validatedToken: this.auth.validatedToken,
        sid: this.auth.sid
      });
      const list = H.getOrderList(resp);
      for (const raw of list) {
        const o = H.unwrapOrder(raw);
        const n = o.nOrdNo ?? o.ordNo;
        if (n) this.ordersMap.set(String(n), o);
      }
      this.recomputeFromOrderMap();
      this.emit();
    } catch (err) {
      this.lastError = '[poll] ' + err.message;
      this.emit();
    }
  }

  async placeManualSell(limitPrice) {
    if (!this.auth) throw new Error('Not authenticated');
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) throw new Error('Invalid sell price');
    if (!this.hasOpenPositionForCurrentBuy) throw new Error('No open buy position available');
    if (this.hasOpenSellForCurrentBuy) throw new Error('Open sell order already exists for current buy');

    const buy = this.openPositionBuy || this.latestBuy;
    if (!buy) throw new Error('No buy order available');

    const qtyRaw = H.getOrderQtyRaw(buy);
    const qty = qtyRaw != null ? Number(qtyRaw) : NaN;
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('Invalid buy quantity');

    const body = {
      am: 'NO',
      dq: '0',
      es: String(buy.exSeg ?? buy.exchSeg ?? buy.es ?? 'bse_fo'),
      mp: '0',
      pc: String(buy.prod ?? buy.product ?? 'NRML'),
      pf: 'N',
      pr: Number(limitPrice).toFixed(2),
      pt: 'L',
      qt: String(qty),
      rt: 'DAY',
      tp: '0',
      ts: String(buy.trdSym ?? buy.tsym ?? buy.sym ?? ''),
      tt: 'S'
    };

    const resp = await placeOrder({
      accessToken: this.auth.accessToken,
      validatedToken: this.auth.validatedToken,
      sid: this.auth.sid,
      body
    });

    await this.pollOrdersRest();
    return resp;
  }

  connectHsi() {
    const url = this.env.KOTAK_HSI_URL || 'wss://mis.kotaksecurities.com/realtime';
    const hbMs = Number(this.env.KOTAK_HSI_HEARTBEAT_MS || 30000);
    const hsiWs = new WebSocket(url);
    this.hsiWs = hsiWs;

    hsiWs.on('open', () => {
      this.hsiConnected = true;
      this.lastError = null;
      const cnMsg = JSON.stringify({
        type: 'cn',
        Authorization: this.auth.validatedToken,
        Sid: this.auth.sid,
        src: 'WEB'
      }).replace(/"/g, '');
      hsiWs.send(cnMsg);
      if (this.hsiHbTimer) clearInterval(this.hsiHbTimer);
      this.hsiHbTimer = setInterval(() => {
        if (hsiWs.readyState === WebSocket.OPEN) {
          hsiWs.send(JSON.stringify({ type: 'hb' }).replace(/"/g, ''));
        }
      }, hbMs);
      this.emit();
    });

    hsiWs.on('message', (data) => {
      const str = data.toString ? data.toString() : String(data);
      this.ingestOrderMessage(str);
    });

    hsiWs.on('close', () => {
      this.hsiConnected = false;
      if (this.hsiHbTimer) {
        clearInterval(this.hsiHbTimer);
        this.hsiHbTimer = null;
      }
      this.emit();
      if (this.running) setTimeout(() => this.connectHsi(), 5000);
    });

    hsiWs.on('error', () => {
      this.hsiConnected = false;
      this.emit();
    });
  }

  resubscribeHsmScript() {
    const ws = this.hsmWs;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.hsmReady) return;
    const ch = Number(this.env.KOTAK_HSM_CHANNEL || 1);
    if (this.monitoredScriptKey) {
      const p = hsmProtocol.buildScripSubscribePacket(this.monitoredScriptKey, ch);
      if (p) ws.send(p);
    }
  }

  connectHsm() {
    const url = this.env.KOTAK_HSM_URL || 'wss://mlhsm.kotaksecurities.com';
    const ch = Number(this.env.KOTAK_HSM_CHANNEL || 1);
    const socket = new WebSocket(url);
    this.hsmWs = socket;

    socket.on('open', () => {
      this.hsmConnected = true;
      this.hsmReady = false;
      socket.send(hsmProtocol.buildConnectionPacket(this.auth.token, this.auth.sid));
      if (this.hsmPingInterval) clearInterval(this.hsmPingInterval);
      this.hsmPingInterval = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }, 60000);
      this.emit();
    });

    socket.on('message', (data) => {
      try {
        const parsed = hsmParser.parseMessage(data, (msgNum) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(hsmProtocol.buildAckPacket(msgNum));
          }
        });
        if (parsed) this.pushHsmRecent(parsed);
        this.onHsmParsed(parsed);

        const last = this.hsmRecent[this.hsmRecent.length - 1];
        if (last && String(last).includes('"type":"cn"')) {
          const ok = String(last).includes('"stat":"Ok"');
          if (ok && !this.hsmReady) {
            this.hsmReady = true;
            const indicesStr = this.env.KOTAK_INDICES || 'nse_cm|Nifty 50';
            if (indicesStr) {
              const ip = hsmProtocol.buildIndexSubscribePacket(indicesStr, ch);
              if (ip) socket.send(ip);
            }

            // If Sensex isn't coming through (naming differs), try common aliases once.
            setTimeout(() => {
              if (!this.hsmReady || !this.hsmWs || this.hsmWs.readyState !== WebSocket.OPEN) return;
              if (this.indexLtpCache && this.indexLtpCache.sensex != null) return;
              const fallbacksRaw = this.env.KOTAK_SENSEX_FALLBACKS || 'bse_cm|SENSEX&bse_cm|S&P BSE SENSEX&bse_cm|BSE SENSEX';
              const fp = hsmProtocol.buildIndexSubscribePacket(fallbacksRaw, ch);
              if (fp) socket.send(fp);
            }, 5000);

            this.resubscribeHsmScript();
          }
        }
        this.emit();
      } catch (_) {}
    });

    socket.on('close', () => {
      this.hsmConnected = false;
      this.hsmReady = false;
      if (this.hsmPingInterval) {
        clearInterval(this.hsmPingInterval);
        this.hsmPingInterval = null;
      }
      this.emit();
      if (this.running) setTimeout(() => this.connectHsm(), 3000);
    });

    socket.on('error', () => {
      this.hsmConnected = false;
      this.emit();
    });
  }

  async start() {
    this.running = true;
    this.lastError = null;
    try {
      this.auth = await login(this.env);
      this.emit();

      this.pollOrdersRest();
      this.pollTimer = setInterval(() => this.pollOrdersRest(), 30000);

      this.connectHsi();
      this.connectHsm();
    } catch (e) {
      this.running = false;
      this.lastError = e.message;
      throw e;
    }
  }

  stop() {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.hsiHbTimer) clearInterval(this.hsiHbTimer);
    this.hsiHbTimer = null;
    if (this.hsmPingInterval) clearInterval(this.hsmPingInterval);
    this.hsmPingInterval = null;
    try {
      if (this.hsiWs) this.hsiWs.close();
    } catch (_) {}
    try {
      if (this.hsmWs) this.hsmWs.close();
    } catch (_) {}
  }
}

function numOrNull(s) {
  const n = parseFloat(String(s));
  return Number.isFinite(n) ? n : null;
}

module.exports = { KotakMonitor };
