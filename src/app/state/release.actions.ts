import { createAction, props } from '@ngrx/store';

export const createBatch = createAction(
  '[Release] Create batch',
  props<{ input: { name: string; firmware: string; rollbackVersion: string; groupId: string; rolloutPercent: number; failureThreshold: number }; actor: string }>()
);
export const approveBatch = createAction('[Release] Approve batch', props<{ id: string; actor: string }>());
export const pauseBatch = createAction('[Release] Pause batch', props<{ id: string; actor: string }>());
export const resumeBatch = createAction('[Release] Resume batch', props<{ id: string; actor: string }>());
export const rollbackBatch = createAction('[Release] Rollback batch', props<{ id: string; actor: string }>());

/** 某机型升级失败后重试：从 reachedVersion 另找一条回到稳定版本的路 */
export const retryRoute = createAction('[Release] Retry model route', props<{ batchId: string; routeId: string; actor: string }>());
/** 重新规划某条被卡住的路线（补齐缺失环节后使用） */
export const replanRoute = createAction('[Release] Replan blocked route', props<{ batchId: string; routeId: string; actor: string }>());

/**
 * 修改某版本的依赖关系（前置版本列表）。
 * baseRevision 为值班员打开编辑器时看到的 prereqRevision；
 * 与仓库当前值不一致说明有人先改过，后到的提交看到冲突。
 */
export const updatePrerequisites = createAction(
  '[Firmware] Update prerequisites',
  props<{
    modelId: string;
    version: string;
    prerequisites: string[];
    baseRevision: number;
    actor: string;
  }>()
);
export const dismissConflict = createAction('[Firmware] Dismiss conflict');
/** 演示用：模拟对班值班员在你不知情时先一步提交，把节点修订号顶高 */
export const simulateConcurrentEdit = createAction(
  '[Firmware] Simulate concurrent edit',
  props<{ modelId: string; version: string; actor: string }>()
);
export const telemetryTick = createAction('[Release] Telemetry tick');
