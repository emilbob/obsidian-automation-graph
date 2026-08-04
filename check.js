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
  readSources, buildGraph, layout, renderSvg, approxWidth, nextFire,
} = plugin.__internals;

const args = process.argv.slice(2);
const htmlFlag = args.indexOf('--html');
const htmlOut = htmlFlag >= 0 ? args[htmlFlag + 1] : null;
const declFlag = args.indexOf('--declared');
const declared = declFlag >= 0 ? args[declFlag + 1] : '';
const positional = args.filter((a) => !a.startsWith('--') && a !== htmlOut && a !== declared);
const root = path.resolve(positional[0] || '.');
plugin.__internals.configure({ declaredNote: declared });

const src = readSources(fs, path, root);
const graph = buildGraph(src);
const view = layout(graph, { measure: approxWidth, maxWidth: 330 });   // a real sidebar's width

const byKind = {};
for (const n of graph.nodes) (byKind[n.kind] = byKind[n.kind] || []).push(n);

console.log(`root: ${root}`);
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

const runners = graph.nodes.filter((n) => n.kind === 'workflow' || n.kind === 'routine');
if (!runners.length || !graph.edges.length) {
  console.error('\nFAIL: derived no runners or no edges — the parser is broken, not the vault.');
  process.exit(1);
}
