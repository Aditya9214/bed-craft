// Builds the whole game into one self-contained HTML file.
//
// `bun run build` produces a Sites Worker build (separate JS/CSS/worker files
// served over HTTP). This one inlines everything - script, styles, fonts and
// the chunk mesher worker - into dist-standalone/buffcraft.html, so the game
// runs by double-clicking the file: no server, no network, solo and sandbox
// play against bots.
//
//   node scripts/build-standalone.mjs     (or: bun run build:standalone)
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, 'dist-standalone')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * The renderer starts its mesher as a module worker, which cannot load from a
 * file:// page (Chrome refuses the request and the fallback never runs). Swap
 * the worker for Vite's inline variant, which is a blob URL, so the thread
 * survives without a server. Build-time only: the game's source is untouched.
 */
const inlineMesherWorker = {
  name: 'inline-mesher-worker',
  enforce: 'pre',
  transform(code, id) {
    if (!id.replace(/\\/g, '/').endsWith('/src/engine/render/chunks.ts')) return null
    const marker = "new Worker(new URL('./mesh-worker.ts', import.meta.url), { type: 'module' })"
    if (!code.includes(marker)) throw new Error('mesh worker creation moved; update build-standalone.mjs')
    return {
      code: `import MesherWorker from './mesh-worker.ts?worker&inline'\n${code.replace(marker, 'new MesherWorker()')}`,
      map: null,
    }
  },
}

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  define: { __SITES__: true, __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [inlineMesherWorker],
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    modulePreload: false,
    // Big enough that fonts and images become data URIs instead of files.
    assetsInlineLimit: 32 * 1024 * 1024,
    chunkSizeWarningLimit: 4000,
    rollupOptions: { output: { inlineDynamicImports: true, manualChunks: undefined } },
  },
})

/** A single file leaves nothing to fetch: everything goes between the tags. */
const escapeScript = (js) => js.replace(/<\/script/gi, '<\\/script')
const escapeStyle = (css) => css.replace(/<\/style/gi, '<\\/style')

const htmlPath = join(outDir, 'index.html')
let html = readFileSync(htmlPath, 'utf8')
html = html
  // Drop the icon and preloads: a data-URI page needs no extra requests.
  .replace(/<link rel="icon"[^>]*>\s*/i, '')
  .replace(/<link rel="modulepreload"[^>]*>\s*/gi, '')
  .replace(/<link rel="stylesheet"([^>]*?)href="([^"]+)"([^>]*?)>/gi, (tag, _b, href) => {
    if (/^https?:/i.test(href)) return ''
    return `<style>\n${escapeStyle(readFileSync(join(outDir, href.replace(/^\//, '')), 'utf8'))}\n</style>`
  })
  .replace(/<script([^>]*?)src="([^"]+)"([^>]*)><\/script>/gi, (tag, _b, src) => {
    if (/^https?:/i.test(src)) return tag
    return `<script type="module">\n${escapeScript(readFileSync(join(outDir, src.replace(/^\//, '')), 'utf8'))}\n</script>`
  })

writeFileSync(htmlPath, html)

// Only the page itself may remain; anything else means something escaped the
// inliner and would be a missing file on file://.
for (const name of readdirSync(outDir)) if (name !== 'index.html') rmSync(join(outDir, name), { recursive: true, force: true })
const leftovers = readdirSync(outDir).filter((name) => name !== 'index.html')
if (leftovers.length) throw new Error(`not self-contained, leftover files: ${leftovers.join(', ')}`)
if (/<script[^>]+src=|<link[^>]+href="(?!data:)/i.test(html)) throw new Error('page still loads an external file')
const size = statSync(htmlPath).size
console.log(`dist-standalone/index.html  ${(size / 1024 / 1024).toFixed(2)} MB, single file`)
