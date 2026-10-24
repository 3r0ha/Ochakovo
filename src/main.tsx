import './fonts.css'
import { MotionConfig } from 'motion/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { loadVacancyOverrides } from '@shared/content/vacancies'
import { App } from './App'
import './index.css'
import { captureSource } from './lib/source'

captureSource()

const root = createRoot(document.getElementById('root')!)
const render = () =>
  root.render(
    <StrictMode>
      {/* «user» — анимации motion уважают системную настройку «уменьшить движение» */}
      <MotionConfig reducedMotion="user">
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </MotionConfig>
    </StrictMode>,
  )
render()
// Правки вакансий из HR-панели (сумма, закрыта ли вакансия): первый экран не ждёт сеть — данные из сборки,
// а когда правки пришли, страница перерисовывается с ними
void loadVacancyOverrides().then((changed) => changed && render())
