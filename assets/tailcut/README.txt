TailCut — логотип «Play Cut»
Палитра: graphite #17181F · acid lime #B7F03F · paper #F6F5F8
Шрифт: Space Grotesk 700 (лок-апы), JetBrains Mono (тех. метки)

icon/        плитка для manifest (графит + белый play + лаймовый хвост), 16-512 px
glyph/       прозрачный фон: dark / light / mono / mono-light / disabled (32%)
svg/         векторные исходники: mark, tile, lockup, promo
promo/       плитки для стора 440x280 и 1400x560 + readme-banner-1280x440.png (@2x, EN, для README.md)
alternates/  отклонённые направления 1a / 1c / 1d в векторе

manifest.json:
  "icons": { "16": "icon/icon-16.png", "32": "icon/icon-32.png",
             "48": "icon/icon-48.png", "128": "icon/icon-128.png" }
  "action": { "default_icon": { "16": "glyph/glyph-mono-16.png",
              "32": "glyph/glyph-dark-32.png" } }

Правило состояний: лайм на хвосте = в буфере есть сегменты; пустой буфер = mono; недоступно = disabled.
На 16-32 px используется компактная геометрия (шире разрез, крупнее хвост).

README.md:
  ![TailCut](assets/tailcut/promo/readme-banner-1280x440.png)
