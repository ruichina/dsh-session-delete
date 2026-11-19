# dsh-session-delete

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that **permanently deletes sessions** from the sidebar session list.

English | [中文](README.md)

DSH's built-in "Archive session" only hides a row; the log stays on disk. This plugin adds real deletion: **Delete session…** in the row menu (right-click, or the row's `...` menu), plus a trash button on row hover. Confirming removes the stored chat log, its projection cache, and the workspace entry.

- Version: `1.0.0`
- Tested with: DSH `0.2.2-rc.5` (desktop)
- License: MIT

## Features

| Surface | Where |
|---|---|
| Menu row **Delete session…** | Session row menu (right-click or `...`), placed before the built-in Archive action |
| Trash button | On row hover, after the archive and pin buttons |
| Confirmation dialog | Cancel focused by default, Escape / backdrop click cancels, buttons disabled while deleting |
| Success notice | A short "Session deleted" pill at the bottom, cleared after ~2.4 s |
| Agent tool `session_delete` | The same Host method, taking a list of session ids |

## Install

```bash
git clone https://github.com/ruichina/dsh-session-delete.git
```

Either **Plugins → Add plugin** and pick the cloned directory (local link install), or run:

```text
plugin_manager action=install_bundle target=<absolute path to this repository>
```

The installed row id looks like `include:session-delete`. Disable it any time in **Settings → Plugins**; disabling restores the stock sidebar and removes the `session_delete` tool.

## What it removes

In the **Host process**, after confirmation:

1. The Session's storage directory (`<DSH_HOME>/sessions/<group>/<session-dir>/`), including **every format generation** — deleting only the current generation would resurrect the Session at an older format;
2. Its projection-cache record `<DSH_HOME>/storages/session_projcache/sessions/<id>.json`;
3. The Session's workspace, archive, and pin entries, so the row disappears from the sidebar.

## Limits and safety gates

- A Session that is **in use** (a live Agent still owns its write handle) is refused; switch to another Session first.
- A Session that **still has running work** (subagents, jobs, schedules) is refused; archive it first — archiving stops that work. The check reuses the archive path's `workspace/session-activity` waterfall.
- The dialog handles one Session at a time; the `session_delete` tool accepts up to 50 ids per request.
- Attachments and terminals of the Session are out of scope.
- A Session that belongs to no workspace may keep its sidebar row until you switch sessions or reload the page.

## How it works

- **Host half** ([`index.js`](index.js)): the deletion is written once and shared by both callers. The browser reaches it through one **exact Fetch route** on `/api` (`ctx.connection.fetch.register`, `POST /api/session-delete/delete`); the `/api` RPC interceptor is single-owner (the API Gateway holds it) and cannot be claimed by a plugin. The `session_delete` tool runs the same function.
- **Client half** ([`client.js`](client.js)): registers into `sidebar.workspaces.session.menu.item`, `sidebar.workspaces.session.row.action`, and `shell.overlay`; styles use only `--dsw-alias-*` theme tokens, and the dialog portals to `document.body` so a narrow-window drawer cannot cover it.
- Display metadata and the icon come from [`locale/`](locale) and [`icon.svg`](icon.svg), readable without enabling the plugin.

## Known gaps

- The in-browser click flow was verified by hand by the author; this repository has no automated UI test.
- The workspace-account detach branch (`detachSession`) cannot be exercised with a synthetic session and has only been reviewed in code.

## Development

- After editing `client.js`, reload the page (client bundles are versioned by file metadata);
- After editing `index.js`, restart the plugin row (disable, then enable) to load the new Host module;
- Syntax check: `node --check index.js client.js`.

## Credits

The plugin contract, slot catalogue, and theme tokens come from [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness). Released under the [MIT](LICENSE) license.
