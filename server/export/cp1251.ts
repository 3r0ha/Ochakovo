// Кодировка Windows-1251 для выгрузки в 1С: таблица строится из системного декодера,
// символы вне кодировки заменяются похожими или «?»

const table = new Map<string, number>()
const decoder = new TextDecoder('windows-1251')
for (let b = 0x80; b <= 0xff; b++) table.set(decoder.decode(Uint8Array.of(b)), b)

const similar: Record<string, string> = { ' ': ' ', ' ': ' ', '−': '-', '…': '...', ' ': ' ' }

export function encodeCp1251(text: string): Buffer {
  const out = Buffer.alloc(text.length * 3)
  let n = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code < 0x80) out[n++] = code
    else if (table.has(ch)) out[n++] = table.get(ch)!
    else for (const c of similar[ch] ?? '?') out[n++] = table.get(c) ?? c.charCodeAt(0)
  }
  return out.subarray(0, n)
}
