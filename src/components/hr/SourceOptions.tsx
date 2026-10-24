import { manualSources } from '@shared/hr'
import { sourceKinds } from '@shared/sources'
import { useSources } from './sourcesCache'

/**
 * Варианты «Откуда» для «+ Кандидат» и импорта: метки из реестра «Источники», по типам точек контакта.
 * Пока реестр не загрузился или его нет (демо без сервера) — встроенный список ручных источников
 */
export function SourceOptions() {
  const registry = useSources()?.sources
  if (!registry?.length)
    return (
      <>
        {manualSources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </>
    )
  return (
    <>
      {sourceKinds.map((k) => {
        const items = registry.filter((s) => s.kind === k.id)
        return items.length ? (
          <optgroup key={k.id} label={k.label}>
            {items.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </optgroup>
        ) : null
      })}
    </>
  )
}
