// Child process for VotingEngine.ledger-concurrency.test.ts: records `count`
// gold outcomes for voter "a" (always correct) against the ledger at argv[2].
import { VotingEngine } from '../../../src/swarm/VotingEngine.js';

const [, , ledger, tag, count] = process.argv;
VotingEngine.attachLedger(ledger!);
for (let i = 0; i < Number(count); i++) {
  VotingEngine.recordOutcome('a', 'general', 'w', 'w', { source: 'human', outcomeId: `${tag}-${i}` });
}
