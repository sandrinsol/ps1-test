---
name: ps1-ci-tests
description: Set up automated regression tests for a PlayStation (PS1) game that run in CI (GitHub Actions) using step scripts and golden images from the ps1-test harness. Use when the user wants their PS1 game tested on every push or pull request, or asks to add CI for a PS1 disc image or EXE.
---

# CI regression tests for a PS1 game

Tests are step scripts (JSON) replayed by `runner.mjs`. Replays are deterministic, so
golden images and RAM checks are stable across runs and machines.

## 1. Write the scripts

In the user's repo create `tests/ps1/<name>.json`:

```json
{ "rom": "build/game.cue",
  "video": { "path": "failures/<name>.gif", "onlyOnFail": true, "seconds": 10 },
  "steps": [
    { "waitUntil": { "address": "frame_count", "as": "u32", "op": "gte", "value": 30 }, "maxFrames": 900 },
    { "tap": "START" },
    { "waitUntil": { "screen": "stable", "frames": 20 } },
    { "assert": "goldens/<name>-title.png", "ignore": [{ "x": 16, "y": 32, "w": 288, "h": 8 }] },
    { "assertRam": "lives", "as": "u8", "equals": 3 }
  ] }
```

A script may also set `"bios"`, `"region"` and `"pad1"`. The fastest way to get
one is to play the scenario with the MCP tools and `export_script`, then add
`assert` / `assertRam` steps. `rom` is relative to the working directory; every
other path (goldens, the failure clip) to the script. Mask anything that changes
every frame (counters, timers) with `ignore`.

## 2. Create the goldens

Run each script once locally — missing goldens are created — and look at every
created PNG before committing it. Commit `tests/ps1/goldens/`.

## 3. Add the workflow

Copy [workflow.yml](workflow.yml) to `.github/workflows/ps1-tests.yml` and adjust
the build step (it installs PSn00bSDK with the template's script; for other
toolchains replace it, or download the disc image from an earlier job) and the
disc path. It fetches the harness, runs every script, and uploads screenshots,
diffs and failure clips as an artifact. Projects started from the `psn00bsdk`
template already have it.

## Notes

- Goldens come from the core's own software renderer, so they don't depend on the
  GPU of the CI machine; regenerate them with `UPDATE_GOLDENS=1` only when the
  picture is meant to change, and review the diff.
- Discs boot through OpenBIOS in ~150 frames: start scripts with a `waitUntil` on a
  variable the game sets (or the screen settling), not a fixed wait.
- Keep scripts short and focused (one feature each); long scripts fail late.
- Don't commit commercial discs or BIOS dumps; build the game in CI. Commercial
  games that need a real BIOS can't run in public CI.
