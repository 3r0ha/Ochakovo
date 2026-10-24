import { lazy, Suspense, type ComponentType } from 'react'
import { Route, Routes } from 'react-router'
import { Layout } from './components/Layout'
import { Home } from './pages/Home'

// Главная грузится сразу, остальные страницы — отдельными чанками
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })))

const Vacancies = page(() => import('./pages/Vacancies'), 'Vacancies')
const Apply = page(() => import('./pages/Apply'), 'Apply')
const Consent = page(() => import('./pages/Consent'), 'Consent')
const Focus = page(() => import('./pages/Focus'), 'Focus')
const Game = page(() => import('./pages/Game'), 'Game')
const Hr = page(() => import('./pages/Hr'), 'Hr')
const Materials = page(() => import('./pages/Materials'), 'Materials')
const HrLogin = page(() => import('./pages/HrLogin'), 'HrLogin')
const HrPass = page(() => import('./pages/HrPass'), 'HrPass')
const HrPoster = page(() => import('./pages/HrPoster'), 'HrPoster')
const NotFound = page(() => import('./pages/NotFound'), 'NotFound')
const Privacy = page(() => import('./pages/Privacy'), 'Privacy')

export function App() {
  return (
    <Routes>
      {/* Панель HR — рабочий инструмент со своим компактным каркасом, без шапки и чата сайта */}
      <Route path="hr" element={<Suspense fallback={null}><Hr /></Suspense>} />
      <Route path="hr/login" element={<Suspense fallback={null}><HrLogin /></Suspense>} />
      <Route path="hr/pass" element={<Suspense fallback={null}><HrPass /></Suspense>} />
      <Route path="hr/poster" element={<Suspense fallback={null}><HrPoster /></Suspense>} />
      {/* Материалы кейса для экспертов и сдачи: свой каркас, без шапки и чата сайта */}
      <Route path="materials" element={<Suspense fallback={null}><Materials /></Suspense>} />
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="vacancies" element={<Vacancies />} />
        <Route path="apply" element={<Apply />} />
        <Route path="game" element={<Game />} />
        {/* Анонимная анкета фокус-группы: ссылка и QR — из вкладки HR «Фокус-группа», в меню и карте сайта её нет */}
        <Route path="focus" element={<Focus />} />
        <Route path="privacy" element={<Privacy />} />
        {/* Текст согласия открывается без входа: на него ведут форма заявки, чат и боты */}
        <Route path="consent" element={<Consent />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
