import { useSyncExternalStore } from 'react'
import { sourceName } from '@shared/hr'
import type { SourcesPayload } from '@shared/sources'
import { demoLocal } from '../../lib/api'
import { getSources } from '../../lib/hr/sources'

// Реестр меток для всех экранов панели — один запрос на сессию, обновляется после правок во вкладке «Источники».
//
//   const names = useSourceNames()          // { 'fair-misis': 'Ярмарка МИСИС', … }; пока не загрузилось — {}
//   sourceName(a.source, names)             // из @shared/hr: название из реестра важнее встроенного словаря
//   describeSource(r.source, names)         // в «Воронке»: kind 'registry' у названных, 'unknown' — подсветить
//   const label = useSourceLabel()          // то же одной функцией: label(a.source)
//   const data = useSources()               // реестр, незнакомые метки, расходы, адрес сайта; null — грузится или нет связи
//
// Без сервера (демо в браузере) реестра нет: названия — только из встроенного словаря.

let data: SourcesPayload | null = null
let names: Record<string, string> = {}
let pending: Promise<SourcesPayload | null> | null = null
const listeners = new Set<() => void>()

function publish(next: SourcesPayload | null) {
  data = next
  names = next ? Object.fromEntries(next.sources.map((s) => [s.code, s.name])) : {}
  for (const l of listeners) l()
}

/** Загрузить реестр; fresh — заново, даже если уже есть. Ошибка — null, экраны остаются со встроенным словарём */
export function loadSources(fresh = false): Promise<SourcesPayload | null> {
  if (demoLocal) return Promise.resolve(null)
  if (data && !fresh) return Promise.resolve(data)
  if (pending && !fresh) return pending
  const p = getSources().then(
    (payload) => {
      if (pending === p) publish(payload)
      return payload
    },
    () => null,
  )
  pending = p
  void p.finally(() => {
    if (pending === p) pending = null
  })
  return p
}

/** Названия меток без подписки — для подписей в списках; перерисовку при загрузке реестра даёт useSourceNames() в src/pages/Hr.tsx */
export const currentSourceNames = () => names

/** После правки во вкладке «Источники»: новый реестр сразу у всех экранов */
export function setSources(next: SourcesPayload) {
  publish(next)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!data) void loadSources()
  return () => listeners.delete(listener)
}

/** Реестр, незнакомые метки, расходы, адрес сайта и боты. null — ещё грузится, нет связи или демо без сервера */
export function useSources(): SourcesPayload | null {
  return useSyncExternalStore(subscribe, () => data, () => null)
}

/** Названия меток из реестра: { метка: название }. Тот же объект, пока реестр не изменился */
export function useSourceNames(): Record<string, string> {
  return useSyncExternalStore(subscribe, () => names, () => names)
}

/** Подпись источника с учётом реестра: label('fair-misis') → «Ярмарка МИСИС» */
export function useSourceLabel(): (src: string | null) => string {
  const current = useSourceNames()
  return (src) => sourceName(src, current)
}
