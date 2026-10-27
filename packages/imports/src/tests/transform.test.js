import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTransform, fitAffine2D, fitSimilarity2D, resolveTransform, unitFactor } from '../transform.js';

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} !~ ${expected}`);

test('units convert through metres and an unknown unit is refused', () => {
  close(unitFactor('m', 'mm'), 1000);
  close(unitFactor('ft', 'm'), 0.3048);
  assert.throws(() => unitFactor('cubits', 'm'), (error) => error.constraintId === 'import.units.unconfirmed');
});

test('IDENTITY leaves a coordinate untouched', () => {
  const resolved = resolveTransform({ method: 'IDENTITY', sourceCrs: 'EPSG:3857', targetCrs: 'EPSG:3857' });
  assert.deepEqual(applyTransform(resolved.method, resolved.parameters, [10, 20]), [10, 20]);
});

test('UNIT_SCALE records the factor', () => {
  const resolved = resolveTransform({ method: 'UNIT_SCALE', sourceUnits: 'mm', targetUnits: 'm' });
  close(resolved.parameters.factor, 0.001);
  close(applyTransform('UNIT_SCALE', resolved.parameters, [1000, 2000])[0], 1);
});

test('SIMILARITY_2D recovers a known scale, rotation, and translation exactly', () => {
  // 90 degree rotation, scale 2, translate (5, -3).
  const apply = ([x, y]) => [2 * (0 * x - 1 * y) + 5, 2 * (1 * x + 0 * y) - 3];
  const sources = [[0, 0], [1, 0], [0, 1], [2, 3]];
  const controlPoints = sources.map((source) => ({ source, target: apply(source), reviewState: 'REVIEWED' }));

  const { parameters, residualErrorM } = fitSimilarity2D(controlPoints);
  close(residualErrorM, 0, 1e-9);
  close(parameters.a, 0, 1e-9);
  close(parameters.b, 2, 1e-9);
  for (const [x, y] of sources) {
    const [u, v] = applyTransform('SIMILARITY_2D', parameters, [x, y]);
    close(u, apply([x, y])[0], 1e-9);
    close(v, apply([x, y])[1], 1e-9);
  }
});

test('a residual above tolerance is reported, not swallowed', () => {
  const controlPoints = [
    { source: [0, 0], target: [0, 0], reviewState: 'REVIEWED' },
    { source: [1, 0], target: [1, 0], reviewState: 'REVIEWED' },
    { source: [0, 1], target: [0.5, 1], reviewState: 'REVIEWED' },
  ];
  const resolved = resolveTransform({ method: 'SIMILARITY_2D', controlPoints, toleranceM: 0.05 });
  assert.ok(resolved.residualErrorM > 0);
  assert.deepEqual(resolved.diagnostics.map((entry) => entry.constraintId), ['import.transform.residual_exceeded']);
});

test('AFFINE_2D recovers a shear that a similarity cannot', () => {
  const sources = [[0, 0], [1, 0], [0, 1], [2, 2]];
  const controlPoints = sources.map((source) => ({
    source,
    target: [source[0] + 0.5 * source[1], source[1]],
    reviewState: 'REVIEWED',
  }));
  const { parameters, residualErrorM } = fitAffine2D(controlPoints);
  close(residualErrorM, 0, 1e-9);
  const [u, v] = applyTransform('AFFINE_2D', parameters, [2, 4]);
  close(u, 4, 1e-9);
  close(v, 4, 1e-9);
});

test('too few or collinear control points are insufficient, never guessed', () => {
  assert.throws(
    () => resolveTransform({ method: 'SIMILARITY_2D', controlPoints: [{ source: [0, 0], target: [0, 0], reviewState: 'REVIEWED' }] }),
    (error) => error.constraintId === 'import.transform.control_points_insufficient',
  );
  assert.throws(
    () =>
      resolveTransform({
        method: 'AFFINE_2D',
        controlPoints: [
          { source: [0, 0], target: [0, 0], reviewState: 'REVIEWED' },
          { source: [1, 1], target: [1, 1], reviewState: 'REVIEWED' },
          { source: [2, 2], target: [2, 2], reviewState: 'REVIEWED' },
        ],
      }),
    (error) => error.constraintId === 'import.transform.control_points_insufficient',
  );
});

test('a projection or datum change requires a provider and a declared CRS', () => {
  assert.throws(
    () => resolveTransform({ method: 'PROJECTION_CHANGE', targetCrs: 'EPSG:3857' }),
    (error) => error.constraintId === 'import.transform.control_points_insufficient',
  );
  const resolved = resolveTransform({ method: 'PROJECTION_CHANGE', sourceCrs: 'EPSG:4326', targetCrs: 'EPSG:3857' });
  assert.equal(resolved.requiresProvider, true);
  assert.equal(resolved.residualErrorM, null);
});

test('the control-point limit is enforced', () => {
  const many = Array.from({ length: 101 }, (_, index) => ({ source: [index, 0], target: [index, 0], reviewState: 'REVIEWED' }));
  assert.throws(
    () => resolveTransform({ method: 'SIMILARITY_2D', controlPoints: many, maxControlPoints: 100 }),
    (error) => error.constraintId === 'import.conversion.incomplete',
  );
});
