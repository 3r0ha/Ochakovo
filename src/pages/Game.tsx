import { useEffect, useMemo, useRef } from 'react'
import { Link, useSearchParams } from 'react-router'
import { COMPANY_QUIZ_ROUND, companyQuizPromise } from '@shared/content/companyQuiz'
import { formatRub, minMonthlyPay } from '@shared/content/vacancies'
import { parseChallenge, type Challenge } from '../game/challenge'
import { CompanyQuiz } from '../game/CompanyQuiz'
import { btnRed, InlineGame, NIGHT } from '../game/InlineGame'
import { GAME_SECONDS, type GameStats } from '../game/useConveyorGame'
import { scrollToTop } from '../lib/motion'
import { nb } from '../lib/typo'

/** Строка о работе в первом экране: сумма — нижняя граница зарплат без опыта из shared, не ориентир */
const GAME_JOB_LINE = nb(`Летняя работа на этом заводе от ${formatRub(minMonthlyPay)} в месяц`)

/** Два режима одной страницы: «Поймай брак» (/game) и викторина — контрольные вопросы о компании (/game?t=quiz) */
type Mode = 'game' | 'quiz'

const modes: { id: Mode; label: string; to: string; title: string }[] = [
  { id: 'game', label: 'Поймай брак', to: '/game', title: 'Поймай брак' },
  { id: 'quiz', label: 'Викторина', to: '/game?t=quiz', title: `${COMPANY_QUIZ_ROUND} вопросов об «Очаково»` },
]

/** «Поймай брак» на отдельной странице (та же игра, что на главной, плюс подробности раунда) и контрольные вопросы */
export function Game() {
  const [params] = useSearchParams()
  const mode: Mode = params.get('t') === 'quiz' ? 'quiz' : 'game'
  // Вызов друга ?c=…: неверное значение молча не замечаем — обычная игра
  const raw = params.get('c')
  const challenge = useMemo(() => parseChallenge(raw), [raw])
  useModeChange(mode)

  return (
    <div className="text-white" data-surface="dark" style={{ background: NIGHT }}>
      <div className="container-x pt-24 pb-20 md:pt-36 md:pb-28">
        <ModeSwitch mode={mode} />
        {/* Новая ссылка с вызовом — новая игра с её лентой */}
        {mode === 'quiz' ? <QuizMode /> : <GameMode key={challenge ? raw : ''} challenge={challenge} />}
      </div>
    </div>
  )
}

/**
 * Заголовок вкладки по режиму и переход между режимами. Шапка сайта ставит заголовок по адресу без параметров, поэтому
 * свой — кадром позже, поверх. Смена режима — тот же адрес, и шапка не переводит фокус: переводим сами, на новый h1
 */
function useModeChange(mode: Mode) {
  const shown = useRef(mode)
  useEffect(() => {
    const title = modes.find((m) => m.id === mode)!.title
    const frame = requestAnimationFrame(() => {
      const site = document.title.includes(' — ') ? document.title.slice(document.title.indexOf(' — ')) : ''
      document.title = `${title}${site}`
    })
    if (shown.current !== mode) {
      shown.current = mode
      scrollToTop()
      const h1 = document.querySelector<HTMLElement>('#main h1')
      if (h1) {
        h1.setAttribute('tabindex', '-1')
        h1.focus({ preventScroll: true })
      }
    }
    return () => cancelAnimationFrame(frame)
  }, [mode])
}

/** Переключатель режимов: две ссылки, текущая подчёркнута красным */
function ModeSwitch({ mode }: { mode: Mode }) {
  return (
    <nav aria-label="Игры на этой странице" className="mb-8 md:mb-10">
      <ul className="flex flex-wrap gap-x-7 gap-y-2">
        {modes.map((m) => {
          const on = m.id === mode
          return (
            <li key={m.id}>
              <Link
                to={m.to}
                aria-current={on ? 'page' : undefined}
                className={`-my-2 inline-block py-2 font-display text-[17px] font-bold tracking-[0.08em] uppercase transition-colors ${
                  on ? 'text-white' : 'text-white/60 hover:text-white'
                }`}
              >
                <span className={`block border-b-[3px] pb-1 ${on ? 'border-brand' : 'border-transparent'}`}>{m.label}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

function GameMode({ challenge }: { challenge: Challenge | null }) {
  return (
    <>
      <p className="font-display text-[17px] font-bold tracking-[0.08em] text-white/75 uppercase">Игра на {GAME_SECONDS} секунд</p>
      {/* На телефоне заголовок скромнее: «Играть» должна попасть в первый экран и на 360 × 740 */}
      <h1 className="display mt-3 text-[clamp(60px,14vw,240px)] md:mt-4">
        Поймай <span className="text-brand">брак</span>
      </h1>

      <InlineGame
        className="mt-6 -mx-5 md:mx-0 md:mt-10"
        challenge={challenge}
        resultExtras={(stats) => <ResultExtras stats={stats} />}
      />

      {/* Ради чего игра: работа на этом заводе — сразу под лентой. Над ней строка уводила бы от игры, ради которой пришли */}
      <div className="mt-8 flex flex-col gap-4 border-t border-white/25 pt-6 sm:flex-row sm:items-center sm:gap-8 md:mt-10" data-game-job>
        <p className="max-w-[520px] text-[19px] leading-snug md:text-[22px] lg:max-w-none">{GAME_JOB_LINE}</p>
        <Link to="/apply" className={`${btnRed} w-fit shrink-0`}>
          Откликнуться
        </Link>
      </div>
    </>
  )
}

/**
 * Контрольные вопросы на знание компании (кейс: «интерактивный блок с контрольными вопросами»): случайные вопросы
 * из shared/content/companyQuiz.ts, после ответа — объяснение, в конце — счёт и ссылка на практику
 */
function QuizMode() {
  return (
    <>
      <p className="font-display text-[17px] font-bold tracking-[0.08em] text-white/75 uppercase">Викторина</p>
      {/* На ноутбуке — одной строкой: первый вопрос должен попасть в первый экран */}
      <h1 className="display mt-4 text-[clamp(60px,7.4vw,116px)]">
        {COMPANY_QUIZ_ROUND} вопросов <br className="lg:hidden" />
        об&nbsp;<span className="text-brand">«Очаково»</span>
      </h1>
      <p className="mt-5 max-w-[620px] text-[17px] leading-relaxed text-white/80 md:mt-6 md:text-[19px]">
        {nb(`История, квас, деньги и практика. ${companyQuizPromise()}`)}
      </p>

      <CompanyQuiz tone="dark" size="page" level="h2" className="mt-12 md:mt-14" />
    </>
  )
}

function ResultExtras({ stats }: { stats: GameStats }) {
  // Очки и пойманное уже на экране итогов — здесь подробности раунда
  const rows = [
    { label: 'Пропущено брака', value: stats.missed },
    { label: 'Лишние нажатия', value: stats.mistakes },
    { label: 'Лучшая серия', value: `×${stats.maxMult}` },
  ]

  return (
    <dl className="mt-4 grid grid-cols-3 gap-x-6 lg:max-w-[720px]">
      {rows.map((r) => (
        <div key={r.label} className="border-t border-white/25 py-4">
          <dt className="text-[14px] text-white/75">{r.label}</dt>
          <dd className="display mt-1 text-[40px] tabular-nums">{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}
