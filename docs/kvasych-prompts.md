# Квасыч: описания для генерации картинок

Каждое описание ниже самодостаточное: его можно вставить в нейросеть целиком, без контекста. Английский вариант точнее понимают Midjourney, DALL·E, Stable Diffusion и Flux. Русский подходит для Кандинского и Шедеврума. Кто такой Квасыч и где стоят позы на сайте, описано в `docs/kvasych.md`.

## Как получить одинакового персонажа во всех позах

1. Сначала сгенерируй `kvasych-face.png` (голова анфас) и выбери лучший вариант.
2. Остальные позы генерируй с этой картинкой как референсом персонажа (в Midjourney `--cref`, в других сервисах «референс персонажа» или «image prompt») и с тем же seed, если сервис его даёт.
3. Проверь каждую картинку: пышные рыжевато-русые усы на месте, куртка красная с чёрными вставками и серебристой полосой, в руках нет пива, кружек и надписей.
4. Убери фон (remove.bg или встроенная функция), сохрани PNG с прозрачным фоном высотой 1400 px. Ноги стоят на нижнем крае картинки, масштаб во всех позах одинаковый.
5. Положи файл в `public/mascot/` с именем из заголовка позы: сайт подхватит его сам.

## Общее описание персонажа

Этот блок уже вставлен в каждую позу ниже. Он нужен, если хочешь собрать свою позу.

**English**

> Kvasych, the mascot of a Russian kvass factory: a friendly master craftsman and mentor. A man around fifty with a stocky, solid build, a round kind face, warm eyes with smile lines and a big bushy reddish-blond walrus mustache that covers the upper lip. The mustache is his main feature and must be readable even at avatar size. Short neat hair. He wears a red work jacket (#D50032) with black inserts on the shoulders and sides and a horizontal silver reflective stripe across the chest and sleeves, black work trousers and black safety boots. Style: flat 2D vector illustration, uniform black outline of the same weight everywhere, flat color fills, no gradients, no shadows, no texture, clean simple shapes like line pictograms. Palette strictly limited to red #D50032, dark red #AB2328, black #141414, kvass brown #54341B, warm yellow #FFD07B and white. Full body, feet resting on the bottom edge of the canvas, plain white background, portrait orientation. No beer, no alcohol, no mugs, no logos, no text or letters anywhere, no watermark, no 3D, no photorealism.

**Русский**

> Квасыч, маскот российского завода кваса: добродушный мастер-наставник. Мужчина около пятидесяти лет, крепкий, коренастый, с круглым добрым лицом, тёплым взглядом и морщинками от улыбки, с большими пышными рыжевато-русыми усами, которые закрывают верхнюю губу. Усы главная деталь, они должны читаться даже на маленьком аватаре. Короткая аккуратная стрижка. На нём красная рабочая куртка (#D50032) с чёрными вставками на плечах и боках и горизонтальной серебристой светоотражающей полосой на груди и рукавах, чёрные рабочие брюки и чёрные ботинки. Стиль: плоская 2D векторная иллюстрация, чёрный контур одинаковой толщины везде, плоские заливки без градиентов, теней и текстур, простые чистые формы, как у линейных пиктограмм. Палитра строго: красный #D50032, тёмно-красный #AB2328, чёрный #141414, коричневый цвета кваса #54341B, тёплый жёлтый #FFD07B и белый. В полный рост, ноги стоят на нижнем крае картинки, белый фон, вертикальная картинка. Без пива и алкоголя, без кружек, без логотипов, без текста и букв, без водяных знаков, без 3D и фотореализма.

Бутылка кваса во всех позах одна и та же: **EN** a 1.5-litre plastic bottle filled with amber-brown kvass (#54341B), red cap, plain white label without any text. **RU** полуторалитровая пластиковая бутылка с янтарно-коричневым квасом (#54341B), красная крышка, белая этикетка без надписей.

## Позы

### kvasych-face.png: аватар

Где: аватар Квасыча в чате и боте. Сгенерируй первой, она станет референсом для остальных.

**English**

> Kvasych, the mascot of a Russian kvass factory: a friendly master craftsman around fifty with a round kind face, warm eyes with smile lines and a big bushy reddish-blond walrus mustache covering the upper lip, short neat hair, collar of a red work jacket (#D50032) with black inserts and a silver reflective stripe. Head and shoulders only, front view, centered, friendly closed-mouth smile under the mustache, looking straight at the viewer. Square canvas. Flat 2D vector illustration, uniform black outline, flat fills, no gradients, no shadows. Palette: red #D50032, dark red #AB2328, black #141414, kvass brown #54341B, warm yellow #FFD07B, white. Plain white background. No text, no logos, no beer.

**Русский**

> Квасыч, маскот российского завода кваса: добродушный мастер около пятидесяти лет с круглым добрым лицом, тёплым взглядом, морщинками от улыбки и большими пышными рыжевато-русыми усами, которые закрывают верхнюю губу, короткая стрижка, виден воротник красной рабочей куртки (#D50032) с чёрными вставками и серебристой полосой. Только голова и плечи, анфас, по центру, дружелюбная улыбка с закрытым ртом под усами, смотрит прямо на зрителя. Квадратная картинка. Плоская векторная иллюстрация, ровный чёрный контур, плоские заливки без градиентов и теней. Палитра: красный #D50032, тёмно-красный #AB2328, чёрный #141414, коричневый #54341B, жёлтый #FFD07B, белый. Белый фон. Без текста, логотипов и пива.

### kvasych-hello.png: машет рукой

Где: первый экран сайта, приветствие в боте, стикер «Привет, смена».

**English**

> Kvasych, the mascot of a Russian kvass factory: a friendly stocky master craftsman around fifty with a big bushy reddish-blond walrus mustache, round kind face, red work jacket (#D50032) with black inserts and a silver reflective stripe, black trousers and boots. He stands facing the viewer and waves his right hand raised at shoulder height with the palm open, big warm smile, eyes slightly squinted from smiling. His left hand holds a 1.5-litre plastic bottle of amber kvass with a red cap and a plain white label at waist level. Full body, feet on the bottom edge. Flat 2D vector illustration, uniform black outline, flat fills, no gradients, no shadows. Palette: red #D50032, dark red #AB2328, black #141414, kvass brown #54341B, warm yellow #FFD07B, white. Plain white background. No text, no logos, no beer.

**Русский**

> Квасыч, маскот российского завода кваса: добродушный коренастый мастер около пятидесяти лет с большими пышными рыжевато-русыми усами, круглым добрым лицом, в красной рабочей куртке (#D50032) с чёрными вставками и серебристой полосой, чёрных брюках и ботинках. Стоит лицом к зрителю и машет правой рукой, поднятой на уровень плеча, ладонь раскрыта, широкая тёплая улыбка, глаза чуть прищурены от улыбки. В левой руке на уровне пояса полуторалитровая пластиковая бутылка янтарного кваса с красной крышкой и белой этикеткой без надписей. В полный рост, ноги на нижнем крае. Плоская векторная иллюстрация, ровный чёрный контур, плоские заливки без градиентов и теней. Палитра: красный #D50032, тёмно-красный #AB2328, чёрный #141414, коричневый #54341B, жёлтый #FFD07B, белый. Белый фон. Без текста, логотипов и пива.

### kvasych-mentor.png: у пульта линии

Где: блок о наставниках на главной, оплачиваемая практика, стикер «Смотри, как надо».

**English**

> Kvasych, the mascot of a Russian kvass factory: a friendly stocky master craftsman around fifty with a big bushy reddish-blond walrus mustache, round kind face, red work jacket (#D50032) with black inserts and a silver reflective stripe, black trousers and boots, red cap. He stands to the right of an industrial touch-screen control panel on a grey metal stand at chest height. The screen shows simple flat red and yellow blocks and bars, no readable text. With his left index finger he points at the screen, turns his head toward the viewer and explains something with a calm, confident half-smile, like a mentor showing a newcomer how the line works. Full body, feet on the bottom edge, the panel fully visible. Flat 2D vector illustration, uniform black outline, flat fills, no gradients, no shadows. Palette: red #D50032, dark red #AB2328, black #141414, kvass brown #54341B, warm yellow #FFD07B, white, plus light grey for the panel. Plain white background. No text, no logos, no beer.

**Русский**

> Квасыч, маскот российского завода кваса: добродушный коренастый мастер около пятидесяти лет с большими пышными рыжевато-русыми усами, круглым добрым лицом, в красной рабочей куртке (#D50032) с чёрными вставками и серебристой полосой, чёрных брюках, ботинках и красной кепке. Стоит справа от промышленного сенсорного пульта на серой металлической стойке на уровне груди. На экране простые плоские красные и жёлтые блоки и полосы, без читаемого текста. Указательным пальцем левой руки показывает на экран, повернул голову к зрителю и спокойно, уверенно объясняет с полуулыбкой, как наставник, который показывает новичку линию. В полный рост, ноги на нижнем крае, пульт виден целиком. Плоская векторная иллюстрация, ровный чёрный контур, плоские заливки без градиентов и теней. Палитра: красный #D50032, тёмно-красный #AB2328, чёрный #141414, коричневый #54341B, жёлтый #FFD07B, белый и светло-серый для пульта. Белый фон. Без текста, логотипов и пива.

### kvasych-money.png: расчётный лист на телефоне

Где: «Собери лето», стикер «12-го и 27-го».

**English**

> Kvasych, the mascot of a Russian kvass factory: a friendly stocky master craftsman around fifty with a big bushy reddish-blond walrus mustache, round kind face, red work jacket (#D50032) with black inserts and a silver reflective stripe, black trousers and boots. He holds a smartphone in his right hand and turns its screen toward the viewer. The screen shows a simple payslip: a few grey lines and one large bold warm-yellow block for the amount, no readable digits or text. He looks pleased and proud, raised eyebrows, satisfied smile under the mustache. Left hand on his hip. Full body, feet on the bottom edge. Flat 2D vector illustration, uniform black outline, flat fills, no gradients, no shadows. Palette: red #D50032, dark red #AB2328, black #141414, kvass brown #54341B, warm yellow #FFD07B, white. Plain white background. No text, no logos, no money bills, no beer.

**Русский**

> Квасыч, маскот российского завода кваса: добродушный коренастый мастер около пятидесяти лет с большими пышными рыжевато-русыми усами, круглым добрым лицом, в красной рабочей куртке (#D50032) с чёрными вставками и серебристой полосой, чёрных брюках и ботинках. В правой руке смартфон, экран повёрнут к зрителю. На экране простой расчётный лист: несколько серых строк и один крупный жёлтый блок суммы, без читаемых цифр и текста. Выглядит довольным и гордым, брови приподняты, довольная улыбка под усами. Левая рука на поясе. В полный рост, ноги на нижнем крае. Плоская векторная иллюстрация, ровный чёрный контур, плоские заливки без градиентов и теней. Палитра: красный #D50032, тёмно-красный #AB2328, чёрный #141414, коричневый #54341B, жёлтый #FFD07B, белый. Белый фон. Без текста, логотипов, купюр и пива.

### kvasych-think.png: подкручивает ус

Где: вопросы «Подбора работы», стикер «Дай подумать».

**English**

> Kvasych, the mascot of a Russian kvass factory: a friendly stocky master craftsman around fifty with a big bushy reddish-blond walrus mustache, round kind face, red work jacket (#D50032) with black inserts and a silver reflective stripe, black trousers and boots. He is thinking: twirls the right end of his mustache with the fingers of his right hand, eyes narrowed and looking up and to the left, one eyebrow raised, lips pressed in a thoughtful half-smile. Left hand on his hip. Full body, feet on the bottom edge. Flat 2D vector illustration, uniform black outline, flat fills, no gradients, no shadows. Palette: red #D50032, dark red #AB2328, black #141414, kvass brown #54341B, warm yellow #FFD07B, white. Plain white background. No text, no logos, no beer.

**Русский**

> Квасыч, маскот российского завода кваса: добродушный коренастый мастер около пятидесяти лет с большими пышными рыжевато-русыми усами, круглым добрым лицом, в красной рабочей куртке (#D50032) с чёрными вставками и серебристой полосой, чёрных брюках и ботинках. Думает: пальцами правой руки подкручивает правый кончик уса, глаза прищурены и смотрят вверх и влево, одна бровь приподнята, задумчивая полуулыбка. Левая рука на поясе. В полный рост, ноги на нижнем крае. Плоская векторная иллюстрация, ровный чёрный контур, плоские заливки без градиентов и теней. Палитра: красный #D50032, тёмно-красный #AB2328, чёрный #141414, коричневый #54341B, жёлтый #FFD07B, белый. Белый фон. Без текста, логотипов и пива.

### kvasych-wow.png: радуется

Где: итог «Подбора работы», рекорд в игре, заявка отправлена, стикер «Вот это да».

**English**

> Kvasych, the mascot of a Russian kvass factory: a friendly stocky master craftsman around fifty with a big bushy reddish-blond walrus mustache, round kind face, red work jacket (#D50032) with black inserts and a silver reflective stripe, black trousers and boots. He celebrates: both arms raised high above his head with open palms, mouth open in a joyful laugh under the mustache, eyes squeezed happily, standing on tiptoe. Full body, toes touching the bottom edge. Flat 2D vector illustration, uniform black outline, flat fills, no gradients, no shadows. Palette: red #D50032, dark red #AB2328, black #141414, kvass brown #54341B, warm yellow #FFD07B, white. A few small warm-yellow confetti shapes around him. Plain white background. No text, no logos, no beer.

**Русский**

> Квасыч, маскот российского завода кваса: добродушный коренастый мастер около пятидесяти лет с большими пышными рыжевато-русыми усами, круглым добрым лицом, в красной рабочей куртке (#D50032) с чёрными вставками и серебристой полосой, чёрных брюках и ботинках. Радуется: обе руки высоко подняты над головой, ладони раскрыты, рот открыт в радостном смехе под усами, глаза зажмурены от удовольствия, стоит на носочках. В полный рост, носки касаются нижнего края. Плоская векторная иллюстрация, ровный чёрный контур, плоские заливки без градиентов и теней. Палитра: красный #D50032, тёмно-красный #AB2328, чёрный #141414, коричневый #54341B, жёлтый #FFD07B, белый. Вокруг несколько мелких жёлтых конфетти. Белый фон. Без текста, логотипов и пива.

### kvasych-inspector.png: проверяет качество

Где: ведущий игры «Поймай брак», стикер «Проверим».

**English**

> Kvasych, the mascot of a Russian kvass factory: a friendly stocky master craftsman around fifty with a big bushy reddish-blond walrus mustache, round face, red work jacket (#D50032) with black inserts and a silver reflective stripe, black trousers and boots, white hard hat. He inspects quality: holds a round magnifying glass up to his right eye, the eye looks enlarged behind the lens, the other eye narrowed in a strict squint, eyebrows drawn together, mouth in a firm line under the mustache. In his left hand a clipboard with a checklist of simple lines and red tick marks, no readable text. Full body, feet on the bottom edge. Flat 2D vector illustration, uniform black outline, flat fills, no gradients, no shadows. Palette: red #D50032, dark red #AB2328, black #141414, kvass brown #54341B, warm yellow #FFD07B, white. Plain white background. No text, no logos, no beer.

**Русский**

> Квасыч, маскот российского завода кваса: добродушный коренастый мастер около пятидесяти лет с большими пышными рыжевато-русыми усами, круглым лицом, в красной рабочей куртке (#D50032) с чёрными вставками и серебристой полосой, чёрных брюках, ботинках и белой каске. Проверяет качество: подносит к правому глазу круглую лупу, глаз за линзой выглядит увеличенным, другой глаз строго прищурен, брови сведены, губы под усами сжаты. В левой руке планшет с чек-листом из простых линий и красных галочек, без читаемого текста. В полный рост, ноги на нижнем крае. Плоская векторная иллюстрация, ровный чёрный контур, плоские заливки без градиентов и теней. Палитра: красный #D50032, тёмно-красный #AB2328, чёрный #141414, коричневый #54341B, жёлтый #FFD07B, белый. Белый фон. Без текста, логотипов и пива.

### kvasych-oops.png: хватается за голову

Где: ошибка в игре, стикер «Ой, брак».

**English**

> Kvasych, the mascot of a Russian kvass factory: a friendly stocky master craftsman around fifty with a big bushy reddish-blond walrus mustache, round face, red work jacket (#D50032) with black inserts and a silver reflective stripe, black trousers and boots. He has just made a funny mistake: grabs his head with both hands, eyes wide open, eyebrows raised high, mouth a small round "o" under the mustache, slightly leaning back. Comic, not scared. Full body, feet on the bottom edge. Flat 2D vector illustration, uniform black outline, flat fills, no gradients, no shadows. Palette: red #D50032, dark red #AB2328, black #141414, kvass brown #54341B, warm yellow #FFD07B, white. Plain white background. No text, no logos, no beer.

**Русский**

> Квасыч, маскот российского завода кваса: добродушный коренастый мастер около пятидесяти лет с большими пышными рыжевато-русыми усами, круглым лицом, в красной рабочей куртке (#D50032) с чёрными вставками и серебристой полосой, чёрных брюках и ботинках. Только что смешно ошибся: схватился за голову обеими руками, глаза широко открыты, брови высоко подняты, рот маленьким кружком «о» под усами, чуть отклонился назад. Смешно, а не страшно. В полный рост, ноги на нижнем крае. Плоская векторная иллюстрация, ровный чёрный контур, плоские заливки без градиентов и теней. Палитра: красный #D50032, тёмно-красный #AB2328, чёрный #141414, коричневый #54341B, жёлтый #FFD07B, белый. Белый фон. Без текста, логотипов и пива.

### kvasych-meh.png: «бывает»

Где: пропущенный брак в игре, пустой фильтр вакансий, стикер «Бывает».

**English**

> Kvasych, the mascot of a Russian kvass factory: a friendly stocky master craftsman around fifty with a big bushy reddish-blond walrus mustache, round kind face, red work jacket (#D50032) with black inserts and a silver reflective stripe, black trousers and boots. He shrugs good-naturedly: shoulders raised, both hands spread to the sides with palms up, eyebrows raised, head slightly tilted, a calm half-smile under the mustache that says "it happens". Full body, feet on the bottom edge. Flat 2D vector illustration, uniform black outline, flat fills, no gradients, no shadows. Palette: red #D50032, dark red #AB2328, black #141414, kvass brown #54341B, warm yellow #FFD07B, white. Plain white background. No text, no logos, no beer.

**Русский**

> Квасыч, маскот российского завода кваса: добродушный коренастый мастер около пятидесяти лет с большими пышными рыжевато-русыми усами, круглым добрым лицом, в красной рабочей куртке (#D50032) с чёрными вставками и серебристой полосой, чёрных брюках и ботинках. Добродушно пожимает плечами: плечи подняты, обе руки разведены в стороны ладонями вверх, брови приподняты, голова чуть наклонена, спокойная полуулыбка под усами, будто говорит «бывает». В полный рост, ноги на нижнем крае. Плоская векторная иллюстрация, ровный чёрный контур, плоские заливки без градиентов и теней. Палитра: красный #D50032, тёмно-красный #AB2328, чёрный #141414, коричневый #54341B, жёлтый #FFD07B, белый. Белый фон. Без текста, логотипов и пива.

### kvasych-thumbs.png: палец вверх

Где: пойманный брак в игре, шаги до первой смены, стикер «Глаз-алмаз».

**English**

> Kvasych, the mascot of a Russian kvass factory: a friendly stocky master craftsman around fifty with a big bushy reddish-blond walrus mustache, round kind face, red work jacket (#D50032) with black inserts and a silver reflective stripe, black trousers and boots. He gives a big thumbs-up with his right hand stretched toward the viewer, winks with his left eye and grins confidently under the mustache. Left hand holds a 1.5-litre plastic bottle of amber kvass with a red cap and a plain white label. Full body, feet on the bottom edge. Flat 2D vector illustration, uniform black outline, flat fills, no gradients, no shadows. Palette: red #D50032, dark red #AB2328, black #141414, kvass brown #54341B, warm yellow #FFD07B, white. Plain white background. No text, no logos, no beer.

**Русский**

> Квасыч, маскот российского завода кваса: добродушный коренастый мастер около пятидесяти лет с большими пышными рыжевато-русыми усами, круглым добрым лицом, в красной рабочей куртке (#D50032) с чёрными вставками и серебристой полосой, чёрных брюках и ботинках. Показывает большой палец вверх правой рукой, вытянутой к зрителю, подмигивает левым глазом и уверенно улыбается под усами. В левой руке полуторалитровая пластиковая бутылка янтарного кваса с красной крышкой и белой этикеткой без надписей. В полный рост, ноги на нижнем крае. Плоская векторная иллюстрация, ровный чёрный контур, плоские заливки без градиентов и теней. Палитра: красный #D50032, тёмно-красный #AB2328, чёрный #141414, коричневый #54341B, жёлтый #FFD07B, белый. Белый фон. Без текста, логотипов и пива.

### kvasych-phone.png: печатает в телефоне

Где: отклик через Telegram и форму, стикер «Пишу».

**English**

> Kvasych, the mascot of a Russian kvass factory: a friendly stocky master craftsman around fifty with a big bushy reddish-blond walrus mustache, round kind face, red work jacket (#D50032) with black inserts and a silver reflective stripe, black trousers and boots. He holds a smartphone with both hands at chest height and types with both thumbs, looking down at the screen with focused eyes and a slight smile, tip of the tongue not shown. The screen shows two simple chat bubbles, one red and one white, no readable text. Full body, feet on the bottom edge. Flat 2D vector illustration, uniform black outline, flat fills, no gradients, no shadows. Palette: red #D50032, dark red #AB2328, black #141414, kvass brown #54341B, warm yellow #FFD07B, white. Plain white background. No text, no logos, no beer.

**Русский**

> Квасыч, маскот российского завода кваса: добродушный коренастый мастер около пятидесяти лет с большими пышными рыжевато-русыми усами, круглым добрым лицом, в красной рабочей куртке (#D50032) с чёрными вставками и серебристой полосой, чёрных брюках и ботинках. Держит смартфон обеими руками на уровне груди и печатает двумя большими пальцами, смотрит в экран сосредоточенно и с лёгкой улыбкой. На экране два простых пузыря чата, красный и белый, без читаемого текста. В полный рост, ноги на нижнем крае. Плоская векторная иллюстрация, ровный чёрный контур, плоские заливки без градиентов и теней. Палитра: красный #D50032, тёмно-красный #AB2328, чёрный #141414, коричневый #54341B, жёлтый #FFD07B, белый. Белый фон. Без текста, логотипов и пива.

### kvasych-clock.png: смотрит на часы

Где: график смен, срок ответа HR, стикер «Смена в 8:00».

**English**

> Kvasych, the mascot of a Russian kvass factory: a friendly stocky master craftsman around fifty with a big bushy reddish-blond walrus mustache, round kind face, red work jacket (#D50032) with black inserts and a silver reflective stripe, black trousers and boots. He raises his left forearm in front of his chest and looks at a simple round wristwatch, the watch face shows hands at eight o'clock, no digits. Slightly businesslike expression, one eyebrow raised, lips pressed under the mustache. Right hand on his hip. Full body, feet on the bottom edge. Flat 2D vector illustration, uniform black outline, flat fills, no gradients, no shadows. Palette: red #D50032, dark red #AB2328, black #141414, kvass brown #54341B, warm yellow #FFD07B, white. Plain white background. No text, no logos, no beer.

**Русский**

> Квасыч, маскот российского завода кваса: добродушный коренастый мастер около пятидесяти лет с большими пышными рыжевато-русыми усами, круглым добрым лицом, в красной рабочей куртке (#D50032) с чёрными вставками и серебристой полосой, чёрных брюках и ботинках. Поднял левое предплечье перед грудью и смотрит на простые круглые наручные часы, стрелки показывают восемь часов, цифр нет. Деловитое выражение, одна бровь приподнята, губы под усами сжаты. Правая рука на поясе. В полный рост, ноги на нижнем крае. Плоская векторная иллюстрация, ровный чёрный контур, плоские заливки без градиентов и теней. Палитра: красный #D50032, тёмно-красный #AB2328, чёрный #141414, коричневый #54341B, жёлтый #FFD07B, белый. Белый фон. Без текста, логотипов и пива.

### kvasych-point.png: показывает в сторону

Где: подсказки рядом с кнопками, листовки, стикер «Тебе туда».

**English**

> Kvasych, the mascot of a Russian kvass factory: a friendly stocky master craftsman around fifty with a big bushy reddish-blond walrus mustache, round kind face, red work jacket (#D50032) with black inserts and a silver reflective stripe, black trousers and boots. He stands at three-quarter view and points to the right with his whole right arm fully extended and the index finger out, as if showing the way to a button. His head turns to the viewer with a friendly encouraging smile under the mustache. Left hand holds a 1.5-litre plastic bottle of amber kvass with a red cap and a plain white label. Full body, feet on the bottom edge, empty space on the right side of the canvas. Flat 2D vector illustration, uniform black outline, flat fills, no gradients, no shadows. Palette: red #D50032, dark red #AB2328, black #141414, kvass brown #54341B, warm yellow #FFD07B, white. Plain white background. No text, no logos, no beer.

**Русский**

> Квасыч, маскот российского завода кваса: добродушный коренастый мастер около пятидесяти лет с большими пышными рыжевато-русыми усами, круглым добрым лицом, в красной рабочей куртке (#D50032) с чёрными вставками и серебристой полосой, чёрных брюках и ботинках. Стоит вполоборота и показывает вправо полностью вытянутой правой рукой с указательным пальцем, будто показывает дорогу к кнопке. Голова повёрнута к зрителю, дружелюбная ободряющая улыбка под усами. В левой руке полуторалитровая пластиковая бутылка янтарного кваса с красной крышкой и белой этикеткой без надписей. В полный рост, ноги на нижнем крае, справа на картинке свободное место. Плоская векторная иллюстрация, ровный чёрный контур, плоские заливки без градиентов и теней. Палитра: красный #D50032, тёмно-красный #AB2328, чёрный #141414, коричневый #54341B, жёлтый #FFD07B, белый. Белый фон. Без текста, логотипов и пива.

### kvasych-peek.png: выглядывает из-за края

Где: раздел вопросов и ответов, стикер «Я тут».

**English**

> Kvasych, the mascot of a Russian kvass factory: a friendly master craftsman around fifty with a big bushy reddish-blond walrus mustache, round kind face, short neat hair, red work jacket (#D50032) with black inserts. He peeks out from behind the left edge of the canvas: only his head, the mustache, one shoulder and the fingers of both hands gripping the edge are visible, the rest of the body hidden off-canvas. Curious playful look, eyebrows raised, small smile under the mustache, looking at the viewer. Flat 2D vector illustration, uniform black outline, flat fills, no gradients, no shadows. Palette: red #D50032, dark red #AB2328, black #141414, kvass brown #54341B, warm yellow #FFD07B, white. Plain white background. No text, no logos, no beer.

**Русский**

> Квасыч, маскот российского завода кваса: добродушный мастер около пятидесяти лет с большими пышными рыжевато-русыми усами, круглым добрым лицом, короткой стрижкой, в красной рабочей куртке (#D50032) с чёрными вставками. Выглядывает из-за левого края картинки: видны только голова, усы, одно плечо и пальцы обеих рук, которые держатся за край, остальное тело за краем. Любопытный озорной взгляд, брови приподняты, лёгкая улыбка под усами, смотрит на зрителя. Плоская векторная иллюстрация, ровный чёрный контур, плоские заливки без градиентов и теней. Палитра: красный #D50032, тёмно-красный #AB2328, чёрный #141414, коричневый #54341B, жёлтый #FFD07B, белый. Белый фон. Без текста, логотипов и пива.

### kvasych-lost.png: заблудился с картой

Где: страница 404, стикер «Где я».

**English**

> Kvasych, the mascot of a Russian kvass factory: a friendly stocky master craftsman around fifty with a big bushy reddish-blond walrus mustache, round kind face, red work jacket (#D50032) with black inserts and a silver reflective stripe, black trousers and boots. He holds a large unfolded paper map with both hands and looks at it confused: one eyebrow raised, the other lowered, mouth twisted to one side under the mustache, head tilted. The map shows simple flat shapes and a dotted path, no readable text. Full body, feet on the bottom edge. Flat 2D vector illustration, uniform black outline, flat fills, no gradients, no shadows. Palette: red #D50032, dark red #AB2328, black #141414, kvass brown #54341B, warm yellow #FFD07B, white. Plain white background. No text, no logos, no beer.

**Русский**

> Квасыч, маскот российского завода кваса: добродушный коренастый мастер около пятидесяти лет с большими пышными рыжевато-русыми усами, круглым добрым лицом, в красной рабочей куртке (#D50032) с чёрными вставками и серебристой полосой, чёрных брюках и ботинках. Держит обеими руками большую развёрнутую бумажную карту и растерянно в неё смотрит: одна бровь поднята, другая опущена, рот под усами скошен в сторону, голова наклонена. На карте простые плоские фигуры и пунктирная дорожка, без читаемого текста. В полный рост, ноги на нижнем крае. Плоская векторная иллюстрация, ровный чёрный контур, плоские заливки без градиентов и теней. Палитра: красный #D50032, тёмно-красный #AB2328, чёрный #141414, коричневый #54341B, жёлтый #FFD07B, белый. Белый фон. Без текста, логотипов и пива.

## Мемы для презентации

Стиль другой: грубый чёрный рисунок от руки, как у мемов-сойджеков. Текст на картинке не генерируем, подписи ставим шрифтом презентации. Квасыча узнают по усам и красной куртке, поэтому они есть и в мемах.

### kvasych-meme-point.png: удивлённо показывает пальцем

Где в презентации: слайд «Первый экран и задания» с подписью «Когда зарплату видно раньше, чем дочитал вакансию» или слайд HR-панели с подписью «Когда ответ «тяжело» сам стал задачей позвонить».

**English**

> A meme illustration in the style of the "pointing soyjak" internet meme: rough black hand-drawn marker lines with slight wobble, white background, almost no color. The character is Kvasych, a stocky man around fifty with a round head, short hair, a big bushy walrus mustache drawn with many short strokes and light stubble along the jaw. Head and upper body only, the head large relative to the body. Excited surprised face: eyes wide open with small black pupils, eyebrows raised high with forehead lines, mouth wide open in a big black oval under the mustache. His right arm stretches to the left side of the frame and points with the index finger at something outside the picture. The only color is the collar and shoulders of a red work jacket filled flat with red #D50032. Square canvas, the figure on the right half, empty white space on the left for a caption. No text, no letters, no logos, no beer.

**Русский**

> Мем в стиле «сойджек показывает пальцем»: грубые чёрные линии маркером от руки, слегка неровные, белый фон, почти без цвета. Персонаж Квасыч: коренастый мужчина около пятидесяти лет с круглой головой, короткой стрижкой, большими пышными усами из множества коротких штрихов и лёгкой щетиной по линии челюсти. Только голова и верх туловища, голова крупная. Восторженно удивлённое лицо: глаза широко открыты, маленькие чёрные зрачки, брови высоко подняты, на лбу складки, рот широко открыт большим чёрным овалом под усами. Правая рука вытянута в левую сторону картинки и указательным пальцем показывает на что-то за кадром. Единственный цвет: воротник и плечи красной рабочей куртки, залитые плоским красным #D50032. Квадратная картинка, персонаж в правой половине, слева пустое белое место под подпись. Без текста, букв, логотипов и пива.

### kvasych-meme-smug.png: довольный в очках

Где в презентации: слайд про викторину с подписью «7 из 7, значок «1978» мой» или слайд обоснования с подписью «Когда у студентов нет испытательного срока».

**English**

> A meme illustration in the style of the "smug glasses soyjak" internet meme: rough black hand-drawn marker lines with slight wobble, white background, almost no color. The character is Kvasych, a stocky man around fifty with a round head, short hair, a big bushy walrus mustache drawn with many short strokes and stubble along the jaw and chin. Head and neck only, three-quarter view turned to the right. Thick black rectangular glasses, half-closed lazy eyes looking sideways at the viewer, one eyebrow slightly raised, a smug closed-mouth smirk under the mustache, forehead with a few lines. The only color is the collar of a red work jacket filled flat with red #D50032 at the bottom. Square canvas, the head in the upper two thirds, empty white space at the bottom for a caption. No text, no letters, no logos, no beer.

**Русский**

> Мем в стиле «самодовольный сойджек в очках»: грубые чёрные линии маркером от руки, слегка неровные, белый фон, почти без цвета. Персонаж Квасыч: коренастый мужчина около пятидесяти лет с круглой головой, короткой стрижкой, большими пышными усами из множества коротких штрихов и щетиной по линии челюсти и подбородку. Только голова и шея, вполоборота вправо. Толстые чёрные прямоугольные очки, полуприкрытые ленивые глаза смотрят искоса на зрителя, одна бровь чуть приподнята, самодовольная ухмылка с закрытым ртом под усами, на лбу несколько складок. Единственный цвет: воротник красной рабочей куртки внизу, залитый плоским красным #D50032. Квадратная картинка, голова в верхних двух третях, внизу пустое белое место под подпись. Без текста, букв, логотипов и пива.

Готовые мемы присылай как PNG, подписи и место на слайде поставим при сборке презентации.
