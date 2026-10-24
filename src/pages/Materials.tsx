import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { dorm } from '@shared/content/handbook'
import { timeline } from '@shared/content/company'
import { COMPANY_QUIZ_ROUND, companyQuiz } from '@shared/content/companyQuiz'
import { formatRub, maxEntryPay, minMonthlyPay } from '@shared/content/vacancies'
import { nb } from '../lib/typo'

// Материалы кейса одной страницей — для экспертов хакатона и для сдачи: что просит кейс и где это в решении.
// Макеты и превью лежат в docs/brand и публикуются по адресу /materials/… (плагин materials в vite.config.ts).
// Снимки экранов продукта — docs/brand/img/site-*.webp, их снимает scripts/materials-shots.mjs; превью макетов —
// scripts/materials-previews.mjs. Документы .md — в репозитории, пути к ним подписаны. Цифры — из shared/content, как на сайте и в боте.

const M = '/materials'

const sections = [
  { id: 'req', title: 'Требования' },
  { id: 'tool', title: 'Инструмент' },
  { id: 'concept', title: 'Концепция' },
  { id: 'story', title: 'Сторителлинг' },
  { id: 'visuals', title: 'Визуальные материалы' },
  { id: 'merch', title: 'Мерч' },
  { id: 'clips', title: 'Видеоролики' },
  { id: 'rationale', title: 'Обоснование' },
  { id: 'ideas', title: 'Что придумали сами' },
  { id: 'check', title: 'Как проверить' },
] as const

type SectionId = (typeof sections)[number]['id']

/** Номер раздела «01» … «10»: требования идут без номера */
const num = (id: SectionId) => String(sections.findIndex((s) => s.id === id)).padStart(2, '0')
const title = (id: SectionId) => sections.find((s) => s.id === id)!.title

const pay = `от ${minMonthlyPay.toLocaleString('ru-RU')} до ${formatRub(maxEntryPay)}`

const kicker = 'text-[13px] font-semibold tracking-[0.08em] text-brand-bright uppercase'
const h2 = 'font-display text-[clamp(44px,6vw,92px)] leading-[0.86] font-black uppercase'
const h3 = 'font-display text-[28px] leading-[0.92] font-extrabold uppercase'
const body = 'text-[17px] leading-relaxed text-white/80'
const doc = 'rounded-sm bg-white/10 px-1.5 py-0.5 font-mono text-[13px] whitespace-nowrap text-white/85'
const caption = 'mt-3 text-[14px] leading-snug text-white/60'
const linkCls =
  'group inline-flex min-h-11 items-center gap-3 font-display text-[19px] font-extrabold tracking-[0.04em] uppercase text-white underline decoration-white/30 underline-offset-[6px] hover:decoration-brand-bright'
const btn =
  'inline-flex min-h-12 items-center px-5 font-display text-[19px] font-extrabold tracking-[0.04em] uppercase transition-colors md:min-h-14 md:px-7 md:text-[21px]'

const Dash = () => <span aria-hidden="true" className="block h-[2px] w-5 bg-current transition-[width] duration-300 group-hover:w-8" />

/** Ссылка на макет или файл — в новой вкладке, с сайта; на страницы сайта — роутером; download — скачать файл */
function Open({ href, children, download }: { href: string; children: ReactNode; download?: boolean }) {
  if (download)
    return (
      <a href={href} download className={linkCls}>
        {children}
        <Dash />
      </a>
    )
  if (href.startsWith(M) || href.startsWith('http'))
    return (
      <a href={href} target="_blank" rel="noreferrer" className={linkCls}>
        {children}
        <Dash />
      </a>
    )
  return (
    <Link to={href} className={linkCls}>
      {children}
      <Dash />
    </Link>
  )
}

function Section({ id, n, heading, lead, children }: { id: SectionId; n: string; heading: string; lead?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-16 border-t border-white/15 pt-14 pb-20 md:pt-20 md:pb-28">
      <div className="container-x">
        <p className={kicker}>{nb(n)}</p>
        <h2 id={`${id}-title`} className={`${h2} mt-3`}>
          {nb(heading)}
        </h2>
        {lead && <p className={`${body} mt-6 max-w-3xl`}>{nb(lead)}</p>}
        <div className="mt-10">{children}</div>
      </div>
    </section>
  )
}

/** Картинка в рамке одной пропорции: подписи в ряду стоят на одной линии */
function Figure({
  src,
  alt,
  text,
  w,
  h,
  box = 'aspect-[4/5]',
  fit = 'object-cover',
  className = '',
}: {
  src: string
  alt: string
  text?: string
  w: number
  h: number
  box?: string
  fit?: string
  className?: string
}) {
  return (
    <figure className={className}>
      {/* Фон под картинкой — тёмный, если рамка не задала свой (у рисунков мерча — светлое поле) */}
      <img src={src} alt={alt} width={w} height={h} loading="lazy" decoding="async" className={`block w-full ${box.includes('bg-') ? '' : 'bg-coal'} ${box} ${fit}`} />
      {text && <figcaption className={caption}>{nb(text)}</figcaption>}
    </figure>
  )
}

function Card({ heading, children, links }: { heading: string; children: ReactNode; links?: [string, string][] }) {
  return (
    <div className="flex flex-col bg-coal p-6 md:p-7">
      <h3 className={h3}>{nb(heading)}</h3>
      <div className="mt-3 flex-1 text-[15px] leading-relaxed text-white/75">{children}</div>
      {links && (
        <div className="mt-5 flex flex-col gap-1">
          {links.map(([href, label]) => (
            <Open key={href} href={href}>
              {label}
            </Open>
          ))}
        </div>
      )}
    </div>
  )
}

/** Требование кейса → где в решении → раздел страницы */
const requirements: [string, string, SectionId][] = [
  ['Сбор данных: ФИО, контакты, дата рождения, вакансия, готовность выйти, вуз или колледж', 'Анкета на сайте и в боте, одна проверка для сайта, бота и сервера; моложе 18 лет заявку не примут', 'tool'],
  ['Информация в лёгкой игровой форме', 'Четыре задания прямо на главной: «Собери лето», «Подбор работы», «Поймай брак», «Правда или миф»', 'tool'],
  ['Связь с целевой аудиторией', 'Бот в Telegram и MAX, чат на сайте, сообщения HR в бот, SMS, «Напомнить о наборе», самозапись на собеседование', 'tool'],
  ['Контрольные вопросы на знание компании', `${COMPANY_QUIZ_ROUND} случайных из ${companyQuiz.length} вопросов, у каждого источник`, 'tool'],
  ['Концепция HR-бренда в презентации: идея, цель, слоган, ключевые образы', 'Презентация «Квас делают люди» на 31 слайд: исследования, идея, цель, слоган, ключевые образы, посылы и фокус-группа, экраны сайта, мини-приложения и HR-панели с объяснением, как они работают и зачем нужны, мост в мессенджеры, материалы, мерч, легенда, ролики, обоснование, разработка и внедрение, масштабируемость и смета; PDF для печати', 'concept'],
  ['Проверка концепции через фокус-группу', 'Три группы, интервью и анонимная анкета, пороги решений записаны заранее. Встреч пока не было, результатов ещё нет', 'concept'],
  ['История, направления, карьерные возможности, ключевые бренды', 'Таймлайн: 1978, 1996, 1998 и сегодня, бренды, «Путь кваса», вакансии по отделам', 'story'],
  ['Сторителлинг', 'Легенда «Квас делают люди» на сайте, в боте и на экскурсии', 'story'],
  ['Листовки, маскоты, образы, референсы', 'Три листовки, ролл-ап и табличка для стенда, маскот Квасыч, ключевые образы', 'visuals'],
  ['Мерч', 'Коллекция «Смена»: макеты изделий и векторные файлы принтов для производства', 'merch'],
  ['Видеоролик о компании', 'Серия коротких вертикальных роликов: 12 выпусков с обложками, сценариями и списком кадров на один съёмочный день', 'clips'],
  ['Обоснование концепции', 'Ответ на каждую проблему кейса, цели сезона, календарь и смета пилота', 'rationale'],
]

/** Экраны продукта: scripts/materials-shots.mjs → docs/brand/img/<shot>.webp */
const phones: { shot: string; text: string }[] = [
  { shot: 'site-home', text: 'Главная: сумма на первом экране' },
  { shot: 'site-game', text: 'Задание «Поймай брак»' },
  { shot: 'site-apply', text: 'Заявка: поля по кейсу, проверка 18+' },
  { shot: 'site-status', text: '«Моя заявка»: статус и что дальше' },
]
const desktops: { shot: string; text: string }[] = [
  { shot: 'site-hr-funnel', text: 'HR-панель, «Воронка»: путь от входа до смены по меткам источника' },
  { shot: 'site-hr-list', text: 'HR-панель, «Заявки»: все каналы в одном списке' },
]

/** Концепция коротко — docs/brand/concept.md, раздел «Коротко» */
const concept: [string, string][] = [
  ['Идея', '«Очаково» растит себе смену: опытные сотрудники учат молодых делать натуральные напитки официально, за зарплату, с наставником у каждого новичка.'],
  ['Цель', 'Студенты 4-х курсов и выпускники 18–26 лет знают «Очаково» как работодателя, где учат наставники, и сами приходят на оплачиваемую практику: заявок больше, чем мест, и практику доводят до конца.'],
  ['Слоган', '«Квас делают люди». Запасные: «Я делаю натуральные напитки» и «Сначала научим, потом доверим».'],
  ['Образы', 'Наставник и новичок у пульта линии. Надпись на спине рабочей куртки. Руки и детали оборудования. Квас на свету. «Тогда и сейчас». Квасыч. Фирменные пиктограммы.'],
]

const messages: [string, string][] = [
  ['Инженерные специальности', 'Линия розлива изнутри, рядом с наставником'],
  ['Профильные специалисты', 'Оплачиваемая практика по специальности в лаборатории и цехе варки'],
  ['Линейный персонал', `${pay[0].toUpperCase()}${pay.slice(1)} до вычета налога, общежитие студентам за ${formatRub(dorm.priceStudent)} и наставник у каждого новичка`],
  ['Студенты 4-х курсов', 'Практика по договору с вузом, с зарплатой и без испытательного срока'],
  ['Выпускники', 'После практики можно остаться на постоянной работе'],
]

const leaflets: { heading: string; text: string; href: string; img: [string, string]; h: number }[] = [
  { heading: 'Листовка A5', text: 'Оплачиваемая практика: сумма, четыре отдела, QR с меткой точки контакта', href: `${M}/print/leaflet-a5.html`, img: ['leaflet-a5-1', 'leaflet-a5-2'], h: 907 },
  { heading: 'Вкладыш для вузов', text: 'Практика по договору с вузом: документы, кабинет 525, учёба и смены', href: `${M}/print/insert-vuz.html`, img: ['insert-vuz-1', 'insert-vuz-2'], h: 907 },
  { heading: 'Памятка A6', text: '«Перед первой сменой»: дорога, общежитие, телефоны, что делать, если тяжело', href: `${M}/print/first-shift-a6.html`, img: ['first-shift-a6-1', 'first-shift-a6-2'], h: 902 },
]

/** Мерч после главной пары «куртка — худи»: превью технических рисунков, docs/brand/merch/layouts.html */
const merch: { img: string; heading: string; why: string; anchor: string }[] = [
  { img: 'merch-longsleeve', heading: 'Лонгслив «2/2»', why: 'через месяц на смене, «2/2» во весь перед: так на заводе называют график', anchor: 'longsleeve' },
  { img: 'merch-tote', heading: 'Шоппер «Состав смены»', why: 'каждому из двоих, когда друг вышел на смену', anchor: 'tote' },
  { img: 'merch-tee', heading: 'Футболка «Двойное брожение»', why: 'амбассадорам, в ней снимают ролики', anchor: 'tee' },
  { img: 'merch-socks', heading: 'Носки-жаккард', why: 'за контрольные вопросы без ошибок на стенде', anchor: 'socks' },
  { img: 'merch-pins', heading: 'Значки и наклейки', why: 'коллекция из шести: четыре отдела, колос и «1978», который дают за 6 из 7 в викторине', anchor: 'pins' },
]

/** Файлы принтов для производства: размер — как в art/*.svg (scripts/merch-art.py) */
const prints: { heading: string; size: string; file: string; anchor: string }[] = [
  { heading: 'Принт на спину худи', size: '300 × 156 мм', file: 'hoodie-back', anchor: 'hoodie' },
  { heading: 'Принт на перед лонгслива', size: '400 × 235 мм', file: 'longsleeve-front', anchor: 'longsleeve' },
  { heading: 'Принт шоппера', size: '280 × 238 мм', file: 'tote-sostav', anchor: 'tote' },
]

/** Обложки на странице — с рубрикой. 06 «Сколько за лето» — шаблон под героя, она только в макете обложек */
/** Стикерпак Квасыча: файл и подпись (scripts/stickers.py, docs/kvasych.md) */
const stickers: [string, string][] = [
  ['01-hello', 'Привет, смена'],
  ['02-face', 'Жду на смене'],
  ['03-thumbs', 'Глаз-алмаз'],
  ['04-meh', 'Бывает'],
  ['05-oops', 'Ой, брак'],
  ['06-inspector', 'Проверим'],
  ['07-think', 'Дай подумать'],
  ['08-wow', 'Вот это да'],
  ['09-money', '12-го и 27-го'],
  ['10-clock', 'Смена в 8:00'],
  ['11-mentor', 'Смотри, как надо'],
  ['12-point', 'Тебе туда'],
  ['13-peek', 'Я тут'],
  ['14-phone', 'Пишу'],
  ['15-lost', 'Где я?'],
]
const covers: [string, string][] = [
  ['01', 'Квасыч отвечает'],
  ['02', 'Поймай брак'],
  ['03', 'Тогда и сейчас'],
  ['04', 'Первый день'],
  ['05', 'Квасыч отвечает'],
  ['07', 'Квасыч отвечает'],
  ['08', 'Первый день'],
  ['09', 'Тренд недели'],
  ['10', 'Квасыч отвечает'],
  ['11', 'Тогда и сейчас'],
  ['12', 'Наставник и новичок'],
]

const problems: [string, string, string][] = [
  ['Нет системного продвижения бренда работодателя', 'Одна идея и слоган во всех точках, у каждой точки своя метка источника, «Воронка» до выхода на смену', 'доля заявок и выходов на смену по меткам'],
  ['38% отсеиваются на испытательном сроке', 'До заявки показываем ролики, 12-часовые и ночные смены; наставник у каждого новичка; в «Как дела на смене» HR перезванивает тем, кому тяжело', 'доля закончивших практику, «Первые недели на смене»'],
  ['Средний возраст вырос с 47 до 52 лет', 'Герои кампании наставники, молодые приходят учиться у них', 'средний возраст принятых'],
  ['Конверсия в найм 0,02%', 'Точные посылы для каждого блока, задания и контрольные вопросы до заявки, заявка за 2 минуты', 'конверсия в «Воронке»'],
  ['Отток выпускников и молодых специалистов', 'Путь «практика → постоянная работа», вид «Резерв», мерч за месяц и за практику', 'доля перешедших на постоянную работу'],
]

/** Свои решения команды — критерий «Новаторские идеи»: что и где это в продукте */
const ideas: [string, string][] = [
  ['Задания заполняют заявку', '«Собери лето» ставит в анкету месяцы, «Подбор работы» ставит вакансию. Пара минут игры экономит время на форме, HR видит «Смену N/4» как сигнал интереса.'],
  ['Метка на каждую точку контакта', 'У QR на ярмарке, поста вуза, экскурсии и ролика своя метка и своя строка в «Воронке» до выхода на смену, с ценой выхода в рублях.'],
  ['«Как дела на смене»', 'Вопрос новичку после первой смены, через неделю и через месяц. «Тяжело» сразу становится звонком HR, а человек получает совет из справочника студента по своей причине.'],
  ['День найма по ссылке', 'Экскурсия и собеседования в один день: кандидат по ссылке или QR выбирает час, места по часам считает панель.'],
  ['Квасыч учится у HR', 'Вопрос без ответа уходит во вкладку «Вопросы к Квасычу»; ответ сотрудника сразу попадает в базу помощника, а частые вопросы становятся роликами «Квасыч отвечает».'],
  ['Мерч за шаг на заводе', 'Лонгслив с графиком 2/2 выдают через месяц на смене, когда новички уходят чаще всего. Худи с надписью рабочих курток выдают только после практики.'],
  ['Один движок для трёх каналов', 'Сайт, Telegram и MAX работают на одном сценарии: бот MAX работает без доработки, ему нужна только регистрация компанией.'],
]

/** Цели сезона — docs/strategy.md, раздел 1 */
const funnel: [string, string][] = [
  ['400 000', 'увидели кампанию'],
  ['40 000', 'открыли сайт или бота'],
  ['20 000', 'прошли задание'],
  ['3 000', 'заявок'],
  ['1 500', 'собеседований'],
  ['400', 'вышли на смену'],
]

/** Календарь кампании по месяцам — docs/strategy.md, раздел 7 */
const calendar: [string, string, string][] = [
  ['Октябрь–декабрь', 'Подготовка', 'запуск сайта и бота, договоры с вузами и колледжами о практике, отбор амбассадоров, съёмка «Наставник и новичок», запас из 10–15 коротких роликов'],
  ['Январь–февраль', 'Набор на практику', 'рассылки центров карьеры, экскурсии для профильных групп, вакансии на hh.ru, 3–4 коротких ролика в неделю, посевы в студенческих каналах'],
  ['Февраль–апрель', 'Пик набора', 'ярмарки с квасом и QR, таргет, день найма на заводе, «Устройтесь вдвоём»'],
  ['Март–август', 'Сезон', 'выход на смены, новые истории со смен, удержание до конца практики'],
  ['Сентябрь–октябрь', 'Итоги', 'разговор о постоянной работе с теми, кто доработал, кадровый резерв, отчёт «Лето в цифрах»'],
]

/** Деньги пилота — docs/strategy.md, раздел 8, и docs/brand/merch.md, раздел 4. Все цены — допущения команды */
const costs: [string, string][] = [
  ['780 тыс.–2,2 млн ₽', 'пилот кампании на сезон: таргет, посевы, ярмарки, работные сайты, ролики, мерч для стенда, хостинг'],
  ['1 950–5 550 ₽', 'за выход на смену при цели 400 человек: расход пилота ÷ выходы на смену'],
  ['30–120 тыс. ₽', 'на сайт, бота и HR-панель за сезон: они уже сделаны, в смете только хостинг и GigaChat'],
]

const docs: [string, string][] = [
  ['docs/brand/concept.md', 'концепция «Смена»: идея, цель, слоган, образы, тон, легенда, посылы'],
  ['docs/brand/rationale.md', 'обоснование концепции, образов и подачи'],
  ['docs/analytics.md', 'целевая и потенциальная аудитория, путь кандидата, аналоги'],
  ['docs/strategy.md', 'маркетинговая и PR-стратегия: каналы, короткие ролики, инфоповоды, метрики, смета'],
  ['docs/brand/visuals.md', 'фирменный стиль на печати, образы, листовки, стенд, маскот, референсы'],
  ['docs/brand/merch.md', 'коллекция мерча: что носят, за что выдают, цена'],
  ['docs/brand/clips.md', 'короткие ролики: 12 сценариев, съёмочный день, обложки'],
  ['docs/brand/focus-group.md', 'протокол фокус-группы и анкета'],
  ['docs/kvasych.md', 'маскот Квасыч: роль, позы, стикерпак'],
  ['docs/demo.md', 'сценарий показа на защите: пять минут, вопросы жюри, запасной план'],
  ['docs/hr.md', 'HR-панель: заявки, собеседования, первые недели, выгрузки'],
]

/** Раздел, который сейчас читают: линия на трети высоты экрана пересекает его */
function useActiveSection() {
  const [active, setActive] = useState<SectionId | null>(null)
  useEffect(() => {
    const els = sections.map((s) => document.getElementById(s.id)).filter((el): el is HTMLElement => Boolean(el))
    const seen = new Set<string>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) seen.add(e.target.id)
          else seen.delete(e.target.id)
        }
        // Пересечь линию может только один раздел; на стыке берём верхний
        const first = sections.find((s) => seen.has(s.id))
        setActive(first ? first.id : null)
      },
      { rootMargin: '-30% 0px -69% 0px' },
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])
  return active
}

/** Меню разделов: текущий отмечен; на телефоне меню прокручивается вбок — справа затухание, текущий пункт подъезжает в видимую часть */
function SectionNav() {
  const active = useActiveSection()
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    const ul = list.current
    if (!ul) return
    // Выше разделов, на первом экране, меню — с начала
    // scrollTo в новых браузерах возвращает промис: из эффекта его не возвращаем, React принял бы его за очистку
    if (!active) {
      ul.scrollTo({ left: 0, behavior: 'smooth' })
      return
    }
    const a = ul.querySelector<HTMLElement>(`a[href="#${active}"]`)
    if (!a) return
    const left = a.offsetLeft - ul.offsetLeft
    if (left < ul.scrollLeft || left + a.offsetWidth > ul.scrollLeft + ul.clientWidth) ul.scrollTo({ left: left - 16, behavior: 'smooth' })
  }, [active])
  return (
    <nav aria-label="Разделы" className="sticky top-0 z-20 border-y border-white/15 bg-night/95 backdrop-blur">
      <div className="relative">
        <ul ref={list} className="container-x flex gap-6 overflow-x-auto py-4 whitespace-nowrap [scrollbar-width:none]">
          {sections.map((s) => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                aria-current={active === s.id ? 'location' : undefined}
                className={`font-display text-[17px] font-extrabold tracking-[0.04em] whitespace-nowrap uppercase underline-offset-[10px] hover:text-white ${
                  active === s.id ? 'text-white underline decoration-brand decoration-2' : 'text-white/70'
                }`}
              >
                {s.title}
              </a>
            </li>
          ))}
        </ul>
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-night to-transparent lg:hidden" />
      </div>
    </nav>
  )
}

export function Materials() {
  useEffect(() => {
    // Тёмный фон и заголовок вкладки: у страницы свой каркас, без шапки и чата сайта
    const title = document.title
    document.title = 'Материалы кейса «Очаково»'
    document.documentElement.style.backgroundColor = '#0c0c0c'
    return () => {
      document.title = title
      document.documentElement.style.backgroundColor = ''
    }
  }, [])

  return (
    <div className="min-h-svh bg-night text-white">
      <header className="container-x pt-10 pb-14 md:pt-14 md:pb-20">
        <div className="flex items-center justify-between gap-6">
          <Link to="/" aria-label="Сайт «Очаково»">
            <img src="/brand/logo-wordmark-white.svg" alt="ОЧАКОВО" width={196} height={24} className="h-6 w-auto" />
          </Link>
          <p className="text-right text-[13px] text-white/55">
            Открой#Моспром · <span className="whitespace-nowrap">кейс АО МПБК «Очаково»</span>
          </p>
        </div>
        <p className={`${kicker} mt-14 md:mt-20`}>Материалы решения</p>
        <h1 className="mt-4 font-display text-[clamp(56px,10.4vw,176px)] leading-[0.8] font-black uppercase">
          Квас делают
          <span className="block text-brand">люди</span>
        </h1>
        <p className="mt-8 max-w-4xl text-[clamp(19px,1.9vw,26px)] leading-snug text-white">
          {nb(
            `Сайт, бот в Telegram и MAX и HR-панель на одном API: знакомят студентов и выпускников 18–26 лет с «Очаково» через короткие задания и ведут на оплачиваемую практику ${pay} в месяц до вычета налога.`,
          )}
        </p>
        <div className="mt-10 flex flex-wrap gap-3">
          {/* Презентация лежит статичными файлами в docs/brand/deck (плагин materials в vite.config.ts), поэтому здесь ссылка, без Link */}
          <a href={`${M}/deck/index.html`} className={`${btn} bg-brand text-white hover:bg-brand-deep`}>
            Презентация HR-бренда
          </a>
          <Link to="/" className={`${btn} border border-white/40 text-white hover:border-white`}>
            Открыть сайт
          </Link>
          <Link to="/hr" className={`${btn} border border-white/40 text-white hover:border-white`}>
            HR-панель
          </Link>
          <a href="#check" className={`${btn} border border-white/40 text-white hover:border-white`}>
            Проверить за 5 минут
          </a>
        </div>
      </header>

      <SectionNav />

      <section id="req" aria-labelledby="req-title" className="scroll-mt-16 pt-14 pb-20 md:pt-20 md:pb-28">
        <div className="container-x">
          <p className={kicker}>Что просит кейс и где это в решении</p>
          <h2 id="req-title" className={`${h2} mt-3`}>
            {nb('Требования кейса')}
          </h2>
          <ul className="mt-10 border-t border-white/15">
            {requirements.map(([req, where, id]) => (
              <li key={req}>
                <a
                  href={`#${id}`}
                  className="group grid gap-2 border-b border-white/15 py-4 transition-colors hover:bg-white/[0.04] md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_15rem] md:gap-10"
                >
                  <span className="text-[16px] font-semibold text-white">{nb(req)}</span>
                  <span className="text-[15px] leading-relaxed text-white/70">{nb(where)}</span>
                  <span className="inline-flex items-center gap-3 font-display text-[17px] font-extrabold tracking-[0.04em] whitespace-nowrap text-brand-bright uppercase md:justify-end md:self-start md:pt-0.5">
                    {num(id)} · {title(id)}
                    <Dash />
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <Section
        id="tool"
        n={`${num('tool')} · Цифровой инструмент`}
        heading="Сайт, бот и HR-панель"
        lead="Один API для сайта, ботов в Telegram и MAX и панели отдела персонала. Помощник Квасыч отвечает по базе знаний на GigaChat и без ключа работает в офлайн-режиме; персональные данные в модель не уходят."
      >
        <div className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-4 md:gap-x-6">
          {phones.map((p) => (
            <Figure key={p.shot} src={`${M}/img/${p.shot}.webp`} w={600} h={1298} box="aspect-[390/844] border border-white/15" fit="object-cover object-top" alt={p.text} text={p.text} />
          ))}
        </div>
        <div className="mt-10 grid gap-x-6 gap-y-8 md:grid-cols-2">
          {desktops.map((d) => (
            <Figure key={d.shot} src={`${M}/img/${d.shot}.webp`} w={1200} h={750} box="aspect-[1440/900] border border-white/15" fit="object-cover object-top" alt={d.text} text={d.text} />
          ))}
        </div>

        <div className="mt-16 grid gap-px bg-white/10 md:grid-cols-2 lg:grid-cols-3">
          <Card heading="Сайт для кандидата" links={[['/', 'Открыть сайт']]}>
            {nb(`Сумма на первом экране: ${pay} в месяц до вычета налога. Четыре задания «Смена N/4», история и бренды, вакансии по отделам.`)}
          </Card>
          <Card heading="Задания" links={[['/game', '«Поймай брак»']]}>
            {nb('«Собери лето», «Подбор работы», «Поймай брак» и «Правда или миф» идут прямо на главной, каждое на пару минут. Задания заполняют часть заявки: вакансию и месяцы.')}
          </Card>
          <Card heading="Контрольные вопросы" links={[['/game?t=quiz', 'Пройти вопросы']]}>
            {nb(`${COMPANY_QUIZ_ROUND} случайных из ${companyQuiz.length} вопросов о компании, после каждого ответа объяснение с фактом из материалов «Очаково».`)}
          </Card>
          <Card heading="Заявка по кейсу" links={[['/apply', 'Открыть анкету']]}>
            {nb('ФИО, дата рождения с проверкой 18+, контакт, вакансия, когда можно выйти, вуз или колледж. После отправки открывается «Моя заявка» со статусом и выбором времени собеседования.')}
          </Card>
          <Card heading="Бот и Квасыч" links={[['/#bot', 'Спросить Квасыча']]}>
            {nb('Один движок диалогов для Telegram, MAX и чата на сайте: задания, заявка, статус, приглашение и напоминания. Чат на сайте работает сразу, внизу любой страницы. Ботам в Telegram и MAX нужен токен компании: код бота MAX готов, зарегистрировать его может только «Очаково».')}
          </Card>
          <Card heading="HR-панель" links={[['/hr', 'Открыть панель']]}>
            {nb('Заявки со всех каналов, собеседования и самозапись, первые недели новичков, «Воронка» по источникам до выхода на смену, выгрузки в Excel, CSV, 1С и на Яндекс Диск. Вход для проверки описан в README.')}
          </Card>
        </div>
      </Section>

      <Section
        id="concept"
        n={`${num('concept')} · Концепция HR-бренда`}
        heading="«Смена»"
        lead="Концепция отвечает сразу на две проблемы кейса: стареющий коллектив и отсев новичков."
      >
        <dl className="border-t border-white/15">
          {concept.map(([k, v]) => (
            <div key={k} className="grid gap-2 border-b border-white/15 py-5 md:grid-cols-[11rem_minmax(0,1fr)] md:gap-10">
              <dt className="font-display text-[26px] leading-none font-extrabold text-brand-bright uppercase">{k}</dt>
              <dd className="max-w-4xl text-[17px] leading-relaxed text-white/85">{nb(v)}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-12 grid max-w-4xl gap-10 md:grid-cols-2">
          <Figure src={`${M}/img/key-mentor.jpg`} w={600} h={626} alt="Наставник и новичок у пульта линии" text="Ключевой образ: наставник и новичок у пульта. Кадр из ролика компании «Оператор линии розлива»" />
          <Figure src={`${M}/img/key-back.jpg`} w={560} h={630} alt="Надпись «Я делаю натуральные напитки» на спине рабочей куртки" text="Ключевой образ: надпись на спине рабочей куртки, из неё сделана главная вещь мерча" />
        </div>
        <h3 className={`${h3} mt-16`}>{nb('Посылы для трёх блоков кейса и для учёбы')}</h3>
        <ul className="mt-6 grid gap-px bg-white/10 md:grid-cols-2 lg:grid-cols-3">
          {messages.map(([who, msg]) => (
            <li key={who} className="bg-coal p-6">
              <p className="text-[13px] font-semibold tracking-[0.06em] text-white/55 uppercase">{who}</p>
              <p className="mt-3 font-display text-[26px] leading-[0.95] font-extrabold uppercase">«{nb(msg)}»</p>
            </li>
          ))}
          <li className="bg-coal p-6 text-[15px] leading-relaxed text-white/70">
            {nb('Посылы с доводами, точки контакта для каждого блока и ответ на каждую проблему кейса описаны в ')}
            <span className={doc}>docs/brand/concept.md</span>.
          </li>
        </ul>
        <div className="mt-14 grid gap-8 md:grid-cols-2">
          <div>
            <h3 className={h3}>{nb('Проверка на фокус-группе')}</h3>
            <p className="mt-3 text-[15px] leading-relaxed text-white/75">
              {nb('Анкета и сценарий встречи готовы, результаты собираются в HR-панели. В анкете три слогана и шесть вопросов о практике, она анонимная. Ссылку и QR с меткой группы выдаёт вкладка HR «Фокус-группа», там же ответы по меткам и выгрузка CSV. Протокол и сценарий встречи лежат в ')}
              <span className={doc}>docs/brand/focus-group.md</span>.
            </p>
            <div className="mt-4">
              <Open href="/focus?s=fg-a">Открыть анкету</Open>
            </div>
          </div>
          <div>
            <h3 className={h3}>Тон</h3>
            <p className="mt-3 text-[15px] leading-relaxed text-white/75">
              {nb('Как в роликах самой компании: коротко, на «ты», с цифрами, без лозунгов. Суммы пишем со словами «от» и «до вычета налога». В кадре и на вещах только квас и безалкогольные напитки: аудитория 18–26 лет. Подробно в ')}
              <span className={doc}>docs/brand/concept.md</span>.
            </p>
          </div>
        </div>
      </Section>

      <Section
        id="story"
        n={`${num('story')} · Сторителлинг`}
        heading="Легенда"
        lead="Легенда «Квас делают люди» о том, что умение делать квас пришло от людей и сейчас его передают люди. В ней только факты из материалов компании. Она живёт на главной, в боте, у Квасыча, на экскурсии и в музее."
      >
        <ol className="grid gap-px bg-white/10 md:grid-cols-2 lg:grid-cols-4">
          {timeline.map((t) => (
            <li key={t.id} className="bg-coal p-6">
              <p className="font-display text-[64px] leading-none font-black text-brand">{t.when}</p>
              <p className="mt-4 font-display text-[24px] leading-[0.95] font-extrabold uppercase">{nb(t.title)}</p>
              <p className="mt-3 text-[15px] leading-relaxed text-white/70">{nb(t.text)}</p>
            </li>
          ))}
        </ol>
        <p className={`${body} mt-10 max-w-3xl`}>
          {nb('К каждому новичку прикрепляют наставника, опытного сотрудника, который прошёл обучение в Учебном центре. Квасыч собирает черты таких наставников в одном персонаже: на сайте и в боте он подскажет, где что, а на заводе учит настоящий наставник.')}
        </p>
      </Section>

      <Section
        id="visuals"
        n={`${num('visuals')} · Визуальные материалы`}
        heading="Листовки и стенд"
        lead="Макеты для печати в натуральную величину: открываются в браузере и сохраняются в PDF, для типографии есть версия с вылетами и метками реза. QR на каждом носителе ведёт на сайт с меткой точки контакта из вкладки HR «Источники». Фото в макетах пока черновые, это кадры из роликов компании. Для тиража нужна фотосъёмка."
      >
        <div className="grid gap-12 lg:grid-cols-3">
          {leaflets.map((l) => (
            <div key={l.href}>
              <div className="grid grid-cols-2 gap-3">
                {l.img.map((i, k) => (
                  <a key={i} href={l.href} target="_blank" rel="noreferrer" className="group block" aria-label={`${l.heading}, ${k ? 'оборот' : 'лицевая'}: открыть макет`}>
                    <img src={`${M}/img/${i}.webp`} width={640} height={l.h} alt="" loading="lazy" decoding="async" className="block aspect-[148/210] w-full bg-coal object-cover transition-opacity group-hover:opacity-85" />
                    <span className="mt-2 block text-[13px] tracking-[0.06em] text-white/60 uppercase">{k ? 'оборот' : 'лицевая'}</span>
                  </a>
                ))}
              </div>
              <h3 className={`${h3} mt-5`}>{nb(l.heading)}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-white/70">{nb(l.text)}</p>
              <div className="mt-3">
                <Open href={l.href}>Макет</Open>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-20 grid gap-12 md:grid-cols-[minmax(0,0.55fr)_minmax(0,1fr)]">
          <Figure
            src={`${M}/img/stand-rollup.webp`}
            w={480}
            h={1044}
            box="aspect-[850/1850]"
            alt="Ролл-ап: знак и сумма сверху, QR и фото наставника с новичком посередине"
            text="Ролл-ап 850 × 2000 мм, видимая часть 1850 мм. Знак и сумма на уровне глаз, QR 250 мм на высоте 1050–1300 мм от пола"
            className="mx-auto w-full max-w-[300px]"
          />
          <div>
            <Figure
              src={`${M}/img/stand-tent.webp`}
              w={640}
              h={906}
              box="aspect-[210/297]"
              alt="Табличка на стол: сторона для посетителя и перевёрнутая шпаргалка для сотрудника"
              text="Табличка A4 складывается домиком: нижняя половина смотрит на посетителя, верхняя перевёрнута и служит шпаргалкой для сотрудника за столом"
              className="max-w-[420px]"
            />
            <h3 className={`${h3} mt-8`}>Стенд на ярмарке</h3>
            <p className="mt-3 text-[15px] leading-relaxed text-white/75">
              {nb(`Ролл-ап отвечает издалека: что за работа, ${pay} в месяц, наставник, общежитие для студентов ${formatRub(dorm.priceStudent)}, автобус от м. «Озёрная», QR на заявку. На табличке для стола сторона посетителя предлагает «7 вопросов о заводе кваса» и носки за ответы без ошибок, а сторона сотрудника подсказывает, как вести человека у стенда.`)}
            </p>
            <div className="mt-4 flex flex-col gap-1">
              <Open href={`${M}/stand/rollup.html`}>Ролл-ап</Open>
              <Open href={`${M}/stand/table-tent.html`}>Табличка на стол</Open>
            </div>
          </div>
        </div>
        <div className="mt-20 grid gap-10 md:grid-cols-2">
          <div>
            <h3 className={h3}>Маскот Квасыч</h3>
            <p className="mt-3 text-[15px] leading-relaxed text-white/75">
              {nb('Мастер-наставник, нарисован по образу наставников «Очаково». В боте и на сайте он ведёт кандидата: отвечает на вопросы о работе, подсказывает задания, напоминает о собеседовании. На печати он маленький и всегда стоит рядом с настоящими людьми. Нарисовано 15 поз, из них собран стикерпак ниже. Роль, позы и подписи описаны в ')}
              <span className={doc}>docs/kvasych.md</span>.
            </p>
          </div>
          <div>
            <h3 className={h3}>Фирменный стиль</h3>
            <p className="mt-3 text-[15px] leading-relaxed text-white/75">{nb('Официальный логотип, красный и белый по брендбуку, фирменные пиктограммы процессов, оборудования и сырья, из них взяты только подходящие безалкогольным напиткам.')}</p>
            <div className="mt-5 flex flex-wrap gap-3" aria-hidden="true">
              {['kettle', 'cct', 'pet-bottle', 'control', 'barley', 'cycle', 'hopper', 'citrus'].map((p) => (
                <img key={p} src={`/brand/pictograms/${p}.svg`} alt="" width={48} height={48} className="size-12 rounded-sm bg-white p-1" loading="lazy" />
              ))}
            </div>
          </div>
        </div>
        <div className="mt-20">
          <h3 className={h3}>Стикерпак для Telegram</h3>
          <p className="mt-3 max-w-[760px] text-[15px] leading-relaxed text-white/75">
            {nb('15 стикеров из поз Квасыча с короткими подписями. Подписи годятся для любого чата, рекламы в них нет: стикеры отправляют друзьям. В название набора ставим имя бота, поэтому каждый отправленный стикер напоминает о Квасыче. Файлы готовы для бота @Stickers: 512 × 512 px, PNG с прозрачным фоном.')}
          </p>
          <ul className="mt-8 grid max-w-[1000px] grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-5">
            {stickers.map(([file, text]) => (
              <li key={file}>
                <a href={`${M}/stickers/${file}.png`} download className="group block" aria-label={`Стикер «${text}»: скачать PNG`}>
                  <img src={`${M}/stickers/preview/${file}.webp`} width={256} height={256} alt="" loading="lazy" decoding="async" className="block w-full transition-opacity group-hover:opacity-85" />
                </a>
              </li>
            ))}
          </ul>
          <div className="mt-6">
            <Open href={`${M}/stickers/kvasych-stickers.zip`} download>
              Скачать набор, ZIP 2 МБ
            </Open>
          </div>
        </div>
      </Section>

      <Section
        id="merch"
        n={`${num('merch')} · Мерч`}
        heading="Коллекция «Смена»"
        lead="Вещи, которые носят и после завода. На каждой то, что знают только свои, логотип маленький. Получить их можно только за шаг на заводе: экскурсию, первую смену, месяц, друга на смене, законченную практику. Купить нельзя, за одну заявку не дают."
      >
        <div className="grid gap-x-8 gap-y-10 md:grid-cols-2">
          <Figure
            src={`${M}/img/merch-jacket.webp`}
            w={677}
            h={542}
            box="aspect-[5/4]"
            alt="Рабочая куртка «Очаково» с надписью «Я делаю натуральные напитки» на спине"
            text="Откуда вещь: надпись на спинах рабочих курток. Кадр из ролика компании «Оператор линии розлива»"
          />
          <Figure
            src={`${M}/img/merch-hoodie.webp`}
            w={1000}
            h={827}
            box="aspect-[5/4] bg-[#f3f1ed]"
            fit="object-contain"
            alt="Худи «Я делаю натуральные напитки»: спина и перед"
            text="Худи с той же надписью «Я делаю натуральные напитки» выдают за законченную практику, на груди пиктограмма своего отдела"
          />
        </div>
        <ul className="mt-14 grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
          {merch.map((m) => (
            <li key={m.img}>
              <a href={`${M}/merch/layouts.html#${m.anchor}`} target="_blank" rel="noreferrer" className="group block" aria-label={`${m.heading}: технический рисунок`}>
                <img src={`${M}/img/${m.img}.webp`} width={1000} height={700} alt="" loading="lazy" decoding="async" className="block aspect-[10/7] w-full bg-[#f3f1ed] object-contain transition-opacity group-hover:opacity-90" />
              </a>
              <h3 className="mt-5 font-display text-[24px] leading-[0.95] font-extrabold uppercase">{nb(m.heading)}</h3>
              <p className="mt-2 text-[15px] text-white/70">{nb(m.why)}</p>
            </li>
          ))}
          <li className="flex flex-col justify-end border-t border-white/15 pt-5 text-[15px] leading-relaxed text-white/70">
            {nb('Ещё в коллекции лента с чехлом для пропуска, её выдают в первую смену, и нашивка «Наставник» для сотрудников после Учебного центра.')}
          </li>
        </ul>
        <div className="mt-16 border-t border-white/15 pt-10">
          <h3 className={h3}>{nb('Технические рисунки и файлы для производства')}</h3>
          <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-white/75">
            {nb('Рисунки изделий с принтами в масштабе и характеристиками для подрядчика. Принты сделаны векторными файлами в натуральную величину: размеры в миллиметрах, текст в кривых, у наклеек контур высечки, у носков сетка петель. Цена коллекции на сезон и минимальный набор для пилота описаны в ')}
            <span className={doc}>docs/brand/merch.md</span>.
          </p>
          <div className="mt-4">
            <Open href={`${M}/merch/layouts.html`}>Технические рисунки</Open>
          </div>
          <ul className="mt-6 border-t border-white/15">
            {prints.map((p) => (
              <li key={p.file} className="grid gap-x-8 gap-y-1 border-b border-white/15 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center">
                <span className="text-[16px] font-semibold text-white">{p.heading}</span>
                <span className="text-[15px] text-white/65">{nb(`${p.size}, текст в кривых`)}</span>
                <span className="flex flex-wrap gap-x-6">
                  <Open href={`${M}/merch/layouts.html#${p.anchor}`}>На изделии</Open>
                  <Open href={`${M}/merch/art/${p.file}.svg`} download>
                    Скачать SVG
                  </Open>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section
        id="clips"
        n={`${num('clips')} · Видеоролик о компании`}
        heading="12 выпусков на первый месяц"
        lead="Главный канал охвата: VK Клипы. Те же ролики идут в YouTube Shorts, Telegram, MAX и Дзен. Рубрики: «Квасыч отвечает», «Поймай брак», «Первый день», «Тогда и сейчас», «Сколько за лето», тренд недели. У каждого ролика своя метка, и «Воронка» показывает, какой из них довёл людей до смены."
      >
        <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-6">
          {covers.map(([n, rubric]) => (
            <li key={n}>
              <a href={`${M}/clips/covers/clip-${n}.webp`} target="_blank" rel="noreferrer" className="block">
                <img src={`${M}/clips/covers/clip-${n}.webp`} alt={`Обложка выпуска ${n}, рубрика «${rubric}»`} width={1080} height={1920} loading="lazy" decoding="async" className="block aspect-[9/16] w-full bg-coal" />
              </a>
              <p className="mt-2 text-[14px] leading-snug text-white/65">
                <span className="text-white">{n}</span> · {nb(rubric)}
              </p>
            </li>
          ))}
          <li>
            <a href={`${M}/clips/covers/template-subtitles.webp`} target="_blank" rel="noreferrer" className="block">
              <img src={`${M}/clips/covers/template-subtitles.webp`} alt="Шаблон титров: две строки на тёмной плашке" width={1080} height={1920} loading="lazy" decoding="async" className="block aspect-[9/16] w-full bg-coal" />
            </a>
            <p className="mt-2 text-[14px] leading-snug text-white/65">Шаблон титров</p>
          </li>
        </ul>
        <div className="mt-10 grid gap-8 md:grid-cols-2">
          <p className="text-[15px] leading-relaxed text-white/75">
            {nb('Обложки 1080 × 1920 готовы к загрузке. Выпуск 06 «Сколько за лето» сделан шаблоном: сумму и кадр даёт практикант прошлого сезона, обложка с местом под них лежит в макете. Сценарии с первым кадром, титрами, метками и списком кадров на один съёмочный день описаны в ')}
            <span className={doc}>docs/brand/clips.md</span>.
          </p>
          <div className="flex flex-col gap-1">
            <Open href={`${M}/clips/covers.html`}>Обложки, титры и зоны интерфейса</Open>
          </div>
        </div>
      </Section>

      <Section
        id="rationale"
        n={`${num('rationale')} · Обоснование и аналитика`}
        heading="Что меняется для компании"
        lead="Решение отвечает на основную проблему кейса и на второстепенные, цифры компании стоят рядом с цифрами панели. Каждый ответ можно проверить в «Воронке» HR-панели."
      >
        <div className="border-t border-white/15">
          <div aria-hidden="true" className="hidden gap-8 border-b border-white/15 py-3 text-[13px] font-semibold tracking-[0.06em] text-white/55 uppercase md:grid md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)_minmax(0,0.8fr)]">
            <span>Проблема кейса</span>
            <span>Что делаем</span>
            <span>Чем меряем</span>
          </div>
          {problems.map(([p, what, metric]) => (
            <div key={p} className="grid gap-3 border-b border-white/15 py-5 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)_minmax(0,0.8fr)] md:gap-8">
              <p className="font-display text-[24px] leading-[0.95] font-extrabold uppercase">{nb(p)}</p>
              <p className="text-[15px] leading-relaxed text-white/75">{nb(what)}</p>
              <p className="text-[14px] text-white/60">
                <span className="text-white/80 md:sr-only">Метрика: </span>
                {nb(metric)}
              </p>
            </div>
          ))}
        </div>

        <h3 className={`${h3} mt-16`}>Цели сезона</h3>
        <ol className="mt-6 grid grid-cols-2 gap-px bg-white/10 md:grid-cols-3 lg:grid-cols-6">
          {funnel.map(([v, label]) => (
            <li key={label} className="bg-coal p-5">
              <p className="font-display text-[44px] leading-none font-black tabular-nums">{v}</p>
              <p className="mt-2 text-[14px] text-white/65">{label}</p>
            </li>
          ))}
        </ol>

        <h3 className={`${h3} mt-16`}>Календарь кампании</h3>
        <ol className="mt-6 border-t border-white/15">
          {calendar.map(([when, stage, what]) => (
            <li key={when} className="grid gap-2 border-b border-white/15 py-4 md:grid-cols-[13rem_11rem_minmax(0,1fr)] md:gap-8">
              <span className="font-display text-[22px] leading-none font-extrabold text-brand-bright uppercase">{nb(when)}</span>
              <span className="font-display text-[22px] leading-none font-extrabold uppercase">{stage}</span>
              <span className="text-[15px] leading-relaxed text-white/70">{nb(what)}</span>
            </li>
          ))}
        </ol>

        <h3 className={`${h3} mt-16`}>{nb('Эффект оправдывает затраты')}</h3>
        <ul className="mt-6 grid gap-px bg-white/10 md:grid-cols-3">
          {costs.map(([v, label]) => (
            <li key={v} className="bg-coal p-6">
              <p className="font-display text-[clamp(36px,3.6vw,52px)] leading-none font-black whitespace-nowrap uppercase tabular-nums">{v}</p>
              <p className="mt-3 text-[15px] leading-relaxed text-white/70">{nb(label)}</p>
            </li>
          ))}
        </ul>
        <p className="mt-6 max-w-3xl text-[15px] leading-relaxed text-white/75">
          {nb('Пилот оправдан, если рубли за выход на смену ниже нынешней стоимости найма практиканта. Эту стоимость знает компания, а «Воронка» считает цифру по каждой метке. Каждый платный канал сначала тестируем две недели, затем бюджет уходит туда, где выход на смену дешевле. Мерч растёт только вместе с результатом: от 854 до 1413 тыс. ₽ на сезон, минимальный набор для пилота стоит от 445 до 770 тыс. ₽. Все цены остаются допущениями команды, расчёт лежит в ')}
          <span className={doc}>docs/strategy.md</span>.
        </p>
      </Section>

      <Section id="ideas" n={`${num('ideas')} · Новаторские идеи`} heading="Что придумали сами">
        <ul className="grid gap-px bg-white/10 md:grid-cols-2">
          {ideas.map(([heading, text]) => (
            <li key={heading} className="bg-coal p-6">
              <p className="font-display text-[24px] leading-[0.95] font-extrabold uppercase">{nb(heading)}</p>
              <p className="mt-2 text-[15px] leading-relaxed text-white/70">{nb(text)}</p>
            </li>
          ))}
          <li className="bg-coal p-6 text-[15px] leading-relaxed text-white/70">
            {nb('Аналоги («Мармеладыч», лендинг «Боржоми», страница «Северстали» для студентов, X5) и что у них взяли и не взяли: ')}
            <span className={doc}>docs/analytics.md</span>.
          </li>
        </ul>
      </Section>

      <Section id="check" n={`${num('check')} · Как проверить`} heading="Пять минут на всё">
        <ol className="grid gap-px bg-white/10 md:grid-cols-2 lg:grid-cols-3">
          {[
            ['Пройти путь кандидата', 'Главная → задание «Поймай брак» → «Собери лето» → заявка. Счётчик «Смена N/4» в шапке растёт, задания заполняют анкету.'],
            ['Игры во весь экран', 'Страница /play: шесть игр по одной на экран. Так их открывает бот в Telegram, «Дальше» ведёт к следующему заданию.'],
            ['Спросить Квасыча', 'Чат внизу страницы: «сколько платят», «где жить», «можно ли совмещать с сессией». На стенде отвечает GigaChat, без ключа готовые ответы из той же базы.'],
            ['Проверить метку источника', 'Открыть сайт по ссылке /?src=fair-mgupp и отправить заявку. В HR-панели у неё будет источник «Ярмарка МГУПП», а в «Воронке» своя строка.'],
            ['Открыть HR-панель', 'Логин и пароль для жюри передаём вместе с решением. На стенде уже есть демо-заявки: собеседования, день найма, первые недели, «Воронка».'],
            ['Анкета фокус-группы', 'Открыть /focus?s=fg-a, ответить и посмотреть счёт во вкладке «Фокус-группа».'],
            ['Макеты в натуральную величину', 'Листовка, вкладыш, памятка, ролл-ап, табличка и мерч открываются по ссылкам выше и печатаются в PDF. QR на них ведут на этот стенд.'],
            ['Стикеры', 'Набор Квасыча для Telegram: 15 PNG одним архивом в разделе «Визуальные материалы».'],
            ['Посмотреть презентацию', 'Кнопка «Презентация HR-бренда» в начале страницы: 31 слайд, листать стрелками, F открывает во весь экран. Там же PDF.'],
          ].map(([t, d], i) => (
            <li key={t} className="bg-coal p-6">
              <p className="font-display text-[44px] leading-none font-black text-brand">{i + 1}</p>
              <p className="mt-3 font-display text-[24px] leading-[0.95] font-extrabold uppercase">{nb(t)}</p>
              <p className="mt-2 text-[15px] leading-relaxed text-white/70">{nb(d)}</p>
            </li>
          ))}
        </ol>
        <h3 className={`${h3} mt-16`}>Документы в репозитории</h3>
        <ul className="mt-6 grid border-t border-white/15">
          {docs.map(([path, what]) => (
            <li key={path} className="grid gap-1 border-b border-white/15 py-3 md:grid-cols-[minmax(0,0.6fr)_minmax(0,1.4fr)] md:gap-8">
              <span className="font-mono text-[14px] whitespace-nowrap text-white">{path}</span>
              <span className="text-[15px] text-white/65">{nb(what)}</span>
            </li>
          ))}
        </ul>
      </Section>

      <footer className="border-t border-white/15 py-10">
        <div className="container-x flex flex-col justify-between gap-4 text-[14px] text-white/55 md:flex-row">
          <p>{nb('Факты о компании взяты из материалов «Очаково» и ochakovo.ru. Логотип, фото и ролики компании здесь для согласования: разрешение на публикацию даёт «Очаково».')}</p>
          <Link to="/" className="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">
            Сайт для кандидата
          </Link>
        </div>
      </footer>
    </div>
  )
}
