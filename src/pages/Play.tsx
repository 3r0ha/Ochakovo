import { useEffect, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { COMPANY_QUIZ_REWARD, companyQuizPassed, companyQuizPromise } from '@shared/content/companyQuiz'
import { CompanyQuiz } from '../game/CompanyQuiz'
import { useCompanyQuiz } from '../game/companyQuizStore'
import { GameSection } from '../home/GameSection'
import { btn, Dash } from '../home/kit'
import { Money } from '../home/Money'
import { MythSection } from '../home/MythSection'
import { ProductionPath } from '../home/ProductionPath'
import { QuizSection } from '../home/QuizSection'
import { TaskNav } from '../home/taskNav'
import { SHIFT_HINT, type Task } from '../home/tasks'
import { scrollToTop } from '../lib/motion'
import { inTelegram } from '../lib/telegram'
import { nb } from '../lib/typo'
import { useActivities, type ActivityId } from '../store/activities'

/**
 * Игры сайта по одной на экран: мини-приложение Telegram (бот открывает его кнопкой web_app) и просто страница /play.
 * Это те же блоки, что на главной. Четыре задания «Смены» идут в том же порядке, «Дальше» открывает следующее
 * на его экране, результаты уходят в заявку так же, как на главной
 */
type GameId = ActivityId | 'company' | 'path'

const games: { id: GameId; title: string; text: string }[] = [
  { id: 'money', title: 'Собери лето', text: 'Выбери работу и месяцы и посмотри, сколько выйдет за лето' },
  { id: 'quiz', title: 'Подбор работы', text: 'Четыре вопроса, и сайт предложит подходящую вакансию' },
  { id: 'game', title: 'Поймай брак', text: '20 секунд на линии розлива: найди бутылки с браком' },
  { id: 'myth', title: 'Правда или миф', text: 'Пять карточек о заводе и работе' },
  { id: 'company', title: 'Викторина', text: `7 вопросов об «Очаково», за 6 верных ${COMPANY_QUIZ_REWARD}` },
  { id: 'path', title: 'Путь кваса', text: 'От зерна до полки и кто работает на каждом этапе' },
]

const isGame = (v: string | null): v is GameId => games.some((g) => g.id === v)

export function Play() {
  const [params] = useSearchParams()
  const raw = params.get('g')
  const id = isGame(raw) ? raw : null
  const navigate = useNavigate()

  // Новая игра открывается с начала экрана, а не там, где была прокрутка предыдущей
  useEffect(() => {
    scrollToTop()
  }, [id])

  // Все задания пройдены (null): к заявке, иначе следующее задание на своём экране
  const goTo = (task: Task | null) => navigate(task ? `/play?g=${task.id}` : '/apply')

  if (!id) return <Hub />
  return (
    <TaskNav.Provider value={goTo}>
      <div className="bg-night text-white" data-surface="dark">
        <div className="container-x pt-24 md:pt-32">
          <Link to="/play" className="-my-2 inline-flex items-center gap-3 py-2 font-display text-[17px] font-bold tracking-[0.08em] text-white/75 uppercase hover:text-white">
            <span aria-hidden="true">←</span> Все игры
          </Link>
        </div>
        <GameView id={id} />
      </div>
    </TaskNav.Provider>
  )
}

function GameView({ id }: { id: GameId }) {
  const views: Record<GameId, ReactNode> = {
    money: <Money />,
    quiz: <QuizSection />,
    game: <GameSection />,
    myth: <MythSection />,
    company: <CompanyQuizView />,
    path: <ProductionPath />,
  }
  return views[id]
}

/** Викторина в своём блоке: на главной она внутри «Правды или мифа», здесь отдельный экран */
function CompanyQuizView() {
  return (
    <section className="container-x pt-10 pb-20 md:pt-14 md:pb-28">
      <h1 className="display text-[clamp(56px,7.4vw,116px)]">
        Викторина <br className="sm:hidden" />
        об&nbsp;<span className="text-brand">«Очаково»</span>
      </h1>
      <p className="mt-5 max-w-[620px] text-[17px] leading-relaxed text-white/80 md:text-[19px]">{nb(`История, квас, деньги и практика. ${companyQuizPromise()}`)}</p>
      <CompanyQuiz tone="dark" size="page" level="h2" className="mt-10 md:mt-12" />
    </section>
  )
}

/** Список игр: что внутри, сколько заданий пройдено, значок за викторину */
function Hub() {
  const done = useActivities((s) => s.done)
  const best = useCompanyQuiz((s) => s.best)
  const badge = best ? companyQuizPassed(best.score, best.total) : false
  const status = (id: GameId) => {
    if (id === 'company') return badge ? 'значок получен' : null
    if (id === 'path') return null
    return done[id] ? 'пройдено' : null
  }
  return (
    <div className="bg-night text-white" data-surface="dark">
      <div className="container-x pt-24 pb-16 md:pt-36 md:pb-24">
        <h1 className="display text-[clamp(64px,12vw,180px)]">
          Игры <span className="text-brand">«Очаково»</span>
        </h1>
        <p className="mt-5 max-w-[640px] text-[17px] leading-relaxed text-white/80 md:text-[19px]">{nb(`${SHIFT_HINT}.`)}</p>

        <ol className="mt-10 border-b border-white/20 md:mt-14">
          {games.map((g, i) => {
            const s = status(g.id)
            return (
              <li key={g.id}>
                <Link to={`/play?g=${g.id}`} className="group grid grid-cols-[3rem_minmax(0,1fr)_auto] items-baseline gap-x-3 border-t border-white/20 py-5 md:grid-cols-[5rem_minmax(0,1fr)_auto] md:py-7">
                  <span className="font-display text-[22px] font-black text-brand-bright tabular-nums md:text-[28px]">{String(i + 1).padStart(2, '0')}</span>
                  <span>
                    <span className="block font-display text-[34px] leading-[0.92] font-black uppercase transition-colors group-hover:text-brand-bright md:text-[52px]">{g.title}</span>
                    <span className="mt-2 block text-[16px] leading-snug text-white/70 md:text-[18px]">{nb(g.text)}</span>
                  </span>
                  <span className="self-center text-right font-display text-[15px] font-bold tracking-[0.08em] uppercase">
                    {s ? <span className="text-white/60">{s}</span> : <span aria-hidden="true" className="text-[28px] text-brand transition-transform duration-300 group-hover:translate-x-1 inline-block">→</span>}
                  </span>
                </Link>
              </li>
            )
          })}
        </ol>

        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <Link to="/apply" className={btn.red}>
            Откликнуться <Dash />
          </Link>
          <Link to="/vacancies" className={btn.ghost}>
            Вакансии <Dash />
          </Link>
        </div>
        {!inTelegram && (
          <p className="mt-8 max-w-[640px] text-[15px] leading-relaxed text-white/60">
            {nb('Эти же игры стоят на главной странице друг за другом, вместе с историей завода и условиями.')}{' '}
            <Link to="/" className="underline decoration-white/40 underline-offset-4 hover:decoration-white">
              На главную
            </Link>
          </p>
        )}
      </div>
    </div>
  )
}
