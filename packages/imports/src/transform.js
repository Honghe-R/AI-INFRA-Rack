import { IMPORT_DIAGNOSTICS } from './diagnostics.js';

/**
 * Units and CRS resolution.
 *
 * The methods and evidence rules from doc/workspace/import-adapters.md, "Units
 * and CRS Resolution" and "Transform Methods". Source values are never marked
 * authoritative here: a fitted transform is provisional until a reviewer accepts
 * it, and a residual above tolerance is reported rather than swallowed.
 *
 * A datum or projection change needs a geodetic provider, which this framework
 * does not embed. Those methods therefore require a declared source CRS and are
 * returned as `requiresProvider`, instead of silently approximating a reprojection
 * with a similarity fit.
 */
export class TransformError extends Error {
  constructor(constraintId, message, details = []) {
    super(message);
    this.name = 'TransformError';
    this.code = constraintId;
    this.constraintId = constraintId;
    this.details = details;
    Object.freeze(this);
  }
}

/** Metres per unit. Source-unit values are retained alongside the conversion. */
export const UNIT_TO_METRES = Object.freeze({
  m: 1,
  metre: 1,
  metre_s: 1,
  mm: 0.001,
  cm: 0.01,
  in: 0.0254,
  ft: 0.3048,
  us_ft: 0.3048006096012192,
  deg: null,
});

export const DEFAULT_RESIDUAL_TOLERANCE_M = 0.05;

export function unitFactor(from, to) {
  const source = UNIT_TO_METRES[String(from ?? '').toLowerCase()];
  const target = UNIT_TO_METRES[String(to ?? '').toLowerCase()];
  if (source === undefined || target === undefined || source === null || target === null) {
    throw new TransformError(
      IMPORT_DIAGNOSTICS.UNITS_UNCONFIRMED.constraintId,
      `Cannot convert from "${from}" to "${to}".`,
      [{ from, to }],
    );
  }
  return source / target;
}

/**
 * Resolves a transform request to a method, its parameters, and the diagnostics a
 * reviewer must see. `maxControlPoints` is enforced per the adapter limits.
 */
export function resolveTransform({
  method,
  sourceCrs = null,
  targetCrs = null,
  sourceUnits = null,
  targetUnits = null,
  controlPoints = [],
  toleranceM = DEFAULT_RESIDUAL_TOLERANCE_M,
  maxControlPoints = 100,
} = {}) {
  if (controlPoints.length > maxControlPoints) {
    throw new TransformError(
      IMPORT_DIAGNOSTICS.CONVERSION_INCOMPLETE.constraintId,
      `At most ${maxControlPoints} control points are permitted.`,
      [{ control_points: controlPoints.length }],
    );
  }

  const diagnostics = [];

  if (method === 'IDENTITY') {
    if (sourceCrs && targetCrs && sourceCrs !== targetCrs) {
      throw new TransformError(IMPORT_DIAGNOSTICS.TRANSFORM_UNREVIEWED.constraintId, 'IDENTITY requires matching source and target CRS.');
    }
    return { method, parameters: {}, residualErrorM: null, requiresProvider: false, diagnostics };
  }

  if (method === 'UNIT_SCALE') {
    const factor = unitFactor(sourceUnits, targetUnits);
    return { method, parameters: { factor }, residualErrorM: factor === 1 ? null : 0, requiresProvider: false, diagnostics };
  }

  if (method === 'PROJECTION_CHANGE' || method === 'HELMERT_7_PARAM') {
    if (!sourceCrs) {
      throw new TransformError(
        IMPORT_DIAGNOSTICS.TRANSFORM_CONTROL_POINTS_INSUFFICIENT.constraintId,
        `${method} requires a declared source CRS.`,
        [{ method }],
      );
    }
    return { method, parameters: { sourceCrs, targetCrs }, residualErrorM: null, requiresProvider: true, diagnostics };
  }

  if (method === 'SIMILARITY_2D' || method === 'CONTROL_POINT_LOCAL') {
    requireControlPoints(controlPoints, 2, method);
    const { parameters, residualErrorM } = fitSimilarity2D(controlPoints);
    return finishDistanceMethod(method, parameters, residualErrorM, toleranceM, diagnostics);
  }

  if (method === 'AFFINE_2D') {
    requireControlPoints(controlPoints, 3, method);
    const { parameters, residualErrorM } = fitAffine2D(controlPoints);
    return finishDistanceMethod(method, parameters, residualErrorM, toleranceM, diagnostics);
  }

  throw new TransformError(IMPORT_DIAGNOSTICS.TRANSFORM_UNREVIEWED.constraintId, `Unknown transform method "${method}".`);
}

function finishDistanceMethod(method, parameters, residualErrorM, toleranceM, diagnostics) {
  if (residualErrorM > toleranceM) {
    diagnostics.push({
      constraintId: IMPORT_DIAGNOSTICS.TRANSFORM_RESIDUAL_EXCEEDED.constraintId,
      message: `The fitted residual ${residualErrorM.toFixed(4)} m exceeds the ${toleranceM} m tolerance.`,
      evidence: { residual_error_m: residualErrorM, tolerance_m: toleranceM },
    });
  }
  return { method, parameters, residualErrorM, requiresProvider: false, diagnostics };
}

function requireControlPoints(controlPoints, minimum, method) {
  const reviewed = controlPoints.filter((point) => point.reviewState === undefined || point.reviewState === 'REVIEWED');
  if (reviewed.length < minimum) {
    throw new TransformError(
      IMPORT_DIAGNOSTICS.TRANSFORM_CONTROL_POINTS_INSUFFICIENT.constraintId,
      `${method} requires at least ${minimum} reviewed control points.`,
      [{ method, reviewed: reviewed.length }],
    );
  }
  if (method === 'AFFINE_2D' && isCollinear(reviewed)) {
    throw new TransformError(
      IMPORT_DIAGNOSTICS.TRANSFORM_CONTROL_POINTS_INSUFFICIENT.constraintId,
      'The control points are collinear and cannot define an affine transform.',
      [{ method }],
    );
  }
}

function isCollinear(points) {
  const [first] = points;
  return points.every((point) => {
    const cross = (point.source[0] - first.source[0]) * (points[1].source[1] - first.source[1])
      - (point.source[1] - first.source[1]) * (points[1].source[0] - first.source[0]);
    return Math.abs(cross) < 1e-12;
  });
}

/**
 * Similarity fit (scale, rotation, translation) by least squares on the complex
 * plane. Two points determine it exactly; more points average the error.
 */
export function fitSimilarity2D(controlPoints) {
  const n = controlPoints.length;
  const mean = (index, key) => controlPoints.reduce((total, point) => total + point[key][index], 0) / n;
  const mx = mean(0, 'source');
  const my = mean(1, 'source');
  const mu = mean(0, 'target');
  const mv = mean(1, 'target');

  let sumConjZ = 0;
  let sumConjZz = 0;
  for (const point of controlPoints) {
    const zx = point.source[0] - mx;
    const zy = point.source[1] - my;
    const wx = point.target[0] - mu;
    const wy = point.target[1] - mv;
    sumConjZ += zx * wx + zy * wy; // Re(conj(z) w)
    sumConjZz += zx * zx + zy * zy;
  }
  if (sumConjZz === 0) {
    throw new TransformError(IMPORT_DIAGNOSTICS.TRANSFORM_CONTROL_POINTS_INSUFFICIENT.constraintId, 'The control points are degenerate.');
  }

  const a = sumConjZ / sumConjZz; // s*cos(theta)
  const b = controlPoints.reduce((total, point) => {
    const zx = point.source[0] - mx;
    const zy = point.source[1] - my;
    const wx = point.target[0] - mu;
    const wy = point.target[1] - mv;
    return total + (zx * wy - zy * wx); // Im(conj(z) w)
  }, 0) / sumConjZz; // s*sin(theta)

  const tx = mu - (a * mx - b * my);
  const ty = mv - (b * mx + a * my);

  return { parameters: { a, b, tx, ty }, residualErrorM: residual(controlPoints, (x, y) => [a * x - b * y + tx, b * x + a * y + ty]) };
}

/** Full affine fit (6 parameters) by normal equations. */
export function fitAffine2D(controlPoints) {
  const normal = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const rhsX = [0, 0, 0];
  const rhsY = [0, 0, 0];

  for (const point of controlPoints) {
    const basis = [point.source[0], point.source[1], 1];
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) normal[row][column] += basis[row] * basis[column];
      rhsX[row] += basis[row] * point.target[0];
      rhsY[row] += basis[row] * point.target[1];
    }
  }

  const solveX = solve3(normal, rhsX);
  const solveY = solve3(normal, rhsY);
  const apply = (x, y) => [solveX[0] * x + solveX[1] * y + solveX[2], solveY[0] * x + solveY[1] * y + solveY[2]];

  return {
    parameters: { a: solveX[0], b: solveX[1], c: solveX[2], d: solveY[0], e: solveY[1], f: solveY[2] },
    residualErrorM: residual(controlPoints, apply),
  };
}

export function applyTransform(method, parameters, [x, y]) {
  if (method === 'IDENTITY' || !parameters) return [x, y];
  if (method === 'UNIT_SCALE') return [x * parameters.factor, y * parameters.factor];
  if (parameters.d !== undefined) {
    return [parameters.a * x + parameters.b * y + parameters.c, parameters.d * x + parameters.e * y + parameters.f];
  }
  const { a, b, tx, ty } = parameters;
  return [a * x - b * y + tx, b * x + a * y + ty];
}

/** Root-mean-square of the per-point error, in target units (metres by D9). */
function residual(controlPoints, apply) {
  const sum = controlPoints.reduce((total, point) => {
    const [x, y] = apply(point.source[0], point.source[1]);
    return total + (x - point.target[0]) ** 2 + (y - point.target[1]) ** 2;
  }, 0);
  return Math.sqrt(sum / controlPoints.length);
}

function solve3(matrix, vector) {
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }
    if (Math.abs(a[pivot][column]) < 1e-12) {
      throw new TransformError(IMPORT_DIAGNOSTICS.TRANSFORM_CONTROL_POINTS_INSUFFICIENT.constraintId, 'The control points are degenerate.');
    }
    [a[column], a[pivot]] = [a[pivot], a[column]];
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = a[row][column] / a[column][column];
      for (let k = column; k < 4; k += 1) a[row][k] -= factor * a[column][k];
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}
