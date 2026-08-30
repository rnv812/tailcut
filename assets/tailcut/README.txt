TailCut — "Play Cut" logo
Palette: graphite #17181F · acid lime #B7F03F · paper #F6F5F8
Type: Space Grotesk 700 (lockups), JetBrains Mono (technical labels)

icon/   Manifest tiles: graphite, white play symbol, lime tail; 16-512 px
glyph/  Transparent-background variants: dark, light, mono, mono-light, disabled (32%)
svg/    Vector sources: mark, tile, and lockups

Suggested manifest mapping:
  "icons": { "16": "icon/icon-16.png", "32": "icon/icon-32.png",
             "48": "icon/icon-48.png", "128": "icon/icon-128.png" }
  "action": { "default_icon": { "16": "glyph/glyph-mono-16.png",
              "32": "glyph/glyph-dark-32.png" } }

Suggested state convention: a lime tail means the buffer contains segments; an empty buffer is
mono; unavailable is disabled. Sizes from 16-32 px use compact geometry with a wider cut and
larger tail.

README.md:
  <img src="assets/tailcut/svg/lockup-dark.svg" alt="TailCut">
