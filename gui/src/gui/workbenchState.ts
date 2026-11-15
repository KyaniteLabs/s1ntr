export type WorkbenchModeId = 'showcase' | 'generate' | 'improve' | 'review' | 'evolve' | 'observe' | 'settings' | 'campaign';

export interface WorkbenchMode {
  id: WorkbenchModeId;
  label: string;
  legacyTabs: string[];
  /**
   * Operator / observability surface (self-improve scan, MAP-Elites curator, compost
   * evolution viz, telemetry cockpit). These are the engine's internals, not the
   * creative product — hidden from the user GUI unless operator mode is on
   * (?operator in the URL or localStorage 'sinter.operator'='1'). The CLI is the
   * primary operator substrate; this keeps them reachable without cluttering the studio.
   */
  operator?: boolean;
}

// User-facing order: Create is the whole app and the default landing; Gallery is your
// saved work; Settings is the key + language. The operator surfaces follow, hidden by default.
export const WORKBENCH_MODES: WorkbenchMode[] = [
  { id: 'generate', label: 'Create', legacyTabs: ['create', 'liveMusic'] },
  { id: 'campaign', label: 'Campaign', legacyTabs: ['campaign'] },
  { id: 'showcase', label: 'Gallery', legacyTabs: ['showcase'] },
  { id: 'settings', label: 'Settings', legacyTabs: ['config'] },
  { id: 'improve', label: 'Improve', legacyTabs: ['improve'], operator: true },
  { id: 'review', label: 'Review', legacyTabs: ['live', 'curator'], operator: true },
  { id: 'evolve', label: 'Evolve', legacyTabs: ['compost'], operator: true },
  { id: 'observe', label: 'Observe', legacyTabs: ['activity'], operator: true },
];

export function getWorkbenchMode(tab: string): WorkbenchMode {
  return WORKBENCH_MODES.find((mode) => mode.legacyTabs.includes(tab)) ?? WORKBENCH_MODES[0];
}

/** Modes shown in the user GUI. Operator surfaces appear only when operator mode is on. */
export function getVisibleModes(showOperator: boolean): WorkbenchMode[] {
  return WORKBENCH_MODES.filter((mode) => showOperator || !mode.operator);
}

/** True when the operator/observability surfaces should be exposed in the GUI. */
export function isOperatorMode(): boolean {
  try {
    if (new URLSearchParams(window.location.search).has('operator')) return true;
    return window.localStorage.getItem('sinter.operator') === '1';
  } catch {
    return false;
  }
}

export function shouldRenderLegacyPanel(tab: string): boolean {
  return tab !== 'create' && tab !== 'improve';
}
