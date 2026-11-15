import {
  LiminalCommandService,
  type LiminalCommandResult,
  type LiminalCreativeCommand,
} from '../runtime-core/LiminalCommandService.js';
import { LiminalProductCommandPort }
  from '../runtime-core/LiminalProductCommandPort.js';

/** Public CLI adapter over the authoritative Liminal command composition root. */
export function runLiminalCommandJourney(
  service: LiminalCommandService,
  command: LiminalCreativeCommand,
): Promise<LiminalCommandResult> {
  return new LiminalProductCommandPort(service).submitCreate('cli', command)
    .then(projection => {
      if (projection.kind !== 'create') throw new Error('LIMINAL_CREATE_PROJECTION_INVALID');
      return projection.result;
    });
}
