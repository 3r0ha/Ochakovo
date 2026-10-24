import type { TemplateKey } from '@shared/applications'
import { getTemplates, type NotifyTemplate } from '../../lib/api'

// Тексты уведомлений для предпросмотра — один запрос на сессию панели

let cache: Promise<NotifyTemplate[]> | null = null

export function loadTemplates(fresh = false) {
  if (!cache || fresh) cache = getTemplates().catch(() => ((cache = null), []))
  return cache
}

export async function templateText(key: TemplateKey) {
  return (await loadTemplates()).find((t) => t.key === key) ?? null
}
