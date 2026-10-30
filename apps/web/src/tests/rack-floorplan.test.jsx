import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoomFloorplan } from '../rack/RackRoomView.jsx';
import { boundaryPath, fitRoom, gridLines, niceMetres, panCamera, toLocal, toScreen, zoomCamera } from '../rack/floorplan-view.js';

const extent = {width:10,height:8};
const boundary = {type:'Polygon',coordinates:[[[0,0],[10,0],[10,8],[0,8],[0,0]],[[1,1],[2,1],[2,2],[1,2],[1,1]]]};
test('floorplan fit uses uniform scaling and inverts only screen Y', () => {
  const camera = fitRoom(extent);
  assert.deepEqual(toScreen([5,4],camera),[400,220]);
  const east = toScreen([6,4],camera), north = toScreen([5,5],camera);
  assert.equal(east[0]-400,220-north[1]);
  assert.deepEqual(toLocal(east,camera),[6,4]);
  for (const point of boundary.coordinates[0]) {
    const [x,y] = toScreen(point,camera);
    assert.ok(x>=60 && x<=740 && y>=60 && y<=380);
  }
});
test('zoom preserves the local point under the cursor, clamps zoom and pan moves the view only', () => {
  const camera = fitRoom(extent), anchor = [123,321];
  const before = toLocal(anchor,camera);
  const zoomed = zoomCamera(camera,2,camera.scale,anchor);
  const after = toLocal(anchor,zoomed);
  assert.ok(Math.abs(before[0]-after[0])<1e-12 && Math.abs(before[1]-after[1])<1e-12);
  assert.equal(zoomCamera(camera,1e9,camera.scale).scale,camera.scale*32);
  assert.equal(zoomCamera(camera,1e-9,camera.scale).scale,camera.scale/4);
  assert.deepEqual(toScreen([5,4],panCamera(camera,80,40)),[480,260]);
  assert.equal(camera.cx,5);
});
test('display retains separate polygon paths for holes and grid/scalebar remain bounded at zoom extremes', () => {
  const camera = fitRoom(extent), path = boundaryPath(boundary,camera);
  assert.equal((path.match(/M/g)??[]).length,2);
  assert.equal((path.match(/Z/g)??[]).length,2);
  assert.equal(niceMetres(110/camera.scale)*camera.scale<=110,true);
  for (const factor of [.25,1,32]) {
    const grid = gridLines(zoomCamera(camera,factor,camera.scale));
    assert.ok(grid.stepM>0 && grid.lines.length>0 && grid.lines.length<=200);
    assert.ok(grid.lines.flat().every(Number.isFinite));
  }
});
test('floorplan render labels local units, provenance and unchecked scope without pretending racks exist', () => {
  const html = renderToStaticMarkup(<RoomFloorplan room={{name:'Hall <A>'}} view={{extentM:extent,boundaryLocalM:boundary,
    areaM2:79,interiorRingCount:1,sourceCrs:'EPSG:32618',originProjectedM:[500000,4400000],originDescription:'Outer ring minimum'}}
    sourceGeometry={{geometryId:'g',role:'FLOOR_BOUNDARY',provenanceReference:'dev-seed-facility',transformReviewState:'NOT_RECORDED'}} />);
  for(const text of ['fill-rule="evenodd"','Hall &lt;A&gt;','10.00','8.00','79.00','Synthetic Facility sample','UNKNOWN','NOT_RUN','Grid N','EPSG:32618','Fit room','Coordinates and source']) assert.ok(html.includes(text),text);
  assert.ok(!html.includes('Validated'));
  assert.ok(html.includes('<pattern') && html.includes('Auto-fit dot-grid view'));
  assert.ok(!html.includes('Zoom in floorplan') && !html.includes('Scroll or +'));
});
