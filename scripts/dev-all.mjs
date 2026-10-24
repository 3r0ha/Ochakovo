// Сайт и сервер одной командой: pnpm dev:all. Ctrl+C останавливает оба процесса.
import { spawn } from 'node:child_process'

const run = (name, cmd, args) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
  const prefix = (chunk) =>
    chunk
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((line) => `[${name}] ${line}`)
      .join('\n') + '\n'
  child.stdout.on('data', (c) => process.stdout.write(prefix(c)))
  child.stderr.on('data', (c) => process.stderr.write(prefix(c)))
  child.on('exit', (code) => {
    console.log(`[${name}] завершился с кодом ${code}`)
    stop()
  })
  return child
}

const children = [run('server', 'pnpm', ['server']), run('web', 'pnpm', ['dev'])]

let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM')
  setTimeout(() => process.exit(0), 1500).unref()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
