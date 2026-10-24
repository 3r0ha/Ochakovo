import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { contacts } from '@shared/content/content'
import { getPass, HrUnauthorized, type PassItem } from '../lib/api'
import { nb } from '../lib/typo'

const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10)
const ru = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })

/** «Список на проходную»: кто придёт на собеседование в этот день. Белая страница для печати и Excel для охраны */
export function HrPass() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? params.get('date')! : today()
  const [items, setItems] = useState<PassItem[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    document.title = `Список на проходную — ${date.split('-').reverse().join('.')}`
    setItems(null)
    getPass(date)
      .then((r) => setItems(r.items))
      .catch((e) => (e instanceof HrUnauthorized ? navigate('/hr/login', { replace: true }) : setError('Список не загрузился. Обнови страницу.')))
  }, [date, navigate])

  return (
    <div className="min-h-dvh bg-white px-4 py-8 text-[#141414] sm:px-6 print:p-0">
      <div className="mx-auto max-w-4xl">
        <div className="flex flex-wrap items-center gap-4 print:hidden">
          <Link to="/hr?tab=schedule" className="text-[15px] underline underline-offset-4">
            ← График
          </Link>
          <label className="flex items-center gap-2 text-[15px]">
            День
            <input type="date" value={date} onChange={(e) => e.target.value && setParams({ date: e.target.value })} className="h-9 border-b border-[#141414]/40 bg-transparent" />
          </label>
          <button onClick={() => window.print()} className="h-9 bg-[#141414] px-4 text-[15px] font-medium text-white">
            Печать
          </button>
          <a href={`/api/hr/pass.xlsx?date=${date}`} className="h-9 px-4 text-[15px] leading-9 font-medium ring-1 ring-[#141414] ring-inset">
            Excel
          </a>
        </div>

        <h1 className="mt-8 text-[28px] leading-tight font-bold print:mt-0">Список на проходную</h1>
        <p className="mt-1 text-[16px]">
          {/* Адрес и телефон — из общих контактов сайта: поменяются там — поменяются и здесь */}
          {nb(`Собеседования в «Очаково», ${ru(date).replace(/ г\.$/, '')}. ${contacts.address}. Отдел персонала: ${contacts.phone}, ${contacts.phoneNote}.`)}
        </p>

        {error && <p className="mt-6 text-[16px] text-[#b0002a]">{error}</p>}
        {items && !items.length && <p className="mt-6 text-[16px]">На этот день собеседований нет.</p>}
        {items && items.length > 0 && (
          <table className="mt-6 w-full border-collapse text-left text-[15px] sm:text-[16px]">
            <caption className="sr-only">Кандидаты на собеседование: время, фамилия, имя, отчество, вакансия</caption>
            <thead>
              <tr className="border-b-2 border-[#141414]">
                <th className="py-2 pr-3">№</th>
                <th className="py-2 pr-3">Время</th>
                <th className="py-2 pr-3">ФИО</th>
                <th className="py-2 pr-3">Вакансия</th>
                {/* Графа для отметки охраны нужна на бумаге; на телефоне её нет, чтобы таблица помещалась */}
                <th className="hidden w-32 py-2 sm:table-cell print:table-cell">Отметка</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={it.id} className="border-b border-[#141414]/30 align-top">
                  <td className="py-2 pr-3 tabular-nums">{i + 1}</td>
                  <td className="py-2 pr-3 tabular-nums">{it.time}</td>
                  <td className="py-2 pr-3 font-medium">{it.fullName}</td>
                  <td className="py-2 pr-3">{it.vacancy}</td>
                  <td className="hidden py-2 sm:table-cell print:table-cell" />
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {items && items.length > 0 && <p className="mt-4 text-[14px] text-[#141414]/70">Всего: {items.length}. Паспорт сверяют на проходной.</p>}
      </div>
    </div>
  )
}
