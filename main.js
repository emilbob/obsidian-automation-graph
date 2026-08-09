/* Automation Graph — a live picture of a repository's automation, derived from
 * the repository itself.
 *
 * Open it and it reads the files that define your automation — `.github/workflows`
 * for the Actions tier, and optionally `.claude/` for hooks and agents — then
 * builds the graph from what it finds: what fires on a clock, what fires on an
 * event, what each one produces, and where those products go next. Nothing is
 * stored, so there is no diagram to fall out of date. Redraw and it re-derives.
 *
 * Two things it does that a drawn diagram cannot:
 *
 *   1. Automation that lives elsewhere — a cloud runner, another repo, a cron on
 *      a laptop — cannot be proven from here. Point the plugin at a note that
 *      declares it and those nodes are drawn DASHED: asserted, not verified. The
 *      distinction stays visible instead of being flattened into one confident
 *      picture.
 *
 *   2. Because both halves are parsed, they can be held against each other — a
 *      workflow that runs while no note describes it shows up as drift.
 *
 * Live run state (last run failed, running now, how much is waiting on you) is
 * an overlay with different truth conditions from the structure, and follows one
 * rule throughout: ABSENCE IS NEVER SUCCESS. A node that could not be fetched
 * stays unmarked and the header says why. Nothing renders as passing because a
 * request failed.
 *
 * Desktop only: `.github/` and `.claude/` are dot-folders, which Obsidian's
 * index excludes, so these files are read through node's fs.
 */

const {
  ItemView, Plugin, Notice, PluginSettingTab, Setting, requestUrl,
} = require('obsidian');

const VIEW_TYPE = 'automation-graph';

/* Cron expressions in workflows are UTC; they are shown in the reader's own
 * timezone, because a timetable you have to convert in your head is one you
 * misread. Overridable for automation scheduled against somewhere else's day. */
let TZ = 'UTC';
try {
  TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
} catch (e) { /* keep UTC */ }

/* Path, relative to the vault root, of a note declaring automation that runs
 * outside this repository. Empty means the feature is off: no dashed nodes and
 * no drift check, which is the correct picture for a repo whose automation all
 * lives inside it. Module-level rather than threaded through every function,
 * because it is read in a dozen places and set exactly once. */
let DOC_PATH = '';

function configure(opts) {
  if (opts.timezone) TZ = opts.timezone;
  DOC_PATH = opts.declaredNote || '';
}

/* ------------------------------------------------------------------ reading */

/* Where the repository actually is.
 *
 * Empty means "the vault is the repository" — the only arrangement that was
 * possible before this setting existed, and still the default, so an existing
 * install sees no change. A relative path resolves against the vault, because
 * `../work/api` is how people say where a sibling checkout is; `~` expands,
 * because that is how they say the rest.
 *
 * Pure, and takes `home` rather than calling os.homedir(), so the harness can
 * ask what a given string resolves to without a real filesystem underneath.
 */
function resolveRepoRoot(path, vaultRoot, repoPath, home) {
  const raw = String(repoPath || '').trim().replace(/[/\\]+$/, '');
  if (!raw) return vaultRoot;
  let p = raw;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    if (!home) return vaultRoot;          // no home to expand against; stay put
    p = path.join(home, p.slice(1));
  }
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(vaultRoot, p);
}

/* Where people keep code. Not an attempt at every possible layout — just the
 * handful of names that cover most machines, so the common case needs no
 * typing at all. Anything unusual still has the text field. */
const REPO_SEARCH_DIRS = [
  'code', 'Code', 'dev', 'Dev', 'Developer', 'src', 'repos', 'Repos',
  'projects', 'Projects', 'git', 'work', 'Work', 'Documents', 'Sites',
];

const SKIP_DIRS = new Set([
  'node_modules', 'Library', 'Applications', 'Music', 'Movies', 'Pictures',
  'Downloads', 'Public', 'Desktop', '.Trash', 'venv', 'vendor', 'target', 'dist', 'build',
]);

/* Find repositories that actually contain workflows, so the plugin can offer
 * them instead of asking for an absolute path.
 *
 * A text box wanting a filesystem path is a quiz: someone who cannot remember
 * whether their code is at ~/code/api or ~/Documents/code/api gives up there,
 * and that is the last screen of a first run. Looking is cheap; the search is
 * breadth-first from a few known places, bounded hard by a readdir budget so a
 * huge home directory cannot make opening the panel slow.
 *
 * Takes fs so the harness can run it against a synthetic tree. Never throws:
 * an unreadable directory is one fewer candidate, not an error the reader has
 * to understand.
 */
function findRepoCandidates(fs, path, vaultRoot, home, opts) {
  const budget = { left: (opts && opts.budget) || 300 };
  const maxDepth = (opts && opts.maxDepth) || 2;
  const found = new Map();

  const list = (dir) => {
    if (budget.left <= 0) return [];
    budget.left -= 1;
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return [];
    }
  };

  const workflowCount = (dir) => {
    const entries = list(path.join(dir, '.github/workflows'));
    return entries.filter((e) => !e.isDirectory() && /\.ya?ml$/.test(e.name)).length;
  };

  /* Directories are identified by inode, not by the string used to reach them.
   * On a case-insensitive filesystem — the macOS default — ~/code and ~/Code
   * are one directory, and seeding both spellings offers the reader every
   * repository twice. Symlinked search roots collapse the same way, and a
   * directory reached by two names is scanned once instead of twice. Falls
   * back to the path where a filesystem reports no usable inode. */
  const identity = (dir) => {
    try {
      const st = fs.statSync(dir);
      if (st && st.ino) return `${st.dev}:${st.ino}`;
    } catch (e) { /* gone or unreadable; the path is as good a key as any */ }
    return dir;
  };

  const consider = (dir, key) => {
    if (found.has(key)) return true;
    const n = workflowCount(dir);
    if (!n) return false;
    let isGit = false;
    try { isGit = fs.existsSync(path.join(dir, '.git')); } catch (e) { /* unreadable */ }
    found.set(key, { root: dir, workflows: n, isGit });
    return true;
  };

  const seeds = [];
  if (vaultRoot) {
    seeds.push(vaultRoot);
    try { seeds.push(path.dirname(vaultRoot)); } catch (e) { /* no parent */ }
  }
  if (home) {
    seeds.push(home);
    for (const d of REPO_SEARCH_DIRS) seeds.push(path.join(home, d));
  }

  const queue = seeds.map((dir) => [dir, 0]);
  const visited = new Set();
  while (queue.length && budget.left > 0) {
    const [dir, depth] = queue.shift();
    if (!dir) continue;
    const key = identity(dir);
    if (visited.has(key)) continue;
    visited.add(key);

    // A directory that is itself a repository with workflows is an answer, and
    // descending into it would only turn up its own vendored copies.
    if (consider(dir, key)) continue;
    if (depth >= maxDepth) continue;

    for (const entry of list(dir)) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      queue.push([path.join(dir, entry.name), depth + 1]);
    }
  }

  // Most workflows first — that is the repository whose automation is worth
  // drawing. Shallower paths break ties, being the likelier main checkout.
  return [...found.values()].sort((a, b) => (b.workflows - a.workflows)
    || (a.root.split(/[/\\]/).length - b.root.split(/[/\\]/).length)
    || (a.root < b.root ? -1 : 1));
}

/* Node's fs, not Obsidian's vault API: `.github/` and `.claude/` are dot-folders,
 * which Obsidian excludes from its index, so getAbstractFileByPath cannot see
 * them. Desktop-only for exactly this reason (manifest says so).
 *
 * Two roots, not one. Once the repository is allowed to sit outside the vault,
 * the two halves stop living in the same place: workflows and `.claude/` are
 * facts about the REPOSITORY, while the declared note is a note — it is in the
 * VAULT, and reading it from the repo root would silently lose the declared
 * half of the graph for exactly the users this setting exists for. `vaultRoot`
 * defaults to `root` so the single-root callers keep working unchanged. */
function readSources(fs, path, root, vaultRoot) {
  const noteRoot = vaultRoot || root;
  const readIn = (base, rel) => {
    try { return fs.readFileSync(path.join(base, rel), 'utf8'); } catch (e) { return null; }
  };
  const listIn = (base, rel) => {
    try { return fs.readdirSync(path.join(base, rel)).sort(); } catch (e) { return []; }
  };
  const readFile = (rel) => readIn(root, rel);
  const listDir = (rel) => listIn(root, rel);

  const workflows = listDir('.github/workflows')
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => ({ file: `.github/workflows/${f}`, text: readFile(`.github/workflows/${f}`) || '' }));

  const agents = listDir('.claude/agents')
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ file: `.claude/agents/${f}`, text: readFile(`.claude/agents/${f}`) || '' }));


  // Every note beside the declared one, concatenated, for the "is this piece
  // documented anywhere?" half of the drift check. Asking the declared note
  // alone produces findings that are true of that file and false of the vault,
  // since a piece is often described in a sibling note — and a check that cries
  // wolf gets ignored, then deleted.
  const noteDir = DOC_PATH.includes('/') ? DOC_PATH.slice(0, DOC_PATH.lastIndexOf('/')) : '';
  const docsText = DOC_PATH
    ? listIn(noteRoot, noteDir || '.')
      .filter((f) => f.endsWith('.md'))
      .map((f) => readIn(noteRoot, noteDir ? `${noteDir}/${f}` : f) || '')
      .join('\n')
    : '';

  return {
    workflows,
    agents,
    settings: readFile('.claude/settings.json'),
    doc: DOC_PATH ? readIn(noteRoot, DOC_PATH) : null,
    docsText,
  };
}

/* ------------------------------------------------------------- yaml parsing */

/* Deliberately not a YAML library: plugins ship unbundled here (no build step
 * in this vault), and the shapes we need are four keys deep. Anything this
 * misses shows up as a missing edge, never as a wrong one. */
function onBlock(text) {
  const m = text.match(/^on:[^\n]*\n([\s\S]*?)(?=^[A-Za-z_]+:)/m);
  return m ? m[1] : '';
}

function parseList(rest) {
  const inline = rest.match(/\[(.*)\]/);
  if (!inline) return [];
  return inline[1].split(',').map(unquote).filter(Boolean);
}

function unquote(s) {
  return String(s).trim().replace(/^["']|["']$/g, '').trim();
}

function parseTriggers(text) {
  const out = {
    crons: [], dispatch: false, pushBranches: [], pushPaths: [],
    issues: false, pullRequest: false,
  };
  let section = null;
  let sectionIndent = -1;
  let listKey = null;

  for (const raw of onBlock(text).split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    const t = line.trim();

    if (section !== null && indent <= sectionIndent && !t.startsWith('-')) {
      section = null;
      listKey = null;
    }

    if (/^schedule:/.test(t)) { section = 'schedule'; sectionIndent = indent; continue; }
    if (/^push:/.test(t)) { section = 'push'; sectionIndent = indent; continue; }
    if (/^workflow_dispatch:?/.test(t)) { out.dispatch = true; continue; }
    if (/^issues:/.test(t)) { out.issues = true; continue; }
    if (/^pull_request:/.test(t)) { out.pullRequest = true; continue; }

    if (section === 'schedule') {
      const m = t.match(/cron:\s*(.+)$/);
      if (m) out.crons.push(unquote(m[1]));
      continue;
    }

    if (section === 'push') {
      const b = t.match(/^branches:\s*(.*)$/);
      if (b) { listKey = 'pushBranches'; out.pushBranches.push(...parseList(b[1])); continue; }
      const p = t.match(/^paths:\s*(.*)$/);
      if (p) { listKey = 'pushPaths'; out.pushPaths.push(...parseList(p[1])); continue; }
      const item = t.match(/^-\s*(.+)$/);
      if (item && listKey) out[listKey].push(unquote(item[1]));
    }
  }
  return out;
}

/* What a workflow produces, read off its own run: bodies. Each pattern is a
 * command with a visible effect — an issue, a PR, a branch, a file, a commit to
 * main — so an edge here means "this script contains the call that makes it". */
function parseEmissions(text) {
  const out = { issue: false, pr: false, mainPush: false, branches: [], files: [], scripts: [], assigns: false };

  // Two dialects reach the same API: the gh CLI in run: blocks, and
  // actions/github-script in js. Matching only the first missed
  // daily-review-notify entirely, which is the workflow whose whole job is to
  // open an issue.
  if (/gh issue (create|comment)/.test(text) || /issues\.(create|createComment)\b/.test(text)) out.issue = true;
  if (/gh pr create/.test(text) || /pulls\.create\b/.test(text)) out.pr = true;
  if (/git push origin (HEAD:)?main/.test(text)) out.mainPush = true;
  if (/--assignee/.test(text)) out.assigns = true;

  // branch="plugin-update/obsidian-git-$latest" → plugin-update/*
  // Shell parameter expansion also matches this shape (`${ref#origin/}`), and
  // is not a branch name at all — anything left holding expansion syntax, or
  // reduced to a bare wildcard, is dropped rather than drawn.
  for (const m of text.matchAll(/branch="([^"]+)"/g)) {
    const pattern = m[1]
      .replace(/\$\{[A-Za-z_][^}]*\}/g, '*')
      .replace(/\$[A-Za-z_]\w*/g, '*')
      .replace(/\*+/g, '*');
    if (!pattern.includes('/') || /[{}#$]/.test(pattern) || pattern === '*') continue;
    if (!out.branches.includes(pattern)) out.branches.push(pattern);
  }

  // Files the run block writes, then commits. Directories are skipped: a
  // committed folder is already represented by the branch and PR it rides on.
  for (const m of text.matchAll(/^\s*\}?\s*>\s*([\w./ -]+\.md)\s*$/gm)) {
    const f = m[1].trim();
    if (!f.startsWith('/tmp') && !out.files.includes(f)) out.files.push(f);
  }
  for (const m of text.matchAll(/git add ([\w./ -]+)/g)) {
    const f = m[1].trim();
    if (f === '.' || f.endsWith('/') || !f.includes('/') || out.files.includes(f)) continue;
    out.files.push(f);
  }

  for (const m of text.matchAll(/python3\s+([\w./-]+\.py)/g)) {
    if (!out.scripts.includes(m[1])) out.scripts.push(m[1]);
  }
  return out;
}

function parseWorkflows(workflows) {
  return workflows.map(({ file, text }) => {
    const name = (text.match(/^name:\s*(.+)$/m) || [null, file.split('/').pop()])[1].trim();
    const stem = file.split('/').pop().replace(/\.ya?ml$/, '');
    return {
      // The pill carries the stem, not the `name:` field — "system-health" is
      // the name people actually use for a workflow in conversation, and a
      // `name:` field like "Nightly integration suite" would not fit a pill
      // anyway. The full name is in the detail pane.
      id: `wf:${stem}`,
      label: stem,
      title: name,
      file,
      triggers: parseTriggers(text),
      emits: parseEmissions(text),
    };
  });
}

/* --------------------------------------------------- the declared half (doc) */

/* Cloud routines run off-repo and leave no file here. Rather than hard-coding
 * them into this plugin — which would just be a second hand-drawn picture, one
 * nobody would remember to edit — they are read from the table that already
 * declares them, and marked as declared so the drawing never overstates itself. */
function parseDeclared(doc) {
  const routines = [];
  const hooks = [];
  if (!doc) return { routines, hooks };

  for (const raw of doc.split('\n')) {
    if (!raw.startsWith('|')) continue;
    const cells = raw.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    if (/^-+$/.test(cells[0].replace(/[: ]/g, '-'))) continue;   // separator row

    const joined = cells.join(' ');
    if (cells.length >= 4 && /[☁️⚙️⛔]/.test(cells[2])) {
      const name = pieceName(cells[1]);
      if (!name) continue;
      if (cells[2].includes('⛔') || /~~/.test(cells[1])) continue;   // removed piece
      routines.push({
        id: `rt:${name}`,
        label: name,
        when: cells[0].replace(/\*\*/g, ''),
        cloud: cells[2].includes('☁️'),
        detail: stripMd(cells[3] || ''),
        piece: cells[1],                      // raw, for the "lives elsewhere" test
        emits: emittedPaths(joined),
      });
    } else if (cells.length === 3 && /[🌍🗄️]/.test(cells[1])) {
      const name = pieceName(cells[0]);
      if (!name) continue;
      hooks.push({
        id: `hk:${name}`,
        label: name,
        global: cells[1].includes('🌍'),
        detail: stripMd(cells[2] || ''),
        file: (cells[1].match(/`([^`]+)`/) || [])[1] || null,
      });
    }
  }
  return { routines, hooks };
}

function pieceName(cell) {
  const wiki = cell.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
  if (wiki) return (wiki[2] || wiki[1]).trim();
  const code = cell.match(/`([^`]+)`/);
  if (code) return code[1].trim();
  const plain = stripMd(cell);
  return plain && plain.length < 40 ? plain : null;
}

function stripMd(s) {
  return s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
    .replace(/\*\*|__|~~/g, '')
    .replace(/`/g, '')
    .trim();
}

/* Paths and branch globs a declared row says it produces, e.g. `reports/*.md` or
 * `release/*`. This is what wires the declared half into the verified one: a
 * branch pattern named here and waited on by a workflow becomes an edge. */
function emittedPaths(rowText) {
  const out = [];
  for (const m of rowText.matchAll(/`([\w.-]+\/[\w.*/-]+)`/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/* --------------------------------------------------------------------- cron */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function cronMatches(field, value, names) {
  if (field === '*' || field === '?') return true;
  return field.split(',').some((part) => {
    const step = part.match(/^(.+)\/(\d+)$/);
    const base = step ? step[1] : part;
    const every = step ? parseInt(step[2], 10) : 1;
    let lo; let hi;
    if (base === '*') { lo = names.lo; hi = names.hi; } else {
      const range = base.split('-').map((n) => parseInt(n, 10));
      lo = range[0];
      hi = range.length > 1 ? range[1] : range[0];
    }
    if (Number.isNaN(lo)) return false;
    return value >= lo && value <= hi && (value - lo) % every === 0;
  });
}

/* Next UTC firing of a 5-field cron, scanned forward day by day. Crons in
 * workflows are UTC; the label is rendered in the reader's timezone, because a
 * timetable you have to convert in your head is one you will misread. */
function nextFire(expr, from) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [mi, ho, dom, mon, dow] = parts;
  const start = new Date(from || Date.now());
  for (let d = 0; d < 400; d++) {
    const day = new Date(Date.UTC(
      start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + d,
    ));
    if (!cronMatches(mon, day.getUTCMonth() + 1, { lo: 1, hi: 12 })) continue;
    const domOk = cronMatches(dom, day.getUTCDate(), { lo: 1, hi: 31 });
    const dowOk = cronMatches(dow, day.getUTCDay(), { lo: 0, hi: 6 });
    // cron's OR rule: with both fields restricted, either one firing is enough.
    const dayOk = (dom === '*' || dow === '*') ? (domOk && dowOk) : (domOk || dowOk);
    if (!dayOk) continue;
    for (let h = 0; h < 24; h++) {
      if (!cronMatches(ho, h, { lo: 0, hi: 23 })) continue;
      for (let m = 0; m < 60; m++) {
        if (!cronMatches(mi, m, { lo: 0, hi: 59 })) continue;
        const when = new Date(Date.UTC(
          day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m,
        ));
        if (when > start) return when;
      }
    }
  }
  return null;
}

function fmtLocal(date) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
  } catch (e) {
    return date.toISOString().slice(11, 16) + ' UTC';
  }
}

/* A short human label for a cron — "daily 07:15", "Mon 06:45", "monthly d1-15". */
function cronLabel(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [mi, ho, dom, , dow] = parts;
  const next = nextFire(expr);
  const time = next
    ? fmtLocal(next).replace(/^\w+,?\s*/, '')
    : `${String(ho).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;

  let when = 'daily';
  if (dow !== '*') {
    const days = dow.split(',').map((d) => DAYS[parseInt(d, 10)] || d);
    when = days.join('/');
  } else if (dom !== '*') {
    when = `d${dom}`;
  }
  return `${when} ${time}`;
}

/* --------------------------------------------------------------- live state */

/* The structure above is derived from files and is always true. Run state is
 * fetched over a network that can be down, from an API that can rate-limit,
 * with a token that can be missing — so it is kept strictly separate, and the
 * one rule it follows is that ABSENCE IS NEVER SUCCESS. A node nobody could
 * fetch stays neutral and says so; it never renders as passing. Same rule
 * system-health states about its own inventory: an absent repo is not a green
 * one.
 */

function readRepoSlug(fs, path, root) {
  try {
    const cfg = fs.readFileSync(path.join(root, '.git/config'), 'utf8');
    const m = cfg.match(/\[remote "origin"\][\s\S]*?url\s*=\s*(\S+)/);
    if (!m) return null;
    const slug = m[1].match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    return slug ? slug[1] : null;
  } catch (e) {
    return null;
  }
}

/* Where gh actually lives. A GUI app launched from the Dock on macOS gets a
 * bare PATH — /usr/bin:/bin:/usr/sbin:/sbin — so a Homebrew gh is invisible to
 * it even though it works perfectly in a terminal. Bare 'gh' is tried first
 * anyway, since it succeeds when Obsidian was started from a shell. */
const GH_CANDIDATES = [
  'gh',
  '/opt/homebrew/bin/gh',      // Homebrew, Apple silicon
  '/usr/local/bin/gh',         // Homebrew, Intel
  '/opt/local/bin/gh',         // MacPorts
  '/usr/bin/gh',               // system package managers
  '/home/linuxbrew/.linuxbrew/bin/gh',
];

/* Plugin settings last, not first: a token typed into the plugin is the only
 * one that ends up on disk, so it is the fallback rather than the default.
 * This vault is a private repo, so there is no useful unauthenticated path.
 *
 * Returns `tried` alongside the result, because "no token" has several very
 * different causes — gh not installed, gh installed but off PATH, gh logged
 * out, env var set in a shell profile the GUI app never reads — and a bare
 * "no token" sends the reader looking in the wrong place. Ask this function
 * what it did and it can say.
 */
function resolveToken(settings, env, exec, readFile, home) {
  const tried = [];

  if (settings && settings.token) return { token: settings.token, from: 'plugin settings', tried };
  tried.push('plugin setting (empty)');

  const keys = ['VAULT_PAT', 'GITHUB_TOKEN', 'GH_TOKEN'];
  for (const key of keys) {
    if (env && env[key]) return { token: env[key], from: `$${key}`, tried };
  }
  tried.push(`environment: ${keys.map((k) => `$${k}`).join(', ')} (unset in this process)`);

  const candidates = (settings && settings.ghPath ? [settings.ghPath] : []).concat(GH_CANDIDATES);
  const ghFailures = [];
  for (const bin of candidates) {
    if (!exec) break;
    try {
      const out = String(exec(bin, ['auth', 'token'], { encoding: 'utf8', timeout: 4000 })).trim();
      if (out) return { token: out, from: `gh auth token (${bin})`, tried };
      ghFailures.push(`${bin}: no output`);
    } catch (e) {
      ghFailures.push(`${bin}: ${e && /ENOENT/.test(String(e.message)) ? 'not found' : 'failed'}`);
    }
  }
  if (ghFailures.length) tried.push(`gh — ${ghFailures.join('; ')}`);

  // Last resort: gh's own config. Only present when gh was not configured to
  // use the system keyring, so its absence is not evidence of anything.
  try {
    if (readFile && home) {
      const yml = readFile(`${home}/.config/gh/hosts.yml`);
      const m = yml && yml.match(/oauth_token:\s*(\S+)/);
      if (m) return { token: m[1], from: '~/.config/gh/hosts.yml', tried };
      tried.push('~/.config/gh/hosts.yml (no oauth_token — gh likely uses the keyring)');
    }
  } catch (e) {
    tried.push('~/.config/gh/hosts.yml (unreadable)');
  }

  return { token: null, from: null, tried };
}

async function fetchLive({ slug, token, request }) {
  if (!slug) return { error: 'no git remote — cannot tell which repo this vault is' };
  if (!token) return { error: 'no token', needsToken: true };

  const get = async (suffix) => {
    const res = await request({
      url: `https://api.github.com/repos/${slug}${suffix}`,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      throw: false,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`GitHub ${res.status} — token rejected or rate-limited`);
    }
    if (res.status >= 400) throw new Error(`GitHub ${res.status} on ${suffix.split('?')[0]}`);
    return res.json;
  };

  try {
    // Three calls, not one per workflow: the runs feed is already newest-first
    // across every workflow, so a single page covers the estate.
    const [runs, prs, issues] = await Promise.all([
      get('/actions/runs?per_page=50'),
      get('/pulls?state=open&per_page=50'),
      get('/issues?state=open&per_page=50'),
    ]);

    const byWorkflow = {};
    for (const run of (runs && runs.workflow_runs) || []) {
      const stem = String(run.path || '').split('/').pop().replace(/\.ya?ml$/, '');
      if (!stem || byWorkflow[stem]) continue;          // first seen = most recent
      byWorkflow[stem] = {
        status: run.status,
        conclusion: run.conclusion,
        at: run.run_started_at || run.created_at,
        url: run.html_url,
      };
    }

    return {
      at: Date.now(),
      runs: byWorkflow,
      prs: (prs || []).length,
      // GitHub returns PRs in the issues feed too; only real issues count here.
      issues: (issues || []).filter((i) => !i.pull_request).length,
      error: null,
    };
  } catch (err) {
    return { error: err.message };
  }
}

/* When each produced file was last actually written, straight from git — no
 * network, and it covers the cloud routines whose runs are invisible from
 * here. "This routine has stopped producing" is the one failure mode that is
 * visible without being able to see the runs themselves. */
function localFreshness(exec, root, paths) {
  const out = {};
  for (const p of paths) {
    try {
      const ts = exec('git', ['log', '-1', '--format=%ct', '--', p],
        { cwd: root, encoding: 'utf8', timeout: 4000 }).trim();
      if (ts) out[p] = parseInt(ts, 10) * 1000;
    } catch (e) { /* not in git, or no commit ever touched it */ }
  }
  return out;
}

const DAY = 86400000;

/* The period a node's own declared schedule implies, so staleness is measured
 * against what the schedule itself says rather than a threshold invented here. */
function expectedPeriod(when) {
  const w = String(when || '').toLowerCase();
  if (w.includes('daily')) return DAY;
  // Monthly before weekday: "1st Saturday" contains "sat", and read as weekly
  // it would call the calibration loop stale three weeks out of every four.
  if (w.includes('month') || w.includes('1st')) return 31 * DAY;
  if (/mon|tue|wed|thu|fri|sat|sun|weekly/.test(w)) return 7 * DAY;
  return null;
}

/* A node's real period: the gap between its next two firings, computed from
 * the cron it already carries. Only nodes with no cron fall back to reading
 * the declared cadence text, and a node with neither gets no staleness
 * judgment at all rather than an assumed one. */
function nodePeriod(n) {
  const crons = (n.facts && n.facts.triggers && n.facts.triggers.crons)
    || (n.cron ? [n.cron] : []);
  const periods = crons.map((c) => {
    const first = nextFire(c);
    const second = first && nextFire(c, first);
    return first && second ? second - first : null;
  }).filter(Boolean);
  if (periods.length) return Math.min(...periods);
  return expectedPeriod(n.when);
}

function stateFor(nodes, edges, live, freshness, now) {
  const state = {};
  const at = now || Date.now();

  if (live && !live.error) {
    for (const n of nodes) {
      if (n.kind !== 'workflow') continue;
      const run = live.runs[n.label];
      if (!run) {
        state[n.id] = { kind: 'unknown', note: 'no run in the last 50 — not the same as passing' };
        continue;
      }
      const ago = describeAge(at - new Date(run.at).getTime());
      if (run.status !== 'completed') {
        state[n.id] = { kind: 'running', note: `running now (started ${ago} ago)`, url: run.url };
      } else if (['failure', 'timed_out', 'startup_failure'].includes(run.conclusion)) {
        state[n.id] = { kind: 'failure', note: `last run ${run.conclusion} ${ago} ago`, url: run.url };
      } else if (run.conclusion === 'success') {
        state[n.id] = { kind: 'ok', note: `last run passed ${ago} ago`, url: run.url };
      } else {
        state[n.id] = {
          kind: 'unknown',
          note: `last run ${run.conclusion || 'unresolved'} ${ago} ago`,
          url: run.url,
        };
      }
    }

    const waiting = live.prs + live.issues;
    state['art:pr'] = { kind: live.prs ? 'waiting' : 'ok', badge: String(live.prs), note: `${live.prs} open PR(s)` };
    state['art:issue'] = { kind: live.issues ? 'waiting' : 'ok', badge: String(live.issues), note: `${live.issues} open issue(s)` };
    state['human:you'] = {
      kind: waiting ? 'waiting' : 'ok',
      badge: String(waiting),
      note: waiting ? `${waiting} item(s) waiting on you` : 'nothing waiting on you',
    };
  }

  // Freshness needs no network, so it applies whether or not the fetch worked
  // — and it is the only signal the cloud routines have at all.
  const producedBy = {};
  for (const e of edges) {
    if (!e.to.startsWith('art:f:')) continue;
    const p = e.to.slice('art:f:'.length);
    if (freshness[p]) (producedBy[e.from] = producedBy[e.from] || []).push(freshness[p]);
  }

  for (const n of nodes) {
    const path = n.id.startsWith('art:f:') ? n.id.slice('art:f:'.length) : null;
    const stamps = producedBy[n.id] || (path && freshness[path] ? [freshness[path]] : []);
    if (!stamps.length) continue;
    const age = at - Math.max(...stamps);
    const period = nodePeriod(n);
    const note = `last produced ${describeAge(age)} ago`;
    // Missed at least two of its own cycles — derived from the declared
    // cadence, not from a number chosen here.
    const missed = period && age > period * 2;
    const prior = state[n.id];
    if (missed && (!prior || prior.kind === 'ok' || prior.kind === 'unknown')) {
      state[n.id] = { kind: 'stale', note: `${note} — past two of its own cycles` };
    } else if (!prior) {
      state[n.id] = { kind: 'quiet', note };
    } else {
      state[n.id] = Object.assign({}, prior, { note: `${prior.note} · ${note}` });
    }
  }

  return state;
}

/* Every directory the graph is derived from, with a predicate for which files
 * in it actually matter. One entry per source in readSources — if a source is
 * added there and not here, the graph silently stops following it, which is
 * how the root scripts went unwatched in the first place.
 *
 * Watches are non-recursive, and the predicates carry the noise filtering:
 * a notes folder churns constantly, and almost none of that says anything
 * about the machine.
 */
/* Each target says which root it hangs off, for the same reason readSources
 * takes two: the workflow directories are in the repository and the declared
 * note is in the vault, and once those differ a watcher pointed at the wrong
 * one silently stops noticing edits. */
function watchTargets(declaredNote) {
  const targets = [
    ['.github/workflows', () => true, 'repo'],
    ['.claude/agents', () => true, 'repo'],
    ['.claude/hooks', () => true, 'repo'],
    ['.claude', (f) => f === 'settings.json', 'repo'],
  ];
  if (declaredNote) {
    const slash = declaredNote.lastIndexOf('/');
    const dir = slash === -1 ? '.' : declaredNote.slice(0, slash);
    const base = declaredNote.slice(slash + 1);
    // Only the declared note itself: its folder may hold notes that change
    // every day and say nothing about the machine.
    targets.push([dir, (f) => f === base, 'vault']);
  }
  return targets;
}

const ACTIVE_POLL_MS = 30000;

/* How long until the next run-state fetch, given what the last one found.
 *
 * Idle, the panel does not poll at all unless asked — background network calls
 * nobody requested should not start on their own. But while something is
 * actually running, "as of four minutes ago" is the wrong answer to the only
 * question being asked, so it drops to every 30s until the run completes and
 * then goes quiet again. Cost is negligible: three requests per fetch against
 * an authenticated ceiling of 5,000/hour.
 *
 * Returns 0 for "do not schedule anything".
 */
function pollDelay(live, settings, openViews) {
  if (!openViews) return 0;                       // nothing on screen to update
  const running = !!(live && !live.error && live.runs
    && Object.values(live.runs).some((r) => r.status && r.status !== 'completed'));
  if (running) return ACTIVE_POLL_MS;
  const idleMinutes = (settings && settings.autoRefreshMinutes) || 0;
  return idleMinutes > 0 ? idleMinutes * 60000 : 0;
}

function describeAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/* ------------------------------------------------------------ graph building */

const KIND = {
  clock: { glyph: '⏱', cls: 'clock' },
  event: { glyph: '⚡', cls: 'event' },
  workflow: { glyph: '⚙️', cls: 'workflow' },
  routine: { glyph: '☁️', cls: 'routine' },
  // Not 🪝 for hooks: at 11px it is the same yellow squiggle as 🐍, and the two
  // kinds sit two ranks apart in this graph.
  hook: { glyph: '⚓', cls: 'hook' },
  session: { glyph: '▶', cls: 'session' },
  script: { glyph: '🐍', cls: 'script' },
  agent: { glyph: '🤖', cls: 'agent' },
  artifact: { glyph: '📄', cls: 'artifact' },
  human: { glyph: '👤', cls: 'human' },
};

function globToRe(glob) {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*');
  return new RegExp(`^${body}$`);
}

function buildGraph(src) {
  const nodes = new Map();
  const edges = [];

  const add = (node) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    return nodes.get(node.id);
  };
  const link = (from, to, type) => {
    if (!from || !to || from === to) return;
    if (edges.some((e) => e.from === from && e.to === to)) return;
    edges.push({ from, to, type: type || 'flow' });
  };

  const workflows = parseWorkflows(src.workflows);
  const { routines, hooks } = parseDeclared(src.doc);

  // --- runners: workflows (verified) -------------------------------------
  for (const wf of workflows) {
    add({
      id: wf.id, label: wf.label, kind: 'workflow', verified: true,
      source: wf.file, cadence: wf.triggers.crons.length ? 'scheduled' : 'event',
      detail: wf.title, facts: wf,
    });

    for (const cron of wf.triggers.crons) {
      const clock = add({
        id: `ck:${cron}`, label: cronLabel(cron), kind: 'clock', verified: true,
        source: wf.file, cadence: 'scheduled', cron,
      });
      link(clock.id, wf.id, 'trigger');
    }
    if (wf.triggers.issues || wf.triggers.pullRequest) {
      const ev = add({
        id: 'ev:gh', label: 'PR / issue events', kind: 'event', verified: true,
        source: wf.file, cadence: 'event',
      });
      link(ev.id, wf.id, 'trigger');
    }

    // --- what it produces ------------------------------------------------
    if (wf.emits.issue) {
      const n = add({ id: 'art:issue', label: 'issue → email', kind: 'artifact', verified: true, cadence: 'event' });
      link(wf.id, n.id, 'flow');
    }
    if (wf.emits.pr) {
      const n = add({ id: 'art:pr', label: 'PR awaiting review', kind: 'artifact', verified: true, cadence: 'event' });
      link(wf.id, n.id, 'flow');
    }
    if (wf.emits.mainPush) link(wf.id, add({ id: 'art:main', label: 'main', kind: 'artifact', verified: true, cadence: 'event' }).id, 'flow');
    for (const b of wf.emits.branches) {
      const n = add({ id: `art:br:${b}`, label: b, kind: 'artifact', verified: true, cadence: 'event' });
      link(wf.id, n.id, 'flow');
    }
    for (const f of wf.emits.files) {
      const n = add({ id: `art:f:${f}`, label: f, kind: 'artifact', verified: true, cadence: 'event' });
      link(wf.id, n.id, 'flow');
    }
    for (const s of wf.emits.scripts) {
      const n = add({ id: `sc:${s}`, label: s, kind: 'script', verified: true, source: s, cadence: 'event' });
      link(wf.id, n.id, 'uses');
    }
  }

  // --- runners: cloud routines (declared, unverifiable from here) ---------
  for (const rt of routines) {
    if (!rt.cloud) continue;
    add({
      id: rt.id, label: rt.label, kind: 'routine', verified: false,
      cadence: 'scheduled', when: rt.when, detail: rt.detail, source: DOC_PATH,
    });
    const clock = add({
      id: `ck:doc:${rt.when}`, label: rt.when, kind: 'clock', verified: false,
      cadence: 'scheduled', source: DOC_PATH,
    });
    link(clock.id, rt.id, 'trigger');
    for (const p of rt.emits) {
      const isBranch = !/\.\w+$/.test(p);
      const n = add({
        id: isBranch ? `art:br:${p}` : `art:f:${p}`, label: p,
        kind: 'artifact', verified: false, cadence: 'event',
      });
      link(rt.id, n.id, 'flow');
    }
  }

  // --- wire artifacts into the workflows they trigger ---------------------
  // A push-triggered workflow names the branches or paths it waits for; an
  // artifact node that matches is, by construction, what wakes it.
  for (const wf of workflows) {
    const wants = [
      ...wf.triggers.pushBranches.map((b) => ({ glob: b, prefix: 'art:br:' })),
      ...wf.triggers.pushPaths.map((p) => ({ glob: p, prefix: 'art:f:' })),
    ];
    for (const want of wants) {
      const re = globToRe(want.glob);
      let matched = false;
      for (const node of nodes.values()) {
        if (!node.id.startsWith(want.prefix)) continue;
        const value = node.id.slice(want.prefix.length);
        if (re.test(value) || globToRe(value).test(want.glob)) {
          link(node.id, wf.id, 'trigger');
          matched = true;
        }
      }
      // Nothing in the repo produces it, but something clearly does: the
      // producer is off-repo. Slug-match it to a declared routine before
      // falling back to an anonymous source, so the chain stays connected.
      if (!matched && want.prefix === 'art:f:') {
        const slug = want.glob.split('/').pop().replace(/\.\w+$/, '');
        const producer = [...nodes.values()].find(
          (n) => n.kind === 'routine' && n.id.toLowerCase().includes(slug.toLowerCase()),
        );
        const art = add({
          id: `art:f:${want.glob}`, label: want.glob, kind: 'artifact',
          verified: !!producer, cadence: 'event',
        });
        if (producer) link(producer.id, art.id, 'flow');
        link(art.id, wf.id, 'trigger');
      }
    }
  }

  // --- the human gate ------------------------------------------------------
  // The human gate. Every automation graph has one somewhere, and it earns its
  // place: it is the node that decides how fast everything upstream can move.
  const emil = add({ id: 'human:you', label: 'you merge', kind: 'human', verified: true, cadence: 'human' });
  if (nodes.has('art:pr')) link('art:pr', emil.id, 'flow');
  if (nodes.has('art:issue')) link('art:issue', emil.id, 'reads');
  for (const node of nodes.values()) {
    if (node.id.startsWith('art:br:')) link(node.id, 'art:pr', 'flow');
  }
  const main = add({ id: 'art:main', label: 'main', kind: 'artifact', verified: true, cadence: 'event' });
  link(emil.id, main.id, 'flow');

  // --- the local tier: session, hooks, fleet -------------------------------
  if (src.settings) {
    const session = add({
      id: 'local:session', label: 'Claude Code session', kind: 'session', verified: true,
      source: '.claude/settings.json', cadence: 'human',
    });
    link(main.id, session.id, 'feedback');

    const settings = safeJson(src.settings);
    for (const event of Object.keys((settings && settings.hooks) || {})) {
      const cmd = JSON.stringify(settings.hooks[event]);
      const file = (cmd.match(/\.claude\/hooks\/[\w.-]+/) || [])[0] || '.claude/settings.json';
      const n = add({
        id: `hk:${event}`, label: event, kind: 'hook', verified: true,
        source: file, cadence: 'human',
        detail: file.endsWith('.sh') ? file : 'inline command in settings.json',
      });
      link(session.id, n.id, 'trigger');
      if (/git push/.test(cmd) || /auto-push/.test(cmd)) link(n.id, main.id, 'flow');
    }

    // The fleet is one box, not five. Five sibling pills would be the widest
    // rank in the graph and would say nothing the detail pane cannot say
    // better — and the routing decision, not the roster, is what the graph is
    // about.
    const fleet = src.agents.map((ag) => ({
      name: ((ag.text.match(/^name:\s*(.+)$/m) || [])[1] || '').trim(),
      model: ((ag.text.match(/^model:\s*(.+)$/m) || [])[1] || '').trim(),
    })).filter((a) => a.name);

    if (fleet.length) {
      const n = add({
        id: 'ag:fleet', label: `routing fleet · ${fleet.length}`, kind: 'agent',
        verified: true, source: '.claude/agents', cadence: 'human',
        detail: fleet.map((a) => `${a.name}${a.model ? ` (${a.model.replace(/^claude-/, '')})` : ''}`).join(' · '),
      });
      link(session.id, n.id, 'spawns');
    }
  }

  // Hooks the map declares but this repo cannot see (they live in ~/.claude/).
  for (const hk of hooks) {
    if (!hk.global) continue;
    const n = add({
      id: hk.id, label: hk.label, kind: 'hook', verified: false,
      cadence: 'human', detail: hk.detail, source: DOC_PATH,
    });
    if (nodes.has('local:session')) link('local:session', n.id, 'trigger');
  }

  return { nodes: [...nodes.values()], edges, drift: driftCheck(workflows, routines, src) };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

/* The one check a derived picture gets for free: both halves are now parsed, so
 * they can be held against each other. Only provable directions are reported —
 * a cloud routine with no file is normal, not drift. */
function driftCheck(workflows, routines, src) {
  const out = [];
  const doc = src.doc || '';
  // Nothing declared is a valid configuration — plenty of repositories have no
  // automation living outside themselves — so it is silence, not a finding.
  if (!DOC_PATH) return [];
  if (!doc) return [{ text: `${DOC_PATH} not found — the declared half of the graph is missing`, kind: 'missing-doc' }];

  const shelf = src.docsText || doc;
  for (const wf of workflows) {
    const base = wf.file.split('/').pop();
    if (!shelf.includes(base) && !shelf.includes(wf.title) && !shelf.includes(wf.label)) {
      out.push({ text: `workflow ${base} runs but is described in no note beside ${DOC_PATH}`, kind: 'undocumented' });
    }
  }

  for (const rt of routines) {
    if (rt.cloud) continue;                       // off-repo by design
    // A ⚙️ row that says where it lives is not claiming to live here. keep-green
    // runs in each project repo; demanding a file for it in this repo would be
    // a weekly false alarm about a workflow that is working exactly as written.
    if (/\b(each|other|project|every)\b.{0,12}\brepo/i.test(rt.piece || '')) continue;
    const named = rt.label.replace(/\.ya?ml$/, '');
    const exists = workflows.some((wf) => wf.file.includes(named) || wf.title === rt.label);
    if (!exists && /^[\w-]+$/.test(named)) {
      out.push({ text: `${DOC_PATH} lists ${rt.label} as a workflow here, but no such file is in .github/workflows`, kind: 'phantom' });
    }
  }
  return out;
}

/* ------------------------------------------------------------------- layout */

/* Sugiyama-lite: rank by longest path, order by barycenter, pack each rank.
 * Feedback edges (the loop back to main → session) are found by DFS and left
 * out of ranking, then drawn dashed — a cycle is the point of this system, not
 * a defect to be hidden by an arbitrary cut. */
function layout(graph, opts) {
  const o = Object.assign({
    measure: approxWidth, maxWidth: 320, rankGap: 34, lineGap: 8,
    gapX: 12, padX: 10, padY: 10, nodeH: 26,
  }, opts);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) if (out.has(e.from) && byId.has(e.to)) out.get(e.from).push(e);

  // 1. mark back edges
  const state = new Map();
  const back = new Set();
  const visit = (id) => {
    state.set(id, 1);
    for (const e of out.get(id) || []) {
      const s = state.get(e.to) || 0;
      if (s === 1) { back.add(e); e.type = e.type === 'flow' ? 'feedback' : e.type; } else if (s === 0) visit(e.to);
    }
    state.set(id, 2);
  };
  const roots = graph.nodes.filter((n) => !graph.edges.some((e) => e.to === n.id && !back.has(e)));
  for (const r of roots) if (!state.get(r.id)) visit(r.id);
  for (const n of graph.nodes) if (!state.get(n.id)) visit(n.id);

  const forward = graph.edges.filter((e) => !back.has(e));

  // 2. rank = longest path from a source
  const rank = new Map(graph.nodes.map((n) => [n.id, 0]));
  for (let i = 0; i < graph.nodes.length; i++) {
    let changed = false;
    for (const e of forward) {
      const want = rank.get(e.from) + 1;
      if (want > rank.get(e.to)) { rank.set(e.to, want); changed = true; }
    }
    if (!changed) break;
  }

  const ranks = [];
  for (const n of graph.nodes) {
    const r = rank.get(n.id);
    (ranks[r] = ranks[r] || []).push(n);
  }

  // 3. barycenter ordering, a few sweeps in each direction
  const pos = new Map();
  ranks.forEach((row) => row.forEach((n, i) => pos.set(n.id, i)));
  const neighbours = (id, dir) => forward
    .filter((e) => (dir < 0 ? e.to === id : e.from === id))
    .map((e) => pos.get(dir < 0 ? e.from : e.to))
    .filter((v) => v !== undefined);

  for (let sweep = 0; sweep < 6; sweep++) {
    const dir = sweep % 2 === 0 ? -1 : 1;
    for (const row of ranks) {
      if (!row) continue;
      const key = new Map(row.map((n) => {
        const ns = neighbours(n.id, dir);
        return [n.id, ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : pos.get(n.id)];
      }));
      row.sort((a, b) => key.get(a.id) - key.get(b.id));
      row.forEach((n, i) => pos.set(n.id, i));
    }
  }

  // 4. positions — a rank wider than the panel wraps onto further lines rather
  // than widening the canvas. A sidebar is a tall thin thing; a graph that
  // scrolls sideways in it is a graph that gets read once. Scrolling stays
  // vertical, which is the direction the flow already runs.
  const placed = [];
  const width = Math.max(200, o.maxWidth);
  const inner = width - o.padX * 2;
  let cursor = o.padY;

  ranks.forEach((row, r) => {
    if (!row || !row.length) return;
    const sized = row.map((n) => ({ n, w: Math.min(inner, o.measure(nodeText(n))) }));

    const lines = [[]];
    let lineW = 0;
    for (const item of sized) {
      const line = lines[lines.length - 1];
      if (line.length && lineW + o.gapX + item.w > inner) {
        lines.push([item]);
        lineW = item.w;
      } else {
        line.push(item);
        lineW += (line.length > 1 ? o.gapX : 0) + item.w;
      }
    }

    lines.forEach((line, li) => {
      const total = line.reduce((a, b) => a + b.w, 0) + o.gapX * (line.length - 1);
      let x = o.padX + (inner - total) / 2;
      const y = cursor + li * (o.nodeH + o.lineGap);
      for (const { n, w } of line) {
        placed.push(Object.assign({}, n, {
          x, y, w, h: o.nodeH, rank: r, text: fitText(nodeText(n), w, o.measure),
        }));
        x += w + o.gapX;
      }
    });

    cursor += lines.length * (o.nodeH + o.lineGap) - o.lineGap + o.rankGap;
  });

  const height = cursor - o.rankGap + o.padY;
  return { nodes: placed, edges: graph.edges, drift: graph.drift, width, height };
}

function nodeText(n) {
  return `${KIND[n.kind].glyph} ${n.label}`;
}

/* Trim with the same measurement that sized the pill, so the ellipsis lands
 * where the theme's font actually runs out rather than where a fixed
 * characters-per-pixel guess says it should. */
function fitText(text, w, measure) {
  const room = w - 14;
  if (measure(text) - 22 <= room) return text;
  let s = text;
  while (s.length > 1 && measure(`${s}…`) - 22 > room) s = s.slice(0, -1);
  return `${s}…`;
}

/* No canvas in the test harness; in Obsidian the view swaps in a real
 * measurement so long labels do not overflow their pill. */
function approxWidth(text) {
  return Math.min(220, Math.max(64, text.length * 6.1 + 22));
}

/* -------------------------------------------------------------------- render */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* Short edges connect directly. Anything spanning more than one rank is bowed
 * out to the nearer side gutter instead of cutting straight down through the
 * node column — in a 300px-wide panel those long edges are what turns the
 * picture into spaghetti, and pushing them to the margin leaves the middle
 * legible. Following one specific chain is what selection is for; the static
 * picture only has to carry shape, cadence and kind. */
function edgePath(a, b, canvasW) {
  const x1 = a.x + a.w / 2;
  const y1 = a.y + a.h;
  const x2 = b.x + b.w / 2;
  const y2 = b.y;
  const span = Math.abs((b.rank || 0) - (a.rank || 0));

  if (y2 <= y1) {
    // a return path: always bow right, so the loop reads as a loop
    const bow = Math.min(canvasW * 0.42, Math.max(46, (y1 - y2) * 0.22));
    return `M ${x1} ${y1} C ${x1 + bow} ${y1 + 20}, ${x2 + bow} ${y2 - 20}, ${x2} ${y2}`;
  }

  if (span > 1) {
    const left = (x1 + x2) / 2 < canvasW / 2;
    const gutter = left ? Math.min(x1, x2) * 0.35 : canvasW - (canvasW - Math.max(x1, x2)) * 0.35;
    return `M ${x1} ${y1} C ${gutter} ${y1 + 26}, ${gutter} ${y2 - 26}, ${x2} ${y2}`;
  }

  const mid = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
}

function renderSvg(view, state) {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const parts = [];
  parts.push(
    // The SVG fills its pane and the viewBox is the camera — set from the view
    // on every pan and zoom. Sizing the SVG to its content instead (the first
    // version) left the graph occupying only the top of a large window, made
    // panning depend on there being overflow to scroll, and clipped away any
    // node dragged past the content's edge.
    `<svg class="vag-svg" viewBox="0 0 ${view.width} ${view.height}" `
    + 'width="100%" height="100%" preserveAspectRatio="xMidYMid meet" '
    + 'xmlns="http://www.w3.org/2000/svg">',
  );
  parts.push(
    '<defs>'
    + '<marker id="vag-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">'
    + '<path d="M0,0 L8,4 L0,8 z" class="vag-arrow-head"/></marker></defs>',
  );

  parts.push('<g class="vag-edges">');
  for (const e of view.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const long = Math.abs((b.rank || 0) - (a.rank || 0)) > 1 ? ' vag-edge-long' : '';
    parts.push(
      `<path class="vag-edge vag-edge-${esc(e.type)}${long}" d="${edgePath(a, b, view.width)}" `
      + `data-from="${esc(e.from)}" data-to="${esc(e.to)}" marker-end="url(#vag-arrow)"/>`,
    );
  }
  parts.push('</g>');

  parts.push('<g class="vag-nodes">');
  for (const n of view.nodes) {
    const st = (state && state[n.id]) || null;
    const cls = `vag-node vag-${KIND[n.kind].cls}${n.verified ? '' : ' vag-declared'}`
      + `${st ? ` vag-state-${st.kind}` : ''}`;
    parts.push(
      `<g class="${cls}" data-node="${esc(n.id)}" data-cadence="${esc(n.cadence || '')}" tabindex="0">`
      + `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="7"/>`
      + `<text x="${n.x + n.w / 2}" y="${n.y + n.h / 2 + 4}" text-anchor="middle">`
      + `${esc(n.text || nodeText(n))}</text>`
      + badgeSvg(n, st)
      + `<title>${esc(nodeTooltip(n, st))}</title></g>`,
    );
  }
  parts.push('</g></svg>');
  return parts.join('');
}

/* A count where there is one to show, a dot where the state is worth seeing at
 * a glance, and nothing at all for "passing" or "unknown" — a panel that marks
 * every healthy node is a panel whose marks stop being read. */
function badgeSvg(n, st) {
  if (!st) return '';
  const cx = n.x + n.w - 3;
  const cy = n.y + 3;
  if (st.badge && st.badge !== '0') {
    return `<circle class="vag-badge-bg" cx="${cx}" cy="${cy}" r="8"/>`
      + `<text class="vag-badge-text" x="${cx}" y="${cy + 3}" text-anchor="middle">${esc(st.badge)}</text>`;
  }
  if (['failure', 'running', 'stale'].includes(st.kind)) {
    return `<circle class="vag-badge-dot" cx="${cx}" cy="${cy}" r="4.5"/>`;
  }
  return '';
}

/* The two kinds every graph carries whether or not anything was found: the
 * human gate and `main`. They are the frame derived automation hangs on, not
 * evidence that any was derived. */
const SCAFFOLD_KINDS = new Set(['human', 'artifact']);

/* Whether this graph shows the reader anything at all.
 *
 * The panel used to ask `view.nodes.length`, which is never zero: buildGraph
 * lays down the gate and `main` unconditionally, so a vault with no automation
 * still produced two nodes and one edge between them. The empty panel — the
 * screen that says what was looked for and offers the repositories found on
 * this machine — could therefore never appear. A new reader got a picture of
 * two boxes meaning nothing, instead of the one screen written for them.
 */
function graphHasContent(nodes) {
  return (nodes || []).some((n) => !SCAFFOLD_KINDS.has(n.kind));
}

function nodeTooltip(n, st) {
  const bits = [n.label, n.kind];
  if (n.cron) bits.push(`cron ${n.cron} (UTC)`);
  if (n.detail) bits.push(n.detail);
  if (st && st.note) bits.push(st.note);
  bits.push(n.verified
    ? `from ${n.source || 'this repository'}`
    : `declared in ${n.source || 'a note'} — not verifiable from this repository`);
  return bits.filter(Boolean).join(' · ');
}

/* ---------------------------------------------------------- DOM rendering */

/* Everything a user's browser actually executes is built as real nodes —
 * createElementNS + setAttribute + textContent — never innerHTML. The escaped
 * string builder above (renderSvg) stays only for check.js, which runs in
 * plain Node with no `document` to build into; it was never a security
 * boundary here (every value was already escaped), but Obsidian's plugin
 * guidelines treat innerHTML as a blanket risk regardless of what feeds it,
 * so the code path real users hit doesn't use it at all.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const key in attrs) {
      const v = attrs[key];
      if (v !== undefined && v !== null) el.setAttribute(key, v);
    }
  }
  return el;
}

function buildSvgElement(view, state) {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));

  const svg = svgEl('svg', {
    class: 'vag-svg',
    viewBox: `0 0 ${view.width} ${view.height}`,
    width: '100%',
    height: '100%',
    preserveAspectRatio: 'xMidYMid meet',
  });

  const defs = svgEl('defs');
  const marker = svgEl('marker', {
    id: 'vag-arrow', viewBox: '0 0 8 8', refX: '7', refY: '4',
    markerWidth: '6', markerHeight: '6', orient: 'auto',
  });
  marker.appendChild(svgEl('path', { d: 'M0,0 L8,4 L0,8 z', class: 'vag-arrow-head' }));
  defs.appendChild(marker);
  svg.appendChild(defs);

  const edgesG = svgEl('g', { class: 'vag-edges' });
  for (const e of view.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const long = Math.abs((b.rank || 0) - (a.rank || 0)) > 1 ? ' vag-edge-long' : '';
    edgesG.appendChild(svgEl('path', {
      class: `vag-edge vag-edge-${e.type}${long}`,
      d: edgePath(a, b, view.width),
      'data-from': e.from,
      'data-to': e.to,
      'marker-end': 'url(#vag-arrow)',
    }));
  }
  svg.appendChild(edgesG);

  const nodesG = svgEl('g', { class: 'vag-nodes' });
  for (const n of view.nodes) {
    const st = (state && state[n.id]) || null;
    const cls = `vag-node vag-${KIND[n.kind].cls}${n.verified ? '' : ' vag-declared'}`
      + `${st ? ` vag-state-${st.kind}` : ''}`;
    const g = svgEl('g', {
      class: cls, 'data-node': n.id, 'data-cadence': n.cadence || '', tabindex: '0',
    });

    g.appendChild(svgEl('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 7 }));

    const text = svgEl('text', { x: n.x + n.w / 2, y: n.y + n.h / 2 + 4, 'text-anchor': 'middle' });
    text.textContent = n.text || nodeText(n);
    g.appendChild(text);

    appendBadge(g, n, st);

    const title = svgEl('title');
    title.textContent = nodeTooltip(n, st);
    g.appendChild(title);

    nodesG.appendChild(g);
  }
  svg.appendChild(nodesG);

  return svg;
}

/* Mirrors badgeSvg's three cases exactly, as real elements. */
function appendBadge(g, n, st) {
  if (!st) return;
  const cx = n.x + n.w - 3;
  const cy = n.y + 3;
  if (st.badge && st.badge !== '0') {
    g.appendChild(svgEl('circle', { class: 'vag-badge-bg', cx, cy, r: 8 }));
    const t = svgEl('text', { class: 'vag-badge-text', x: cx, y: cy + 3, 'text-anchor': 'middle' });
    t.textContent = st.badge;
    g.appendChild(t);
    return;
  }
  if (['failure', 'running', 'stale'].includes(st.kind)) {
    g.appendChild(svgEl('circle', { class: 'vag-badge-dot', cx, cy, r: 4.5 }));
  }
}

/* ---------------------------------------------------------------- the view */

class AutomationGraphView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.selected = null;
    this.filter = null;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Automation graph'; }
  getIcon() { return 'git-fork'; }

  async onOpen() {
    // One frame late: at onOpen the leaf often has no width yet, and laying out
    // to a width of zero produces a graph that has to be thrown away.
    window.requestAnimationFrame(() => {
      this.draw();
      // Structure first, then the network. The graph must never wait on
      // GitHub to appear — the derived half is the part that always works.
      this.refresh();
    });
  }

  /* Re-derive the structure and re-fetch run state. Failure of the second
   * never costs you the first. */
  async refresh() {
    this.loading = true;
    this.draw();
    try {
      await this.plugin.refreshLive();
    } finally {
      this.loading = false;
      this.draw();
      // Reschedule from what this fetch found: 30s if something is running,
      // otherwise the idle interval, otherwise nothing.
      this.plugin.scheduleNextPoll();
    }
  }

  async onClose() {
    if (this.endDrag) this.endDrag();
    window.clearTimeout(this.resizeTimer);
    // Re-evaluate after the leaf is actually gone: with no panel open there is
    // nothing to poll for, and polling on should stop with the last view.
    window.setTimeout(() => this.plugin.scheduleNextPoll(), 0);
  }

  onResize() {
    // Re-layout rather than rescale: the panel is narrow, and a graph that
    // shrinks to fit is a graph nobody can read. Dragging the sidebar edge
    // fires this continuously, and every draw re-reads the repo — so settle
    // first, and ignore the sub-pill wobble entirely.
    const width = this.contentEl.clientWidth;
    if (Math.abs((this.lastWidth || 0) - width) < 8) return;
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.framed = false;          // a resized pane deserves a fresh framing
      this.draw();
    }, 150);
  }

  draw() {
    const root = this.contentEl;
    root.empty();
    root.addClass('vag-root');
    this.lastWidth = root.clientWidth;

    // Containers first, so the graph can be laid out to the width the scroller
    // actually has. Measuring the panel instead left the layout ~15px wider
    // than the space beside the vertical scrollbar, which is a horizontal
    // scrollbar under a graph that was supposed to only ever scroll down.
    // (.vag-scroll sets scrollbar-gutter: stable, so this width holds once the
    // content is tall enough to need the bar.)
    const head = root.createDiv({ cls: 'vag-head' });
    const legend = root.createDiv({ cls: 'vag-legend' });
    const scroller = root.createDiv({ cls: 'vag-scroll' });
    this.detail = root.createDiv({ cls: 'vag-detail' });

    const avail = scroller.clientWidth || root.clientWidth || 320;

    let view;
    try {
      const graph = buildGraph(this.plugin.readVault());
      view = layout(graph, {
        measure: this.measurer(),
        // Capped in a wide pane: past a point extra width only stretches the
        // edges, and a rank spread across 2000px is harder to read than one
        // centred in 1100.
        maxWidth: Math.max(240, Math.min(avail - 2, 1100)),
      });
    } catch (err) {
      root.createDiv({ cls: 'vag-error', text: `Could not derive the graph: ${err.message}` });
      return;
    }
    // Manual positions are applied on top of the layout, and the canvas grows
    // to contain them — a node dragged past the edge must not be clipped away.
    const offsets = this.plugin.settings.layout || {};
    for (const n of view.nodes) {
      n.baseX = n.x;
      n.baseY = n.y;
      const off = offsets[n.id];
      if (!off) continue;
      n.x += off[0];
      n.y += off[1];
      view.width = Math.max(view.width, n.x + n.w + 12);
      view.height = Math.max(view.height, n.y + n.h + 12);
    }

    this.view = view;

    if (!graphHasContent(view.nodes)) {
      // Drop the scaffolding built above before saying there is nothing to
      // show. The header and legend would render as two empty bordered bars,
      // and .vag-scroll is flex: 1 1 auto — it takes the whole pane and pushes
      // the panel that explains what to do to the very bottom, under them.
      root.empty();
      this.detail = null;
      this.renderEmpty(root);
      return;
    }

    // Live state is an overlay, computed separately and allowed to be absent.
    // If the fetch failed or never ran, the structure below is still exactly
    // as true as it was — only the badges go away.
    const paths = view.nodes
      .filter((n) => n.id.startsWith('art:f:') && !n.id.includes('*'))
      .map((n) => n.id.slice('art:f:'.length));
    const previous = this.state;
    this.state = stateFor(view.nodes, view.edges, this.plugin.live, this.plugin.readFreshness(paths));

    this.renderHeader(head, legend, view);

    const anim = (this.plugin.settings && this.plugin.settings.animate) || 'real';
    root.toggleClass('vag-anim-off', anim === 'off');
    root.toggleClass('vag-anim-all', anim === 'all');

    // Real nodes, not innerHTML — scroller is freshly emptied by root.empty()
    // above, so there is nothing stale to clear first.
    scroller.appendChild(buildSvgElement(view, this.state));
    this.markFlow();
    this.flashChanges(previous);

    // Keep the selection across a redraw. Now that polling and file-watching
    // can redraw on their own, dropping it would clear the detail pane under
    // the reader mid-sentence.
    const keep = this.selected && view.nodes.some((n) => n.id === this.selected)
      ? this.selected : null;
    this.selected = null;
    if (keep) this.select(keep); else this.showDetail(null);

    scroller.querySelectorAll('[data-node]').forEach((el) => {
      const id = el.getAttribute('data-node');
      el.addEventListener('click', () => {
        if (this.suppressClick) return;      // this click ended a drag
        this.select(id);
      });
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') this.select(id);
      });
      // Hover lights the immediate neighbourhood, no click required. Selection
      // is still what traces the whole downstream chain.
      el.addEventListener('mouseenter', () => this.hover(id));
      el.addEventListener('mouseleave', () => this.hover(null));
      this.installNodeDrag(el, id, scroller);
    });

    this.installZoomPan(scroller);
    if (!this.pan) this.pan = { x: 0, y: 0 };
    // Frame on first paint only. Later redraws — polling, file-watching — must
    // not yank the camera back while the reader is looking somewhere.
    if (!this.framed) {
      this.framed = true;
      window.requestAnimationFrame(() => this.fit());
    } else {
      this.applyView();
    }
  }

  /* The first thing most readers see, because most vaults are not repositories.
   * It used to say "open a vault that is itself a git repository", which asks
   * someone to restructure their vault to use a plugin — so it says what it
   * looked at, why that came back empty, and offers the setting that fixes it. */
  renderEmpty(root) {
    const s = this.plugin.repoStatus();
    const box = root.createDiv({ cls: 'vag-error vag-empty' });

    // What this is, before why it is empty. For most readers this panel is the
    // first thing the plugin ever shows them, and opening with a diagnosis
    // answers a question they have not formed yet — they do not know what it
    // was trying to draw, so "this vault is not a repository" means nothing.
    box.createDiv({
      cls: 'vag-empty-lead',
      text: 'Automation Graph draws a repository\'s workflows as a graph.',
    });

    let reason;
    if (!s.exists) {
      reason = s.sameAsVault
        ? 'This vault does not appear to be a repository.'
        : `That folder does not exist: ${s.root}`;
    } else if (!s.workflows && !s.claude) {
      reason = s.isGit
        ? `${s.root} is a repository, but it has no .github/workflows and no .claude/ — there is no automation here to draw.`
        : `${s.root} has no .github/workflows and no .claude/ in it.`;
    } else {
      // Directories are there and were read; the graph still came out empty.
      // That is a parse result, not a configuration mistake, and saying
      // "point it somewhere else" here would send the reader the wrong way.
      reason = `Read ${s.workflows} workflow file(s) in ${s.root}, but derived no nodes from them.`;
    }
    box.createDiv({ cls: 'vag-empty-reason', text: reason });

    // Offer what is actually on this machine before asking anyone to type a
    // path. Reaching this screen and being handed a blank text field is the
    // point a first run usually ends.
    const candidates = this.plugin.repoCandidates()
      .filter((c) => c.root !== s.root)
      .slice(0, 6);

    if (candidates.length) {
      // An instruction, not an observation. "Found 6 repositories" states a
      // fact and asks for nothing; the rows are buttons but read as a list, so
      // the one action that fixes everything was never actually requested.
      box.createDiv({
        cls: 'vag-empty-hint vag-empty-ask',
        text: candidates.length === 1
          ? 'Pick this repository to draw it:'
          : 'Pick the repository you want to draw:',
      });
      const list = box.createDiv({ cls: 'vag-candidates' });
      for (const c of candidates) {
        const row = list.createEl('button', { cls: 'vag-candidate' });
        row.createDiv({ cls: 'vag-candidate-path', text: this.plugin.shortPath(c.root) });
        row.createDiv({
          cls: 'vag-candidate-meta',
          text: `${c.workflows} workflow${c.workflows === 1 ? '' : 's'}${c.isGit ? '' : ' · not a git repository'}`,
        });
        row.onclick = () => this.plugin.adoptRepo(c.root);
      }
      box.createDiv({ cls: 'vag-empty-hint', text: 'Somewhere else? Set the path in settings.' });
    } else {
      box.createDiv({
        cls: 'vag-empty-hint',
        text: s.sameAsVault
          ? 'Nothing with workflows in it turned up beside this vault or under your '
            + 'home folder. If your code is somewhere less usual, set the path to the '
            + 'folder that contains .github/workflows.'
          : 'Set the path to the folder that contains .github/workflows.',
      });
    }

    new Setting(box)
      .addButton((btn) => {
        // Says what it does. The old label — "Choose a folder…" — promised a
        // picker this button does not open, on the one element that looks like
        // the primary action.
        btn.setButtonText('Open settings').onClick(() => this.plugin.openSettings());
        // Accented only when it is the way forward. With repositories listed
        // above, the rows are the action and an accented button beside them
        // competes for the eye with the thing the reader should press.
        if (!candidates.length) btn.setCta();
      });
  }

  renderHeader(head, legend, view) {
    const counts = view.nodes.reduce((acc, n) => {
      acc[n.verified ? 'verified' : 'declared'] += 1;
      return acc;
    }, { verified: 0, declared: 0 });

    const title = head.createDiv({ cls: 'vag-title' });
    title.createSpan({ text: 'Automation' });
    const sub = `${counts.verified} derived · ${counts.declared} declared`;
    title.createSpan({
      cls: 'vag-sub',
      // Which repository, whenever it is not the vault. A graph is a claim
      // about a specific repository, and the panel should never leave the
      // reader guessing which one they are looking at.
      text: this.plugin.repoRoot() === this.plugin.vaultRoot()
        ? sub
        : `${sub} · ${this.plugin.shortPath(this.plugin.repoRoot())}`,
    });

    const tools = head.createDiv({ cls: 'vag-tools' });
    const fit = tools.createEl('button', { text: 'Fit', cls: 'vag-btn' });
    fit.onclick = () => this.fit();
    const refresh = tools.createEl('button', { text: 'Redraw', cls: 'vag-btn' });
    refresh.onclick = () => this.refresh();
    // Offer the location you are not in. "Open wide" while already wide is a
    // button that appears to do nothing.
    let inMain = false;
    try {
      inMain = this.leaf.getRoot() === this.app.workspace.rootSplit;
    } catch (e) { /* harness, or a workspace shape without a root split */ }
    const move = tools.createEl('button', { text: inMain ? 'To sidebar' : 'Open wide', cls: 'vag-btn' });
    move.onclick = () => (inMain ? this.plugin.activate() : this.plugin.openInMainPane());

    // The live row states its own freshness, always. There is no rendering of
    // this panel in which run state is silently missing: it either carries a
    // timestamp or it says why it has none.
    // Picked for them, not by them: said once, plainly, with the way to change
    // it. Silently drawing a repository nobody chose is the kind of helpfulness
    // that reads as a bug the first time it guesses wrong.
    if (this.plugin.usingDetectedRepo()) {
      const note = head.createDiv({ cls: 'vag-detected' });
      note.createSpan({ text: `Found this repository automatically — ${this.plugin.shortPath(this.plugin.repoRoot())}` });
      const change = note.createEl('button', { text: 'change', cls: 'vag-btn vag-btn-sm' });
      change.onclick = () => this.plugin.openSettings();
    }

    const live = this.plugin.live;
    const row = head.createDiv({ cls: 'vag-live' });
    let text;
    let cls = 'vag-live-chip';
    if (this.loading) {
      text = 'checking GitHub…';
    } else if (!live) {
      text = 'run state not checked yet — click to fetch';
    } else if (live.needsToken) {
      text = 'no token found — Settings → Automation Graph → Test connection';
      cls += ' vag-live-warn';
    } else if (live.error) {
      text = `run state unavailable: ${live.error}`;
      cls += ' vag-live-warn';
    } else {
      const waiting = live.prs + live.issues;
      // Say the cadence out loud when it is polling. "As of 5:02" with no
      // further word leaves the reader unable to tell a live panel from a
      // frozen one.
      const delay = pollDelay(live, this.plugin.settings, 1);
      const cadence = delay === ACTIVE_POLL_MS ? ' · re-checking every 30s'
        : (delay ? ` · re-checking every ${Math.round(delay / 60000)}m` : '');
      text = `run state as of ${new Date(live.at).toLocaleTimeString()}`
        + `${waiting ? ` · ${waiting} waiting on you` : ''}${cadence}`;
      cls += ' vag-live-ok';
    }
    const chip = row.createDiv({ cls, text });
    chip.onclick = () => this.refresh();

    if (view.drift.length) {
      const chip = head.createDiv({ cls: 'vag-drift' });
      chip.setText(`⚠ ${view.drift.length} drift`);
      chip.onclick = () => {
        const list = head.querySelector('.vag-drift-list');
        if (list) { list.remove(); return; }
        const ul = head.createDiv({ cls: 'vag-drift-list' });
        for (const d of view.drift) ul.createDiv({ cls: 'vag-drift-item', text: d.text.replace(/`/g, '') });
      };
    }

    const chips = [
      ['scheduled', 'on a clock'],
      ['event', 'on an event'],
      ['human', 'you'],
    ];
    for (const [cadence, label] of chips) {
      const chip = legend.createSpan({ cls: `vag-chip vag-chip-${cadence}`, text: label });
      chip.onclick = () => {
        this.filter = this.filter === cadence ? null : cadence;
        this.contentEl.querySelectorAll('[data-cadence]').forEach((el) => {
          el.classList.toggle('vag-dim', !!this.filter && el.getAttribute('data-cadence') !== this.filter);
        });
        legend.querySelectorAll('.vag-chip').forEach((c) => c.classList.toggle('vag-chip-on', c === chip && !!this.filter));
      };
    }
  }

  /* Light the immediate neighbourhood of whatever the pointer is over. Cheap
   * on purpose: class toggles only, no relayout, so it stays smooth while the
   * pointer sweeps across a dense rank. */
  hover(id) {
    const root = this.contentEl;
    if (!id) {
      root.querySelectorAll('.vag-hovered, .vag-edge-hover')
        .forEach((el) => el.classList.remove('vag-hovered', 'vag-edge-hover'));
      return;
    }
    const neighbours = new Set([id]);
    for (const e of this.view.edges) {
      if (e.from === id) neighbours.add(e.to);
      if (e.to === id) neighbours.add(e.from);
    }
    root.querySelectorAll('[data-node]').forEach((el) => {
      el.classList.toggle('vag-hovered', neighbours.has(el.getAttribute('data-node')));
    });
    root.querySelectorAll('.vag-edge').forEach((el) => {
      const touching = el.getAttribute('data-from') === id || el.getAttribute('data-to') === id;
      el.classList.toggle('vag-edge-hover', touching);
    });
  }

  /* Nodes can be moved. The layered layout stays the source of truth — a drag
   * records an offset from where the layout put the node, so a node you have
   * not touched keeps following the layout as the graph changes, and the ranks
   * still mean what they meant. Offsets live in settings, so an arrangement
   * survives a redraw, a reload and a restart.
   */
  installNodeDrag(el, id, scroller) {
    let drag = null;

    el.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();            // stop the browser starting a selection
      ev.stopPropagation();           // and stop the background pan handler
      const node = this.view.nodes.find((n) => n.id === id);
      if (!node) return;
      drag = {
        x: ev.clientX, y: ev.clientY, moved: false, node, ox: node.x, oy: node.y,
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      this.endDrag = up;
    });

    const move = (ev) => {
      if (!drag) return;
      const scale = this.scale || 1;
      const dx = (ev.clientX - drag.x) / scale;
      const dy = (ev.clientY - drag.y) / scale;
      if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      drag.moved = true;
      el.classList.add('vag-dragging');

      drag.node.x = drag.ox + dx;
      drag.node.y = drag.oy + dy;
      el.setAttribute('transform',
        `translate(${drag.node.x - drag.ox},${drag.node.y - drag.oy})`);
      this.redrawEdgesFor(id);
    };

    const up = () => {
      if (!drag) return;
      if (drag.moved) {
        const base = this.baseFor(id);
        const offsets = Object.assign({}, this.plugin.settings.layout);
        offsets[id] = [
          Math.round((drag.node.x - base.x) * 10) / 10,
          Math.round((drag.node.y - base.y) * 10) / 10,
        ];
        this.plugin.settings.layout = offsets;
        this.plugin.saveSettings();
        // Swallow the click this drag would otherwise fire, so releasing a
        // node you dragged does not also select it.
        this.suppressClick = true;
        window.setTimeout(() => { this.suppressClick = false; }, 0);
      }
      el.classList.remove('vag-dragging');
      drag = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.endDrag = null;
    };
  }

  /* Where the layout — before any manual offset — put this node. */
  baseFor(id) {
    const node = this.view.nodes.find((n) => n.id === id);
    if (!node) return { x: 0, y: 0 };
    const off = (this.plugin.settings.layout || {})[id] || [0, 0];
    // node.x already includes the offset applied at render time, so the base is
    // the rendered position minus whatever offset was applied then.
    return { x: node.baseX !== undefined ? node.baseX : node.x - off[0],
      y: node.baseY !== undefined ? node.baseY : node.y - off[1] };
  }

  /* Recompute only the edges touching a node being dragged. */
  redrawEdgesFor(id) {
    const byId = new Map(this.view.nodes.map((n) => [n.id, n]));
    this.contentEl.querySelectorAll('.vag-edge').forEach((path) => {
      const from = path.getAttribute('data-from');
      const to = path.getAttribute('data-to');
      if (from !== id && to !== id) return;
      const a = byId.get(from);
      const b = byId.get(to);
      if (a && b) path.setAttribute('d', edgePath(a, b, this.view.width));
    });
  }

  /* The camera. `pan` is the world coordinate at the pane's top-left and
   * `scale` is pixels per world unit; together they are the viewBox. Nothing
   * here depends on scrollbars existing, so panning works whether or not the
   * graph is bigger than the pane, and a node dragged into empty space is
   * still there to be panned to rather than clipped away. */
  applyView() {
    const svg = this.contentEl.querySelector('.vag-svg');
    const scroller = this.contentEl.querySelector('.vag-scroll');
    if (!svg || !scroller || !this.view) return;
    const scale = this.scale || 1;
    const w = (scroller.clientWidth || this.view.width) / scale;
    const h = (scroller.clientHeight || this.view.height) / scale;
    svg.setAttribute('viewBox', `${this.pan.x} ${this.pan.y} ${w} ${h}`);
  }

  /* Frame everything, including nodes dragged well outside the layout. Also
   * the answer to "the graph does not fill the window": the camera zooms to
   * the pane rather than the picture being pinned at its natural size. */
  fit() {
    const scroller = this.contentEl.querySelector('.vag-scroll');
    if (!scroller || !this.view || !this.view.nodes.length) return;
    const pad = 16;
    const xs = this.view.nodes.map((n) => n.x);
    const ys = this.view.nodes.map((n) => n.y);
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    const maxX = Math.max(...this.view.nodes.map((n) => n.x + n.w)) + pad;
    const maxY = Math.max(...this.view.nodes.map((n) => n.y + n.h)) + pad;

    const pw = scroller.clientWidth || this.view.width;
    const ph = scroller.clientHeight || this.view.height;
    // Clamped: in a narrow sidebar a true fit would shrink 11px labels to
    // something unreadable, and panning is available for the overflow.
    this.scale = Math.max(0.6, Math.min(2, Math.min(pw / (maxX - minX), ph / (maxY - minY))));
    this.pan = {
      x: minX - ((pw / this.scale) - (maxX - minX)) / 2,
      y: minY - ((ph / this.scale) - (maxY - minY)) / 2,
    };
    this.applyView();
  }

  installZoomPan(scroller) {
    // Screen pixels -> world coordinates, via the current camera.
    const toWorld = (ev) => {
      const r = scroller.getBoundingClientRect();
      const scale = this.scale || 1;
      return {
        x: this.pan.x + (ev.clientX - r.left) / scale,
        y: this.pan.y + (ev.clientY - r.top) / scale,
      };
    };

    // Plain wheel zooms, matching Obsidian's own graph view. Shift+wheel is
    // kept as a vertical pan for anyone used to scrolling this panel.
    scroller.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      if (ev.shiftKey) {
        this.pan.y += ev.deltaY / (this.scale || 1);
        this.applyView();
        return;
      }
      const before = this.scale || 1;
      const next = Math.min(4, Math.max(0.2, before * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
      if (next === before) return;
      // Keep the point under the cursor fixed: it is the only zoom that feels
      // like the picture rather than the window is moving.
      const at = toWorld(ev);
      this.scale = next;
      const r = scroller.getBoundingClientRect();
      this.pan = {
        x: at.x - (ev.clientX - r.left) / next,
        y: at.y - (ev.clientY - r.top) / next,
      };
      this.applyView();
    }, { passive: false });

    // Drag the background to pan. Works at any zoom, including when the whole
    // graph already fits — there is no scrollbar involved any more.
    // While a drag is live the listeners belong to the window, not the pane.
    // Ending a pan on mouseleave meant any drag that crossed the pane edge —
    // which is most of them, since panning is how you reach what is off-screen
    // — stopped dead at the boundary.
    scroller.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0 || ev.target.closest('[data-node]')) return;
      ev.preventDefault();
      const from = { x: ev.clientX, y: ev.clientY, pan: { x: this.pan.x, y: this.pan.y } };
      scroller.classList.add('vag-panning');

      const move = (e) => {
        const scale = this.scale || 1;
        this.pan = {
          x: from.pan.x - (e.clientX - from.x) / scale,
          y: from.pan.y - (e.clientY - from.y) / scale,
        };
        this.applyView();
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        scroller.classList.remove('vag-panning');
        this.endDrag = null;
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      this.endDrag = up;               // so closing the view mid-drag cleans up
    });

    // Double-click empty space reframes everything, dragged nodes included —
    // the way back when you have panned or dragged something out of sight.
    scroller.addEventListener('dblclick', (ev) => {
      if (ev.target.closest('[data-node]')) return;
      this.fit();
    });
  }

  /* Edges leaving a workflow that is running right now. This is the only
   * animation that runs unasked, and it is showing something true. */
  markFlow() {
    const st = this.state || {};
    const running = new Set(Object.keys(st).filter((k) => st[k].kind === 'running'));
    this.contentEl.querySelectorAll('.vag-edge').forEach((el) => {
      el.classList.toggle('vag-edge-live', running.has(el.getAttribute('data-from')));
    });
  }

  /* A node whose state changed since the last draw gets one flash. Refreshing
   * and seeing nothing move is the answer "nothing changed", which is worth
   * being able to tell apart from "the refresh did not work". */
  flashChanges(previous) {
    if (!previous) return;
    const now = this.state || {};
    const changed = new Set();
    for (const id of new Set([...Object.keys(previous), ...Object.keys(now)])) {
      const before = previous[id] && previous[id].kind;
      const after = now[id] && now[id].kind;
      if (before !== after) changed.add(id);
    }
    if (!changed.size) return;
    this.contentEl.querySelectorAll('[data-node]').forEach((el) => {
      if (changed.has(el.getAttribute('data-node'))) el.classList.add('vag-flash');
    });
  }

  /* Everything reachable downstream of a node, with its hop distance. The hop
   * count becomes an animation delay, so selecting a clock plays the chain it
   * sets off as a wave rather than lighting the whole graph at once. */
  downstream(id) {
    const out = new Map();
    for (const e of this.view.edges) {
      if (!out.has(e.from)) out.set(e.from, []);
      out.get(e.from).push(e);
    }
    const edges = new Map();
    const nodes = new Map([[id, 0]]);
    let frontier = [id];
    for (let hop = 0; hop < 8 && frontier.length; hop++) {
      const next = [];
      for (const cur of frontier) {
        for (const e of out.get(cur) || []) {
          const key = `${e.from}|${e.to}`;
          if (edges.has(key)) continue;
          edges.set(key, hop);
          if (!nodes.has(e.to)) {
            nodes.set(e.to, hop + 1);
            next.push(e.to);
          }
        }
      }
      frontier = next;
    }
    return { edges, nodes };
  }

  select(id) {
    this.selected = this.selected === id ? null : id;
    const node = this.view.nodes.find((n) => n.id === this.selected);
    this.contentEl.querySelectorAll('[data-node]').forEach((el) => {
      el.classList.toggle('vag-selected', el.getAttribute('data-node') === this.selected);
    });
    const trace = this.selected ? this.downstream(this.selected) : null;
    this.contentEl.querySelectorAll('.vag-edge').forEach((el) => {
      const from = el.getAttribute('data-from');
      const to = el.getAttribute('data-to');
      const touching = this.selected && (from === this.selected || to === this.selected);
      el.classList.toggle('vag-edge-on', !!touching);

      const hop = trace ? trace.edges.get(`${from}|${to}`) : undefined;
      el.classList.toggle('vag-edge-trace', hop !== undefined);
      el.style.animationDelay = hop === undefined ? '' : `${hop * 0.22}s`;
    });
    this.contentEl.querySelectorAll('[data-node]').forEach((el) => {
      el.classList.toggle('vag-traced', !!trace && trace.nodes.has(el.getAttribute('data-node')));
    });
    this.showDetail(node);
  }

  showDetail(node) {
    const d = this.detail;
    // Absent on the empty panel, which tears the pane down and rebuilds it
    // without a detail pane. Nothing selectable exists there, but a redraw
    // arriving from polling must not throw on the way past.
    if (!d) return;
    d.empty();
    if (!node) {
      d.createDiv({
        cls: 'vag-hint',
        text: 'Tap a node for what it is, where it is defined, and when it next runs.',
      });
      return;
    }

    d.createDiv({ cls: 'vag-d-title', text: `${KIND[node.kind].glyph} ${node.label}` });
    const meta = d.createDiv({ cls: 'vag-d-meta' });
    meta.createSpan({ cls: 'vag-tag', text: node.kind });
    meta.createSpan({
      cls: node.verified ? 'vag-tag vag-tag-ok' : 'vag-tag vag-tag-declared',
      text: node.verified ? 'derived from a file' : 'declared, not verifiable here',
    });

    const st = this.state && this.state[node.id];
    if (st) {
      const row = d.createDiv({ cls: `vag-d-row vag-d-state vag-state-${st.kind}` });
      row.createSpan({ text: st.note });
      if (st.url) {
        const open = row.createEl('button', { cls: 'vag-btn vag-btn-sm', text: 'Run log' });
        open.onclick = () => window.open(st.url, '_blank');
      }
    }

    const crons = node.cron ? [node.cron] : ((node.facts && node.facts.triggers.crons) || []);
    for (const cron of crons) {
      const next = nextFire(cron);
      d.createDiv({
        cls: 'vag-d-row',
        text: `next: ${next ? `${fmtLocal(next)} (${TZ})` : 'never — cron does not resolve'}`,
      });
    }
    if (node.when) d.createDiv({ cls: 'vag-d-row', text: `runs: ${node.when}` });
    if (node.detail) d.createDiv({ cls: 'vag-d-row', text: node.detail });

    if (node.facts) {
      const t = node.facts.triggers;
      const trig = [];
      if (t.dispatch) trig.push('manual dispatch');
      if (t.issues) trig.push('issue events');
      if (t.pullRequest) trig.push('PR events');
      if (t.pushBranches.length) trig.push(`push to ${t.pushBranches.join(', ')}`);
      if (t.pushPaths.length) trig.push(`push touching ${t.pushPaths.join(', ')}`);
      if (trig.length) d.createDiv({ cls: 'vag-d-row', text: `also on: ${trig.join(' · ')}` });
    }

    if (node.source) {
      const row = d.createDiv({ cls: 'vag-d-src' });
      row.createSpan({ text: node.source });
      const open = row.createEl('button', { cls: 'vag-btn vag-btn-sm', text: 'Open' });
      open.onclick = () => this.plugin.openSource(node.source);
    }
  }

  /* Real text measurement inside Obsidian — the pill has to fit the theme's
   * font, not the harness's guess about it. */
  measurer() {
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const style = getComputedStyle(this.contentEl);
      ctx.font = `11px ${style.fontFamily || 'sans-serif'}`;
      return (text) => Math.min(230, Math.max(64, Math.ceil(ctx.measureText(text).width) + 22));
    } catch (e) {
      return approxWidth;
    }
  }
}

/* ------------------------------------------------------------------ plugin */

// 'main' by default: the graph is nine ranks deep and reads far better with
// room to breathe than squeezed into a sidebar column.
const DEFAULT_SETTINGS = {
  token: '', ghPath: '', autoRefreshMinutes: 0, openIn: 'main', layout: {},
  declaredNote: '', timezone: '',
  // Empty = the vault is the repository, which is what every install before
  // this setting assumed. Nothing changes for them on upgrade.
  repoPath: '',
  // 'real' animates only what is actually happening — a workflow running now,
  // the chain you selected, a node whose state just changed. 'all' makes every
  // edge flow continuously, which looks better and means less: this machine is
  // idle most of the day, and a picture that is always moving says otherwise.
  animate: 'real',
};

class AutomationGraphPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    configure(this.settings);
    this.live = null;

    this.pollTimer = null;
    this.watchers = [];

    this.registerView(VIEW_TYPE, (leaf) => new AutomationGraphView(leaf, this));
    this.addSettingTab(new AutomationGraphSettingTab(this.app, this));

    this.register(() => this.stopPolling());
    this.register(() => this.stopWatching());
    this.startWatching();

    this.addRibbonIcon('git-fork', 'Automation graph', () => this.open());
    this.addCommand({
      id: 'open-automation-graph',
      name: 'Open automation graph',
      callback: () => this.open(),
    });
    this.addCommand({
      id: 'open-automation-graph-wide',
      name: 'Open automation graph in main pane',
      callback: () => this.openInMainPane(),
    });
    this.addCommand({
      id: 'reset-automation-graph-layout',
      name: 'Reset node positions',
      callback: async () => {
        this.settings.layout = {};
        await this.saveSettings();
        this.redrawAll();
        new Notice('Automation graph: node positions reset to the derived layout.');
      },
    });
    this.addCommand({
      id: 'open-automation-graph-sidebar',
      name: 'Open automation graph in the left sidebar',
      callback: () => this.activate(),
    });
  }

  onunload() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => leaf.detach());
  }

  vaultRoot() {
    const adapter = this.app.vault.adapter;
    return adapter.basePath || (adapter.getBasePath && adapter.getBasePath()) || '';
  }

  /* The repository the graph is derived from. Same as the vault unless the
   * reader has said otherwise, which is the common case: most vaults are notes,
   * and most repositories are somewhere else entirely. */
  repoRoot() {
    /* eslint-disable global-require */
    const path = require('path');
    const explicit = this.settings && this.settings.repoPath;
    if (explicit) {
      let home = '';
      try { home = require('os').homedir(); } catch (e) { /* ~ stays literal */ }
      return resolveRepoRoot(path, this.vaultRoot(), explicit, home);
    }
    // Nothing configured: if exactly one repository was found on this machine,
    // use it rather than drawing an empty panel and asking for a path. Nothing
    // is written to settings — the reader can still set one, and this
    // re-resolves on reload if their machine changes.
    return this.autoRepo() || this.vaultRoot();
  }

  homeDir() {
    try { return require('os').homedir(); } catch (e) { return ''; }
  }

  /* Absolute paths are long enough to wrap twice in a sidebar. `~` is both
   * shorter and how the reader thinks of it anyway. */
  shortPath(p) {
    const home = this.homeDir();
    return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  }

  /* Cached for the session: the panel redraws on file changes and on every
   * poll, and walking the disk each time would make those redraws cost real
   * time for an answer that almost never changes. */
  repoCandidates() {
    if (this.candidateCache) return this.candidateCache;
    try {
      const fs = require('fs');
      const path = require('path');
      this.candidateCache = findRepoCandidates(fs, path, this.vaultRoot(), this.homeDir());
    } catch (e) {
      this.candidateCache = [];
    }
    return this.candidateCache;
  }

  /* Adopt a detected repository only when there is exactly one, and only when
   * the vault is not itself a repository with workflows. Two candidates is a
   * question, not a default — guessing between them would draw a graph of the
   * wrong project and look like a bug rather than a choice. */
  autoRepo() {
    if (this.autoRepoCache !== undefined) return this.autoRepoCache;
    const vault = this.vaultRoot();
    const found = this.repoCandidates();
    if (found.some((c) => c.root === vault)) {
      this.autoRepoCache = null;                 // the vault is the repository
    } else {
      this.autoRepoCache = found.length === 1 ? found[0].root : null;
    }
    return this.autoRepoCache;
  }

  /* True when the graph is being drawn from somewhere nobody chose, which the
   * panel has to say out loud — a picture of a repository you did not pick is
   * confusing precisely because it looks right. */
  usingDetectedRepo() {
    return !(this.settings && this.settings.repoPath) && !!this.autoRepo();
  }

  forgetDetection() {
    this.candidateCache = null;
    this.autoRepoCache = undefined;
  }

  /* Take one of the offered repositories. Writes it to settings, so from here
   * on it is a choice rather than a guess. */
  async adoptRepo(root) {
    this.settings.repoPath = root;
    await this.saveSettings();
    await this.applyRepoPath();
  }

  /* What the configured repository path actually points at, in the terms the
   * reader needs to fix it: does it exist, is it a repository, does it hold
   * workflows. Shared by the settings tab and the empty panel, so the two can
   * never disagree about why nothing was found. */
  repoStatus() {
    const root = this.repoRoot();
    const out = {
      root, exists: false, isGit: false, workflows: 0, claude: false, sameAsVault: root === this.vaultRoot(),
    };
    try {
      const fs = require('fs');
      const path = require('path');
      if (!fs.existsSync(root)) return out;
      out.exists = true;
      out.isGit = fs.existsSync(path.join(root, '.git'));
      out.claude = fs.existsSync(path.join(root, '.claude'));
      try {
        out.workflows = fs.readdirSync(path.join(root, '.github/workflows'))
          .filter((f) => /\.ya?ml$/.test(f)).length;
      } catch (e) { /* no workflows directory — reported as 0, not as an error */ }
    } catch (e) {
      out.error = e.message;
    }
    return out;
  }

  readVault() {
    /* eslint-disable global-require */
    const fs = require('fs');
    const path = require('path');
    return readSources(fs, path, this.repoRoot(), this.vaultRoot());
  }

  /* Last-written times for produced files, from git. No network, so this is
   * the half of "live" that keeps working on a plane. Runs in the repository,
   * which is the only place those paths mean anything. */
  readFreshness(paths) {
    try {
      const { execFileSync } = require('child_process');
      return localFreshness(execFileSync, this.repoRoot(), paths);
    } catch (e) {
      return {};
    }
  }

  /* Resolve a token, ask GitHub, store the answer. Any failure is recorded as
   * an error on this.live rather than thrown: a panel that shows nothing
   * because the network blipped is worse than one that says the network
   * blipped. */
  /* Token discovery, isolated so the settings tab can run it on its own and
   * report what happened without also performing a fetch. */
  findToken() {
    try {
      const fs = require('fs');
      const os = require('os');
      const { execFileSync } = require('child_process');
      return resolveToken(
        this.settings, process.env, execFileSync,
        (p) => fs.readFileSync(p, 'utf8'), os.homedir(),
      );
    } catch (e) {
      return { token: null, from: null, tried: [`token lookup failed: ${e.message}`] };
    }
  }

  async refreshLive() {
    let slug = null;
    let found = { token: null, from: null, tried: [] };
    try {
      const fs = require('fs');
      const path = require('path');
      slug = readRepoSlug(fs, path, this.repoRoot());
      found = this.findToken();
    } catch (e) {
      this.live = { error: `could not resolve a token: ${e.message}` };
      return this.live;
    }

    this.live = await fetchLive({ slug, token: found.token, request: requestUrl });
    this.live.slug = slug;
    this.live.tokenFrom = found.from;
    this.live.tokenTried = found.tried;
    return this.live;
  }

  async saveSettings() {
    configure(this.settings);
    await this.saveData(this.settings);
  }

  /* Settings that change how the graph looks should show up without making
   * the reader go and reopen the panel. */
  redrawAll() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE)
      .forEach((leaf) => leaf.view && leaf.view.draw && leaf.view.draw());
  }

  openViewCount() {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).length;
  }

  /* Adaptive polling: quiet while the machine is quiet, every 30s while a run
   * is in flight. Rescheduled after every fetch, so it speeds up on its own
   * when something starts and settles again when it finishes. */
  scheduleNextPoll() {
    this.stopPolling();
    const delay = pollDelay(this.live, this.settings, this.openViewCount());
    if (!delay) return;
    this.pollTimer = window.setTimeout(async () => {
      this.pollTimer = null;
      if (!this.openViewCount()) return;          // panel closed while we waited
      await this.refreshLive();
      this.redrawAll();
      this.scheduleNextPoll();
    }, delay);
  }

  stopPolling() {
    if (this.pollTimer) window.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /* Watch the files the structure is derived from, so editing a workflow — or
   * obsidian-git pulling someone else's — updates the picture without a
   * Redraw. Structure only: this never touches the network. */
  startWatching() {
    let fs;
    let path;
    try {
      fs = require('fs');
      path = require('path');
    } catch (e) {
      return;                                     // no node API, no watching
    }
    const roots = { repo: this.repoRoot(), vault: this.vaultRoot() };
    for (const [rel, relevant, which] of watchTargets(this.settings.declaredNote)) {
      const root = roots[which] || roots.vault;
      try {
        const watcher = fs.watch(path.join(root, rel), { persistent: false }, (ev, file) => {
          if (!relevant(file)) return;
          this.onSourceChanged();
        });
        this.watchers.push(watcher);
      } catch (e) { /* directory absent on this machine — nothing to watch */ }
    }
  }

  stopWatching() {
    for (const w of this.watchers) {
      try { w.close(); } catch (e) { /* already closed */ }
    }
    this.watchers = [];
    if (this.watchDebounce) window.clearTimeout(this.watchDebounce);
    this.watchDebounce = null;
  }

  /* One redraw per burst: a single save fires several fs events, and a git
   * pull fires one per file it touches. */
  onSourceChanged() {
    if (this.watchDebounce) window.clearTimeout(this.watchDebounce);
    this.watchDebounce = window.setTimeout(() => {
      this.watchDebounce = null;
      if (this.openViewCount()) this.redrawAll();
    }, 500);
  }

  /* Straight to this plugin's own tab, so the empty panel's button lands the
   * reader on the setting rather than on the top of Obsidian's settings. */
  openSettings() {
    const setting = this.app.setting;
    if (!setting || !setting.open) {
      new Notice('Open Settings → Community plugins → Automation Graph.');
      return;
    }
    setting.open();
    if (setting.openTabById) setting.openTabById('automation-graph');
  }

  /* The repository moved: re-point the watchers, drop run state fetched about
   * the old repo, and redraw. Without the re-watch, edits in the new repository
   * would not reach the panel until a reload. */
  async applyRepoPath() {
    this.live = null;
    this.forgetDetection();
    this.stopWatching();
    this.startWatching();
    this.redrawAll();
  }

  /* Where the ribbon icon and the plain command put it. Both specific
   * commands stay available regardless, so neither location is locked away. */
  open() {
    return this.settings.openIn === 'left' ? this.activate() : this.openInMainPane();
  }

  async activate() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE)
      .filter((leaf) => workspace.getLeftLeaf && leaf.getRoot() !== workspace.rootSplit);
    if (existing.length) {
      workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getLeftLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
  }

  async openInMainPane() {
    const { workspace } = this.app;
    // Reuse a tab that is already open in the main area rather than stacking
    // duplicates every time the ribbon is clicked.
    const existing = workspace.getLeavesOfType(VIEW_TYPE)
      .find((leaf) => leaf.getRoot() === workspace.rootSplit);
    if (existing) {
      workspace.revealLeaf(existing);
      workspace.setActiveLeaf(existing, { focus: true });
      return;
    }
    const leaf = workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
  }

  /* Dot-folder files are invisible to Obsidian's index, so "open" means the
   * system editor for those and a normal note for anything the vault can see. */
  async openSource(rel) {
    const file = this.app.vault.getAbstractFileByPath(rel);
    if (file && 'extension' in file) {
      await this.app.workspace.getLeaf(true).openFile(file);
      return;
    }
    try {
      const { shell } = require('electron');
      const path = require('path');
      const fs = require('fs');
      // Workflow files hang off the repository, the declared note off the
      // vault. When those are the same directory this is the old behaviour;
      // when they differ, guessing wrong opens nothing, so check.
      const candidates = [...new Set([this.repoRoot(), this.vaultRoot()])]
        .map((base) => path.join(base, rel));
      const full = candidates.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } })
        || candidates[0];
      const err = await shell.openPath(full);
      if (err) new Notice(`Could not open ${rel}: ${err}`);
    } catch (e) {
      new Notice(`${rel} lives outside Obsidian's index — open it in your editor.`);
    }
  }
}

/* ---------------------------------------------------------------- settings */

class AutomationGraphSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /* One line saying what the configured path actually is, refreshed on every
   * keystroke. A path setting that only reveals whether it worked when you
   * close settings and reopen the panel is a setting people get wrong once and
   * then abandon. */
  renderRepoStatus(el) {
    el.empty();
    const s = this.plugin.repoStatus();
    if (this.plugin.usingDetectedRepo()) {
      el.createDiv({
        cls: 'vag-diag-line',
        text: `Using ${this.plugin.shortPath(s.root)}, found automatically. `
          + 'Set a path here to pin it.',
      });
    }
    if (!s.exists) {
      el.createDiv({ cls: 'vag-diag-line', text: `✗ no such folder: ${s.root}` });
      return;
    }
    const bits = [];
    bits.push(s.workflows
      ? `${s.workflows} workflow file(s)`
      : 'no .github/workflows');
    if (s.claude) bits.push('.claude/ present');
    if (!s.isGit) bits.push('not a git repository — run state and freshness will be unavailable');
    const ok = s.workflows || s.claude;
    el.createDiv({
      cls: 'vag-diag-line',
      text: `${ok ? '✓' : '✗'} ${s.root} — ${bits.join(', ')}`,
    });
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    // First, because nothing below it matters if the plugin is looking at the
    // wrong directory.
    new Setting(containerEl)
      .setName('Repository path')
      .setDesc('The repository whose automation is drawn. Leave empty if this vault is '
        + 'itself the repository. Otherwise give the folder that contains .github/workflows '
        + '— absolute, or relative to the vault (../work/api), or starting with ~. '
        + 'The declared-automation note is always read from the vault, wherever this points.')
      .addText((text) => {
        text.inputEl.addClass('vag-wide-input');
        text.setPlaceholder('~/code/my-repo  (empty = this vault)')
          .setValue(this.plugin.settings.repoPath || '')
          .onChange(async (value) => {
            this.plugin.settings.repoPath = value.trim();
            await this.plugin.saveSettings();
            this.renderRepoStatus(repoReport);
            await this.plugin.applyRepoPath();
          });
      });
    const repoReport = containerEl.createDiv({ cls: 'setting-item-description vag-diag' });
    this.renderRepoStatus(repoReport);

    // Picking from a list beats knowing a path. The scan is cheap and bounded,
    // but it is still disk work, so it happens when asked rather than every
    // time the settings tab is opened.
    // Declared before the Setting so the click handler can close over it, but
    // appended after — results belong under the button that produced them, not
    // above it, where they read as belonging to the setting before this one.
    let picker;
    new Setting(containerEl)
      .setName('Find repositories')
      .setDesc('Looks for repositories with workflows in the usual places — beside the '
        + 'vault, and under your home folder — and lists them to pick from.')
      .addButton((btn) => {
        btn.setButtonText('Find').onClick(() => {
          picker.empty();
          picker.createDiv({ cls: 'vag-diag-line', text: 'Looking…' });
          this.plugin.forgetDetection();
          const found = this.plugin.repoCandidates();
          picker.empty();
          if (!found.length) {
            picker.createDiv({
              cls: 'vag-diag-line',
              text: 'Nothing with .github/workflows turned up beside the vault or under '
                + 'your home folder. Paste the path above instead.',
            });
            return;
          }
          const list = picker.createDiv({ cls: 'vag-candidates' });
          for (const c of found.slice(0, 8)) {
            const row = list.createEl('button', { cls: 'vag-candidate' });
            row.createDiv({ cls: 'vag-candidate-path', text: this.plugin.shortPath(c.root) });
            row.createDiv({
              cls: 'vag-candidate-meta',
              text: `${c.workflows} workflow${c.workflows === 1 ? '' : 's'}${c.isGit ? '' : ' · not a git repository'}`,
            });
            row.onclick = async () => {
              await this.plugin.adoptRepo(c.root);
              this.display();                    // reflect the new value in the field
            };
          }
        });
      });
    picker = containerEl.createDiv({ cls: 'setting-item-description vag-diag' });

    const found = this.plugin.live && this.plugin.live.tokenFrom;
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: found
        ? `Currently using the token from ${found}.`
        : 'No token found yet. The panel looks in this order: plugin setting below, '
          + 'then $VAULT_PAT / $GITHUB_TOKEN / $GH_TOKEN, then gh (several known '
          + 'locations), then ~/.config/gh/hosts.yml.',
    });

    // The diagnosis, not just the verdict. "No token" while `gh auth status`
    // works in a terminal almost always means Obsidian was launched from the
    // Dock and never saw your shell's PATH or exported variables.
    const report = containerEl.createDiv({ cls: 'setting-item-description vag-diag' });
    new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Finds a token, says where it came from, and makes one real request.')
      .addButton((btn) => {
        btn.setButtonText('Test').onClick(async () => {
          report.empty();
          report.createDiv({ text: 'Testing…' });
          const t = this.plugin.findToken();
          report.empty();
          if (t.token) {
            report.createDiv({ text: `✓ token found via ${t.from}` });
          } else {
            report.createDiv({ text: '✗ no token found. Tried, in order:' });
            for (const line of t.tried || []) report.createDiv({ cls: 'vag-diag-line', text: `• ${line}` });
            report.createDiv({
              cls: 'vag-diag-line',
              text: 'If gh works in your terminal but says "not found" above, Obsidian was '
                + 'launched without your shell PATH. Set the gh path below to the output of '
                + '`which gh`, or paste a token.',
            });
            return;
          }
          const live = await this.plugin.refreshLive();
          if (live.error) {
            report.createDiv({ cls: 'vag-diag-line', text: `✗ request failed: ${live.error}` });
          } else {
            report.createDiv({
              cls: 'vag-diag-line',
              text: `✓ ${live.slug}: ${Object.keys(live.runs).length} workflow(s) with recent runs, `
                + `${live.prs} open PR(s), ${live.issues} open issue(s)`,
            });
            this.plugin.redrawAll();
          }
        });
      });

    new Setting(containerEl)
      .setName('Path to gh')
      .setDesc('Only needed if gh is installed somewhere the panel does not look. '
        + 'Run `which gh` in a terminal and paste the result.')
      .addText((text) => {
        text.setPlaceholder('/opt/homebrew/bin/gh')
          .setValue(this.plugin.settings.ghPath || '')
          .onChange(async (value) => {
            this.plugin.settings.ghPath = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Open in')
      .setDesc('Where the ribbon icon puts the graph. The main pane gives it room; '
        + 'the sidebar keeps it beside your notes. Both are always available from the '
        + 'command palette whichever you pick here.')
      .addDropdown((drop) => {
        drop.addOption('main', 'Main pane (wide)')
          .addOption('left', 'Left sidebar')
          .setValue(this.plugin.settings.openIn)
          .onChange(async (value) => {
            this.plugin.settings.openIn = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Animation')
      .setDesc('"Only what is happening" animates a workflow that is running now, the '
        + 'chain you select, and any node whose state just changed. "Everything flowing" '
        + 'keeps every edge moving — it looks livelier, but this machine is idle most of '
        + 'the day, so constant motion is decoration rather than information. Reduced-motion '
        + 'system settings are honoured either way.')
      .addDropdown((drop) => {
        drop.addOption('real', 'Only what is happening')
          .addOption('all', 'Everything flowing')
          .addOption('off', 'Off')
          .setValue(this.plugin.settings.animate)
          .onChange(async (value) => {
            this.plugin.settings.animate = value;
            await this.plugin.saveSettings();
            this.plugin.redrawAll();
          });
      });

    new Setting(containerEl)
      .setName('GitHub token')
      .setDesc('Only needed if the environment and the gh CLI cannot supply one. '
        + 'A private repository cannot report run state without a token. '
        + 'Needs read access to Actions, pull requests and issues. Stored in this '
        + "plugin's data.json — if your vault is itself a repository, keep that file "
        + 'out of version control.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder('ghp_… (leave empty to use gh or the environment)')
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Idle re-check')
      .setDesc('Minutes between run-state fetches while nothing is running. 0 means '
        + 'fetch only when the panel opens or you ask. Regardless of this setting, '
        + 'the panel drops to every 30 seconds on its own while a workflow is actually '
        + 'running, and settles back when it finishes. Each fetch is 3 requests against '
        + 'an authenticated ceiling of 5,000 per hour, so this is not a budget worth '
        + 'protecting — it defaults to 0 because background network calls should be '
        + 'asked for, not assumed.')
      .addText((text) => {
        text.setPlaceholder('0')
          .setValue(String(this.plugin.settings.autoRefreshMinutes))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.autoRefreshMinutes = Number.isFinite(n) && n > 0 ? n : 0;
            await this.plugin.saveSettings();
            this.plugin.scheduleNextPoll();
          });
      });

    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Changing auto-refresh takes effect after reloading the plugin.',
    });
  }
}

module.exports = AutomationGraphPlugin;

/* Exported for the offline harness (scripts/automation-graph-check.js), which
 * runs the same parse → build → layout → SVG path against the real repo with no
 * Obsidian around it. Obsidian ignores extra properties on the exported class. */
module.exports.__internals = {
  readSources, parseTriggers, parseEmissions, parseWorkflows, parseDeclared,
  nextFire, cronLabel, buildGraph, layout, renderSvg, buildSvgElement, approxWidth, KIND,
  readRepoSlug, resolveRepoRoot, findRepoCandidates, graphHasContent,
  resolveToken, fetchLive,
  localFreshness, stateFor,
  expectedPeriod, nodePeriod,
  pollDelay, ACTIVE_POLL_MS, watchTargets, configure,
  describeAge,
  // The view too, so the panel's own wiring — header, legend, selection,
  // detail pane — can be driven in a headless browser instead of being the one
  // layer nobody exercises until it is in front of a user.
  AutomationGraphView,
};
