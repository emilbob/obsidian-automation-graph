#!/usr/bin/env node
/* Offline harness for the Automation Graph plugin.
 *
 *   node check.js [vault-root] [--html out.html]
 *
 * Runs the plugin's real parse → build → layout → SVG path against the real
 * repo with no Obsidian around it, and prints what it derived. The plugin is
 * otherwise only observable by opening it, which makes "did the parser break?"
 * a question nobody can answer from CI or from a terminal.
 *
 * Exit code is 1 when the graph comes out structurally empty (no runners, or no
 * edges) — that is a parser regression, not a vault with nothing in it. Drift
 * findings are printed but never fail the run: drift is a fact about the vault,
 * and this script reports on the code.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

// The plugin requires 'obsidian' at load time; nothing in the derivation path
// touches it, so a stub is enough to import the module outside the app.
const load = Module._load;
Module._load = function stub(request, ...rest) {
  if (request === 'obsidian') {
    // PluginSettingTab must be a class: the settings tab extends it at module
    // load, and `class X extends undefined` is a TypeError before any test runs.
    return {
      ItemView: class {},
      Plugin: class {},
      Notice: class {},
      PluginSettingTab: class {},
      Setting: class {},
      requestUrl: async () => { throw new Error('harness: no network'); },
    };
  }
  return load.call(this, request, ...rest);
};

const plugin = require('./main.js');
const {
  readSources, buildGraph, layout, renderSvg, approxWidth, nextFire, resolveRepoRoot,
  findRepoCandidates, keyboardTarget, graphAriaLabel,
} = plugin.__internals;

const args = process.argv.slice(2);
const htmlFlag = args.indexOf('--html');
const htmlOut = htmlFlag >= 0 ? args[htmlFlag + 1] : null;
const declFlag = args.indexOf('--declared');
const declared = declFlag >= 0 ? args[declFlag + 1] : '';
// The vault and the repository are separable now, so the harness has to be able
// to separate them too — otherwise the arrangement most users have is the one
// arrangement never tested.
const vaultFlag = args.indexOf('--vault');
const vaultArg = vaultFlag >= 0 ? args[vaultFlag + 1] : null;
const positional = args.filter((a) => !a.startsWith('--')
  && a !== htmlOut && a !== declared && a !== vaultArg);
// Positional stays the repository, so `node check.js .` means what it always
// meant. --vault splits the two apart when you want to test that arrangement.
const root = path.resolve(positional[0] || '.');
const vaultRoot = vaultArg ? path.resolve(vaultArg) : root;
plugin.__internals.configure({ declaredNote: declared });

/* resolveRepoRoot decides where every read below happens, and it is pure — so
 * it is checked here rather than only being exercised by hand in the app. */
const cases = [
  ['', '/v', '/v', 'empty falls back to the vault'],
  ['/abs/repo', '/v', path.normalize('/abs/repo'), 'absolute is taken as given'],
  ['../work/api', '/v/vault', path.resolve('/v/vault', '../work/api'), 'relative resolves against the vault'],
  ['~', '/v', os.homedir(), 'bare ~ is home'],
  ['~/code/x', '/v', path.join(os.homedir(), 'code/x'), '~/ expands'],
  ['  /abs/repo/  ', '/v', path.normalize('/abs/repo'), 'whitespace and trailing slash are ignored'],
];
let unitFailures = 0;
for (const [input, vault, want, label] of cases) {
  const got = resolveRepoRoot(path, vault, input, os.homedir());
  if (got !== want) {
    console.error(`FAIL resolveRepoRoot: ${label} — ${JSON.stringify(input)} gave ${got}, wanted ${want}`);
    unitFailures += 1;
  }
}
console.log(`resolveRepoRoot: ${cases.length - unitFailures}/${cases.length} cases pass`);

/* Detection decides what a first run sees, and it walks a real filesystem — so
 * it is checked against a real one, built here and thrown away, rather than
 * against a mock that cannot reproduce the things that actually go wrong
 * (unreadable directories, huge trees, repos nested inside repos). */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vag-detect-'));
  const mk = (rel, workflows) => {
    const dir = path.join(tmp, rel);
    fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    for (let i = 0; i < workflows; i += 1) {
      fs.writeFileSync(path.join(dir, `.github/workflows/w${i}.yml`), 'on: push\n');
    }
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    return dir;
  };

  const big = mk('code/api', 4);
  mk('code/site', 1);
  // Noise that must not be picked up: no workflows, and a vendored copy that
  // would otherwise show up as a third repository.
  fs.mkdirSync(path.join(tmp, 'code/notes'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'code/api/node_modules/dep/.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'code/api/node_modules/dep/.github/workflows/x.yml'), 'on: push\n');

  const found = findRepoCandidates(fs, path, path.join(tmp, 'vault'), tmp);
  const roots = found.map((c) => c.root);
  const detectChecks = [
    [found.length === 2, `found exactly the two real repos (got ${found.length}: ${roots.join(', ')})`],
    [roots[0] === big, 'the repo with the most workflows is offered first'],
    [found[0] && found[0].workflows === 4, 'workflow counts are right'],
    [!roots.some((r) => r.includes('node_modules')), 'vendored copies are skipped'],
    [found.every((c) => c.isGit), 'git repositories are recognised as such'],
  ];
  for (const [ok, label] of detectChecks) {
    if (!ok) { console.error(`FAIL findRepoCandidates: ${label}`); unitFailures += 1; }
  }
  console.log(`findRepoCandidates: ${detectChecks.filter(([ok]) => ok).length}/${detectChecks.length} cases pass`);

  // The budget is the only thing standing between "opens instantly" and
  // "walks your entire home directory", so it is asserted, not assumed.
  const wide = path.join(tmp, 'wide');
  for (let i = 0; i < 200; i += 1) fs.mkdirSync(path.join(wide, `d${i}`), { recursive: true });
  const t0 = Date.now();
  findRepoCandidates(fs, path, wide, tmp, { budget: 60 });
  const ms = Date.now() - t0;
  console.log(`  budget honoured on a 200-directory tree: ${ms}ms`);
  if (ms > 1500) { console.error('FAIL findRepoCandidates: scan is too slow to run on open'); unitFailures += 1; }

  fs.rmSync(tmp, { recursive: true, force: true });
}

const src = readSources(fs, path, root, vaultRoot);
const graph = buildGraph(src);
const view = layout(graph, { measure: approxWidth, maxWidth: 330 });   // a real sidebar's width

const byKind = {};
for (const n of graph.nodes) (byKind[n.kind] = byKind[n.kind] || []).push(n);

console.log(`repo:  ${root}`);
console.log(`vault: ${vaultRoot}${vaultRoot === root ? ' (same — vault is the repository)' : ''}`);
console.log(`sources: ${src.workflows.length} workflow(s), ${src.agents.length} agent(s), `
  + `declared note ${declared ? (src.doc ? 'found' : 'MISSING') : 'not configured'}`);
console.log(`graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges, `
  + `${view.width}×${view.height}px, ${Math.max(...view.nodes.map((n) => n.rank)) + 1} ranks`);
console.log('');

for (const kind of Object.keys(byKind).sort()) {
  console.log(`${kind} (${byKind[kind].length})`);
  for (const n of byKind[kind]) {
    const mark = n.verified ? ' ' : '~';
    const next = n.cron ? `  next ${(nextFire(n.cron) || new Date(0)).toISOString().slice(0, 16)}Z` : '';
    console.log(`  ${mark} ${n.label}${n.source ? `   [${n.source}]` : ''}${next}`);
  }
}

console.log('\nedges');
for (const e of graph.edges) console.log(`  ${e.from}  --${e.type}-->  ${e.to}`);

console.log(`\ndrift findings: ${graph.drift.length}`);
for (const d of graph.drift) console.log(`  ⚠ ${d.text}`);

/* Keyboard traversal, against the real laid-out graph rather than a toy one.
 * The property that matters is reachability: a keyboard user must be able to
 * get from the first node to every other one, or the panel is a maze with
 * rooms that have no doors. Checked by walking, not by assertion about one
 * hand-picked node. */
console.log('\nkeyboard');
{
  const first = keyboardTarget(view, null, 'ArrowRight');
  const seen = new Set();
  const queue = [first];
  while (queue.length) {
    const at = queue.shift();
    if (!at || seen.has(at)) continue;
    seen.add(at);
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown']) {
      const next = keyboardTarget(view, at, key);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  const unreachable = view.nodes.filter((n) => !seen.has(n.id));
  console.log(`  entry node: ${first}`);
  console.log(`  reachable by arrow keys: ${seen.size}/${view.nodes.length}`);
  if (unreachable.length) {
    for (const n of unreachable.slice(0, 8)) console.log(`  ✗ unreachable: ${n.label} (${n.id})`);
    unitFailures += 1;
  }

  // Down and up must undo each other along a real edge, or the reader cannot
  // back out of where a keypress took them.
  let asym = 0;
  for (const n of view.nodes) {
    const fwd = keyboardTarget(view, n.id, 'ArrowDown');
    if (!fwd) continue;
    const isEdge = graph.edges.some((e) => e.from === n.id && e.to === fwd);
    if (!isEdge) continue;                       // fell through to a rank hop
    const back = keyboardTarget(view, fwd, 'ArrowUp');
    if (back !== n.id && !graph.edges.some((e) => e.to === fwd && e.from === back)) asym += 1;
  }
  console.log(`  edge steps that reverse cleanly: ${asym === 0 ? 'all' : `${asym} do not`}`);
  if (asym) unitFailures += 1;

  /* The key must move the selection the way the key points.
   *
   * The first version of this bound edge-following to left/right in a graph
   * that is laid out top to bottom, so pressing → moved the selection
   * downward and ↓ moved it sideways. Every check here passed: the graph was
   * still fully reachable and every step still reversed. Reachability and
   * reversal are properties of the graph, and say nothing about whether the
   * keyboard agrees with what is on screen — so geometry is asserted now.
   */
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  let wrongWay = 0;
  for (const n of view.nodes) {
    for (const [key, ok, label] of [
      ['ArrowDown', (a, b) => b.y > a.y, 'down should move down'],
      ['ArrowUp', (a, b) => b.y < a.y, 'up should move up'],
      ['ArrowRight', (a, b) => b.x > a.x || b.y > a.y, 'right should move right or onto the next line'],
      ['ArrowLeft', (a, b) => b.x < a.x || b.y < a.y, 'left should move left or onto the previous line'],
    ]) {
      const to = keyboardTarget(view, n.id, key);
      if (!to) continue;
      const t = byId.get(to);
      if (!ok(n, t)) {
        if (wrongWay < 5) console.error(`FAIL keyboard geometry: ${key} from ${n.label} — ${label}`);
        wrongWay += 1;
      }
    }
  }
  console.log(`  key direction matches screen direction: ${wrongWay === 0 ? 'all moves' : `${wrongWay} do not`}`);
  if (wrongWay) unitFailures += 1;

  // Every node must carry a name a screen reader can read out. Counted off the
  // rendered output rather than the model, since the markup is what assistive
  // technology actually meets.
  const markup = renderSvg(view);
  const named = (markup.match(/role="button" aria-label="[^"]+"/g) || []).length;
  console.log(`  nodes with an accessible name: ${named}/${view.nodes.length}`);
  if (named !== view.nodes.length) unitFailures += 1;

  console.log(`  graph label: "${graphAriaLabel(view)}"`);
}

if (htmlOut) {
  const css = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
  fs.writeFileSync(htmlOut, `<!doctype html><meta charset="utf-8"><style>
:root{--background-secondary:#1e2127;--background-primary-alt:#22262e;--background-modifier-border:#3a3f4b;
--background-modifier-hover:#2a2f38;--background-modifier-form-field:#262b33;--text-normal:#dcddde;
--text-muted:#9aa0a6;--text-faint:#6b7280;--interactive-accent:#7c6cf0;--color-yellow:#c9a227;
--color-blue:#4b7bec;--color-purple:#9068c9;--color-cyan:#37a6a6;--color-pink:#c95f9b;--color-green:#3fa66a;
--color-orange:#d08a3e;--font-monospace:ui-monospace,monospace}
body{margin:0;background:#181b21;font-family:-apple-system,Segoe UI,sans-serif}
.pane{width:340px;height:820px;border:1px solid #3a3f4b;background:var(--background-primary-alt);overflow:auto}
${css}</style><div class="pane vag-root"><div class="vag-scroll">${renderSvg(view)}</div></div>`);
  console.log(`\nwrote ${htmlOut}`);
}

if (unitFailures) {
  console.error(`\nFAIL: ${unitFailures} check(s) failed — see the ✗ lines above.`);
  process.exit(1);
}

const runners = graph.nodes.filter((n) => n.kind === 'workflow' || n.kind === 'routine');
if (!runners.length || !graph.edges.length) {
  // Two causes now that the repository is separable from the vault, and they
  // want opposite responses: fix the path, or fix the parser.
  if (!src.workflows.length) {
    console.error(`\nFAIL: no workflow files under ${root}/.github/workflows`
      + ' — check the path argument before suspecting the parser.');
  } else {
    console.error('\nFAIL: derived no runners or no edges from '
      + `${src.workflows.length} workflow file(s) — the parser is broken, not the repo.`);
  }
  process.exit(1);
}
