# Updating RiverField and reviewing Freefield

`origin` is `ai-joe-git/riverfield`; `upstream` is `neuregex/freefield`.

## Update an installation

Run `./update.sh` from a clean `main` branch. It fetches **origin/main** and
accepts only a fast-forward: diverged history is never automatically merged.
It then updates dependencies when needed, applies available machine-local
overlays and validates the manifests. It does not restart services. Local
overlays may modify files; inspect `git status` afterwards.

## Review upstream without integrating it

```bash
git remote add upstream https://github.com/neuregex/freefield.git # once, if absent
./update.sh --check-upstream
```

This only fetches and displays recent upstream commits. The displayed list is
**not** a list of missing patches.

The histories have different commit IDs and no Git merge base. Their initial
commits (`9297496` in RiverField, `d6909b2` in Freefield) have identical trees.
Most upstream patches were already imported with new IDs. Do not use
`--allow-unrelated-histories` to merge the projects.

For maintainers: compare `git patch-id --stable` over
`git log --no-merges -p --pretty='format:commit %H' <base>..<tip>` on each side.
Then inspect unmatched patches with `git show`. Adapt only the wanted changes
on a dedicated branch, preserving RiverField's branding, queue, GPU settings
and the integrated agent. Validate and review the diff before merging into main.

## Review baseline (9 November 2026)

Freefield tip: `f3d32ce`. Of its 81 post-base patches, 79 were already identical
in RiverField. The two remaining changes have now been adapted:

- `e5fa71b`: proxy discovery in inactive virtual environments, SIGTERM cleanup
  in `tools/local_backend.py`, and console encoding fallback.
- `f3d32ce`: correct MiniMax Music 3 model licensing, extended here to
  `music-turbo` and `music-turbo-hq` as well as `music`.

Adapted patches need not have the same patch ID as upstream. Keep this baseline
in mind when reviewing future commits rather than importing them again.

## Review baseline (19 November 2026)

Freefield tip: `f7540e1`. Nine commits after `f3d32ce`; none matched a
RiverField patch ID, so none had been imported already.

Adopted:

- `905eb6f` (and its `a98ed93` test fix): the global `foreign()` cross-site and
  DNS-rebinding guard, per-visitor history with `ff_vid`, `RIVERFIELD_SHARED_HISTORY`,
  the `admitting` race counter, `/api/jobs` off on hosted demos, and the
  `ipaddress` private-range fix in `infra/gateway.py`.
- `f0c2358`: the hosted web app gets 2 GB of memory for upload buffering.
- `f7540e1`: the top menus stay open while the pointer heads diagonally toward
  the panel; RiverField's 3D menu is included.
- `178f86c` (local backend parts only): clearer Hugging Face 401/403 messages and
  no duplicated `--extra-model-paths-config`.
- `5088cd8` (selected parts only): `plainHttpToIp` cookies, shared-history
  support, and the second look before believing a job is `"expired"`.

Not adopted:

- `aa676c5`: the large Russian localization. It is not a drop-in patch for
  RiverField's English/Spanish UI and would need its own translation pass.
- `5088cd8`'s Dockerfile, image workflow, `infra/pod.py` and cloud-GPU guide:
  CUDA/NVIDIA and Freefield-branded; a RiverField pod image would need ROCm and
  its own release pipeline.
- `73cc249` and the pod parts of `178f86c`: only useful with that pod image.
- `96276f1`: upstream sponsors and referral links; not RiverField branding.
