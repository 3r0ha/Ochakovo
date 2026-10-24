import { BotBlock } from '../home/BotBlock'
import { Conditions } from '../home/Conditions'
import { Faq } from '../home/Faq'
import { FinalBand } from '../home/FinalBand'
import { GameSection } from '../home/GameSection'
import { Hero } from '../home/Hero'
import { History } from '../home/History'
import { BeltSeam } from '../home/kit'
import { Mentors } from '../home/Mentors'
import { Money } from '../home/Money'
import { MythSection } from '../home/MythSection'
import { Practice } from '../home/Practice'
import { ProductionPath } from '../home/ProductionPath'
import { QuizSection } from '../home/QuizSection'
import { ShiftInside } from '../home/ShiftInside'
import { VacancyList } from '../home/VacancyList'

// Сначала предложение, потом задания и подробности: практика → смена изнутри → деньги → подбор → условия → путь кваса → игра →
// вакансии → история «Квас делают люди» → наставники → миф (с контрольными вопросами) → Квасыч → вопросы.
// Миф стоит после истории: его карточки об истории проверяют то, что человек только что прочитал.
// Где соседние секции одного цвета, между ними шов-лента: без неё две пустые полосы отступов сливаются в одну дыру
export function Home() {
  return (
    <div className="bg-night">
      <Hero />
      <Practice />
      <ShiftInside />
      {/* Ролики и «Собери лето» — оба на тёмном: между ними шов-лента, а не скачок тона */}
      <BeltSeam />
      <Money />
      <QuizSection />
      <Conditions />
      <ProductionPath />
      <BeltSeam />
      <GameSection />
      <VacancyList />
      <History />
      <Mentors />
      <MythSection />
      <BotBlock />
      <Faq />
      <FinalBand />
      <div className="pointer-events-none fixed -inset-[10%] z-50 opacity-[0.06] mix-blend-overlay" aria-hidden="true">
        <div className="grain size-full" />
      </div>
    </div>
  )
}
