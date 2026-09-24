# Chrome Web Store listing

Everything the Chrome Web Store developer dashboard asks for, ready to paste. The package is `diagonal-store.zip` from `npm run zip:store` (every release also attaches it).

## Store listing

- **Name:** Diagonal
- **Summary (132 chars max):** Groups your tabs as you browse and names each group with Apple's on-device model. No cloud, nothing to press.
- **Category:** Workflow & Planning
- **Language:** English
- **Description:**

  > Diagonal keeps your tabs in named groups without you doing anything.
  >
  > Open and close tabs as usual. A link you open from a tab joins it in a group. Loose tabs are sorted into matching groups once you stop for a moment. Each group gets a short title with an emoji, written by Apple's on-device model on your Mac. Tabs you haven't touched in a day move to a collapsed Parked group, and you can restore anything Diagonal archived.
  >
  > Your choices win: groups you make yourself are left alone, a title you type is kept, and a tab you pull out of a group stays out.
  >
  > Requirements: a Mac with Apple silicon running macOS 27 with Apple Intelligence on, plus Diagonal's small helper program, installed with: brew install iko-soy/tap/diagonal
  >
  > Private by design: the model runs on your Mac and sees only each tab's title, address and description. Diagonal has no server and no analytics.

- **Icon:** `icons/128.png`
- **Screenshots (1280×800):** `docs/store/screenshot-popup.png`, `docs/store/screenshot-settings.png`
- **Small promo tile (440×280):** `docs/store/promo-small.png`
- **Homepage:** https://github.com/iko-soy/diagonal
- **Support:** https://github.com/iko-soy/diagonal/issues

## Privacy practices

- **Single purpose:** Organizes the browser's tabs into named tab groups.
- **Permission justifications:**
  - `tabs`: reads tab titles and addresses to decide which tabs belong together and to name groups.
  - `tabGroups`: creates, names, collapses and removes the tab groups it manages.
  - `storage`: keeps settings, which groups it manages, and archived tabs, on this computer.
  - `alarms`: waits for tabs to settle before grouping, and runs the idle-tab tidy on a schedule.
  - `nativeMessaging`: talks to Diagonal's helper on the Mac, which runs Apple's on-device model.
  - `scripting`: reads the meta description of tabs that were already open when Diagonal was installed.
  - Host permissions `http://*/*`, `https://*/*`: the content script reads each page's meta description, which helps the model name groups.
- **Remote code:** No, it does not use remote code.
- **Data usage:** collects "Web history" (tab titles and addresses) and "Website content" (page descriptions). Check the three certifications: not sold to third parties, not used for unrelated purposes, not used for creditworthiness or lending.
- **Privacy policy URL:** https://github.com/iko-soy/diagonal/blob/master/PRIVACY.md

## Distribution

- **Visibility:** Public (or Unlisted to share by link only)
- **Regions:** All

## After the first upload

The store gives the listing its own extension ID. Put it in `STORE_ORIGIN` in `host/diagonal-host.py` as `chrome-extension://<id>/` so the helper accepts the store install, and set these repository secrets so every release uploads itself: `CWS_EXTENSION_ID`, `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` (see Google's guide, "Use the Chrome Web Store API").
