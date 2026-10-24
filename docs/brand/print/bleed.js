// Вылеты для типографии: адрес макета с #bleed ставит <html class="bleed">. Размер вылета, поле с метками реза
// и формат листа при печати задаёт CSS макета (print.css, stand.css). Скрипт лежит отдельным файлом: политика CSP
// сайта запрещает встроенные скрипты. Подключают листовки (print/) и стенд (stand/)
const bleed = () => document.documentElement.classList.toggle('bleed', location.hash === '#bleed')
bleed()
addEventListener('hashchange', bleed)
