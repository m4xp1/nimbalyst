# How we write this wiki

This wiki holds what a capable agent would need to rebuild this project from scratch, and nothing more. The code says how the project works. The wiki says what the team wants it to be, why, and what the team knew when it decided. Agents and people read this page before adding to the wiki.

Edit this page to fit your team. It overrides the base guide Nimbalyst ships.

## The test for every page and statement

Write something down only if all three are true:

1. **A strong model would get it wrong without the note.** It could not infer it from the code, the repository history, or general knowledge. It is not a best practice, a library's documentation, or anything a modern model already does well.
2. **A person chose it, or a person needed it to choose.** It records a decision, a preference, a constraint, or a judgment of quality, or the context the team weighed when making one. You don't need to know the competitors to build to the spec, but the team needed to know them to decide what the product does, and the next decision will need them too. What the code merely implies doesn't count.
3. **It will still matter when the code has changed.** Implementation details, file layouts, and step-by-step plans expire. Intent, constraints, and reasons last.

If a statement fails any test, leave it out. If an existing page fails, supersede or archive it. Deleting stale content is part of maintaining the wiki.

## What belongs here

- **What the project is and who it is for.** The problem, the users, and what the project deliberately is not.
- **Decisions and their reasons.** Especially the non-obvious ones, the rejected alternatives, and the reversals. Write the reason in a sentence; the reason is what stops a later agent from undoing the decision.
- **Taste and quality bar.** What "good" means here, where the team departs from convention, and which trade-offs the team makes on purpose (for example, "local-first before team features" or "no curated default model list").
- **Constraints that are not visible in the code.** Legal, security, privacy, cost, platform, and partner commitments.
- **Hard-won lessons.** Incidents and failures a model would repeat, with the one rule each one taught. Skip the incident narrative.
- **Decision context.** What the team weighs when it decides: customers and what they asked for, competitors and where they overlap, markets, technologies, and partners, with the facts about them the team relies on, each dated and sourced. Link decisions to the context they rested on, so a later reader can tell when a changed fact reopens a decision.
- **Open questions.** What the team has not decided, who owns each question, and the current position.

## What does not belong here

- Anything a model already knows: language features, framework usage, standard patterns, general engineering practice.
- Anything the code already states: APIs, schemas, file structure, configuration values. Link to the code if a pointer helps.
- Plans for individual features, task lists, status updates, and meeting notes. Those belong in trackers and expire when the work ships.
- Changelogs and release notes.
- Restatements. If a fact is on one page, link to it; do not copy it.

## How to write

- Short. A page is usually a few paragraphs. A decision is usually one sentence of choice and one of reason.
- Specific. Name the thing, the date, and the person or team who decided. "We chose X over Y because Z (decided by the platform team, 2026-03)" beats "X is preferred."
- One idea per statement. Facts about the domain go in as statements with a subject, a relationship, and a value, each with a date and a source, not buried in prose.
- State certainty. Mark what is decided, what is observed, and what is inferred. Do not present an inference as a decision.
- Prefer updating to appending. When something changes, supersede the old statement so its history stays visible.
- Label every page with each label that fits, and fill in what those labels ask for. A page can be a feature and a surface at once.
- Facts that change over time are dated statements with a source, never prose. A newer value is a new statement; the old one stays as history.

## For agents

- Read this page and the wiki home before writing.
- Before adding a page, search for an existing one. Extend it or link to it.
- Record a decision when a person makes it, in their words, attributed to them. Do not invent decisions or reasons.
- When the wiki's structure does not fit what you need to record (a missing label, property, or relationship), propose a change instead of forcing the content into the wrong place.
- When you are unsure whether something passes the test, leave it out and ask.
<!-- pack:market -->

## Markets, makers and competitors

- Every product sits in at least one market and names its maker. If the maker is unknown or an individual, say so on the page rather than inventing one.
- Markets form a tree under the Markets area. Put a product in the most specific market that fits; mark the main one as primary.
- Competition is a statement per market, not a folder. "We compete with Product A in note-taking, threat high" is one statement; the same product in a second market is a second statement, with its own threat.
- Company facts (revenue, funding, headcount) go on the organization; product facts (pricing, licence, platforms, users, lifecycle) go on the product. Each has an as-of date and a source. A fact older than 90 days is stale; research a newer one before relying on it.
<!-- /pack:market -->
<!-- pack:spec -->

## The spec

- The spec is the part of the wiki someone would need to rebuild the project: subsystems, features, surfaces, requirements, invariants, data stores, integrations, and the wire protocols the project's own parts speak.
- Every spec page points at its sources: the paths that implement it (with the commit they were checked against), the decisions that govern it, and the sessions where it was worked out. A spec page with no source is a guess; mark it as one.
- Write the why and the rules, not the code. An invariant names the rule, the incident or decision behind it, and what enforces it. A requirement is one sentence a reviewer can check.
- When the code moves, re-point the implementation statement rather than editing the prose. When a rule is knowingly broken, record that it is violated and link the bug.
- Spec pages are not work items. Plans and tasks stay in trackers; the spec page links the decision they produced.
<!-- /pack:spec -->
