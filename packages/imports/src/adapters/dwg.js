import { defineAdapter, emptyResult } from '../adapter-contract.js';
import { IMPORT_DIAGNOSTICS } from '../diagnostics.js';

/**
 * DWG.
 *
 * DWG is never parsed directly: the format specification is proprietary, so this
 * descriptor declares a converter dependency and the adapter refuses when no
 * licensed converter is configured. The converted DXF or IFC is then consumed by
 * that format's adapter (doc/workspace/import-adapters.md, "CAD: DXF and DWG").
 */
export const descriptor = {
  adapter_id: 'dwg',
  adapter_version: '1.0.0',
  media_types: ['image/vnd.dwg', 'application/acad', 'application/octet-stream'],
  extensions: ['.dwg'],
  extraction_capabilities: [
    { name: 'layers', level: 'PARTIAL' },
    { name: 'blocks', level: 'PARTIAL' },
    { name: 'block_attributes', level: 'PARTIAL' },
    { name: 'georeferencing', level: 'PARTIAL' },
  ],
  source_crs_declarations: ['LOCAL', 'EPSG'],
  source_unit_declarations: ['m', 'mm', 'in', 'ft'],
  fidelity_level: 'PARTIAL',
  converter_dependency: {
    identity: 'ODA File Converter',
    version: '25.4',
    licence: 'Deployment licence entitlement required; the converter is not bundled.',
    licence_class: 'COMMERCIAL',
    output_media_type: 'image/vnd.dxf',
    output_adapter_id: 'dxf',
  },
  supported_range: { min_version: 'AC1009', max_version: 'AC1032', tested_versions: ['AC1009', 'AC1015', 'AC1018', 'AC1021', 'AC1024', 'AC1027', 'AC1032'] },
  release_level: 'R1',
  status: 'ACTIVE',
  entry_point: new URL('./dwg.js', import.meta.url).href,
  isolation: 'WORKER_SANDBOX',
  conformance_fixtures: ['packages/imports/src/tests/fixtures/unavailable.dwg'],
  required_diagnostics: [
    IMPORT_DIAGNOSTICS.CONVERSION_INCOMPLETE.constraintId,
    IMPORT_DIAGNOSTICS.ADAPTER_UNSUPPORTED.constraintId,
  ],
};

export async function extract() {
  const result = emptyResult({ sourceCrs: null, sourceUnits: null, confidence: 'LOW', evidence: ['converter not configured'] });
  result.diagnostics = [
    {
      constraintId: IMPORT_DIAGNOSTICS.CONVERSION_INCOMPLETE.constraintId,
      message: 'No licensed DWG converter is configured, so no geometry was extracted.',
    },
  ];
  throw Object.assign(new Error('No licensed DWG converter is configured.'), {
    code: IMPORT_DIAGNOSTICS.ADAPTER_UNSUPPORTED.constraintId,
    result,
  });
}

export default defineAdapter({ descriptor, extract });
