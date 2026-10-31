// Run with sharp available through the local runtime's NODE_PATH.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const output = new URL('../presentation-assets/', import.meta.url);
await mkdir(output, { recursive: true });
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
let parts;
function start(title) {
  parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900" role="img" aria-label="${esc(title)}"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0 0L10 5L0 10Z" fill="#52677f"/></marker></defs><rect width="1600" height="900" fill="white"/><g font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif"><text x="60" y="83" font-size="44" font-weight="700" fill="#172b46">${esc(title)}</text>`];
}
function text(x, y, value, size = 26, color = '#52677f', anchor = 'middle') {
  parts.push(`<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" fill="${color}">${esc(value)}</text>`);
}
function line(points, label, lx, ly, { dashed = false, both = false } = {}) {
  parts.push(`<polyline points="${points.map(p => p.join(',')).join(' ')}" fill="none" stroke="#52677f" stroke-width="2.5" stroke-linejoin="round" ${dashed ? 'stroke-dasharray="8 6"' : ''} marker-end="url(#arrow)" ${both ? 'marker-start="url(#arrow)"' : ''}/>`);
  if (label) text(lx, ly, label, 23);
}
function box(x, y, w, h, title, detail = [], tone = 'blue') {
  const palette = { blue: ['#edf4ff', '#4675bc'], green: ['#edf8f3', '#41866d'], gray: ['#f5f7fa', '#a0adbd'], red: ['#fff4f2', '#cf8f85'] };
  const [fill, stroke] = palette[tone];
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
  const lines = [title, ...detail];
  const top = y + h / 2 - (lines.length - 1) * 19 + 11;
  lines.forEach((value, i) => text(x + w / 2, top + i * 38, value, i ? 25 : 31, i ? '#52677f' : '#172b46'));
}
async function finish(name) {
  const svg = `${parts.join('\n')}</g></svg>`;
  await writeFile(new URL(`${name}.svg`, output), svg);
  await sharp(Buffer.from(svg)).resize(3200, 1800).png().toFile(fileURLToPath(new URL(`${name}.png`, output)));
  console.log(`${name}: SVG 1600x900; PNG 3200x1800`);
}

start('Assistant 集成架构');
// Edges precede boxes so no connector can obscure node text.
line([[250, 425], [310, 425]], 'HTTP', 280, 398, { both: true });
line([[520, 425], [590, 425]], '', 0, 0, { both: true });
line([[870, 425], [950, 425]], '', 0, 0, { both: true });
line([[1180, 425], [1260, 425]], '', 0, 0, { both: true });
line([[730, 250], [730, 350]], '', 0, 0, { both: true });
line([[445, 250], [445, 285], [630, 285], [630, 350]], '', 0, 0, { dashed: true });
line([[1080, 250], [1080, 285], [830, 285], [830, 350]], '', 0, 0, { dashed: true });
line([[730, 500], [730, 610]], '记录', 765, 561, { dashed: true });
line([[1390, 485], [1390, 610]], '读写', 1425, 558, { both: true });
box(60, 365, 190, 120, '聊天界面', ['聊天入口']);
box(310, 365, 210, 120, '聊天 API', ['身份与作用域']);
box(590, 350, 280, 150, 'Assistant 宿主', ['编排与调用校验']);
box(950, 365, 230, 120, '7 个 Rack 工具', ['查询／预览／应用']);
box(1260, 365, 260, 120, 'Rack 业务服务', ['规则检查与保存'], 'green');
box(590, 145, 280, 105, '模型服务', [], 'blue');
box(300, 145, 250, 105, '领域指令', ['当前 Plan 上下文'], 'gray');
box(950, 145, 260, 105, '个人连接', ['模型地址与加密凭证'], 'gray');
box(565, 610, 330, 120, '会话存储', ['DB 索引＋RustFS'], 'gray');
box(1230, 610, 320, 120, 'PostgreSQL', ['PostGIS 空间检查'], 'green');
text(60, 818, '实线：调用与结果    虚线：配置输入与会话记录', 25, '#52677f', 'start');
text(60, 858, '模型通过工具访问业务服务，凭证由后端使用，布局保存复用统一规则。', 25, '#52677f', 'start');
await finish('assistant-architecture-16x9');

start('Assistant 修改指令执行流程');
line([[340, 260], [460, 260]], '', 0, 0);
line([[740, 260], [860, 260]], '允许', 800, 241);
line([[1140, 260], [1260, 260]], '通过', 1200, 241);
line([[1400, 320], [1400, 520]], '', 0, 0);
line([[1260, 580], [1140, 580]], '提案 ID', 1200, 619);
line([[860, 580], [740, 580]], '通过', 800, 559);
line([[460, 580], [340, 580]], '提交', 400, 559);
line([[600, 320], [600, 390]], '越权／只读', 502, 367);
line([[1000, 320], [1000, 390]], '检查失败', 1080, 367);
line([[1000, 520], [1000, 470]], '', 0, 0);
line([[600, 520], [600, 470]], '', 0, 0);
line([[1260, 550], [1190, 550], [1190, 430], [1090, 430]], '拒绝', 1158, 413);
box(60, 200, 280, 120, '修改指令', ['明确目标与参数']);
box(460, 200, 280, 120, '权限与上下文', ['身份／Plan／模式']);
box(860, 200, 280, 120, '读取并预览', ['检查修改后状态']);
box(1260, 200, 280, 120, '保存绑定提案', ['用户与版本 · 30 分钟']);
box(1260, 520, 280, 145, '操作模式', ['Ask：用户确认', 'Full：直接应用']);
box(860, 520, 280, 145, '应用前复核', ['权限／来源／版本', '锁定／空间／容量']);
box(460, 520, 280, 145, '事务保存', ['布局＋版本', '提案应用状态'], 'green');
box(60, 520, 280, 145, '返回并刷新', ['显示保存结果'], 'green');
box(510, 390, 580, 80, '失败或拒绝：返回原因，不改布局', [], 'red');
text(600, 713, '事务失败时回滚', 24);
text(1000, 713, '复核失败时拒绝', 24);
text(60, 817, '上排从左到右，下排从右到左。Full 只跳过确认，仍需复核与事务保存。', 25, '#52677f', 'start');
text(60, 857, '预览只保存提案；成功应用后，同一提案的重复请求不会再次修改布局。', 25, '#52677f', 'start');
await finish('assistant-edit-flow-16x9');
