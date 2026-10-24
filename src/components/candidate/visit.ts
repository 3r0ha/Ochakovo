import { contacts, phonebook, phoneLine, routeStations } from '@shared/content/content'
import { dorm, practiceDocs, TRAINING_CENTER_ROOM } from '@shared/content/handbook'

// «Куда ехать и что взять» на странице «Моя заявка» — по справочнику студента (shared/content/handbook.ts, content.ts).
// Без React и браузера: тексты проверяет scripts/tests/w2-pages-chat-status.test.ts.

export type VisitBlock = {
  id: 'route' | 'practice' | 'dorm'
  title: string
  /** Строки блока: первая — главный факт */
  lines: string[]
  /** Список «откуда — как»: дорога по станциям метро, каждая своей строкой */
  list?: { term: string; text: string }[]
  /** Телефон для кнопки «Позвонить»: tel-ссылка без пробелов */
  call?: { label: string; tel: string }
}

const tel = (phone: string) => phone.replace(/[^+\d]/g, '')
const recruiting = phonebook.find((p) => p.id === 'recruiting')!
const training = phonebook.find((p) => p.id === 'training')!
const commandant = phonebook.find((p) => p.id === 'dorm')!

/** Список документов по практике одной строкой: «договор о практике от вуза или колледжа, приказ от «Очаково», …» */
const docsLine = practiceDocs.map((d) => `${d.title.toLowerCase()} (${d.who})`).join(', ')

/**
 * Блоки «Куда ехать и что взять». Дорога — всем: адрес, звонок в отдел подбора до приезда и маршруты по станциям,
 * корпоративный автобус первым. Документы и Учебный центр — заявкам на практику: и оплачиваемую, и бесплатную, и с отметкой
 * «Практика от вуза» (справочник студента: документы для обеих практик одни и те же). Общежитие — всем: иногородним оно важнее всего
 */
export function visitBlocks(practice: boolean): VisitBlock[] {
  const blocks: VisitBlock[] = [
    {
      id: 'route',
      title: 'Дорога',
      lines: [
        // Справочник студента: «До приезда необходимо связаться с отделом подбора»
        `${contacts.address}. Перед приездом позвони в отдел подбора: ${recruiting.phone}, ${recruiting.ext}, или ${recruiting.mobile}.`,
      ],
      list: routeStations.map((r) => ({ term: r.from, text: r.how })),
      call: { label: 'Позвонить в отдел подбора', tel: tel(recruiting.phone) },
    },
  ]
  if (practice)
    blocks.push({
      id: 'practice',
      title: 'Документы по практике',
      lines: [
        `Документы несут в Учебный центр, кабинет ${TRAINING_CENTER_ROOM}. Договор от вуза или колледжа подписывают до начала практики.`,
        `Что понадобится: ${docsLine}.`,
        `${phoneLine(training)}.`,
      ],
    })
  blocks.push({
    id: 'dorm',
    title: 'Если нужно общежитие',
    lines: [
      `${dorm.address}: для студентов ${rub(dorm.priceStudent)} за койко-место, для остальных ${rub(dorm.priceOther)}.`,
      `${capital(dorm.checkIn)}. Есть всё, кроме фена, его стоит взять с собой.`,
      `${phoneLine(commandant)}.`,
    ],
  })
  return blocks
}

/** Заголовок блока: «что взять» — только когда есть что взять, то есть документы по практике */
export const visitTitle = (blocks: VisitBlock[]) => (blocks.some((b) => b.id === 'practice') ? 'Куда ехать и что взять' : 'Дорога и общежитие')

const rub = (n: number) => `${n.toLocaleString('ru-RU').replace(/\s/g, ' ')} ₽`
const capital = (s: string) => s[0].toUpperCase() + s.slice(1)
