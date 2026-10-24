import { stripNameIntro } from './intent'

// ФИО и дата рождения из свободного текста в заявке бота.
// Просим «как в паспорте: фамилия, имя, отчество», но люди пишут и «Аня Смирнова», и «Иван Иванович Петров».
// Порядок угадываем осторожно: известное имя, суффикс отчества, суффикс фамилии, имя из профиля мессенджера.
// Итог человек видит на экране проверки отдельными строками и может исправить.

export type FullName = { lastName: string; name: string; middleName: string }

/**
 * Частые имена и их короткие формы — чтобы понять, где имя, если человек написал «Аня Смирнова».
 * Список не ограничивает ввод: незнакомое имя тоже принимается, порядок тогда — как в паспорте
 */
const GIVEN_NAMES = new Set(
  (
    'александр саша шура алексей лёша леша анатолий толя андрей андрюша антон аркадий арсений арсен артём артем артур богдан борис боря ' +
    'вадим валентин валера валерий василий вася виктор витя виталий владимир вова володя владислав влад всеволод вячеслав слава ' +
    'гавриил геннадий гена георгий гоша гриша григорий даниил данил даня денис дима дмитрий евгений женя егор елисей захар иван ваня ' +
    'игорь илья ильдар ислам камиль кирилл константин костя лев лёва лева леонид лёня марат марк матвей михаил миша назар никита ' +
    'николай коля олег павел паша пётр петр петя платон роберт родион роман рома руслан рустам савелий святослав семён семен сергей ' +
    'серёжа сережа станислав стас степан тимофей тимур тёма федор фёдор федя филипп эдуард эльдар эмиль юрий юра ян ярослав ' +
    'александра алёна алена алина алиса алла анастасия настя ангелина анжелика анна аня арина валентина валерия лера варвара варя ' +
    'вера вероника ника виктория вика галина диана дарья даша ева евгения екатерина катя елена лена елизавета лиза жанна злата зоя ' +
    'инна ирина ира камила карина кира кристина ксения ксюша лариса лилия лия любовь люба людмила мадина майя маргарита рита марина ' +
    'мария маша милана мила надежда надя наталья наташа нелли нина оксана олеся ольга оля полина регина сабина светлана света ' +
    'софия софья соня таисия тая тамара татьяна таня ульяна эвелина элина эльвира юлия юля яна ясмина'
  ).split(' '),
)

const isGiven = (w: string) => GIVEN_NAMES.has(w.toLowerCase().replace(/ё/g, 'е')) || GIVEN_NAMES.has(w.toLowerCase())

/** Отчество: «-ович», «-евна», «-ична», «Ильич», а также «оглы» и «кызы» отдельным словом */
const isPatronymic = (w: string) => /(вич|вна|ична|инична|ьич|ич)$/i.test(w) && w.length >= 5

/** Похоже на фамилию по окончанию. Короткие слова не считаем: «Ева» — имя, а не «-ева» */
const isSurnameLike = (w: string) =>
  w.length >= 5 && /(ов|ова|ев|ева|ёв|ёва|ин|ина|ын|ына|ский|ская|цкий|цкая|енко|швили|дзе|ян|янц|ук|юк|чук|ых|их)$/i.test(w)

/** Слово имени: буквы, дефис внутри и апостроф. «Анна-Мария», «Д'Артаньян» */
const NAME_WORD = /^[a-zа-яё]+(?:['’-][a-zа-яё]+)*$/i

/** «анна-мария» → «Анна-Мария»; слово, набранное как есть, не трогаем */
const capitalize = (w: string) => (w === w.toLowerCase() ? w.replace(/(^|[-'’])([a-zа-яё])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase()) : w)

/** Слова имени из ввода или null, если это не имя: цифры, ссылки, больше пяти слов */
export function nameWords(text: string): string[] | null {
  const clean = stripNameIntro(text).replace(/[,;]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (clean.length < 2 || clean.length > 120) return null
  const words = clean.split(' ')
  if (words.length > 5 || !words.every((w) => NAME_WORD.test(w))) return null
  return words.map(capitalize)
}

/**
 * ФИО из одной строки. Одно слово — только имя (фамилию бот спросит отдельно).
 * Два слова — по умолчанию «Фамилия Имя», как в паспорте; «Имя Фамилия», если первое слово — известное имя или имя из профиля,
 * а второе на него не похоже, или если на фамилию похоже только второе. Три слова — по месту отчества.
 * hint — имя из профиля мессенджера
 */
export function parseFullName(text: string, hint = ''): FullName | null {
  const w = nameWords(text)
  if (!w) return null
  const given = (x: string) => isGiven(x) || (hint !== '' && x.toLowerCase() === hint.toLowerCase())
  if (w.length === 1) return { lastName: '', name: w[0], middleName: '' }
  if (w.length === 2) {
    const [a, b] = w
    if (isPatronymic(b) && given(a)) return { lastName: '', name: a, middleName: b }
    const nameFirst = (given(a) && !given(b)) || (!given(b) && !isSurnameLike(a) && isSurnameLike(b))
    return nameFirst ? { lastName: b, name: a, middleName: '' } : { lastName: a, name: b, middleName: '' }
  }
  // «Иван Иванович Петров» — имя, отчество, фамилия
  if (w.length === 3 && isPatronymic(w[1]) && !isPatronymic(w[2])) return { lastName: w[2], name: w[0], middleName: w[1] }
  // «Петров Иван Иванович», «Мамедов Али Гусейн оглы»
  return { lastName: w[0], name: w[1], middleName: w.slice(2).join(' ') }
}

/**
 * Фамилия и отчество, когда имя уже известно: «Смирнова», «Смирнова Сергеевна».
 * Если человек написал ФИО целиком, с именем, — разбираем его заново, и имя берём оттуда
 */
export function parseLastName(text: string, name: string): FullName | null {
  const w = nameWords(text)
  if (!w) return null
  const rest = w.filter((x) => x.toLowerCase() !== name.toLowerCase())
  if (rest.length === w.length && w.length >= 3) return parseFullName(text, name)
  if (!rest.length) return null
  if (rest.length === 1) return { lastName: rest[0], name, middleName: '' }
  // «Сергеевна Смирнова» — отчество первым
  if (isPatronymic(rest[0]) && !isPatronymic(rest[1])) return { lastName: rest[1], name, middleName: rest.slice(2).concat(rest[0]).join(' ') }
  return { lastName: rest[0], name, middleName: rest.slice(1).join(' ') }
}

/** «Смирнова Анна Сергеевна» — как в паспорте, без пустых частей */
export const fullNameLine = (n: Partial<FullName>) => [n.lastName, n.name, n.middleName].filter(Boolean).join(' ')

const MONTHS: Record<string, number> = {
  январ: 1, феврал: 2, март: 3, апрел: 4, ма: 5, июн: 6, июл: 7, август: 8, сентябр: 9, октябр: 10, ноябр: 11, декабр: 12,
}

/**
 * Дата словами — в цифры для shared/birthDate: «<день> мая <год>», «<день> марта <год> г.» → «<день>.5.<год>», «<день>.3.<год>».
 * Остальное — как есть: цифровые форматы разбирает parseBirthDate
 */
export function dateFromWords(text: string): string {
  const m = /^(\d{1,2})\s+([а-яё]+)\s+(\d{4})(?:\s*г(?:ода|од)?\.?)?$/i.exec(text.trim())
  if (!m) return text.trim()
  const word = m[2].toLowerCase().replace(/ё/g, 'е')
  const stem = Object.keys(MONTHS)
    .sort((a, b) => b.length - a.length)
    .find((k) => word.startsWith(k) && (k !== 'ма' || /^ма[йяе]$/.test(word)))
  return stem ? `${m[1]}.${MONTHS[stem]}.${m[3]}` : text.trim()
}
