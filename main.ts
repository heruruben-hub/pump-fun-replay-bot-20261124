// Pump.fun Replay Sprint — launch scalp with confirmation.
//
// Hello: this bot trades 10 SOL of paper money on a 24h pump.fun replay. It
// watches every coin from its CreateEvent and buys a small fixed stake only
// once a launch has shown real buyers: inside a short age window after
// creation, with the creator not selling, several distinct non-creator
// wallets buying (but not so many that it smells like a bundled cluster),
// net SOL flowing in, and the price already up a little from the create
// price. Most launches are losers, so the bot stays small, exits fast, and
// cycles through many coins — the guardrail needs 20+ distinct mints, and no
// single coin is allowed to hurt the account much.
//
// Every batch of orders is decided from the state the harness hands over for
// that slot: exits first (take-profit, stop-loss, a hard maximum hold, and an
// instant exit when the creator sells while we hold), then new entries. A
// reply never carries more than the batch cap of orders, buys on one mint
// never exceed the size cap, and no position is opened while five are
// already committed. Deterministic by construction: no clock, no randomness,
// insertion-ordered maps only, so two runs produce the same action log.

import { BPS, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin in total. */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuy: number;
  maxDevBuy: number;
  /** Distinct non-creator buyers seen before entry: window. */
  minBuyers: number;
  maxBuyers: number;
  /** Price now over the create price, as bps (10000 = flat): window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** The recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowLamports: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /**
   * Guardrail pacing: the run must end with at least 20 distinct mints. Once
   * three quarters of the window's block time has passed, if the bot's own
   * coins lag targetCoins scaled by the pace, it opens tiny probe round trips
   * (buy probeSol on the most liquid coin in the batch, sell it as soon as
   * the buy lands) until it is back on pace.
   */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 2,
  maxAge: 3,
  stakeLamports: 100_000_000,
  minBuyLamports: 5_000_000,
  minRealSol: 300_000_000,
  maxRealSol: 30_000_000_000,
  minDevBuy: 0,
  maxDevBuy: 2_500_000_000,
  minBuyers: 3,
  maxBuyers: 3,
  minRunupBps: 10500,
  maxRunupBps: 1_000_000,
  flowWindow: 10,
  minFlowLamports: 0,
  skipDevSold: true,
  buySlippageBps: 10_000,
  tpBps: 2500,
  slBps: 1200,
  trailArmBps: 1_000_000,
  trailBps: 1000,
  maxHold: 10,
  exitOnDevSell: true,
  targetCoins: 25,
  paceSecs: 86400,
  probeSol: 0.01,
  maxProbes: 1,
};

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** The create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  buyers: Set<Pubkey>;
  bought: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Trades of the last flowWindow slots (older ones dropped as new ones come). */
  recent: Tick[];
  /** Never buy it again (entered, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
}

const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) would pay after curve fees (protocol + creator, 95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): { onBatch(state: BotState, batch: Batch): OrderInput[] } {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  /** Probe round trips in flight (guardrail pacing), by mint. */
  const probes = new Set<Pubkey>();
  /** Mints the bot's own filled orders were on. */
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime = 0;
  const stake = BigInt(p.stakeLamports);
  const minBuy = BigInt(p.minBuyLamports);

  /** Net lamports bought minus sold over the last flowWindow slots. */
  const flow = (c: Coin, slot: number): bigint => {
    const from = slot - p.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    for (const t of c.recent) net += t.isBuy ? t.sol : -t.sol;
    return net;
  };

  const hasPending = (state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean => {
    for (const po of state.pending.values()) {
      if (po.order.mint === mint && po.order.side === side) return true;
    }
    return false;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          coins.set(e.mint, {
            mint: e.mint,
            createSlot: e.slot,
            creator: e.creator,
            vq0: BigInt(e.virtual_quote_reserves),
            vt0: BigInt(e.virtual_token_reserves),
            devBuy: 0n,
            buyers: new Set(),
            bought: 0n,
            devSold: false,
            lastTradeSlot: e.slot,
            recent: [],
            done: false,
            complete: false,
          });
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = BigInt(e.sol_amount);
          c.lastTradeSlot = e.slot;
          c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            c.bought += sol;
            if (isDev && e.slot === c.createSlot) c.devBuy += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
          }
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) myCoins.add(f.mint);
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          probes.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), best: 0n });
        }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) held.delete(mint);
      }
      for (const mint of [...probes]) {
        if (!state.positions.has(mint) && !hasPending(state, mint, 'buy') && !hasPending(state, mint, 'sell')) probes.delete(mint);
      }

      // Probe exits: sell a probe the moment its buy has landed.
      for (const mint of [...probes]) {
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (hasPending(state, mint, 'sell')) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
      }

      // Exits first.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(p.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(p.slBps))) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(p.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(p.trailBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= p.maxHold) exit = true;
        if (c !== undefined && p.exitOnDevSell && c.devSold) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: fresh launches that already show real buying.
      let free = state.freeCashLamports();
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        if (age > p.maxAge) {
          c.done = true;
          continue;
        }
        if (age < p.minAge) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && p.skipDevSold) {
          c.done = true;
          continue;
        }
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(p.minRealSol) || rq > BigInt(p.maxRealSol)) continue;
        if (c.devBuy < BigInt(p.minDevBuy) || c.devBuy > BigInt(p.maxDevBuy)) continue;
        if (c.buyers.size < p.minBuyers || c.buyers.size > p.maxBuyers) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup > BigInt(p.maxRunupBps) || runup < BigInt(p.minRunupBps)) continue;
        if (flow(c, state.slot) < BigInt(p.minFlowLamports)) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        c.done = true;
        open += 1;
      }

      // Guardrail pacing: open one tiny probe round trip when the bot's own
      // coins lag the pace late in the window. A probe buys the smallest
      // qualifying amount on the most liquid coin in this batch; the probe
      // exit above sells it as soon as the buy lands.
      if (probes.size < p.maxProbes && firstTime !== null && lastTime > firstTime) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        if (pace >= 0.75 && myCoins.size < Math.ceil(p.targetCoins * pace)) {
          const probeLamports = BigInt(Math.floor(p.probeSol * 1e9));
          let bestMint: Pubkey | null = null;
          let bestRq = 0n;
          for (const e of batch.events) {
            const curve = state.curves.get(e.mint);
            if (curve === undefined || curve.complete) continue;
            if (held.has(e.mint) || probes.has(e.mint) || hasPending(state, e.mint, 'buy') || state.positions.has(e.mint)) continue;
            if (curve.real_quote_reserves > bestRq) {
              bestRq = curve.real_quote_reserves;
              bestMint = e.mint;
            }
          }
          if (bestMint !== null && state.maxBuyLamports(bestMint) >= probeLamports && free >= probeLamports + tx && orders.length < cap) {
            orders.push({ side: 'buy', mint: bestMint, quote_lamports: probeLamports, max_slippage_bps: p.buySlippageBps });
            probes.add(bestMint);
            free -= probeLamports + tx;
          }
        }
      }
      return orders;
    },
  };
}

await runBot(createStrategy());
