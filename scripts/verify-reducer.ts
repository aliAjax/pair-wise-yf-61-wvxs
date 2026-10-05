/**
 * reducer 状态流验证：
 *   npx tsx scripts/verify-reducer.ts
 * 用 localStorage 桩 + 手工派发 action，覆盖：缺环节草稿阻止审批、失败重试救援、
 * 依赖改动未下发路线失效重算/刷好结果保留、两名值班员乐观锁冲突。
 */
import '@angular/compiler';
import { initialState, releaseReducer } from '../src/app/state/release.reducer';
import {
  approveBatch, createBatch, replanRoute, resumeBatch,
  retryRoute, rollbackBatch, simulateConcurrentEdit, telemetryTick, updatePrerequisites
} from '../src/app/state/release.actions';
import type { ReleaseState } from '../src/app/state/release.models';

let state: ReleaseState = structuredClone(initialState);

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✘ ${name} ${detail}`); }
}
const dispatch = (action: ReturnType<typeof Object>) => { state = releaseReducer(state, action as never); };
const getBatch = (id: string) => state.batches.find((b) => b.id === id)!;

console.log('A) 初始种子：缺环节批次留在草稿，正常批次已审批');
{
  const gap = getBatch('batch-gap');
  const edge = getBatch('batch-edge');
  check('缺环节批次为 draft', gap.status === 'draft');
  const x100 = gap.routes.find((r) => r.modelId === 'gw-x100')!;
  check('X100 路线 blocked 且点名 3.1.9', x100.status === 'blocked' && x100.blockingGaps.some((g) => g.includes('3.1.9')));
  check('边缘批次 approved', edge.status === 'approved');
  check('边缘批次 E300 路线含 2.9.0', edge.routes.find((r) => r.modelId === 'gw-e300')!.steps.some((s) => s.toVersion === '2.9.0'));
  check('X100 路线带 boot-1.2', edge.routes.find((r) => r.modelId === 'gw-x100')!.steps[0].toVersion === 'boot-1.2');
}

console.log('B) 草稿存在 blocked 路线时审批被阻止');
{
  const before = getBatch('batch-gap').status;
  dispatch(approveBatch({ id: 'batch-gap', actor: '发布负责人' }));
  check('审批后仍是 draft', getBatch('batch-gap').status === before);
}

console.log('C) 新建批次：目标 3.2.0 的 X100 缺环节 -> 退回草稿');
{
  dispatch(createBatch({
    actor: '发布负责人',
    input: { name: '验证批次-缺口', firmware: '3.2.0', rollbackVersion: '2.8.2', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 5 }
  }));
  const batch = state.batches[0];
  check('新批次为 draft', batch.status === 'draft');
  check('E300→3.2.0 本就无路也 blocked', batch.routes.find((r) => r.modelId === 'gw-e300')!.status === 'blocked');
  check('X100 blocked 点名 3.1.9', batch.routes.find((r) => r.modelId === 'gw-x100')!.blockingGaps.some((g) => g.includes('3.1.9')));
  check('审计记录了缺环节', state.audits[0].message.includes('缺环节'));
}

console.log('D) 遥测推进：E300 首跳 2.8.1→2.9.0 确定性失败，批次暂停，可重试');
{
  dispatch(resumeBatch({ id: 'batch-edge', actor: '发布负责人' }));
  // 引导步骤(X100) 与 E300 首跳都在第一个 tick 开始 flashing；需要足够 tick 让 E300 撞上失败边
  for (let i = 0; i < 3; i++) dispatch(telemetryTick());
  const edge = getBatch('batch-edge');
  const e300 = edge.routes.find((r) => r.modelId === 'gw-e300')!;
  check('E300 状态 failed', e300.status === 'failed', e300.status);
  check('记录失败边 2.8.1->2.9.0', e300.failedEdges.includes('2.8.1->2.9.0'));
  check('reachedVersion 仍为 2.8.1', e300.reachedVersion === '2.8.1');
  check('批次被自动暂停', edge.status === 'paused');
}

console.log('E) 重试：从 2.8.1 避开失败边改走 2.9.1，批次恢复运行直至完成');
{
  const edge = getBatch('batch-edge');
  const e300 = edge.routes.find((r) => r.modelId === 'gw-e300')!;
  dispatch(retryRoute({ batchId: 'batch-edge', routeId: e300.id, actor: '值班人员' }));
  const retried = getBatch('batch-edge').routes.find((r) => r.modelId === 'gw-e300')!;
  check('重试后 rescue=true 且 running', retried.rescue && retried.status === 'running');
  check('新路线不含 2.9.0、含 2.9.1', !retried.steps.some((s) => s.toVersion === '2.9.0') && retried.steps.some((s) => s.toVersion === '2.9.1'));
  check('批次回到 running', getBatch('batch-edge').status === 'running');
  // 推到结束
  for (let i = 0; i < 40; i++) dispatch(telemetryTick());
  const done = getBatch('batch-edge');
  const finalE300 = done.routes.find((r) => r.modelId === 'gw-e300')!;
  check('E300 最终 rescued', finalE300.status === 'rescued', finalE300.status);
  check('E300 已到 3.1.2', finalE300.reachedVersion === '3.1.2');
  check('批次 completed', done.status === 'completed', done.status);
}

console.log('F) 依赖一改：未下发路线立即失效重算；已完成路线冻结保留');
{
  const revBefore = state.graphRevision;
  // 给 X100 的 3.2.0 补一条 3.0.0→3.2.0 的边（跨过渡），草稿批次应能重新规划
  const node = state.firmware.find((n) => n.modelId === 'gw-x100' && n.version === '3.2.0')!;
  dispatch(updatePrerequisites({
    modelId: 'gw-x100', version: '3.2.0', prerequisites: ['3.0.0'],
    baseRevision: node.prereqRevision, actor: '值班员-甲'
  }));
  check('谱系修订号 +1', state.graphRevision === revBefore + 1);
  const gap = getBatch('batch-gap');
  let x100 = gap.routes.find((r) => r.modelId === 'gw-x100')!;
  check('补边后原 blocked 路线立即自动重算为 planned', x100.status === 'planned', x100.status);
  check('自动重算终点为 3.2.0', x100.steps.at(-1)!.toVersion === '3.2.0', x100.steps.map((s) => s.toVersion).join(','));
  check('批次仍留在 draft，等待重新审批', getBatch('batch-gap').status === 'draft');
  // 手动重新规划在已通的情况下保持 planned（幂等）
  dispatch(replanRoute({ batchId: 'batch-gap', routeId: x100.id, actor: '值班员-甲' }));
  x100 = getBatch('batch-gap').routes.find((r) => r.modelId === 'gw-x100')!;
  check('手动重新规划仍 planned 且终点 3.2.0', x100.status === 'planned' && x100.steps.at(-1)!.toVersion === '3.2.0',
    x100.status);
  check('已完成的 batch-edge 结果冻结，E300 仍 rescued/3.1.2',
    getBatch('batch-edge').routes.find((r) => r.modelId === 'gw-e300')!.reachedVersion === '3.1.2');
}

console.log('G) 两名值班员并发：后到者基线过期 -> 冲突，修改被拒绝');
{
  // 当前甲刚把 X100@3.2.0 顶到 r2；模拟乙拿着 r1 提交
  dispatch(updatePrerequisites({
    modelId: 'gw-x100', version: '3.2.0', prerequisites: ['3.1.9'],
    baseRevision: 1, actor: '值班员-乙'
  }));
  check('产生冲突横幅', state.conflict !== null && state.conflict!.actor === '值班员-乙');
  check('冲突指名先到者 值班员-甲', state.conflict!.winner === '值班员-甲');
  const node = state.firmware.find((n) => n.modelId === 'gw-x100' && n.version === '3.2.0')!;
  check('被拒绝的旧值没有写回（前置仍为 3.0.0）', node.prerequisites.join(',') === '3.0.0');
}

console.log('H) 模拟对班先提交（演示按钮）会抬高修订号并触发未下发路线重算');
{
  const revBefore = state.graphRevision;
  dispatch(simulateConcurrentEdit({ modelId: 'gw-e300', version: '3.0.0', actor: '值班员-乙' }));
  check('修订号再 +1', state.graphRevision === revBefore + 1);
  const node = state.firmware.find((n) => n.modelId === 'gw-e300' && n.version === '3.0.0')!;
  check('节点记录最后修改人', node.lastEditor === '值班员-乙');
  // 已完成路线依旧冻结
  check('batch-edge 仍 completed', getBatch('batch-edge').status === 'completed');
}

console.log('I) 紧急回滚：已刷好的机型保留结果，未刷步骤作废');
{
  // 新造一个进行中的批次再回滚
  dispatch(createBatch({
    actor: '发布负责人',
    input: { name: '验证批次-回滚', firmware: '3.1.2', rollbackVersion: '2.8.1', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 5 }
  }));
  const created = state.batches[0];
  dispatch(approveBatch({ id: created.id, actor: '发布负责人' }));
  dispatch(resumeBatch({ id: created.id, actor: '发布负责人' }));
  for (let i = 0; i < 2; i++) dispatch(telemetryTick());
  dispatch(rollbackBatch({ id: created.id, actor: '发布负责人' }));
  const rb = state.batches.find((b) => b.name === '验证批次-回滚')!;
  check('批次 rolled_back', rb.status === 'rolled_back');
  check('存在 done 步骤（已刷好的保留）', rb.routes.some((r) => r.steps.some((s) => s.status === 'done')));
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed) process.exit(1);
