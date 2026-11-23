/** MECE cluster path ownership for UMD-V2 G5 inventory. Exclusive prefixes. */
export const CLUSTERS = {
  'C-core': [
    'src/core/',
    'src/runtime-core/',
    'src/routing/',
    'src/types/',
    'src/errors/',
    'src/constants/',
    'src/shared/',
    'src/utils/',
  ],
  'C-llm': [
    'src/llm/',
    'src/prompts/',
    'src/config/',
    'src/nodeprompt/',
  ],
  'C-harness': [
    'src/harness/',
    'src/ledger/',
    'src/improvement/',
    'src/quality/',
    'src/fix/',
    'harness-tasks/',
    'ledger-tasks/',
  ],
  'C-gen': [
    'src/generators/',
    'src/render/',
    'src/composite/',
    'src/composition/',
    'src/creative-vocabulary/',
  ],
  'C-media': [
    'src/music/',
    'src/audio/',
    'src/musicToVisual/',
    'src/aesthetic/',
    'src/perception/',
    'src/brain/',
    'src/creative-intelligence/',
    'src/media/',
    'src/footage/',
    'src/reverse/',
  ],
  'C-evo': [
    'src/atelier/',
    'src/evolution/',
    'src/compost/',
    'compost/',
    'src/dreaming/',
    'src/emergence/',
    'src/entropy/',
    'src/intuition/',
    'src/learning/',
    'src/embeddings/',
    'src/cortex/',
  ],
  'C-surface': [
    'src/cli/',
    'src/chat/',
    'src/creative-run/',
    'src/tui/',
    'src/tui-bridge/',
    'src/gui/',
    'src/ui/',
    'src/site/',
    'src/gallery/',
    'src/market/',
    'src/product/',
    'src/export/',
    'src/release/',
    'teaser/',
  ],
  'C-agent': [
    'src/agent/',
    'src/collab/',
    'src/swarm/',
    'src/autonomy/',
    'src/daemon/',
    'src/scavenger/',
  ],
  'C-safety': [
    'src/security/',
    'src/sandbox/',
    'src/guardrails/',
    'src/identity/',
    'src/git/',
    'src/telemetry/',
    'src/analytics/',
    'src/reporting/',
  ],
  'C-plugins': [
    'src/plugins/',
    'src/fs/',
    'src/evaluation/',
    'plugins/',
  ],
  'C-tooling-tests': [
    'test/',
  ],
  'C-tooling-scripts': [
    'scripts/',
    'tools/dashboards/',
  ],
  'C-tooling-ci': [
    '.forgejo/',
    '.github/',
    '.githooks/',
    'config/',
    'docker/',
    'ops/',
    'audition/',
    'dogfood-campaign/',
    'goals/',
  ],
  'C-tooling-docs': [
    'assets/',
    'docs/',
    'site/',
    'deploy/',
    'branding/',
  ],
  'C-workspace-gui': [
    'gui/',
    'hermes-plugin/',
  ],
  'C-workspace-packages': [
    'packages/',
  ],
  'C-agent-skills': [
    '.skills/',
  ],
};

/** Paths that are intentionally unowned product inventory (tracked but excluded). */
export const EXCLUDES = [
  { prefix: 'node_modules/', reason: 'dependency tree' },
  { prefix: 'dist/', reason: 'build output' },
  { prefix: 'coverage/', reason: 'coverage output' },
  { prefix: '.quality/', reason: 'local receipts; not product SoT' },
  { prefix: 'artifacts/', reason: 'local campaign artifacts' },
  { prefix: '.omx/', reason: 'local agent state' },
  { prefix: 'vendor/', reason: 'pinned third-party bytes; integrity owned by vendor/manifest.json + OfflineVendored test' },
];

export function assignCluster(relPath) {
  const p = relPath.replace(/\\/g, '/');
  for (const ex of EXCLUDES) {
    if (p === ex.prefix.slice(0, -1) || p.startsWith(ex.prefix)) {
      return { kind: 'exclude', reason: ex.reason };
    }
  }
  for (const [clusterId, prefixes] of Object.entries(CLUSTERS)) {
    for (const pref of prefixes) {
      if (p === pref.slice(0, -1) || p.startsWith(pref)) {
        return { kind: 'cluster', clusterId };
      }
    }
  }
  // standalone src files
  if (p.startsWith('src/') && !p.slice(4).includes('/')) {
    return { kind: 'cluster', clusterId: 'C-core' };
  }
  // root configs, bin, desktop, examples — tooling/ci surface for v0 inventory
  if (
    p.startsWith('bin/') ||
    p.startsWith('electron/') ||
    p.startsWith('examples/') ||
    p.startsWith('landing-live/') ||
    p.startsWith('public/') ||
    p.startsWith('fixtures/') ||
    p.startsWith('memory/') ||
    p.startsWith('.vscode/') ||
    p.startsWith('.claude/') ||
    p.startsWith('.codex/') ||
    p.startsWith('.agents/') ||
    !p.includes('/')
  ) {
    return { kind: 'cluster', clusterId: 'C-tooling-ci' };
  }
  return { kind: 'unowned' };
}
