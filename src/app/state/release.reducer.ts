import { createReducer, on } from '@ngrx/store';
import type {
  AuditEntry, DeviceGroup, DeviceModel, FirmwareNode, ReleaseBatch,
  ReleaseState, RouteStatus, RouteStep, UpgradeRoute
} from './release.models';
import {
  approveBatch, createBatch, dismissConflict, pauseBatch, replanRoute,
  resumeBatch, retryRoute, rollbackBatch, simulateConcurrentEdit, telemetryTick, updatePrerequisites
} from './release.actions';
import { SEED_FIRMWARE, SEED_GROUPS, SEED_MODELS } from './firmware.seed';
import { planGroupRoutes, planTail } from './firmware.planner';

const STORAGE_KEY = 'firmware-release-v2';
const now = () => new Date().toISOString();

/* ---------------- 初始数据：一条正常批次 + 一条缺环节批次 ---------------- */

function seedBatches(firmware: FirmwareNode[], models: DeviceModel[], groups: DeviceGroup[], revision: number): ReleaseBatch[] {
  const edge = groups.find((group) => group.id === 'g-edge')!;
  const clinic = groups.find((group) => group.id === 'g-clinic')!;
  const ready = (routes: ReturnType<typeof planGroupRoutes>): ReturnType<typeof planGroupRoutes> =>
    routes.map((route) => ({ ...route, status: 'ready' as RouteStatus }));

  // 正常批次：目标 3.1.2
  //   E300：2.8.1 → 2.9.0(过渡) → 3.0.0 → 3.1.2，首跳会被遥测注入故障，重试改走 2.9.1 通道
  //   X100 老机型换过主板：先补 boot-1.2，再 2.4.0 → 2.6.0(过渡) → 2.8.2 → 2.9.1(过渡) → 3.0.0 → 3.1.2
  const edgeRoutes = ready(planGroupRoutes(firmware, models, edge, '3.1.2', '2.8.1', revision));

  // 缺环节批次：X100 目标 3.2.0 的前置过渡版 3.1.9 未入库 → 退回草稿并指名
  const x100Only: DeviceGroup = { ...edge, fleet: edge.fleet.filter((fleet) => fleet.modelId === 'gw-x100') };
  const gapRoutes = planGroupRoutes(firmware, models, x100Only, '3.2.0', '2.8.2', revision);

  // 正常批次：诊疗终端 3.2.1 → 3.3.0 → 3.4.2（3.4.0 缺 3.3.5 但可绕行，不误报缺口）
  const clinicRoutes = ready(planGroupRoutes(firmware, models, clinic, '3.4.2', '3.3.0', revision));

  return [
    { id: 'batch-edge', name: '边缘网关 3.1.2 灰度', firmware: '3.1.2', rollbackVersion: '2.8.1', groupId: 'g-edge', rolloutPercent: 20, failureThreshold: 5, status: 'approved', routes: edgeRoutes, updatedAt: now() },
    { id: 'batch-gap', name: 'X100 老机型跨代升级 3.2.0（草稿）', firmware: '3.2.0', rollbackVersion: '2.8.2', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 5, status: 'draft', routes: gapRoutes, updatedAt: now() },
    { id: 'batch-clinic', name: '远程诊疗终端 3.4.2 灰度', firmware: '3.4.2', rollbackVersion: '3.3.0', groupId: 'g-clinic', rolloutPercent: 25, failureThreshold: 5, status: 'approved', routes: clinicRoutes, updatedAt: now() }
  ];
}

const seedAudits: AuditEntry[] = [
  { id: crypto.randomUUID(), at: now(), actor: '系统', message: '固件仓库已载入版本谱系：跨大版本须经过渡版，换主板网关先补引导程序' },
  { id: crypto.randomUUID(), at: now(), actor: '系统', message: '批次「X100 老机型跨代升级 3.2.0」缺少环节 3.1.9，已退回草稿' }
];

function fallbackState(): ReleaseState {
  const graphRevision = 1;
  return {
    models: SEED_MODELS,
    groups: SEED_GROUPS,
    firmware: SEED_FIRMWARE,
    batches: seedBatches(SEED_FIRMWARE, SEED_MODELS, SEED_GROUPS, graphRevision),
    audits: seedAudits,
    graphRevision,
    conflict: null,
    lastRevisionNote: null
  };
}

const stored = typeof localStorage === 'undefined'
  ? null
  : JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as ReleaseState | null;
export const initialState: ReleaseState = stored
  ? { ...stored, conflict: null }
  : fallbackState();

/* ---------------- 工具 ---------------- */

function audit(state: ReleaseState, actor: string, message: string): AuditEntry[] {
  return [{ id: crypto.randomUUID(), at: now(), actor, message }, ...state.audits];
}

function routeModel(state: ReleaseState, route: UpgradeRoute): DeviceModel | undefined {
  return state.models.find((model) => model.id === route.modelId);
}

/** 已刷好的步骤前缀（含完成的引导步骤） */
function donePrefix(route: UpgradeRoute): RouteStep[] {
  const prefix: RouteStep[] = [];
  for (const step of route.steps) {
    if (step.status !== 'done') break;
    prefix.push(step);
  }
  return prefix;
}

/**
 * 依赖关系变更后重算一条路线。
 * 刷好的设备保留结果：只保留 done 步骤前缀，未下发的尾巴立即作废重算。
 */
function recomputeRoute(state: ReleaseState, route: UpgradeRoute): UpgradeRoute {
  // 已刷到目标 / 已救援 / 已随批次回滚：结果冻结，永不重算
  if (route.status === 'done' || route.status === 'rescued' || route.status === 'rolled_back') return route;

  const model = routeModel(state, route);
  if (!model) return route;

  // 已失败的路线等待值班员显式重试，但标注谱系已变，供重试时使用新依赖
  if (route.status === 'failed') return { ...route, planRevision: state.graphRevision };

  const result = planTail(
    state.firmware, model,
    { fromVersion: route.fromVersion, targetVersion: route.targetVersion, rollbackVersion: route.rollbackVersion },
    route.reachedVersion,
    new Set(route.failedEdges),
    route.rescue
  );

  if (!result.path) {
    return {
      ...route,
      steps: donePrefix(route),
      status: 'blocked',
      blockingGaps: result.blockingGaps,
      planRevision: state.graphRevision,
      updatedAt: now()
    };
  }

  const nodes = new Map(state.firmware.filter((node) => node.modelId === route.modelId).map((node) => [node.version, node]));
  const tail: RouteStep[] = result.path.slice(1).map((version) => ({
    id: crypto.randomUUID(),
    toVersion: version,
    kind: nodes.get(version)?.kind ?? 'stable',
    status: 'pending' as const
  }));

  return {
    ...route,
    steps: [...donePrefix(route), ...tail],
    // 之前被卡草稿的路线按最新谱系重算：能走通就回到 planned，否则继续 blocked
    status: route.status === 'blocked' ? 'planned' : route.status,
    blockingGaps: [],
    rescue: result.rescueHit,
    planRevision: state.graphRevision,
    updatedAt: now()
  };
}

/** 重算某批次内所有路线，返回新路线列表及批次应处状态 */
function recomputeBatch(state: ReleaseState, batch: ReleaseBatch): ReleaseBatch {
  if (batch.status === 'completed' || batch.status === 'rolled_back') return batch;
  const routes = batch.routes.map((route) => recomputeRoute(state, route));
  const anyBlocked = routes.some((route) => route.status === 'blocked');
  // 被改断的路线让整个批次退回草稿；其余情况下保持批次状态
  const status = anyBlocked ? 'draft' as const : batch.status;
  if (anyBlocked && batch.status !== 'draft') {
    // 下发中的路线被打回 pending
    routes.forEach((route) => {
      if (route.status !== 'blocked' && route.status !== 'failed' && route.status !== 'done' && route.status !== 'rescued') {
        route.status = 'planned';
      }
    });
  }
  return { ...batch, routes, status, updatedAt: now() };
}

/* ---------------- reducer ---------------- */

export const releaseReducer = createReducer(
  initialState,

  on(createBatch, (state, { input, actor }) => {
    const group = state.groups.find((item) => item.id === input.groupId);
    if (!group) return state;
    const routes = planGroupRoutes(state.firmware, state.models, group, input.firmware, input.rollbackVersion, state.graphRevision);
    const blocked = routes.some((route) => route.status === 'blocked');
    const batch: ReleaseBatch = {
      id: crypto.randomUUID(),
      name: input.name,
      firmware: input.firmware,
      rollbackVersion: input.rollbackVersion,
      groupId: input.groupId,
      rolloutPercent: input.rolloutPercent,
      failureThreshold: input.failureThreshold,
      status: 'draft',
      routes,
      updatedAt: now()
    };
    const gapMessages = routes
      .filter((route) => route.status === 'blocked')
      .flatMap((route) => route.blockingGaps.map((gap) => `机型 ${route.modelName} 缺少环节 ${gap}`));
    const message = blocked
      ? `批次「${input.name}」${gapMessages.length ? '存在缺环节，已退回草稿：' + gapMessages.join('；') : '路线不完整，已退回草稿'}`
      : `批次「${input.name}」已为分组内 ${routes.length} 种机型规划升级路线`;
    return { ...state, batches: [batch, ...state.batches], audits: audit(state, actor, message) };
  }),

  on(approveBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch || batch.status !== 'draft') return state;
    if (batch.routes.some((route) => route.status === 'blocked')) {
      return { ...state, audits: audit(state, actor, `批次「${batch.name}」仍有缺环节机型，审批被阻止`) };
    }
    const routes = batch.routes.map((route): UpgradeRoute => ({ ...route, status: 'ready' }));
    return {
      ...state,
      batches: state.batches.map((item) => item.id === id ? { ...item, status: 'approved', routes, updatedAt: now() } : item),
      audits: audit(state, actor, `批次「${batch.name}」审批通过，各机型路线可下发`)
    };
  }),

  on(pauseBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch) return state;
    const routes = batch.routes.map((route) =>
      route.status === 'running' ? { ...route, status: 'paused' as RouteStatus } : route
    );
    return {
      ...state,
      batches: state.batches.map((item) => item.id === id ? { ...item, status: 'paused', routes, updatedAt: now() } : item),
      audits: audit(state, actor, `批次「${batch.name}」已暂停，各机型停在当前版本`)
    };
  }),

  on(resumeBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch || (batch.status !== 'paused' && batch.status !== 'approved')) return state;
    const hasRunnable = batch.routes.some((route) =>
      ['ready', 'paused', 'planned', 'running'].includes(route.status) &&
      route.steps.some((step) => step.status !== 'done')
    );
    if (!hasRunnable) return state;
    const routes = batch.routes.map((route): UpgradeRoute =>
      route.status === 'ready' || route.status === 'paused' || route.status === 'planned'
        ? { ...route, status: 'running' }
        : route
    );
    return {
      ...state,
      batches: state.batches.map((item) => item.id === id ? { ...item, status: 'running', routes, updatedAt: now() } : item),
      audits: audit(state, actor, `批次「${batch.name}」恢复发布`)
    };
  }),

  on(rollbackBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch || batch.status === 'completed' || batch.status === 'rolled_back') return state;
    const routes = batch.routes.map((route): UpgradeRoute =>
      route.status === 'done' || route.status === 'rescued'
        ? route
        : { ...route, status: 'rolled_back', steps: route.steps.map((step) => step.status === 'pending' ? { ...step, status: 'failed' } : step) }
    );
    return {
      ...state,
      batches: state.batches.map((item) => item.id === id ? { ...item, status: 'rolled_back', routes, updatedAt: now() } : item),
      audits: audit(state, actor, `批次「${batch.name}」已紧急回滚，已刷好的机型保留当前结果`)
    };
  }),

  /* 某机型升级失败后重试：从 reachedVersion 避开失败边，另找一条回到稳定版本的路 */
  on(retryRoute, (state, { batchId, routeId, actor }) => {
    const batch = state.batches.find((item) => item.id === batchId);
    const route = batch?.routes.find((item) => item.id === routeId);
    if (!batch || !route || route.status !== 'failed') return state;
    const model = routeModel(state, route);
    if (!model) return state;

    const result = planTail(
      state.firmware, model,
      { fromVersion: route.fromVersion, targetVersion: route.targetVersion, rollbackVersion: route.rollbackVersion },
      route.reachedVersion,
      new Set(route.failedEdges),
      true
    );
    if (!result.path) {
      return {
        ...state,
        batches: state.batches.map((item) => item.id === batchId
          ? { ...item, routes: item.routes.map((r) => r.id === routeId ? { ...r, status: 'blocked', blockingGaps: result.blockingGaps, planRevision: state.graphRevision } : r) }
          : item),
        audits: audit(state, actor, `机型 ${route.modelName} 重试失败，仍无替代路线：${result.blockingGaps.join('；')}`)
      };
    }

    const nodes = new Map(state.firmware.filter((node) => node.modelId === route.modelId).map((node) => [node.version, node]));
    const tail: RouteStep[] = result.path.slice(1).map((version) => ({
      id: crypto.randomUUID(), toVersion: version, kind: nodes.get(version)?.kind ?? 'stable', status: 'pending'
    }));
    const dest = result.path[result.path.length - 1];
    const retried: UpgradeRoute = {
      ...route,
      steps: [...donePrefix(route), ...tail],
      status: 'running',
      blockingGaps: [],
      rescue: true,
      planRevision: state.graphRevision,
      updatedAt: now()
    };
    // 失败的是一条下发中的路线：重试同时把暂停的批次带回运行
    const batches = state.batches.map((item) => item.id === batchId
      ? { ...item, status: 'running' as const, routes: item.routes.map((r) => r.id === routeId ? retried : r.status === 'paused' ? { ...r, status: 'running' as RouteStatus } : r), updatedAt: now() }
      : item);
    return {
      ...state,
      batches,
      audits: audit(state, actor, `机型 ${route.modelName} 从已刷版本 ${route.reachedVersion} 重试，避开失败边，改走替代路线抵达稳定版 ${dest}`)
    };
  }),

  /* 缺环节补齐后，让退回草稿的路线重新按谱系规划（保留已刷好的前缀） */
  on(replanRoute, (state, { batchId, routeId, actor }) => {
    const batch = state.batches.find((item) => item.id === batchId);
    const route = batch?.routes.find((item) => item.id === routeId);
    if (!batch || !route) return state;
    if (!state.models.some((model) => model.id === route.modelId)) return state;

    const recomputed = recomputeRoute(state, route);
    const replanned: UpgradeRoute = recomputed.status === 'blocked'
      ? recomputed
      : { ...recomputed, status: 'planned' };
    const allClear = batch.routes.every((r) => r.id === routeId ? replanned.status !== 'blocked' : r.status !== 'blocked');
    return {
      ...state,
      batches: state.batches.map((item) => item.id === batchId
        ? { ...item, status: allClear ? 'draft' : item.status, routes: item.routes.map((r) => r.id === routeId ? replanned : r) }
        : item),
      audits: audit(state, actor, replanned.status === 'blocked'
        ? `机型 ${route.modelName} 重新规划仍缺环节：${replanned.blockingGaps.join('；')}`
        : `机型 ${route.modelName} 已按当前谱系重新规划路线，未下发步骤重算、已刷好的设备保留结果`)
    };
  }),

  /*
   * 修改版本依赖关系：
   * 1. 乐观锁——baseRevision 落后于仓库当前修订号则后到者看到冲突；
   * 2. 改成功则谱系修订号 +1，所有未下发路线立即失效重算，刷好的设备保留结果。
   */
  on(updatePrerequisites, (state, { modelId, version, prerequisites, baseRevision, actor }) => {
    const node = state.firmware.find((item) => item.modelId === modelId && item.version === version);
    if (!node) return state;

    if (baseRevision !== node.prereqRevision) {
      return {
        ...state,
        conflict: {
          nodeKey: `${node.modelId}@${node.version}`,
          actor,
          winner: node.lastEditor ?? '另一位值班员',
          baseRevision,
          currentRevision: node.prereqRevision,
          message: `值班员「${actor}」基于第 ${baseRevision} 版依赖关系提交，但「${node.lastEditor ?? '另一位值班员'}」已先提交第 ${node.prereqRevision} 版，本次修改被拒绝，请刷新后基于最新依赖再改`
        },
        audits: audit(state, actor, `修改 ${modelId}@${version} 依赖关系冲突：${node.lastEditor ?? '另一位值班员'} 已先一步提交（第 ${node.prereqRevision} 版）`)
      };
    }

    const nextRevision = state.graphRevision + 1;
    const firmware = state.firmware.map((item) =>
      item.modelId === modelId && item.version === version
        ? { ...item, prerequisites: [...prerequisites], prereqRevision: item.prereqRevision + 1, lastEditor: actor }
        : item
    );
    const edited: ReleaseState = { ...state, firmware, graphRevision: nextRevision, conflict: null };
    const batches = edited.batches.map((batch) => recomputeBatch(edited, batch));
    const affected = batches.filter((batch, index) => batch.routes.some((route, ri) => route !== state.batches[index].routes[ri]));
    const gapBatches = batches.filter((batch) => batch.routes.some((route) => route.status === 'blocked'));

    let messages = [
      `${actor} 修改 ${modelId}@${version} 的依赖关系（第 ${nextRevision} 版）：前置版本 ${prerequisites.join('、') || '无'}`
    ];
    if (affected.length) {
      messages.push(`依赖变更生效：${affected.map((batch) => `「${batch.name}」`).join('、')} 中未下发的路线已立即失效重算，已刷好的设备保留结果`);
    }
    if (gapBatches.length) {
      const named = gapBatches.flatMap((batch) =>
        batch.routes.filter((route) => route.status === 'blocked').flatMap((route) =>
          route.blockingGaps.map((gap) => `「${batch.name}」机型 ${route.modelName} 缺 ${gap}`)
        )
      );
      messages.push(`重算后被改断的路线已退回草稿：${named.join('；')}`);
    }
    return {
      ...edited,
      batches,
      audits: messages.reduce((entries, message) => [{ id: crypto.randomUUID(), at: now(), actor: '系统', message }, ...entries], edited.audits),
      lastRevisionNote: { nodeKey: `${modelId}@${version}`, actor, at: now(), revision: nextRevision }
    };
  }),

  on(dismissConflict, (state) => ({ ...state, conflict: null })),

  /* 演示：对班值班员先一步改了同一节点的依赖（依赖内容本身不变，只抬高修订号并触发重算） */
  on(simulateConcurrentEdit, (state, { modelId, version, actor }) => {
    const node = state.firmware.find((item) => item.modelId === modelId && item.version === version);
    if (!node) return state;
    const nextRevision = state.graphRevision + 1;
    const firmware = state.firmware.map((item) =>
      item.modelId === modelId && item.version === version
        ? { ...item, prereqRevision: item.prereqRevision + 1, lastEditor: actor }
        : item
    );
    const edited: ReleaseState = { ...state, firmware, graphRevision: nextRevision, conflict: null };
    const batches = edited.batches.map((batch) => recomputeBatch(edited, batch));
    return {
      ...edited,
      batches,
      audits: audit(edited, actor, `${actor} 刚刚先一步提交了 ${modelId}@${version} 的依赖调整（第 ${nextRevision} 版），未下发路线已重算`),
      lastRevisionNote: { nodeKey: `${modelId}@${version}`, actor, at: now(), revision: nextRevision }
    };
  }),

  /* ---------------- 模拟刷机遥测：按路线逐步推进 ---------------- */
  on(telemetryTick, (state) => {
    let failureMessages: string[] = [];
    const batches = state.batches.map((batch) => {
      if (batch.status !== 'running') return batch;
      let batchFailed = false;
      const routes = batch.routes.map((route) => {
        if (route.status !== 'running') return route;
        const activeIndex = route.steps.findIndex((step) => step.status === 'flashing');
        let steps = route.steps;
        let index = activeIndex;
        if (activeIndex < 0) {
          index = route.steps.findIndex((step) => step.status === 'pending');
          if (index < 0) return route;
          steps = route.steps.map((step, i) => i === index ? { ...step, status: 'flashing' as const } : step);
        }
        const current = steps[index];

        // 确定性故障注入：E300 首条 2.8.1→2.9.0 的边（老过渡版通道）刷失败，
        // 2.9.1 是并行的另一条过渡通道，重试时可改走 2.8.1→2.9.1→...
        const priorVersion = index === 0 ? route.fromVersion : steps.slice(0, index).reverse().find((step) => step.kind !== 'bootloader')?.toVersion ?? route.reachedVersion;
        const deterministicFail =
          route.modelId === 'gw-e300' && priorVersion === '2.8.1' && current.toVersion === '2.9.0' && !route.rescue &&
          !route.failedEdges.includes('2.8.1->2.9.0');
        const randomFail = !deterministicFail && Math.random() < 0.015;

        if (deterministicFail || randomFail) {
          const edge = `${priorVersion}->${current.toVersion}`;
          batchFailed = true;
          failureMessages.push(`机型 ${route.modelName} 刷入 ${current.toVersion} 失败，停在 ${route.reachedVersion}，可从该版本重试替代路线`);
          return {
            ...route,
            steps: steps.map((step, i) => i === index ? { ...step, status: 'failed' as const } : step),
            status: 'failed' as RouteStatus,
            failedEdges: [...new Set([...route.failedEdges, edge])],
            updatedAt: now()
          };
        }

        // 刷写成功
        const doneSteps = steps.map((step, i) => i === index ? { ...step, status: 'done' as const } : step);
        const reachedVersion = current.kind === 'bootloader' ? route.reachedVersion : current.toVersion;
        const morePending = doneSteps.some((step) => step.status === 'pending');
        const finished = !morePending;
        return {
          ...route,
          steps: doneSteps,
          reachedVersion,
          status: finished ? (route.rescue ? 'rescued' : 'done') as RouteStatus : 'running',
          updatedAt: now()
        };
      });

      const allFinished = routes.length > 0 && routes.every((route) => route.status === 'done' || route.status === 'rescued');
      // 某机型失败会自动暂停整个批次：其余在刷机型一并停在当前版本，等待继续或对失败机型重试
      const pausedRoutes = batchFailed
        ? routes.map((route) =>
            route.status === 'running' && !route.steps.every((step) => step.status === 'done')
              ? { ...route, status: 'paused' as RouteStatus, steps: route.steps.map((step) => step.status === 'flashing' ? { ...step, status: 'pending' as const } : step) }
              : route
          )
        : routes;
      const status = batchFailed ? 'paused' as const : allFinished ? 'completed' as const : 'running' as const;
      return { ...batch, routes: pausedRoutes, status, updatedAt: now() };
    });

    if (!failureMessages.length && batches.every((batch, i) => batch === state.batches[i])) return state;
    const audits = failureMessages.length
      ? [...failureMessages.map((message) => ({ id: crypto.randomUUID(), at: now(), actor: '设备遥测', message })), ...state.audits]
      : state.audits;
    return { ...state, batches, audits };
  })
);
