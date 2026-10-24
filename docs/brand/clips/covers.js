// Обложки коротких роликов: карточки рисует этот скрипт (covers.html его подключает). Скрипт лежит отдельным файлом,
// потому что политика CSP сайта запрещает встроенные скрипты. Адрес с #export включает режим выгрузки для
// scripts/clip-covers.mjs: карточки 1080 × 1920.
if (location.hash === '#export') document.documentElement.classList.add('export')

// Обложки: номер, рубрика, вопрос первого кадра и строка под ним, как в docs/brand/clips.md, раздел 2.
// small: вопрос мельче, иначе «Койко-место» не помещается в строку и рвётся по дефису.
// crop: участок кадра ролика компании [x, y, ширина, высота] в пикселях 1280 × 720, без вшитых подписей ролика
const covers = [
  { n: '01', rubric: 'Квасыч отвечает', hook: 'Сколько платят на заводе кваса', sub: 'От 56 000 до 70 000 ₽ в месяц до вычета налога, смены по 12 часов', kind: 'red', glyph: '₽' },
  { n: '02', rubric: 'Поймай брак', hook: 'Найди брак за 3 секунды', sub: 'Ответ в конце ролика', img: '../../../public/photos/hero-line-1600.webp', alt: 'Бутылки кваса на линии розлива' },
  { n: '03', rubric: 'Тогда и сейчас', hook: 'Этот завод строили к Олимпиаде-80', sub: 'Комбинат начал работу в 1978 году', kind: 'archive', img: '../../../public/photos/archive-1978-480.webp', alt: 'Архивный кадр комбината' },
  { n: '04', rubric: 'Первый день', hook: 'Что выдают в первый день', sub: 'Спецодежду, обувь и пропуск', img: '../frames/bottling-uniform.webp', crop: [300, 0, 745, 600], alt: 'Новичок надевает рабочую куртку' },
  { n: '05', rubric: 'Квасыч отвечает', hook: 'А если сессия?', sub: 'О зачёте или экзамене скажи руководителю заранее, и смену на это время не поставят', kind: 'red', glyph: '?' },
  { n: '06', rubric: 'Сколько за лето', hook: 'за лето', sub: 'Сумму называет практикант прошлого сезона по своему расчётному листу', kind: 'template', alt: 'Шаблон: кадр героя' },
  { n: '07', rubric: 'Квасыч отвечает', hook: 'Койко-место за 3 400 ₽', sub: 'Общежитие для студентов: ул. Рябиновая, 36, к. 2', kind: 'red', small: true },
  { n: '08', rubric: 'Первый день', hook: 'Лаборант: что делают руками', sub: 'От 60 000 ₽ до вычета налога, смены 2/2 по 12 часов', img: '../frames/lab-quality.webp', crop: [330, 0, 732, 590], alt: 'Лаборант у прибора в лаборатории' },
  { n: '09', rubric: 'Тренд недели', hook: 'POV: первая неделя на заводе кваса', sub: 'Пропуск, форма, наставник, линия', img: '../../../public/photos/line-kvass-1600.webp', alt: 'Банки кваса «Очаковский» на линии' },
  { n: '10', rubric: 'Квасыч отвечает', hook: 'Кто будет учить', sub: 'Наставника прикрепляют к каждому новичку', img: '../frames/bottling-mentor.webp', crop: [420, 130, 732, 590], alt: 'Наставник и новичок у пульта' },
  { n: '11', rubric: 'Тогда и сейчас', hook: 'Что такое квас двойного брожения', sub: '1996 год: впервые в промышленных масштабах', img: '../../../public/photos/brewhall-1600.webp', alt: 'Цех брожения' },
  { n: '12', rubric: 'Наставник и новичок', hook: 'Квас делают люди', sub: 'Наставник у каждого новичка', img: '../frames/bottling-back.webp', crop: [80, 178, 677, 542], alt: 'Надпись «Я делаю натуральные напитки» на спине рабочей куртки' },
]

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// Типографика, как nb() на сайте (src/lib/typo.ts): короткое слово держится за следующим, число за единицей,
// тире не начинает строку. На обложке не остаются «НА / ЗАВОДЕ», «ЗА 3 / СЕКУНДЫ», «ЭТО / КАК»
const NBSP = '\u00a0'
const SHORT = new Set('в во с со к ко у о об и а но да на по за до от из не ни для без под над при про что как это все всё или'.split(' '))
const nb = (s) =>
  s
    .replace(/(\p{L}+) +/gu, (m, w) => (SHORT.has(w.toLowerCase()) ? w + NBSP : m))
    .replace(/(\d) (?=\d{3}(?!\d))/g, `$1${NBSP}`)
    .replace(/(\d) +(?=[%₽\p{L}])/gu, `$1${NBSP}`)
    .replace(/ +([—–])(?= )/g, `${NBSP}$1`)
/** Текст для разметки: экранирование и неразрывные пробелы */
const text = (s) => esc(nb(s))
const BAND_W = 1080
const BAND_H = 870

function band(c) {
  if (c.kind === 'archive')
    return `<div class="band" style="background:#1b1b1b"><div class="year" aria-hidden="true">1978</div><div class="print"><img src="${c.img}" alt="${esc(c.alt)}"></div></div>`
  if (c.kind === 'template')
    return `<div class="band"><div class="placeholder">Кадр героя: практикант прошлого сезона в рабочей куртке у проходной, снято на телефон</div></div>`
  if (c.crop) {
    const [x, y, w] = c.crop
    const s = BAND_W / w
    return `<div class="band"><img class="crop" src="${c.img}" alt="${esc(c.alt)}" style="width:${1280 * s}px;left:${-x * s}px;top:${-y * s}px"></div>`
  }
  return `<div class="band"><img class="fit" src="${c.img}" alt="${esc(c.alt)}"></div>`
}

function cover(c) {
  const red = c.kind === 'red'
  const hook = c.kind === 'template' ? `<span class="sum">сумма ₽</span><br>${text(c.hook)}` : text(c.hook)
  return `
    <div>
      <div class="slot">
        <div class="cover${red ? ' red' : ''}${c.kind === 'archive' ? ' archive' : ''}" data-name="clip-${c.n}">
          ${red ? (c.glyph ? `<div class="glyph" aria-hidden="true">${esc(c.glyph)}</div>` : '') : band(c)}
          <img class="brand" src="../../../public/brand/logo-wordmark-white.svg" alt="ОЧАКОВО">
          <div class="chip">${esc(c.rubric)}</div>
          <div class="text"><div class="bar"></div><div class="hook${c.small ? ' small' : ''}">${hook}</div><div class="sub">${text(c.sub)}</div></div>
          <div class="zones"><i class="top"></i><i class="side"></i><i class="bottom"></i></div>
        </div>
      </div>
      <p><b>${c.n} · ${esc(c.rubric)}.</b> Метка: <code>vk-clip-${c.n}</code>${c.kind === 'template' ? '. Шаблон: сумму и кадр даёт герой' : ''}</p>
    </div>`
}

document.getElementById('covers').innerHTML = covers.map(cover).join('')

// Зоны интерфейса VK Клипов поверх обложек включает флажок над сеткой
document.getElementById('zones').addEventListener('change', (e) => document.body.classList.toggle('show-zones', e.target.checked))
