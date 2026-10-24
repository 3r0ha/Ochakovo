import { useSentApplication } from '../components/candidate/sent'
import { ButtonLink, FitLine } from '../home/kit'

// 404: текст и кнопки — одним блоком под цифрой, без пустоты между ними на широком экране.
// Куда пойти: главная, вакансии, «Поймай брак»; если в этом браузере уже есть заявка — «Моя заявка»
export function NotFound() {
  const sent = useSentApplication((s) => s.last)
  return (
    <div className="flex min-h-svh flex-col justify-center bg-night pt-[calc(72px+var(--invite-h,0px))] pb-16 text-white">
      <div className="container-x">
        <h1 className="w-full font-display leading-[0.8] font-black text-brand md:w-[56%]">
          <FitLine>404</FitLine>
        </h1>
        <p className="mt-8 max-w-md text-lg text-white/75">Такой страницы нет. Возможно, ссылка устарела.</p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <ButtonLink to="/" className="w-full sm:w-fit">
            На главную
          </ButtonLink>
          {sent && (
            <ButtonLink to="/apply" variant="ghost" className="w-full sm:w-fit">
              Моя заявка
            </ButtonLink>
          )}
          <ButtonLink to="/vacancies" variant="ghost" className="w-full sm:w-fit">
            Вакансии
          </ButtonLink>
          <ButtonLink to="/game" variant="ghost" className="w-full sm:w-fit">
            Поймай брак
          </ButtonLink>
        </div>
      </div>
    </div>
  )
}
