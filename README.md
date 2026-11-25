# Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana

[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/Andysyahputra/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny trading bot for the [make.fun](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) bounty "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana" ($2 prize).

## Strategy

Trend ride with a volatility brake, on hourly Solana bars (7 symbols: FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH, WIF):

- **Trend filter:** fast EMA (12 bars) vs slow EMA (48 bars) on closes.
- **Enter long** when fast EMA crosses above slow EMA AND the trailing 24-bar return is positive. Equal notional slices, capped at 25% of equity per position, max 5 symbols.
- **Exit** when fast EMA crosses below slow EMA, or the close falls 8% below the highest close since entry (trailing stop), or the trailing 24-bar return drops below −3%.
- **Portfolio drawdown guard:** if equity falls more than 12% below its peak, sell everything to USDC and stay flat until a symbol shows fast EMA above slow EMA again.

Deterministic: all decisions are pure functions of the bar history seen so far. No randomness, no clock, no network.

## Dev-window validation (grade-local, `--driver process`)

- Net PnL **−126.17 USDC** vs buy-and-hold **−869.34 USDC** (above baseline by ~743)
- **11 trades** (guardrail ≥ 8)
- Max drawdown **1.29%** (guardrail ≤ 25%)
- Deterministic: regrade reproduced byte for byte, 0 rejected orders
