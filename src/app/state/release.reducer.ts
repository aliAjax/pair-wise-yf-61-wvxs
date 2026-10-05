import { createReducer, on } from '@ngrx/store';
import type { AuditEntry, DeviceGroup, DeviceModelId, FirmwareDependency, ReleaseBatch, ReleaseState } from './release.models';
import {
  addDependency,
  approveBatch,
  clearConflict,
  createBatch,
  pauseBatch,
  removeDependency,
  resumeBatch,
  retryBatch,
  rollbackBatch,
  simulateConcurrentEdit,
  telemetryTick,
  updateDependency
} from './release.actions';
import { computeRoute, routeToStable } from './firmware.route';

const initialGroups: DeviceGroup[] = [
  { id: 'g-edge', name: '华东边缘网关', region: '华东', count: 680, compatible: true, offlineGateways: 4, model: 'edge-gateway', replacedBoards: 6 },
  { id: 'g-plant', name: '工业采集终端', region: '华南', count: 1240, compatible: false, offlineGateways: 12, model: 'plant-terminal', replacedBoards: 0 },
  { id: 'g-clinic', name: '远程诊疗终端', region: '新加坡', count: 310, compatible: true, offlineGateways: 2, model: 'clinic-terminal', replacedBoards: 0 }
];

/** 固件仓库：版本依赖谱系。root 版本（requires 为空）为出厂基线。 */
const initialDependencies: FirmwareDependency[] = [
  // 边缘网关：跨大版本 3.0.0 必须先过过渡版本 2.8.1；换过主板的网关刷 3.0.0 前还要先补引导程序
  { id: 'dep-edge-279', model: 'edge-gateway', version: '2.7.9', requires: '', kind: 'firmware', stable: true, revision: 1, updatedAt: '' },
  { id: 'dep-edge-281', model: 'edge-gateway', version: '2.8.1', requires: '2.7.9', kind: 'firmware', stable: true, revision: 1, updatedAt: '' },
  { id: 'dep-edge-300', model: 'edge-gateway', version: '3.0.0', requires: '2.8.1', kind: 'firmware', stable: false, revision: 1, updatedAt: '' },
  { id: 'dep-edge-bl300', model: 'edge-gateway', version: '3.0.0', requires: 'bl-3.0', kind: 'bootloader', stable: false, revision: 1, updatedAt: '' },
  // 工业采集终端
  { id: 'dep-plant-279', model: 'plant-terminal', version: '2.7.9', requires: '', kind: 'firmware', stable: true, revision: 1, updatedAt: '' },
  { id: 'dep-plant-281', model: 'plant-terminal', version: '2.8.1', requires: '2.7.9', kind: 'firmware', stable: true, revision: 1, updatedAt: '' },
  { id: 'dep-plant-300', model: 'plant-terminal', version: '3.0.0', requires: '2.8.1', kind: 'firmware', stable: false, revision: 1, updatedAt: '' },
  // 远程诊疗终端：谱系缺环节 —— 3.0.0 依赖 2.8.1，但仓库里没有 2.8.1 的前置记录
  { id: 'dep-clinic-279', model: 'clinic-terminal', version: '2.7.9', requires: '', kind: 'firmware', stable: true, revision: 1, updatedAt: '' },
  { id: 'dep-clinic-300', model: 'clinic-terminal', version: '3.0.0', requires: '2.8.1', kind: 'firmware', stable: false, revision: 1, updatedAt: '' }
];

const now = new Date().toISOString();
for (const dep of initialDependencies) dep.updatedAt = now;

function audit(state: ReleaseState, actor: string, message: string): AuditEntry[] {
  return [{ id: crypto.randomUUID(), at: new Date().toISOString(), actor, message }, ...state.audits];
}

function includeBootloaderFor(state: ReleaseState, groupId: string): boolean {
  const group = state.groups.find((item) => item.id === groupId);
  return (group?.replacedBoards ?? 0) > 0;
}

/** 按最新谱系重算批次路线。
 *  allowStableFallback 仅用于失败重试：目标版本不可达时改算回稳定版本的路；
 *  其余场景（创建/审批/依赖失效）目标不可达即退回草稿并指名缺的版本。 */
function recomputeRoute(state: ReleaseState, batch: ReleaseBatch, allowStableFallback = false): ReleaseBatch {
  const includeBootloader = includeBootloaderFor(state, batch.groupId);
  const from = batch.reachedVersion ?? batch.currentVersion;
  const targetResult = computeRoute(state.dependencies, batch.model, from, batch.firmware, includeBootloader);
  if (targetResult.valid) return { ...batch, route: targetResult.steps, routeValid: true, routeMissing: undefined };
  if (!allowStableFallback) return { ...batch, route: [], routeValid: false, routeMissing: targetResult.missing ?? from };
  const stableResult = routeToStable(state.dependencies, batch.model, from, includeBootloader);
  if (stableResult.valid) return { ...batch, route: stableResult.steps, routeValid: true, routeMissing: undefined };
  return { ...batch, route: [], routeValid: false, routeMissing: targetResult.missing ?? from };
}

const TERMINAL_STATUSES: ReadonlyArray<ReleaseBatch['status']> = ['completed', 'rolled_back', 'stabilized'];

function newAuditEntry(actor: string, message: string): AuditEntry {
  return { id: crypto.randomUUID(), at: new Date().toISOString(), actor, message };
}

/** 依赖关系一改动，未下发的路线立即失效重算；已刷好的设备（终态批次）保留结果。 */
function invalidateRoutes(state: ReleaseState, actor: string, reason: string): ReleaseState {
  let audits = state.audits;
  const batches = state.batches.map((batch) => {
    if (TERMINAL_STATUSES.includes(batch.status)) return batch;
    const recomputed = recomputeRoute(state, batch);
    if (!recomputed.routeValid) {
      audits = [newAuditEntry(actor, `${reason}：批次 ${batch.name} 路线失效，退回草稿，缺少过渡版本 ${recomputed.routeMissing}`), ...audits];
      return { ...recomputed, status: 'draft' as const };
    }
    if (recomputed.route.length !== batch.route.length || recomputed.route.some((step, index) => step.version !== batch.route[index]?.version)) {
      audits = [newAuditEntry(actor, `${reason}：批次 ${batch.name} 路线已按新版本谱系重算`), ...audits];
    }
    return recomputed;
  });
  return { ...state, batches, audits };
}

function loadState(): ReleaseState {
  const fallback: ReleaseState = {
    groups: initialGroups,
    batches: [],
    dependencies: initialDependencies,
    conflict: null,
    audits: [{ id: 'audit-1', at: now, actor: '系统', message: '固件仓库版本谱系已载入' }]
  };
  if (typeof localStorage === 'undefined') return fallback;
  const raw = localStorage.getItem('firmware-release-v2');
  if (raw) return JSON.parse(raw) as ReleaseState;
  // 从 v1 迁移：补机型与版本谱系字段
  const legacy = localStorage.getItem('firmware-release-v1');
  if (legacy) {
    const old = JSON.parse(legacy) as { groups: DeviceGroup[]; batches: ReleaseBatch[]; audits: AuditEntry[] };
    const groups = old.groups.map((group) => ({
      ...group,
      model: (group.id === 'g-edge' ? 'edge-gateway' : group.id === 'g-plant' ? 'plant-terminal' : 'clinic-terminal') as DeviceModelId,
      replacedBoards: group.id === 'g-edge' ? 6 : 0
    }));
    const state: ReleaseState = { groups, batches: [], dependencies: initialDependencies, conflict: null, audits: old.audits ?? [] };
    state.batches = old.batches.map((batch) => {
      const group = groups.find((item) => item.id === batch.groupId);
      const migrated: ReleaseBatch = {
        ...batch,
        currentVersion: batch.rollbackVersion,
        model: group?.model ?? 'edge-gateway',
        reachedVersion: undefined,
        route: [],
        routeValid: false
      };
      return recomputeRoute(state, migrated);
    });
    return state;
  }
  const demoBatch: ReleaseBatch = {
    id: 'batch-demo', name: '边缘网关安全补丁 2.8.1', firmware: '2.8.1', currentVersion: '2.7.9', rollbackVersion: '2.7.9',
    groupId: 'g-edge', model: 'edge-gateway', rolloutPercent: 20, failureThreshold: 5, status: 'approved',
    progress: 0, downloaded: 0, failed: 0, route: [], routeValid: false, updatedAt: now
  };
  const withDemo: ReleaseState = { ...fallback, batches: [] };
  const demoRoute = recomputeRoute(withDemo, demoBatch);
  return { ...withDemo, batches: [{ ...demoBatch, route: demoRoute.route, routeValid: demoRoute.routeValid }] };
}

export const releaseReducer = createReducer(
  loadState(),
  on(createBatch, (state, { batch }) => {
    const withRoute = recomputeRoute(state, batch);
    const next: ReleaseState = { ...state, batches: [withRoute, ...state.batches] };
    const message = withRoute.routeValid
      ? `创建批次 ${batch.name}，路线 ${withRoute.route.map((step) => step.version).join(' → ')}`
      : `创建批次 ${batch.name}：缺少过渡版本 ${withRoute.routeMissing}，退回草稿`;
    return { ...next, audits: audit(state, '发布负责人', message) };
  }),
  on(approveBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch) return state;
    const recomputed = recomputeRoute(state, batch);
    if (!recomputed.routeValid) {
      return {
        ...state,
        batches: state.batches.map((item) => item.id === id ? { ...recomputed, status: 'draft' } : item),
        audits: audit(state, actor, `批次 ${batch.name} 无法审批：缺少过渡版本 ${recomputed.routeMissing}，保持草稿`)
      };
    }
    return {
      ...state,
      batches: state.batches.map((item) => item.id === id ? { ...recomputed, status: 'approved', updatedAt: new Date().toISOString() } : item),
      audits: audit(state, actor, `批次 ${batch.name} 审批通过，路线 ${recomputed.route.map((step) => step.version).join(' → ')}`)
    };
  }),
  on(pauseBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) => batch.id === id ? { ...batch, status: 'paused', updatedAt: new Date().toISOString() } : batch),
    audits: audit(state, actor, `批次 ${id} 已暂停`)
  })),
  on(resumeBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) => batch.id === id ? { ...batch, status: 'running', updatedAt: new Date().toISOString() } : batch),
    audits: audit(state, actor, `批次 ${id} 恢复发布`)
  })),
  on(retryBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch) return state;
    const recomputed = recomputeRoute(state, batch, true);
    if (!recomputed.routeValid) {
      return {
        ...state,
        batches: state.batches.map((item) => item.id === id ? { ...recomputed, status: 'failed' } : item),
        audits: audit(state, actor, `批次 ${batch.name} 重试失败：从已到达版本 ${batch.reachedVersion ?? batch.currentVersion} 出发缺少过渡版本 ${recomputed.routeMissing}`)
      };
    }
    const diverted = !recomputed.route.some((step) => step.version === batch.firmware);
    return {
      ...state,
      batches: state.batches.map((item) => item.id === id
        ? { ...recomputed, status: diverted ? 'stabilized' : 'running', updatedAt: new Date().toISOString() }
        : item),
      audits: audit(
        state, actor,
        diverted
          ? `批次 ${batch.name} 从重试：目标版本不可达，已从 ${batch.reachedVersion ?? batch.currentVersion} 回到稳定版本 ${recomputed.route[recomputed.route.length - 1]?.version ?? batch.currentVersion}`
          : `批次 ${batch.name} 重试：从已到达版本 ${batch.reachedVersion ?? batch.currentVersion} 继续，路线 ${recomputed.route.map((step) => step.version).join(' → ')}`
      )
    };
  }),
  on(rollbackBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) => batch.id === id ? { ...batch, status: 'rolled_back', updatedAt: new Date().toISOString() } : batch),
    audits: audit(state, actor, `批次 ${id} 已紧急回滚`)
  })),
  on(addDependency, (state, { dependency, actor }) => {
    const exists = state.dependencies.some((item) => item.model === dependency.model && item.version === dependency.version && item.requires === dependency.requires);
    if (exists) {
      return { ...state, audits: audit(state, actor, `依赖 ${dependency.version}（前置 ${dependency.requires || '无'}）已存在，未重复添加`) };
    }
    const next: ReleaseState = { ...state, dependencies: [...state.dependencies, dependency] };
    const withAudit: ReleaseState = { ...next, audits: audit(state, actor, `新增依赖：${dependency.model} ${dependency.version} 依赖 ${dependency.requires || '出厂基线'}（修订 ${dependency.revision}）`) };
    return invalidateRoutes(withAudit, actor, '版本谱系新增依赖');
  }),
  on(updateDependency, (state, { id, changes, baseRevision, actor }) => {
    const dep = state.dependencies.find((item) => item.id === id);
    if (!dep) return state;
    if (dep.revision !== baseRevision) {
      return {
        ...state,
        conflict: {
          dependencyId: id, model: dep.model, version: dep.version,
          expectedRevision: baseRevision, actualRevision: dep.revision, at: new Date().toISOString()
        },
        audits: audit(state, actor, `依赖 ${dep.version} 的修改冲突：你基于修订 ${baseRevision}，但当前已是修订 ${dep.revision}，请刷新后重试`)
      };
    }
    const dependencies = state.dependencies.map((item) => item.id === id
      ? { ...item, ...changes, revision: item.revision + 1, updatedAt: new Date().toISOString() }
      : item);
    const next: ReleaseState = { ...state, dependencies };
    const withAudit: ReleaseState = { ...next, audits: audit(state, actor, `依赖 ${dep.version} 已更新（修订 ${dep.revision} → ${dep.revision + 1}）`) };
    return invalidateRoutes(withAudit, actor, '版本谱系依赖变更');
  }),
  on(removeDependency, (state, { id, actor }) => {
    const dep = state.dependencies.find((item) => item.id === id);
    if (!dep) return state;
    const next: ReleaseState = { ...state, dependencies: state.dependencies.filter((item) => item.id !== id) };
    const withAudit: ReleaseState = { ...next, audits: audit(state, actor, `移除依赖：${dep.model} ${dep.version}（前置 ${dep.requires || '无'}）`) };
    return invalidateRoutes(withAudit, actor, '版本谱系依赖移除');
  }),
  on(simulateConcurrentEdit, (state, { id, actor }) => {
    const dep = state.dependencies.find((item) => item.id === id);
    if (!dep) return state;
    const dependencies = state.dependencies.map((item) => item.id === id ? { ...item, revision: item.revision + 1, updatedAt: new Date().toISOString() } : item);
    const next: ReleaseState = { ...state, dependencies };
    const withAudit: ReleaseState = { ...next, audits: audit(state, actor, `${actor} 抢先保存了依赖 ${dep.version}（修订 ${dep.revision} → ${dep.revision + 1}）`) };
    return invalidateRoutes(withAudit, actor, '版本谱系依赖并发变更');
  }),
  on(clearConflict, (state) => ({ ...state, conflict: null })),
  on(telemetryTick, (state) => {
    const batches = state.batches.map((batch) => {
      if (batch.status !== 'running') return batch;
      const group = state.groups.find((item) => item.id === batch.groupId);
      const target = Math.round((group?.count ?? 0) * batch.rolloutPercent / 100);
      const increment = Math.max(4, Math.round(target * 0.055));
      const downloaded = Math.min(target, batch.downloaded + increment);
      const failed = batch.failed + (Math.random() < 0.08 ? 1 : 0);
      const failureRate = downloaded ? failed / downloaded * 100 : 0;
      const progress = target ? Math.round(downloaded / target * 100) : 0;
      const status: ReleaseBatch['status'] = failureRate > batch.failureThreshold ? 'paused' : downloaded >= target ? 'completed' : 'running';
      // 记录设备已到达的版本，作为失败后重试的起点
      let reachedVersion = batch.reachedVersion ?? batch.currentVersion;
      if (batch.route.length) {
        const idx = Math.min(batch.route.length - 1, Math.floor(progress / 100 * batch.route.length));
        reachedVersion = batch.route[idx].version;
      }
      return { ...batch, downloaded, failed, progress, status, reachedVersion, updatedAt: new Date().toISOString() };
    });
    const overflow = batches.some((batch, index) => batch.status === 'paused' && state.batches[index]?.status === 'running');
    return { ...state, batches, audits: overflow ? audit(state, '系统', '失败率超过阈值，已自动暂停发布') : state.audits };
  })
);
