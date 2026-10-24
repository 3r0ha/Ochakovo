import { createContext, useContext } from 'react'
import { scrollToTarget } from '../lib/motion'
import { HEADER_OFFSET, type Task } from './tasks'

/**
 * Переход к следующему заданию. На главной задания стоят друг под другом, и кнопка прокручивает к блоку.
 * В мини-приложении Telegram (/play) у каждого задания свой экран: страница игр подставляет сюда переход между ними
 */
export const TaskNav = createContext<((task: Task | null) => void) | null>(null)

/** Перейти к заданию или, если все пройдены (null), к финалу: на главной прокруткой, в /play своим переходом */
export function useGoToTask() {
  const nav = useContext(TaskNav)
  return (task: Task | null) => (nav ? nav(task) : scrollToTarget(task ? task.anchor : '#final', HEADER_OFFSET))
}
