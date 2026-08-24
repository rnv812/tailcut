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

  // Беззвучное, зациклённое и без панели управления — это баннер, а не видео.
  if (signals.muted && signals.loop && !signals.controls) return 'reject'
  if (signals.muted && !config.recordMuted) return 'reject'

  // Только накопленное время. Пауза уже учтена тем, что на ней playedSeconds
  // не растёт — см. комментарий к VideoSignals.playing.
  if (signals.playedSeconds >= config.gracePeriodSeconds) return 'promote'

  return 'hold'
}
