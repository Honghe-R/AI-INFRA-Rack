import { finding } from './shared.js';

export const environmentChecks = {
  /** A site-level climate claim needs a design-weather reference. */
  'facility.environment.design_weather.missing': async (ctx, constraint) => {
    const siteScopes = ctx.scopes.filter((scope) => scope.entity_type === 'SITE');
    const findings = [];
    for (const scope of siteScopes) {
      const profiles = ctx.profiles.filter((profile) => profile.site_scope_id === scope.scope_id);
      if (profiles.length === 0) {
        findings.push(finding(constraint, {
          entityRefs: [{ entity_type: 'SITE', entity_id: scope.scope_id }],
          computed: { expression: 'environmental profile for site scope', expected: '>= 1', actual: 0 },
        }));
        continue;
      }
      for (const profile of profiles.filter((item) => !item.design_weather_ref || item.design_weather_ref.trim() === '')) {
        findings.push(finding(constraint, {
          entityRefs: [{ entity_type: 'ENVIRONMENTAL_PROFILE', entity_id: profile.profile_id }],
          sourceValues: [{ field: 'design_weather_ref', value: profile.design_weather_ref }],
          computed: { expression: 'design_weather_ref', expected: 'declared', actual: null },
        }));
      }
    }
    return findings;
  },

  /** Water is consumed by cooling; without an envelope the claim cannot be bounded. */
  'facility.environment.water.envelope_missing': async (ctx, constraint) => {
    const waterConstraints = ctx.envConstraints.filter((row) => row.basis === 'WATER_FLOW');
    const waterSources = ctx.sources.filter((source) => source.kind === 'WATER');
    if (waterConstraints.length > 0 || waterSources.length > 0) return [];
    return [finding(constraint, {
      computed: { expression: 'water availability or permit envelope', expected: '>= 1', actual: 0 },
      remediationHint: 'Declare a water source or a WATER_FLOW environmental constraint.',
    })];
  },

  /** A profile is reusable only within its site and its effective period. */
  'facility.environment.profile.out_of_scope': async (ctx, constraint) => {
    const scopeIds = new Set(ctx.scopes.map((scope) => scope.scope_id));
    const findings = [];
    for (const profile of ctx.profiles) {
      if (!scopeIds.has(profile.site_scope_id)) {
        findings.push(finding(constraint, {
          entityRefs: [{ entity_type: 'ENVIRONMENTAL_PROFILE', entity_id: profile.profile_id }],
          sourceValues: [{ field: 'site_scope_id', value: profile.site_scope_id }],
          computed: { expression: 'profile site scope in revision', expected: true, actual: false },
        }));
        continue;
      }
      if (profile.effective_until && new Date(profile.effective_until) < new Date()) {
        findings.push(finding(constraint, {
          entityRefs: [{ entity_type: 'ENVIRONMENTAL_PROFILE', entity_id: profile.profile_id }],
          sourceValues: [{ field: 'effective_until', value: profile.effective_until }],
          computed: { expression: 'profile effective period', expected: 'covers now', actual: 'expired' },
        }));
        continue;
      }
      if (profile.effective_until && new Date(profile.effective_until) < new Date(profile.effective_at)) {
        findings.push(finding(constraint, {
          entityRefs: [{ entity_type: 'ENVIRONMENTAL_PROFILE', entity_id: profile.profile_id }],
          sourceValues: [{ field: 'effective_until', value: profile.effective_until }],
          computed: { expression: 'effective window', expected: 'until > at', actual: 'inverted' },
        }));
      }
    }
    return findings;
  },

  'facility.environment.constraint.basis_missing': async (ctx, constraint) =>
    ctx.envConstraints
      .filter((row) => !row.threshold_unit || row.threshold_unit.trim() === '' || !row.basis)
      .map((row) => finding(constraint, {
        entityRefs: [{ entity_type: 'ENVIRONMENTAL_CONSTRAINT', entity_id: row.environmental_constraint_id }],
        sourceValues: [{ field: 'threshold_unit', value: row.threshold_unit }, { field: 'basis', value: row.basis }],
        computed: { expression: 'threshold unit and basis', expected: 'declared', actual: 'missing' },
      })),
};

export const environmentCheckIds = Object.keys(environmentChecks);
