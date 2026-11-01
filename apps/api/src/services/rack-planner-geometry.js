import { localRectangle } from '@ai-infra/rack';

/** Batch search adapter. Same contact policies as rack-layout.check; every final
 * option must additionally pass that complete authoritative checker. Materialize
 * parsed shapes once per batch; ST_Relate needs an explicit bounding-box filter
 * to avoid exact topology work for every distant locked rack/maintenance band. */
export async function pickRackPosition(client, layout, constraints, proposals, placed) {
  const result = await client.query(`
    WITH room AS MATERIALIZED (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1),0) AS geom),
    holes AS (SELECT ST_MakePolygon(ST_InteriorRingN(room.geom,n)) AS geom
      FROM room, generate_series(1,ST_NumInteriorRings(room.geom)) n),
    obstacles AS MATERIALIZED (SELECT ST_SetSRID(ST_GeomFromGeoJSON(x),0) AS geom FROM jsonb_array_elements($2::jsonb) x),
    fixed AS MATERIALIZED (SELECT ST_SetSRID(ST_GeomFromGeoJSON(x->'geometry'),0) AS geom FROM jsonb_array_elements($3::jsonb) x),
    fixed_bands AS MATERIALIZED (SELECT ST_SetSRID(ST_GeomFromGeoJSON(b),0) AS geom
      FROM jsonb_array_elements($3::jsonb) x CROSS JOIN LATERAL jsonb_array_elements(x->'bands') b),
    poses AS MATERIALIZED (SELECT ord-1 AS idx,ST_SetSRID(ST_GeomFromGeoJSON(x->'geometry'),0) AS geom,x->'bands' AS bands
      FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY a(x,ord)),
    bands AS MATERIALIZED (SELECT p.idx,ST_SetSRID(ST_GeomFromGeoJSON(b),0) AS geom FROM poses p
      CROSS JOIN LATERAL jsonb_array_elements(p.bands) b)
    SELECT p.idx FROM poses p,room
    WHERE ST_Covers(room.geom,p.geom)
      AND NOT EXISTS(SELECT 1 FROM holes h WHERE ST_Intersects(h.geom,p.geom))
      AND NOT EXISTS(SELECT 1 FROM obstacles o WHERE ST_Intersects(o.geom,p.geom))
      AND NOT EXISTS(SELECT 1 FROM fixed f WHERE f.geom && p.geom AND ST_Relate(f.geom,p.geom,'T********'))
      AND NOT EXISTS(SELECT 1 FROM fixed_bands f WHERE f.geom && p.geom AND ST_Relate(f.geom,p.geom,'T********'))
      AND NOT EXISTS(SELECT 1 FROM bands b WHERE b.idx=p.idx AND (
        NOT ST_Covers(room.geom,b.geom)
        OR EXISTS(SELECT 1 FROM holes h WHERE ST_Intersects(h.geom,b.geom))
        OR EXISTS(SELECT 1 FROM obstacles o WHERE ST_Intersects(o.geom,b.geom))
        OR EXISTS(SELECT 1 FROM fixed f WHERE f.geom && b.geom AND ST_Relate(f.geom,b.geom,'T********'))))
    ORDER BY p.idx LIMIT 1`, [
    JSON.stringify(layout.snapshot.view.boundaryLocalM),
    JSON.stringify(constraints.obstacles.map(o => localRectangle(o.xM,o.yM,o.widthM,o.depthM))),
    JSON.stringify(placed.map(p => ({ geometry:p.geometry,bands:p.bands }))),
    JSON.stringify(proposals.map(p => ({ geometry:p.geometry,bands:p.bands }))),
  ]);
  return result.rows.length ? Number(result.rows[0].idx) : null;
}
