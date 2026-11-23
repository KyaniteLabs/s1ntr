/**
 * Per-command help for `sinter <command> --help` (dogfood finding 5: every command used to print the global help).
 * One row per registered command in bin/sinter; test/integration/cli-command-help.test.ts fails the build when a
 * command registered in bin/sinter has no row here, or when its help is the global help.
 */
export interface CommandHelpEntry {
  readonly summary: string;
  readonly usage: readonly string[];
  readonly flags?: readonly string[];
  readonly example: string;
}

const GEN: CommandHelpEntry = {
  summary: 'Create art or code from a prompt through the governed generate path (exit 0 accepted, 3 generated but not accepted).',
  usage: ['sinter generate [options] "<prompt>"', 'sinter "<prompt>"'],
  flags: ['--domain <name>   force a creative domain', '-o, --output <dir>   output directory', '--reasoning <level>   none|low|medium|high|xhigh|max', '--teach <scope>   apply activated knowledge (visual|motion)', '--attempt <id>   name this sampling attempt'],
  example: 'sinter generate --domain html "a slow orbit of colored light"',
};
const MARKET: CommandHelpEntry = {
  summary: 'Print the release-truth report; exit 0 only when release-ready.',
  usage: ['sinter market status', 'sinter readiness status'],
  example: 'sinter market status',
};
const LIST: CommandHelpEntry = {
  summary: 'Show saved sketches.',
  usage: ['sinter list'],
  example: 'sinter list',
};
const SERVE: CommandHelpEntry = {
  summary: 'Start the preview server.',
  usage: ['sinter serve [port]'],
  flags: ['--gallery <dir>   gallery directory to expose (default ./gallery)'],
  example: 'sinter serve 3456',
};

export const COMMAND_HELP: Readonly<Record<string, CommandHelpEntry>> = {
  generate: GEN, gen: GEN, g: GEN,
  list: LIST, ls: LIST,
  serve: SERVE, s: SERVE,
  market: MARKET, readiness: MARKET,
  archive: { summary: 'Inspect the artifact archive.', usage: ['sinter archive list', 'sinter archive inspect <artifactId>', 'sinter archive lineage <artifactId>'], example: 'sinter archive list' },
  'authoritative-create': { summary: 'Run an authority-sealed governed create.', usage: ['sinter authoritative-create --authority <absolute-authority.json>'], flags: ['--authority <file>   absolute path to the authority json (required)'], example: 'sinter authoritative-create --authority /abs/authority.json' },
  'authoritative-reevaluate': { summary: 'Re-evaluate an authority-sealed create with a repair authority.', usage: ['sinter authoritative-reevaluate --authority <original.json> --reevaluation-authority <repair.json>'], flags: ['--authority <file>', '--reevaluation-authority <file>'], example: 'sinter authoritative-reevaluate --authority /abs/a.json --reevaluation-authority /abs/b.json' },
  'best-of': { summary: 'Generate 2-3 candidates, score each, keep the best and archive the rest.', usage: ['sinter best-of [N=2..3] "<prompt>"'], flags: ['--domain <name>   forwarded to every candidate'], example: 'sinter best-of 3 "a slow orbit of colored light"' },
  capabilities: {
    summary: 'Classify saved provider capability probes and report their freshness.',
    usage: ['sinter capabilities <probes.json> [--max-age-ms <ms>]'],
    example: 'sinter capabilities probes.json --max-age-ms 60000',
  },
  export: {
    summary: 'Package a code file as HTML, JavaScript, or a ZIP archive.',
    usage: ['sinter export <html|js|zip> <code-file> -o <out-path>'],
    example: 'sinter export html sketch.js -o sketch.html',
  },
  fragments: {
    summary: 'Read and search the curated prompt fragment archive.',
    usage: ['sinter fragments <categories|constraint|seed>', 'sinter fragments search <query>'],
    example: 'sinter fragments search contrast',
  },
  memo: {
    summary: 'Save a structured review memo.',
    usage: ['sinter memo -o <file> --by <reviewer> --verdict <approve|revise|reject> --score <0..1> --title <title> "<brief>" --section "<title>|<text>|<priority>"'],
    example: 'sinter memo -o memo.json --by reviewer --verdict revise --score 0.6 --title Study "Color study" --section "Color|Increase separation|high"',
  },
  notation: {
    summary: 'Encode a prompt as Swarm notation or decode notation from a file.',
    usage: ['sinter notation <encode|decode> <file>'],
    example: 'sinter notation encode prompt.txt',
  },
  seed: {
    summary: 'Save, show, or list reusable creative prompts.',
    usage: ['sinter seed save <name> --prompt "<prompt>" [--domain <domain>] [--title <title>]', 'sinter seed <show|list> [name]'],
    example: 'sinter seed save orbit --domain html --prompt "A slow orbit of light"',
  },
  bridge: { summary: 'Start the TUI bridge server.', usage: ['sinter bridge [port]'], example: 'sinter bridge 3000' },
  budget: { summary: 'Show per-endpoint spend caps (~/.sinter/provider-budgets.json).', usage: ['sinter budget status'], example: 'sinter budget status' },
  'campaign-continue': { summary: 'Resume the server-owned governed campaign continuation.', usage: ['sinter campaign-continue [options]'], example: 'sinter campaign-continue' },
  'campaign-owner-decision': { summary: 'Finalize a completed governed owner decision.', usage: ['sinter campaign-owner-decision [options]'], example: 'sinter campaign-owner-decision' },
  'campaign-owner-decision-start': { summary: 'Start a host-sealed governed revision comparison.', usage: ['sinter campaign-owner-decision-start [options]'], example: 'sinter campaign-owner-decision-start' },
  chat: { summary: 'Distill persisted Studio chats into lessons (interactive chat was retired: use sinter studio).', usage: ['sinter chat reflect'], example: 'sinter chat reflect' },
  compact: { summary: 'Reclaim ~/.sinter state (dry run by default).', usage: ['sinter compact [--execute] [--root <path>]'], flags: ['--execute   actually delete', '--root <path>   state root'], example: 'sinter compact --root ~/.sinter' },
  compose: { summary: 'Assemble layers into one composition.', usage: ['sinter compose --prompt "<idea>" [--regenerate-layer <id>]'], flags: ['--regenerate-layer <id>   replace one layer'], example: 'sinter compose --prompt "dusk over a harbor"' },
  composite: { summary: 'Analyze a composition spec and produce a layer plan.', usage: ['sinter composite "<idea>"'], example: 'sinter composite "dusk over a harbor"' },
  compost: { summary: 'Compost Mill: turn rejected work into seeds.', usage: ['sinter compost <add|digest|soup|seeds|status>'], example: 'sinter compost status' },
  conductor: { summary: 'Elixis conductor lane: operator status and manual adherence re-check.', usage: ['sinter conductor <status|recheck>'], example: 'sinter conductor status' },
  consolidate: { summary: 'Retired (exit 2). Use governed Dream transfer and activation.', usage: ['sinter dream transfer <command.json>'], example: 'sinter dream activate command.json' },
  data: { summary: 'Data integrity: snapshot, migrate, domains, rebuild, verify, retention, selftest.', usage: ['sinter data <snapshot|migrate|domains|rebuild|verify|retention|selftest>'], example: 'sinter data verify' },
  demo: { summary: 'Run a demo scenario.', usage: ['sinter demo creative-codex'], example: 'sinter demo creative-codex' },
  domains: { summary: 'List the public mediums or run the creative-domain gauntlet.', usage: ['sinter domains gauntlet', 'sinter mediums check', 'sinter mediums list'], example: 'sinter domains gauntlet' },
  dream: { summary: 'Governed research: run, transfer, activate, autoseal, guard.', usage: ['sinter dream run <command.json>', 'sinter dream transfer <command.json>', 'sinter dream activate <command.json>', 'sinter dream autoseal --judge <id> --out <dir>', 'sinter dream guard --scheduled f --incumbent f --candidate f [--min-gain 0.03]'], example: 'sinter dream activate command.json' },
  emergence: { summary: 'Score or probe emergence for a text or file output.', usage: ['sinter emergence <score|probe> <text-or-file>'], example: 'sinter emergence score out/index.html' },
  entropy: { summary: 'Show the seed and phrase harvested from this project (trend rows, compost heap). best-of uses the phrase to steer its tries apart.', usage: ['sinter entropy'], example: 'sinter entropy' },
  field: { summary: 'Latent field of the artifact store.', usage: ['sinter field [subcommand]'], example: 'sinter field' },
  fix: { summary: 'Auto-fix code issues with LLM assistance.', usage: ['sinter fix <file|description> [--error <text>] [--dry-run] [--confirm auto|ask|never]', 'sinter fix --test-failures [--test-file <path>]'], flags: ['--error <text>', '--test-failures', '--test-file <path>', '--dry-run', '--confirm <auto|ask|never>'], example: 'sinter fix sketch.js --dry-run' },
  fs: { summary: 'Inspect the Sinter content store.', usage: ['sinter fs <artifacts|refs|runs>'], example: 'sinter fs artifacts' },
  gallery: { summary: 'List saved gallery projects with version counts.', usage: ['sinter gallery list [--gallery <dir>]'], flags: ['--gallery <dir>   gallery directory (default ./gallery)'], example: 'sinter gallery list' },
  garden: { summary: 'Autonomous gardener.', usage: ['sinter garden <status|rebalance|start|stop|tend [budget]>'], example: 'sinter garden status' },
  gbg: { summary: 'Glass Bead Game: bead index, cross-domain threads, one move per wave.', usage: ['sinter gbg [--index|--move]'], example: 'sinter gbg --index' },
  git: { summary: 'Git integration.', usage: ['sinter git <status|log|diff|branch|commit|init>'], example: 'sinter git status' },
  'gui-evolve': { summary: 'GUI evolution lane.', usage: ['sinter gui-evolve <subcommand>'], example: 'sinter gui-evolve status' },
  help: { summary: 'Show the global help.', usage: ['sinter help'], example: 'sinter help' },
  hillclimb: { summary: 'Governed hill-climb run.', usage: ['sinter hillclimb run [options]'], example: 'sinter hillclimb run' },
  image: { summary: 'Validate or stage an image attachment.', usage: ['sinter image validate <path>'], example: 'sinter image validate ref.png' },
  improve: { summary: 'Diagnose repair, hardening and optimization proposals.', usage: ['sinter improve <scan|run>'], flags: ['--gates-passed   report improve mode after external gates pass'], example: 'sinter improve scan' },
  islands: { summary: 'Domain-partitioned subpopulations with ring migration.', usage: ['sinter islands [subcommand]'], example: 'sinter islands' },
  'judge-evidence': { summary: 'Learning step: judge evidence rows.', usage: ['sinter judge-evidence [--write-negatives] [--out <dir>]'], example: 'sinter judge-evidence --out out' },
  judge: { summary: 'Compare rendered pieces or select a judging round.', usage: ['sinter judge compare', 'sinter judge --round <2|3> <artifact>'], example: 'sinter judge --round 2 out/' },
  judgment: { summary: 'Governed blind rendered comparison.', usage: ['sinter judgment compare'], example: 'sinter judgment compare' },
  ledger: { summary: 'Telemetry and task ledger.', usage: ['sinter ledger query [--event --role --model --since --limit]', 'sinter ledger <list|show|run|verify|accept|reject|status>'], example: 'sinter ledger list' },
  'legacy-backfill': { summary: 'Learning step: backfill legacy rows.', usage: ['sinter legacy-backfill [options]'], example: 'sinter legacy-backfill' },
  'live-music': { summary: 'Generate a live AV set (Strudel music + Hydra visuals).', usage: ['sinter live-music "<prompt>" [--music-to-visual]'], flags: ['--music-to-visual   derive visuals from the measured music'], example: 'sinter live-music "a slow tide"' },
  mece: { summary: 'MECE inventory and diagnosis.', usage: ['sinter mece <manifest|inventory|diagnose|budget>'], example: 'sinter mece inventory' },
  model: { summary: 'Model assimilation audition.', usage: ['sinter model audition <model>'], example: 'sinter model audition glm-5.3' },
  name: { summary: 'Elixis plates for champions and moves.', usage: ['sinter name'], example: 'sinter name' },
  organism: { summary: 'Inspect or act on shared Studio/CLI causal state.', usage: ['sinter organism <inspect|react|context>'], example: 'sinter organism inspect' },
  persona: { summary: 'Cognitive-style personas per machine.', usage: ['sinter persona [subcommand]'], example: 'sinter persona' },
  phases: { summary: 'Regime changes in the score time series.', usage: ['sinter phases [options]'], example: 'sinter phases' },
  plugins: { summary: 'List the plugins folder and whether the governed gate would admit each plugin (nothing is executed); pin a plugin to its current bytes.', usage: ['sinter plugins status [--plugins-dir <dir>]', 'sinter plugins pin <id> [--plugins-dir <dir>]'], flags: ['--plugins-dir <dir>   default: the plugins folder of the install'], example: 'sinter plugins status' },
  preferences: { summary: 'Preference model.', usage: ['sinter preferences <export|stats|train|model>'], example: 'sinter preferences stats' },
  prompt: { summary: 'Prompt tools.', usage: ['sinter prompt synthesize --input <graph.json>'], example: 'sinter prompt synthesize --input graph.json' },
  'prompt-next': { summary: 'Next prompts from the frontier-directed prompt engine.', usage: ['sinter prompt-next [count]'], example: 'sinter prompt-next 3' },
  provider: { summary: 'Provider setup and key diagnostics.', usage: ['sinter provider <help|list|status>'], example: 'sinter provider status' },
  quality: { summary: 'Quality gate.', usage: ['sinter quality <run|gate>'], example: 'sinter quality run' },
  release: { summary: 'Owner-release truth gate or terminal receipt.', usage: ['sinter release <gate|receipt>'], flags: ['--dry-run   report Level 6 candidate gates without live receipts'], example: 'sinter release gate --dry-run' },
  report: { summary: 'Reports.', usage: ['sinter report <cognition|fitness|provenance|archive|garden|readiness>'], example: 'sinter report readiness' },
  'rerender-reevaluate': { summary: 'Re-render and re-evaluate a product run under a grant.', usage: ['sinter rerender-reevaluate --run-root <abs> --grant <abs grant.json> [--prompt-file <prompt.txt>] [--repo-root <clone>]'], flags: ['--run-root <dir>', '--grant <file>', '--prompt-file <file>', '--repo-root <dir>'], example: 'sinter rerender-reevaluate --run-root /abs/run --grant /abs/grant.json' },
  rescore: { summary: 'Re-score visual archive entries (read-only unless --persist).', usage: ['sinter rescore [--all|--floors] [--domain <list>] [--persist] [--max-provider-calls <n>]'], flags: ['--all   re-score every non-quarantined entry per visual domain', '--floors   re-score the bottom two entries per visual domain', '--domain <list>   restrict to these visual domains', '--persist   write fresh scores back (pause the self-improve daemon first)', '--max-provider-calls <n>   cap judge calls'], example: 'sinter rescore --floors --domain svg' },
  rescue: { summary: 'Salvage rejected generations: mechanical recovery plus bounded LLM repair.', usage: ['sinter rescue [rejects-dir]'], example: 'sinter rescue .omx/atelier/rejects/code' },
  rotate: { summary: 'Cycle generator models per wave and learn which is best per domain.', usage: ['sinter rotate [subcommand]'], example: 'sinter rotate' },
  rotation: { summary: 'Standing rotation batteries.', usage: ['sinter rotation <generator|evaluator|harness|chat|report>'], example: 'sinter rotation report' },
  runtime: { summary: 'Shared runtime projections.', usage: ['SINTER_LIMINAL_RUNTIME_ROOT=<abs> sinter runtime import-projections <run-dir>...'], example: 'sinter runtime import-projections run1' },
  'second-judge': { summary: 'Run the second judge over one piece or a directory.', usage: ['sinter second-judge <artifact-dir>'], example: 'sinter second-judge out/' },
  'self-improve': { summary: 'Self-improvement routing gauntlet.', usage: ['sinter self-improve gauntlet [--live]'], flags: ['--live   run one bounded pass in a sandbox'], example: 'sinter self-improve gauntlet' },
  ship: { summary: 'Garden promotion tier behind a regression gate.', usage: ['sinter ship <garden|rollback>'], example: 'sinter ship garden' },
  site: { summary: 'Living website: seed starter slots, then evolve them.', usage: ['sinter site seed [--slots <n>]', 'sinter site evolve'], flags: ['--slots <n>   number of starter slots'], example: 'sinter site seed --slots 3' },
  'sss-score': { summary: 'Scorecard with two judges minimum (exit 2 on a blank artifact).', usage: ['sinter sss-score <artifact>'], example: 'sinter sss-score out/' },
  studio: { summary: 'Launch the GUI workbench (backend plus browser app).', usage: ['sinter studio'], example: 'sinter studio' },
  swarm: { summary: 'Swarm runs and human gold labels.', usage: ['sinter swarm run --prompt "<prompt>" [--swarm-mode <mode>] [--swarm-rounds N] [--no-label]', 'sinter swarm sessions [--all] [--limit 20]', 'sinter swarm label <sessionId>'], flags: ['--session-dir <path>', '--ledger <path>', '--winner <index|personaId>', '--reveal'], example: 'sinter swarm sessions --all' },
  taste: { summary: 'Train or evaluate the taste model, or import observations and signed owner likes.', usage: ['sinter taste <train|eval|ingest>'], example: 'sinter taste eval' },
  taxonomy: { summary: 'Grow the Elixis taxonomy from the name log.', usage: ['sinter taxonomy [--json|--no-write]'], flags: ['--json', '--no-write'], example: 'sinter taxonomy --json' },
  'third-judge': { summary: 'Run the third judge over one piece.', usage: ['sinter third-judge <artifact-dir>'], example: 'sinter third-judge out/' },
};

export function printCommandHelp(cmd: string, write: (line: string) => void = line => console.log(line)): boolean { // eslint-disable-line no-console
  const e = COMMAND_HELP[cmd];
  if (!e) return false;
  write(`sinter ${cmd}: ${e.summary}`);
  write('');
  write('Usage:');
  for (const u of e.usage) write(`  ${u}`);
  if (e.flags?.length) { write(''); write('Flags:'); for (const f of e.flags) write(`  ${f}`); }
  write('');
  write('Example:');
  write(`  ${e.example}`);
  write('');
  write('Global options and the full command list: sinter --help');
  return true;
}
