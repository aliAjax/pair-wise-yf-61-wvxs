import { createAction, props } from '@ngrx/store';
import type { FirmwareDependency, ReleaseBatch } from './release.models';

export const createBatch = createAction('[Release] Create batch', props<{ batch: ReleaseBatch }>());
export const approveBatch = createAction('[Release] Approve batch', props<{ id: string; actor: string }>());
export const pauseBatch = createAction('[Release] Pause batch', props<{ id: string; actor: string }>());
export const resumeBatch = createAction('[Release] Resume batch', props<{ id: string; actor: string }>());
export const retryBatch = createAction('[Release] Retry batch', props<{ id: string; actor: string }>());
export const rollbackBatch = createAction('[Release] Rollback batch', props<{ id: string; actor: string }>());
export const telemetryTick = createAction('[Release] Telemetry tick');

export const addDependency = createAction('[Release] Add dependency', props<{ dependency: FirmwareDependency; actor: string }>());
export const updateDependency = createAction('[Release] Update dependency', props<{ id: string; changes: Partial<Omit<FirmwareDependency, 'id' | 'revision'>>; baseRevision: number; actor: string }>());
export const removeDependency = createAction('[Release] Remove dependency', props<{ id: string; actor: string }>());
export const simulateConcurrentEdit = createAction('[Release] Simulate concurrent edit', props<{ id: string; actor: string }>());
export const clearConflict = createAction('[Release] Clear conflict');
