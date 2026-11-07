import { describe, expect, it } from 'vitest';
import { globalRegistry, resolveFields, type TrackerDataModel } from '../TrackerDataModel';

const model = (type: string, fields: TrackerDataModel['fields']): TrackerDataModel => ({ type, displayName: type, displayNamePlural: type, icon: 'task', color: '#123456', modes: { inline: true, fullDocument: true }, idPrefix: type, idFormat: 'ulid', fields });

describe('composite tracker fields', () => {
  it('uses an explicit workspace resolver and preserves primary field precedence', () => {
    globalRegistry.register(model('composite-audit-primary', [{ name: 'wrongWorkspace', type: 'string' }]));
    const primary = model('composite-audit-primary', [{ name: 'status', type: 'select' }, { name: 'dependsOn', type: 'relationship', multiValue: true }]);
    const secondary = model('secondary', [{ name: 'status', type: 'text' }, { name: 'target', type: 'reference' }]);
    const models = new Map([[primary.type, primary], [secondary.type, secondary]]);
    const fields = resolveFields([primary.type, 'unknown', secondary.type, primary.type], type => models.get(type));
    expect(fields.map(field => field.name)).toEqual(['status', 'dependsOn', 'target']);
    expect(fields[0]).toBe(primary.fields[0]);
    expect(resolveFields([primary.type]).some(field => field.name === 'wrongWorkspace')).toBe(true);
  });

  it('validates composite workspace fields without replacing the global model', () => {
    const primary = model('composite-validation-primary', [{ name: 'title', type: 'string' }]);
    const secondary = model('composite-validation-secondary', [{ name: 'estimate', type: 'number', min: 0 }]);
    globalRegistry.register(primary);
    const registeredFields = globalRegistry.get(primary.type)?.fields;
    const models = new Map([[primary.type, primary], [secondary.type, secondary]]);
    const effective = { ...primary, fields: resolveFields([primary.type, secondary.type], type => models.get(type)) };
    expect(globalRegistry.validate(primary.type, { estimate: 'bad' }, effective).errors).toContainEqual({ field: 'estimate', message: "Field 'estimate' must be a number" });
    expect(globalRegistry.validate(primary.type, { estimate: 2 }, effective).valid).toBe(true);
    expect(globalRegistry.validate(primary.type, { estimate: 'bad' }).valid).toBe(true);
    expect(globalRegistry.get(primary.type)?.fields).toEqual(registeredFields);
  });
});
