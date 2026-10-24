import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'

const br = promisify(brotliCompress)
const gz = promisify(gzip)

/**
 * Кладёт рядом с каждым текстовым файлом сборки .br и .gz.
 * Сервер (server/app.ts) отдаёт их через serveStatic({ precompressed: true }), так что
 * сжимать на лету не нужно, а brotli можно жать на максимальном уровне.
 * Картинки, шрифты и уже сжатые форматы не трогаем.
 */
function precompress(): Plugin {
  let outDir = 'dist'
  return {
    name: 'ochakovo:precompress',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    async closeBundle() {
      const files = (await readdir(outDir, { recursive: true })).filter((f) => /\.(js|mjs|css|html|svg|json|txt|xml|webmanifest)$/i.test(f))
      let before = 0
      let after = 0
      await Promise.all(
        files.map(async (name) => {
          const path = join(outDir, name)
          if ((await stat(path)).size < 1024) return
          const data = await readFile(path)
          const [b, g] = await Promise.all([
            br(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
            gz(data, { level: 9 }),
          ])
          // Сжатая копия, которая почти не меньше оригинала, только тратит диск
          if (b.length < data.length * 0.9) await writeFile(`${path}.br`, b)
          if (g.length < data.length * 0.9) await writeFile(`${path}.gz`, g)
          before += data.length
          after += b.length
        }),
      )
      this.info(`brotli: ${Math.round(before / 1024)} → ${Math.round(after / 1024)} КБ`)
    },
  }
}

/**
 * Какие позы Квасыча уже нарисованы: список файлов public/mascot/kvasych-<поза>.webp
 * как модуль `virtual:mascot-poses`. Страница не запрашивает картинки, которых ещё нет,
 * а новая картинка подхватывается без перезапуска dev-сервера.
 */
function mascotPoses(): Plugin {
  const id = 'virtual:mascot-poses'
  const dir = fileURLToPath(new URL('./public/mascot', import.meta.url))
  const list = async () =>
    (await readdir(dir).catch(() => [] as string[])).flatMap((f) => f.match(/^kvasych-([a-z]+)\.webp$/)?.[1] ?? []).sort()
  return {
    name: 'ochakovo:mascot-poses',
    resolveId: (source) => (source === id ? '\0' + id : undefined),
    load: async (source) => (source === '\0' + id ? `export default ${JSON.stringify(await list())}` : undefined),
    configureServer(server) {
      server.watcher.add(dir)
      const reload = (file: string) => {
        if (!file.startsWith(dir)) return
        const mod = server.moduleGraph.getModuleById('\0' + id)
        if (mod) server.reloadModule(mod)
      }
      server.watcher.on('add', reload)
      server.watcher.on('unlink', reload)
    },
  }
}

/**
 * Материалы кейса для экспертов по адресу /materials/…: макеты и превью из docs/brand — листовки, мерч, обложки роликов,
 * стенд, презентация. Страница /materials (src/pages/Materials.tsx) ведёт на них. В макетах пути к public/ относительные
 * (../../../public/brand/…), чтобы они открывались прямо из папки проекта; на сайте public/ лежит в корне, поэтому при
 * сборке и в dev-сервере пути переписываются на /brand/…. Документы .md не публикуем — они в репозитории.
 */
function materials(): Plugin {
  const src = fileURLToPath(new URL('./docs/brand', import.meta.url))
  const dirs = ['print', 'merch', 'clips', 'stand', 'frames', 'img', 'deck', 'stickers']
  const types: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    // Скрипты макетов (вылеты, обложки, показ презентации): встроенные сайт не выполняет — CSP script-src 'self'
    js: 'text/javascript; charset=utf-8',
    svg: 'image/svg+xml',
    txt: 'text/plain; charset=utf-8',
    webp: 'image/webp',
    jpg: 'image/jpeg',
    png: 'image/png',
    woff2: 'font/woff2',
    pdf: 'application/pdf',
    zip: 'application/zip',
  }
  const ext = (f: string) => f.slice(f.lastIndexOf('.') + 1).toLowerCase()
  const rewrite = (f: string, data: Buffer) =>
    /^(html|css|svg|js)$/.test(ext(f)) ? Buffer.from(data.toString('utf8').replace(/(?:\.\.\/)+public\//g, '/')) : data
  const list = async () => {
    const out: string[] = []
    for (const d of dirs)
      // Папки нет (сборка без docs/brand) — материалов на сайте не будет, сама сборка не падает
      for (const f of await readdir(join(src, d), { recursive: true }).catch(() => [] as string[]))
        if (types[ext(f)] && (await stat(join(src, d, f))).isFile()) out.push(`${d}/${f}`)
    return out
  }
  return {
    name: 'ochakovo:materials',
    async generateBundle() {
      const files = await list()
      if (!files.length) this.warn('docs/brand не найдена: страница /materials останется без макетов')
      for (const f of files) this.emitFile({ type: 'asset', fileName: `materials/${f}`, source: rewrite(f, await readFile(join(src, f))) })
    },
    configureServer(server) {
      server.middlewares.use('/materials/', async (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '')
        if (!dirs.includes(rel.split('/')[0]) || rel.includes('..') || !types[ext(rel)]) return next()
        try {
          const data = rewrite(rel, await readFile(join(src, rel)))
          res.setHeader('Content-Type', types[ext(rel)])
          res.end(data)
        } catch {
          next()
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), materials(), precompress(), mascotPoses()],
  resolve: { alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) } },
  build: {
    // dist/.vite/manifest.json: по нему сервер ставит modulepreload на чанк страницы (/apply, /vacancies и др.) —
    // браузер качает его вместе с основным скриптом, а не после. Наружу /.vite сервер не отдаёт
    manifest: true,
    rolldownOptions: {
      output: {
        // Библиотеки отдельными файлами: правки сайта не сбрасывают их кэш у посетителей,
        // а браузер качает их параллельно с кодом страниц
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/, priority: 30 },
            { name: 'vendor-motion', test: /node_modules[\\/](motion|framer-motion|motion-dom|motion-utils)[\\/]/, priority: 20 },
            // Плавная прокрутка (src/lib/motion.ts). GSAP больше не нужен: появление — на IntersectionObserver и CSS
            { name: 'vendor-lenis', test: /node_modules[\\/]lenis[\\/]/, priority: 20 },
          ],
        },
      },
    },
  },
  server: {
    port: 5180,
    strictPort: true,
    // API и вебхуки ботов живут в отдельном процессе (pnpm server)
    proxy: { '/api': `http://localhost:${process.env.API_PORT ?? 8787}` },
  },
})
