import {test} from 'vitest';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {RackWorkbench,RackInspector} from '../rack/RackWorkbench.jsx';
import {equipmentCamera,pointerPosition,dragPosition,deviceKind} from '../rack/workbench-view.js';
import {CANVAS,toScreen,fitRoom} from '../rack/floorplan-view.js';

const model={modelId:'m',name:'Assumed rack',widthM:.8,depthM:1.2,heightU:42};
const rack={rackId:'r',modelId:'m',name:'R <1>',xM:5,yM:5,rotationDeg:90,locked:true};
const devices=[{deviceId:'d',name:'GPU <test>',catalogRef:{modelId:'demo-gpu-4u',version:2},rackId:'r',startU:1,heightU:4,weightKg:null,powerKw:0,coolingKw:3},
  {deviceId:'s',name:'Switch',catalogRef:{modelId:'demo-tor-1u',version:1},rackId:'r',startU:5,heightU:1,weightKg:2,powerKw:.2,coolingKw:.2},
  {deviceId:'u',name:'Unassigned',rackId:null,startU:null,heightU:1,weightKg:null,powerKw:null,coolingKw:null}];
const constraints={obstacles:[{obstacleId:'o',name:'Reserved',xM:8,yM:5,widthM:1,depthM:5}],clearance:{frontM:1,rearM:.6}};
const extent={width:100,height:80};
const snapshot={room:{name:'Hall'},view:{extentM:extent,areaM2:7999,boundaryLocalM:{type:'Polygon',coordinates:[[[0,0],[100,0],[99,80],[0,80],[0,0]],[[1,1],[2,1],[2,2],[1,1]]]}},sourceGeometry:{}};
const props={snapshot,placements:[rack],models:[model],constraints,equipment:{devices},selectedId:'r',isPositionLocked:()=>true,editable:false};

test('inspector provides a write-gated position lock switch and explains pending saved unlocks',()=>{
  const render = patch=>renderToStaticMarkup(<RackInspector rack={rack} model={model} devices={[]} positionLocked editable onUpdate={()=>{}} {...patch}/>);
  assert.match(render({}),/type="checkbox" checked=""/);
  assert.match(render({editable:false}),/type="checkbox" disabled="" checked=""/);
  assert.match(render({rack:{...rack,locked:false}}),/Unlock pending. Save layout/);
  assert.match(render({}),/Position lock \(on = locked\)/);
});

test('inspector only allows deleting an editable unlocked empty rack and explains installed device protection',()=>{
  const render=patch=>renderToStaticMarkup(<RackInspector rack={rack} model={model} devices={[]} editable onRemove={()=>{}} {...patch}/>);
  assert.match(render({}),/class="rack-danger">Remove selected rack/);
  for(const patch of [{editable:false},{positionLocked:true},{devices}])
    assert.match(render(patch),/class="rack-danger" disabled="">Remove selected rack/);
  assert.match(render({devices}),/Unassign or move equipment on the equipment page/);
});

test('equipment viewport fits real rotated footprints and reserved zones without changing input geometry',()=>{
  const before=structuredClone({rack,model,constraints,extent});
  const camera=equipmentCamera([rack],[model],constraints,extent);
  for(const p of [[4.4,4.6],[5.6,5.4],[7.5,2.5],[8.5,7.5]]){const [x,y]=toScreen(p,camera);assert.ok(x>0&&x<CANVAS.width&&y>0&&y<CANVAS.height);}
  assert.deepEqual(equipmentCamera([],[],null,extent),fitRoom(extent));
  assert.deepEqual({rack,model,constraints,extent},before);
});

test('pointer mapping uses uniform SVG scale, including resized and letterboxed full-screen canvases',()=>{
  const camera={cx:50,cy:40,scale:20},point=[53.2,38.7];
  const [x,y]=toScreen(point,camera);
  for(const rect of [{left:10,top:30,width:1600,height:880},{left:7,top:19,width:1200,height:440},{left:5,top:20,width:400,height:600}]) {
    const k=Math.min(rect.width/800,rect.height/440);
    const result=pointerPosition(rect.left+(rect.width-800*k)/2+x*k,rect.top+(rect.height-440*k)/2+y*k,rect,camera);
    assert.ok(Math.abs(result.xM-point[0])<1e-10);assert.ok(Math.abs(result.yM-point[1])<1e-10);
  }
});

test('drag snaps final physical centre and retains the click offset without mutating the initial position',()=>{
  const start={xM:3,yM:4,pointer:{xM:3.2,yM:4.3}},copy=structuredClone(start);
  assert.deepEqual(dragPosition(start,{xM:4.46,yM:3.54},.1),{xM:4.3,yM:3.2});
  assert.deepEqual(dragPosition(start,{xM:4.46,yM:3.54},.5),{xM:4.5,yM:3});
  assert.deepEqual(start,copy);
});

test('inspector shows actual rack members, clickable devices and locked controls without assuming unknown resources',()=>{
  const html=renderToStaticMarkup(<RackInspector rack={rack} model={model} devices={devices} positionLocked editable report={null}/>);
  for(const text of ['R &lt;1&gt;','GPU &lt;test&gt;','Switch','U1–4','U5–5','Not checked','Position locked','disabled="" aria-label="Rotate selected rack"']) {
    if(text.startsWith('disabled')) assert.match(html,/aria-label="Rotate selected rack" disabled=""/); else assert.ok(html.includes(text),text);
  }
  assert.ok(!html.includes('Unassigned'));
  const deviceHtml=renderToStaticMarkup(<RackInspector devices={devices} selectedDevice={devices[0]} rack={rack}/>);
  for(const text of ['GPU server','0 kW','Unknown','demo-gpu-4u · v2'])assert.ok(deviceHtml.includes(text),text);
  assert.ok(!deviceHtml.includes('Switch'));
});

test('pending equipment is distinct from installed equipment and custom devices do not invent a server kind',()=>{
  const pending=renderToStaticMarkup(<RackInspector devices={devices} pending/>);
  assert.ok(pending.includes('Unassigned'));assert.ok(!pending.includes('GPU &lt;test&gt;'));
  assert.deepEqual(deviceKind(devices[1]),['ToR switch','switch']);
  assert.deepEqual(deviceKind(devices[2]),['Equipment','other']);
});

test('studio preserves polygon holes, real area, draft restriction and selected rack while presenting one inspector',()=>{
  const html=renderToStaticMarkup(<RackWorkbench {...props}/>);
  for(const text of ['fill-rule="evenodd"','7999','Equipment area view','Full room','Room overview','Choose Edit layout','Select rack R &lt;1&gt;','Snap','Unknown','NOT_RUN']) {
    if(text==='NOT_RUN')assert.ok(html.includes('Overall engineering validation has not run'));else assert.ok(html.includes(text),text);
  }
  assert.equal((html.match(/aria-label="Object details"/g)||[]).length,1);
  assert.ok(html.includes('data-locked="true"'));
  assert.ok(html.includes('aria-label="New rack model" disabled=""'));
});
