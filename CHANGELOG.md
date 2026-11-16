# Changelog

All notable changes to this project will be documented in this file.

## [2.5.0] - 2026-11-15

User-facing changes merged since 2.4.0 (#1482–#1535, 2026-11-14).

### Added

- Reverse mode takes any reference. `sinter generate` and `sinter compose` accept `--ref`, `--arc`, `--duration` and `--cues`: audio, image, video, SVG diagrams, storyboards, mood boards and text each become a feature card, and the cards plus an energy arc steer the piece. The run writes a `reverse-provenance.json` (#1508, part of #711).
- Tone and Strudel pieces fit an exact `--duration`. The piece is rendered and measured (length within 50 ms, a final hit, envelope against the arc, ending decay), then revised once if it misses; the measured fit goes into the provenance file (#1509, closes #711).
- Sinter has a Blender domain: the model writes a `bpy` script, Sinter renders it headless in a locked-down subprocess and judges the PNG like the other visual domains. It has not yet been run against a real Blender install, so treat it as unverified until it has (#1507).
- SVG pieces can be generated as page-ready fragments bound to host CSS tokens: `--output-mode fragment --tokens ... --container WxH --motion ...`. Standalone SVG output is unchanged (#1504, part of #1162).
- `sinter sss-score` reads its second vision eye from `~/.sinter/config.json`; the default is unchanged (#1482).

### Fixed

- Long reasoning calls no longer die at 300 s with a bare "fetch failed"; provider timeouts are honored, and a timed-out evaluator run is marked unscored instead of scored (#1506, #708, #709).
- Concurrent `sinter generate` runs on different keys no longer block each other, the same key still runs once, and the shared store no longer loses updates between processes (#1503, #707).
- `sinter live-music` and `sinter fix` run their provider calls under a journal-reserved grant, like `compose` (#1505, #710).
- Sing's microphone no longer prompts twice, can be cancelled while starting, survives a quick restart, and offline renders find ffmpeg on Linux (#1512).
- SVG pieces can only reference their own `#id` fragments; `file:` and relative `href`/`src` values are rejected (#1514).
- Swarm voting calibration no longer loses updates when two processes share the ledger (#1518, #1295).
- File operations report errors instead of swallowing them in compaction, backup, preferences, SinterFS persistence and state resets (#1519, #1525, #1529), and a SeedBank load race is closed (#1517).
- Writing tests for 16 more modules exposed and fixed real bugs (#1531).

### Security and safety

- LLM-generated art code now runs behind one AST-based guard instead of a regex denylist. It blocks prototype pollution, window and document reach, `eval` and `Function` by alias, and `__proto__` literals, and `eval` and `new Function` are lint errors elsewhere (#1527).
- The public mirror publishes a snapshot with no private history, never force-pushes, and refuses to push unless the public CI command passes on the sanitized tree (#1534, #1536, #1538).

### Internal

- Public CI for the `s1ntr` snapshot, a merge-safe split of the shared ledger and registry, a CI gate that names the stalled step, and the TUI bridge split into modules (#1535, #1522, #1521, #1530).
- 460+ weak assertions replaced with exact values, silent-pass test suites now run against a recorded provider, and dozens of previously untested modules covered (#1511, #1513, #1515, #1516, #1520, #1523, #1524, #1526, #1528, #1531, #1532).

## [2.4.0] - 2026-11-14

The QA-stack release: user-facing changes merged since 2.3.0, including the 18-PR QA stack (#1484–#1501).

### Fixed (QA stack, 2026-11-14)

- Sing shows microphone, camera and recording failures instead of failing silently, stops cleanly, and keeps each recording's real format through download and offline export (#1485, #1489, #1500).
- The gallery builders check their inputs before building, keep the previous output when a build fails, and refuse to write through traversal paths, symlinks or hard links (#1486, #1488).
- The gallery keeps keyboard focus on a visible work while it rotates; focusing a work's details pauses rotation (#1501).
- Shader and Three.js pieces start and swap transactionally, so a failed replacement no longer leaks resources or leaves a stale frame running (#1490).
- Three.js pieces that use `new THREE.Mesh(` render again; a rewrite had turned their code invalid and the error was hidden, leaving a blank scene (#1490).
- Atelier rejects malformed or incomplete transport results instead of accepting them (#1491).
- Security events keep their trusted type, severity and timestamp, and SIEM forwarding recovers after a successful delivery, even when sends finish out of order (#1487, #1493).
- Chat reports a failed suggestion while generation continues, without exposing raw provider errors (#1494).
- Seed archives keep their identity, reject malformed data, and report read failures other than a missing file (#1495, #1496).
- The Grok evaluator fails the request instead of crashing when the Grok process closes its input early (#1486).
- The post-checkout hook reports exact worktree paths safely (#1499).

### Tests

- Stronger result and contract assertions across storage, telemetry, Promise adapters and tool payloads; obsolete test-quality baseline entries removed (#1484, #1492, #1497, #1498).

### Added

- Swarm operators can run, list and label sessions, and gold labels persist across sessions (#1470).
- The npm package is published as `s1ntr` (#1483), and the approved S1NTR icon ships (#1441).

### Security and safety

- Every full page carries its medium's network policy, the preview server answers on loopback only, and URL fetches pin the addresses they checked (#1468, #1469).
- The spend cap stops every provider adapter, and the CLI refuses short unquoted bare words instead of starting a paid generation (#1469).
- Studio reads require auth, archive writers no longer erase each other, shipped browsers keep Chrome's sandbox, and the package ships no owner host names or addresses (#1463–#1468).
- Stop now silences Tone pieces, and live works on the stage can be stopped and played from the keyboard (#1468, #1469).
- Swarm voter calibration ignores heuristic self-votes (#1471).

### Earlier fixes since 2.3.0

This part was written on 2026-11-11 and summarizes changes merged since August 28, 2026.

### Fixed

- Audio pieces now capture sound at the output destination, so previews and scoring can measure the audio the piece actually produces (#1446).
- Local LFM3 models now return their final answer without exposing reasoning text, in both regular and streamed responses (#1447, #1451).
- Short, complete Strudel patterns now pass validation; valid compact pieces no longer fail a length check (#1448).
- Three.js pieces render again in embedded previews (#1453).
- Judges no longer score the Revideo stand-in preview as if it were the rendered video; the result says the scene was not rendered (#1457).
- Explicit token caps now limit a request without being raised to a generator's default (#1452).
- Sinter's GUI typecheck errors are cleared and the fast CI gate now checks GUI types (#1449, #1454); provider environment variables no longer leak between tests (#1450).

### Improved

- Strudel and Tone.js playback now capture real audio, including Strudel's sample bank and common tempo chains (#1118–#1124, #1446).
- Explicit domain selection now reaches generation, and more registered domains participate in routing (#997, #998, #1111, #1112).
- SVG output can be embedded as a fragment in a host page (#1430).
- The npm package includes vendored runtime assets needed by installed Sinter builds (#1444).
- Local LFM3 models have explicit capability metadata, including for decision-model use (#1427).

### Changed

- A `.env` in the folder you run `sinter` from now only supplies API keys, model names and the log level. Other names are ignored with a warning; set `SINTER_TRUST_DOTENV=1` in your shell to load the whole file.
- The Studio server rejects foreign host names and compares access tokens in constant time (#1445). A saved Studio key is discarded when a save moves to another endpoint (#1443).
- `sinter studio` requires a repository checkout with dependencies installed.
- `THIRD_PARTY_NOTICES.md` now lists every vendored runtime asset with its license, and ships in the package (#1456).

### Version consistency

- `config/sinter.json` and the gallery footer still said 2.2.0 after the 2.3.0 release. The footer now reads `package.json`, and `validate-version.js` also checks `config/sinter.json` and `SINTER_VERSION`, so this drift fails the pre-commit hook.

### Docs

- README, llms.txt, AGENTS.md, HANDOFF.md and the waves entry point now describe 2.3.0: Hermes CLI seats, the real audio meter, known issues and the Blender next step.

## [2.3.0] - 2026-11-10

Pause point after the Hermes model matrix: every seat can now generate and
judge through Hermes, and the pages Sinter produces show what they really do.
About 1,400 commits since 2.2.0; the highlights are below, and the dated
sections that follow are the backfilled detail.

### Highlights

- **Seven models through Hermes.** DeepSeek V4.1 Flash, GPT-6 Luna,
  GPT-6.1 Terra and Sol, Sonnet 5.5, Opus 5.5 and Fable 5.2 each generated
  and judged real pieces across 15 domains through the Hermes seat (#1436).
- **Music pages show the real sound** (#1437). Strudel and Tone.js pages
  draw a live spectrum and waveform from the actual audio output, and the
  meter reads "silent" when nothing plays, replacing a clock-driven
  animation that moved whether or not any sound came out.
- **Shaders get their uniforms.** Bare `time`/`resolution` uniforms are
  mapped onto what the page feeds, so those shaders draw instead of
  rendering black (#1436).
- **Decision models.** LFM3 model kinds and a d1 decision head at every
  seat; d1 can screen candidates at the evaluator seat (#1427).
- **Embeddable SVG fragments** for host pages (#1162).
- **CI fails visibly** and reruns only failed files once (#1429).

### Removed

- `CodexProvider` (no callers; the Codex seats run through Hermes).
- `ResilienceGuardrail` (never opened) and four sample-data visualization
  pages (#1429).

### Known issues

- A judge can score a music piece without hearing it: one matrix Strudel
  piece crashed before playing (it calls an undefined `bpm()`) and still
  scored 0.77. The new meter makes this visible; the judge does not yet
  use it.
- The `sss-score` vision eye is hardcoded to MiniMax-M3 (tracked).

### Changed — 2026-08-28 closure behavior

- **2026-08-28:** The loop runbook now distinguishes one standing-loop
  lineage from its parallel worker children, documents `WORKERS` and
  `parallel-loop.sh`, and names each worker's lock.
- **2026-08-28:** The coding-plan seat and qwen identity laws were hardened;
  the CLI generation path now exposes its injected teaching through
  `systemPromptHead`.
- **2026-08-28:** Strudel artifacts now use the playable web engine, while
  audio scoring rejects silent pieces and the outage failover remains
  fail-safe.

> Backfill scope: 2026-08-25 → 2026-08-27 on `ticket/w8c-closure` (the
> atelier / SSS+ flywheel sprint). Wave-10 history between 2.2.0 and this
> window is not yet backfilled.

### Added — Atelier SSS+ flywheel (unsupervised self-improvement)

- **SSS+ system loop**: unsupervised runner cycling generate → score →
  compost → lesson-refresh; GUI flywheel waves 1+2 made recursive
  self-improvement live.
- **`sinter sss-score <playable.html | artifact-dir>`**: the SPU-1.1 universal
  scorecard as a command. Levels are COMPUTED from gate arithmetic, never
  asked of judges; axes D craft / A artistic / R reliability / N novelty on
  the anchored `(v−1)/4×100` scale (CEO correction). Three-vendor vision-judge
  ensemble — gemini-3.7 via router, minimax-m3, glm-5.3-flash ("third eye").
  Temporal probe adds stability / flicker / jank / fps evidence no still can
  show. TEETH contract: a blank or near-blank screenshot is a hard failure —
  exit 2 `SSS_SCORE_BLANK_ARTIFACT` — and the browser is a resolved portable
  chromium (`--no-sandbox`) so linux servers score too.
- **EloTable**: pairwise Elo ladder over artifacts and lessons — research says
  head-to-head beats absolute scoring under judge noise; every same-domain
  scorecard pair updates ratings, and the ladder feeds exemplar selection.
- **LessonBandit**: composite lesson-selection engine — per-lesson Beta
  posteriors updated from lesson-set outcomes with Monte-Carlo Shapley credit,
  Thompson-sampled subsets, credibility-gated promotion; bounded ablation went
  live through `selectLessons` with an A4 kill-switch.
- **SinterGym**: Gymnasium-shaped RL environment over the flywheel; replay
  mode trains policies offline from logged turns at zero model cost.
- **Evolution + curriculum**: genome staging with an A/B graduation gate
  (lessons must win an arm-race to become system state); epsilon-greedy
  frontier curriculum (70% of turns on the domain nearest S-rank — CEO law:
  S+ table stakes everywhere); niche direction picks the least-used aesthetic
  seed per domain; exemplar grounding anchors every generation prompt on
  best-per-domain work (RAFT closure); every 4th turn polishes the domain-best
  instead of generating fresh; new domain-bests auto-open a before/after
  "improvement shower".
- **SSS+ system-lessons channel**: scorecard defects compound into generation
  rules at runtime (deterministic A/B arms).
- **FrugalGPT escalation lane**: hard-domain validation failure retries once
  on GLM (config-loaded, static imports).
- **Docs**: LEARNINGS (12 laws from 22 bugs) and the loop operations runbook.

### Changed — GLM coding-plan seat lane + identity laws

- **Coding-plan seat law**: the `glmCodingPlanSeat` role flag routes a role
  over the owner-authorized z.ai coding-plan seat; provisioning remains
  `sinter provider provision-glm-coding-plan` and fail-closes without
  `--confirm-owner-authorized-subscription`. Sol-reviewed security laws:
  A005 — seat requires the exact endpoint + verified binding and exact-match
  model equality with the requesting model; A006 — <fleet-node> offline funding
  restricted to owner-authorized free routes. Per-attempt funding envelopes
  and an owner-review primary-allocation fix shipped in the same closing
  batch.
- **Fallback inheritance (A003)**: fallback transports whose base URL is the
  exact coding-plan endpoint inherit the seat flag, classifying as
  `glm-coding-plan-seat` instead of dying on glm-direct metered evidence;
  linux hosts resolve the seat credential from a 0600 owner-only file (no
  macOS keychain on servers).
- **Identity hardening**: NaN expiry guard + identity-divergence guard
  (P14 senior round); role-aware key preflight, qwen identity, help routing.
- **Teaching reaches the CLI**: the generate path no longer sends empty system
  prompts — hints + lessons inject into the orchestrator's llm caller
  (hydra forbidden-method errors vanished as proof); reasoning-capture was
  rewired into the live generation path after being orphaned since a past
  refactor.
- **Hydra unlocked**: the runtime contract was one thin sentence — the full
  API law (sources, chain methods, no-JS-math, `.out()` required) produced the
  first valid hydra artifact; animation time-law fix and a compile-don't-execute
  syntax gate at validation; SwiftShader WebGL flags unlock shader/3D scoring
  (the blank-artifact class dies).

### Fixed

- Compost: bounded the DB lock wait — operator commands no longer hang during
  live campaigns (A001).
- PR #879 criticals: SPU unit mismatch (below-S was unconditional), portable
  bridge roots, stable cycleId, honest gates + two-page pairwise.
- Spine/server lane: generator client built without api key/seat flag
  classified unknown and funded fail-closed; explicit-config default clients
  raced async resolution; seat credentials now come from the config file;
  spine helper hoisted to module scope.
- Minimax eye was blind to images (anthropic image block); ESM `require()`
  bug killed the lesson loader in dist; fallback-chain ordinal normalization;
  bridge f-string JS-brace escaping; studio end-to-end Create blockers.
- Bandit/Elo durability: Elo `apply()` never persisted; bandit record moved
  after AXES/DOMAIN/ARM assignment; hysteresis flipped to trip the kill-switch
  only on promote↔demote swaps; genome undefined in the generated select
  script.

## [2.2.0] - 2026-07-25

Sinter V1 go-live (wayfinder map #321): conversational art workshop.
Artifact-carrying revisions (W1), retired dead liminal chat (W2), UI honesty
+ provider truthfulness (W3), raw-score fitness gating (W4), 14-domain
vision-graded beauty campaign (W5), three/p5/glsl/hydra fixes (W6), learning
loop restored (W7). Post-release: #350 leftovers, #351 final-qa hang fix,
#352 identity/docs freshness.

### Added — Dual Video Frameworks (PR #391)
- **RevideoRenderer**: Rewritten to use in-process `renderVideo()` from `@revideo/renderer` (replaces broken CLI shell-out). Proper project scaffolding with npm install, try-catch cleanup, duration parsing from `yield* waitFor(N)`.
- **HyperFramesRenderer**: New renderer for HTML+GSAP asset compositing via `createRenderJob`/`executeRenderJob` from `@hyperframes/producer`. Asset injection with `file://` URL conversion for headless browsers.
- **VideoPipeline**: Multi-step orchestrator that chains Revideo→HyperFrames (generative output becomes compositing asset input).
- **VideoCapabilityDetector**: ESM-compatible startup detection via `createRequire(import.meta.url)`.
- **HyperFramesGenerator**: LLM code generator for HTML+GSAP compositions with `canHandle()` routing (promo, slideshow, overlay patterns) and generative keyword guard (particles, fractals → Revideo).
- **HyperFramesValidator**: Validates GSAP timeline structure, blocks React/@revideo/p5/video.play() patterns.
- **Exporter wiring**: Routes by domain ('revideo'/'hyperframes') with capability checks before render.
- **registerGenerators wiring**: `hyperframesConfidence()` helper, mutual exclusion with revideo via generative keyword guard.
- **uuid override**: Forces `uuid@^14.0.0` to fix transitive vulnerability from `@revideo/ffmpeg`.
- Optional dependencies: `@revideo/*` (^0.10.4), `@hyperframes/producer` (^0.4.3).

### Added — Self-Hosting Task Ledger (Phase 9–10)
- `src/ledger/` — Complete task management system with corpus, runner, and verifier
- TaskRunner: Executes tasks from corpus with shell-free security (`execFileSync`)
- TaskVerifier: Validates results with metacharacter guard + prefix whitelist
- Task corpus: Curated task definitions with approval workflow
- CLI: `liminal ledger list|show|run|verify|accept|reject|status`
- Autonomous development conveyor: Phase 10 pipeline for self-directed task execution

### Added — LiminalFS (Filesystem Substrate)
- `src/fs/` — Unified filesystem facade over ProjectStore, EventStore, AssetStore
- SeedFSAdapter, TraceFSAdapter, GalleryFSAdapter: Bridge existing modules to LiminalFS
- LoopPersistence: RalphLoop writes generation runs to LiminalFS
- OrganismLoop: Wired to LiminalFS for persistent organism state
- CLI: `liminal fs artifacts|refs|runs` subcommands

### Added — Guardrails M12–M18
- Compliance guardrails layer (correctness, hygiene, observation, remediation)
- `src/guardrails/` restructured into domain-specific subdirectories
- 7 new guardrail rules covering runtime health, accessibility, and semantic checks

### Added — Thinking-Trace Feedback Loop
- ReasoningCapture: Extracts model thinking from LLM responses
- ThinkingSeparation: Keeps generator and harness thinking in separate namespaces
- MetaHarnessIntegration: Analyzes generator thinking to improve prompts and routing
- ModelBehaviorPatterns: Long-term pattern detection across sessions

### Added — DF3 Phases 6–8
- Intuition scoring dimension (`--intuition` flag)
- Entropy measurement for generation diversity
- Evolution-based generation improvement

### Changed
- Structured logger replaces console.log throughout harness and core modules
- CI pipeline optimized: removed setup-node, enabled caches, switched to thread pool
- Bubble Tea TUI is now the primary interactive interface
- Coverage ratchet targeting 70% across all metrics (currently ~68.6% statements)

### Fixed
- repairAdvice dropout in multi-candidate RalphLoop evaluation
- Strudel regex typo causing false validation failures
- Candidate telemetry using filtered-array position instead of original index
- `rankCandidates` crash on empty evaluations
- SQLite runtime DB accidentally tracked in git

### Removed
- Archaeology pipeline extracted to separate `dev-archaeology` repo
- Stale root-level audit reports moved to `docs/internal/`

---

## [2.1.0] - 2026-04-01

### Added — Meta-Harness (Self-Improving Infrastructure)
- FailureLogger: Captures all failures with rich context (model, domain, prompt, error, thinking)
  - Auto-saves to `~/.liminal/failures/{id}.json`
  - FailureRecord schema: id, timestamp, sessionId, model, domain, prompt, code, error, errorType, validationErrors, thinking, duration
- PatternDetector: Analyzes failures to detect recurring patterns
  - 6 known patterns from dogfooding: qwen-thinking-trap, glsl-undefined-function, tone-hallucinated-api, strudel-tidal-confusion, ascii-timeout, html-404-error
  - Pattern interface with detector functions, occurrence tracking, affected models/domains
- HarnessUpdater: Applies adaptations based on detected patterns
  - Automatic adaptation tracking with HarnessAdaptation interface
  - Report generation with harnessUpdater.generateReport()
- Exports via `src/harness/index.ts`: failureLogger, patternDetector, harnessUpdater

### Added — Model-Specific Adaptations
- Qwen model detection and simplified prompts
  - Auto-detects Qwen models via model name matching
  - Uses simplified system/user prompts to avoid "thinking trap"
  - Extracts code from thinking field if response is empty
- Ollama native API support
  - Added `apiStyle: 'ollama'` config option
  - Bypasses OpenAI-compatible endpoint issues
  - Direct `/api/generate` endpoint usage

### Added — Domain Validation Enhancements
- GLSL semantic validation
  - Catches undefined functions (noise, fbm, hash without definitions)
  - Detects invalid operators (`%` instead of mod())
  - Function call vs definition tracking
- Tone.js API whitelist validation
  - Validates Tone.* class names against known API
  - Catches hallucinated classes (Reverberator, DrivingPattern, ReverbNode)
  - Suggests closest valid class names
- Strudel prompt with working examples and anti-patterns
  - 5 working code examples
  - Anti-patterns section: NEVER use Haskell `$`, NEVER write `d1 $`, NEVER bare `s("bd")`
  - Distinguishes Strudel JavaScript from TidalCycles Haskell

### Changed — Generator Architecture
- **BREAKING**: Removed all template fallbacks from P5Generator
  - Deleted: ParticleSystem, CellularAutomata, FlowField templates
  - P5Generator now forces LLM path exclusively
  - All p5 generation uses P5GeneratorLLM with model-specific prompts
- Raised confidence scores for domain routing
  - three.js: 0.5 → 0.95
  - strudel: 0.6 → 0.95
  - Prevents misrouting to generic generators

### Fixed
- Qwen3.5 family complete failure on complex prompts
  - Root cause: "thinking trap" consuming all tokens without outputting code
  - Solution: Simplified prompts for Qwen models
- ASCII generator 404 errors on some models
- HTML generator endpoint routing issues
- GLSL generator using undefined noise functions
- Tone.js generator hallucinating non-existent APIs
- Strudel generator confusing TidalCycles vs Strudel syntax

### Documentation
- Added comprehensive Meta-Harness section to architecture docs

---

## [0.2.0] - 2026-03-29

### Added — LIR Evaluation Integration
- GeneratedCodeParser: wraps CodeParser for ephemeral generated code parsing into LIRCodeToken[]
- lirEnabled flag in LoopOptions, cascading to compost config when set
- AestheticCritic dual-path: LIR-aware critique when lirTokens available, regex fallback otherwise
- CreativeEvaluator.assessWithLIR(): overlays LIR metrics (LOC, complexity, nesting, call graph) on regex baseline
- ScoringEngine and AestheticStrategy thread lirContext through evaluation pipeline
- RalphLoop wires GeneratedCodeParser after code generation, passes LIR context to all critics

### Added — Enhanced Evolutionary Engine
- FitnessCombiner: multi-axis weighted fitness (novelty 40%, quality 30%, technical 20%, diversity 10%)
- MAP-Elites N-dimensional: upgraded from 2D to N-dim quality-diversity optimization
- PerlinNoise utility: gradient noise for natural parameter variation in evolutionary search

### Added — Voice + Audio Pipeline
- VoiceToShapeMapper: energy->radius, pitch->height (semitone log scaling), onset->radial bump
- PitchColorMapper: 12 pitch classes -> 30 degree chromatic-circle hue steps, 8 scale palettes, quantization
- FormantAnalyzer: MFCC-based F1/F2 estimation, phoneme-to-geometry mapping
- PitchDetector: autocorrelation F0 with pre-emphasis and Hann windowing
- BPMKeyDetector: onset autocorrelation tempo detection, Krumhansl-Schmuckler key detection
- AudioToVisualMapper updated: pitch-class palettes, formant complexity, tempo/composition mapping

### Added — Music Theory Engine
- EuclideanRhythm: Bjorklund's algorithm for polyrhythmic pattern generation
- MarkovChain: order 1-4 transition matrix melody generation from seed melodies
- TheoryEngine: 14 scales, 7 chord types, MIDI conversion, quantization, diatonic progressions
- Arpeggiator: 5 modes (up/down/upDown/downUp/random) with configurable params
- RhymeEngine: vowel-group-based rhyme classification and scoring
- SyllableCounter: syllable constraint validation for lyric generation
- StructureTemplates: 5 song structure templates (pop/rap/ballad/punk/singer-songwriter)

### Added — Prompt Architecture + Creative Intelligence
- Evaluation prompt: 5-dimension scoring with anti-hallucination
- Chat prompt: creative coding assistant with grounding rules and structured JSON responses
- Design prompt: CLARIFY/DELIVERY modes with performance constraints
- CreativePreferenceExtractor: keyword-based style/color/technique extraction
- AmbiguityDetector: 4 detection strategies
- CrossDomainCrossover: bidirectional technique transfer between domains
- SymbolicCreativeLanguage: emergent vocabulary with effectiveness tracking

### Added — Multi-Agent Creative Critique
- CreativeBoard: 3-agent heuristic deliberation panel (Minimalist/Expressionist/Technician)
- EvaluationMemo: builder-pattern structured evaluation reports
- CreativeEvaluator.assessWithBoard(): blends 60% baseline + 40% board aggregate score

### Added — Smart Routing + Circuit Breaker
- CircuitBreaker: provider failover with closed/open/half-open state machine
- QualityPredictor: heuristic model routing based on prompt complexity and domain history
- BatchProcessor: generic queue-based processor with concurrency control and retry support

### Added — Supporting Creative Features
- ColorTheoryEngine: 7 harmony rules
- GlitchEffects: p5.js glitch effect code generation
- ProgressiveDesignTiers: 5-tier progression with score thresholds
- StyleBlender: weighted style profile mixing with interpolation
- CreativeConstraints: web/mobile/print constraint presets
- CreativeWorkflow: 4-stage pipeline (gather/plan/create/refine)

---

## [0.1.0] - 2026-03-29

### Added
- Voice/singing audio input pipeline (Meyda + pitchfinder)
  - AudioAnalyzer orchestrator chaining extract, pitch detection, timbre extraction
  - AudioToVisualMapper mapping audio features to visual parameters
  - Audio feature types (AudioFeatures, PitchData, TimbreData, AudioAnalysisResult, VisualMappingParams)
  - Pitch utility functions (frequency/MIDI/note name conversion, frequency clamping)
- Aesthetic guardrails system (4 static critics + orchestrator)
  - ColorHarmonyCritic: hex/rgb/hsl/named color extraction, harmony analysis
  - LayoutCritic: canvas dimension extraction, position validation, centering detection
  - TypographyCritic: font size bounds, unloaded font detection
  - SoundHarmonyCritic: frequency extraction, interval consonance, gain warning
  - AestheticCritic orchestrator running all critics with aggregated scoring
  - AestheticStrategy ScoringStrategy plugin for ScoringEngine
  - 5 preset profiles: minimalist, vibrant, cinematic, playful, free
- RalphLoop integration: aesthetic quality gate applies score penalties and violation feedback
- LoopConfig extensions: useAestheticGuardrails, aestheticConfig, visualMappingParams options
- ContextBuilder: audio-derived visual parameter injection into generation context
- CLI flags: --voice, --voice-file, --aesthetic, --aesthetic-config
- Prompt library entries: audio.voice-to-visual, aesthetic.constraints
- CreativeBrief extensions: audioPreference, designConstraints, visualParameters fields
- InterviewPhase: audioPreference + aestheticPreset discovery questions
- Domain type extended with 'voice'
- Barrel exports for all audio and aesthetic modules from src/index.ts
- Dependencies: meyda, pitchfinder
