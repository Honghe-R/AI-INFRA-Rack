import csv from './csv.js';
import documentAdapter from './document.js';
import dwg from './dwg.js';
import dxf from './dxf.js';
import geojson from './geojson.js';
import kml from './kml.js';
import raster from './raster.js';

/**
 * The adapters registered in R1.
 *
 * IFC is deliberately absent: the plan defers IFC 2X3/4/4X3 to R1.1 while the
 * framework, KML/KMZ, and DXF ship first. Adding it later is one module and one
 * array entry — no pipeline, storage, API, or tool change.
 */
export const r1Adapters = Object.freeze([geojson, csv, dxf, kml, raster, documentAdapter, dwg]);

export { csv, documentAdapter, dwg, dxf, geojson, kml, raster };
