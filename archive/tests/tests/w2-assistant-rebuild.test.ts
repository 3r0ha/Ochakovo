// Пересборка базы при правке вакансий (w2-as-4): после правки суммы и вызова rebuildKnowledge() Квасыч называет
// новую сумму без перезапуска, guard её пропускает, база знаний, промпт и список вакансий в функциях обновлены.
// Метрики помощника для /api/health: средняя задержка и доля запасных ответов.
// Запуск: pnpm test w2-assistant-rebuild (без базы)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assistantStats, createAssistant, systemPrompt } from '../../server/assistant/assistant'
import { checkAnswer } from '../../server/assistant/guard'
import { knowledgeText, rebuildKnowledge } from '../../server/assistant/knowledge'
import { functionDefinitions } from '../../server/assistant/tools'
import { offlineProvider } from '../../server/llm/offline'
import { vacancies, vacancyById } from '../../shared/content/vacancies'

const plain = (t: string) => t.replace(/[  ]/g, ' ')
const assistant = createAssistant({ provider: offlineProvider(), log: () => {} })
const ask = async (q: string) => plain((await assistant.answer({ question: q, history: [], sessionId: 'rebuild', channel: 'web' })).text)

test('правка суммы: после rebuildKnowledge() Квасыч называет новую, guard её пропускает', async () => {
  const v = vacancyById('storekeeper')!
  const was = v.pay!.from
  const promptBefore = systemPrompt()
  try {
    v.pay!.from = 58000
    rebuildKnowledge()
    assert.match(await ask('сколько платят кладовщику'), /^Кладовщику платят от 58 000 ₽/)
    assert.ok(checkAnswer('Кладовщику платят от 58 000 ₽ в месяц.').ok, 'новая сумма разрешена')
    assert.ok(plain(knowledgeText()).includes('Кладовщик: Складской комплекс, оплачиваемая практика. Зарплата от 58 000 ₽'))
    assert.notEqual(systemPrompt(), promptBefore, 'кэш промпта сброшен')
  } finally {
    v.pay!.from = was
    rebuildKnowledge()
  }
  assert.match(await ask('сколько платят кладовщику'), /^Кладовщику платят от 56 000 ₽/)
  assert.equal(systemPrompt(), promptBefore, 'после отката промпт тот же — кэш GigaChat снова попадает')
})

test('закрытая вакансия пропадает из базы и из списка вакансий в функциях', () => {
  const at = vacancies.findIndex((v) => v.id === 'merchandiser')
  const [removed] = vacancies.splice(at, 1)
  try {
    rebuildKnowledge()
    const getVacancy = functionDefinitions().find((f) => f.name === 'get_vacancy')!
    assert.ok(!getVacancy.parameters.properties!.vacancy_id.enum!.includes('merchandiser'))
    assert.ok(!knowledgeText().includes('Мерчандайзер:'))
  } finally {
    vacancies.splice(at, 0, removed)
    rebuildKnowledge()
  }
  const getVacancy = functionDefinitions().find((f) => f.name === 'get_vacancy')!
  assert.ok(getVacancy.parameters.properties!.vacancy_id.enum!.includes('merchandiser'))
})

test('метрики: число ответов, средняя задержка, доля запасных', async () => {
  const before = assistantStats()
  await ask('когда зарплата')
  await ask('')
  const after = assistantStats()
  assert.equal(after.answers, before.answers + 2)
  assert.ok(after.avgMs >= 0)
  assert.ok(after.bySource.offline > before.bySource.offline && after.bySource.fallback > before.bySource.fallback)
  assert.ok(after.fallbackShare > 0 && after.fallbackShare <= 1)
})
