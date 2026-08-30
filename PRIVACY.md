# Privacy Policy

tailcut is designed to work locally. It has no account system, analytics, telemetry, advertising, or remote backend. The extension does not sell or share user data.

## Data tailcut handles

tailcut can access video and audio data that a web player receives while you watch it. It also handles the page title, hostname, media URL, playback times, transient editor preview frames, clip names, and the settings needed to record and export that material.

This data is used only to provide the extension's capture, history, editing, and export features.

## Local storage

Settings are stored with `chrome.storage.local`. Recording metadata is stored in IndexedDB. Buffered media pieces and editor snapshots are stored in the extension's Origin Private File System. Preview frames are kept in memory while the editor uses them. Finished clips are written to the Downloads location selected by Chrome.

Recorded material stays on the device. Retention and disk limits are configurable, and recordings can be deleted from tailcut. Removing the extension also removes its extension-owned local storage according to Chrome's behavior.

## Network access

tailcut does not send captured media, browsing activity, or settings to the developer or to an analytics service.

For an ordinary `<video src>` file, tailcut may make bounded byte-range requests to the same media URL that the page is already playing. These requests let it read the file index and the media ranges needed for the interval held by the player. The browser may attach credentials it already has for that host. tailcut does not read, store, or transmit those credentials separately.

MediaSource capture does not start a second download of the stream. It copies media bytes already delivered to the page's player.

## Permissions

- `storage` keeps settings and coordinates extension state.
- `downloads` saves completed clips.
- `activeTab` and `scripting` connect popup actions to the current page and its frames.
- `alarms` schedules retention and storage cleanup.
- `<all_urls>` lets tailcut observe players across sites and perform cross-origin range reads to the media host already serving an ordinary video file.

Recording can be disabled globally, limited to an allowlist, denied for selected sites, or paused for the current tab.

## Third parties

tailcut does not include third-party analytics or advertising SDKs. Websites and media hosts remain subject to their own privacy policies when the browser loads their pages and media.

## Changes and contact

Material changes to this policy will be recorded in this repository. Questions and privacy reports can be filed through [GitHub Issues](https://github.com/rnv812/tailcut/issues).
