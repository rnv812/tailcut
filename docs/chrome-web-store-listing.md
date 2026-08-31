# Chrome Web Store listing

This file is the source of truth for the Chrome Web Store listing and reviewer submission.

## Single purpose

tailcut turns already-buffered web video into a clip that the user can review, trim, and export locally as MP4 or animated WebP. Recording history and editing exist only to support that purpose.

## Store description

Save precise clips from video you have already watched in the current browser. tailcut records media delivered to the page, keeps a configurable local history, and provides a local editor for trimming and exporting MP4 or animated WebP files.

tailcut has no account, cloud backend, analytics, advertising, or telemetry. It refuses DRM-protected media. Users must have the right to record and save the material and must follow the website's terms.

## Prominent data disclosure

Show this disclosure prominently before installation:

> tailcut reads video and audio delivered to players on websites you visit. It also handles the page title, hostname, media URL, playback times, clip names, and recording settings so it can keep a local recording history and export clips. This data is processed locally and stays on your device. It is not sent to the developer, analytics services, advertisers, or a tailcut server. For ordinary video-file players, tailcut may request limited byte ranges from the same media host already serving that video.

The exact public privacy-policy URL submitted with the listing is:

https://github.com/rnv812/tailcut/blob/master/PRIVACY.md

## Permission justifications

- `storage`: stores user settings, recording rules, and session coordination state locally.
- `downloads`: saves the MP4 or animated WebP file selected by the user.
- `scripting`: lets the popup and badge query the current tab and its frames for recording state.
- `alarms`: schedules local history-retention and storage cleanup after the service worker sleeps.
- `<all_urls>`: lets tailcut observe video players across websites and make bounded byte-range requests to the media host already serving an ordinary video file. By default, tailcut observes video players on all sites you visit. Users can disable recording globally, restrict it to an allowlist, deny individual sites, or pause the current tab.

## Reviewer steps

1. Install the submitted extension ZIP or load its unpacked `dist` directory in Chrome.
2. Open and play an ordinary, unprotected video or the repository's fixture-backed video page.
3. Open the toolbar popup and confirm that recording or capture state appears for the current page.
4. Watch part of the video, open the saved recording, then edit and export a short MP4 or animated WebP clip.
5. Open encrypted or DRM-protected media and confirm that it is refused and not recorded.
6. Open Settings to verify global disable, allowlist, deny-list, current-tab pause, retention, and disk-limit controls.

No account, payment, test credential, or backend configuration is required.

## Remote code

All executable code and JavaScript that defines tailcut functionality is included in the submitted package ZIP. tailcut does not download remotely hosted extension logic, modules, or WebAssembly. The extension may make bounded byte-range requests to the same media file the page is already playing; those responses are media bytes, not executable code.

When a website creates a media worker, tailcut's packaged worker shim loads that website's original worker URL so the site's own player continues to work. That script remains page-origin website code, has no extension API access, and does not define or alter tailcut functionality. This behavior is implemented in `src/page/worker-hook.ts` and is disclosed here for reviewer inspection.

## Copyright and authorized use

Users must own the content or have permission or other authorization to record and save the media. tailcut does not grant copyright permission. It does not bypass, circumvent, or decrypt DRM or other protection on encrypted media. Users remain responsible for following each site, website, or platform's terms, rules, and conditions.

tailcut is not affiliated with, endorsed by, or sponsored by YouTube or any other media platform. Site names may be used only to describe compatibility and reviewer steps.

## Donation

Use this exact optional support copy wherever the Donatty link appears:

> Support tailcut with a voluntary donation via Donatty. Donations do not unlock features, licenses, support priority, or any other benefit.

The donation link is optional, opens the hosted Donatty page, and is not a purchase, subscription, or requirement for any extension function.
