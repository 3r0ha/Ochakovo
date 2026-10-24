import { useState, type FormEvent } from "react";
import { openKvasychChat } from "../components/chat/bus";
import { Mascot } from "../components/Mascot";
import { useSiteConfig } from "../lib/config";
import { useReveal } from "../lib/motion";
import { nb } from "../lib/typo";
import { useProfile } from "../store/profile";
import { btn, Dash } from "./kit";

/** Готовые вопросы: нажатие открывает чат и сразу отправляет вопрос */
const READY = [
  "Кто будет учить?",
  "Можно остаться после практики?",
  "Как добраться до завода?",
];

/** Метка источника для диплинка бота: только [A-Za-z0-9_-], до 64 символов; без метки — site */
const startParam = (source: string | null | undefined) =>
  (source ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "site";

/**
 * Диплинк «Напомнить о наборе»: remind-<метка>, без метки — remind. Бот разбирает его отдельно от метки источника
 * (server/dialog), источник заявки не портится. Вместе с «remind-» — не длиннее 64 символов, как требует Telegram
 */
const remindParam = (source: string | null | undefined) => {
  const label = (source ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 57);
  return label ? `remind-${label}` : "remind";
};

type BotLink = { name: string; url: string; remind: string };

/** Ссылки на ботов — только для тех, чьё имя отдал сервер (GET /api/config): без работающего бота кнопки нет */
function useBotLinks(): BotLink[] {
  const config = useSiteConfig();
  const source = useProfile((s) => s.source);
  const start = encodeURIComponent(startParam(source));
  const remind = encodeURIComponent(remindParam(source));
  const tg = config?.bots.telegram;
  const max = config?.bots.max;
  const tgBase = tg ? `https://t.me/${encodeURIComponent(tg)}` : "";
  const maxBase = max ? `https://max.ru/${encodeURIComponent(max)}` : "";
  return [
    tg
      ? {
          name: "Telegram",
          url: `${tgBase}?start=${start}`,
          remind: `${tgBase}?start=${remind}`,
        }
      : null,
    max
      ? {
          name: "MAX",
          url: `${maxBase}?start=${start}`,
          remind: `${maxBase}?start=${remind}`,
        }
      : null,
  ].filter((x): x is BotLink => !!x);
}

/** «Спросить Квасыча»: поле для своего вопроса, три готовых вопроса и боты в мессенджерах */
export function BotBlock() {
  const [question, setQuestion] = useState("");
  const bots = useBotLinks();
  const title = useReveal<HTMLHeadingElement>();

  const ask = (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q) return;
    openKvasychChat(q);
    setQuestion("");
  };

  return (
    <section id="bot" className="bg-coal py-16 text-white md:py-24">
      <div className="container-x grid grid-cols-[minmax(0,1fr)] gap-x-16 gap-y-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start">
        <div>
          <h2
            ref={title}
            className="font-display text-[clamp(44px,5.4vw,84px)] leading-[0.88] font-black uppercase"
          >
            Спросить Квасыча
          </h2>
          {/* Под заголовком на ноутбуке пустая колонка: Квасыч здоровается. На телефоне он не отодвигает поле вопроса */}
          <Mascot
            pose="hello"
            dark
            className="mt-10 hidden h-64 w-auto lg:block"
          />
        </div>

        <div>
          <form onSubmit={ask} className="flex gap-2">
            <label htmlFor="bot-question" className="sr-only">
              Вопрос Квасычу
            </label>
            <input
              id="bot-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Напиши вопрос"
              autoComplete="off"
              enterKeyHint="send"
              maxLength={500}
              className="h-16 min-w-0 flex-1 bg-white px-4 text-[17px] text-ink outline-none placeholder:text-ink/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            />
            <button
              type="submit"
              aria-haspopup="dialog"
              className={`${btn.red} shrink-0 !px-5 md:!px-7`}
            >
              Спросить
            </button>
          </form>

          {/* Готовые вопросы — подсказками под полем, как в чате: строки с чертой рядом с «Вопросами» ниже читались бы
              как ещё один раскрывающийся список */}
          <p className="mt-6 text-[15px] text-white/75">Или выбери вопрос:</p>
          <ul className="mt-3 flex flex-wrap gap-2.5">
            {READY.map((q) => (
              <li key={q}>
                <button
                  onClick={() => openKvasychChat(q)}
                  aria-haspopup="dialog"
                  className="inline-flex min-h-11 items-center px-4 py-2 text-left text-[16px] leading-snug ring-1 ring-white/45 transition-colors ring-inset hover:bg-white hover:text-ink md:text-[17px]"
                >
                  {nb(q)}
                </button>
              </li>
            ))}
          </ul>

          {bots.length > 0 && (
            <>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row lg:flex-col xl:flex-row">
                {bots.map((b) => (
                  <a
                    key={b.name}
                    href={b.url}
                    target="_blank"
                    rel="noreferrer"
                    className={`${btn.ghost} justify-between sm:min-w-[240px]`}
                  >
                    Квасыч в {b.name}
                    <Dash />
                  </a>
                ))}
              </div>
              {/* Напоминание о наборе — тише кнопок: главное действие на странице остаётся «Откликнуться» */}
              <div data-remind className="mt-6 border-t border-white/25 pt-5">
                <p className="text-[15px] leading-snug text-white/75">
                  {nb(
                    "Бот спросит направление и пришлёт сообщение, когда откроется набор. Отписаться можно кнопкой «Не присылать».",
                  )}
                </p>
                <p className="mt-2 flex flex-wrap gap-x-6">
                  {bots.map((b) => (
                    <a
                      key={b.name}
                      href={b.remind}
                      target="_blank"
                      rel="noreferrer"
                      className="py-2.5 font-display text-[19px] font-bold tracking-[0.05em] uppercase underline decoration-white/50 decoration-2 underline-offset-[6px] hover:decoration-white"
                    >
                      Напомнить о наборе в {b.name}
                    </a>
                  ))}
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
