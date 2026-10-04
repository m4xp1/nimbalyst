/**
 * The label-driven part of an item's detail view that the chip row cannot
 * carry:
 *
 *  - qualifiers of field-stored properties that declare them (the chip edits
 *    the value; the qualifiers are edited here);
 *  - claim-stored properties, read-only at their current value (the latest
 *    `asOf` among asserted claims), with an "add statement" affordance
 *    prefilled with the predicate;
 *  - properties whose storage the vocabulary cannot resolve, flagged.
 *
 * Claim values subscribe to the claims about THIS item only
 * (`trackerClaimsAboutAtom`), so an edit to an unrelated item does not repaint
 * the section.
 */

import React, { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import {
  currentClaimValue,
  globalRegistry,
  type EffectiveProperty,
  type FieldDefinition,
  type FieldType,
  type PredicateQualifierDefinition,
} from '@nimbalyst/tracker-schema';
import { MaterialSymbol } from '../../../ui/icons/MaterialSymbol';
import { TrackerFieldEditor } from './TrackerFieldEditor';
import { trackerItemByIdAtom } from '../trackerDataAtoms';
import { getRecordTitle } from '../trackerRecordAccessors';
import { trackerClaimsAboutAtom } from './trackerClaimAtoms';
import {
  labelFieldQualifiers,
  unwrapLabelFieldValue,
  type LabelFieldDefinition,
  type TrackerLabelFieldLayout,
} from './trackerLabelFields';
import { isTrackerFieldEmpty } from './trackerFieldLayout';

const sectionLabelClasses = 'text-[11px] font-medium text-nim-muted uppercase tracking-[0.5px]';

/** A qualifier declaration as a field the ordinary editor can render. */
export function qualifierFieldDefinition(name: string, qualifier: PredicateQualifierDefinition): FieldDefinition {
  return {
    name,
    type: qualifier.type as FieldType,
    ...(qualifier.options ? { options: qualifier.options.map(value => ({ value, label: value })) } : {}),
    ...(qualifier.type === 'array' ? { itemType: 'string' as FieldType } : {}),
    ...(qualifier.type === 'relationship' ? { targetTrackerTypes: qualifier.targetTrackerTypes ?? '*' } : {}),
    displayLabel: qualifier.label ?? name,
  } as FieldDefinition;
}

export interface TrackerLabelPropertiesSectionProps {
  itemId: string;
  layout: TrackerLabelFieldLayout;
  /** The item's stored field values (qualified values still wrapped). */
  values: Record<string, unknown>;
  editable: boolean;
  /** Persist a field-stored property's full stored value. */
  onSaveField: (name: string, stored: unknown) => void;
  /** Start a new claim about this item with the predicate prefilled. Absent disables the affordance. */
  onAddStatement?: (predicateId: string) => void;
  onOpenItem?: (itemId: string) => void;
}

export const TrackerLabelPropertiesSection: React.FC<TrackerLabelPropertiesSectionProps> = ({
  itemId,
  layout,
  values,
  editable,
  onSaveField,
  onAddStatement,
  onOpenItem,
}) => {
  const qualified = useMemo(
    () => layout.fields.filter(field => Object.keys(field.labelProperty.qualifiers ?? {}).length > 0
      && !isTrackerFieldEmpty(unwrapLabelFieldValue(field, values[field.name]))),
    [layout.fields, values],
  );
  if (qualified.length === 0 && layout.claims.length === 0 && layout.unknown.length === 0) return null;

  return (
    <div className="tracker-label-properties space-y-3 pt-1 border-t border-nim" data-testid="tracker-label-properties">
      {qualified.map(field => (
        <QualifiedFieldRow
          key={field.name}
          field={field}
          stored={values[field.name]}
          editable={editable}
          onSaveField={onSaveField}
        />
      ))}
      {layout.claims.length > 0 && (
        <TrackerClaimPropertyValues
          subjectId={itemId}
          properties={layout.claims}
          onAddStatement={editable ? onAddStatement : undefined}
          onOpenItem={onOpenItem}
        />
      )}
      {layout.unknown.length > 0 && (
        <div className="tracker-label-properties-unknown flex flex-wrap items-center gap-1.5" data-testid="tracker-label-properties-unknown">
          <MaterialSymbol icon="warning" size={14} className="text-[var(--nim-warning)]" />
          <span className="text-[11px] text-nim-muted">Undeclared properties:</span>
          {layout.unknown.map(property => (
            <span
              key={property.id}
              className="tracker-label-property-unknown text-[11px] font-mono text-nim-muted"
              title={`'${property.id}' is listed by the '${property.viaLabel}' label but is neither a field property nor a predicate`}
            >
              {property.id}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

const QualifiedFieldRow: React.FC<{
  field: LabelFieldDefinition;
  stored: unknown;
  editable: boolean;
  onSaveField: (name: string, stored: unknown) => void;
}> = ({ field, stored, editable, onSaveField }) => {
  const qualifiers = labelFieldQualifiers(stored);
  const value = unwrapLabelFieldValue(field, stored);
  const declarations = Object.entries(field.labelProperty.qualifiers ?? {});
  return (
    <div className="tracker-label-qualified-field flex flex-col gap-1" data-testid={`tracker-label-qualified-${field.name}`}>
      <span className={sectionLabelClasses}>{field.displayLabel} qualifiers</span>
      <div className="flex flex-wrap gap-3">
        {declarations.map(([name, declaration]) => {
          const qualifierField = qualifierFieldDefinition(name, declaration);
          return editable ? (
            <TrackerFieldEditor
              key={name}
              field={qualifierField}
              value={qualifiers[name]}
              onChange={(next) => onSaveField(field.name, { value, qualifiers: { ...qualifiers, [name]: next } })}
            />
          ) : (
            <span key={name} className="text-[12px] text-nim-muted">
              {declaration.label ?? name}: {qualifiers[name] === undefined ? '--' : String(qualifiers[name])}
            </span>
          );
        })}
      </div>
    </div>
  );
};

export interface TrackerClaimPropertyValuesProps {
  subjectId: string;
  properties: readonly EffectiveProperty[];
  onAddStatement?: (predicateId: string) => void;
  onOpenItem?: (itemId: string) => void;
  /** For tests; defaults to now. */
  now?: Date;
}

export function TrackerClaimPropertyValues({
  subjectId,
  properties,
  onAddStatement,
  onOpenItem,
  now,
}: TrackerClaimPropertyValuesProps): React.ReactElement {
  const claims = useAtomValue(trackerClaimsAboutAtom(subjectId));
  const rows = useMemo(
    () => properties.map(property => ({
      property,
      label: globalRegistry.getPredicate(property.id)?.label ?? property.id,
      current: currentClaimValue(claims, subjectId, property.id, { now }),
    })),
    [claims, properties, subjectId, now],
  );
  return (
    <div className="tracker-claim-property-values flex flex-col gap-1" data-testid="tracker-claim-property-values">
      <span className={sectionLabelClasses}>Statements</span>
      {rows.map(({ property, label, current }) => (
        <div
          key={property.id}
          className="tracker-claim-property-row flex items-center gap-2 text-[12px]"
          data-testid={`tracker-claim-property-${property.id}`}
        >
          <span className="tracker-claim-property-label min-w-[110px] text-nim-muted">{label}</span>
          {current ? (
            <button
              type="button"
              className="tracker-claim-property-value flex items-center gap-1 text-left text-nim hover:underline"
              title={current.asOf ? `As of ${current.asOf}${current.stale ? ' (more than 90 days old)' : ''}` : 'Undated statement'}
              onClick={() => onOpenItem?.(current.claimId)}
            >
              <span className="select-text">
                {current.value ?? (current.objectId ? <ClaimObjectTitle itemId={current.objectId} /> : '')}
              </span>
              {current.stale && (
                <span className="tracker-claim-property-stale text-[10px] text-[var(--nim-warning)]" data-testid={`tracker-claim-property-stale-${property.id}`}>
                  stale
                </span>
              )}
            </button>
          ) : (
            <span className="tracker-claim-property-empty text-nim-faint">Not stated</span>
          )}
          <button
            type="button"
            className="tracker-claim-property-add ml-auto flex items-center gap-0.5 text-[11px] text-nim-muted enabled:hover:text-nim disabled:opacity-50"
            disabled={!onAddStatement}
            title={onAddStatement ? `Add a '${label}' statement` : 'Statements cannot be added here'}
            data-testid={`tracker-claim-property-add-${property.id}`}
            onClick={() => onAddStatement?.(property.id)}
          >
            <MaterialSymbol icon="add" size={13} />
            Add statement
          </button>
        </div>
      ))}
    </div>
  );
}

function ClaimObjectTitle({ itemId }: { itemId: string }): React.ReactElement {
  const record = useAtomValue(trackerItemByIdAtom(itemId));
  return <>{record ? getRecordTitle(record) || itemId : itemId}</>;
}
