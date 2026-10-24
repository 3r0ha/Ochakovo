import { useEffect, useState } from 'react'

// Общее для «Политики обработки данных» (/privacy) и текста согласия (/consent).
// Реквизиты — из ЕГРЮЛ. Что ещё должны подтвердить юристы перед запуском — docs/deploy.md, «Перед запуском».

export const operator = {
  name: 'АО\u00A0МПБК «Очаково»',
  inn: '7729101200',
  ogrn: '1027739613791',
  address: '121471, Москва, ул. Рябиновая, д. 44',
}

/** Какие сервисы сейчас обрабатывают данные по поручению «Очаково» — решает сервер (GET /api/privacy) */
export type Processors = { yandex360: boolean; sms: string | null }

/** Поручения обработки с сервера. Пока ответа нет или сервер недоступен — ничего не подключено */
export function useProcessors(): Processors {
  const [processors, setProcessors] = useState<Processors>({ yandex360: false, sms: null })
  useEffect(() => {
    const ctrl = new AbortController()
    fetch('/api/privacy', { signal: ctrl.signal })
      .then((r) => (r.ok && r.headers.get('content-type')?.includes('application/json') ? (r.json() as Promise<Processors>) : null))
      .then((p) => p && setProcessors({ yandex360: p.yandex360 === true, sms: typeof p.sms === 'string' ? p.sms : null }))
      .catch(() => {})
    return () => ctrl.abort()
  }, [])
  return processors
}

