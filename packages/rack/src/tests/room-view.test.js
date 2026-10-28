import test from 'node:test';
import assert from 'node:assert/strict';
import { localizeRoomBoundary, MAX_ROOM_VIEW_POINTS, MAX_ROOM_VIEW_RINGS } from '../index.js';

const outer = [[500000,4400000],[500010,4400000],[500010,4400004],[500004,4400004],[500004,4400010],[500000,4400010],[500000,4400000]];
const hole = [[500001,4400001],[500002,4400001],[500002,4400002],[500001,4400002],[500001,4400001]];
const source = (coordinates = [outer, hole]) => ({ geometry: { type: 'Polygon', coordinates }, crs: 'EPSG:32618', srid: 32618, dimensions: 2, valid: true });

test('room display preserves a concave outline and holes, using translation only', () => {
  const input = source();
  const before = structuredClone(input);
  const result = localizeRoomBoundary(input);
  assert.equal(result.status, 'AVAILABLE');
  assert.deepEqual(result.view.originProjectedM, [500000,4400000]);
  assert.deepEqual(result.view.boundaryLocalM.coordinates[0], [[0,0],[10,0],[10,4],[4,4],[4,10],[0,10],[0,0]]);
  assert.deepEqual(result.view.boundaryLocalM.coordinates[1], [[1,1],[2,1],[2,2],[1,2],[1,1]]);
  assert.equal(result.view.areaM2, 63, 'uses polygon area minus holes, not the 100 m² bounding box');
  assert.deepEqual(result.view.extentM, { width: 10, height: 10 });
  assert.equal(result.view.interiorRingCount, 1);
  assert.equal(result.view.obstacleCoverage, 'UNKNOWN');
  assert.equal(result.view.transform, 'TRANSLATE_ONLY');
  assert.deepEqual(input, before);
  assert.ok(Object.isFrozen(result.view.boundaryLocalM.coordinates[0][0]));
});

test('display frame preserves rotation and arbitrary ring winding', () => {
  const ring = [[500000,4400001],[500002,4400000],[500003,4400002],[500001,4400003],[500000,4400001]];
  const forward = localizeRoomBoundary(source([ring]));
  const backward = localizeRoomBoundary(source([ring.toReversed()]));
  assert.equal(forward.view.areaM2, 5);
  assert.equal(backward.view.areaM2, 5);
  assert.deepEqual(forward.view.boundaryLocalM.coordinates[0][0], [0,1]);
  assert.equal(forward.view.sourceCrs, 'EPSG:32618');
});

test('only matching WGS84 UTM definitions have an explicit metre contract', () => {
  for (const srid of [32601,32660,32701,32760]) assert.equal(localizeRoomBoundary({ ...source(), srid, crs: `EPSG:${srid}` }).status, 'AVAILABLE');
  for (const override of [{srid:4326,crs:'EPSG:4326'}, {srid:3857,crs:'EPSG:3857'}, {srid:2263,crs:'EPSG:2263'},
    {srid:32600,crs:'EPSG:32600'}, {srid:32661,crs:'EPSG:32661'}, {crs:'EPSG:32611'}, {srid:'32618'}, {crs:'local-metres'}]) {
    assert.equal(localizeRoomBoundary({ ...source(), ...override }).reason, 'CRS_UNSUPPORTED');
  }
});

test('invalid topology assertion, 3D and other geometry types are refused', () => {
  assert.equal(localizeRoomBoundary({...source(),valid:false}).reason,'INVALID_BOUNDARY');
  assert.equal(localizeRoomBoundary({...source(),valid:null}).reason,'INVALID_BOUNDARY');
  assert.equal(localizeRoomBoundary({...source(),dimensions:3}).reason,'DIMENSION_UNSUPPORTED');
  assert.equal(localizeRoomBoundary({...source(),geometry:{type:'MultiPolygon',coordinates:[[outer]]}}).reason,'GEOMETRY_TYPE_UNSUPPORTED');
});

test('malformed, unclosed, degenerate and nonfinite coordinates never reach the drawing', () => {
  for (const coordinates of [[], [outer.slice(0,-1)], [[[0,0],[1,0],[2,0],[0,0]]],
    [[[0,0],[NaN,0],[0,1],[0,0]]], [[[0,0],[1,Infinity],[0,1],[0,0]]],
    [[[0,0],[1,'2'],[0,1],[0,0]]], [[[0,0,0],[1,0,0],[0,1,0],[0,0,0]]]]) {
    assert.notEqual(localizeRoomBoundary(source(coordinates)).status, 'AVAILABLE');
  }
});

test('geometry complexity and extents are bounded without simplifying a boundary', () => {
  const points = Array.from({length:MAX_ROOM_VIEW_POINTS+1},() => [0,0]);
  assert.equal(localizeRoomBoundary(source([points])).reason,'GEOMETRY_TOO_COMPLEX');
  assert.equal(localizeRoomBoundary(source(Array.from({length:MAX_ROOM_VIEW_RINGS+1},()=>outer))).reason,'GEOMETRY_TOO_COMPLEX');
  assert.equal(localizeRoomBoundary(source([[[0,0],[10001,0],[10001,1],[0,0]]])).reason,'EXTENT_UNSUPPORTED');
});
