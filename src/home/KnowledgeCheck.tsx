import { Link } from 'react-router'
import { COMPANY_QUIZ_ROUND, companyQuizPromise } from '@shared/content/companyQuiz'
import { nb } from '../lib/typo'
import { btn, Dash } from './kit'

/** Адрес контрольных вопросов: режим страницы игры (src/pages/Game.tsx, пакет w2-game) */
export const COMPANY_QUIZ_URL = '/game?t=quiz'

/**
 * Карточка викторины «7 вопросов об „Очаково“» рядом с заданиями смены: контрольные вопросы на знание компании (кейс:
 * «интерактивный блок с контрольными вопросами»). Сами вопросы — shared/content/companyQuiz.ts, игра — на /game?t=quiz
 */
export function KnowledgeCheck({ className = '' }: { className?: string }) {
  return (
    <div data-company-quiz className={`border-t-[3px] border-ink pt-5 ${className}`}>
      <p className="font-display text-[17px] font-bold tracking-[0.08em] uppercase">Викторина</p>
      <p className="mt-3 font-display text-[clamp(34px,3.2vw,48px)] leading-[0.9] font-black uppercase">
        {COMPANY_QUIZ_ROUND} вопросов об&nbsp;«Очаково»
      </p>
      <p className="mt-3 max-w-[460px] text-[17px] leading-relaxed text-ink/80">
        {nb(`Про историю, квас, деньги и практику. ${companyQuizPromise()}`)}
      </p>
      <Link to={COMPANY_QUIZ_URL} className={`${btn.ink} mt-5 w-fit`}>
        Проверить себя
        <Dash />
      </Link>
    </div>
  )
}
