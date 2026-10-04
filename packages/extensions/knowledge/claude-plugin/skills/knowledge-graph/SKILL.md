---
name: knowledge-graph
description: Write a knowledge graph in Nimbalyst trackers -- entities, claims, questions, findings, investigations, the labels that say what each page is, and the predicates that connect them -- following the project's wiki guide. Use when the user wants to record what is known about products/systems/decisions in the team wiki or knowledge base, or to add pages, statements, questions, or findings to an existing graph. To set up a new graph or add a vocabulary pack, use the knowledge-setup skill.
---

# Knowledge graph

## First: read the project's wiki guide

Before writing anything, find the project's guide page: an `entity` whose `aliases` contain `wiki-guide` (usually titled "How we write this wiki"). Read its body with `tracker_get` and follow it; it decides what belongs in this wiki, and it overrides the writing advice below wherever they disagree. The mechanics below (kinds, labels, properties, predicates, hierarchy) still apply.

If the project has no guide page, follow the base guide in `../knowledge-setup/references/wiki-guide.md`, and tell the user they can install it as an editable page with the `knowledge-setup` skill. If the kinds below do not exist yet, run `knowledge-setup` first.

## Vocabulary

A knowledge graph here is ordinary tracker data with a shared vocabulary:

- **Kinds are tracker types.** `entity`, `claim`, `question`, `finding`, `investigation`.
- **Pages are tracker items.** Each item's body is a collaborative document; write prose there.
- **Labels say what a page is.** A label is a tag that carries properties. An entity may carry several labels (a page can be a `feature` and a `surface`), and a label may sit under broader labels (`feature` is under `capability`, so every feature is also a capability).
- **Properties are stored one of two ways.** A **field** property holds a current value on the page itself. A **claim** property is a predicate: each value is a claim item with a date, a basis and sources. A label lists its properties without saying which; the registries do.
- **Statements are claim items.** `subject` (an entity) + `predicate` (a verb from the registry) + `object` (an entity) or `valueText`.
- The web console wiki reads these types and registries directly, so the vocabulary is shared across every project that uses it.

The canonical definitions are in `references/` next to this file. They are the source of truth; copy them, do not paraphrase them.

| File | What |
| --- | --- |
| `references/entity.yaml` | Anything statements are about. What it is lives in `labels`. |
| `references/claim.yaml` | One assertion under stated conditions. |
| `references/question.yaml` | A goal with constraints, an owner, and a current position. |
| `references/finding.yaml` | A scoped answer resting on exact claims. |
| `references/investigation.yaml` | One attempt at a question, including failed ones. |
| `references/packs/<pack>/labels.yaml` | A pack's labels, field properties, and claim-property extensions (`range`, `options`, `facet`). |
| `references/packs/<pack>/predicates.yaml` | A pack's claim-stored verbs. |

Packs are `core` (always), `market` and `spec` (opt-in). The project's registries are what count, not the packs: read them before writing.

<!-- desktop-only -->
- Labels and field properties: `.nimbalyst/labels.yaml` at the workspace root.
- Predicates: `.nimbalyst/predicates.yaml`.
<!-- /desktop-only -->
<!-- remote-only
- Labels, field properties and predicates: the `labels` object and `predicates` array in the `tracker_list_types` result.
-->

## Invariants (do not rename or repurpose)

- Kind ids: `entity`, `claim`, `question`, `finding`, `investigation`.
- `claim.subject` and `claim.object` are relationships to `entity`. `claim.predicate` is a `predicate-ref` whose value is a predicate `id` from the registry. `claim.basis` is one of `documented`, `observed`, `decision`, `inference`.
- `question.owner`, `question.position`, `question.positionAsOf`, `question.positionState`, `question.decidedBy`, `question.decidedAt` carry accountability. `question.subjects` targets `entity`; `question.answers` targets `finding`.
- `finding.question` targets `question`; `finding.claims` targets `claim`. `investigation.question` targets `question`.
- `entity.labels` holds label ids. `entity.kind` is the older single-valued axis and is still read as a label. The wiki hierarchy reads `entity.kind: area` and `kind: home`, `entity.parent` (targets `entity`), and `question.parent` (targets `question`).
- Label ids, property ids and predicate ids, and a predicate's `label` / `inverseLabel`, are what the wiki prints and what other pages point at. Do not change an existing id. Field properties and predicates share one id namespace.

## Hierarchy

The wiki's tree comes from links between items, not tracker folders.

- A top-level area is an entity with `kind: area`, `labels: [area]` and no `parent`.
- Subareas (also `kind: area`) and pages (any other entity) set `parent` to the entity they sit under.
- Questions appear under the entities in their `subjects`. A sub-question sets `parent` to the question it helps answer.
- Never create a cycle: before setting `parent`, walk up from the new parent and make sure you do not reach the item itself.
- Keep it shallow: an area, a subarea, then pages. Use claims, not deeper nesting, to relate pages to each other.
- Placement is navigation only. A page lives in one area, but what it is and how it relates to other pages are labels and claims, never the area it sits under.

## Labels and properties

1. **Apply every label that fits, as many as apply.** Read each label's `description`. A page about a screen that is also a user-facing capability gets `feature` and `surface`. Do not add a label's broader labels as well; they follow.
<!-- desktop-only -->
   Set `labels` on create. On update, `labels` replaces the whole set, so send the labels the page already has plus the new ones.
<!-- /desktop-only -->
<!-- remote-only
   Here labels are not a field: pass `labels: [...]` to `tracker_create`, and on `tracker_update` pass `addLabels` / `removeLabels` with only the ids that change (never the whole set; ids already on the page are left alone). A label id not in the registry is still written and comes back in `warnings`: correct the id, or draft an `add-label` proposal.
-->
2. **Structure pages keep `kind`.** Areas and the home page set `kind` (`area`, `home`) as well as `labels`, because the wiki's tree still reads `kind`. Other new pages set only `labels`. Never set `kind: concept`, and never apply the deprecated `concept` label.
3. **Start the body from the template.** When a new page has one label with a `template`, use it as the body's skeleton; with several, use the most specific label's and add headings from the others only when they have content. Drop headings you have nothing true to put under.
4. **Fill the properties the labels bring.** The page's properties are the union of `properties` over its labels and their broader labels.
   - A **field** property (declared under `properties` in the label registry) goes in the item's fields under its id. If it declares `qualifiers`, store `{ value, qualifiers }`; otherwise store the bare value. A `select` or `multiselect` takes only its declared options.
   - A **claim** property (a predicate) is recorded as a claim with the page as `subject`. Check `claimProperties.<id>`: `range` names the labels the object should carry, and `options` the values `valueText` may take.
   - An entity base field listed as a property (`website`) is set as that field.
   - Leave a property empty rather than guess. An empty property is a visible gap; a wrong one is a silent error.
5. **Satisfy `expects`.** A label's `expects` entries (`{ property, min?, max? }`) say what a complete page has. When you create or edit a page, meet each one you can from a source; when you cannot, say so on the page. Unmet expectations are reported in the Ontology inspector's health checks, never enforced.
6. **Facts that change are dated claims, not prose or fields.** A new value is a new claim with its own date; the latest asserted one is the current value. When a body sentence states something a claim property covers, record the claim too.
7. **When nothing fits, draft a proposal.** No label describes the page, or no property holds the statement: draft an `add-label` or `add-property` ontology proposal (below) instead of forcing it into the nearest label, a tag, or prose. You may apply a label that exists only in a pending proposal; the health check reports it until the proposal is applied. Applying an existing label to a page is an ordinary edit and needs no proposal.

### Market pack

Only when the registry has the market pack's labels (`product`, `market`).

- **Every product gets a market and a maker.** When you create a `product`, add an `in-market` claim to its market (qualifier `primary: true` on the main one) and a `made-by` claim to its organization, creating the organization if it does not exist. If the maker is unknown or an individual, say so on the page rather than inventing one. Put the site in the `website` field.
- **Markets are a tree.** A `market` page sits under the Markets area; a submarket sets `parent` to its market.
- **Competition is a claim, per market.** "We compete with X" is a `competes-with` claim with the project (or one of its capabilities) as subject and X as object, qualifiers `market` (the market page), `threat` (`low`, `medium`, `high`, `critical`), `overlap`, `difference`, `reviewedAt`. A product we compete with in two markets gets two claims. Do not use the legacy entity fields `group`, `overlap`, `difference`, `threat` and `reviewedAt`, or the retired `competitor` tracker.
- **Fact mechanics.** Company facts go on the organization, product facts on the product (the labels' `factBox` lists them). Put the display value in `valueText` ("$500M ARR"), the required `asOf` date and, for quantities, `amount` and `unit` (`USD`, `people`, `users`, `seats`) in `qualifiers`, and the source in `citations`. When the source only gives a month or a year, store its first day as `asOf` and set `asOfPrecision` to `month` or `year` (absent means `day`); never describe precision in `applicability`. `lifecycle` takes one of `active`, `declining`, `unmaintained`, `defunct` in `valueText`. A fact is stale 90 days after its date (after the end of its month or year for coarser precision).

### Spec pack

Only when the registry has the spec pack's labels (`subsystem`, `feature`).

- **Every spec page points at its sources.** `implemented-in` is a claim whose `valueText` is a repository path or glob, with the `commit` qualifier set to the commit you checked it against (and `repo` when the project spans several). `governed-by` names a decision: `valueText` is its issue key and `citations` links the decision item. `discussed-in` holds a session id in `valueText`, with `sessionTitle` and `date`.
- **Structure is claims.** `part-of-subsystem` places a page in a `subsystem`; `exposed-on` points at a `surface` page; `stores-in` at a `data-store`; `upholds` and `violates` at an `invariant` or `requirement` (a `violates` claim names the tracking bug in `issue`).
- **When code moves,** add a new `implemented-in` claim that supersedes the old one; do not edit the body to follow the code.
- Spec labels are for wiki pages, not tracker types: a project's `feature` tracker type (planned work) is unrelated to the `feature` label.

## Ontology proposals

Never change the ontology silently. Schema and structure changes are `ontology-proposal` items: `title`, `reason`, `status` (`proposed`, `accepted`, `applied`, `rejected`, `undone`; derived, never set by hand except leaving new items `proposed`), `request`, `healthCheck`, `changes` (a JSON string holding an array) and `undo` (written only by the web console). People review each change in the Ontology inspector (Trackers > Tracker setup > Ontology on web; Settings > Project > Trackers > Ontology on desktop), which is read-only.

Each change is `{ id, type, reason? }` plus the fields for its type. Never set `decision`, `decidedBy`, `decidedAt`, `rejectReason`, `appliedAt` or `undoneAt`, except `appliedAt` as described in step 5.

| `type` | Fields | Applied by |
| --- | --- | --- |
| `add-label` | `label`: a label registry entry | agent (schema) |
| `add-property` | `storage` (`field` or `claim`), `property`: a field property entry, or a predicate entry for `claim`; `claimProperty?`: its `range` / `options` / `facet`; `labelIds?`: labels that should list it | agent (schema) |
| `add-label-property` | `labelId`, `propertyId`, `expects?` (`{ min?, max? }`) | agent (schema) |
| `add-broader` | `labelId`, `broaderId` | agent (schema) |
| `extend-range` | `propertyId`, `labelIds` (added to its `range`) | agent (schema) |
| `split-label` | `labelId`, `into`: new label entries, `pageIds`: `{ <newLabelId>: [pageId] }` | agent (new labels), then web console (pages) |
| `apply-label` | `labelId`, `pageIds` | web console |
| `add-market-node` | `title`, `parentId?` (omitted: under the Markets area), `summary?`, `aliases?` | web console |
| `merge-duplicates` | `keepId`, `mergeIds` (references are repointed, merged titles become aliases, merged items are archived; works across types) | web console |
| `move-field-to-claims` | `field`, `predicate`, `pageIds?`, `subjectId?`, `qualifiers?` (qualifier name -> entity field), `staticQualifiers?`, `valueText?` | web console |

`add-kind-option`, `add-predicate` and `reclassify-pages` are retired: they stay readable in old proposals, but never draft them. Use `add-label`, `add-property` with `storage: claim`, and `apply-label`.

1. **Pick up requests.** List `ontology-proposal` items with status `proposed` and empty `changes` (`[]` or blank). The inspector's Improve and Suggest structure buttons create them; `request` names the problem and the affected page ids, and `healthCheck` names the check, for example `unmet-expects:<label>:<property>`, `unknown-label:<label>`, `undeclared-property`, `range-violation:<property>`, `off-label-claim`, `label-cycle:<a>+<b>`, `duplicate-label:<a>+<b>`, `sparse-field:<type>[:<label>]:<field>`, `deprecated-field:entity:<kind>:<field>`, `broken-links`, `undeclared-predicates`, `stale-facts`, `duplicates`, `suggest-structure`. Older requests may name `catch-all-kind:<kind>`, `missing-market`, `missing-maker` or `missing-competes-with`.
2. **Check history first.** Read every other proposal (any status) for the same `healthCheck` or the same change. Never re-propose a change whose decision is `rejected`; read its `rejectReason`.
3. **Draft.** Write `changes` and `reason` onto the request item with `tracker_update`, one proposal per request, splitting a large fix into several changes. Leave `status` as `proposed`. You may also create a proposal yourself whenever a write needs a label or property that does not exist.
4. **Review happens in the inspector.** The person accepts or rejects each change and applies them. The web console writes the data changes and keeps an undo record; nothing is deleted.
5. **Apply accepted schema changes yourself.** The browser cannot edit schemas. For each accepted change marked "agent" above without `appliedAt`, make the edit with `tracker_define_type`, which merges by id: `labels: { labels: [...] }` for a new or changed label (send the full label entry, existing keys unchanged, with the property, `expects` or broader label appended), `labels: { properties: [...] }` for a field property, `predicates: [...]` plus `labels: { claimProperties: {...} }` for a claim property, and the `range` extended in place for `extend-range`. Never send removals. Then set that change's `appliedAt` to the current ISO time in `changes`, keeping every other field as it was.

## Extending

- A new kind of thing is a new label, never a new `entity` field, `kind` option, or tracker type. A new thing to say about pages is a new property. Both go through a proposal.
- Choose storage deliberately: a **field** for a stable attribute where history and sources do not matter (a flag name, a platform list); a **claim** for anything that changes over time, needs a source, or relates two pages.
- A new predicate has `id`, `label`, `inverseLabel`, `subjectKinds: [entity]`, `valueShape` (`entity`, `text`, `boolean-assessment`, `quantity`, or `select`), `direction` (`directed` or `symmetric`; required), and the qualifiers a reader needs to act on it. `range` and `options` go in `claimProperties`, not in the predicate.
- Reuse before adding: search the registries for a property that already means the same thing. Two labels that need `owner` share the one `owner`.
- Create a new standalone tracker kind only when the thing is not something statements are made about and has genuinely different fields; relationships that target `entity` will not accept it.
- Add; never repurpose an existing label, property or option to mean something else.

## Writing the graph

- **One assertion per claim.** If the sentence has "and", it is two claims. Title the claim as the plain sentence ("Product A exports CSV").
- **Basis is a field, not a trust score.** `documented` = someone's docs say so; `observed` = seen or tested; `decision` = we chose it; `inference` = reasoned, not seen. Never invent a confidence number.
- **A documentation claim is never relabelled as tested.** When a test confirms it, add a separate `observed` claim that cites the test, and leave the documented one as it was.
- **State when it holds** in `applicability` (versions, plans, platforms) and put sources in `citations`.
- **Changing a claim** means a new claim with `supersedes` set and the old one moved to `superseded`, not an in-place rewrite of what was asserted.
- **Questions carry a current position.** Update `position`, `positionAsOf`, and `positionState` as the answer firms up. `status` tracks work; `positionState` tracks acceptance -- `answered` does not mean `accepted`. Set `owner`; set `decidedBy`/`decidedAt` only when someone with authority accepts the position.
- **Findings cite exact claims** in `claims` and say where the answer holds (`scope`) and where it does not (`limitations`). Link the finding back from `question.answers`.
- **Investigations are recorded even when inconclusive.** Put versions and config in `environment`; link findings you reused in `reusedFindings`.
- Search for an existing entity (title and `aliases`) before creating one. Add alternate names to `aliases` instead of creating duplicates. When the page exists, add the labels it lacks rather than creating a second page.

## References in bodies

Link items from any body with the issue key as label and URL:

- `[KEY](nimbalyst://KEY)` -- inline link.
- `[KEY](nimbalyst://KEY "view=card")` -- embedded card (on its own line).
- `[ENTITY-KEY](nimbalyst://ENTITY-KEY "view=statements")` -- embedded list of the claims about that entity.

Only link keys you created or looked up. A typical entity page: a short summary, then a `view=statements` embed of itself, then cards for the findings and questions that concern it.
