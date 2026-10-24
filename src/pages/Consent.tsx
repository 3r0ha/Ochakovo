import type { ReactNode } from 'react'
import { CONSENT_VERSION } from '@shared/applications'
import { contacts } from '@shared/content/content'
import { operator, useProcessors, type Processors } from '../components/candidate/legal'
import { ButtonLink } from '../home/kit'
import { nb } from '../lib/typo'

// Текст согласия на обработку персональных данных (152-ФЗ, ст. 9): его принимают отметкой в форме заявки
// и кнопкой «Даю согласие, отправить» в чате и ботах. Версия — CONSENT_VERSION: сервер принимает заявку
// только с действующей версией, поэтому любая правка текста меняет номер (shared/applications.ts).

type Section = { title: string; body: ReactNode }

const mail = (subject: string) => `mailto:${contacts.email}?subject=${encodeURIComponent(subject)}`
const link = 'underline underline-offset-4 hover:text-brand'

const sections = (processors: Processors): Section[] => [
  {
    title: 'Кому',
    body: (
      <p>
        {nb(`Оператору персональных данных: ${operator.name}, ${operator.address}. `)}
        <span className="whitespace-nowrap">ИНН {operator.inn}</span>, <span className="whitespace-nowrap">ОГРН {operator.ogrn}</span>.
      </p>
    ),
  },
  {
    title: 'Зачем',
    body: (
      <ul className="space-y-3">
        <li>{nb('Рассмотреть заявку на оплачиваемую или бесплатную практику или на работу.')}</li>
        <li>{nb('Проверить возраст: на работу, стажировку и практику берут с 18 лет.')}</li>
        <li>{nb('Связаться по заявке: позвонить, написать в мессенджер или отправить SMS.')}</li>
        <li>{nb('Пригласить на собеседование и оформить на работу.')}</li>
        <li>{nb('Узнать, как проходят первые недели работы, и помочь, если тяжело.')}</li>
        <li>{nb('Предложить другую вакансию, если она откроется, пока данные хранятся.')}</li>
      </ul>
    ),
  },
  {
    title: 'Какие данные',
    body: (
      <ul className="space-y-3">
        <li>{nb('Фамилия, имя, отчество, дата рождения, телефон или ник в Telegram или MAX.')}</li>
        <li>{nb('Учёба: вуз или колледж и курс. Когда можешь выйти на работу, вакансия, направление, формат, месяцы работы, комментарий.')}</li>
        <li>{nb('Ответы анкеты: гражданство, медкнижка, подходящие смены, ссылка на портфолио.')}</li>
        <li>{nb('Отметки «Уже не учусь», «Практика от вуза», «Хочу остаться после сезона». Имя друга, если идёшь вместе.')}</li>
        <li>{nb('Результаты заданий на сайте: итог подбора работы, сколько заданий пройдено, лучший счёт контрольных вопросов о компании, рекорд в «Поймай брак», если включено «Показать результат игры».')}</li>
        <li>{nb('Откуда пришла заявка: метка в ссылке и код приглашения.')}</li>
        <li>{nb('Ответы на вопрос «Как дела на смене» в первые недели работы: всё нормально, есть вопрос или тяжело и что тяжелее всего.')}</li>
        <li>{nb('В чате на сайте и в ботах Telegram и MAX: id и имя профиля, ник и шаг разговора.')}</li>
      </ul>
    ),
  },
  {
    title: 'Что с ними делаем',
    body: (
      <p>
        {nb(
          'С помощью программ и вручную: сбор, запись, систематизация, накопление, хранение, уточнение, извлечение, использование, передача по поручению, обезличивание, блокирование, удаление и уничтожение. Другим компаниям для их целей данные не передаём.',
        )}
      </p>
    ),
  },
  // Поручения — только те, что подключены сейчас: сервер называет их в GET /api/privacy
  ...(processors.yandex360 || processors.sms
    ? [
        {
          title: 'Кто обрабатывает по поручению',
          body: (
            <ul className="space-y-3">
              {processors.yandex360 && <li>{nb('Яндекс 360 для бизнеса: на Яндекс Диске компании лежит таблица заявок для отдела персонала.')}</li>}
              {processors.sms && <li>{nb(`${processors.sms}: отправка SMS с приглашением на собеседование. Сервис получает только номер телефона и текст сообщения.`)}</li>}
            </ul>
          ),
        },
      ]
    : []),
  {
    title: 'Сколько действует',
    body: <p>{nb('Сезон и ещё 12 месяцев после него. Потом данные удаляем или обезличиваем: в отчётах остаются только числа без имён и контактов.')}</p>,
  },
  {
    title: 'Как отозвать',
    body: (
      <>
        <p>
          {nb('Напиши на ')}
          <a className={link} href={mail('Отзыв согласия')}>
            {contacts.email}
          </a>
          {nb(' с темой «Отзыв согласия» и укажи телефон или ник из заявки.')}
        </p>
        <p>{nb('Обработку прекратим, данные удалим не позже чем через 30 дней (так требует ч. 5 ст. 21 закона 152-ФЗ) и больше не будем связываться.')}</p>
      </>
    ),
  },
  {
    title: 'Версия',
    body: (
      <>
        <p>{nb(`Версия текста: ${CONSENT_VERSION}. Если текст изменится, у него будет новый номер, и для новой заявки согласие спросим заново.`)}</p>
        <p>
          {nb('Как устроена работа с данными, описано в ')}
          <a className={link} href="/privacy">
            политике обработки данных
          </a>
          .
        </p>
      </>
    ),
  },
]

export function Consent() {
  const processors = useProcessors()
  return (
    <div className="bg-night pt-[calc(72px+var(--invite-h,0px))] text-white">
      <div className="container-x pt-14 pb-24 md:pt-20 md:pb-32">
        <p className="font-display text-[18px] font-extrabold tracking-[0.06em] text-white/55 uppercase">Персональные данные · версия {CONSENT_VERSION}</p>
        <h1 className="mt-4 max-w-[16ch] font-display text-[clamp(52px,8vw,128px)] leading-[0.86] font-black uppercase">Согласие на обработку данных</h1>
        <p className="mt-8 max-w-[640px] text-lg text-white/80">
          {nb('Ты принимаешь этот текст отметкой «Даю согласие» в заявке на сайте или кнопкой «Даю согласие, отправить» в чате и ботах. Без согласия заявку не принимаем.')}
        </p>

        <ol className="mt-16 border-t border-white/15 md:mt-20">
          {sections(processors).map((s, i) => (
            <li key={s.title} className="grid gap-4 border-b border-white/15 py-8 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-12 md:py-10">
              <h2 className="font-display text-[clamp(26px,2.4vw,34px)] leading-none font-extrabold uppercase">
                <span className="mr-3 text-white/35 tabular-nums">{String(i + 1).padStart(2, '0')}</span>
                {s.title}
              </h2>
              <div className="max-w-[680px] space-y-4 text-[17px] leading-relaxed text-white/80">{s.body}</div>
            </li>
          ))}
        </ol>

        <div className="mt-14 flex flex-col gap-3 sm:flex-row">
          <ButtonLink to="/apply">К заявке</ButtonLink>
          <ButtonLink to="/privacy" variant="ghost">
            Политика обработки данных
          </ButtonLink>
        </div>
      </div>
    </div>
  )
}
