import { io } from 'socket.io-client';
import './input.css';

const socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });

const fmt = (n) => {
  if (n == null || Number.isNaN(Number(n))) return '?';
  const x = Number(n);
  return x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtInt = (n) => {
  if (n == null || Number.isNaN(Number(n))) return '?';
  return Number(n).toLocaleString('en-IN');
};

let prevBuyOrderNo = '';
let prevBuyStatus = '';
let buyFlashUntilMs = 0;
let prevSellOrderNo = '';
let prevSellStatus = '';
let sellFlashUntilMs = 0;
let audioCtx = null;

function beep(times = 2) {
  try {
    if (!window.AudioContext && !window.webkitAudioContext) return;
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
    }
    const now = audioCtx.currentTime;
    for (let i = 0; i < times; i++) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 920;
      gain.gain.value = 0.001;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      const t0 = now + i * 0.22;
      gain.gain.exponentialRampToValueAtTime(0.15, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16);
      osc.start(t0);
      osc.stop(t0 + 0.18);
    }
  } catch (_) {}
}

function notifyBuyComplete(buy) {
  const orderNo = String((buy && buy.nOrdNo) || '');
  const symbol = String((buy && buy.symbol) || 'Unknown');
  const price = buy && buy.price != null ? fmt(buy.price) : '?';
  const qty = buy && buy.qty != null ? fmtInt(buy.qty) : '?';
  const title = 'Buy Order Completed';
  const body = `${symbol} | Qty ${qty} | Price ${price} | #${orderNo}`;

  beep(2);

  try {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      new Notification(title, { body });
      return;
    }
    if (Notification.permission === 'default') {
      Notification.requestPermission().then((p) => {
        if (p === 'granted') new Notification(title, { body });
      }).catch(() => {});
    }
  } catch (_) {}
}

function isCompleteStatus(s) {
  const x = String(s || '').toLowerCase();
  return x === 'complete' || x.includes('complete') || x.includes('filled') || x.includes('executed');
}

function pillClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'complete' || s.includes('complete')) return 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300';
  if (s === 'open' || s.includes('open') || s.includes('pending')) return 'bg-amber-100 text-amber-700 ring-1 ring-amber-300';
  return 'bg-slate-100 text-slate-700 ring-1 ring-slate-300';
}

function render(state) {
  const root = document.getElementById('app');
  const buy = state.buy;
  const sell = state.sell;
  const pnl = state.pnl || {};
  const idx = state.indices || {};
  const conn = state.connections || {};
  const position = state.position || {};
  const hasOpenPosition = !!position.hasOpenPosition;
  const hasCorrespondingSell = !!position.hasCorrespondingSell;
  const showNoSellOrder = hasOpenPosition && !hasCorrespondingSell;
  const sellStatus = String((sell && sell.status) || '').toLowerCase();
  const onlyLiveLtp = !!pnl.onlyLiveLtp;
  const realizedAvailable = !!pnl.realizedAvailable;
  // Keep values visible whenever there is an open position.
  const hidePnlValues = !hasOpenPosition && !realizedAvailable;
  const scriptName = pnl.scriptName ? String(pnl.scriptName) : '';
  const showLiveOnly = onlyLiveLtp && !realizedAvailable;
  const sellIsSl = !!sell && String(sell.orderType || '').toUpperCase() === 'SL';
  const sellHeading = sellIsSl ? 'SELL ORDER - STOPLOSS' : 'SELL ORDER - TARGET';
  const buyStatus = String((buy && buy.status) || '').toLowerCase();
  const isOpenBuy = buyStatus.includes('open') || buyStatus.includes('pending') || buyStatus.includes('trigger') || buyStatus.includes('validation');
  const buyHeading = isOpenBuy ? 'BUY ORDER' : 'LAST BUY ORDER';

  const buyOrderNo = String((buy && buy.nOrdNo) || '');
  const buyNowComplete = !!buy && isCompleteStatus(buyStatus);
  const buyWasComplete = isCompleteStatus(prevBuyStatus);
  const isTransitionToComplete =
    !!buy &&
    buyNowComplete &&
    (buyOrderNo !== prevBuyOrderNo || !buyWasComplete);
  if (isTransitionToComplete) {
    buyFlashUntilMs = Date.now() + 1400;
    notifyBuyComplete(buy);
  }
  prevBuyOrderNo = buyOrderNo;
  prevBuyStatus = buyStatus;
  const buyFlashClass = Date.now() < buyFlashUntilMs ? 'buy-complete-flash' : '';

  const sellOrderNo = String((sell && sell.nOrdNo) || '');
  const sellNowComplete = !!sell && isCompleteStatus(sellStatus);
  const sellWasComplete = isCompleteStatus(prevSellStatus);
  const isSellTransitionToComplete =
    !!sell &&
    sellNowComplete &&
    (sellOrderNo !== prevSellOrderNo || !sellWasComplete);
  if (isSellTransitionToComplete) {
    sellFlashUntilMs = Date.now() + 1400;
  }
  prevSellOrderNo = sellOrderNo;
  prevSellStatus = sellStatus;
  const sellFlashClass = Date.now() < sellFlashUntilMs ? 'sell-complete-flash' : '';

  root.innerHTML = `
    <div class="relative max-w-5xl mx-auto px-4 py-4 sm:py-8">
      <div class="absolute top-1 right-4 text-[9px] sm:text-[10px] text-slate-500 font-medium tracking-wide">Kotak Neo</div>
      <header class="mb-2 sm:mb-4 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-1 sm:gap-3">
        <div>
          <div class="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <div class="flex items-baseline gap-2">
              <span class="text-xs font-semibold uppercase tracking-wider text-slate-500">Nifty</span>
              <span class="text-xl sm:text-2xl font-bold tabular-nums text-slate-900">${fmt(idx.nifty)}</span>
            </div>
            <div class="flex items-baseline gap-2">
              <span class="text-xs font-semibold uppercase tracking-wider text-slate-500">Sensex</span>
              <span class="text-xl sm:text-2xl font-bold tabular-nums text-slate-900">${fmt(idx.sensex)}</span>
            </div>
          </div>
        </div>
      </header>

      ${state.lastError ? `<div class="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">${escapeHtml(state.lastError)}</div>` : ''}

      <div class="h-1"></div>

      <div class="grid grid-cols-1 gap-3 mb-3">
        <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm ${sellFlashClass}">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-500">${sellHeading}</h2>
            ${sell && !showNoSellOrder ? `<span class="text-xs px-2 py-0.5 rounded-md ${pillClass(sell.status)}">${escapeHtml(sell.status)}</span>` : ''}
          </div>
          ${
            sell && !showNoSellOrder
              ? `
            <div class="space-y-3">
              <div class="text-slate-500 text-sm truncate">${escapeHtml(sellIsSl ? 'Stoploss' : 'Target')}</div>
              ${
                sellIsSl
                  ? `
                <div>
                  <div class="text-slate-500 text-xs mb-1">Trigger</div>
                  <div class="text-4xl sm:text-5xl font-bold tabular-nums leading-none ${sell.status && String(sell.status).toLowerCase().includes('complete') ? 'text-slate-400' : 'text-orange-600'}">${fmt(sell.triggerPrice)}</div>
                </div>
                <div>
                  <div class="text-slate-500 text-xs mb-1">Limit price</div>
                  <div class="text-2xl font-semibold text-slate-800 tabular-nums">${fmt(sell.price)}</div>
                </div>
              `
                  : `
                <div>
                  <div class="text-slate-500 text-xs mb-1">Target</div>
                  <div class="text-4xl sm:text-5xl font-bold text-cyan-700 tabular-nums leading-none ${sell.status && String(sell.status).toLowerCase().includes('complete') ? 'text-slate-400' : ''}">${fmt(sell.limitPrice ?? sell.price)}</div>
                </div>
              `
              }
              <div class="text-xs text-slate-500">Order #${escapeHtml(sell.nOrdNo)}</div>
            </div>
          `
              : `<p class="text-red-600 text-3xl sm:text-4xl font-bold leading-tight">No Sell Order present</p>`
          }
        </section>

        <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm ${buyFlashClass}">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-500">${buyHeading}</h2>
            ${buy ? `<span class="text-xs px-2 py-0.5 rounded-md ${pillClass(buy.status)}">${escapeHtml(buy.status)}</span>` : ''}
          </div>
          ${
            buy
              ? `
            <div class="space-y-1">
              <div class="text-slate-500 text-sm truncate" title="${escapeHtml(buy.symbol || '')}">${escapeHtml(buy.symbol || '?')}</div>
              <div class="flex flex-wrap items-baseline gap-4">
                <div>
                  <div class="text-slate-500 text-xs">Price</div>
                  <div class="text-4xl sm:text-5xl font-bold text-slate-900 tabular-nums leading-none">${fmt(buy.price)}</div>
                </div>
                <div>
                  <div class="text-slate-500 text-xs">Qty</div>
                  <div class="text-4xl sm:text-5xl font-bold text-cyan-700 tabular-nums leading-none">${fmtInt(buy.qty)}</div>
                </div>
              </div>
              <div class="text-xs text-slate-500 pt-2">Order #${escapeHtml(buy.nOrdNo)}</div>
            </div>
          `
              : `<p class="text-slate-500 text-sm">No index F&amp;O buy in feed yet.</p>`
          }
        </section>
      </div>

      <section class="rounded-2xl border border-cyan-200 bg-gradient-to-br from-white to-cyan-50 p-6 shadow-sm">
        <h2 class="text-xs font-semibold uppercase tracking-wider text-cyan-700 mb-4">
          Position${scriptName ? ` ? ${escapeHtml(scriptName)}` : ''}
        </h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <div class="${showLiveOnly ? 'sm:col-span-2 lg:col-span-4' : ''}">
            <div class="text-slate-500 text-xs mb-1">Live LTP</div>
            <div class="text-3xl font-bold text-slate-900 tabular-nums">${fmt(pnl.liveLtp)}</div>
          </div>
          ${
            showLiveOnly
              ? `
          <div>
            <div class="text-slate-500 text-xs mb-1">High LTP (since entry)</div>
            <div class="text-3xl font-bold text-emerald-600 tabular-nums">${fmt(pnl.highLtpSinceEntry)}</div>
          </div>
          <div>
            <div class="text-slate-500 text-xs mb-1">Low LTP (since entry)</div>
            <div class="text-3xl font-bold text-rose-600 tabular-nums">${fmt(pnl.lowLtpSinceEntry)}</div>
          </div>
          `
              : `
          <div>
            <div class="text-slate-500 text-xs mb-1">${realizedAvailable ? 'Buy price' : 'Buy avg'}</div>
            <div class="text-3xl font-bold text-slate-700 tabular-nums">${fmt(realizedAvailable ? pnl.realizedBuyPrice : pnl.buyPrice)}</div>
          </div>
          <div>
            <div class="text-slate-500 text-xs mb-1">${realizedAvailable ? 'Points taken' : 'Point diff'}</div>
            <div class="text-3xl font-bold tabular-nums ${realizedAvailable ? ((pnl.pointsTaken || 0) >= 0 ? 'text-emerald-600' : 'text-rose-600') : (pnl.pointDiffColor === 'green' ? 'text-emerald-600' : pnl.pointDiffColor === 'red' ? 'text-rose-600' : 'text-slate-600')}">${realizedAvailable ? fmt(pnl.pointsTaken) : (hidePnlValues ? '' : fmt(pnl.pointDiff))}</div>
          </div>
          <div>
            <div class="text-slate-500 text-xs mb-1">${realizedAvailable ? 'Last Trade P&amp;L (?)' : 'Total P&amp;L (?)'}</div>
            <div class="text-3xl font-bold tabular-nums ${realizedAvailable ? ((pnl.lastTradePnlRs || 0) >= 0 ? 'text-emerald-600' : 'text-rose-600') : ((pnl.totalPnlRs || 0) >= 0 ? 'text-emerald-600' : 'text-rose-600')}">${realizedAvailable ? fmt(pnl.lastTradePnlRs) : (hidePnlValues ? '' : fmt(pnl.totalPnlRs))}</div>
          </div>`
          }
        </div>
        ${showLiveOnly ? '' : `
        <div class="mt-6 pt-6 border-t border-slate-200 grid grid-cols-2 gap-4">
          <div>
            <div class="text-slate-500 text-xs mb-1">High LTP (since entry)</div>
            <div class="text-xl font-semibold text-emerald-600 tabular-nums">${fmt(pnl.highLtpSinceEntry)}</div>
          </div>
          <div>
            <div class="text-slate-500 text-xs mb-1">Low LTP (since entry)</div>
            <div class="text-xl font-semibold text-rose-600 tabular-nums">${fmt(pnl.lowLtpSinceEntry)}</div>
          </div>
        </div>
        `}
        <p class="text-xs text-slate-500 mt-4">
          Lot size ${pnl.lotSize ?? '?'} ? Effective units ${fmtInt(pnl.effectiveUnits)}
          ${pnl.entryActive ? '' : ' ? High/low track after buy <span class="text-amber-600">COMPLETE</span>'}
        </p>
      </section>

      ${
        Array.isArray(state.slHistory) && state.slHistory.length
          ? `
      <section class="mt-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-500">Stoploss history</h2>
          <span class="text-xs text-slate-500">last 20</span>
        </div>
        <div class="overflow-x-auto">
          <table class="min-w-full text-sm">
            <thead>
              <tr class="text-left text-slate-500">
                <th class="py-2 pr-4 font-semibold">#</th>
                <th class="py-2 pr-4 font-semibold">Time</th>
                <th class="py-2 pr-4 font-semibold">Trigger Price</th>
              </tr>
            </thead>
            <tbody>
              ${state.slHistory
                .slice()
                .reverse()
                .map((h, idx) => `
                  <tr class="border-t border-slate-100">
                    <td class="py-2 pr-4 text-slate-500 tabular-nums">${idx + 1}</td>
                    <td class="py-2 pr-4 text-slate-700 whitespace-nowrap tabular-nums">${fmtTime(h.ts)}</td>
                    <td class="py-2 pr-4 font-bold text-orange-700 tabular-nums whitespace-nowrap">${fmt(h.triggerPrice)}</td>
                  </tr>
                `)
                .join('')}
            </tbody>
          </table>
        </div>
      </section>
      `
          : ''
      }

      <footer class="mt-10 text-center text-xs text-slate-500">
        Polling orders REST every 30s ? WebSocket realtime
      </footer>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '?';
  return new Date(n).toLocaleTimeString('en-IN', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

socket.on('dashboard', (state) => {
  render(state);
});

socket.on('connect_error', (err) => {
  const root = document.getElementById('app');
  root.innerHTML = `<div class="p-8 text-red-700">Connection failed: ${escapeHtml(err.message)}</div>`;
});

render({
  loginOk: false,
  connections: { hsi: false, hsm: false },
  buy: null,
  sell: null,
  pnl: {},
  indices: { nifty: null, sensex: null }
});
