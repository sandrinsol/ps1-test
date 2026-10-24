// Packaging check: `npm pack` the repo, install the tarball into an empty project,
// start the installed `ps1-test-mcp` bin over stdio, and drive an EXE with it.
// Proves the published package is self-contained (core, BIOS, page, modules, deps).
//
//   node tests/package.mjs   (exit 0 = pass, 1 = fail; needs the npm registry)

import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
};

// The root (published) and harness (dev) manifests must agree.
const root = JSON.parse(await readFile(path.join(REPO, 'package.json'), 'utf8'));
const dev = JSON.parse(await readFile(path.join(REPO, 'harness', 'package.json'), 'utf8'));
ok('versions match', root.version === dev.version, `${root.version} / ${dev.version}`);
ok('dependencies match', JSON.stringify(root.dependencies) === JSON.stringify(dev.dependencies));
// The Claude Code plugin manifest starts the server through launch.mjs.
const plugin = JSON.parse(await readFile(path.join(REPO, '.claude-plugin', 'plugin.json'), 'utf8'));
const launch = plugin.mcpServers?.['ps1-test']?.args?.[0]?.replace('${CLAUDE_PLUGIN_ROOT}', REPO);
ok('plugin version matches', plugin.version === root.version, `${plugin.version} / ${root.version}`);
ok('plugin starts an existing launcher', !!launch && existsSync(launch), launch);
ok('plugin skills exist', ['ps1-game-testing', 'ps1-playtest', 'ps1-ci-tests', 'ps1-homebrew-dev', 'psn00bsdk', 'ps1-hardware', 'ps1-performance', 'ps1-real-hardware'].every((n) => existsSync(path.join(REPO, 'skills', n, 'SKILL.md'))));
ok('plugin agents exist', ['ps1-tester', 'ps1-reviewer'].every((n) => existsSync(path.join(REPO, 'agents', `${n}.md`))));

const work = await mkdtemp(path.join(tmpdir(), 'ps1test-pkg-'));
try {
  const npm = (args, cwd) => execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const [{ filename, files }] = JSON.parse(npm(['pack', '--json', '--pack-destination', work], REPO));
  const names = files.map((f) => f.path);
  ok('tarball has the core and BIOS', ['data/cores/pcsx_rearmed-wasm.data', 'data/cores/reports/pcsx_rearmed-ps1test.json', 'data/bios/openbios.bin'].every((f) => names.includes(f)));
  ok('tarball has the page + server', names.includes('harness/page.html') && names.includes('harness/mcp-server.mjs') && names.includes('harness/launch.mjs'));
  ok('tarball has no tests, demo or core sources', !names.some((f) => f.startsWith('harness/tests/') || f.startsWith('demo/') || f.startsWith('core/')));
  ok('tarball has the template without build output', ['templates/psn00bsdk/src/main.c', 'templates/psn00bsdk/CMakeLists.txt', 'templates/psn00bsdk/assets/player.tim', 'templates/psn00bsdk/.devcontainer/Dockerfile'].every((f) => names.includes(f)) && !names.some((f) => /^templates\/[^/]+\/build\//.test(f)));

  await writeFile(path.join(work, 'package.json'), '{"name":"consumer","private":true}');
  // Skip the postinstall; fetch the browser this install's Playwright expects (a
  // no-op when cached) unless PS1TEST_CHROMIUM points at one.
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(work, filename)], work);
  if (!process.env.PS1TEST_CHROMIUM) npm(['exec', '--', 'playwright', 'install', 'chromium'], work);
  await copyFile(path.join(REPO, 'harness', 'tests', 'fixtures', 'hello.exe'), path.join(work, 'hello.exe'));

  const sdk = (p) => import(pathToFileURL(path.join(work, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', p)).href);
  const { Client } = await sdk('client/index.js');
  const { StdioClientTransport } = await sdk('client/stdio.js');
  const client = new Client({ name: 'pkg-test', version: '0' });
  await client.connect(new StdioClientTransport({
    command: path.join(work, 'node_modules', '.bin', 'ps1-test-mcp'),
    env: { ...process.env, PS1TEST_ROOT: work },
    stderr: 'ignore',
  }));
  try {
    ok('installed server reports its version', client.getServerVersion()?.version === root.version);
    const load = /** @type {any} */ (await client.callTool({ name: 'load_disc', arguments: { path: 'hello.exe' } }));
    ok('installed server boots an EXE', !load.isError, load.content?.[0]?.text);
    const shot = /** @type {any} */ (await client.callTool({ name: 'screenshot', arguments: { scale: 1 } }));
    ok('installed server takes screenshots', shot.content?.some((c) => c.type === 'image'));
    execFileSync(path.join(work, 'node_modules', '.bin', 'ps1-test-mcp'), ['new', 'psn00bsdk', 'mygame'], { cwd: work });
    ok('installed bin creates a project', ['src/main.c', 'CMakeLists.txt', 'ps1test.json', '.gitignore', 'tests/ps1/smoke.json'].every((f) => existsSync(path.join(work, 'mygame', f))));
  } finally {
    await client.close();
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
