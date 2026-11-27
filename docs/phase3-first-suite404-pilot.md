# Phase 3 — First SUITE 404 Production Pilot (prepared, not launched)

Status: **prepared, awaiting explicit human authorization**. No render, observation,
comparison, senior review or canonical change has been launched.

## Run

```text
run id:       phase3-suite404-pilot-001
production:   suite-404
season:       suite-404-s01
episode:      suite-404-s01e02 (Velvet Moon, draft)
profile:      build
status:       prepared
stage:        plan
canonical:    0
```

The existing scene `suite-404-s01e02-sc01` — Velvet Moon (experimental) — is only an
optional narrative starting point. Its candidate is not treated as canonical.

Two new draft scenes were created for the run:

```text
suite-404-s01e02-sc02  After Hours Toast
suite-404-s01e02-sc03  Room Service Confession
```

## Brief

> A small two-scene romantic-comedy loop: Akari challenges Daichi to an after-hours toast,
> then an awkward near-confession in the suite is interrupted by room service.

## Scene plan

### Scene 02 — After Hours Toast

- Objective: Akari challenges Daichi to recreate the Velvet Moon toast without spilling
  the drink.
- Intended events: Akari sets two glasses on the bar; Daichi raises a glass and tries to
  match her toast; the glass wobbles and they both freeze.
- Dialogue requirements: “You call that a toast?” / “I call it a controlled pour.”
- Characters: Akari, Daichi.
- Location: Velvet Moon Bar.
- Target duration: 7.3 s.
- Transition: cut to scene 03.
- References:

```text
suite404-official-akari-character-sheet
suite404-official-daichi-character-sheet
suite404-asset-20261125-005052479-3984-1   Suite_404_Velvet_Moon_Bar_Master
```

### Scene 03 — Room Service Confession

- Objective: The toast moves to the suite; Daichi attempts a confession before room
  service knocks.
- Intended events: Daichi carries the glasses into the suite; Akari laughs at a small
  spill; a room-service knock interrupts the near-confession.
- Dialogue requirements: “There is something I should—” / “Room service has excellent timing.”
- Characters: Akari, Daichi.
- Location: Suite 404 bedroom.
- Target duration: 7.3 s.
- Transition: end.
- References:

```text
suite404-official-akari-character-sheet
suite404-official-daichi-character-sheet
suite404-official-suite-404-bedroom-master
```

No untrusted or ambiguous asset is selected automatically. The pending eleven-asset
correction batch is not applied by this pilot.

## Generation profile and payloads

- Build profile: **0.1 MP**, no upscale, prompt enhancer on, Fast Review.
- Application: `h3-studio-director-flash`.
- Detailed cinematic prompts are not written here; the existing Director prompt enhancer
  remains responsible for the final model prompt.
- Exact prepared request templates: `out/observations/phase3-pilot/pilot-plan.json`
- Persisted run: `out/observations/phase3-pilot/production-run.json`
- Each scene has three ordered reference pictures and one 7.3-second Build segment.

## Budgets

```text
max renders per scene:          1
max total renders:              2
max prompt enhancement calls:   2
max observation jobs:           2
max comparison calls:           2
max senior review batches:      0 (selective Senior Review remains available but is not
                                   budgeted for this first Build pilot)
wall clock:                     120 minutes
automatic regenerations:        0
```

The run engine reserves each budget item durably before the corresponding operation. A
failed job is recorded and does not retry automatically.

## Approval checkpoints

1. After scene 02 candidate registration and Fast observation.
2. After deterministic validation and continuity preparation.
3. Human approves/rejects scene 02. Approval advances the plan; it does **not** canonize.
4. After scene 03 candidate registration, observation, validation and continuity review.
5. Human approves/rejects scene 03.
6. Canonical changes, if any, remain a separate interactive Production CLI approval.

## Required authorization

Starting this pilot will launch two Build renders, two Fast observations, two comparison
passes and no Senior Review. It will not approve candidates or change canonical memory.

The run must remain `prepared` until the user explicitly authorizes:

```text
phase3-suite404-pilot-001
```

No standalone model benchmark is authorized or prepared.
