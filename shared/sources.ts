import { contacts } from './content/content'
import { dorm, PAY_DAYS } from './content/handbook'
import { NIGHT_PAY_NOTE, paidPractice, SHIFT_HOURS_2_2 } from './content/vacancies'

// Реестр меток источников: типы точек контакта, проверка метки и расхода, ссылки для QR. Общее для сервера и панели.
//
// Метка — короткий код в ссылке ?src= и в ?start= ботов: fair-misis, tour-mgupp, edu-kolledzh-1. Кандидат приходит
// по QR с листовки или плаката, метка запоминается в заявке, а HR в «Воронке», карточке и списке видит название
// из реестра: «Ярмарка МИСИС». Так экскурсии, музей, инженерные классы, вузы, ярмарки, работные сайты, соцсети
// и приглашения друзей сходятся в одну воронку — это и есть единая система, которой, по кейсу, сейчас нет.

// ── Типы точек контакта ───────────────────────────────────────────────────────

export type SourceKindId = 'excursion' | 'museum' | 'eng_class' | 'school' | 'fair' | 'job_board' | 'social' | 'friend' | 'own' | 'other'

export type SourceKind = {
  id: SourceKindId
  label: string
  /** Начало метки по умолчанию: fair-, tour-, edu- … */
  prefix: string
  /** Подсказка в форме: что это за точка и что по ней важно знать */
  hint: string
  /** Слова, которые в названии повторяют сам тип: из метки их убираем, «Ярмарка МИСИС» → fair-misis */
  words: string[]
}

/**
 * Типы — по точкам контакта из концепции бренда (docs/brand/concept.md, раздел 10) и инициативам компании из кейса:
 * экскурсии на производство, музей, инженерные классы, вузы и колледжи, ярмарки, работные сайты, соцсети, друзья.
 * «Свои каналы» — сайт, боты и отдел персонала без внешней точки
 */
export const sourceKinds: SourceKind[] = [
  { id: 'excursion', label: 'Экскурсия на производство', prefix: 'tour-', hint: 'Листовка A5 после экскурсии.', words: ['экскурсия', 'экскурсии', 'на', 'производство', 'завод'] },
  { id: 'museum', label: 'Музей', prefix: 'museum-', hint: 'Листовка у выхода из музея.', words: ['музей', 'музея'] },
  {
    id: 'eng_class',
    label: 'Инженерный класс',
    prefix: 'class-',
    hint: 'Знакомство с заводом. Заявки на работу и практику принимают только с 18 лет.',
    words: ['инженерный', 'инженерного', 'инженерные', 'класс', 'класса', 'классы', 'школа', 'школы', 'гбоу'],
  },
  { id: 'school', label: 'Вуз или колледж', prefix: 'edu-', hint: 'Центр карьеры, кафедра, договор о практике.', words: [] },
  { id: 'fair', label: 'Ярмарка вакансий', prefix: 'fair-', hint: 'Плакат A3 на стенд и листовки A5.', words: ['ярмарка', 'ярмарки', 'вакансий', 'карьеры', 'день'] },
  { id: 'job_board', label: 'hh.ru и работные сайты', prefix: 'job-', hint: 'Ссылка в тексте вакансии.', words: ['вакансия', 'вакансии'] },
  {
    id: 'social',
    label: 'Соцсети и каналы',
    prefix: 'vk-',
    hint: 'Пост или реклама: vk- для ВКонтакте, tg- для Telegram, max- для MAX.',
    words: ['вконтакте', 'вк', 'vk', 'telegram', 'телеграм', 'телеграмм', 'tg', 'max', 'макс', 'канал', 'группа', 'пост', 'реклама'],
  },
  { id: 'friend', label: 'Друг или амбассадор', prefix: 'amb-', hint: 'Студент-амбассадор раздаёт свою ссылку.', words: ['амбассадор', 'друг'] },
  { id: 'own', label: 'Сайт, боты и отдел персонала', prefix: '', hint: 'Свои каналы без внешней точки.', words: [] },
  { id: 'other', label: 'Другое', prefix: '', hint: 'Всё, что не подходит выше.', words: [] },
]

export const sourceKindIds = sourceKinds.map((k) => k.id)

export const isSourceKind = (v: unknown): v is SourceKindId => typeof v === 'string' && (sourceKindIds as string[]).includes(v)

export const sourceKindLabel = (id: string) => sourceKinds.find((k) => k.id === id)?.label ?? 'Другое'

// ── Записи реестра ────────────────────────────────────────────────────────────

export type SourceEntry = {
  code: string
  name: string
  kind: SourceKindId
  note: string
  /** Метка из словаря кода (сайт, боты, ручные источники): её нельзя удалить */
  builtin: boolean
  createdAt: string
  updatedAt: string
  updatedBy: string
  /** Заявок с этой меткой за всё время, без дублей */
  applications: number
}

/** Метка, которая встречается в заявках и визитах, но в реестре её нет */
export type UnknownSource = {
  code: string
  /** Как её сейчас подписывает панель без реестра: «Ярмарка · misis» или сам код */
  guess: string
  applications: number
  /** Посетителей сайта и людей в ботах с этой меткой */
  visitors: number
  lastSeen: string
}

export type SourceCost = {
  id: number
  code: string
  amount: number
  comment: string
  /** Срок, дни по Москве включительно, YYYY-MM-DD; null — без срока */
  from: string | null
  to: string | null
  createdAt: string
  authorName: string
  demo: boolean
}

/** Адрес сайта и имена ботов — из них собираются ссылки и QR */
export type SourcesSite = {
  url: string
  bots: { telegram: string | null; max: string | null }
  /** Бот сейчас поднят на сервере: ссылку на неподнятого бота стоит проверить перед печатью */
  active: { telegram: boolean; max: boolean }
}

/** Ответ GET /api/hr/sources */
export type SourcesPayload = {
  sources: SourceEntry[]
  unknown: UnknownSource[]
  costs: SourceCost[]
  site: SourcesSite
  /** Править реестр и расходы может только администратор */
  canEdit: boolean
}

export type SourceDraft = { code: string; name: string; kind: SourceKindId; note: string }

export type CostDraft = { code: string; amount: number; comment: string; from: string | null; to: string | null }

// ── Метка ─────────────────────────────────────────────────────────────────────

export const SOURCE_CODE_MAX = 40
export const SOURCE_NAME_MAX = 80
export const SOURCE_NOTE_MAX = 300
export const COST_COMMENT_MAX = 200
export const COST_MAX = 100_000_000

/** Новая метка: строчная латиница, цифры и дефис, без дефиса в начале и в конце, до 40 знаков */
export const SOURCE_CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

/**
 * Занятые метки. friend-<код> и старые friend, share — приглашения друзей: такая метка спутала бы приглашения
 * в «Воронке». remind и remind-<метка> — подписка «Напомнить о наборе» в боте: /start remind… бот поймёт иначе
 */
export function isReservedSourceCode(code: string): boolean {
  return code === 'friend' || code === 'share' || code === 'remind' || code.startsWith('friend-') || code.startsWith('remind-')
}

const translit: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya',
}

/** Кириллица латиницей, как в адресах: «Мосполитех» → mospolitekh */
export const transliterate = (s: string) => [...s.toLowerCase()].map((c) => translit[c] ?? c).join('')

/** К виду метки: строчные, латиница, пробелы и знаки — в дефис, без дефисов по краям, до 40 знаков */
export function normalizeSourceCode(raw: string): string {
  return transliterate(raw.trim())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SOURCE_CODE_MAX)
    .replace(/-+$/, '')
}

/** Короткие слова, которые в метке не нужны */
const stopWords = new Set(['в', 'во', 'на', 'для', 'и', 'по', 'из', 'от', 'с', 'со', 'у', 'к', 'при', 'им', 'имени'])

/** Сеть по названию: для соцсетей метка начинается с vk-, tg- или max- — так её узнаёт и панель без реестра */
function socialPrefix(name: string): string {
  const n = name.toLowerCase()
  // \b в JS не видит границ кириллических слов — граница слова вручную
  const word = (w: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${w}([^\\p{L}\\p{N}]|$)`, 'u').test(n)
  if (/telegram|телеграм/.test(n) || word('tg')) return 'tg-'
  if (word('max') || word('макс')) return 'max-'
  return 'vk-'
}

/**
 * Метка по типу и названию: «Ярмарка МИСИС» → fair-misis, «Экскурсия МГУПП, весна» → tour-mgupp-vesna.
 * Слова, которые повторяют тип, и короткие предлоги убираем. Длинное название режем по целому слову
 */
export function suggestSourceCode(kind: SourceKindId, name: string): string {
  const meta = sourceKinds.find((k) => k.id === kind)
  const prefix = kind === 'social' ? socialPrefix(name) : (meta?.prefix ?? '')
  const skip = new Set(meta?.words ?? [])
  const words = name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !stopWords.has(w) && !skip.has(w))
  let code = prefix.replace(/-$/, '')
  for (const w of words.map((x) => normalizeSourceCode(x)).filter(Boolean)) {
    const next = code ? `${code}-${w}` : w
    if (next.length > SOURCE_CODE_MAX) break
    code = next
  }
  return code === prefix.replace(/-$/, '') && prefix ? '' : code
}

/** Что не так с меткой; null — подходит. Дубли проверяет сервер: он знает реестр */
export function sourceCodeProblem(code: string): string | null {
  if (!code) return 'Нужна метка: латиница, цифры и дефис'
  if (code.length > SOURCE_CODE_MAX) return `Метка длиннее ${SOURCE_CODE_MAX} знаков`
  if (!SOURCE_CODE_RE.test(code)) return 'Только строчная латиница, цифры и дефис, без дефиса в начале и в конце'
  if (isReservedSourceCode(code)) return 'Так подписаны приглашения друзей и напоминания бота. Выбери другую метку'
  return null
}

export type SourceCheck = { value: SourceDraft; errors: Partial<Record<keyof SourceDraft, string>> }

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** Новая метка или правка: обрезка пробелов, проверка полей. codeLocked — метку не проверяем (правка или встроенная) */
export function checkSource(raw: Partial<Record<keyof SourceDraft, unknown>>, opts: { codeLocked?: boolean } = {}): SourceCheck {
  const value: SourceDraft = {
    code: str(raw.code).trim(),
    name: str(raw.name).trim().replace(/\s+/g, ' '),
    kind: isSourceKind(raw.kind) ? raw.kind : 'other',
    note: str(raw.note).trim(),
  }
  const errors: SourceCheck['errors'] = {}
  if (!opts.codeLocked) {
    const problem = sourceCodeProblem(value.code)
    if (problem) errors.code = problem
  }
  if (!value.name) errors.name = 'Нужно название: так метку увидят в «Воронке» и карточке'
  else if (value.name.length > SOURCE_NAME_MAX) errors.name = `Название длиннее ${SOURCE_NAME_MAX} знаков`
  if (raw.kind !== undefined && !isSourceKind(raw.kind)) errors.kind = 'Выбери тип из списка'
  if (value.note.length > SOURCE_NOTE_MAX) errors.note = `Заметка длиннее ${SOURCE_NOTE_MAX} знаков`
  return { value, errors }
}

// ── Расход ────────────────────────────────────────────────────────────────────

/** «15 000», «15000 ₽», «15 000 руб.» → 15000; не число — NaN */
export function parseRubles(raw: unknown): number {
  if (typeof raw === 'number') return raw
  const s = str(raw)
    .replace(/[\s  ]/g, '')
    .replace(/(₽|руб\.?|р\.?)$/i, '')
  return /^\d+$/.test(s) ? Number(s) : Number.NaN
}

/** День: YYYY-MM-DD из поля даты или ДД.ММ.ГГГГ руками → YYYY-MM-DD; невозможный день — null */
export function parseDay(raw: unknown): string | null {
  const s = str(raw).trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  let y: number, mo: number, d: number
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  else {
    m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s)
    if (!m) return null
    ;[d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  }
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export type CostCheck = { value: CostDraft; errors: Partial<Record<'code' | 'amount' | 'comment' | 'from' | 'to', string>> }

/** Расход: сумма в рублях целиком, комментарий, необязательный срок «с — по» (можно только одну границу) */
export function checkCost(raw: Partial<Record<'code' | 'amount' | 'comment' | 'from' | 'to', unknown>>): CostCheck {
  const amount = parseRubles(raw.amount)
  const fromRaw = str(raw.from).trim()
  const toRaw = str(raw.to).trim()
  const value: CostDraft = {
    code: str(raw.code).trim(),
    amount: Number.isInteger(amount) ? amount : 0,
    comment: str(raw.comment).trim().replace(/\s+/g, ' '),
    from: fromRaw ? parseDay(fromRaw) : null,
    to: toRaw ? parseDay(toRaw) : null,
  }
  const errors: CostCheck['errors'] = {}
  if (!value.code) errors.code = 'Выбери метку'
  if (!Number.isInteger(amount) || amount <= 0) errors.amount = 'Сумма в рублях целым числом, например 15 000'
  else if (amount > COST_MAX) errors.amount = 'Слишком большая сумма, проверь нули'
  if (value.comment.length > COST_COMMENT_MAX) errors.comment = `Комментарий длиннее ${COST_COMMENT_MAX} знаков`
  if (fromRaw && !value.from) errors.from = 'Дата в виде ДД.ММ.ГГГГ'
  if (toRaw && !value.to) errors.to = 'Дата в виде ДД.ММ.ГГГГ'
  if (value.from && value.to && value.from > value.to) errors.to = 'Конец срока раньше начала'
  return { value, errors }
}

/** YYYY-MM-DD → ДД.ММ.ГГГГ */
export const dayLabel = (day: string) => day.split('-').reverse().join('.')

/** Срок расхода словами: «без срока», «с 03.03.ГГГГ», «по 15.03.ГГГГ», «03.03.ГГГГ — 15.03.ГГГГ» */
export function costPeriodLabel(c: Pick<SourceCost, 'from' | 'to'>): string {
  if (c.from && c.to) return c.from === c.to ? dayLabel(c.from) : `${dayLabel(c.from)}–${dayLabel(c.to)}`
  if (c.from) return `с ${dayLabel(c.from)}`
  if (c.to) return `по ${dayLabel(c.to)}`
  return 'без срока'
}

// ── Ссылки ───────────────────────────────────────────────────────────────────

export type SourceLinks = {
  /** Сайт с меткой: QR на листовках и плакатах ведёт сюда */
  site: string
  /** Боты — только если имя бота известно; без имени ссылки нет, заглушек не ставим */
  telegram: string | null
  max: string | null
}

/** Адрес сайта без «/» в конце */
export const siteBase = (url: string) => url.trim().replace(/\/+$/, '')

export function sourceLinks(code: string, site: Pick<SourcesSite, 'url' | 'bots'>): SourceLinks {
  const src = encodeURIComponent(code)
  return {
    site: `${siteBase(site.url)}/?src=${src}`,
    telegram: site.bots.telegram ? `https://t.me/${site.bots.telegram}?start=${src}` : null,
    max: site.bots.max ? `https://max.ru/${site.bots.max}?start=${src}` : null,
  }
}

/** Ссылка для подписи под QR: без https:// — так короче и её можно набрать руками */
export const shortLink = (url: string) => url.replace(/^https?:\/\//, '')

// ── Сводка по типам ──────────────────────────────────────────────────────────

export type KindSummary = { kind: SourceKind; codes: number; applications: number; cost: number }

/** Сводка «тип точки → меток, заявок, расход за всё время»: в каком порядке типы в sourceKinds, без пустых */
export function summarizeKinds(sources: SourceEntry[], costs: SourceCost[]): KindSummary[] {
  const byCode = new Map(sources.map((s) => [s.code, s.kind]))
  return sourceKinds
    .map((kind) => {
      const list = sources.filter((s) => s.kind === kind.id)
      const cost = costs.filter((c) => byCode.get(c.code) === kind.id).reduce((sum, c) => sum + c.amount, 0)
      return { kind, codes: list.length, applications: list.reduce((sum, s) => sum + s.applications, 0), cost }
    })
    .filter((k) => k.codes > 0)
}

/** Тип по приставке метки — для «Дать название» у незнакомой метки: fair-… → ярмарка, tour-… → экскурсия */
export function kindByCode(code: string): SourceKindId {
  const byPrefix = sourceKinds.find((k) => k.prefix && code.startsWith(k.prefix) && code.length > k.prefix.length)
  if (byPrefix) return byPrefix.id
  if (/^(tg|max)-./.test(code)) return 'social'
  return 'other'
}

// ── Плакат A3 и листовка A5: факты из shared/content, чтобы цифры на печати совпадали с сайтом ──────────────

/** Пиктограмма отдела из брендбука (public/brand/pictograms): для склада в наборе её нет */
const unitPictograms: Record<string, string> = {
  Лаборатория: '/brand/pictograms/control.svg',
  'Цех розлива': '/brand/pictograms/pet-bottle.svg',
  'Технологический цех': '/brand/pictograms/kettle.svg',
}

/** Что делает роль — одной строкой для листовки, по «Описанию практики»; у новых ролей — первые задачи */
const roleDuties: Record<string, string> = {
  'lab-chemist': 'Анализы и контроль качества',
  'bottling-operator': 'Этикетировщик, упаковка, выдувная машина, паллетайзер',
  'fermentation-assistant': 'Цех варки, сырьё: сахар, сироп',
  'warehouse-operator': 'Программа, документы, накладные',
  storekeeper: 'Накладные, комплектовщики',
}

/** Порядок отделов на листовке: лаборатория, розлив, технологический цех, склад */
const unitOrder = ['Лаборатория', 'Цех розлива', 'Технологический цех', 'Складской комплекс']

export type PrintRole = {
  id: string
  unit: string
  title: string
  what: string
  /** «от 60 000 ₽» */
  pay: string
  /** «с ночными больше», «ориентир» */
  note: string
  picto: string | null
}

const rubles = (n: number) => `${n.toLocaleString('ru-RU').replace(/\s/g, ' ')} ₽`

/** Оплачиваемая практика для плаката и листовки: вилка, отделы, срок, роли, что даёт компания, шаги, контакты */
export function practicePrint() {
  const paid = [...paidPractice].sort((a, b) => unitOrder.indexOf(a.unit ?? '') - unitOrder.indexOf(b.unit ?? ''))
  const pays = paid.flatMap((v) => (v.pay ? [v.pay.from] : []))
  const estimate = paid.some((v) => v.pay?.estimate)
  const units = [...new Set(paid.map((v) => v.unit).filter((u): u is string => Boolean(u)))]
  const roles: PrintRole[] = paid.map((v) => ({
    id: v.id,
    unit: v.unit ?? '',
    title: v.title,
    what: roleDuties[v.id] ?? v.tasks.slice(0, 2).join(', '),
    pay: v.pay ? `от ${rubles(v.pay.from)}` : 'по итогам собеседования',
    note: [v.pay?.estimate ? 'ориентир' : '', v.payNote === NIGHT_PAY_NOTE ? 'с ночными больше' : (v.payNote ?? '')].filter(Boolean).join(', '),
    picto: unitPictograms[v.unit ?? ''] ?? null,
  }))
  return {
    /** «от 56 000 до 70 000 ₽» */
    range: `от ${rubles(Math.min(...pays)).replace(/ ₽$/, '')} до ${rubles(Math.max(...pays))}`,
    min: Math.min(...pays),
    max: Math.max(...pays),
    /** Ориентир, а не сумма из «Описания практики»: тогда рядом пишем «ориентир» */
    estimate,
    per: `в месяц до вычета налога${estimate ? ', ориентир' : ''}`,
    /** «Лаборатория, цех розлива, технологический цех, склад» */
    units: units.map((u, i) => (u === 'Складской комплекс' ? 'склад' : i ? u.toLowerCase() : u)).join(', '),
    /** «С начала марта или апреля до конца июля или середины августа» — «Описание практики» */
    period: 'С начала марта или апреля до конца июля или середины августа',
    roles,
    footnote: `Суммы в месяц до вычета налога. Смены по ${SHIFT_HOURS_2_2} часов: 8:00–20:00 и 20:00–8:00, график составляет руководитель.`,
    gives: [
      'Наставник у каждого новичка, его учили в Учебном центре',
      'Без испытательного срока: вместо него практика',
      'Срочный договор по ТК РФ, потом можно перейти на постоянную работу',
      `Койко-место в общежитии для студентов за ${rubles(dorm.priceStudent)}`,
      'Половину стоимости обеда платит компания',
      'Спецодежда и медосмотр за счёт компании',
      `Зарплата ${PAY_DAYS[0]}-го и ${PAY_DAYS[1]}-го`,
      'Об экзамене скажи заранее, и смену не поставят',
    ],
    steps: [
      'Наведи камеру на QR',
      'Заявка займёт около 2 минут: ФИО, дата рождения, телефон, вакансия, когда можешь выйти, вуз или колледж',
      'HR позвонит и пригласит на собеседование',
    ],
    phone: `Отдел подбора: ${contacts.phone}, ${contacts.phoneNote.split(',')[0]}`,
    address: contacts.address,
    street: contacts.address.replace(/^Москва,\s*/, ''),
    shuttle: contacts.shuttle,
    route: contacts.route,
  }
}

export type PracticePrint = ReturnType<typeof practicePrint>
