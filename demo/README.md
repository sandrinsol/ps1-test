# Demo

`demo.cue` + `demo.bin` is a small PlayStation game built from
[`templates/psn00bsdk`](../templates/psn00bsdk) (original code and art, GPL-3.0+ like
the rest of this repo): text, a player you move with the D-pad or the left stick,
and a spinning cube. `demo.exe` is the same program as a PS-EXE and `demo.elf` its
symbols (`frame_count`, `cpu_usage`, `player_x`, `player_y`, …).

Play it from the play page (**Try the demo**), or test it:

```bash
node harness/runner.mjs templates/psn00bsdk/tests/ps1/smoke.json   # from the template dir
```

Rebuild it with `demo/build.sh` (needs PSn00bSDK).
