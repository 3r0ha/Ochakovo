// Срок ответа здесь не повторяем: на форме он один раз у кнопки отправки, на экране успеха — в первом абзаце
const stepsFor = (telegram: boolean) => [
  { title: 'HR смотрит заявку', text: 'Всё из формы и пройденные задания уже в ней, по телефону повторять не придётся.' },
  telegram
    ? { title: 'Сообщение в Telegram', text: 'Обсудите график, должность и зарплату.' }
    : { title: 'Звонок', text: 'Обсудите график, должность и зарплату.' },
  { title: 'Оформление', text: 'Собеседование, медкомиссия, договор и инструктаж. Официально с первого рабочего дня.' },
]

/** Три шага после заявки — жирная линейка сверху, номера красным узким шрифтом */
export function NextSteps({ telegram = false }: { telegram?: boolean }) {
  const steps = stepsFor(telegram)
  return (
    <ol className="border-t-[3px] border-white">
      {steps.map((step, i) => (
        <li key={step.title} className="grid grid-cols-[3rem_1fr] border-b border-white/15 py-5">
          <span className="font-display text-[44px] leading-[0.8] font-black text-brand">{i + 1}</span>
          <span>
            <span className="block font-display text-[28px] leading-none font-extrabold uppercase">{step.title}</span>
            <span className="mt-2 block text-[15px] leading-snug text-white/65">{step.text}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}
