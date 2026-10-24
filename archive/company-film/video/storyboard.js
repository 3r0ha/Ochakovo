// Раскадровка ролика о компании: сцены рисует этот скрипт (storyboard.html его подключает). Скрипт лежит отдельным
// файлом, потому что политика CSP сайта запрещает встроенные скрипты.
// Сцены те же, что в docs/brand/video.md: время, что в кадре, титр, звук и откуда кадр
const P = '../../../public/photos/'
const F = '../frames/'
const scenes = [
  { n: 1, t: [0, 4], what: 'Утро у проходной. Практикант прикладывает пропуск, турникет щёлкает', title: '8:00. Первая смена', sound: 'шаги, турникет', shoot: 'Проходная, 8:00. Средний план сбоку: рука с пропуском, турникет. Лицо только по согласию', src: 'новая съёмка' },
  { n: 2, t: [4, 9], what: 'Раздевалка. Практикант надевает рабочую куртку, на спине читается «Я делаю натуральные напитки»', title: 'Надень форму', sound: 'шорох ткани, шкафчик', img: F + 'bottling-uniform.webp', zoom: [1.4, '80%', '0%'], src: 'черновик из ролика «Оператор линии розлива», 5–8 с; для чистовой пересъёмка, надпись целиком' },
  { n: 3, t: [9, 17], what: 'Цех розлива. Наставник у пульта показывает, практикант записывает', title: 'Наставник покажет', sound: 'шум линии; живая фраза наставника', img: F + 'bottling-mentor.webp', zoom: [1.4, '90%', '100%'], src: 'черновик из того же ролика, 17–19 с; новая съёмка на линии кваса' },
  { n: 4, t: [17, 27], what: 'Четыре коротких кадра по 2,5 секунды: проба в лаборатории, сироп в цехе варки, накладная на складе, кнопка на пульте', sound: 'ритм оборудования', quad: [{ img: F + 'lab-quality.webp', zoom: [1.45, '80%', '0%'], title: 'Лаборатория' }, { img: P + 'brewhall-960.webp', title: 'Технологический цех' }, { shoot: 'Склад: накладная в руках, стеллажи в расфокусе', title: 'Склад' }, { img: F + 'bottling-walk.webp', zoom: [1.35, '100%', '0%'], title: 'Цех розлива' }], src: 'черновик: «Химик-лаборант», 14 с, «Оператор линии розлива», 8 с, фото цеха; склад и цех варки снимаем заново' },
  { n: 5, t: [27, 32], what: 'Квас на линии: янтарные бутылки на свету, этикетка кваса читается', title: 'До 70 000 бутылок напитков в час', sound: 'звон бутылок', img: P + 'hero-line-1600.webp', src: 'новая съёмка; черновик public/photos/hero-line-1600.webp' },
  { n: 6, t: [32, 37], what: '«Тогда и сейчас»: архивный кадр комбината и тот же цех сегодня', title: 'С 1978 года. Квас «Очаковский» с 1998-го', small: true, sound: 'тишина, щелчок затвора', quad2: [P + 'archive-1978-480.webp', P + 'brewhall-960.webp'], src: 'public/photos/archive-1978-480.webp, новая съёмка с той же точки' },
  { n: 7, t: [37, 45], what: 'Позже, снова пульт. Практикант уверенно работает на линии, наставник отходит на шаг и кивает', title: 'Управляй линией', top: true, sound: 'линия набирает ход', img: F + 'bottling-back.webp', zoom: [1.4, '20%', '100%'], ref: true, src: 'новая съёмка; кадр взят референсом из ролика «Оператор линии розлива», 20 с' },
  { n: 8, t: [45, 50], what: 'Вечер, 20:00: ночная смена заступает, свет цеха, столовая', title: 'Смены по 12 часов, днём и ночью', small: true, sound: 'шум цеха', shoot: 'Цех вечером: свет ламп, смена у пульта. Затем столовая в 20:30, вечернее питание', src: 'новая съёмка' },
  { n: 9, t: [50, 56], what: 'Официальный логотип, слоган и сумма', sound: 'музыка, финальный аккорд', graphic: 'sum', src: 'графика' },
  { n: 10, t: [56, 60], what: 'Куда идти', sound: 'тишина', graphic: 'cta', src: 'графика; QR демонстрационный, ведёт на демо-адрес с меткой vk-video, код своей публикации берут в HR-панели' },
]
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const tc = (s) => `0:${String(s).padStart(2, '0')}`.replace('0:60', '1:00')
const isNew = (s) => Boolean(s.shoot) || s.ref
// Увеличение к углу кадра: вшитые подписи роликов компании уходят за край
const img = (src, zoom) =>
  `<img src="${src}" alt="" style="${zoom ? `transform:scale(${zoom[0]});transform-origin:${zoom[1]} ${zoom[2]}` : ''}">`

function frame(s) {
  if (s.graphic === 'sum')
    return `<div class="graphic"><img src="../../../public/brand/logo-wordmark-white.svg" alt="ОЧАКОВО"><div class="slogan">Квас делают люди</div><div class="sum">Оплачиваемая практика: от&nbsp;56&nbsp;000 до&nbsp;70&nbsp;000&nbsp;₽ в&nbsp;месяц до&nbsp;вычета налога. С&nbsp;18&nbsp;лет</div></div>`
  if (s.graphic === 'cta')
    return `<div class="graphic"><img src="../../../public/brand/logo-wordmark-white.svg" alt="ОЧАКОВО"><div style="display:flex;justify-content:space-between;align-items:flex-end;gap:4%"><div class="sum">Откликнуться<br>по&nbsp;QR или в&nbsp;боте Квасыча</div><img class="qr" src="qr/vk-video.svg" alt="QR-код с меткой ролика"></div></div>`
  let inner = ''
  if (s.img) inner = img(s.img, s.zoom).replace('alt=""', `alt="${esc(s.what)}"`)
  else if (s.shoot) inner = `<div class="shoot">${esc(s.shoot)}</div>`
  else if (s.quad)
    inner = `<div class="quad">${s.quad.map((q) => `<div>${q.img ? img(q.img, q.zoom) : `<div class="shoot">${esc(q.shoot)}</div>`}<div class="title small quarter">${esc(q.title)}</div></div>`).join('')}</div>`
  else if (s.quad2) inner = `<div class="quad" style="grid-template-rows:1fr">${s.quad2.map((src, i) => `<div><img src="${src}" alt="" style="${i ? '' : 'filter:grayscale(1)'}"></div>`).join('')}</div>`
  return s.title ? `${inner}<div class="title${s.small ? ' small' : ''}${s.top ? ' top' : ''}">${esc(s.title)}</div>` : inner
}

document.getElementById('board').innerHTML = scenes
  .map(
    (s) => `
    <article class="scene" aria-labelledby="s${s.n}">
      <div class="frame">${frame(s)}<span class="tc">${s.n} · ${tc(s.t[0])}–${tc(s.t[1])}</span></div>
      <div class="info">
        <h2 id="s${s.n}"><span class="tag${isNew(s) ? ' new' : ''}">${isNew(s) ? 'снять' : s.graphic ? 'графика' : 'есть черновик'}</span>${esc(s.what)}</h2>
        <p>Звук: ${esc(s.sound)}</p>
        <p class="src">Кадр: ${esc(s.src)}</p>
      </div>
    </article>`,
  )
  .join('')
document.getElementById('timeline').innerHTML = scenes.map((s) => `<i class="${isNew(s) ? 'new' : ''}" style="flex:${s.t[1] - s.t[0]}"></i>`).join('')
