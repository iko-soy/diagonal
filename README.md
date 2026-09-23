# Diagonal

Dia-style tab groups for Brave on macOS, named by Apple's on-device model through the `fm` command-line tool over Chromium native messaging. No HTTP server, no cloud call, no model download.

You open and close tabs as usual. Diagonal does the rest on its own; there are no shortcuts and nothing to press.

1. **Opener grouping.** Cmd-click a link from an ungrouped, unpinned tab and both tabs become a group, titled with the site's hostname until the model names it.
2. **Auto-organize.** Any other loose tab (typed address, bookmark, new window) is sorted once the window has been quiet for 8 s: it joins one of Diagonal's groups, pairs up with other loose tabs on the same topic, or stays loose if nothing fits. A loose tab is looked at again only when it goes to another page or a new tab arrives that it might pair with.
3. **Naming loop.** Groups Diagonal made get an `emoji + 2–4 word` title from the model. The title is recomputed after 4 s of quiet when membership changes, stays put when the model only paraphrases, and is never touched again once you type a title yourself.
4. **Dissolve.** A group Diagonal made that drops to one tab is ungrouped, unless you gave it a title.
5. **Tidy.** Tabs idle for 24 h move to a collapsed grey "Parked" group at the end of the strip. Opening a parked tab takes it back out and auto-organize places it. After another 48 h in Parked, tabs are archived and closed, with restore from the popup.

Your own choices win: a tab you take out of a group stays out until it goes to another page, groups you make yourself are left alone, and a title you type is kept. The popup still has **Organize now**, **Tidy now** and their undo, but none of them is needed.

The model sees a tab's title, address and `<meta name="description">`, and nothing else.

## Requirements

- Brave stable 1.95+ (Chromium 121+ APIs are used)
- macOS 27 on Apple silicon, with Apple Intelligence on and the on-device model downloaded (`/usr/bin/fm` ships with macOS 27)
- Python 3 (standard library only) for the host

## Install

### 1. The extension

The built extension is in `dist/` (or `diagonal-extension/` next to this folder in the delivery).

1. Open `brave://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `dist/` folder.
3. Check that the ID shown is `mpnodlalikgeehnlnofdkpgapkmbkjdf`. It is pinned by the `key` in `manifest.json`, so it stays the same across reloads and machines.

To rebuild from source: `npm ci && npm run build`.

### 2. The native host

Without Nix:

```sh
scripts/install-manifest.sh            # add --beta / --nightly / --all-channels for other Brave channels
```

This copies `host/` to `~/.local/share/diagonal-host`, links `~/.local/bin/diagonal-host`, pins its shebang to your `python3`, writes `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/io.diagonal.host.json`, runs `diagonal-host --install-schemas`, then `diagonal-host --selftest`.

With Nix (nix-darwin + home-manager):

```nix
# flake inputs
diagonal.url = "path:/path/to/diagonal";   # or a git URL once it lives in a repo

# home-manager config
imports = [ inputs.diagonal.homeManagerModules.default ];
programs.diagonal.enable = true;
# programs.diagonal.channels = [ "Brave-Browser" "Brave-Browser-Beta" ];
```

`nix build .#extension` builds `dist/` into `./result`; `nix build .#diagonal-host` builds the host.

### 3. Check it

Open Diagonal's settings page and click **Run self-test**. Expect `fmAvailable: true`, `schemasOk: true` and a title for the three fixture tabs. From a terminal, `diagonal-host --selftest` runs the same checks.

## Develop

```sh
npm ci
npm run build          # dist/
npm run watch          # rebuild on change
npm run typecheck
npm test               # vitest: engine, naming, organize, tidy, url, property tests
npm run test:host      # unittest: framing, origin, every error code, prompts, validators
npm run smoke          # Linux: loads dist/ in Chromium with the real host and a fake fm
npm run check          # typecheck + both unit suites
```

Layout follows the spec: `src/background/` (engine, naming, organize, tidy, host client, state, settings), `src/content/meta.ts`, `src/popup/`, `src/options/`, `src/shared/`, and `host/` (`diagonal-host.py`, `prompts.py`, `validate.py`, `emoji.txt`, `tests/`).

`host/emoji.txt` is the single emoji list. `npm run gen-emoji` regenerates `src/shared/emoji.gen.ts` from it.

### Releases

Every push to `master` runs `.github/workflows/release.yml`: it typechecks, runs both test suites, builds with the manifest `version` set to the commit's UTC time as `YYYY.MM.DD.HHMM`, and publishes a GitHub release tagged with that version, with `diagonal-extension-<version>.zip` attached. Two commits in the same minute share a release; the later one replaces its zip. Locally, `DIAGONAL_VERSION=2026.09.23.1619 npm run build` produces the same stamped build.

### Pinning a different extension ID

`scripts/gen-key.sh` creates `key.pem` if it is missing, writes the public key into `manifest.json`, the ID into `extension-id` and into `ALLOWED_ORIGIN` in `host/diagonal-host.py`, and prints the ID. The shipped ID comes from a key that is not included; you only need the private key to pack a `.crx`. Running the script without a `key.pem` makes a new key and a new ID, so after that rebuild and rerun the host installer.

## Where this differs from the spec, and why

- **Fully automatic.** The spec's keyboard commands are gone (new tab in group, organize, rename, tidy now). Organize runs on its own for loose tabs, the tidy sweep parks without asking by default (Ask mode is still a setting), and topic groups dissolve at one tab like opener groups do.
- **Model calls are one at a time.** Naming and auto-organize share a queue, so they never run the model in parallel.
- **Query strings.** The spec keeps the query only when the path is empty, but also wants `youtube.com/watch?v=…` kept. Diagonal keeps the whole query when the path is empty and otherwise keeps only content keys (`v`, `q`, `query`, `search_query`, `search`, `s`, `k`, `id`, `p`, `list`, `page`), dropping `utm_*` and similar.
- **Grey is reserved for the Parked group.** Site colours hash over the other eight colours.
- **Organize only adds tabs to Diagonal's own groups,** not to groups you made by hand, unless "Name my own groups" is on.
- **An Organize group whose title fails validation is still created,** with the hostname as a placeholder, and the naming loop names it.
- **Restarts.** Tab and group IDs change when Brave restarts, so records are matched to live groups by title and colour, which keeps managed groups managed.

## Not verified on a real Mac yet

Everything was tested against a fake `fm`. These are open until someone runs it on macOS 27 (section 16 of the spec):

- The `fm schema` flags. `diagonal-host --install-schemas` tries the nested organize schema and falls back to the two flat schemas plus two calls if that fails. The flags are in `SCHEMA_COMMANDS` at the top of `host/diagonal-host.py`.
- `fm` stderr wording. `classify()` matches keywords, so an unexpected message shows as `FM_ERROR` with the raw text on the settings page.
- Whether `fm respond` can read the prompt from stdin. Until then, the prompt is an argument and is briefly visible in `ps`.
- The context window. `CHAR_BUDGET` is 10,000 characters, assuming 4,096 tokens. Double it (and `NAME_ITEM_CAP` / `ORGANIZE_ITEM_CAP`) once 8,192 is confirmed.
- The Nix flake has not been built. `importNpmLock` avoids an `npmDepsHash`.
