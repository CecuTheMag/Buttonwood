// Backtest from the command line:
//   npm run backtest -- trend SOL 90
//   npm run backtest -- grid JUP 60 levels=8 rangePct=16
//   npm run backtest -- all 90
import { backtestAll, formatBacktestRow, runBacktest } from '../src/trading/tournament.ts';

const [type = 'all', a = '90', b, ...rest] = process.argv.slice(2);
if (type === 'all') {
  const rows = await backtestAll(Number(a), (s) => console.log(`… ${s}`));
  rows.forEach((r, i) => console.log(`${String(i + 1).padStart(2)}. ${formatBacktestRow(r)}`));
} else {
  const params = Object.fromEntries(rest.map((w) => w.split('=')).map(([k, v]) => [k, Number(v)]));
  const r = await runBacktest(type, a, Number(b ?? 90), params);
  console.log(formatBacktestRow(r));
}
