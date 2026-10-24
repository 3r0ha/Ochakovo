import { useProfile } from '../store/profile'

// Звуки синтезируются на лету через Web Audio — никаких файлов и загрузок.

let ctx: AudioContext | null = null

function audio() {
  if (useProfile.getState().muted) return null
  ctx ??= new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

function tone(freq: number, start: number, duration: number, type: OscillatorType = 'square', gain = 0.06) {
  const a = audio()
  if (!a) return
  const t = a.currentTime + start
  const osc = a.createOscillator()
  const vol = a.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  vol.gain.setValueAtTime(gain, t)
  vol.gain.exponentialRampToValueAtTime(0.0001, t + duration)
  osc.connect(vol).connect(a.destination)
  osc.start(t)
  osc.stop(t + duration)
}

export const sfx = {
  tap: () => tone(520, 0, 0.06, 'triangle', 0.05),
  pop: () => {
    tone(880, 0, 0.07, 'square', 0.04)
    tone(1320, 0.05, 0.08, 'square', 0.035)
  },
  coin: () => {
    tone(988, 0, 0.08, 'square', 0.045)
    tone(1319, 0.07, 0.18, 'square', 0.045)
  },
  error: () => {
    tone(196, 0, 0.12, 'sawtooth', 0.05)
    tone(147, 0.1, 0.18, 'sawtooth', 0.05)
  },
  fanfare: () => {
    ;[523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.22, 'square', 0.045))
  },
  unlock: () => {
    ;[784, 988, 1175, 1568].forEach((f, i) => tone(f, i * 0.06, 0.16, 'triangle', 0.06))
  },
}
