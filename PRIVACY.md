# Diagonal privacy policy

Diagonal groups and names your browser tabs. This page says what it reads, where that goes, and what it keeps.

## What Diagonal reads

For each normal (not incognito) tab: its title, its address and the page's `<meta name="description">`. In settings you can leave out descriptions, or send only the site name instead of the full address.

## Where it goes

- **To Apple's on-device model on your Mac.** Diagonal passes that text to Apple's `fm` tool through a small helper program on your Mac (the native messaging host installed with `brew install iko-soy/tap/diagonal`). By default the model runs on your Mac and nothing leaves it.
- **To Apple's Private Cloud Compute, only if you choose it.** Settings → Privacy → Model offers Apple's larger server model. With that picked, the same text goes to Apple under Apple's Private Cloud Compute terms. It is off by default.

Diagonal has no server of its own. It sends nothing to its developers and has no analytics. The only other request is the browser loading each archived tab's site icon from that site when you open the popup.

## What it keeps

In the browser's extension storage on your computer: its settings, which tab groups it manages and their titles, and archived tabs (title, address, group) so you can restore them. The helper writes a log of its own errors to `~/Library/Logs/Diagonal` on your Mac. Uninstalling removes the extension's storage; `brew uninstall --zap diagonal` removes the helper's files and logs.

## Sharing

Diagonal does not sell, share or transfer your data to anyone, and does not use it for anything other than grouping and naming your tabs.

## Contact

Open an issue at https://github.com/iko-soy/diagonal/issues.
