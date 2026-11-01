// Generate only the simplified diagram; preserve the original diagram assets.
// Run with sharp available in NODE_PATH.
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const output = new URL('../presentation-assets/assistant-architecture-simple-16x9', import.meta.url);
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
// Explicit language runs keep Chinese in SimHei and Latin in Arial when editing.
const runs = value => (String(value).match(/[\x00-\x7F]+|[^\x00-\x7F]+/g) ?? [])
  .map(run => `<tspan font-family="${/^[\x00-\x7F]+$/.test(run) ? 'Arial' : 'SimHei'}">${esc(run)}</tspan>`).join('');
const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900" role="img" aria-labelledby="title desc">
<title id="title">Assistant 集成架构 · 简明版</title>
<desc id="desc">用户通过聊天界面向后端发送请求，后端结合项目知识和模型调用受控 Rack 工具与业务服务，由服务读取或保存方案数据，并记录会话。中文黑体，英文 Arial。</desc>
<defs><marker id="arrow" markerWidth="11" markerHeight="11" refX="9" refY="5.5" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0 0 L11 5.5 L0 11 Z" fill="#52677f"/></marker></defs>
<rect width="1600" height="900" fill="#fff"/>`];
function text(x, y, value, size = 26, color = '#52677f', anchor = 'middle') {
  parts.push(`<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" fill="${color}" font-family="Arial, SimHei">${runs(value)}</text>`);
}
function line(points, { both = false, dashed = false } = {}) {
  parts.push(`<polyline points="${points}" fill="none" stroke="#52677f" stroke-width="3" stroke-linejoin="round" marker-end="url(#arrow)"${both ? ' marker-start="url(#arrow)"' : ''}${dashed ? ' stroke-dasharray="8 7"' : ''}/>`);
}
function box(x, y, w, h, title, details, green = false, gray = false) {
  const fill = gray ? '#f5f7fa' : green ? '#edf8f3' : '#edf4ff';
  const stroke = gray ? '#a0adbd' : green ? '#41866d' : '#4675bc';
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
  const top = y + h / 2 - details.length * 20 + 11;
  text(x + w / 2, top, title, 34, '#172b46');
  details.forEach((value, i) => text(x + w / 2, top + (i + 1) * 40, value, 26));
}
text(60, 85, 'Assistant 集成架构 · 简明版', 46, '#172b46', 'start');
text(60, 134, '用户提需求，模型理解，后端执行与校验。', 28, '#52677f', 'start');
// Main request/result path.
line('300,505 420,505', { both: true });
line('720,505 830,505', { both: true });
line('1130,505 1240,505', { both: true });
text(360, 477, '请求/回复', 23);
text(775, 477, '调用/结果', 23);
text(1185, 477, '读取/保存', 23);
// Knowledge input, model exchange and durable conversation records.
line('510,300 510,420', { dashed: true });
text(470, 370, '注入', 24);
line('980,300 980,350 650,350 650,420', { both: true });
text(820, 329, '模型调用 / 工具请求', 24);
line('570,590 570,660', { both: true, dashed: true });
text(623, 635, '存取', 23);
box(60, 420, 240, 170, '聊天界面', ['Ask about Rack']);
box(420, 420, 300, 170, 'Assistant 后台', ['身份校验 · 工具编排']);
box(830, 420, 300, 170, 'Rack 工具与服务', ['查询 / 预览 / 应用', '权限与规则检查'], true);
box(1240, 420, 300, 170, '方案数据', ['PostgreSQL / PostGIS', '方案版本与布局'], true);
box(365, 180, 290, 120, 'Rack 项目知识', ['领域指令 + 当前 Plan'], false, true);
box(830, 180, 300, 120, '模型服务', ['个人 API 连接'], false, true);
box(420, 660, 300, 110, '会话记录', ['数据库索引 + RustFS'], false, true);
text(60, 820, '修改经过权限检查、必要确认与事务保存；模型不直接写数据库。', 27, '#172b46', 'start');
text(60, 865, '实线：请求与返回    虚线：知识注入与会话记录    API Key 仅由后端使用', 24, '#52677f', 'start');
parts.push('</svg>');
const svg = parts.join('\n');
await writeFile(fileURLToPath(output) + '.svg', svg);
await sharp(Buffer.from(svg)).resize(3200, 1800).png().toFile(fileURLToPath(output) + '.png');
console.log('Simplified diagram: SVG1600x900, PNG3200x1800. Original assets preserved.');
