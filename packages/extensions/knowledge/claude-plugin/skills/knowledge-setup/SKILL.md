---
name: knowledge-setup
description: Initialize or repair a project's knowledge graph in Nimbalyst trackers -- define the entity, claim, question, finding, and investigation kinds, merge the core vocabulary pack (and the market or spec pack when asked) into the label and predicate registries, create the wiki home page, and install the "How we write this wiki" guide page. Safe to re-run; it never overwrites or deletes. Use when the user wants to start a team wiki or knowledge base, add a vocabulary pack, or check that an existing one is set up.
---

# Knowledge setup

<!-- remote-only
On the wiki server, `tracker_define_type` and the other tools act on the team project `wiki_status` resolved, and connecting a repository (`wiki_bind_repo` or `wiki_create_project`) already runs this setup there with the core pack. Use this skill when the user asks to check or repair a wiki's setup, or to add the market or spec pack.
-->

Sets up everything the `knowledge-graph` skill writes into. Every step checks what exists first, adds only what is missing, and reports each step as **created**, **already present**, or **conflict**. Never delete, rename, or overwrite anything; stop and ask when a step would.

The kind definitions are in `../knowledge-graph/references/` (five kind files). The vocabulary is in `../knowledge-graph/references/packs/<pack>/`, each pack a `labels.yaml` (labels, field-stored properties, claim-property extensions) and a `predicates.yaml` (claim-stored verbs). The base wiki guide is `references/wiki-guide.md` next to this file. Copy them; do not paraphrase them.

## 0. Packs

| Pack | Adds | When |
| --- | --- | --- |
| `core` | Labels `area`, `home`, `topic`, `person`, `organization` (and the deprecated `concept`, loadable only); the general relationship verbs. | Always. |
| `market` | Labels `product`, `market`, `capability`, `technology`, `protocol`, `format`, `connector`; market, maker and competition verbs; dated organization and product facts. | The team tracks the products, companies and markets it decides against. |
| `spec` | Labels `subsystem`, `feature`, `surface`, `requirement`, `invariant`, `data-store`, `integration`, `wire-protocol`; structure and provenance verbs that point pages at code paths, decisions and sessions. | The wiki is the project's specification. |

Always install `core`. Ask the user which of `market` and `spec` to add, unless they already said. A pack is already installed when its first label exists (`market`: `product`; `spec`: `subsystem`); offer only the missing ones.

## 1. Kinds

1. Call `tracker_list_types` and note which of `entity`, `claim`, `question`, `finding`, `investigation` already exist and who owns them (`personal` or `team:<name>`).
<!-- desktop-only -->
2. Decide sharing. If the project is shared with a team, define the kinds with `sharing: team` so the web console and teammates see them. Otherwise leave `sharing: personal`. Use the same sharing for all five.
3. For each missing kind, read its reference file and call `tracker_define_type` with `schema` set to the YAML converted to a JSON object (drop comments; change only `sharing`).
<!-- /desktop-only -->
<!-- remote-only
2. Sharing: nothing to decide. The server stores every kind as a team kind whatever `sharing` says.
3. For each missing kind, read its reference file and call `tracker_define_type` with `schema` set to the YAML converted to a JSON object (drop comments; change nothing else).
-->
4. If a kind already exists, compare it to the reference. Missing fields or options (for example `entity.labels`) may be added with a `schema` + `overwrite: true` that keeps every existing field. Never remove, rename, or change the type of an existing field or option, never pass `confirmDestructive` on your own, and never overwrite a kind that differs in an incompatible way. Report each conflict to the user with the field names and stop for that kind.
<!-- desktop-only -->
5. Switching an existing personal kind to team needs `promoteExistingItems: true`; ask the user first.
<!-- /desktop-only -->

## 2. Vocabulary

<!-- desktop-only -->
Read the project's current registries from `.nimbalyst/predicates.yaml` and `.nimbalyst/labels.yaml` at the workspace root (for a team project these are the local copies of the team's registries; a missing file means an empty registry).
<!-- /desktop-only -->
<!-- remote-only
Read the project's current registries from the `predicates` array and the `labels` object in the `tracker_list_types` result (missing means empty). Ignore any `.nimbalyst/*.yaml`: they are not the server's copy.
-->

For `core`, then each chosen pack, in that order, make at most one `tracker_define_type` call carrying both halves. Both arguments merge by id: an entry replaces the entry with its id or is added, and entries you omit are kept. So send only what is new, never an entry the project already has.

- **`predicates`:** every predicate in the pack's `predicates.yaml` whose `id` is not in the registry. An existing predicate with the same `id` but a different definition is a conflict: keep it and report it.
- **`labels.labels`:** every label whose `id` is not in the registry. A label that already exists (a pack may extend one another pack defines, as `market` does with `organization`) is sent only if the pack adds to it: send the existing entry unchanged except `properties`, `factBox` and `expects` extended with the pack's entries it lacks (existing order first). Never change any other key of an existing label.
- **`labels.properties`:** every field property whose `id` is not in the registry. An existing one that differs is a conflict.
- **`labels.claimProperties`:** every entry whose predicate id has none yet.

Predicates are applied before labels in the same call, so a label may name a predicate the call adds. A property id that is already a predicate (or the reverse) is a conflict; report it and leave both alone. Never send `removePredicates` or `labels.remove`. If nothing is missing for a pack, make no call.

## 3. Wiki home page

Look for an `entity` with `kind: home` (`tracker_list` with `type: entity` and `where` on `kind`). If one exists, use it and report it. Otherwise create one: `kind: home`, `labels: [home]`, no `parent`, a title such as "<Project> wiki", and a short body saying what the wiki covers. There is one home page per project; if you find several, report them and use none until the user picks.

## 4. Guide page

The guide tells people and agents what belongs in the wiki. It is a wiki page, so it syncs to the team and the web console like any other page, and a team may rewrite it completely.

- **Base version:** `2`. Bump it whenever `references/wiki-guide.md` changes.
- **Assemble the text:** `references/wiki-guide.md` holds a section per optional pack between `<!-- pack:<id> -->` and `<!-- /pack:<id> -->` lines. Keep the sections of installed packs, drop the rest, and remove the marker lines. That text is "the base" below.
- **Find it:** an `entity` whose `aliases` contain `wiki-guide` (include archived items; an archived guide means the team retired it, so report that and do not recreate it).

If there is no guide page, create it:

- `type: entity`, `title: How we write this wiki`, `kind: topic`, `labels: [topic]`, `parent` set to the home page, `aliases: [wiki-guide]`.
- `tags: [wiki-guide-base:2]` (the base version it was installed from).
- `description`: the assembled base, unchanged.
<!-- desktop-only -->
- In a team project, publish it if the tracker leaves it as a draft, then read it back with `tracker_get` and confirm it has an issue key and the body.
<!-- /desktop-only -->
<!-- remote-only
- Read it back with `tracker_get` and confirm it has an issue key and the body.
-->

If a guide page already exists, **never overwrite it**. Compare its body with the base, ignoring whitespace-only differences, and read its `wiki-guide-base:<n>` tag:

- Same text: report "already present, matches base version <n>".
- The only difference is the section of a pack installed after the guide was: report "already present, missing the <pack> section".
- Different text, tag equals the current base version: the team has edited it. Report "already present, edited by the team".
- Different text, older or missing tag: the base guide has changed since it was installed, and the team may also have edited it. Report both facts.

In the "different" and "missing section" cases, offer the user a diff between their page and the base, and offer a merge: keep every team edit, and propose only the base changes (or the missing pack section) that do not conflict with them. Write the merged body with `tracker_update` (`description`, plus the tag set to the current base version, keeping other tags) only after the user approves the merged text. A team that has replaced the guide on purpose may decline; that is final until they ask again.

## Report

End with one line per step: packs (installed, added this run), kinds (each kind: created / already present / fields added / conflict), vocabulary (per pack: labels, properties and predicates added, labels extended, or none; conflicts), home page (key), guide page (key and status from step 4).
