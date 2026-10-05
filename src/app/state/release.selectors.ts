import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { ReleaseState, RouteStatus, UpgradeRoute } from './release.models';

export const selectRelease = createFeatureSelector<ReleaseState>('release');
export const selectGroups = createSelector(selectRelease, (state) => state.groups);
export const selectModels = createSelector(selectRelease, (state) => state.models);
export const selectFirmware = createSelector(selectRelease, (state) => state.firmware);
export const selectBatches = createSelector(selectRelease, (state) => state.batches);
export const selectAudits = createSelector(selectRelease, (state) => state.audits);
export const selectGraphRevision = createSelector(selectRelease, (state) => state.graphRevision);
export const selectConflict = createSelector(selectRelease, (state) => state.conflict);

export const routeStatusLabel: Record<RouteStatus, string> = {
  planned: '待下发',
  ready: '待下发',
  running: '刷机中',
  paused: '已暂停',
  failed: '失败待重试',
  blocked: '缺环节·退回草稿',
  done: '已刷好',
  rescued: '已替代路线恢复',
  rolled_back: '已回滚'
};

export function firmwareForModel(firmware: ReleaseState['firmware'], modelId: string) {
  return firmware.filter((node) => node.modelId === modelId);
}

export function blockedRoutes(batches: ReleaseState['batches']): Array<{ batchName: string; route: UpgradeRoute }> {
  return batches.flatMap((batch) =>
    batch.routes.filter((route) => route.status === 'blocked').map((route) => ({ batchName: batch.name, route }))
  );
}
