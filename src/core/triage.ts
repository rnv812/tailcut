export interface VideoSignals {
  /** ширина элемента на экране в CSS-пикселях */
  widthPx: number
  muted: boolean
  loop: boolean
  controls: boolean
  /** элемент в видимой области и вкладка не скрыта */
  visible: boolean
  /**
   * Видео воспроизводится прямо сейчас.
   *
   * `triage` это поле сознательно не читает, и это не упущение. По §5.5 спеки
   * пауза замораживает накопление времени, а не вердикт: наблюдатель
   * (`src/page/watcher.ts`) начисляет `playedSeconds` только пока видео играет
   * и видно, поэтому на паузе счётчик просто перестаёт расти. Если бы вердикт
   * зависел ещё и от `playing`, пауза после порога отзывала бы уже заработанное
   * повышение и убивала живую сессию, а пауза до порога отменяла бы мгновенный
   * отказ, который по §5.4 должен срабатывать всегда.
   *
   * Поле живёт в сигналах, потому что его читает наблюдатель: он собирает
   * `VideoSignals` целиком и по этому же полю решает, начислять ли время.
   */
  playing: boolean
  /** сколько секунд элемент реально воспроизводился */
  playedSeconds: number
  /**
   * Something else on this page is playing the sound for this element.
   *
   * The one signal here that is not about the element itself, and it is here because the banner
   * rule below cannot be right without it. That rule reads "muted, looping, no controls" as
   * decoration, and it is correct about nearly everything on the web — but it is exactly the
   * shape of one half of a work whose other half is an `<audio>` playing beside it (§5.6): a
   * short silent loop of picture under a long soundtrack, which is what one site of the seven
   * surveyed is made of. Such a picture is not silent at all; the sound is simply in another
   * element, and the page is playing it.
   *
   * It says nothing about width or watching, and it removes none of the other refusals: a
   * looping silent picture on a page with music behind it still has to be a real player of a real
   * size, watched through the whole grace period, before anything is kept of it.
   */
  soundApart: boolean
  /**
   * К элементу присоединён CDM: страница вызвала `setMediaKeys` с настоящими ключами.
   *
   * Признак адресный — про этот элемент и ничего больше. Отказ по всей странице выносится не
   * здесь: защита — свойство материала, и находят её в самих байтах (`src/core/container.ts`) или
   * слышат от элемента событием `encrypted` (`src/page/watcher.ts`). Оба сильнее вердикта и
   * стирают всю страницу целиком.
   *
   * Вопрос страницы браузеру о системе ключей сюда не входит вовсе: на статье edition.cnn.com
   * замерены шестнадцать таких зондов над потоком, который шёл в открытую, — намерение спросить
   * не делает материал защищённым. А вот присоединённый к элементу CDM — это уже приготовление
   * играть защищённое именно здесь, и писать такой элемент незачем.
   */
  hasDrm: boolean
}

export interface TriageConfig {
  gracePeriodSeconds: number
  minWidthPx: number
  recordMuted: boolean
}

export const BALANCED: TriageConfig = {
  gracePeriodSeconds: 6,
  minWidthPx: 320,
  recordMuted: true,
}

export const LOOSE: TriageConfig = {
  gracePeriodSeconds: 3,
  minWidthPx: 200,
  recordMuted: true,
}

export const STRICT: TriageConfig = {
  gracePeriodSeconds: 12,
  minWidthPx: 480,
  recordMuted: false,
}

export type TriageVerdict = 'reject' | 'hold' | 'promote'

export function triage(signals: VideoSignals, config: TriageConfig): TriageVerdict {
  if (signals.hasDrm) return 'reject'
  // NaN означает, что ширину ещё не измерили: элемент не попал в раскладку и
  // getBoundingClientRect отдал не число. Неподтверждённый минимум — это отказ,
  // иначе неизмеренный элемент проскочил бы фильтр ширины целиком. Сравнение
  // идёт с дробным значением как есть: 319.6 пикселя ниже порога в 320.
  if (Number.isNaN(signals.widthPx) || signals.widthPx < config.minWidthPx) return 'reject'
  if (!signals.visible) return 'reject'

  // Беззвучное, зациклённое и без панели управления — это баннер, а не видео. Если только звук
  // не играет рядом: тогда беззвучность элемента — это не отсутствие звука на странице, а
  // разделение картинки и звука по двум элементам, и перед нами половина работы, а не украшение.
  if (signals.muted && signals.loop && !signals.controls && !signals.soundApart) return 'reject'
  if (signals.muted && !config.recordMuted) return 'reject'

  // Только накопленное время. Пауза уже учтена тем, что на ней playedSeconds
  // не растёт — см. комментарий к VideoSignals.playing.
  if (signals.playedSeconds >= config.gracePeriodSeconds) return 'promote'

  return 'hold'
}
