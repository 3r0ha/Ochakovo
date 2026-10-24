import { Link } from 'react-router'
import { InlineGame } from '../game/InlineGame'
import { useReveal } from '../lib/motion'
import { selectDoneCount, useActivities } from '../store/activities'
import { NextStep, sectionTitle, TaskLabel } from './kit'
import { tasks } from './tasks'

/** Задание «Поймай брак» прямо на странице. Правила, легенду и «дальше» показывает сама игра */
export function GameSection() {
  // Переход к следующему заданию есть в итогах игры; здесь — только момент «смена закрыта»
  const allDone = useActivities(selectDoneCount) === tasks.length
  const title = useReveal<HTMLHeadingElement>()
  return (
    <section id="game" className="relative bg-night py-20 text-white md:py-28">
      <div className="container-x">
        <TaskLabel id="game" light />
        <h2 ref={title} className={`mt-6 ${sectionTitle}`}>
          Поймай брак
        </h2>

        <div id="play" className="mt-8 md:mt-10">
          <InlineGame />
        </div>

        <div className="mt-6 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          {allDone && <NextStep after="game" className="md:max-w-[640px]" />}
          <Link to="/game" className="-my-3 w-fit py-3 text-[15px] text-white/75 underline decoration-white/40 underline-offset-4 hover:text-white md:ml-auto">
            Игра на весь экран
          </Link>
        </div>
      </div>
    </section>
  )
}
