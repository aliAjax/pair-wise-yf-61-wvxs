/**
 * 核心路线逻辑验证（直接用 tsx 跑 planner，不经过 UI）：
 *   npx tsx scripts/verify-planner.ts
 */
import { SEED_FIRMWARE, SEED_GROUPS, SEED_MODELS } from '../src/app/state/firmware.seed';
import { planGroupRoutes, planTail, findPath } from '../src/app/state/firmware.planner';
import type { FirmwareNode, UpgradeRoute } from '../src/app/state/release.models';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✘ ${name} ${detail}`); }
}
const model = (id: string) => SEED_MODELS.find((m) => m.id === id)!;
const group = (id: string) => SEED_GROUPS.find((g) => g.id === id)!;

console.log('1) 分组内每种机型分别算路，跨大版本走过渡版');
{
  const routes = planGroupRoutes(SEED_FIRMWARE, SEED_MODELS, group('g-edge'), '3.1.2', '2.8.1', 1);
  check('华东分组算出 2 条路线（E300 + X100）', routes.length === 2);
  const e300 = routes.find((r) => r.modelId === 'gw-e300')!;
  check('E300 状态 planned', e300.status === 'planned');
  check('E300 经过过渡版 2.9.0', e300.steps.some((s) => s.toVersion === '2.9.0' && s.kind === 'transitional'));
  check('E300 链条终点 3.1.2', e300.steps.at(-1)!.toVersion === '3.1.2');
  const x100 = routes.find((r) => r.modelId === 'gw-x100')!;
  check('X100 状态 planned', x100.status === 'planned');
}

console.log('2) 换过主板的网关先补引导程序');
{
  const routes = planGroupRoutes(SEED_FIRMWARE, SEED_MODELS, group('g-edge'), '3.1.2', '2.8.1', 1);
  const x100 = routes.find((r) => r.modelId === 'gw-x100')!;
  check('X100 第一步是引导程序 boot-1.2', x100.steps[0].toVersion === 'boot-1.2' && x100.steps[0].kind === 'bootloader');
  check('X100 引导之后走 2.6.0 过渡', x100.steps.some((s) => s.toVersion === '2.6.0' && s.kind === 'transitional'));
  // 未换主板的 E300 不带引导步骤
  const e300 = routes.find((r) => r.modelId === 'gw-e300')!;
  check('未换主板的 E300 无引导步骤', !e300.steps.some((s) => s.kind === 'bootloader'));
}

console.log('3) 缺环节退回草稿并指名缺失版本');
{
  const g = { ...group('g-edge'), fleet: group('g-edge').fleet.filter((f) => f.modelId === 'gw-x100') };
  const routes = planGroupRoutes(SEED_FIRMWARE, SEED_MODELS, g, '3.2.0', '2.8.2', 1);
  const x100 = routes[0];
  check('X100→3.2.0 状态 blocked', x100.status === 'blocked');
  check('指名缺失的 3.1.9', x100.blockingGaps.some((gap) => gap.includes('3.1.9')), JSON.stringify(x100.blockingGaps));
  check('说明引用方 3.2.0', x100.blockingGaps.some((gap) => gap.includes('3.2.0')));
}

console.log('4) 可绕行的缺失引用不被误报为缺口');
{
  const routes = planGroupRoutes(SEED_FIRMWARE, SEED_MODELS, group('g-clinic'), '3.4.2', '3.3.0', 1);
  const c8 = routes[0];
  check('诊疗终端 3.4.2 可达，状态 planned', c8.status === 'planned');
  check('链条为 3.2.1→3.3.0→3.4.2，绕过缺 3.3.5 的 3.4.0',
    c8.steps.map((s) => s.toVersion).join(',') === '3.3.0,3.4.2', c8.steps.map((s) => s.toVersion).join(','));
}

console.log('5) 失败后从已到版本避开失败边，另找回稳路线');
{
  // E300 已刷到 2.8.1（未推进），2.8.1->2.9.0 这条边刚失败
  let result = planTail(SEED_FIRMWARE, model('gw-e300'),
    { fromVersion: '2.8.1', targetVersion: '3.1.2', rollbackVersion: '2.8.1' },
    '2.8.1', new Set(['2.8.1->2.9.0']), true);
  check('避开失败边后仍找到路', result.path !== null);
  check('改走并行过渡通道 2.9.1', result.path!.includes('2.9.1') && !result.path!.includes('2.9.0'), JSON.stringify(result.path));
  check('仍能到原目标 3.1.2', result.path!.at(-1) === '3.1.2');

  // 两条过渡通道都断掉：先回滚到稳定版 2.8.1（原地）或最近稳定
  result = planTail(SEED_FIRMWARE, model('gw-e300'),
    { fromVersion: '2.8.1', targetVersion: '3.1.2', rollbackVersion: '2.7.9' },
    '2.8.1', new Set(['2.8.1->2.9.0', '2.8.1->2.9.1']), true);
  check('双过渡通道全断时回退到稳定版 2.7.9', result.path !== null && result.path.at(-1) === '2.7.9', JSON.stringify(result.path));
}

console.log('6) 依赖关系改动后未下发路线立即重算（模拟 editPrerequisites 3.2.0 的前置改为 3.0.0）');
{
  const patched: FirmwareNode[] = SEED_FIRMWARE.map((node) =>
    node.modelId === 'gw-x100' && node.version === '3.2.0'
      ? { ...node, prerequisites: ['3.0.0'] }
      : node
  );
  const result = planTail(patched, model('gw-x100'),
    { fromVersion: '2.4.0', targetVersion: '3.2.0', rollbackVersion: '2.8.2' },
    '2.4.0', new Set(), false);
  check('补边后原目标 3.2.0 可达', result.path !== null && result.path.at(-1) === '3.2.0', JSON.stringify(result.path));
  check('路径串起过渡版 2.6.0、2.9.1', result.path!.includes('2.6.0') && result.path!.includes('2.9.1'));
}

console.log('7) 刷好的设备结果保留：从 reachedVersion=3.0.0 重算只给尾巴');
{
  const result = planTail(SEED_FIRMWARE, model('gw-e300'),
    { fromVersion: '2.8.1', targetVersion: '3.1.2', rollbackVersion: '2.8.1' },
    '3.0.0', new Set(), false);
  check('从 3.0.0 只需一步到 3.1.2', result.path!.join('->') === '3.0.0->3.1.2', JSON.stringify(result.path));
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed) process.exit(1);
