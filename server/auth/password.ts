import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto'

// Пароли сотрудников HR: scrypt со случайной солью. Формат строки:
// scrypt$<N>$<r>$<p>$<соль base64url>$<хеш base64url>

const N = 16384
const R = 8
const P = 1
const KEYLEN = 64

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))))
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 })
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, keyB64] = stored.split('$')
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false
  const expected = Buffer.from(keyB64, 'base64url')
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  })
  return key.length === expected.length && timingSafeEqual(key, expected)
}

/** Минимальные требования к паролю сотрудника: длина важнее спецсимволов */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return 'Пароль должен быть не короче 10 символов'
  if (password.length > 200) return 'Слишком длинный пароль'
  return null
}

/** Токен сессии для cookie и его отпечаток для базы */
export function newSessionToken() {
  const token = randomBytes(32).toString('base64url')
  return { token, id: sessionId(token) }
}

export const sessionId = (token: string) => createHash('sha256').update(token).digest('hex')
