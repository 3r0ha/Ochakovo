import type { Application, GameSnapshot, StartReady } from './applications'
import { mskToday } from './birthDate'
import { departmentList } from './content/departments'
import { vacancies } from './content/vacancies'

// Демо-заявки для HR-панели — одинаковые на сервере и в запасном режиме сайта.
// Имена, вузы и ники выдуманы; вакансии и направления — из shared/content.
// Поля кейса — как в новой анкете: дата рождения (только 18+, от текущего момента), когда может выйти, вуз или «Уже не учусь».

const demoNames = [
  'Анна К.', 'Иван С.', 'Мария Л.', 'Артём В.', 'Софья Н.', 'Дмитрий П.', 'Алина Г.', 'Кирилл М.',
  'Полина Р.', 'Егор Ф.', 'Вероника Т.', 'Никита Б.', 'Дарья Ж.', 'Тимур А.', 'Ксения Е.', 'Максим Ч.',
  'Ева Ш.', 'Георгий О.', 'Злата И.', 'Роман Д.', 'Ульяна Х.', 'Лев Ц.', 'Яна Ю.', 'Марк З.',
]
const demoUniversities = ['МГУПП', 'Московский Политех', 'РХТУ им. Менделеева', 'МГТУ им. Баумана', 'РЭУ им. Плеханова', 'НИТУ МИСИС']
const demoColleges = ['Колледж № 32', 'Колледж пищевых технологий']
const demoUniversityCourses = ['Вуз: 1–2 курс', 'Вуз: 3–4 курс', 'Магистратура', 'Выпускник']
const demoCollegeCourses = ['Колледж: 1–2 курс', 'Колледж: 3–4 курс', 'Выпускник']
const demoSources = ['fair-mgupp', 'fair-mospolytech', 'fair-misis', 'vk', null, null]
const demoChannels = ['web', 'web', 'web', 'telegram', 'max'] as const

/** Задания смены — те же id, что в событиях воронки сайта и в прогрессе бота */
export const demoTaskIds = ['game', 'money', 'quiz', 'myth'] as const
export type DemoTask = (typeof demoTaskIds)[number]

const pick = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)]
const shuffle = <T,>(list: readonly T[]) => [...list].sort(() => Math.random() - 0.5)

/** Возраст по курсу, полных лет: колледж с 1–2 курса бывает и в 16, но в демо — только те, кому уже есть 18 */
const ageByCourse: Record<string, [min: number, max: number]> = {
  'Вуз: 1–2 курс': [18, 20],
  'Вуз: 3–4 курс': [20, 22],
  Магистратура: [22, 25],
  'Колледж: 1–2 курс': [18, 19],
  'Колледж: 3–4 курс': [18, 20],
  Выпускник: [20, 26],
}

/**
 * Дата рождения YYYY-MM-DD: от minAge до maxAge полных лет на сегодня по Москве. День рождения — от 2 до 350 дней
 * назад, поэтому возраст ровно выбранный и не меняется в ближайшие дни показа
 */
export function demoBirthDate(minAge: number, maxAge: number, now = Date.now()) {
  const [y, m, d] = mskToday(now).split('-').map(Number)
  const age = minAge + Math.floor(Math.random() * (maxAge - minAge + 1))
  const birthday = new Date(Date.UTC(y - age, m - 1, Math.min(d, 28)) - (2 + Math.floor(Math.random() * 349)) * 864e5)
  return birthday.toISOString().slice(0, 10)
}

/** Когда может выйти: чаще всего после сессии или сразу; «с месяца» — с первого месяца из заявки, у каждого седьмого — всегда */
function demoStart(months: number[], i: number): { startReady: StartReady; startMonth: number | null } {
  const r = i % 7 === 2 ? 1 : Math.random()
  if (r < 0.35) return { startReady: 'after_session', startMonth: null }
  if (r < 0.6) return { startReady: 'now', startMonth: null }
  if (r < 0.8 || !months.length) return { startReady: 'two_weeks', startMonth: null }
  return { startReady: 'month', startMonth: months[0] }
}

/** Короткий читаемый номер заявки: 8 символов без похожих букв */
export function makeApplicationId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 8 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
}

/**
 * Какие задания прошёл демо-кандидат — по снимку игры: подбор работы — если есть направление,
 * «Поймай брак» — если есть счёт, остальное добирается «Собери лето» и «Правдой или мифом»
 */
export function demoTaskList(game: GameSnapshot): DemoTask[] {
  const done: DemoTask[] = []
  if (game.quizResult) done.push('quiz')
  if (game.conveyorBest > 0) done.push('game')
  for (const t of ['money', 'myth'] as const) if (done.length < (game.activities ?? 0)) done.push(t)
  return done
}

/** Сколько заданий прошёл кандидат: примерно пятая часть — ни одного, треть — все четыре */
function demoGame(dept: Application['department']): GameSnapshot {
  const r = Math.random()
  const count = r < 0.2 ? 0 : r < 0.68 ? 1 + Math.floor(Math.random() * 3) : 4
  const tasks = new Set(shuffle(demoTaskIds).slice(0, count))
  return {
    quizResult: tasks.has('quiz') && dept ? dept : null,
    conveyorBest: tasks.has('game') ? Math.round(60 + Math.random() * 150) : 0,
    activities: count,
  }
}

export function demoApplications(count = 24): Application[] {
  const now = Date.now()
  return Array.from({ length: count }, (_, i) => {
    const dept = pick(departmentList).id
    const isCollege = Math.random() < 0.3
    const vacancy = pick(vacancies.filter((v) => v.department === dept))
    const start = 3 + Math.floor(Math.random() * 4)
    const channel = pick(demoChannels)
    const course = isCollege ? pick(demoCollegeCourses) : pick(demoUniversityCourses)
    // Выпускник чаще отмечает «Уже не учусь», чем пишет вуз; каждый девятый в наборе уже не учится — так вариант есть всегда
    const notStudying = (course === 'Выпускник' && Math.random() < 0.6) || i % 9 === 4
    const months = Array.from({ length: 2 + Math.floor(Math.random() * 4) }, (_, k) => start + k).filter((m) => m <= 9)
    const [minAge, maxAge] = ageByCourse[course] ?? [18, 22]
    const format = vacancy?.format ?? ''
    return {
      id: makeApplicationId(),
      createdAt: new Date(now - Math.random() * 14 * 864e5).toISOString(),
      channel,
      name: demoNames[i % demoNames.length],
      phone: '+7 9' + String(Math.floor(1e8 + Math.random() * 9e8)),
      contact: '@student' + (100 + i),
      school: notStudying ? '' : isCollege ? pick(demoColleges) : pick(demoUniversities),
      course: notStudying ? '' : course,
      notStudying,
      birthDate: demoBirthDate(minAge, maxAge, now),
      ...demoStart(months, i),
      // Практика от вуза — у студентов, которые идут на практику
      practiceSchool: !notStudying && course !== 'Выпускник' && /практика/i.test(format) && Math.random() < 0.6,
      wantsToStay: Math.random() < 0.25,
      department: dept,
      vacancyId: vacancy?.id ?? '',
      format,
      months,
      comment: '',
      game: demoGame(dept),
      source: channel === 'web' ? pick(demoSources) : channel,
    }
  })
}
