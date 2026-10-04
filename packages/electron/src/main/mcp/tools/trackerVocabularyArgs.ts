/**
 * The vocabulary half of `tracker_define_type`: the `predicates` (claim-stored)
 * and `labels` (labels plus field-stored properties) arguments.
 *
 * Both MERGE BY ID into the local copy (`.nimbalyst/predicates.yaml`,
 * `.nimbalyst/labels.yaml`): an entry replaces the entry with its id or is
 * appended, and entries the caller omits are kept. Replacing the whole
 * registry, which `predicates` used to do, made two agents extending the
 * vocabulary at once clobber each other; merge-by-id makes their additions
 * commute. Deletion is explicit (`removePredicates`, `labels.remove`), and
 * anything the classifiers cannot prove additive needs `confirmDestructive`,
 * because it invalidates values already written on teammates' items. The
 * classification only gates; any canonical difference is written, so a
 * rename or a new description is not dropped as "no change".
 */

import {
  applyLabelRegistryPatch,
  canonicalLabelRegistryJson,
  globalRegistry,
  classifyLabelRegistryChanges,
  classifyPredicateRegistryChanges,
  destructivePredicateRegistryChanges,
  validateLabelRegistry,
  validatePredicateRegistry,
  type LabelRegistry,
  type LabelRegistryRemovals,
  type PredicateDefinition,
} from '@nimbalyst/tracker-schema';
import { canonicalPredicateRegistryJson } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/predicateRegistryMerge';
import { applyWorkspaceLabelRegistryInProcess, applyWorkspacePredicateRegistryInProcess } from '../../services/TrackerSchemaService';
import {
  readWorkspacePredicateRegistry,
  writeWorkspacePredicateRegistry,
} from '../../services/tracker/trackerPredicateRegistryFile';
import {
  readWorkspaceLabelRegistry,
  writeWorkspaceLabelRegistry,
} from '../../services/tracker/trackerLabelRegistryFile';
import type { McpToolResult } from './trackerToolResult';

type Outcome<T> = { error: McpToolResult } | ({ summary: string } & T);

function errorResult(text: string): { error: McpToolResult } {
  return { error: { content: [{ type: 'text', text }], isError: true } };
}

function issueList(issues: ReadonlyArray<{ code: string; path: string; message: string }>): string {
  return issues.map(issue => `- ${issue.code} at '${issue.path}': ${issue.message}`).join('\n');
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Merge `args.predicates` (upserts) and `args.removePredicates` (ids) into the
 * registry. Returns the resulting registry so `labels` can be validated
 * against it in the same call.
 */
export async function applyPredicateRegistryArgs(
  workspacePath: string,
  args: any,
): Promise<Outcome<{ applied: PredicateDefinition[] }>> {
  const validation = validatePredicateRegistry(Array.isArray(args?.predicates) ? args.predicates : []);
  if (!validation.valid) {
    return errorResult(`Error: invalid predicate registry.\n${issueList(validation.issues)}`);
  }
  const current = readWorkspacePredicateRegistry(workspacePath);
  if (current === null) {
    return errorResult('Error: .nimbalyst/predicates.yaml is invalid; fix it before merging predicates into it.');
  }

  const removed = stringList(args?.removePredicates);
  const next = current.filter(predicate => !removed.includes(predicate.id));
  for (const predicate of validation.predicates) {
    const at = next.findIndex(existing => existing.id === predicate.id);
    if (at >= 0) next[at] = predicate;
    else next.push(predicate);
  }

  const { classification, changes } = classifyPredicateRegistryChanges(current, next);
  if (classification === 'destructive' && args?.confirmDestructive !== true) {
    return errorResult(
      `This predicate registry change is destructive and needs \`confirmDestructive: true\`:\n${destructivePredicateRegistryChanges(changes)
        .map(change => `- ${change.kind} on '${change.predicateId}'`)
        .join('\n')}\nStatements already written under these predicates stop validating.`,
    );
  }

  // The classifier only sees what can invalidate stored values; a relabel is
  // still an edit. Whether to write is canonical equality.
  const changed = canonicalPredicateRegistryJson(next) !== canonicalPredicateRegistryJson(current);
  if (changed) {
    await writeWorkspacePredicateRegistry(workspacePath, next);
    applyWorkspacePredicateRegistryInProcess(workspacePath, next);
  }
  return {
    applied: next,
    summary: !changed
      ? `Predicate registry unchanged (${next.length} predicate(s)).`
      : `Merged into .nimbalyst/predicates.yaml: ${next.length} predicate(s) (${classification === 'none' ? 'presentation' : classification} change).`,
  };
}

/**
 * Merge `args.labels` ({labels?, properties?, claimProperties?, remove?}) into
 * the label registry. Cross-registry checks (one id namespace, `expects` and
 * `properties` naming a real property or predicate) run here, with the
 * predicate registry in hand, rather than on sync decode.
 */
export async function applyLabelRegistryArgs(
  workspacePath: string,
  args: any,
  predicates: readonly PredicateDefinition[] | null,
): Promise<Outcome<{ applied: LabelRegistry }>> {
  const input = args?.labels;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return errorResult('Error: `labels` must be an object: {labels?, properties?, claimProperties?, remove?}.');
  }
  const { remove, ...patch } = input as Record<string, unknown>;
  const patchValidation = validateLabelRegistry(patch);
  if (!patchValidation.valid) {
    // Broader targets may live in the stored registry; re-check them on the merge below.
    const structural = patchValidation.issues.filter(issue => issue.code !== 'LABEL_BROADER_UNKNOWN');
    if (structural.length > 0) return errorResult(`Error: invalid label registry entries.\n${issueList(structural)}`);
  }

  const current = readWorkspaceLabelRegistry(workspacePath);
  if (current === null) {
    return errorResult('Error: .nimbalyst/labels.yaml is invalid; fix it before merging labels into it.');
  }
  const removals: LabelRegistryRemovals = remove && typeof remove === 'object'
    ? {
        labels: stringList((remove as Record<string, unknown>).labels),
        properties: stringList((remove as Record<string, unknown>).properties),
        claimProperties: stringList((remove as Record<string, unknown>).claimProperties),
      }
    : {};
  const next = applyLabelRegistryPatch(current, patch as Partial<LabelRegistry>, removals);

  const predicateIds = (predicates ?? readWorkspacePredicateRegistry(workspacePath) ?? globalRegistry.getAllPredicates()).map(p => p.id);
  const merged = validateLabelRegistry(next, { predicateIds });
  if (!merged.valid) {
    return errorResult(`Error: the merged label registry is invalid.\n${issueList(merged.issues)}`);
  }

  const { classification, changes } = classifyLabelRegistryChanges(current, merged.registry);
  if (classification === 'destructive' && args?.confirmDestructive !== true) {
    return errorResult(
      `This label registry change is destructive and needs \`confirmDestructive: true\`:\n${changes
        .filter(change => change.destructive)
        .map(change => `- ${change.kind} on '${change.id}'${change.detail ? ` (${change.detail})` : ''}`)
        .join('\n')}\nValues already written under these labels or properties lose their declaration.`,
    );
  }

  const changed = canonicalLabelRegistryJson(merged.registry) !== canonicalLabelRegistryJson(current);
  if (changed) {
    await writeWorkspaceLabelRegistry(workspacePath, merged.registry);
    applyWorkspaceLabelRegistryInProcess(workspacePath, merged.registry);
  }
  const warnings = merged.warnings.length > 0 ? `\nWarnings:\n${issueList(merged.warnings)}` : '';
  return {
    applied: merged.registry,
    summary: (!changed
      ? `Label registry unchanged (${merged.registry.labels.length} label(s), ${merged.registry.properties.length} field propert(ies)).`
      : `Merged into .nimbalyst/labels.yaml: ${merged.registry.labels.length} label(s), ${merged.registry.properties.length} field propert(ies) (${classification === 'none' ? 'presentation' : classification} change).`) + warnings,
  };
}
