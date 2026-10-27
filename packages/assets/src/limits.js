/**
 * Asset kinds, media types, and upload limits.
 *
 * The asset layer records the media type it is given and infers a `kind` for the
 * surface's filtering. Whether an adapter can *process* the type is an import
 * framework question (W4) and raises `asset.media_type.unsupported` there; the
 * asset layer only requires a syntactically valid type and a declared size
 * within the configured limit (D23).
 */
export const ASSET_KINDS = Object.freeze([
  'CAD', 'BIM', 'GIS', 'RASTER', 'DOCUMENT', 'DATASET', 'OTHER',
]);

/** The default per-version ceiling: 2 GiB, matching the documented import limit. */
export const DEFAULT_MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

/** The hard ceiling. Project policy may lower the default but never raise this. */
export const HARD_MAX_ASSET_BYTES = 5 * 1024 * 1024 * 1024;

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

const KIND_BY_PREFIX = Object.freeze([
  [/^model\/ifc$/i, 'BIM'],
  [/^application\/(x-step|ifc)$/i, 'BIM'],
  [/^image\/vnd\.(dwg|dxf)$/i, 'CAD'],
  [/^application\/(dxf|acad)$/i, 'CAD'],
  [/^application\/vnd\.google-earth\.km[zl]/i, 'GIS'],
  [/^application\/(geo\+json|json)$/i, 'GIS'],
  [/^application\/x-esri-shape/i, 'GIS'],
  [/^image\/tiff$/i, 'RASTER'],
  [/^image\/(png|jpeg|webp)$/i, 'RASTER'],
  [/^text\/csv$/i, 'DATASET'],
  [/^application\/(pdf|vnd\.ms-excel)$/i, 'DOCUMENT'],
]);

export function isValidMediaType(mediaType) {
  return typeof mediaType === 'string' && MEDIA_TYPE.test(mediaType.trim());
}

export function kindForMediaType(mediaType) {
  if (typeof mediaType !== 'string') return 'OTHER';
  const match = KIND_BY_PREFIX.find(([pattern]) => pattern.test(mediaType.trim()));
  return match ? match[1] : 'OTHER';
}

export function uploadLimits({ maxBytes = DEFAULT_MAX_ASSET_BYTES } = {}) {
  const effective = Math.min(Math.max(maxBytes, 1), HARD_MAX_ASSET_BYTES);
  return Object.freeze({ maxBytes: effective, hardMaxBytes: HARD_MAX_ASSET_BYTES });
}
