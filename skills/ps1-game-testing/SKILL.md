---
name: ps1-game-testing
description: Test a PlayStation (PS1) game or homebrew (.cue/.bin/.iso disc image or .exe) with the ps1-test MCP tools — boot it, play it, check the screen, RAM and GPU commands, find addresses, record clips, and turn a session into a regression test. Use when the user asks to test, play, check, debug or verify a PS1/PSX game, disc image or PS-EXE.
---

# Testing PS1 games

The `ps1-test` MCP server runs the game in a deterministic emulator (PCSX-ReARMed,
with the free OpenBIOS) that is paused between tool calls: the same inputs always
give the same frames, RAM and GPU commands.

## Workflow

1. `load_disc` with the `.cue` (or `.bin`/`.iso`/`.exe`). A disc boots through the
   BIOS in ~150 frames; an EXE starts at once. If the game must be built first,
   use `build` (see `ps1-homebrew-dev`). Options: `bios` (`openbios`, `hle`, or a
   BIOS dump for commercial games that need one), `region` (`ntsc`/`pal`),
   `pad1: "analog"` for games that want sticks.
2. Drive it with **one `run_sequence` per stretch of play**, not many single calls:
   `[{"waitUntil": {"screen": "stable", "frames": 30}, "maxFrames": 900}, {"tap": "START"}, {"wait": 60}, {"shot": "menu"}]`.
   Every tool call resends the conversation, so batching is the biggest saving.
3. Wait for the game, don't guess: `wait_until` (or a `waitUntil` step) on a RAM
   value (`"frame_count"`, a symbol) or on the screen changing / settling.
4. Look only when needed: `describe` (pc, watched values, display mode, % changed)
   costs far less than a `screenshot`. `gpu_capture` lists what a frame draws — the
   way to see *why* something looks wrong (missing sprite = never sent, or sent
   off-screen, or with an empty CLUT).
5. Check what matters:
   - picture: `assert_golden` (first run creates the golden; mask counters/clocks
     with `ignore`),
   - values: `read_memory` / `assertRam` steps,
   - health: `check` (exceptions, hangs, lag, CPU load, GPU and memory rules).
6. Don't know where a value lives? `ram_search` `start` (type `u16` first — PS1
   games usually keep counters in 16 or 32 bits), change it in game, `filter`
   until one address is left, confirm with `write_memory`.
7. Turn the session into a test: `export_script`, add `assert` / `assertRam`
   steps, replay it with `run_sequence` to prove it passes.

## Useful facts

- Buttons: `CROSS CIRCLE SQUARE TRIANGLE L1 R1 L2 R2 L3 R3 START SELECT UP DOWN LEFT RIGHT`;
  `port: 2` (or `"P2:CROSS"` in steps) for the second pad. Sticks: `set_analog`
  (-128..127). 60 frames ≈ 1 s (50 on PAL).
- Addresses: RAM `0x80000000-0x801FFFFF` (also readable as `0x00…`/`0xA0…`),
  scratchpad `0x1F800000`, I/O `0x1F801000`, BIOS `0xBFC00000`. Pass hex strings,
  or names when there's a symbol file (`.elf`/`.map`/`.sym` beside the disc/EXE).
- Every load and reset ends on frame 10, so input right after a load is deterministic.
- Hung game? `check` names the CPU exception and the function it happened in;
  `read_cpu` shows where the CPU is (`cop0` cause for exceptions).
- Who changes a value? `debug` with `watch: [{address}]` and `halt: false` lists
  every write with the function that made it; with `halt` it stops there with the
  call stack. Turn it `off` when done. Slow game: `profile` shows time per function.
- Textures and VRAM: `view_vram` (`gpu: true` outlines the texture pages and CLUTs
  in use); one texture through its CLUT: `what: "texture"`.
- Memory cards: `memory_card` `list` shows saves (title, blocks, icon); `import`
  boots with a card image; `format` inserts a blank one.
- Save states (`state` `save` / `load`) are the fastest way to retry from a point.
- For a person: `record_video` (.gif plays everywhere, .mp4 has sound), or
  `run_sequence` with `video: {path}` to keep a clip only when a check fails.

## Reporting

Say what you ran, what passed and failed (with the frame number), and attach the
relevant screenshot or clip path. Don't paste raw RAM or GPU dumps unless asked.
