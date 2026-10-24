import { useEffect, useState } from 'react'
import type { SiteConfig } from '@shared/siteConfig'
import { demoLocal, request } from './api'

// Настройки сайта с сервера (GET /api/config): имена ботов и режим помощника.
// Один запрос на загрузку страницы; ошибка и демо без сервера дают null — тогда кнопок ботов нет.

let loading: Promise<SiteConfig | null> | null = null
let loaded: SiteConfig | null = null

export function loadSiteConfig(): Promise<SiteConfig | null> {
  if (demoLocal) return Promise.resolve(null)
  loading ??= request<SiteConfig>('/api/config').then(
    (config) => (loaded = config),
    () => null,
  )
  return loading
}

/** Настройки сайта; null — пока грузятся, сервер недоступен или демо без сервера */
export function useSiteConfig(): SiteConfig | null {
  const [config, setConfig] = useState<SiteConfig | null>(loaded)
  useEffect(() => {
    let alive = true
    void loadSiteConfig().then((c) => alive && setConfig(c))
    return () => {
      alive = false
    }
  }, [])
  return config
}
