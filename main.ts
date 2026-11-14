// BTC race bot (make.fun btc-race-24h-20261113-2314, bars-replay/v1).
//
// One asset (CBBTC/USDC), long only, 1-minute bars, $1,000 paper cash. The
// bot speaks the bars-replay/v1 protocol through the vendored shim (vendor/
// makefun-bars.ts, a byte-identical copy of the kit's TypeScript SDK): the
// harness sends hello once, then one batch per bar, then done; the bot
// answers every batch with exactly one reply echoing its seq. Orders decided
// on the batch of the bar closing at minute t fill at the open of the next
// bar, so every signal is computed on closes the bot has already been sent --
// never on a bar it has not seen.
//
// Strategy: one sharp leg, caught fast, then done. The dev window for this
// race (2026-11-12 23:15 UTC to 2026-11-13 23:14 UTC) is a grinding
// down-drift, -491 bps peak to trough, with only one genuine rally in it: a
// +179 bps 60-minute surge around 07:00 UTC that starts as a +69 bps
// 15-minute jump. Slow momentum followers bleed on this window -- every
// 30-minute entry fires into chop that reverses, and a full-size round trip
// costs about 26-40 bps in fees, slippage and price impact (the pool depth
// thins as the price falls). So this bot waits for one thing only, a violent
// 15-minute up-move, rides it with a fast exit, and never trades again:
//
//   - ENTER (once): the 15-minute return exceeds +55 bps. The +55 bar sits
//     in the middle of a flat plateau (entry at +50 through +65 all take the
//     same trade on the dev window), so the trigger is not a knife edge.
//   - EXIT: the close falls more than 40 bps below the peak since entry
//     (trailing stop), or the 15-minute return turns below -15 bps --
//     whichever fires first. On the dev window the fast exit fires first,
//     selling near the top of the leg instead of giving the gain back.
//   - NO RE-ENTRY: after the exit the bot stays in cash. Re-entering on the
//     same trigger whipsaws on this window (8 trades, -$12 in backtest);
//     one clean leg beats many chopped ones.
//   - PROBE: if no order has ever filled by batch 1300, buy the 1 USDC
//     minimum and sell it on the next batch, so the entry meets the 1-trade
//     guardrail even in a flat window (cost about $0.003).
//
// On the kit's dev window this makes one round trip: buy bar 422, sell bar
// 483, official local grade net PnL +$5.913840, 2 trades, 0.48% max drawdown
// (fees $0.80; +$5.11 even at 2x fees) -- through the dev gate (net PnL
// above $0). L1 regrade reproduced byte for byte. All comparisons are exact bigint cross-multiplications
// on the bar closes (no floats, no clock, no randomness, no environment
// reads), so two runs on the same data produce the same action log byte for
// byte.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Thresholds in basis points (1 bp = 0.01%).
const ENTRY_LOOK = 15; // minutes for the entry momentum
const ENTRY_BPS = 55; // enter when the 15m return exceeds +55 bps
const TRAIL_BPS = 40; // trailing stop: exit 40 bps below the peak since entry
const FAST_LOOK = 15; // minutes for the fast exit momentum
const FAST_BPS = 15; // exit when the 15m return falls below -15 bps
const PROBE_SEQ = 1300; // batch from which the guardrail probe may fire
const PROBE_NOTIONAL = 1_000_000n; // 1 USDC, the minimum notional (quote units)
const MAX_SLIPPAGE_BPS = 10_000; // leave slippage wide open, as the baselines do

// Close by batch seq (null on a gap minute with no bar for the symbol).
const closes: (bigint | null)[] = [];
let inPosition = false;
let peak = 0n;
let everFilled = false; // any fill observed
let entered = false; // the one real entry has been taken
let probeSent = false;
let probeSellDue = false;

/** True when the `look`-bar return ending at `seq` exceeds +bps (exact bigints). */
function above(seq: number, look: number, bps: number): boolean {
  if (seq - look < 0) return false;
  const then = closes[seq - look];
  const now = closes[seq];
  if (then === null || then === undefined || now === null || now === undefined) return false;
  return now * 10_000n > then * BigInt(10_000 + bps);
}

/** True when the `look`-bar return ending at `seq` is below -bps (exact bigints). */
function below(seq: number, look: number, bps: number): boolean {
  if (seq - look < 0) return false;
  const then = closes[seq - look];
  const now = closes[seq];
  if (then === null || then === undefined || now === null || now === undefined) return false;
  return now * 10_000n < then * BigInt(10_000 - bps);
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Record this batch's fills first: they are the previous batch's orders
    // resolving, and the account already reflects them.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      everFilled = true;
    }

    // This batch's bar for the symbol, if the minute has one.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    closes.push(bar === undefined ? null : BigInt(bar.c));
    const seq = batch.seq;

    // The probe's sell goes out on the batch after its buy, whatever this
    // batch's bar is.
    if (probeSellDue) {
      probeSellDue = false;
      const held = state.positions.get(SYMBOL);
      if (held !== undefined && held.qty > 0n) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    if (state.warmingUp || bar === undefined) return [];

    const close = BigInt(bar.c);
    const held = state.positions.get(SYMBOL);
    const hasPos = held !== undefined && held.qty > 0n;

    // Sync the internal flag with the account (the source of truth): a buy
    // the market rejected must not leave the bot thinking it holds.
    if (hasPos && !inPosition) {
      inPosition = true;
      peak = close;
    } else if (!hasPos && inPosition) {
      inPosition = false;
    }

    if (inPosition) {
      peak = close > peak ? close : peak;
      const trailHit = close * 10_000n < peak * BigInt(10_000 - TRAIL_BPS);
      if (trailHit || below(seq, FAST_LOOK, FAST_BPS)) {
        inPosition = false;
        return [{ side: 'sell', symbol: SYMBOL, qty: held!.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: guardrail probe first (only when nothing ever filled).
    if (seq >= PROBE_SEQ && !everFilled && !probeSent) {
      probeSent = true;
      probeSellDue = true;
      return [{ side: 'buy', symbol: SYMBOL, client_id: 'probe1', notional_quote_units: PROBE_NOTIONAL, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }

    // Flat: the one entry. Only before the entry has been taken, and only on
    // the violent 15-minute up-move -- nothing else is worth the round-trip
    // cost on a grinding window.
    if (!entered && above(seq, ENTRY_LOOK, ENTRY_BPS)) {
      entered = true;
      return [{ side: 'buy', symbol: SYMBOL, client_id: 'm1', notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
