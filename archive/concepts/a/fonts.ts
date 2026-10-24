import '@fontsource/dela-gothic-one'
import '@fontsource/yeseva-one'
import type { CSSProperties } from 'react'

// Dela Gothic One — цифры и короткие слова капсом, как на банке. Знака ₽ в нём нет — его рисуем шрифтом текста.
export const dela: CSSProperties = { fontFamily: '"Dela Gothic One", "Arial Black", sans-serif' }
// Yeseva One — «название продукта»: заголовок и подписи
export const yeseva: CSSProperties = { fontFamily: '"Yeseva One", Georgia, serif' }
