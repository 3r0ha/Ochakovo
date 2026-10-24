// Типографика: короткие слова, числа с единицами, диапазоны и сокращения не разрываются переносом строки.
// «без / резюме», «57 000– / 89 000 ₽», «HR / перезвонит», «по 12 / часов» — так в конце строки не остаётся.

const NBSP = ' '
/** Невидимый «не переносить здесь» — для диапазонов через тире: 57 000–89 000 */
const WJ = '⁠'
/** Пробелы внутри строки: переводы строк в ответах бота (списки, абзацы) не трогаем */
const SP = '[^\\S\\r\\n]'

// Предлоги, союзы и частицы, которые приклеиваются к следующему слову.
// Без ретроспективной проверки (?<=…): её не понимает Safari до 16.4, и на старых iPhone падал бы весь сайт
const SHORT = new Set('в во с со к ко у о об обо и а но да на по за до от из изо не ни для без под над при про через что как это все всё или'.split(' '))
// Слово и пробел за ним: поиск всегда начинается с начала слова, поэтому цепочки «и в», «а не» склеиваются за один проход
const WORD_SPACE = new RegExp(`(\\p{L}+)${SP}+`, 'gu')
// Телефон: +7 495 785-39-30, 8 (495) 785-39-30, +7 903 153-77-40
const PHONE = /(?:\+7|\b8)[ \u00a0]?\(?\d{3}\)?[ \u00a0]?\d{3}-\d{2}-\d{2}/g
// Частицы, которые приклеиваются к предыдущему слову
const BEFORE_PARTICLE = new RegExp(`${SP}+(же|ли|бы)(?=[\\s.,!?:;»)]|$)`, 'giu')
// Дефис перед окончанием порядкового числа; в начале узла — когда число стоит в соседнем узле: {PAY_DAYS[0]}-го
const ORDINAL = /(^|\d)-(?=(?:го|му|м|й|я|е|х|ю|ми|ой|ая|ое|ые|ых)(?!\p{L}))/gu
// Сокращения перед названием или числом: м. «Озёрная», ул. Рябиновая, д. 44, доб. 1155
const ABBR = new RegExp(`(^|[\\s(«])(м|ул|д|г|пр|пос|стр|корп|доб|тел|им|см|руб|тыс|млн)\\.${SP}+`, 'giu')

export function nb(text: string) {
  if (!text) return text
  return (
    text
      // Телефон целиком на одной строке: +7 495 785-39-30 — пробелы неразрывные, перенос по дефису запрещён
      .replace(PHONE, (m) => m.replace(new RegExp(SP, 'g'), NBSP).replace(/-/g, `${WJ}-${WJ}`))
      // Короткое слово + следующее
      .replace(WORD_SPACE, (m, word: string) => (SHORT.has(word.toLowerCase()) ? word + NBSP : m))
      .replace(BEFORE_PARTICLE, `${NBSP}$1`)
      .replace(ABBR, `$1$2.${NBSP}`)
      // «№ 5», «§ 2»
      .replace(new RegExp(`([№§])${SP}*(?=\\S)`, 'g'), `$1${NBSP}`)
      // Разряды числа: 107 000
      .replace(/(\d)[  ](?=\d{3}(?!\d))/g, `$1${NBSP}`)
      // Число и единица или следующее слово: 12 часов, 13 %, 57 000 ₽, 2 рабочих дня
      .replace(new RegExp(`(\\d)${SP}+(?=[%₽°a-zа-яё$€])`, 'giu'), `$1${NBSP}`)
      // Диапазон через тире: 57 000–89 000, 1–2 курс, 18–26 лет (дефисы в телефонах не трогаем)
      .replace(new RegExp(`(\\d)${SP}*([–—])${SP}*(?=\\d)`, 'g'), `$1${WJ}$2${WJ}`)
      // HR и следующее слово: «HR перезвонит», «HR увидит»
      .replace(new RegExp(`(^|[\\s(«])(HR)${SP}+`, 'g'), `$1$2${NBSP}`)
      // Тире не начинает строку: «слово — слово»
      .replace(new RegExp(`${SP}+([—–])(?=\\s)`, 'g'), `${NBSP}$1`)
      // Стрелки держатся за соседями: «стрелки ← и →» не разваливается на строки
      .replace(new RegExp(`${SP}+([←→↑↓])`, 'g'), `${NBSP}$1`)
      .replace(new RegExp(`([←→↑↓])${SP}+`, 'g'), `$1${NBSP}`)
      // Окончание порядкового числа не уходит на новую строку: «12-го», «27-го», «2-й», «90-х»
      .replace(ORDINAL, `$1-${WJ}`)
      // Разделитель «·» держится за предыдущим словом, как запятая: строка не начинается с точки, перенос — после неё
      .replace(new RegExp(`${SP}+·${SP}+`, 'g'), `${NBSP}· `)
  )
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CODE', 'PRE', 'SVG', 'NOSCRIPT'])

function skip(node: Node) {
  const parent = node.parentElement
  return !parent || SKIP.has(parent.tagName) || Boolean(parent.closest('[contenteditable], [data-no-typo], svg'))
}

function fix(node: Node) {
  const text = node.nodeValue
  if (!text || !/[\s-]/.test(text) || skip(node)) return
  const done = nb(text)
  if (done !== text) node.nodeValue = done
}

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return fix(root)
  const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = it.nextNode(); n; n = it.nextNode()) fix(n)
}

/**
 * Типограф для всего, что рисуется на странице, — в том числе ответов бота в чате и текстов из данных:
 * проходит по тексту один раз и дальше следит за изменениями. nb() идемпотентна, поэтому повторный проход ничего не портит.
 * Возвращает функцию остановки.
 */
export function startTypographer(root: HTMLElement = document.body) {
  walk(root)
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') fix(r.target)
      else r.addedNodes.forEach(walk)
    }
  })
  observer.observe(root, { subtree: true, childList: true, characterData: true })
  return () => observer.disconnect()
}
