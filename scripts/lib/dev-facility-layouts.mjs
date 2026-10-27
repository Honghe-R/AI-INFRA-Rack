/**
 * The facility graphs the development seed writes, one per seeded project.
 *
 * `dev-seed-facility.mjs` is plumbing: it opens transactions, inserts rows, and
 * checks its own output. Everything that makes one campus *that* campus — its
 * geography, its projected CRS, how many buildings it has, which utilities feed
 * it, how its phases sequence, and the shape of its failure-domain tree — is data,
 * and it lives here.
 *
 * Why two layouts rather than one: the two tenants exist to make tenant isolation
 * observable, and two identical campuses defeat that. A leak across the boundary
 * shows the other tenant's campus, which is only unmistakable if the two look
 * different — different coordinates, a different CRS, a different building count,
 * a different utility mix. Identical demo data would make a leak look like a
 * correct answer.
 *
 * The two also differ in what they get *wrong*, which is the point of seeding a
 * validator's inputs at all: the first campus is missing connection points and
 * commissions cooling after the phase that consumes it, while the second supplies
 * every connection point and instead claims an availability policy its path count
 * cannot meet. A seed that was uniformly clean would exercise no finding.
 */

/** `[lon, lat]` rectangle as a GeoJSON-ready ring, closed by the caller. */
const rect = (lonMin, latMin, lonMax, latMax) => [
  [lonMin, latMin],
  [lonMax, latMin],
  [lonMax, latMax],
  [lonMin, latMax],
];

const NORTHERN_DC = {
  key: 'northern-dc',
  projectName: 'Northern DC Campus',
  scopeName: 'Northern DC Campus',
  jurisdiction: 'Loudoun County, Virginia',
  // UTM zone 18N.
  projectedCrs: 'EPSG:32618',
  projectedSrid: 32618,
  // The first campus's sources claim availability from the day the seed runs,
  // which is later than the phase that consumes them — a real finding it exists to
  // produce. The second campus declares no availability date at all.
  sourcesAvailableFromFirstPhase: true,

  rings: {
    campus: [
      [-77.4925, 39.0425],
      [-77.4866, 39.0425],
      [-77.486, 39.0441],
      [-77.4874, 39.0455],
      [-77.4911, 39.0455],
      [-77.4925, 39.0443],
    ],
    chA: rect(-77.4916, 39.0429, -77.4896, 39.0441),
    chB: rect(-77.4888, 39.0429, -77.487, 39.0441),
    yard: rect(-77.4905, 39.0445, -77.4885, 39.0452),
    hallA1: rect(-77.4914, 39.0431, -77.4902, 39.0439),
    hallA2: rect(-77.49, 39.0431, -77.4898, 39.0439),
    supportA: rect(-77.4916, 39.0439, -77.4896, 39.0441),
    supportB: rect(-77.4888, 39.0439, -77.487, 39.0441),
  },
  points: {
    powerA: [-77.4919, 39.0435],
    powerB: [-77.4868, 39.0435],
    network: [-77.4879, 39.0448],
    cooling: [-77.489, 39.0447],
  },

  phases: [
    { key: 'phase:1', name: 'Phase 1 - 12 MW', order: 0, activationDate: '2024-06-01', precision: null },
    { key: 'phase:2', name: 'Phase 2 - 6 MW', order: 1, activationDate: '2026-01-15', precision: null },
  ],
  phaseDependencies: [['phase:1', 'phase:2']],
  phaseAvailability: [
    ['GEOMETRY', 'phase:1', true, '2024-06-01T00:00:00Z'],
    ['POWER', 'phase:1', true, '2024-06-01T00:00:00Z'],
    ['COOLING', 'phase:1', true, '2024-09-01T00:00:00Z'],
    ['NETWORK_ENTRY', 'phase:1', true, '2024-09-01T00:00:00Z'],
    ['POWER', 'phase:2', false, null],
    ['COOLING', 'phase:2', false, null],
  ],

  containers: [
    { key: 'container:parcel-1', kind: 'PARCEL', name: 'Parcel 1', parent: null, level: null, base: null, top: null, phase: null },
    { key: 'container:dc-a', kind: 'BUILDING', name: 'Data Centre A', parent: 'container:parcel-1', level: null, base: 0, top: 12, phase: 'phase:1' },
    { key: 'container:dc-b', kind: 'BUILDING', name: 'Data Centre B', parent: 'container:parcel-1', level: null, base: 0, top: 12, phase: 'phase:2' },
    { key: 'container:yard', kind: 'EQUIPMENT_YARD', name: 'Generator and Chiller Yard', parent: 'container:parcel-1', level: null, base: null, top: null, phase: 'phase:1' },
    // A HALL's parent is its building and `level_number` is unique within a
    // building (entity-model.md, "Level and Elevation Semantics"), so two data
    // halls in one building are two levels, not two halls on one level.
    { key: 'container:dc-a-hall-1', kind: 'HALL', name: 'Data Hall A1', parent: 'container:dc-a', level: 1, base: 0, top: 6, phase: 'phase:1' },
    { key: 'container:dc-a-hall-2', kind: 'HALL', name: 'Data Hall A2', parent: 'container:dc-a', level: 2, base: 6, top: 12, phase: 'phase:1' },
    { key: 'container:dc-b-floor-1', kind: 'FLOOR', name: 'Data Centre B - Level 1', parent: 'container:dc-b', level: 1, base: 0, top: 6, phase: 'phase:2' },
    // A support space carries no level number, so several can share a floor.
    { key: 'container:support-a', kind: 'SUPPORT_SPACE', name: 'Electrical Room A', parent: 'container:dc-a', level: null, base: 0, top: 6, phase: 'phase:1' },
    { key: 'container:support-b', kind: 'SUPPORT_SPACE', name: 'Electrical Room B', parent: 'container:dc-b', level: null, base: 0, top: 6, phase: 'phase:2' },
  ],

  geometries: [
    { key: 'geometry:site-boundary', entity: 'scope:site', entityType: 'SITE', role: 'BOUNDARY', ring: 'campus' },
    { key: 'geometry:parcel-1', entity: 'container:parcel-1', entityType: 'PARCEL', role: 'BOUNDARY', ring: 'campus' },
    { key: 'geometry:dc-a', entity: 'container:dc-a', entityType: 'BUILDING', role: 'FOOTPRINT', ring: 'chA', base: 0, top: 12, height: 12 },
    { key: 'geometry:dc-b', entity: 'container:dc-b', entityType: 'BUILDING', role: 'FOOTPRINT', ring: 'chB', base: 0, top: 12, height: 12 },
    { key: 'geometry:yard', entity: 'container:yard', entityType: 'EQUIPMENT_YARD', role: 'BOUNDARY', ring: 'yard' },
    { key: 'geometry:dc-a-hall-1', entity: 'container:dc-a-hall-1', entityType: 'HALL', role: 'FLOOR_BOUNDARY', ring: 'hallA1', base: 0, top: 6 },
    { key: 'geometry:dc-a-hall-2', entity: 'container:dc-a-hall-2', entityType: 'HALL', role: 'FLOOR_BOUNDARY', ring: 'hallA2', base: 6, top: 12 },
    { key: 'geometry:dc-b-floor-1', entity: 'container:dc-b-floor-1', entityType: 'FLOOR', role: 'FLOOR_BOUNDARY', ring: 'chB', base: 0, top: 6 },
    { key: 'geometry:support-a', entity: 'container:support-a', entityType: 'SUPPORT_SPACE', role: 'ROOM_BOUNDARY', ring: 'supportA', base: 0, top: 6 },
    { key: 'geometry:support-b', entity: 'container:support-b', entityType: 'SUPPORT_SPACE', role: 'ROOM_BOUNDARY', ring: 'supportB', base: 0, top: 6 },
    { key: 'geometry:interface-power-a', entity: 'utility-interface:power-a', entityType: 'UTILITY_INTERFACE', role: 'CONNECTION_POINT', point: 'powerA' },
    { key: 'geometry:interface-cooling', entity: 'utility-interface:cooling', entityType: 'UTILITY_INTERFACE', role: 'CONNECTION_POINT', point: 'cooling' },
    { key: 'geometry:interface-network', entity: 'utility-interface:network', entityType: 'UTILITY_INTERFACE', role: 'CONNECTION_POINT', point: 'network' },
  ],

  domains: [
    { key: 'failure-domain:feed-a', name: 'Utility Feed A', kind: 'UTILITY_FEED', parent: null },
    { key: 'failure-domain:feed-b', name: 'Utility Feed B', kind: 'UTILITY_FEED', parent: null },
  ],

  requirement: {
    key: 'resilience:main',
    name: 'Campus N+1 requirement',
    policyId: 'corp-dc-standard@3',
    availabilityPolicy: 'N_PLUS_1',
    appliesTo: ['POWER', 'COOLING'],
    autonomyDurationSeconds: 86400,
  },

  sources: [
    { key: 'utility-source:power-a', name: 'Utility Entrance A', kind: 'POWER', value: 18000, unit: 'kW', basis: 'IT_LOAD', state: 'FIRM', domain: 'failure-domain:feed-a', phase: 'phase:1' },
    { key: 'utility-source:power-b', name: 'Utility Entrance B', kind: 'POWER', value: 9000, unit: 'kW', basis: 'IT_LOAD', state: 'CONTRACTUAL', domain: 'failure-domain:feed-b', phase: 'phase:2' },
    { key: 'utility-source:cooling', name: 'Central Chiller Plant', kind: 'COOLING', value: 15000, unit: 'kW', basis: 'HEAT_REJECTION', state: 'FIRM', domain: 'failure-domain:feed-a', phase: 'phase:1' },
    { key: 'utility-source:network', name: 'Carrier Meet-Me Room', kind: 'NETWORK_ENTRY', value: 4, unit: 'count', basis: 'NETWORK_ENTRY_COUNT', state: 'PLANNED', domain: 'failure-domain:feed-b', phase: 'phase:2' },
  ],
  interfaces: [
    { key: 'utility-interface:power-a', name: 'Power Interface A', source: 'utility-source:power-a', value: 18000, unit: 'kW', basis: 'IT_LOAD', state: 'FIRM', domain: 'failure-domain:feed-a', phase: 'phase:1', service: 'AVAILABLE' },
    { key: 'utility-interface:cooling', name: 'Cooling Interface', source: 'utility-source:cooling', value: 15000, unit: 'kW', basis: 'HEAT_REJECTION', state: 'FIRM', domain: 'failure-domain:feed-a', phase: 'phase:1', service: 'AVAILABLE' },
    { key: 'utility-interface:network', name: 'Network Entry Interface', source: 'utility-source:network', value: 4, unit: 'count', basis: 'NETWORK_ENTRY_COUNT', state: 'PLANNED', domain: 'failure-domain:feed-b', phase: 'phase:2', service: 'PLANNED' },
  ],
  reserves: [
    { key: 'storage:fuel', name: 'Fuel Storage - 150,000 L', kind: 'FUEL', value: 150000, unit: 'L', basis: 'FUEL_VOLUME', state: 'PLANNED', autonomySeconds: 86400, domain: 'failure-domain:feed-a', phase: 'phase:1' },
  ],

  profile: {
    key: 'environmental-profile:site',
    name: 'Site environmental profile',
    designWeatherRef: 'ASHRAE 0.4% dry bulb 35.6 C / 0.4% wet bulb 25.0 C',
    hazards: ['SEISMIC_ZONE_2', 'FLOOD_ZONE_X'],
    permits: ['STORMWATER_MANAGEMENT', 'NOISE_ORDINANCE'],
    operatingRanges: { temperature_c: { min: 18, max: 27 }, relative_humidity_pct: { min: 20, max: 80 } },
  },

  constraints: [
    { key: 'spatial-constraint:setback', name: 'Site perimeter setback', kind: 'SETBACK', severity: 'ERROR', ruleKind: 'DISTANCE_FROM_BOUNDARY', ruleValue: 15, ruleUnit: 'm', scope: true },
    { key: 'spatial-constraint:height-dc-a', name: 'Data Centre A height limit', kind: 'HEIGHT_LIMIT', severity: 'ERROR', ruleKind: 'MAX_HEIGHT', ruleValue: 40, ruleUnit: 'm', container: 'container:dc-a', geometry: 'geometry:dc-a' },
  ],

  assumptions: [
    {
      key: 'assumption:utility-diversity',
      name: 'Utility diversity assumption',
      statement: 'Utility Entrance A and Utility Entrance B are fed from independent substations.',
      owner: 'Power planning',
      confidence: 'MEDIUM',
      status: 'OPEN',
      refsTo: ['utility-source:power-a', 'utility-source:power-b'],
    },
    {
      key: 'assumption:water-reuse',
      name: 'Water reuse assumption',
      statement: 'Municipal water is available for make-up at 600 kW-equivalent flow during Phase 2 commissioning.',
      owner: 'Mechanical planning',
      confidence: 'LOW',
      status: 'OPEN',
      refsTo: [],
    },
  ],

  document: { key: 'document:feasibility-study', title: 'Phase 2 Expansion Feasibility Study', owner: 'Development organisation' },

  samples: {
    campusLabel: 'Northern DC Campus',
    study: { name: 'Phase 2 Expansion Feasibility Study', filename: 'phase-2-expansion-feasibility.pdf' },
  },
};

const CASCADE_RIDGE = {
  key: 'cascade-ridge',
  projectName: 'Cascade Ridge Campus',
  scopeName: 'Cascade Ridge Campus',
  jurisdiction: 'Grant County, Washington',
  // UTM zone 11N — a different projection from the first campus on purpose: the
  // projected representation is authoritative for measurement, so two tenants
  // exercising the same CRS would never show a transform that was pinned to the
  // wrong zone.
  projectedCrs: 'EPSG:32611',
  projectedSrid: 32611,
  sourcesAvailableFromFirstPhase: false,

  rings: {
    campus: rect(-119.861, 47.2295, -119.85, 47.2365),
    // Three single-storey halls in two rows, rather than the first campus's two
    // multi-storey buildings: a different graph, not a translation of one.
    ch1: rect(-119.8596, 47.2308, -119.8576, 47.2322),
    ch2: rect(-119.8568, 47.2308, -119.8548, 47.2322),
    ch3: rect(-119.854, 47.2334, -119.852, 47.2348),
    yard: rect(-119.8598, 47.234, -119.8588, 47.2348),
    floor1: rect(-119.8596, 47.2308, -119.8576, 47.2322),
    hall1: rect(-119.8566, 47.231, -119.855, 47.232),
    hall2: rect(-119.8538, 47.2336, -119.8522, 47.2346),
    supportA: rect(-119.8596, 47.2318, -119.8576, 47.2322),
    supportB: rect(-119.8568, 47.2318, -119.8548, 47.2322),
    // A hazard overlay in the south-east corner, clear of every building.
    hazard: rect(-119.851, 47.2298, -119.8502, 47.2306),
  },
  points: {
    powerA: [-119.8595, 47.2336],
    powerB: [-119.8505, 47.2336],
    cooling: [-119.8592, 47.2344],
    water: [-119.8504, 47.2299],
    network: [-119.853, 47.235],
  },

  phases: [
    { key: 'phase:1', name: 'Phase 1 - 24 MW', order: 0, activationDate: '2026-03-01', precision: 'DAY' },
    { key: 'phase:2', name: 'Phase 2 - 18 MW', order: 1, activationDate: '2027-06-01', precision: 'MONTH' },
    { key: 'phase:3', name: 'Phase 3 - 12 MW', order: 2, activationDate: '2029-01-01', precision: 'YEAR' },
  ],
  // A chain rather than a single edge: the dependency graph has depth.
  phaseDependencies: [['phase:1', 'phase:2'], ['phase:2', 'phase:3']],
  phaseAvailability: [
    ['GEOMETRY', 'phase:1', true, '2025-09-01T00:00:00Z'],
    ['POWER', 'phase:1', true, '2025-09-01T00:00:00Z'],
    ['COOLING', 'phase:1', true, '2025-09-01T00:00:00Z'],
    ['WATER', 'phase:1', true, '2025-09-01T00:00:00Z'],
    ['NETWORK_ENTRY', 'phase:1', true, '2025-09-01T00:00:00Z'],
    ['POWER', 'phase:2', true, '2026-12-01T00:00:00Z'],
    ['WATER', 'phase:2', true, '2026-12-01T00:00:00Z'],
    ['POWER', 'phase:3', true, '2028-06-01T00:00:00Z'],
  ],

  containers: [
    { key: 'container:parcel-1', kind: 'PARCEL', name: 'Parcel 1', parent: null, level: null, base: null, top: null, phase: null },
    { key: 'container:ch-1', kind: 'BUILDING', name: 'Cascade Hall 1', parent: 'container:parcel-1', level: null, base: 0, top: 9, phase: 'phase:1' },
    { key: 'container:ch-2', kind: 'BUILDING', name: 'Cascade Hall 2', parent: 'container:parcel-1', level: null, base: 0, top: 9, phase: 'phase:2' },
    { key: 'container:ch-3', kind: 'BUILDING', name: 'Cascade Hall 3', parent: 'container:parcel-1', level: null, base: 0, top: 9, phase: 'phase:3' },
    { key: 'container:yard', kind: 'EQUIPMENT_YARD', name: 'Substation and Generator Yard', parent: 'container:parcel-1', level: null, base: null, top: null, phase: 'phase:1' },
    { key: 'container:ch-1-floor-1', kind: 'FLOOR', name: 'Cascade Hall 1 - Level 1', parent: 'container:ch-1', level: 1, base: 0, top: 6, phase: 'phase:1' },
    { key: 'container:ch-2-hall-1', kind: 'HALL', name: 'Data Hall C1', parent: 'container:ch-2', level: 1, base: 0, top: 6, phase: 'phase:2' },
    { key: 'container:ch-3-hall-1', kind: 'HALL', name: 'Data Hall C2', parent: 'container:ch-3', level: 1, base: 0, top: 6, phase: 'phase:3' },
    { key: 'container:support-a', kind: 'SUPPORT_SPACE', name: 'Electrical Room C1', parent: 'container:ch-1', level: null, base: 0, top: 6, phase: 'phase:1' },
    { key: 'container:support-b', kind: 'SUPPORT_SPACE', name: 'Electrical Room C2', parent: 'container:ch-2', level: null, base: 0, top: 6, phase: 'phase:2' },
  ],

  geometries: [
    { key: 'geometry:site-boundary', entity: 'scope:site', entityType: 'SITE', role: 'BOUNDARY', ring: 'campus' },
    { key: 'geometry:parcel-1', entity: 'container:parcel-1', entityType: 'PARCEL', role: 'BOUNDARY', ring: 'campus' },
    { key: 'geometry:ch-1', entity: 'container:ch-1', entityType: 'BUILDING', role: 'FOOTPRINT', ring: 'ch1', base: 0, top: 9, height: 9 },
    { key: 'geometry:ch-2', entity: 'container:ch-2', entityType: 'BUILDING', role: 'FOOTPRINT', ring: 'ch2', base: 0, top: 9, height: 9 },
    { key: 'geometry:ch-3', entity: 'container:ch-3', entityType: 'BUILDING', role: 'FOOTPRINT', ring: 'ch3', base: 0, top: 9, height: 9 },
    { key: 'geometry:yard', entity: 'container:yard', entityType: 'EQUIPMENT_YARD', role: 'BOUNDARY', ring: 'yard' },
    { key: 'geometry:ch-1-floor-1', entity: 'container:ch-1-floor-1', entityType: 'FLOOR', role: 'FLOOR_BOUNDARY', ring: 'floor1', base: 0, top: 6 },
    { key: 'geometry:ch-2-hall-1', entity: 'container:ch-2-hall-1', entityType: 'HALL', role: 'FLOOR_BOUNDARY', ring: 'hall1', base: 0, top: 6 },
    { key: 'geometry:ch-3-hall-1', entity: 'container:ch-3-hall-1', entityType: 'HALL', role: 'FLOOR_BOUNDARY', ring: 'hall2', base: 0, top: 6 },
    { key: 'geometry:support-a', entity: 'container:support-a', entityType: 'SUPPORT_SPACE', role: 'ROOM_BOUNDARY', ring: 'supportA', base: 0, top: 6 },
    { key: 'geometry:support-b', entity: 'container:support-b', entityType: 'SUPPORT_SPACE', role: 'ROOM_BOUNDARY', ring: 'supportB', base: 0, top: 6 },
    // Every source gets its own connection point, so this campus does *not* raise
    // `facility.data.geometry.role_missing` — the first campus's headline finding.
    { key: 'geometry:source-power-a', entity: 'utility-source:power-a', entityType: 'UTILITY_SOURCE', role: 'CONNECTION_POINT', point: 'powerA' },
    { key: 'geometry:source-power-b', entity: 'utility-source:power-b', entityType: 'UTILITY_SOURCE', role: 'CONNECTION_POINT', point: 'powerB' },
    { key: 'geometry:source-cooling', entity: 'utility-source:cooling', entityType: 'UTILITY_SOURCE', role: 'CONNECTION_POINT', point: 'cooling' },
    { key: 'geometry:source-water', entity: 'utility-source:water', entityType: 'UTILITY_SOURCE', role: 'CONNECTION_POINT', point: 'water' },
    { key: 'geometry:source-network', entity: 'utility-source:network', entityType: 'UTILITY_SOURCE', role: 'CONNECTION_POINT', point: 'network' },
    { key: 'geometry:interface-power-a', entity: 'utility-interface:power-a', entityType: 'UTILITY_INTERFACE', role: 'CONNECTION_POINT', point: 'powerA' },
    { key: 'geometry:interface-power-b', entity: 'utility-interface:power-b', entityType: 'UTILITY_INTERFACE', role: 'CONNECTION_POINT', point: 'powerB' },
    { key: 'geometry:interface-cooling', entity: 'utility-interface:cooling', entityType: 'UTILITY_INTERFACE', role: 'CONNECTION_POINT', point: 'cooling' },
    { key: 'geometry:interface-water', entity: 'utility-interface:water', entityType: 'UTILITY_INTERFACE', role: 'CONNECTION_POINT', point: 'water' },
    { key: 'geometry:interface-network', entity: 'utility-interface:network', entityType: 'UTILITY_INTERFACE', role: 'CONNECTION_POINT', point: 'network' },
    // The hazard overlay's geometry belongs to the constraint entity itself.
    { key: 'geometry:hazard-zone', entity: 'spatial-constraint:hazard', entityType: 'SPATIAL_CONSTRAINT', role: 'CONSTRAINT_AREA', ring: 'hazard' },
  ],

  // A three-level tree rather than two flat domains, so an independence claim has
  // an ancestor to share or not share.
  domains: [
    { key: 'failure-domain:feed-a', name: 'Utility Feed A', kind: 'UTILITY_FEED', parent: null },
    { key: 'failure-domain:substation-a1', name: 'Substation A1', kind: 'SUBSTATION', parent: 'failure-domain:feed-a' },
    { key: 'failure-domain:feed-b', name: 'Utility Feed B', kind: 'UTILITY_FEED', parent: null },
  ],

  requirement: {
    key: 'resilience:main',
    name: 'Campus N+2 requirement',
    policyId: 'campus-n-plus-2@1',
    availabilityPolicy: 'N_PLUS_2',
    appliesTo: ['POWER', 'COOLING'],
    autonomyDurationSeconds: 172800,
  },

  sources: [
    { key: 'utility-source:power-a', name: 'Grand Coulee Feed A', kind: 'POWER', value: 24000, unit: 'kW', basis: 'IT_LOAD', state: 'FIRM', domain: 'failure-domain:feed-a', phase: 'phase:1' },
    { key: 'utility-source:power-b', name: 'Grand Coulee Feed B', kind: 'POWER', value: 12000, unit: 'kW', basis: 'IT_LOAD', state: 'FIRM', domain: 'failure-domain:feed-b', phase: 'phase:2' },
    { key: 'utility-source:cooling', name: 'Air-Cooled Chiller Plant', kind: 'COOLING', value: 20000, unit: 'kW', basis: 'HEAT_REJECTION', state: 'FIRM', domain: 'failure-domain:substation-a1', phase: 'phase:1' },
    { key: 'utility-source:water', name: 'Grant County Water Main', kind: 'WATER', value: 900, unit: 'm3/day', basis: 'WATER_FLOW', state: 'FIRM', domain: 'failure-domain:feed-a', phase: 'phase:2' },
    { key: 'utility-source:network', name: 'Quincy Carrier Hotel', kind: 'NETWORK_ENTRY', value: 6, unit: 'count', basis: 'NETWORK_ENTRY_COUNT', state: 'CONTRACTUAL', domain: 'failure-domain:feed-b', phase: 'phase:3' },
  ],
  interfaces: [
    { key: 'utility-interface:power-a', name: 'Power Interface A', source: 'utility-source:power-a', value: 24000, unit: 'kW', basis: 'IT_LOAD', state: 'FIRM', domain: 'failure-domain:feed-a', phase: 'phase:1', service: 'AVAILABLE' },
    { key: 'utility-interface:power-b', name: 'Power Interface B', source: 'utility-source:power-b', value: 12000, unit: 'kW', basis: 'IT_LOAD', state: 'FIRM', domain: 'failure-domain:feed-b', phase: 'phase:2', service: 'AVAILABLE' },
    { key: 'utility-interface:cooling', name: 'Cooling Interface', source: 'utility-source:cooling', value: 20000, unit: 'kW', basis: 'HEAT_REJECTION', state: 'FIRM', domain: 'failure-domain:substation-a1', phase: 'phase:1', service: 'AVAILABLE' },
    { key: 'utility-interface:water', name: 'Water Interface', source: 'utility-source:water', value: 900, unit: 'm3/day', basis: 'WATER_FLOW', state: 'FIRM', domain: 'failure-domain:feed-a', phase: 'phase:2', service: 'AVAILABLE' },
    { key: 'utility-interface:network', name: 'Network Entry Interface', source: 'utility-source:network', value: 6, unit: 'count', basis: 'NETWORK_ENTRY_COUNT', state: 'CONTRACTUAL', domain: 'failure-domain:feed-b', phase: 'phase:3', service: 'PLANNED' },
  ],
  reserves: [
    { key: 'storage:fuel', name: 'Fuel Storage - 200,000 L', kind: 'FUEL', value: 200000, unit: 'L', basis: 'FUEL_VOLUME', state: 'PLANNED', autonomySeconds: 172800, domain: 'failure-domain:feed-a', phase: 'phase:1' },
    { key: 'storage:water', name: 'Water Storage - 400 m3', kind: 'WATER', value: 400, unit: 'm3', basis: 'WATER_FLOW', state: 'PLANNED', autonomySeconds: 172800, domain: 'failure-domain:feed-a', phase: 'phase:2' },
  ],

  profile: {
    key: 'environmental-profile:site',
    name: 'Site environmental profile',
    designWeatherRef: 'ASHRAE 0.4% dry bulb 33.9 C / 0.4% wet bulb 21.1 C',
    hazards: ['WILDFIRE_ZONE_2', 'SEISMIC_ZONE_1'],
    permits: ['AIR_QUALITY', 'STORMWATER_MANAGEMENT'],
    operatingRanges: { temperature_c: { min: 15, max: 29 }, relative_humidity_pct: { min: 15, max: 70 } },
  },

  constraints: [
    { key: 'spatial-constraint:setback', name: 'Site perimeter setback', kind: 'SETBACK', severity: 'ERROR', ruleKind: 'DISTANCE_FROM_BOUNDARY', ruleValue: 20, ruleUnit: 'm', scope: true },
    { key: 'spatial-constraint:height-ch-2', name: 'Cascade Hall 2 height limit', kind: 'HEIGHT_LIMIT', severity: 'ERROR', ruleKind: 'MAX_HEIGHT', ruleValue: 30, ruleUnit: 'm', container: 'container:ch-2', geometry: 'geometry:ch-2' },
    { key: 'spatial-constraint:hazard', name: 'Wildfire exposure zone', kind: 'HAZARD_ZONE', severity: 'ERROR', ruleKind: 'EXCLUSION', ruleValue: null, ruleUnit: null, scope: true, geometry: 'geometry:hazard-zone' },
  ],

  assumptions: [
    {
      key: 'assumption:grid-capacity',
      name: 'Grid capacity assumption',
      statement: 'Grant County PUD can firm the Phase 2 interconnection by 2027 without a new substation.',
      owner: 'Power planning',
      confidence: 'MEDIUM',
      status: 'OPEN',
      refsTo: ['utility-source:power-b'],
    },
    {
      key: 'assumption:seismic-study',
      name: 'Seismic study assumption',
      statement: 'The 2025 geotechnical study covers the Cascade Hall 3 pad.',
      owner: 'Civil engineering',
      confidence: 'HIGH',
      status: 'RESOLVED',
      refsTo: [],
    },
  ],

  document: { key: 'document:feasibility-study', title: 'Phase 3 Expansion Feasibility Study', owner: 'Cascade Cloud' },

  samples: {
    campusLabel: 'Cascade Ridge Campus',
    study: { name: 'Phase 3 Expansion Feasibility Study', filename: 'phase-3-expansion-feasibility.pdf' },
  },
};

export const DEV_FACILITY_LAYOUTS = Object.freeze([NORTHERN_DC, CASCADE_RIDGE]);

/**
 * The layout for a seeded project.
 *
 * Matched by name so the seed needs nothing but the project list, and falling back
 * to the first layout so a project an operator created by hand still gets a graph
 * rather than an error.
 */
export function layoutFor(projectName) {
  return DEV_FACILITY_LAYOUTS.find((layout) => layout.projectName === projectName) ?? { ...NORTHERN_DC, projectName };
}
