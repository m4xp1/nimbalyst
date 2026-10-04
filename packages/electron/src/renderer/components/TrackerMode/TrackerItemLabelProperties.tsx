/**
 * Tracker Mode's host for the label-driven section of the detail pane:
 * qualifier editing, claim-stored values, and undeclared properties (see
 * `TrackerLabelPropertiesSection`). This file adds what only Electron can do --
 * creating the claim behind "Add statement" and opening it.
 */

import React, { useCallback } from 'react';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { TrackerLabelPropertiesSection } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/TrackerLabelPropertiesSection';
import type { TrackerLabelFieldLayout } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerLabelFields';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { canCreateClaimStatements, createClaimStatement } from './createClaimStatement';

export interface TrackerItemLabelPropertiesProps {
  item: TrackerRecord;
  workspacePath?: string;
  layout: TrackerLabelFieldLayout;
  /** Stored values with in-progress edits applied (qualified values still wrapped). */
  values: Record<string, unknown>;
  editable: boolean;
  onSaveField: (name: string, stored: unknown) => void;
  onOpenItem?: (itemId: string) => void;
}

export const TrackerItemLabelProperties: React.FC<TrackerItemLabelPropertiesProps> = ({
  item,
  workspacePath,
  layout,
  values,
  editable,
  onSaveField,
  onOpenItem,
}) => {
  const handleAddStatement = useCallback(async (predicateId: string) => {
    if (!workspacePath) return;
    try {
      const claimId = await createClaimStatement({ workspacePath, subject: item, predicateId });
      onOpenItem?.(claimId);
    } catch (error) {
      errorNotificationService.showError(
        'Could not add the statement',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [item, onOpenItem, workspacePath]);

  const canAdd = !!workspacePath && layout.claims.length > 0 && canCreateClaimStatements();

  return (
    <TrackerLabelPropertiesSection
      itemId={item.id}
      layout={layout}
      values={values}
      editable={editable}
      onSaveField={onSaveField}
      onAddStatement={canAdd ? handleAddStatement : undefined}
      onOpenItem={onOpenItem}
    />
  );
};
