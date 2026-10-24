---
name: ps1-playtest
description: Playtest a PlayStation (PS1) game like a player with a goal — reach a level, beat a boss, try to break a menu — using save states to explore, and write a bug report with replayable steps and a video for every problem found. Use when the user asks to playtest, try out, explore, QA, or find bugs in a PS1 game, or to check a feature works from a player's point of view.
---

# Playtesting a PS1 game

Play towards a goal, keep checkpoints, and turn every problem into something the
developer can replay.

## Set up

1. `load_disc` (or `build` for a project; `ps1test.json` sets the BIOS, pads and
   watch list). Commercial discs may need `bios` set to a real BIOS dump.
2. Learn the screen: one `screenshot` per new screen; after that `describe`
   (cheap) to know whether anything changed. PS1 games draw text as sprites or
   textured quads, so there is no text read-out: read menus from screenshots.
3. Watch what matters for the goal (`describe` with `watch`: lives, HP, score,
   position, level). Without symbols, find the addresses with `ram_search` first.

## Play

- Save a state at every checkpoint (`state` `save` with an id per place:
  "level1-start", "boss-door"); retry from there instead of from boot.
- Move in `run_sequence` batches: `hold` (or `analog` for stick-driven games) to
  move, `tap` to act, `waitUntil` on the screen settling or a RAM value, then one
  `describe`.
- Explore the edges: walls and screen edges, pausing at odd moments, two buttons
  at once, going back to a previous area, dying during a transition or a load,
  menus opened and closed fast, the memory card full / missing / unformatted
  (`memory_card` `format`, or a card without the game's save), counters at their
  limits (`write_memory`).
- Run `check` at a few points: it catches CPU exceptions, hangs, lag, GPU commands
  the console drops and stack overflows you can't see.
- Loading screens are long on PS1 (CD reads): `waitUntil` on the screen settling
  with a generous `maxFrames` rather than fixed waits.
- Stuck for 3 attempts on the same obstacle? Report it as a possible difficulty or
  design issue and move on (a cheat or `write_memory` can skip it).

## For every problem

1. Reproduce it from the nearest save state with the fewest steps.
2. `export_script` the steps (or write them), and add the check that fails:
   `assertRam` for a wrong value, `assert` for a wrong picture.
3. `record_video` a short clip of it (.gif; .mp4 if sound matters).
4. If it's visual, `gpu_capture` the frame and say which primitive is wrong.
5. Note the frame number, what you expected and what happened.

## Report

```
## Playtest: <goal> — reached / not reached
Played <N> minutes of game time, <M> checkpoints.

### Bugs
1. <title> — <severity: crash / blocker / wrong behaviour / visual / polish>
   Steps: tests/ps1/bug-<n>.json (fails at step <k>)   Clip: <path>
   Expected …  Actual …

### Notes
Difficulty, confusing moments, load times, things that felt good.
```

Severity: crash or freeze > blocks progress > wrong behaviour > visual glitch > polish.
