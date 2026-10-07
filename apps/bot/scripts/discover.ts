// Dry run of whale discovery: scores wallets and prints the results. Follows nobody.
//   npm run discover            (score 15 wallets)
//   npm run discover -- 3       (score 3)
import { describeScore, discoverWhales } from '../src/trading/discovery.ts';

const max = Number(process.argv[2] ?? 15);
const started = Date.now();
const result = await discoverWhales(max, (step) => console.log(`… ${step}`));
console.log(`\nTokens scanned: ${result.tokens.join(', ')}`);
console.log(`Active wallets seen: ${result.seen} · scored: ${result.evaluated.length} · took ${Math.round((Date.now() - started) / 1000)}s\n`);
for (const c of result.evaluated) {
  console.log(`${c.score.eligible ? '✅' : '❌'} ${c.address}  score ${c.score.score.toFixed(3)}  (seen in ${c.foundIn.join(', ')})`);
  console.log(`   ${describeScore(c.score)} · realized $${c.score.realizedUsd.toFixed(2)} · ${Math.round(c.score.liquidShare * 100)}% liquid`);
  if (!c.score.eligible) console.log(`   ✗ ${c.score.reasons.join('; ')}`);
}
