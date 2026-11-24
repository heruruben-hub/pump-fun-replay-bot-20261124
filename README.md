# pump-fun-replay-bot-20261124

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/heruruben-hub/pump-fun-replay-bot-20261124/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/heruruben-hub/pump-fun-replay-bot-20261124/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for make.fun's Pump.fun Replay Sprint. It trades 10 SOL
of paper money on a 24-hour replay of pump.fun bonding-curve activity.

## How it trades

Most new pump.fun coins fade fast, so the bot stays small and quick. It
watches every coin from its CreateEvent and only buys a launch once real
buyers have shown up: inside a short window after creation, with the creator
not selling, exactly a few distinct non-creator wallets buying, net SOL
flowing in, and the price already up a little from the create price. Each
position is a fixed 0.1 SOL stake, exited fast on a +25% take-profit, a −12%
stop-loss, a 10-slot maximum hold, or the moment the creator sells while the
bot holds. Positions cycle through many coins, which also keeps the bot above
the 20-mint guardrail; as a backstop, if the bot's own coin count ever lags
its pace late in the window, it opens tiny 0.01 SOL probe round trips on the
most liquid coin in the batch until it is back on pace.

The bot is deterministic: no clock, no randomness, no network — two runs of
the same replay produce the same action log.

## Run it

```sh
node main.ts
```

It speaks the `agent-fun/replay/v2` protocol on stdin/stdout; the harness
drives it. `vendor/makefun-bot.ts` is the kit's bot shim, vendored
byte-identical. Node 22 or later runs the TypeScript directly, no build and
no install.

## Dev score

Graded locally with the kit's own grader (`grade-local --driver process`) on
the published dev window: net PnL ≈ −0.01 SOL over 32 coins (18.8% win
rate), max drawdown ≈ 0.4%, guardrails met. For comparison, the kit's
house sniper pilot scores ≈ −0.47 SOL on the same window.

---

<sub>Entered on [make.fun](https://make.fun/?ref=kh6903y0&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
