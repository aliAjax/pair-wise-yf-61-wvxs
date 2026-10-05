import type { DeviceModelId, FirmwareDependency, RouteStep, StepKind } from './release.models';

export interface RouteResult {
  valid: boolean;
  steps: RouteStep[];
  /** 路线缺失时指名缺的版本 */
  missing?: string;
}

/** 构造某机型的固件依赖邻接表：requires -> 可刷版本 */
function firmwareAdjacency(deps: FirmwareDependency[], model: DeviceModelId): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const dep of deps) {
    if (dep.model !== model || dep.kind !== 'firmware') continue;
    const list = adj.get(dep.requires) ?? [];
    list.push(dep.version);
    adj.set(dep.requires, list);
  }
  return adj;
}

function bootloaderRequirements(deps: FirmwareDependency[], model: DeviceModelId): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const dep of deps) {
    if (dep.model !== model || dep.kind !== 'bootloader') continue;
    const list = map.get(dep.version) ?? [];
    list.push(dep.requires);
    map.set(dep.version, list);
  }
  return map;
}

function bfs(adj: Map<string, string[]>, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const queue: string[] = [from];
  const prev = new Map<string, string | null>([[from, null]]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (prev.has(next)) continue;
      prev.set(next, cur);
      if (next === to) {
        const path: string[] = [];
        let node: string | null = next;
        while (node !== null) { path.unshift(node); node = prev.get(node) ?? null; }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

function bfsToAny(adj: Map<string, string[]>, from: string, targets: Set<string>): string[] | null {
  if (targets.has(from)) return [from];
  const queue: string[] = [from];
  const prev = new Map<string, string | null>([[from, null]]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (prev.has(next)) continue;
      prev.set(next, cur);
      if (targets.has(next)) {
        const path: string[] = [];
        let node: string | null = next;
        while (node !== null) { path.unshift(node); node = prev.get(node) ?? null; }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

function reachableSet(adj: Map<string, string[]>, from: string): Set<string> {
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/** 在固件版本链路上为需要补引导程序的机型插入 bootloader 步骤 */
function withBootloaders(deps: FirmwareDependency[], model: DeviceModelId, firmwarePath: string[], includeBootloader: boolean): RouteStep[] {
  const steps: RouteStep[] = [];
  const bootloaders = includeBootloader ? bootloaderRequirements(deps, model) : new Map<string, string[]>();
  for (const version of firmwarePath) {
    for (const bootloader of bootloaders.get(version) ?? []) {
      steps.push({ version: bootloader, kind: 'bootloader' as StepKind });
    }
    steps.push({ version, kind: 'firmware' });
  }
  return steps;
}

/**
 * 按版本谱系计算 from -> target 的升级路线。
 * 跨大版本必须先过过渡版本；换过主板的网关在刷固件前还要先补引导程序。
 * 链路缺环节时返回 missing，指名缺的版本。
 */
export function computeRoute(deps: FirmwareDependency[], model: DeviceModelId, from: string, target: string, includeBootloader: boolean): RouteResult {
  const adj = firmwareAdjacency(deps, model);
  const path = bfs(adj, from, target);
  if (path) return { valid: true, steps: withBootloaders(deps, model, path.slice(1), includeBootloader) };

  // 定位缺失环节：从目标沿前置版本回退，第一个从 from 出发够不到的版本就是缺的版本
  const reachable = reachableSet(adj, from);
  const firmware = deps.filter((dep) => dep.model === model && dep.kind === 'firmware');
  let cur: string | undefined = target;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    if (reachable.has(cur)) break;
    const dep = firmware.find((item) => item.version === cur);
    if (!dep || dep.requires === '') return { valid: false, steps: [], missing: cur };
    cur = dep.requires;
  }
  return { valid: false, steps: [], missing: cur ?? target };
}

/**
 * 失败后从设备已到达的版本另找一条能回到稳定版本的路。
 */
export function routeToStable(deps: FirmwareDependency[], model: DeviceModelId, from: string, includeBootloader: boolean): RouteResult {
  const adj = firmwareAdjacency(deps, model);
  const stableVersions = new Set(
    deps.filter((dep) => dep.model === model && dep.kind === 'firmware' && dep.stable).map((dep) => dep.version)
  );
  const path = bfsToAny(adj, from, stableVersions);
  if (!path) return { valid: false, steps: [], missing: from };
  return { valid: true, steps: withBootloaders(deps, model, path.slice(1), includeBootloader) };
}
