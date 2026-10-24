import { useEffect, useState } from 'react'
import type { CandidateStatus } from '@shared/candidateStatus'
import type { SentApplication } from './sent'

export type { CandidateStatus }

/**
 * Статус заявки глазами кандидата: GET /api/applications/:id/status с ключом из этого браузера.
 * null — узнать не получилось (нет сети, старая заявка без ключа, заявку удалили): страница показывает
 * обещание срока ответа из responsePromise (shared/candidateStatus.ts) и контакты, как раньше.
 */
export async function fetchStatus(id: string, token: string): Promise<CandidateStatus | null> {
  try {
    const res = await fetch(`/api/applications/${encodeURIComponent(id)}/status`, {
      headers: { 'x-status-token': token },
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) return null
    return (await res.json()) as CandidateStatus
  } catch {
    return null
  }
}

/** Статус обновляется при открытии страницы и когда человек возвращается на вкладку */
export function useCandidateStatus(app: SentApplication | null) {
  const [status, setStatus] = useState<CandidateStatus | null>(null)
  const [checked, setChecked] = useState(false)
  // Счётчик перезагрузок: запись на собеседование меняет статус — перечитываем сразу, не дожидаясь возврата на вкладку
  const [nonce, setNonce] = useState(0)
  const id = app?.id
  const token = app?.token
  // Другая заявка — статус прежней не показываем
  const [key, setKey] = useState(`${id}:${token}`)
  if (key !== `${id}:${token}`) {
    setKey(`${id}:${token}`)
    setStatus(null)
    setChecked(false)
  }
  useEffect(() => {
    if (!id || !token) {
      setChecked(true)
      return
    }
    let alive = true
    const load = () =>
      void fetchStatus(id, token).then((s) => {
        if (!alive) return
        // Сеть пропала на секунду — не стираем уже показанный статус
        setStatus((prev) => s ?? prev)
        setChecked(true)
      })
    load()
    const onVisible = () => document.visibilityState === 'visible' && load()
    window.addEventListener('focus', load)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      window.removeEventListener('focus', load)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [id, token, nonce])
  return { status, checked, reload: () => setNonce((n) => n + 1) }
}

/** День недели, число и месяц словами и время по Москве: «вторник, <число> <месяца>, в 11:00 по Москве» */
export function interviewWhen(startsAt: string) {
  const d = new Date(startsAt)
  const day = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', weekday: 'long', day: 'numeric', month: 'long' }).format(d)
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(d)
  return `${day}, в ${time} по Москве`
}

export const mapLink = (address: string) => `https://yandex.ru/maps/?text=${encodeURIComponent(address)}`

/** Событие для календаря (.ics): собеседование на час, с адресом и тем, что взять с собой */
export function downloadInterviewIcs(app: { id: string; number: string }, interview: NonNullable<CandidateStatus['interview']>, phone: string) {
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/[,;]/g, (m) => `\\${m}`).replace(/\n/g, '\\n')
  const start = new Date(interview.startsAt)
  const end = new Date(start.getTime() + 60 * 60 * 1000)
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ochakovo//Season//RU',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${app.id}-interview@ochakovo`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${esc('Собеседование в «Очаково»')}`,
    `LOCATION:${esc(interview.address)}`,
    `DESCRIPTION:${esc(`Взять с собой: ${interview.bring}. Номер заявки ${app.number}. Если время не подходит, звони: ${phone}`)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'sobesedovanie-ochakovo.ics'
  document.body.append(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
