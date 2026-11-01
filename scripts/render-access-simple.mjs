// Reproduce the presentation diagram. Requires sharp in NODE_PATH.
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const sharp = createRequire(import.meta.url)('sharp');
const output = fileURLToPath(new URL('../presentation-assets/access-control-simple-16x9', import.meta.url));
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const runs = value => (String(value).match(/[\x00-\x7F]+|[^\x00-\x7F]+/g) ?? [])
  .map(run => `<tspan font-family="${/^[\x00-\x7F]+$/.test(run) ? 'Arial' : 'SimHei'}">${esc(run)}</tspan>`).join('');
const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900" role="img" aria-labelledby="title desc">
<title id="title">认证与权限管理架构 · 简明版</title>
<desc id="desc">用户请求经过身份认证、当前项目的权限检查后进入 Rack 业务与数据。上方仅展示 Viewer、Editor、Administrator 三个项目角色名称。Project access 维护成员角色与状态。</desc>
<defs><marker id="arrow" markerWidth="11" markerHeight="11" refX="9" refY="5.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 L11 5.5 L0 11 Z" fill="#52677f"/></marker></defs>
<rect width="1600" height="900" fill="#fff"/>`];
function text(x, y, value, size = 26, color = '#52677f', anchor = 'middle') {
  parts.push(`<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" fill="${color}">${runs(value)}</text>`);
}
function line(points, dashed = false) {
  parts.push(`<polyline points="${points}" fill="none" stroke="#52677f" stroke-width="3" stroke-linejoin="round" marker-end="url(#arrow)"${dashed ? ' stroke-dasharray="8 7"' : ''}/>`);
}
function box(x, y, w, h, title, details, kind = 'blue', titleSize = 34) {
  const [fill, stroke] = kind === 'green' ? ['#edf8f3', '#41866d'] : kind === 'gray' ? ['#f5f7fa', '#a0adbd'] : ['#edf4ff', '#4675bc'];
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
  const top = y + h / 2 - details.length * 20 + 11;
  text(x + w / 2, top, title, titleSize, '#172b46');
  details.forEach((v, i) => text(x + w / 2, top + (i + 1) * 40, v));
}
text(60, 85, '认证与权限管理架构 · 简明版', 46, '#172b46', 'start');
text(60, 134, '先确认用户身份，再检查当前项目允许的操作。', 28, '#52677f', 'start');
// Default project-role presets feed one server-side permission decision.
box(110, 240, 340, 100, 'Viewer', [], 'gray');
box(630, 240, 340, 100, 'Editor', [], 'gray');
box(1150, 240, 340, 100, 'Administrator', [], 'gray');
parts.push('<path d="M280 340 V390 H1320 V340 M800 340 V390" fill="none" stroke="#a0adbd" stroke-width="2" stroke-dasharray="8 7"/>');
line('940,390 940,470', true);
text(1110, 431, '默认角色 → 权限键', 24);
// Keep the main request path to four nodes.
line('320,545 410,545');
line('690,545 780,545');
line('1100,545 1190,545');
text(365, 516, '请求', 23);
text(735, 516, '身份', 23);
text(1145, 516, '允许', 23);
box(60, 470, 260, 150, '用户 / 工作台', ['登录后发起操作']);
box(410, 470, 280, 150, '身份认证', ['会话与 Token 校验', '确定 userId']);
box(780, 470, 320, 150, '项目权限检查', ['用户 + 项目 + 操作', '匹配有效权限键']);
box(1190, 470, 350, 150, 'Rack 业务与数据', ['执行读取或修改', '规则检查与事务保存'], 'green');
line('940,710 940,620', true);
text(1160, 673, '更新成员角色与状态', 24);
box(720, 710, 440, 100, 'Project access', ['授权管理员管理成员'], 'gray', 30);
text(60, 862, '角色按项目分配；图示为默认预设，有效权限还可能来自组织或全局授权。', 26, '#52677f', 'start');
parts.push('</svg>');
const svg = parts.join('\n');
await writeFile(output + '.svg', svg);
await sharp(Buffer.from(svg)).resize(3200, 1800).png().toFile(output + '.png');
console.log('Access diagram generated: SVG 1600x900; PNG 3200x1800.');
