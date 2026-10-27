const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
let scenarios = [];
let active = null;
let selected = [];
const stateLabels = {
  CHECKED_SCOPE_CLEAR: ['已检查范围无冲突', 'clear'], ISSUES_FOUND: ['发现空间问题', 'issues'],
  INCOMPLETE: ['数据不完整', 'incomplete'], NOT_CHECKED: ['尚未检查', 'empty'],
};
const ruleLabels = { 'rack.space.room_bounds': '机房边界', 'rack.space.obstacles': '障碍冲突', 'rack.space.rack_collision': '柜间碰撞' };
const issueLabels = { RACK_OUTSIDE_ROOM: '机柜超出机房边界', RACK_OBSTACLE_CONFLICT: '机柜触碰或重叠障碍', RACK_PAIR_OVERLAP: '机柜占地发生重叠' };
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function nameOf(id) { return active.input.placements.find(rack => rack.rackId === id)?.name ?? id; }
function idsOf(diagnostic) { return diagnostic.rackIds ?? [diagnostic.rackId]; }
function chooseRack(ids) { selected = ids; renderCanvas(); renderDetails(); }
function activate(id) {
  active = scenarios.find(item => item.id === id);
  selected = active.input.placements.length ? [active.input.placements[0].rackId] : [];
  for (const button of $('scenarios').children) button.setAttribute('aria-current', String(button.dataset.id === id));
  $('case-title').textContent = active.title;
  $('case-description').textContent = active.description;
  const [label, tone] = stateLabels[active.report.status];
  $('status').className = `status status-${tone}`;
  $('status').textContent = label;
  $('metrics').replaceChildren(...[
    ['机柜数量', active.report.summary.racksChecked, '台'], ['已检查机柜对', active.report.summary.pairsChecked, '对'],
    ['发生碰撞', active.report.summary.collidingPairs, '对'], ['空间问题', active.report.diagnostics.length, '项'],
  ].map(([label, value, unit]) => {
    const node = element('div', 'metric');
    const number = element('span', 'metric-value', value);
    number.append(element('small', '', unit));
    node.append(element('span', 'metric-label', label), number);
    return node;
  }));
  renderCanvas(); renderDetails(); renderDiagnostics();
  $('rule-checks').replaceChildren(...active.report.checks.map(check => {
    const icon = check.status === 'PASS' ? '✓' : check.status === 'FAIL' ? '×' : '—';
    return element('span', `rule-chip ${check.status === 'FAIL' ? 'fail' : check.status === 'NOT_CHECKED' ? 'unknown' : ''}`, `${icon} ${ruleLabels[check.ruleId]}${check.status === 'NOT_CHECKED' ? '（未检查）' : ''}`);
  }));
  $('raw-json').textContent = JSON.stringify(active.report, null, 2);
}
function renderCanvas() {
  const canvas = $('floorplan');
  const bounds = active.input.room.boundaryM;
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const x = world => world - bounds.minX;
  const y = world => bounds.maxY - world;
  const rect = (value, className) => svg('rect', { x: x(value.minX), y: y(value.maxY), width: value.maxX - value.minX, height: value.maxY - value.minY, class: className });
  canvas.replaceChildren();
  canvas.setAttribute('viewBox', `-1 -0.9 ${width + 2} ${height + 2}`);
  const defs = svg('defs');
  const pattern = svg('pattern', { id: 'obstacle-pattern', width: .16, height: .16, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  pattern.append(svg('rect', { width: .16, height: .16, fill: '#f1eadf' }), svg('line', { x1: 0, y1: 0, x2: 0, y2: .16, stroke: '#c6b99e', 'stroke-width': .035 }));
  defs.append(pattern); canvas.append(defs, rect(bounds, 'room-floor'));
  for (let index = 1; index < width; index++) canvas.append(svg('line', { x1: index, y1: 0, x2: index, y2: height, class: 'grid-line' }));
  for (let index = 1; index < height; index++) canvas.append(svg('line', { x1: 0, y1: index, x2: width, y2: index, class: 'grid-line' }));
  for (let index = 0; index <= width; index++) canvas.append(svg('text', { x: index, y: height + .4, class: 'dimension-label' }, index));
  for (let index = 0; index <= height; index++) canvas.append(svg('text', { x: -.38, y: height - index + .07, class: 'dimension-label' }, index));
  canvas.append(svg('text', { x: width / 2, y: -.35, class: 'dimension-label' }, `${width} m`), svg('text', { x: width + .25, y: height + .4, class: 'axis-label' }, 'X →'), svg('text', { x: -.6, y: -.35, class: 'axis-label' }, 'Y ↑'));
  for (const obstacle of active.input.room.obstacles) {
    canvas.append(rect(obstacle.boundsM, 'obstacle-shape'), svg('text', { x: x((obstacle.boundsM.minX + obstacle.boundsM.maxX) / 2), y: y(obstacle.boundsM.maxY) - .15, class: 'obstacle-label' }, '障碍区'));
  }
  const issues = new Set(active.report.diagnostics.flatMap(idsOf));
  for (const rack of active.input.placements) {
    const footprint = active.footprints.find(item => item.rackId === rack.rackId);
    const group = svg('g', { class: `rack${issues.has(rack.rackId) ? ' has-issue' : ''}${selected.includes(rack.rackId) ? ' is-selected' : ''}`, role: 'button', tabindex: 0, 'aria-label': `选择 ${rack.name}`, 'aria-pressed': selected.includes(rack.rackId) });
    const [a, b] = footprint.frontEdgeM;
    group.append(svg('title', {}, `${rack.name} · (${rack.xM}, ${rack.yM}) m`), rect(footprint.boundsM, 'rack-rect'), svg('line', { x1: x(a[0]), y1: y(a[1]), x2: x(b[0]), y2: y(b[1]), class: 'rack-front' }), svg('text', { x: x(rack.xM), y: y(rack.yM) + .06, class: 'rack-label' }, rack.name.replace('Rack ', '')));
    group.addEventListener('click', () => chooseRack([rack.rackId]));
    group.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseRack([rack.rackId]); }
    });
    canvas.append(group);
  }
  for (const finding of active.report.diagnostics.filter(item => item.code === 'RACK_PAIR_OVERLAP')) canvas.append(rect(finding.evidence.overlapBoundsM, 'overlap-shape'));
  if (!active.input.placements.length) canvas.append(svg('text', { x: width / 2, y: height / 2, class: 'dimension-label' }, '当前清单为空 · 未检查'));
}
function renderDetails() {
  const rack = active.input.placements.find(item => item.rackId === selected[0]);
  $('selection-count').textContent = selected.length > 1 ? `已定位 ${selected.length} 台` : '';
  const detail = $('rack-detail');
  detail.replaceChildren();
  if (!rack) detail.append(element('p', 'empty-note', '此场景没有机柜。切换左侧场景查看布局。'));
  else {
    const model = active.input.models.find(item => item.modelId === rack.modelId);
    detail.append(element('div', 'rack-name', rack.name));
    if (selected.length > 1) detail.append(element('p', 'empty-note', `同时定位：${selected.slice(1).map(nameOf).join(' / ')}。下方为 ${rack.name} 的属性。`));
    const list = element('dl', 'properties');
    for (const [label, value] of [['中心位置', `(${rack.xM}, ${rack.yM}) m`], ['方向', `${rack.rotationDeg}°`], ['占地尺寸', `${model.widthM} × ${model.depthM} m`], ['安装容量', `${model.heightU} U`]]) {
      const row = element('div', 'property'); row.append(element('dt', '', label), element('dd', '', value)); list.append(row);
    }
    detail.append(list);
  }
  $('rack-list').replaceChildren(...active.input.placements.map(item => {
    const button = element('button', 'rack-choice', item.name.replace('Rack ', ''));
    button.setAttribute('aria-pressed', String(selected.includes(item.rackId)));
    button.addEventListener('click', () => chooseRack([item.rackId]));
    return button;
  }));
}
function renderDiagnostics() {
  $('issue-count').textContent = `${active.report.diagnostics.length} 项`;
  const container = $('diagnostics');
  container.replaceChildren();
  if (!active.report.diagnostics.length) {
    const message = active.report.status === 'CHECKED_SCOPE_CLEAR' ? '已提供的数据在三项空间规则下未发现冲突。' : active.report.status === 'INCOMPLETE' ? '已知机柜未发现冲突，但清单不完整，检查范围不足。' : '没有提供机柜，尚未执行布局检查。';
    container.append(element('p', `empty-note${active.report.status === 'CHECKED_SCOPE_CLEAR' ? ' success-note' : ''}`, message));
  }
  for (const finding of active.report.diagnostics) {
    const ids = idsOf(finding);
    const button = element('button', 'diagnostic');
    button.append(element('strong', '', issueLabels[finding.code]), element('span', '', ids.map(nameOf).join(' ↔ ')), element('small', '', finding.code === 'RACK_PAIR_OVERLAP' ? '点击定位两个机柜及红色重叠区域' : '点击定位对应机柜'));
    button.addEventListener('click', () => chooseRack(ids));
    container.append(button);
  }
}
try {
  const response = await fetch('/data.json');
  if (!response.ok) throw new Error('Preview data request failed.');
  const data = await response.json();
  scenarios = data.cases;
  $('scenarios').replaceChildren(...scenarios.map((item, index) => {
    const button = element('button', 'scenario');
    button.dataset.id = item.id;
    button.append(element('span', 'scenario-number', String(index + 1).padStart(2, '0')), element('span', '', item.title));
    button.addEventListener('click', () => activate(item.id));
    return button;
  }));
  activate(scenarios[0].id);
} catch {
  $('load-error').hidden = false;
  $('load-error').textContent = '无法加载本地预览。请确认 npm run rack:preview 仍在运行，然后刷新页面。';
}
