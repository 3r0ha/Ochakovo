import type { HrRepo } from '../db/hr'
import { hashPassword, passwordProblem } from './password'

// Первый вход в панель. Администратора создаём из HR_ADMIN_EMAIL и HR_ADMIN_PASSWORD;
// дальше сотрудники заводятся в самой панели. Без переменных и без сотрудников
// вне продакшна создаём демо-администратора и печатаем вход в журнал.

export const DEMO_ADMIN = { email: 'hr@ochakovo.local', password: 'ochakovo-demo', name: 'Демо-администратор' }

export async function ensureAdmin(repo: HrRepo, env: NodeJS.ProcessEnv = process.env) {
  const email = env.HR_ADMIN_EMAIL?.trim()
  const password = env.HR_ADMIN_PASSWORD ?? ''

  if (email && password) {
    const problem = passwordProblem(password)
    if (problem) {
      console.error(`[hr] HR_ADMIN_PASSWORD не подходит: ${problem}. Администратор не создан`)
      return
    }
    if (await repo.userByEmail(email)) return
    await repo.createUser({ email, name: env.HR_ADMIN_NAME?.trim() || 'Администратор', role: 'admin', passwordHash: await hashPassword(password) })
    console.log(`[hr] создан администратор ${email}`)
    return
  }

  if ((await repo.countUsers()) > 0) return
  if (env.NODE_ENV === 'production') {
    console.warn('[hr] Сотрудников HR нет. Задайте HR_ADMIN_EMAIL и HR_ADMIN_PASSWORD и перезапустите сервер')
    return
  }
  await repo.createUser({ email: DEMO_ADMIN.email, name: DEMO_ADMIN.name, role: 'admin', passwordHash: await hashPassword(DEMO_ADMIN.password) })
  console.log(`[hr] демо-вход в панель: ${DEMO_ADMIN.email} / ${DEMO_ADMIN.password} (только для разработки)`)
}
