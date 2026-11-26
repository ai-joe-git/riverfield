# Riverfield Production Engine — Phase 0

Phase 0 is the production-level source of truth for persistent series, seasons, episodes and
scenes. Existing Directors remain independent execution clients: their UI, workflows, render
profiles, media bins and saved projects keep their current behavior.

The implementation is deliberately local and backend-first. There is **no video observation,
ASR, embedding store, vector database or autonomous multi-agent workflow** in this phase.

## Source-of-truth model

```text
Production
  Season
    Episode
      Scene
        candidate bindings  ──> immutable render candidates ──> History runs/outputs
        canonical decision
        Identity / State / Episodic / Narrative facts
```

A **scene** is a narrative unit. A **candidate** is an immutable render result, and a **binding**
maps a candidate segment to final-output frames for one scene. A candidate may cover several
scenes, and a scene may use several segments of one candidate. Scene decisions are therefore
stored per scene, never as a global candidate status.

```ts
type SceneRenderBinding = {
  sceneId: string;
  candidateId: string;
  runId?: string;
  timebase: "final-output";
  timelineStartFrame: number;
  timelineEndFrame: number;
  segmentIndex: number;
  sourceStartFrame?: number;
  sourceEndFrame?: number;
  outputHash?: string;
  fps?: number;
};
```

## Storage contract

```text
out/productions/<productionId>/
  events/000000000001-<eventId>.json   append-only event journal
  snapshot.json                        rebuildable projection/cache
```

Each event contains a sequence number, previous-event hash and its own SHA-256 hash. Events are
written to a temporary file, fsynced and atomically renamed; a crash cannot expose a partially
written event. A per-production lock serializes writers. A duplicate command key returns the
existing event instead of appending again.

`snapshot.json` is not a source of truth. It is rebuilt from the journal when missing, stale or
corrupt. A rollback appends a `canon.rolled_back` event referencing the target revision; it never
deletes or rewrites earlier events.

## Immutable candidates and editorial decisions

Candidate JSON is stored once and never mutated. A `candidate.registered` event indexes it.
History integration is non-destructive: the candidate points to the existing file path and run
ID; no media is moved or copied. A candidate has no global approved/rejected status.

A `CanonProposal` may contain:

- one scene-level decision: `canon`, `alternate` or `reject`, with exact candidate/binding IDs;
- zero or more proposed canonical facts.

Only an approved proposal changes the snapshot. A scene-level `canon` decision records the exact
candidate and binding IDs for that scene. Another scene supplied by the same candidate remains
draft until its own decision is approved.

## Canonical memory

The four agreed categories are typed arrays in the snapshot:

| Category | Meaning |
|---|---|
| `identity` | Stable identity, appearance, voice, personality, base relationships, art-direction rules |
| `state` | Current positions, wardrobe, injuries, props, emotions and relationship stance |
| `episodic` | Past events and consequences |
| `narrative` | Open threads, promises, payoffs and recurring gags |

Every canonical fact carries:

- stable fact ID;
- category and text;
- optional structured data, subject IDs and tags;
- provenance (source, actor, source run, source event);
- revision;
- approving human and approval timestamp;
- the event that approved it.

Intent, observation and canon are separate:

- a candidate stores the prompt/reference context that produced it;
- an observation is a separate immutable record and never enters the canonical snapshot by itself;
- only an approved proposal writes a canonical fact or scene decision.

## Bounded ProductionContext

`buildProductionContext()` is engine-independent and returns:

- `identity`, `state`, `episodic`, `narrative` sections;
- selected facts and truncation flags;
- recent canonical scenes;
- the final prompt-ready text;
- the canonical revision.

Selection is typed and bounded by `maxChars` (default 8,000; hard range 500–64,000). It does not
embed or semantically search the Bible. A Director can opt in through the hidden
`production_id` / `production_scene_id` inputs; the prompt preflight then prepends the canonical
context. Directors without an association keep the existing previous-scene truncation behavior
unchanged.

## Human approval boundary

There is intentionally **no HTTP or MCP approval tool**. Agents may create productions, seasons,
episodes, scenes, candidates, observations and proposals, but cannot approve them.

Canonical approval is a separate interactive CLI:

```sh
npm run production -- list
npm run production -- show <productionId>
npm run production -- approve <productionId> <proposalId>
npm run production -- rollback <productionId> <targetRevision>
```

The command requires a real TTY, prints the exact candidate/scene/changes/expected canonical
revision, and requires the human to type a challenge derived from the proposal fingerprint.
The approval proof records the OS user, timestamp, exact fingerprint and expected revision. A
piped or non-interactive invocation is rejected.

This is an application-level human boundary, not WebAuthn or a hardware-backed signature. A
process with full local shell access can still bypass local application controls; that is a
remaining Phase 0 limitation. MCP and the HTTP API expose no approval route.

Rollback uses the same interactive gate. It appends a restoration event; it does not truncate
the journal or rewrite the snapshot history.

## SUITE 404 fixture

The importer indexes existing `out/history` metadata and media without moving or duplicating
anything:

```sh
npm run production:import-suite404
```

It is idempotent. It creates:

- production `suite-404`;
- Season 01;
- E01 “Passion Max” with fifteen draft scenes;
- E02 “Velvet Moon (experimental)” as a draft episode/scene;
- distinct candidates for the existing V6, V7 and Velvet Moon runs;
- image assets from the existing SUITE 404 asset runs.

It never invents a missing run, asset, frame range, evidence item or approval. Every imported
scene remains `draft`; the importer creates **zero** canonical decisions. Creative approval and
canonical approval remain distinct.

## API and MCP

Local HTTP API:

```text
GET  /api/productions
POST /api/productions
GET  /api/productions/:id
GET  /api/productions/:id/context?sceneId=...
POST /api/productions/:id/seasons
POST /api/productions/:id/episodes
POST /api/productions/:id/scenes
POST /api/productions/:id/candidates       # accepts runId + explicit bindings
POST /api/productions/:id/observations
POST /api/productions/:id/assets
POST /api/productions/:id/proposals
```

MCP adds read/write production tools: `list_productions`, `create_production`,
`get_production`, `create_season`, `create_episode`, `create_scene`, `get_scene_context`,
`register_candidate`, `record_scene_observation` and `propose_canonical_changes`.
There is deliberately no MCP approval or rollback tool.

## Migration and compatibility

- No existing app, Director project or History entry is modified by Phase 0.
- Production Store files are additive under `out/productions/`.
- History entries gain an optional `production` association when a Director receives
  `production_id`; old entries remain valid.
- The six Director manifests expose hidden, derived `production_id` and `production_scene_id`
  inputs. Existing projects simply leave them empty and keep their current prompt-context path.
- No schema migration from an earlier Production Engine exists yet; Phase 0 is the first store.

## Remaining limitations

- No automatic observation of generated video, keyframe extraction or ASR.
- No embeddings/vector search; retrieval is typed and bounded.
- No multi-agent orchestrator.
- No approval web UI.
- The approval boundary is local-TTY based, not cryptographic device attestation.
- Imported frame ranges come from recorded native segment windows; actual output probing is not
  part of Phase 0.
- Candidate media paths point at existing History files; moving or deleting those files requires
  a future migration/maintenance workflow.
- The Bible has no rich relational editor yet; facts are proposed through the API/MCP and approved
  through the CLI.
