# BTC race bot — btc-race-24h-20261113-2314

A one-leg momentum bot for make.fun's 24-hour BTC race (bars-replay/v1).

- Entry: once, when the 15-minute return on CBBTC exceeds +55 bps (full size).
- Exit: trailing stop 40 bps below the peak since entry, or the 15-minute
  return falling below -15 bps.
- No re-entry after the exit; a $1 guardrail probe fires after batch 1300
  only if nothing ever filled.
- Exact bigint comparisons throughout; no floats, no clock, no randomness.

Dev window (2026-11-12 23:15 UTC → 2026-11-13 23:14 UTC): one round trip
(buy bar 422, sell bar 483), net PnL +$5.71, 2 trades, 0.50% max drawdown.

Run: `node main.ts` (Node 22, stdlib only; the protocol shim is vendored
under `vendor/`).
