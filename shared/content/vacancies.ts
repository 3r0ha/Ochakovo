import type { DepartmentId } from './departments'

// Вакансии: сначала оплачиваемая практика, потом бесплатная практика по договорённости, потом работа с суммой с hh.ru.
//
// Оплачиваемая практика — по «Описанию практики» «Очаково» (archive/case-materials/Описание практики.docx):
// «На оплачиваемую практику мы берем в 4 отдела: лаборатория, в цех розлива напитков, в технологический цех и складской
// комплекс». Пять ролей, суммы «до вычета налога», графики и обязанности — оттуда же, цитата у каждой роли.
// Бесплатная практика — тот же документ: «Возможно прохождение в разных отделах по договоренности», задачи дословно.
// Разбивка задач бесплатной практики по отделам — наша, чтобы подбор работы и HR видели направление.
// Работа — живые вакансии «Очаково» в Москве на hh.ru (работодатель 871), ссылка и цитата у каждой суммы.
// Выдуманных сумм-ориентиров нет: у бесплатной практики суммы нет вовсе.
//
// id старых вакансий сохранены там, где роль та же по смыслу, — по ним живут заявки в базе, ссылки ?vacancy= и кнопки бота.

export type VacancyFormat =
  | 'Оплачиваемая практика'
  | 'Бесплатная практика'
  | 'Постоянная работа'
  /** Старые форматы: встречаются только в сохранённых заявках, новых вакансий с ними нет */
  | 'Сезонная работа'
  | 'Стажировка'

/** Форматы, которые есть у вакансий сейчас, — в порядке показа */
export const vacancyFormats: VacancyFormat[] = ['Оплачиваемая практика', 'Бесплатная практика', 'Постоянная работа']

export type Vacancy = {
  id: string
  title: string
  department: DepartmentId
  /** Отдел так, как его называет компания: «Цех розлива», «Складской комплекс» */
  unit?: string
  format: VacancyFormat
  schedule: string
  /** Часы смен: «С 8:00 до 20:00 или с 20:00 до 8:00» */
  hours?: string
  /** Бывают ночные смены. Без поля — по строке графика (вакансии из редактора) */
  nights?: boolean
  period: string
  tasks: string[]
  requirements: string
  /** «Срочный набор». Ставится, только если у суммы есть источник и компания сама назвала набор срочным */
  hot?: boolean
  /** Зарплата в месяц до вычета НДФЛ, ₽. estimate — ориентир: в данных сейчас таких нет, поле — для редактора вакансий */
  pay?: { from: number; to?: number; estimate?: boolean }
  /** Пометка к сумме: «с ночными сменами больше» */
  payNote?: string
}

/** Срок оплачиваемой практики. «Описание практики»: «Длится с начала марта (начала апреля) до конца июля (середины августа)» */
export const PRACTICE_PERIOD = 'С марта или апреля до июля или середины августа'
/** Срок бесплатной практики: «Возможно прохождение в разных отделах по договоренности» */
export const FREE_PRACTICE_PERIOD = 'Срок по договорённости'
/** График бесплатной практики — тоже по договорённости */
export const FREE_PRACTICE_SCHEDULE = 'По договорённости'
/** Пометка у сумм лаборанта и склада: «(с ночью больше)» */
export const NIGHT_PAY_NOTE = 'с ночными сменами больше'

/** «2/2 дневные смены с 8.00 до 20.00, или 2/2 с ночными сменами (день-ночь-отсыпной-выходной), смены с 8.00 до 20.00 и с 20.00 до 8.00» */
const TWO_BY_TWO_OR_NIGHTS = '2/2 по 12 часов, только дневные или день-ночь-отсыпной-выходной'
const DAY_AND_NIGHT_HOURS = 'Днём с 8:00 до 20:00, ночью с 20:00 до 8:00'
const PRACTICE_START = 'Студенты колледжей и вузов с 18 лет, без опыта, на старте учит наставник'

/**
 * Все вакансии из данных компании — и те, что администратор закрыл в панели. По ним HR и «Моя заявка» видят название
 * вакансии у старых заявок. Объекты общие с vacancies: правка суммы в панели меняет их на месте (applyVacancyOverrides)
 */
export const allVacancies: Vacancy[] = [
  // ── Оплачиваемая практика: 5 ролей в 4 отделах ─────────────────────────────────
  {
    id: 'bottling-operator',
    title: 'Оператор линии розлива',
    department: 'production',
    unit: 'Цех розлива',
    format: 'Оплачиваемая практика',
    // «Оператор: работа на линии розлива, на машинах (этикетке, упаковке, выдувная, паллет и т.д), замена комплектующих,
    // от 70 000 р до вычета налога, график сменный с ночными и дневными сменами с 8.00 до 20.00 или с 20.00 до 8.00»
    schedule: 'Дневные и ночные смены по 12 часов',
    hours: 'С 8:00 до 20:00 или с 20:00 до 8:00',
    nights: true,
    period: PRACTICE_PERIOD,
    tasks: ['Работа на линии розлива', 'Машины линии: этикетировочная, упаковочная, выдувная, паллетайзер', 'Замена комплектующих'],
    requirements: PRACTICE_START,
    pay: { from: 70000 },
  },
  {
    id: 'fermentation-assistant',
    title: 'Оператор технологического цеха',
    department: 'production',
    unit: 'Технологический цех',
    format: 'Оплачиваемая практика',
    // «Оператор: работа в цехе варки, работа с сырьем (сахар, сироп, все, что используем для производства напитков),
    // от 70 000 р до вычета налога, график сменный 2/2 (день-ночь-отсыпной-выходной) смены с 8.00 до 20.00 или с 20.00 до 8.00»
    schedule: '2/2 по 12 часов, день-ночь-отсыпной-выходной',
    hours: 'С 8:00 до 20:00 или с 20:00 до 8:00',
    nights: true,
    period: PRACTICE_PERIOD,
    tasks: ['Работа в цехе варки', 'Работа с сырьём: сахар, сироп и всё, из чего делают напитки'],
    requirements: `${PRACTICE_START}. Подходит будущим технологам пищевого производства`,
    pay: { from: 70000 },
  },
  {
    id: 'lab-chemist',
    title: 'Лаборант',
    department: 'quality',
    unit: 'Лаборатория',
    format: 'Оплачиваемая практика',
    // «Лаборантов: от 60 000 р до вычета налога (с ночью больше), график работы 2/2 дневные смены с 8.00 до 20.00,
    // или 2/2 с ночными сменами (день-ночь-отсыпной-выходной), смены с 8.00 до 20.00 и с 20.00 до 8.00».
    // Обязанности в «Описании практики» не расписаны — задачи по ролику «Химик-лаборант» (archive/case-materials/video):
    // подписи в кадре «Выполняй органолептические анализы», «Проверяй качество»
    schedule: TWO_BY_TWO_OR_NIGHTS,
    hours: DAY_AND_NIGHT_HOURS,
    nights: true,
    period: PRACTICE_PERIOD,
    tasks: ['Органолептические анализы', 'Проверка качества сырья и продукции', 'Работа с лабораторным оборудованием'],
    requirements: 'Студенты химических, биологических и пищевых направлений с 18 лет, на старте учит наставник',
    pay: { from: 60000 },
    payNote: NIGHT_PAY_NOTE,
  },
  {
    id: 'warehouse-operator',
    title: 'Оператор склада',
    department: 'logistics',
    unit: 'Складской комплекс',
    format: 'Оплачиваемая практика',
    // «Оператор: работа с программой, с документацией, с товарно-транспортными накладными, от 60 000 р до вычета налога
    // (с ночью больше), график работы 2/2 дневные смены … или 2/2 с ночными сменами (день-ночь-отсыпной-выходной)»
    schedule: TWO_BY_TWO_OR_NIGHTS,
    hours: DAY_AND_NIGHT_HOURS,
    nights: true,
    period: PRACTICE_PERIOD,
    tasks: ['Работа в складской программе', 'Документы склада', 'Товарно-транспортные накладные'],
    requirements: PRACTICE_START,
    pay: { from: 60000 },
    payNote: NIGHT_PAY_NOTE,
  },
  {
    id: 'storekeeper',
    title: 'Кладовщик',
    department: 'logistics',
    unit: 'Складской комплекс',
    format: 'Оплачиваемая практика',
    // «Кладовщики: работа с накладными, управление комплектовщиками от 56 000 р до вычета налога (с ночью больше),
    // график работы 2/2 дневные смены … или 2/2 с ночными сменами (день-ночь-отсыпной-выходной)»
    schedule: TWO_BY_TWO_OR_NIGHTS,
    hours: DAY_AND_NIGHT_HOURS,
    nights: true,
    period: PRACTICE_PERIOD,
    tasks: ['Работа с накладными', 'Управление комплектовщиками'],
    requirements: PRACTICE_START,
    pay: { from: 56000 },
    payNote: NIGHT_PAY_NOTE,
  },

  // ── Бесплатная практика по договорённости: задачи дословно из «Описания практики» ──
  {
    id: 'automation-intern',
    title: 'Практика с инженерами',
    department: 'engineering',
    format: 'Бесплатная практика',
    schedule: FREE_PRACTICE_SCHEDULE,
    period: FREE_PRACTICE_PERIOD,
    // «работа в паре с инженером технической поддержки; оцифровка производственной линии; разработка плана оптимизации производства»
    tasks: ['Работа в паре с инженером технической поддержки', 'Оцифровка производственной линии', 'Разработка плана оптимизации производства'],
    requirements: 'Студенты инженерных направлений: автоматизация, мехатроника, электротехника, IT. Практика от вуза или колледжа',
  },
  {
    id: 'microbiologist-intern',
    title: 'Практика в лаборатории',
    department: 'quality',
    format: 'Бесплатная практика',
    schedule: FREE_PRACTICE_SCHEDULE,
    period: FREE_PRACTICE_PERIOD,
    // «взятие проб на контроль качества продукции»
    tasks: ['Взятие проб на контроль качества продукции'],
    requirements: 'Студенты химических, биологических и пищевых направлений. Практика от вуза или колледжа',
  },
  {
    id: 'logistics-planner',
    title: 'Практика на складе',
    department: 'logistics',
    format: 'Бесплатная практика',
    schedule: FREE_PRACTICE_SCHEDULE,
    period: FREE_PRACTICE_PERIOD,
    // «сборка и комплектование заказов»; «работа в программе с ТТН»
    tasks: ['Сборка и комплектование заказов', 'Работа в программе с товарно-транспортными накладными'],
    requirements: 'Студенты логистики, экономики и колледжей любого профиля. Практика от вуза или колледжа',
  },
  {
    id: 'marketing-intern',
    title: 'Практика в офисе',
    department: 'office',
    format: 'Бесплатная практика',
    schedule: FREE_PRACTICE_SCHEDULE,
    period: FREE_PRACTICE_PERIOD,
    // «создание маскотов для странички студента; роликов по профессии, один день из жизни студента; работа в архиве с бумагами;
    // разработка и написание электронного курса; … разработка макета выкладки продукции»
    tasks: [
      'Маскоты для странички студента',
      'Ролики о профессиях и «Один день из жизни студента»',
      'Разработка и написание электронного курса',
      'Работа в архиве с документами',
      'Разработка макета выкладки продукции',
    ],
    requirements: 'Студенты маркетинга, дизайна, журналистики, педагогики, истории. Практика от вуза или колледжа',
  },

  // ── Работа: живые вакансии на hh.ru ───────────────────────────────────────────
  {
    id: 'store-worker',
    title: 'Рабочий фирменного магазина',
    department: 'logistics',
    format: 'Постоянная работа',
    // https://hh.ru/vacancy/137288247 («Работник торгового зала / Грузчик в фирменный магазин (Рябиновая ул. 44)», АО ОЧАКОВО):
    // «от 57 000 до 89 000 ₽ за месяц до вычета налогов», график 2/2, рабочие часы 12, «сменная работа (дневные смены)»,
    // опыт «не требуется», «Полная занятость». Обязанности: «разгрузка продукции для магазина», «выставление товара в торговый зал»,
    // «подготовка ассортимента товара по заказу покупателя», «поддерживание порядка в складском помещении»
    schedule: '2/2, дневные смены по 12 часов',
    nights: false,
    period: 'Круглый год',
    tasks: ['Разгрузка продукции', 'Выкладка товара в торговом зале', 'Сборка заказов покупателей', 'Порядок на складе магазина'],
    requirements: 'Без опыта. Нужны внимательность и организованность',
    pay: { from: 57000, to: 89000 },
  },
  {
    id: 'merchandiser',
    title: 'Мерчандайзер',
    department: 'sales',
    format: 'Постоянная работа',
    // https://hh.ru/vacancy/138508330 («Мерчендайзер», АО ОЧАКОВО, Москва): «от 70 000 ₽ за месяц до вычета налогов»,
    // «График: 5/2», «Рабочие часы: 8», «Формат работы: разъездной», опыт 1–3 года, «опыт работы в продажах будет преимуществом»
    schedule: 'Разъездной, 5/2 по 8 часов',
    nights: false,
    period: 'Круглый год',
    tasks: ['Выкладка продукции в магазинах по стандартам', 'Ценники и наличие товара', 'Отчёты о визитах в приложении компании'],
    requirements: 'Опыт работы от года, опыт в продажах будет плюсом. Работа в разъездах по магазинам',
    pay: { from: 70000 },
  },
]

/**
 * Открытые вакансии: сайт, форма заявки, бот, подбор и Квасыч показывают только их. Закрытие в панели убирает вакансию
 * отсюда — массив меняется на месте, ссылки на него у импортёров остаются верными
 */
export const vacancies: Vacancy[] = [...allVacancies]

/** Вакансия по id — и закрытая тоже: у заявок, поданных до закрытия, название остаётся */
export const vacancyById = (id: string) => allVacancies.find((v) => v.id === id)

/** Вакансия открыта: её можно выбрать в форме, боте и подборе */
export const isVacancyOpen = (id: string) => vacancies.some((v) => v.id === id)

/** Открытая вакансия по id — для выбора в форме и боте; закрытая или неизвестная — undefined */
export const openVacancyById = (id: string) => vacancies.find((v) => v.id === id)

/** Практика: оплачиваемая и бесплатная */
export const isPractice = (v: Vacancy) => v.format === 'Оплачиваемая практика' || v.format === 'Бесплатная практика'
/** Открытая оплачиваемая практика — пересчитывается после правок в панели, массив тот же */
export const paidPractice: Vacancy[] = []
/** Открытая бесплатная практика — пересчитывается после правок в панели, массив тот же */
export const freePractice: Vacancy[] = []

export const formatRub = (n: number) => `${n.toLocaleString('ru-RU')}\u00A0₽`

export const payLabel = (v: Vacancy) =>
  v.pay
    ? v.pay.to
      ? `${v.pay.from.toLocaleString('ru-RU')}–${formatRub(v.pay.to)}`
      : `от ${formatRub(v.pay.from)}`
    : v.format === 'Бесплатная практика'
      ? 'без оплаты'
      : 'по итогам собеседования'

/** На руки после НДФЛ 13 %, округлено до сотен */
export const netPay = (gross: number) => Math.round((gross * 0.87) / 100) * 100

/**
 * Минимальная зарплата среди открытых вакансий: сейчас кладовщик на практике, 56 000 ₽.
 * export let: после правок в панели значение пересчитывается, импортёры видят новое при следующем чтении
 */
export let minMonthlyPay = 0

/**
 * Верхняя граница «от» у оплачиваемой практики: сейчас 70 000 ₽ — операторы цеха розлива и технологического цеха.
 * Вместе с minMonthlyPay — «от 56 000 до 70 000 ₽» на первом экране и в боте: «оператором линии — от 70 000 ₽»
 */
export let maxEntryPay = 0

/** Нижняя граница у оплачиваемой практики: сейчас 56 000 ₽ — кладовщик. Для ответов про практику, без работы */
export let minPracticePay = 0

/**
 * Порядок показа: оплачиваемая практика, бесплатная практика, работа; внутри — от большей суммы к меньшей.
 * Исходный массив не меняем — его порядок использует сайт. Пересчитывается после правок в панели, массив тот же
 */
export const vacanciesByPay: Vacancy[] = []

const sumsFrom = (list: Vacancy[]) => list.flatMap((v) => (v.pay && !v.pay.estimate ? [v.pay.from] : []))
const builtinMin = Math.min(...sumsFrom(allVacancies))
const builtinMax = Math.max(...sumsFrom(allVacancies.filter((v) => v.format === 'Оплачиваемая практика')))
const builtinPracticeMin = Math.min(...sumsFrom(allVacancies.filter((v) => v.format === 'Оплачиваемая практика')))

/** Пересчитать производные после правок: списки практики, порядок по сумме, вилку для первого экрана */
function recompute() {
  paidPractice.splice(0, paidPractice.length, ...vacancies.filter((v) => v.format === 'Оплачиваемая практика'))
  freePractice.splice(0, freePractice.length, ...vacancies.filter((v) => v.format === 'Бесплатная практика'))
  const rank = (v: Vacancy) => {
    const i = vacancyFormats.indexOf(v.format)
    return i < 0 ? vacancyFormats.length : i
  }
  vacanciesByPay.splice(0, vacanciesByPay.length, ...[...vacancies].sort((a, b) => rank(a) - rank(b) || (b.pay?.from ?? 0) - (a.pay?.from ?? 0)))
  // Всё с суммой закрыли — остаётся вилка из данных компании: строки «от 0 ₽» на сайте не будет
  const all = sumsFrom(vacancies)
  const paid = sumsFrom(paidPractice)
  minMonthlyPay = all.length ? Math.min(...all) : builtinMin
  maxEntryPay = paid.length ? Math.max(...paid) : builtinMax
  minPracticePay = paid.length ? Math.min(...paid) : builtinPracticeMin
}
recompute()

/** Бывают ночные смены. У вакансий из редактора без поля nights — по строке графика: 2/2 или «сменный» без «дневные». То же правило — в форме заявки */
export const hasNightShifts = (v: Vacancy) => v.nights ?? (/2\/2|сменн/i.test(v.schedule) && !/дневн/i.test(v.schedule))

/** Направления, где работают рядом с продуктом и нужна личная медицинская книжка. То же правило — в форме заявки */
export const medBookDepartments: DepartmentId[] = ['production', 'quality', 'engineering', 'logistics', 'sales']
/** Вакансии в этих направлениях, где продукта не касаются, — за столом. Сейчас таких нет */
export const deskVacancies: string[] = []
export const needsMedBook = (v: Vacancy) => medBookDepartments.includes(v.department) && !deskVacancies.includes(v.id)

/** Ссылку на портфолио спрашивают в заявке на практику в офисе: маскоты, ролики, курс. Поле необязательное */
export const asksPortfolio = (v: Vacancy) => v.department === 'office'

// ── График и деньги одной строкой — одни и те же тексты на сайте, в боте и у Квасыча ─────

/** Пометка ночных смен в строке графика */
export const NIGHT_SHIFTS_NOTE = 'бывают ночные смены'

/**
 * График вакансии одной строкой для списков, «Собери лето» и итога подбора. Ночные смены не прячутся:
 * «2/2, смены по 12 часов · бывают ночные смены». Если ночь уже названа в самом графике — пометку не повторяем.
 * Без точки в конце — строка встаёт внутрь фразы
 */
export const scheduleLine = (v: Vacancy): string =>
  hasNightShifts(v) && !/ночн|ночь/i.test(v.schedule) ? `${v.schedule} · ${NIGHT_SHIFTS_NOTE}` : v.schedule

/**
 * Общий ответ на «какой график»: заголовок для «Условий» и текст для сайта и чата. По «Описанию практики» и справочнику
 * студента: «Графики работы составляет руководитель. Самостоятельно выбрать не получится»
 */
/** Часы смен, график по отделам и кто его составляет — для таблицы «Условий» на главной; текст для чата собран из них же */
export const shiftHours = 'Дневная смена идёт с 8:00 до 20:00, ночная с 20:00 до 8:00.'
export const scheduleByUnit: { unit: string; where: string; text: string }[] = [
  { unit: 'Лаборатория и склад', where: 'В лаборатории и на складе', text: '2/2, только дневные или день-ночь-отсыпной-выходной' },
  { unit: 'Технологический цех', where: 'в технологическом цехе', text: 'день-ночь-отсыпной-выходной' },
  { unit: 'Цех розлива', where: 'в цехе розлива', text: 'дневные и ночные смены' },
]
export const scheduleNote = 'График составляет руководитель, у бесплатной практики его назначают по договорённости.'

export const scheduleSummary: { title: string; text: string } = {
  title: 'Смены по 12 часов',
  text: `${shiftHours} ${scheduleByUnit.map((s) => `${s.where}: ${s.text}`).join('; ')}. ${scheduleNote}`,
}

/** Деньги за смену и за час на руки: perShift и perHour в ₽, shiftsPerMonth — сколько смен в месяц заложено в расчёт */
export type ShiftPay = { perShift: number; perHour: number; shiftsPerMonth: number }

/** Смен в месяц на графике 2/2 и на «день — ночь — отсыпной — выходной»: две смены на четыре дня, в среднем 30,4 дня ÷ 2 */
export const SHIFTS_PER_MONTH_2_2 = 15.2
/** Часов в смене на графике 2/2 */
export const SHIFT_HOURS_2_2 = 12

/**
 * Сколько выходит за смену и за час на руки. Только для графика 2/2 по 12 часов с суммой из источника (не ориентир);
 * для остальных — null, и строку «за смену» не показываем. У вилки берём нижнюю границу, ночная надбавка не входит.
 * За смену = на руки в месяц ÷ 15,2, округлено до сотен; в час = за смену ÷ 12, округлено до десятков
 */
export const shiftPay = (v: Vacancy): ShiftPay | null => {
  if (!v.pay || v.pay.estimate || !/2\/2/.test(v.schedule) || !new RegExp(`${SHIFT_HOURS_2_2} час`).test(v.schedule)) return null
  const shift = netPay(v.pay.from) / SHIFTS_PER_MONTH_2_2
  return {
    perShift: Math.round(shift / 100) * 100,
    perHour: Math.round(shift / SHIFT_HOURS_2_2 / 10) * 10,
    shiftsPerMonth: SHIFTS_PER_MONTH_2_2,
  }
}

/** Сноска под списками вакансий: откуда суммы. Верна для каждой строки списка */
export const estimateNote =
  'Суммы указаны в месяц до вычета налога. У практики они из данных «Очаково», у работы из вакансий «Очаково» на hh.ru. Ночные смены оплачивают по повышенному коэффициенту, бесплатная практика не оплачивается.'

// ── Правки из панели администратора ─────────────────────────────────────────────
// Администратор закрывает и открывает вакансии, правит зарплату от–до, ориентир, «Срочный набор» и период — без
// программиста. Правки лежат в базе (vacancy_overrides, миграция 015) и накладываются на данные компании выше:
// applyVacancyOverrides меняет объекты на месте, пересчитывает списки и вилку. Сервер накладывает их при старте и после
// сохранения (server/content/vacancies.ts), сайт — при загрузке страницы (loadVacancyOverrides). Без API сайт
// показывает данные компании как есть.

/** Что правится в панели. pay: null — без оплаты (только у бесплатной практики) */
export type VacancyEditable = {
  open: boolean
  pay: { from: number; to?: number; estimate?: boolean } | null
  hot: boolean
  period: string
}

/** Правка одной вакансии — полное состояние редактируемых полей */
export type VacancyOverride = VacancyEditable & { vacancyId: string }

/** Пределы суммы в месяц до вычета налога: от МРОТ с запасом до явной опечатки с лишним нулём */
export const PAY_MIN = 10_000
export const PAY_MAX = 1_000_000
export const PERIOD_MAX = 120

/** Редактируемые поля вакансии сейчас */
export const editableOf = (v: Vacancy): VacancyEditable => ({
  open: isVacancyOpen(v.id),
  pay: v.pay ? { from: v.pay.from, ...(v.pay.to ? { to: v.pay.to } : {}), ...(v.pay.estimate ? { estimate: true } : {}) } : null,
  hot: Boolean(v.hot),
  period: v.period,
})

/** Данные компании до правок — для «Вернуть как было» и истории */
const builtin = new Map(allVacancies.map((v) => [v.id, { open: true, pay: v.pay ? { ...v.pay } : null, hot: Boolean(v.hot), period: v.period } as VacancyEditable]))

/** Как в данных компании, без правок из панели */
export const builtinEditable = (id: string): VacancyEditable | null => {
  const b = builtin.get(id)
  return b ? { ...b, pay: b.pay ? { ...b.pay } : null } : null
}

/**
 * Что не так с правкой, по полям; null — можно сохранять. Правила зависят от формата: у оплачиваемой практики
 * и работы сумма обязательна, у бесплатной практики суммы нет совсем
 */
export function vacancyOverrideProblem(v: Vacancy, o: VacancyEditable): Partial<Record<'payFrom' | 'payTo' | 'period' | 'form', string>> | null {
  const errors: Partial<Record<'payFrom' | 'payTo' | 'period' | 'form', string>> = {}
  const free = v.format === 'Бесплатная практика'
  if (free && o.pay) errors.payFrom = 'У бесплатной практики оплаты нет. Сумму можно указать только у оплачиваемой практики и работы'
  else if (!free && !o.pay) errors.payFrom = v.format === 'Оплачиваемая практика' ? 'У оплачиваемой практики нужна сумма в месяц' : 'Укажи зарплату в месяц до вычета налога'
  else if (o.pay) {
    const { from, to } = o.pay
    if (!Number.isInteger(from) || from < PAY_MIN || from > PAY_MAX) errors.payFrom = `Сумма в месяц до вычета налога должна быть от ${PAY_MIN.toLocaleString('ru-RU')} до ${PAY_MAX.toLocaleString('ru-RU')} ₽`
    if (to !== undefined && (!Number.isInteger(to) || to > PAY_MAX)) errors.payTo = `Не больше ${PAY_MAX.toLocaleString('ru-RU')} ₽`
    else if (to !== undefined && Number.isInteger(from) && to <= from) errors.payTo = '«До» должно быть больше, чем «от»'
  }
  const period = o.period.trim()
  if (!period) errors.period = 'Укажи период, например «С марта по июль»'
  else if (period.length > PERIOD_MAX) errors.period = `Не длиннее ${PERIOD_MAX} символов`
  if (typeof o.open !== 'boolean' || typeof o.hot !== 'boolean') errors.form = 'Неверные данные правки'
  return Object.keys(errors).length ? errors : null
}

let overridesVersion = 0
/** Меняется после каждого наложения правок: по нему сбрасывают кэши (подсказки, тексты) */
export const vacanciesVersion = () => overridesVersion

/**
 * Наложить правки на данные компании: всё, чего нет в списке, — как в данных компании. Объекты вакансий меняются
 * на месте, закрытые уходят из vacancies, списки практики, порядок по сумме и вилка пересчитываются.
 * Правка, которая не проходит vacancyOverrideProblem (например, сумма у бесплатной практики), пропускается.
 * Возвращает id пропущенных правок
 */
export function applyVacancyOverrides(list: VacancyOverride[]): string[] {
  const byId = new Map(list.map((o) => [o.vacancyId, o]))
  const skipped: string[] = []
  const open = new Set<string>()
  for (const v of allVacancies) {
    const o = byId.get(v.id)
    const ok = o && !vacancyOverrideProblem(v, o)
    if (o && !ok) skipped.push(v.id)
    const s = ok ? o : builtin.get(v.id)!
    if (s.pay) v.pay = { from: s.pay.from, ...(s.pay.to ? { to: s.pay.to } : {}), ...(s.pay.estimate ? { estimate: true } : {}) }
    else delete v.pay
    if (s.hot) v.hot = true
    else delete v.hot
    v.period = s.period.trim()
    if (s.open) open.add(v.id)
  }
  vacancies.splice(0, vacancies.length, ...allVacancies.filter((v) => open.has(v.id)))
  recompute()
  overridesVersion++
  return skipped
}

/** Правки из ответа API — только то, что похоже на правку; остальное отбрасывается */
export function parseVacancyOverrides(raw: unknown): VacancyOverride[] {
  const list = Array.isArray((raw as { overrides?: unknown })?.overrides) ? (raw as { overrides: unknown[] }).overrides : Array.isArray(raw) ? raw : []
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined)
  return list.flatMap((item) => {
    const o = item as Record<string, unknown>
    if (!o || typeof o.vacancyId !== 'string' || typeof o.open !== 'boolean' || typeof o.hot !== 'boolean' || typeof o.period !== 'string') return []
    const p = o.pay as Record<string, unknown> | null
    const from = p ? num(p.from) : undefined
    const pay = p && from !== undefined ? { from, ...(num(p.to) !== undefined ? { to: num(p.to) } : {}), ...(p.estimate === true ? { estimate: true } : {}) } : null
    return [{ vacancyId: o.vacancyId, open: o.open, hot: o.hot, period: o.period, pay }]
  })
}

/** Адрес правок для сайта: открытый, без имён сотрудников */
export const VACANCY_OVERRIDES_URL = '/api/vacancy-overrides'

/**
 * Сайт при загрузке: спросить правки и наложить. Не дождались за timeoutMs или API нет — данные компании как есть,
 * страница не ждёт дольше. true — правки наложены
 */
export async function loadVacancyOverrides(url = VACANCY_OVERRIDES_URL, timeoutMs = 1500): Promise<boolean> {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = setTimeout(() => ctrl?.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl?.signal, headers: { accept: 'application/json' } })
    if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) return false
    const list = parseVacancyOverrides(await res.json())
    if (!list.length) return false
    applyVacancyOverrides(list)
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Откуда данные вакансии — только для панели администратора, на сайте не показываем. team — что предложила команда
 * проекта, а не компания: такие места администратору стоит проверить и подтвердить
 */
export const vacancyBasis: Record<string, { source: string; team?: string }> = {
  'bottling-operator': { source: '«Описание практики»: оператор цеха розлива, сумма и график' },
  'fermentation-assistant': { source: '«Описание практики»: оператор технологического цеха, сумма и график' },
  'lab-chemist': { source: '«Описание практики»: лаборант, сумма и график', team: 'задачи взяты из ролика «Химик-лаборант», в документе их нет' },
  'warehouse-operator': { source: '«Описание практики»: оператор склада, сумма и график' },
  storekeeper: { source: '«Описание практики»: кладовщик, сумма и график' },
  'automation-intern': { source: '«Описание практики»: задачи бесплатной практики', team: 'название и отдел предложили мы, когда разбили задачи по отделам' },
  'microbiologist-intern': { source: '«Описание практики»: задачи бесплатной практики', team: 'название и отдел предложили мы, когда разбили задачи по отделам' },
  'logistics-planner': { source: '«Описание практики»: задачи бесплатной практики', team: 'название и отдел предложили мы, когда разбили задачи по отделам' },
  'marketing-intern': { source: '«Описание практики»: задачи бесплатной практики', team: 'название и отдел предложили мы, когда разбили задачи по отделам' },
  'store-worker': { source: 'hh.ru, вакансия 137288247: сумма, график, обязанности' },
  merchandiser: { source: 'hh.ru, вакансия 138508330: сумма, график, обязанности' },
}
