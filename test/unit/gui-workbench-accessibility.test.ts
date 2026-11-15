import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchor repository-file reads to the test module root, not caller CWD,
// so the test works regardless of which directory vitest was launched from.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const shell = fs.readFileSync(path.join(repoRoot, 'gui/src/components/WorkbenchShell.tsx'), 'utf8');
const app = fs.readFileSync(path.join(repoRoot, 'gui/src/App.tsx'), 'utf8');
const studioConversation = fs.readFileSync(path.join(repoRoot, 'gui/src/gui/studioConversation.ts'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'gui/src/index.css'), 'utf8');
const bridgeHook = fs.readFileSync(path.join(repoRoot, 'gui/src/gui/useTuiBridgeSession.ts'), 'utf8');
// User-facing copy now lives in the typed i18n catalog (en.ts is the source of truth);
// the source files reference it via t('<key>'). Contract assertions therefore check the
// catalog for the copy and the source for the wiring (t() keys + structure + logic).
const en = fs.readFileSync(path.join(repoRoot, 'gui/src/i18n/en.ts'), 'utf8');

describe('GUI workbench accessibility contract', () => {
  it('keeps the workbench navigable and announced for assistive technology', () => {
    expect(shell).toContain('sinter-skip-link');
    expect(shell).toContain('id="workbench-prompt"');
    expect(shell).toContain('htmlFor="workbench-prompt"');
    expect(shell).toContain('aria-describedby="workbench-run-status"');
    expect(shell).toContain('id="workbench-run-status"');
    expect(shell).toContain('aria-live="polite"');
    expect(shell).toContain('aria-busy');
    // Timeline keeps an accessible label, now wired through i18n.
    expect(shell).toContain("aria-label={t('timeline.aria')}");
    expect(en).toContain('Generation timeline');
    expect(app).toContain("stageBusy={bridgeSummary.active || runStatus === 'running'}");
    expect(app).toContain("artifactReady={activeMode.id === 'generate' && hasSyncTarget}");
    expect(bridgeHook).toContain("parsed.type === 'status.updated'");
  });

  it('does not tell users to generate again once a preview is mounted', () => {
    expect(shell).toContain('artifactReady');
    expect(shell).toContain('showGeneratePreviewReady');
    expect(shell).toContain("t('artifact.previewReady')");
    expect(en).toContain('Preview is ready');
    expect(en).toContain('Use the message box to revise, make a variation, or polish this direction.');
  });

  it('keeps the active-run stop control beside the composer instead of hiding it in details', () => {
    expect(shell).toContain('onCancelRun');
    expect(shell).toContain("t('composer.stopAria')");
    expect(en).toContain('Stop active generation');
    expect(shell).toContain('sinter-stop-button');
    expect(app).toContain('onCancelRun={bridgeSummary.active ? () => void bridge.cancelCurrent() : undefined}');
  });

  it('keeps secondary modes available as direct rail controls, not a dashboard or a hidden drawer', () => {
    expect(shell).toContain('sinter-primary-mode');
    // Secondary engine surfaces render as a labelled rail group of direct buttons.
    expect(shell).toContain('sinter-rail-group--secondary');
    // The old collapsible "More tools" drawer (and its open/closed state) was removed —
    // the secondary modes are always reachable as buttons, never force-collapsed.
    expect(shell).not.toContain('secondaryToolsOpen');
    expect(shell).not.toContain('sinter-secondary-tools');
  });

  it('keeps closed navigation drawers from overlapping visible rail controls', () => {
    expect(css).toContain('.sinter-subnav--drawer:not([open]) > .sinter-subnav__body');
    expect(css).toContain('display: none');
  });

  it('keeps internal process receipts out of the default preview panel', () => {
    expect(app).not.toContain('sinter-stage-process');
    expect(app).not.toContain('sinter-human-review-strip');
    expect(app).toContain('Manual Review Pack');
  });

  it('does not surface stale EventSource disconnects from replaced sessions', () => {
    expect(bridgeHook).toContain('disconnectCurrentSource');
    expect(bridgeHook).toContain('sourceRef.current !== es');
    expect(bridgeHook).toContain('es.readyState !== EventSource.CLOSED');
    expect(bridgeHook).toContain('!opened');
  });

  it('wraps long inspector receipts and review details inside the right rail', () => {
    expect(css).toContain('.sinter-inspector-grid small,');
    expect(css).toContain('.sinter-review-panel small');
    expect(css).toContain('overflow-wrap: anywhere');
    expect(css).toContain('grid-template-columns: minmax(0, 0.7fr) auto');
  });

  it('keeps sandboxed preview iframes from delegating sensor permissions', () => {
    expect(app).toContain(`const SENSOR_PERMISSION_POLICY = "accelerometer 'none'; gyroscope 'none'; magnetometer 'none'";`);
    expect(app).toContain('allow={SENSOR_PERMISSION_POLICY}');
    expect(app).not.toContain('allow="accelerometer;');
  });

  it('shows a visible recovery state when an inline image preview fails to load', () => {
    expect(app).toContain('failedPreviewSrc');
    expect(app).toContain('sinter-stage-preview-error');
    expect(app).toContain('role="alert"');
    expect(en).toContain('Image preview failed to load');
    expect(app).not.toContain("event.currentTarget.style.display = 'none'");
  });

  it('shows visible recourse when a generation run fails before preview', () => {
    expect(shell).toContain('recourseSlot');
    // Work log is open whenever a run is active or recovery is showing.
    expect(shell).toContain('showRecovery = Boolean(recourseSlot)');
    expect(shell).toContain('(stageBusy || showRecovery)');
    expect(en).toContain('No preview was produced');
    expect(en).toContain('needs recovery');
    expect(app).toContain('sinter-recourse-card');
    expect(app).toContain('runFailedBeforePreview');
    expect(en).toContain('That run did not finish.');
    expect(en).toContain('Try again');
    expect(en).toContain('Polish safely');
    expect(en).toContain('Switch medium');
    // The "Switch medium" action label must not stutter ("browser visual browser visual").
    expect(app).toContain('browser visual(?:\\s+browser visual)+');
    expect(css).toContain('.sinter-recourse-card');
    expect(css).toContain('overflow-wrap: anywhere');
  });

  it('passes the visible loop timeout into every Studio Generate submission', () => {
    const studioSubmissionSources = `${app}\n${studioConversation}`;
    expect(studioSubmissionSources.match(/buildWorkbenchRunOptionsForMode\([^)]*timeoutMinutes/g)?.length).toBe(6);
    expect(app).not.toContain('buildWorkbenchRunOptionsForMode(createExecutionMode, createMaxIterations, effectiveCreateMode),');
    expect(app).not.toContain("buildWorkbenchRunOptionsForMode('draft', createMaxIterations, retryMode),");
  });

  it('keeps operator-stopped runs visible with retry recourse instead of resetting to ready', () => {
    expect(bridgeHook).toContain('cancelledRunEventFromStatus');
    expect(bridgeHook).toContain("type: 'generation.cancelled'");
    expect(bridgeHook).toContain("reason: 'operator-stop'");
    expect(bridgeHook).toContain('await refreshStatus()');
    expect(app).toContain('runStoppedBeforePreview');
    expect(app).toContain("runReceipt?.outcome === 'stopped'");
    expect(app).toContain("runReceipt?.outcome === 'stopped' ?");
    // Stopped-run copy is wired through i18n in both App and the shell work log.
    expect(app).toContain("t('artifact.stopped')");
    expect(app).toContain("t('recovery.stoppedByOperator')");
    expect(shell).toContain("t('log.stopped')");
    expect(en).toContain('Generation stopped');
    expect(en).toContain('Generation stopped by operator.');
  });

  it('keeps reduced-motion and visible preview-status fallbacks in CSS', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('animation: none');
    expect(css).toContain('scroll-behavior: auto');
    expect(css).toContain('sinter-stage-empty--blocked');
  });
});
