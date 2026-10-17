# dsh-skill-install

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) skill installer. From the Web settings page
(Settings → "Skills"), search GitHub repositories by name or paste a repo URL, list the `SKILL.md` skills inside,
tick the ones you want, and install them to a target directory. Integrates with the built-in skill-filesystem, so
installed skills take effect immediately — no restart required.

[中文](README.zh.md)

## Features

- **Search by name / paste a URL**: one input accepts a skill/repo name (searches repos by name), or `owner/repo`
  and `https://github.com/owner/repo` addresses.
- **Only matched repos**: search returns concrete matching repositories; click "Open" to browse their skills.
  There is no full-site discovery feed.
- **Selectable target, global by default**:
  - Global → `<dshHome>/skills` (watched by skill-filesystem by default)
  - Current project → `<project root>/.dsh/skills` (project root = nearest `.git` ancestor, else cwd)
  - Custom directory → any absolute directory; the plugin registers its own skill provider and hot-refreshes it
- **Installed list**: grouped by target directory, one-click removal.
- **Currently loaded skills**: the merged set from the built-in skill-filesystem and this plugin (read-only).
- **Proxy (collapsed entry)**: configure a proxy address, test connectivity, or clear it; requests go through the
  system `curl` when set, direct otherwise.

## Install

```sh
# Local directory — quit the Desktop app first; --profile is required.
dsh plugin --profile <profile> add ./dsh-skill-install

# From GitHub
dsh plugin --profile <profile> add github:<owner>/dsh-skill-install
```

Then restart Harness so the new bundle composes; "Settings → Skills" shows the new page. This package has
**zero external runtime dependencies** (`js-yaml` is bundled as a self-contained ESM build), so a GitHub install
needs no `allowBuilds` code-execution approval.

## Runtime dependencies

- The host plugin is pure ESM with no external runtime dependencies (`js-yaml` is bundled in `js-yaml.mjs`, MIT).
- Extracting the GitHub tarball needs system `tar` (built into Windows 10 1809+); using a proxy needs `curl`.

## Skill-system integration

- Global / project installs write into the standard roots watched by skill-filesystem, so the watcher hot-loads them;
- Custom directories are registered as an independent skill provider via `ctx.skills.registerProvider`, using the
  same discovery rules (`<root>/<name>/SKILL.md` or `<root>/<name>.md`), invalidated on install / remove / changes;
- All routes and providers are registered with `ctx.effect`, so they are removed automatically on disable / reload.

## License

MIT
