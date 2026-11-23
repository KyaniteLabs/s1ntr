#!/usr/bin/env node
import { main as manifestMain } from './manifest.mjs';
import { main as inventoryMain } from './inventory.mjs';
import { main as diagnoseMain } from './diagnose-cluster.mjs';
import { checkBudget, loadBudget } from './budget.mjs';

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'manifest') {
  manifestMain(rest);
} else if (cmd === 'inventory') {
  inventoryMain(rest);
} else if (cmd === 'diagnose') {
  diagnoseMain(rest);
} else if (cmd === 'budget') {
  const usage = {
    calls: Number(rest[0] || 0),
    tokens: Number(rest[1] || 0),
    usd: Number(rest[2] || 0),
    ms: Number(rest[3] || 0),
  };
  const r = checkBudget(usage, loadBudget());
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
} else {
  console.log(`sinter mece <manifest|inventory|diagnose|budget> ...
  manifest [--check] [--write path]
  inventory [--write path]
  diagnose <clusterId> [--write path]
  budget [calls tokens usd ms]`);
  process.exit(cmd ? 2 : 0);
}
