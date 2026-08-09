# Contributing

Issues and pull requests are welcome. This file is the short version of how the repository works, so you don't have to infer it.

## The shape of it

There is **no build step**. `main.js` is the source — hand-written, unminified, and what Obsidian loads. Edit it directly. There is no bundler, no TypeScript, no `node_modules`.

| File | |
|---|---|
| `main.js` | the plugin |
| `styles.css` | all styling, using Obsidian's theme variables |
| `check.js` | offline harness — the test suite |
| `manifest.json`, `versions.json` | version metadata Obsidian reads |

## Running it

Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/automation-graph/` and reload Obsidian (`⌘P` → *Reload app without saving*). Editing files in place and reloading is the whole loop.

## Checking it

```bash
node check.js --unit                    # code checks, no repository needed — what CI runs
node check.js /path/to/a/repo           # full: parse → build → layout → SVG, prints what it derived
node check.js /path/to/repo --vault /path/to/vault --declared notes/automation.md
```

`--unit` must pass before a release; CI runs it on every tag.

## What the checks are for

Each one exists because something got past the others:

- **`resolveRepoRoot`** — the repository path setting decides where every read happens.
- **`findRepoCandidates`** — built against a real temporary tree, not a mock, because the bugs were real-filesystem bugs: case-insensitive paths listing every repository twice, vendored copies being offered.
- **The empty vault** — the panel that greets a new user was unreachable for three releases because every other check ran against a repository that already had automation in it.
- **README against the settings tab** — two settings were documented for eleven releases and had no row in the UI.
- **`:has` in `styles.css`** — flagged by Obsidian's review for broad style invalidation.

If you fix something the harness didn't catch, please add the check that would have. That is the pattern here.

## What is hard to see from a terminal

Most of this plugin's bugs have been rendering bugs: keys bound to the wrong direction, a row clipped by a fixed height, a panel pushed below a flex child, a CSS class that resolved against the wrong box. `check.js` cannot see any of that.

**Open the plugin in Obsidian before opening a pull request.** A throwaway vault with nothing in it is the fastest way to check first-run behaviour, and it is where the worst bug so far was found.

## Style

Match the surrounding code. Comments explain *why*, especially where something looks odd — most of them mark a decision that was wrong the first time.

- No `innerHTML` in anything a user runs. Build DOM with `createEl` / `createDiv` / `createElementNS`.
- Colours come from Obsidian theme variables, never hardcoded, so the panel follows the vault's theme.
- Kind is carried by colour; verification is carried by the border, so the two remain distinguishable without colour vision.
- Shell calls use `execFileSync` with an argument array, never a shell string.

## Releasing

Maintainers only. Bump `manifest.json` and `versions.json`, commit, then:

```bash
git tag 1.2.3 && git push origin 1.2.3
```

`.github/workflows/release.yml` refuses to publish unless the tag, `manifest.json` and `versions.json` agree, runs the checks, attaches the three assets and attests their provenance. The tag carries no `v` prefix — Obsidian reads the tag as the version, and a mismatch fails silently rather than loudly.

## Scope

Bug reports and fixes are the easiest thing to land. Before building a feature, please open an issue — the plugin deliberately draws only what it can derive from files, and the most common suggestion (letting you add nodes by hand) is the one thing it is designed not to do.
