import type {
  DeviceGroup, DeviceModel, FirmwareKind, FirmwareNode,
  RouteStep, RouteStatus, UpgradeRoute
} from './release.models';

/** 一条机型路线的输入：从哪个版本起、刷到哪个版本、回滚到哪个版本 */
export interface RouteSpec {
  modelId: string;
  modelName: string;
  deviceCount: number;
  boardReplaced: boolean;
  fromVersion: string;
  targetVersion: string;
  rollbackVersion: string;
}

interface PlanOutcome {
  steps: RouteStep[];
  blockingGaps: string[];
  blocked: boolean;
}

const nodeId = (modelId: string, version: string) => `${modelId}@${version}`;

function modelIndex(firmware: FirmwareNode[], modelId: string): Map<string, FirmwareNode> {
  const map = new Map<string, FirmwareNode>();
  for (const node of firmware) {
    if (node.modelId === modelId) map.set(node.version, node);
  }
  return map;
}

/**
 * 在机型子图里做 BFS：边的方向是 前置版本 -> 本版本。
 * avoidEdges 里的失败边不再走，从而给失败重试"另找一条路"。
 * 返回含首尾的版本序列；走不通返回 null。
 */
export function findPath(
  nodes: Map<string, FirmwareNode>,
  from: string,
  to: string,
  avoidEdges: ReadonlySet<string>
): string[] | null {
  if (from === to) return [from];
  if (!nodes.has(from) || !nodes.has(to)) return null;
  const queue: string[] = [from];
  const prev = new Map<string, string>();
  const seen = new Set<string>([from]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const node of nodes.values()) {
      if (seen.has(node.version)) continue;
      if (!node.prerequisites.includes(cur)) continue;
      const edge = `${cur}->${node.version}`;
      if (avoidEdges.has(edge)) continue;
      seen.add(node.version);
      prev.set(node.version, cur);
      if (node.version === to) {
        const path = [to];
        let v = to;
        while (v !== from) {
          v = prev.get(v)!;
          path.unshift(v);
        }
        return path;
      }
      queue.push(node.version);
    }
  }
  return null;
}

/** 从前向可达性算出从 from 出发能抵达的全部现存版本 */
function reachable(nodes: Map<string, FirmwareNode>, from: string): Set<string> {
  const out = new Set<string>();
  if (!nodes.has(from)) return out;
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const node of nodes.values()) {
      if (out.has(node.version) || node.version === from) continue;
      if (node.prerequisites.includes(cur)) {
        out.add(node.version);
        queue.push(node.version);
      }
    }
  }
  return out;
}

/**
 * 当目标不可达时，沿前置关系反向排查，指名是哪些版本缺失卡死了链路。
 * 只报"父亲本身不可达"的缺失引用，避免把可绕行的备选前置误报为缺口。
 */
function findBlockingGaps(
  nodes: Map<string, FirmwareNode>,
  from: string,
  target: string,
  modelName: string
): string[] {
  const gaps = new Set<string>();
  const targetNode = nodes.get(target);
  if (!targetNode) {
    gaps.add(`${target}（目标版本不在固件仓库）`);
    return [...gaps];
  }
  const canReach = reachable(nodes, from);
  if (canReach.has(target)) return [];

  const canReach2 = new Set(canReach);
  canReach2.add(from);
  const queue = [target];
  const visited = new Set<string>([target]);
  while (queue.length) {
    const version = queue.shift()!;
    const node = nodes.get(version);
    if (!node) continue;
    for (const prereq of node.prerequisites) {
      if (!nodes.has(prereq)) {
        if (!canReach2.has(version)) {
          gaps.add(`${prereq}（被 ${version} 引用但固件仓库缺失，${modelName} 无法补全到 ${version} 的环节）`);
        }
      } else if (!visited.has(prereq)) {
        visited.add(prereq);
        queue.push(prereq);
      }
    }
  }
  if (gaps.size === 0) gaps.add(`${target}（从 ${from} 出发没有可连通的升级链路）`);
  return [...gaps];
}

function kindOf(nodes: Map<string, FirmwareNode>, version: string): FirmwareKind {
  return nodes.get(version)?.kind ?? 'stable';
}

/** 换主板网关：路线最前面补引导程序节点 */
function bootloaderStep(model: DeviceModel, nodes: Map<string, FirmwareNode>, boardReplaced: boolean): RouteStep[] {
  if (!model.needsBootloader || !boardReplaced) return [];
  const boot = [...nodes.values()].find((node) => node.kind === 'bootloader');
  if (!boot) return [];
  return [{ id: crypto.randomUUID(), toVersion: boot.version, kind: 'bootloader', status: 'pending' }];
}

function toSteps(nodes: Map<string, FirmwareNode>, versions: string[], prefix: RouteStep[] = []): RouteStep[] {
  return [
    ...prefix,
    ...versions.slice(1).map((version) => ({
      id: crypto.randomUUID(), toVersion: version, kind: kindOf(nodes, version), status: 'pending' as const
    }))
  ];
}

/** 首次规划：按机型从当前版本走到目标版本，缺环节则 blocked */
export function planRoute(firmware: FirmwareNode[], model: DeviceModel, spec: RouteSpec): PlanOutcome {
  const nodes = modelIndex(firmware, model.id);
  const prefix = bootloaderStep(model, nodes, spec.boardReplaced);
  const path = findPath(nodes, spec.fromVersion, spec.targetVersion, new Set());
  if (!path) {
    return { steps: prefix, blockingGaps: findBlockingGaps(nodes, spec.fromVersion, spec.targetVersion, spec.modelName), blocked: true };
  }
  return { steps: toSteps(nodes, path, prefix), blockingGaps: [], blocked: false };
}

/**
 * 失败重试 / 依赖变更重算：从已刷到的版本重新寻路，保留刷好的步骤。
 * rescue=true（失败后救援）：优先回到回滚稳定版，再考虑原目标；
 * rescue=false（缺环节补齐后的重新规划）：优先原目标。
 * 最后兜底任意可达稳定版；都走不通且当前版本本身稳定，则就地停留。
 * 返回 null 表示彻底无路（目标在仓库中也不存在等）。
 */
export function planTail(
  firmware: FirmwareNode[],
  model: DeviceModel,
  spec: Pick<RouteSpec, 'fromVersion' | 'targetVersion' | 'rollbackVersion'>,
  reachedVersion: string,
  failedEdges: ReadonlySet<string>,
  rescue: boolean
): { path: string[] | null; rescueHit: boolean; blockingGaps: string[] } {
  const nodes = modelIndex(firmware, model.id);
  const targetCandidate = { version: spec.targetVersion, rescueHit: rescue };
  const rollbackCandidate = spec.rollbackVersion && spec.rollbackVersion !== reachedVersion
    ? [{ version: spec.rollbackVersion, rescueHit: true }]
    : [];
  const candidates = rescue
    ? [...rollbackCandidate, targetCandidate]
    : [targetCandidate, ...rollbackCandidate];
  for (const candidate of candidates) {
    const path = findPath(nodes, reachedVersion, candidate.version, failedEdges);
    if (path) return { path, rescueHit: candidate.rescueHit, blockingGaps: [] };
  }
  // 兜底：找距离最近的可达稳定版（BFS 自然给出最近的）
  const fallback = nearestStable(nodes, reachedVersion, failedEdges);
  if (fallback && fallback.length > 1) return { path: fallback, rescueHit: true, blockingGaps: [] };

  // 已停在稳定版：原地即为安全落脚点
  if (nodes.get(reachedVersion)?.kind === 'stable') {
    return { path: [reachedVersion], rescueHit: rescue || failedEdges.size > 0, blockingGaps: [] };
  }
  return {
    path: null,
    rescueHit: false,
    blockingGaps: findBlockingGaps(nodes, reachedVersion, spec.targetVersion, model.name)
  };
}

function nearestStable(
  nodes: Map<string, FirmwareNode>,
  from: string,
  avoidEdges: ReadonlySet<string>
): string[] | null {
  if (!nodes.has(from)) return null;
  const queue: string[] = [from];
  const prev = new Map<string, string>();
  const seen = new Set<string>([from]);
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur !== from && nodes.get(cur)?.kind === 'stable') {
      const path = [cur];
      let v = cur;
      while (v !== from) {
        v = prev.get(v)!;
        path.unshift(v);
      }
      return path;
    }
    for (const node of nodes.values()) {
      if (seen.has(node.version) || !node.prerequisites.includes(cur)) continue;
      if (avoidEdges.has(`${cur}->${node.version}`)) continue;
      seen.add(node.version);
      prev.set(node.version, cur);
      queue.push(node.version);
    }
  }
  return null;
}

/** 分组内每种机型各算一条路；任一条缺环节，整条批次退回草稿 */
export function planGroupRoutes(
  firmware: FirmwareNode[],
  models: DeviceModel[],
  group: DeviceGroup,
  targetVersion: string,
  rollbackVersion: string,
  graphRevision: number
): UpgradeRoute[] {
  const now = new Date().toISOString();
  return group.fleet.map((fleet) => {
    const model = models.find((item) => item.id === fleet.modelId);
    const spec: RouteSpec = {
      modelId: fleet.modelId,
      modelName: model?.name ?? fleet.modelId,
      deviceCount: fleet.count,
      boardReplaced: fleet.boardReplaced,
      fromVersion: fleet.currentVersion,
      targetVersion,
      rollbackVersion
    };
    const outcome = model ? planRoute(firmware, model, spec) : { steps: [], blockingGaps: [`${fleet.modelId}（机型档案缺失）`], blocked: true };
    const status: RouteStatus = outcome.blocked ? 'blocked' : 'planned';
    return {
      id: `${group.id}::${fleet.modelId}`,
      modelId: fleet.modelId,
      modelName: spec.modelName,
      deviceCount: fleet.count,
      boardReplaced: fleet.boardReplaced,
      fromVersion: fleet.currentVersion,
      reachedVersion: fleet.currentVersion,
      targetVersion,
      rollbackVersion,
      steps: outcome.steps,
      status,
      blockingGaps: outcome.blockingGaps,
      failedEdges: [],
      rescue: false,
      planRevision: graphRevision,
      updatedAt: now
    };
  });
}

export { nodeId };
