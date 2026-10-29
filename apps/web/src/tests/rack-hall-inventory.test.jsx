import {test} from 'vitest';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {RackHallInventory} from '../rack/RackHallInventory.jsx';

const placements=[{rackId:'a',name:'A01',modelId:'m',locked:true},{rackId:'b',name:'B01',modelId:'m',locked:false}];
const models=[{modelId:'m',heightU:42}];
const equipment={devices:[{deviceId:'d',name:'GPU <server>',heightU:4,startU:1,rackId:'a',catalogRef:{modelId:'demo-gpu-4u'}},
  {deviceId:'e',name:'Switch',heightU:1,startU:1,rackId:'b',catalogRef:{modelId:'demo-tor-1u'}},
  {deviceId:'f',name:'Unknown',rackId:null}]};
const resource={total:3,knownSubtotal:3,limit:3,status:'WITHIN_LIMIT'};
const report={racks:[{rackId:'a',capacities:{powerKw:resource}},{rackId:'b',capacities:{powerKw:{...resource,total:1}}}]};
const render=patch=>renderToStaticMarkup(<RackHallInventory placements={placements} models={models} equipment={equipment} report={report} {...patch}/>);

test('hall overview separates installed/pending identities and model counts; groups are display names only',()=>{
  const html=render({});
  for(const text of ['2 个机柜','2 台已安装','1 台待上架','1 个锁定柜','GPU服务器：1','ToR交换机：1','其他／自定义：1','不是空间分区或网络拓扑','A 组','B 组']) assert.ok(html.includes(text),text);
  assert.ok(!html.includes('rack-u-slot'));
});

test('selected rack renders only its read-only elevation and escapes inventory labels',()=>{
  const html=render({selectedId:'a'});
  assert.ok(html.includes('GPU &lt;server&gt;'));assert.ok(!html.includes('>Switch</button>'));
  assert.equal((html.match(/class="rack-u-slot(?: |")/g)||[]).length,42);
  assert.ok(html.includes('aria-pressed="true"'));assert.ok(html.includes('data-load="high"'));
  assert.ok(html.includes('管理设备与 U 位'));
});

test('pending reports do not invent load and arbitrary names remain escaped without a semantic row',()=>{
  const html=render({report:null,placements:[{...placements[0],name:'Custom <rack>'}],selectedId:'a'});
  assert.ok(html.includes('Not checked'));assert.ok(html.includes('data-load="unknown"'));
  assert.ok(html.includes('Custom &lt;rack&gt;'));assert.ok(html.includes('其他 组'));
});
