// Tiny Bot, Easy $2 — trend ride with a volatility brake.
//
// Strategy (per SPEC):
//  - Trend filter: fast EMA (12 bars) vs slow EMA (48 bars) on closes.
//  - Enter long when fast crosses above slow AND the trailing 24-bar return
//    is positive. Equal notional slice of available cash, capped at 25% of
//    equity per position, at most 5 symbols at once.
//  - Exit when fast crosses below slow, OR the close falls 8% below the
//    highest close since entry (trailing stop), OR the trailing 24-bar
//    return drops below -3% (momentum breakdown). Sell the whole position.
//  - Portfolio drawdown guard: if equity falls more than 12% below its
//    peak, sell everything and stay flat until some symbol again shows
//    fast EMA above slow EMA.
//  - Order mechanics: decide every batch (hourly bar). Never trade while
//    warming up. A sell's proceeds land at the next open and never fund a
//    buy in the same reply, so buys are deferred to the batch after any
//    batch that sold anything.
//  - Determinism: every decision is a pure function of the bar history
//    seen so far. No randomness, no clock, no network.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const FAST_LEN = 12;
const SLOW_LEN = 48;
const MOMENTUM_BARS = 24;
const MOMENTUM_EXIT = -0.03;
const TRAIL_STOP = 0.08;
const MAX_SYMBOLS = 5;
const MAX_SLIPPAGE_BPS = 10000;
const MIN_NOTIONAL = 1_000_000n; // 1 USDC, in micro units

interface SymState {
  closes: number[]; // closes in USDC
  fast: number | null;
  slow: number | null;
  prevFast: number | null;
  prevSlow: number | null;
  peakClose: number; // highest close since the current entry
}

const syms = new Map<string, SymState>();
let peakEquity = 0n;
let guardActive = false;
let buysDeferred = false; // true on the batch right after a batch that sold

function symState(symbol: string): SymState {
  let s = syms.get(symbol);
  if (s === undefined) {
    s = { closes: [], fast: null, slow: null, prevFast: null, prevSlow: null, peakClose: 0 };
    syms.set(symbol, s);
  }
  return s;
}

function emaUpdate(prev: number | null, price: number, len: number): number {
  if (prev === null) return price;
  const alpha = 2 / (len + 1);
  return prev + alpha * (price - prev);
}

function momentum24(s: SymState): number | null {
  const n = s.closes.length;
  if (n <= MOMENTUM_BARS) return null;
  const now = s.closes[n - 1]!;
  const then = s.closes[n - 1 - MOMENTUM_BARS]!;
  if (then <= 0) return null;
  return now / then - 1;
}

function crossedUp(s: SymState): boolean {
  return (
    s.prevFast !== null &&
    s.prevSlow !== null &&
    s.fast !== null &&
    s.slow !== null &&
    s.prevFast <= s.prevSlow &&
    s.fast > s.slow
  );
}

function crossedDown(s: SymState): boolean {
  return (
    s.prevFast !== null &&
    s.prevSlow !== null &&
    s.fast !== null &&
    s.slow !== null &&
    s.prevFast >= s.prevSlow &&
    s.fast < s.slow
  );
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  // 1. Fold this batch's bars into per-symbol history.
  for (const bar of batch.bars) {
    const meta = state.symbols.get(bar.symbol);
    if (meta === undefined) continue;
    const price = Number(BigInt(bar.c)) / 10 ** meta.price_scale;
    const s = symState(bar.symbol);
    s.prevFast = s.fast;
    s.prevSlow = s.slow;
    s.closes.push(price);
    s.fast = emaUpdate(s.fast, price, FAST_LEN);
    s.slow = emaUpdate(s.slow, price, SLOW_LEN);
    if (s.peakClose > 0) s.peakClose = Math.max(s.peakClose, price);
  }

  const orders: OrderInput[] = [];
  if (state.warmingUp) return orders;

  // 2. Sync peak-close tracking with the positions the harness reports.
  for (const [symbol, pos] of state.positions) {
    const s = symState(symbol);
    const close = state.close(symbol);
    if (close === null) continue;
    const meta = state.symbols.get(symbol)!;
    const price = Number(close) / 10 ** meta.price_scale;
    if (s.peakClose === 0) s.peakClose = price;
    else s.peakClose = Math.max(s.peakClose, price);
  }
  for (const [symbol, s] of syms) {
    if (!state.positions.has(symbol)) s.peakClose = 0;
  }

  // 3. Portfolio drawdown guard: track peak equity, liquidate on a 12% drop.
  if (state.equity > peakEquity) peakEquity = state.equity;
  // Exact integer check: equity below 88% of its peak means a >12% drawdown.
  const guardThreshold = (peakEquity * 88n) / 100n;
  const guardTripped = peakEquity > 0n && state.equity < guardThreshold;
  if (guardTripped && state.positions.size > 0) {
    guardActive = true;
    for (const [symbol, pos] of state.positions) {
      orders.push({ side: 'sell', symbol, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }
    buysDeferred = true;
    return orders;
  }
  if (guardActive) {
    // Stay flat until at least one symbol again shows fast above slow.
    let trendBack = false;
    for (const s of syms.values()) {
      if (s.fast !== null && s.slow !== null && s.fast > s.slow) {
        trendBack = true;
        break;
      }
    }
    if (!trendBack) return orders;
    guardActive = false;
  }

  // 4. Exits: cross down, trailing stop, or momentum breakdown.
  let sold = false;
  for (const [symbol, pos] of state.positions) {
    const s = syms.get(symbol);
    if (s === undefined) continue;
    const close = state.close(symbol);
    if (close === null) continue;
    const meta = state.symbols.get(symbol)!;
    const price = Number(close) / 10 ** meta.price_scale;
    const mom = momentum24(s);
    const stopHit = s.peakClose > 0 && price < s.peakClose * (1 - TRAIL_STOP);
    const momBreak = mom !== null && mom < MOMENTUM_EXIT;
    if (crossedDown(s) || stopHit || momBreak) {
      orders.push({ side: 'sell', symbol, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      sold = true;
    }
  }

  // 5. Entries: buys are deferred to the batch after any batch that sold.
  const deferred = buysDeferred;
  buysDeferred = sold;
  if (sold || deferred) return orders;

  const heldCount = state.positions.size;
  const slots = MAX_SYMBOLS - heldCount;
  if (slots <= 0 || state.cash <= 0n) return orders;

  for (const symbol of state.symbols.keys()) {
    if (orders.length >= 16) break;
    if (state.positions.has(symbol)) continue;
    if (state.positions.size + orders.filter((o) => o.side === 'buy').length >= MAX_SYMBOLS) break;
    const s = syms.get(symbol);
    if (s === undefined) continue;
    if (s.closes.length < SLOW_LEN) continue; // slow EMA needs a full window
    const mom = momentum24(s);
    if (mom === null || mom <= 0) continue; // momentum confirmation
    if (!crossedUp(s)) continue; // trend filter: fast crossing above slow

    // Equal notional slice of available cash, capped at 25% of equity.
    const remainingSlots = MAX_SYMBOLS - state.positions.size - orders.filter((o) => o.side === 'buy').length;
    if (remainingSlots <= 0) break;
    let notional = state.cash / BigInt(remainingSlots);
    const room = state.weightRoom(symbol);
    if (notional > room) notional = room;
    if (notional < MIN_NOTIONAL) continue;
    orders.push({ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
  }

  return orders;
}

await runBars({ onBatch });
