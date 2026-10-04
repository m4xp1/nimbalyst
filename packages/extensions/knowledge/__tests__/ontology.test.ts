// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';
import {
  parseLabelRegistryYAML,
  parsePredicateRegistryYAML,
  parseTrackerYAML,
  resolveLabels,
  validateLabelRegistry,
  type LabelDefinition,
  type LabelRegistry,
  type PredicateDefinition,
} from '@nimbalyst/tracker-schema';

// The skill's reference files are the canonical knowledge ontology. The web
// console wiki reads these kind ids and field names, and agents pass the files
// to `tracker_define_type` as-is, so they must parse with the runtime parser
// and every relationship must land on a kind the ontology itself defines.
const REFERENCES = path.resolve(__dirname, '../claude-plugin/skills/knowledge-graph/references');
const KINDS = ['entity', 'claim', 'question', 'finding', 'investigation'];
const PACKS = ['core', 'market', 'spec'] as const;

const read = (name: string) => readFileSync(path.join(REFERENCES, name), 'utf-8');
const models = KINDS.map((kind) => parseTrackerYAML(read(`${kind}.yaml`)));
const field = (type: string, name: string) =>
  models.find((m) => m.type === type)?.fields.find((f) => f.name === name);

function packPredicates(pack: string): PredicateDefinition[] {
  const result = parsePredicateRegistryYAML(read(`packs/${pack}/predicates.yaml`));
  expect(result.issues, pack).toEqual([]);
  return result.predicates ?? [];
}

function packLabels(pack: string): LabelRegistry {
  const result = parseLabelRegistryYAML(read(`packs/${pack}/labels.yaml`));
  expect(result.issues, pack).toEqual([]);
  return result.registry!;
}

/**
 * The knowledge-setup merge: add missing ids; an existing label only gains the
 * pack's `properties`, `factBox` and `expects` entries it lacks.
 */
function mergePack(into: LabelRegistry, pack: LabelRegistry): LabelRegistry {
  const union = (a: string[] = [], b: string[] = []) => [...a, ...b.filter((x) => !a.includes(x))];
  const labels = [...into.labels];
  for (const label of pack.labels) {
    const at = labels.findIndex((existing) => existing.id === label.id);
    if (at < 0) {
      labels.push(label);
      continue;
    }
    const existing = labels[at];
    const expects = [...(existing.expects ?? [])];
    for (const e of label.expects ?? []) if (!expects.some((x) => x.property === e.property)) expects.push(e);
    labels[at] = {
      ...existing,
      properties: union(existing.properties, label.properties),
      factBox: union(existing.factBox, label.factBox),
      ...(expects.length ? { expects } : {}),
    } as LabelDefinition;
  }
  const properties = [...into.properties, ...pack.properties.filter((p) => !into.properties.some((q) => q.id === p.id))];
  return { labels, properties, claimProperties: { ...pack.claimProperties, ...into.claimProperties } };
}

describe('knowledge ontology references', () => {
  it('defines each kind under its file name and targets only defined kinds', () => {
    expect(models.map((m) => m.type)).toEqual(KINDS);
    for (const model of models) {
      for (const f of model.fields.filter((f) => f.type === 'relationship')) {
        expect(f.targetTrackerTypes?.length, `${model.type}.${f.name}`).toBeGreaterThan(0);
        for (const target of f.targetTrackerTypes ?? []) {
          expect(KINDS, `${model.type}.${f.name} -> ${target}`).toContain(target);
        }
      }
    }
  });

  it('keeps the fields the wiki reads', () => {
    expect(field('claim', 'subject')?.targetTrackerTypes).toEqual(['entity']);
    expect(field('claim', 'predicate')?.type).toBe('predicate-ref');
    expect(field('claim', 'basis')?.options?.map((o) => o.value)).toEqual([
      'documented', 'observed', 'decision', 'inference',
    ]);
    expect(field('question', 'owner')?.type).toBe('user');
    expect(field('question', 'position')?.type).toBe('text');
    expect(field('question', 'positionState')?.type).toBe('select');
    // Wiki hierarchy: areas -> subareas -> pages, built from links.
    expect(field('entity', 'kind')?.options?.map((o) => o.value)).toEqual(expect.arrayContaining(['area', 'home']));
    expect(field('entity', 'labels')).toMatchObject({ type: 'label-ref', multiValue: true });
    expect(field('entity', 'parent')).toMatchObject({
      type: 'relationship', targetTrackerTypes: ['entity'], multiValue: false,
    });
    expect(field('question', 'parent')).toMatchObject({
      type: 'relationship', targetTrackerTypes: ['question'], multiValue: false,
    });
  });

  it('ships predicate packs whose ids are unique and whose subjects and targets are defined kinds', () => {
    const all = PACKS.flatMap(packPredicates);
    const ids = all.map((p) => p.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    for (const predicate of all) {
      expect(predicate.inverseLabel, predicate.id).toBeTruthy();
      for (const kind of predicate.subjectKinds) expect(KINDS).toContain(kind);
      for (const qualifier of Object.values(predicate.qualifiers ?? {})) {
        for (const target of qualifier.targetTrackerTypes ?? []) expect(KINDS).toContain(target);
      }
    }
  });

  it('validates each label pack against the predicates it can see, and the merged vocabulary as a whole', () => {
    // Every optional pack needs core, and nothing else.
    const core = packPredicates('core').map((p) => p.id);
    for (const pack of PACKS) {
      const predicateIds = pack === 'core' ? core : [...core, ...packPredicates(pack).map((p) => p.id)];
      const registry = pack === 'core' ? packLabels('core') : mergePack(packLabels('core'), packLabels(pack));
      const result = validateLabelRegistry(registry, { predicateIds });
      expect(result.issues, pack).toEqual([]);
      expect(result.warnings, pack).toEqual([]);
    }

    const merged = PACKS.map(packLabels).reduce(mergePack);
    const allPredicateIds = PACKS.flatMap(packPredicates).map((p) => p.id);
    const result = validateLabelRegistry(merged, { predicateIds: allPredicateIds });
    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([]);

    // The market pack extends core's organization rather than replacing it.
    const organization = merged.labels.find((l) => l.id === 'organization')!;
    expect(organization.properties).toEqual(expect.arrayContaining(['website', 'annual-revenue']));
    expect(resolveLabels(merged, { labels: ['feature'] })).toEqual(['feature', 'capability']);

    // Every legacy `kind` option resolves to a declared label.
    const labelIds = new Set(merged.labels.map((l) => l.id));
    for (const option of field('entity', 'kind')?.options ?? []) expect(labelIds, option.value).toContain(option.value);
  });
});
