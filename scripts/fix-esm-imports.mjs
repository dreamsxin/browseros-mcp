import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { extname, join } from 'node:path'

const distDir = fileURLToPath(new URL('../dist/', import.meta.url))

const RELATIVE_SPECIFIER =
  /(\b(?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"]+?)(['"]\)?)/g

function hasExtension(specifier) {
  const last = specifier.split('/').pop() ?? ''
  return extname(last) !== ''
}

function rewriteImports(source) {
  return source.replace(
    RELATIVE_SPECIFIER,
    (match, prefix, specifier, suffix) => {
      if (hasExtension(specifier)) return match
      return `${prefix}${specifier}.js${suffix}`
    },
  )
}

async function* jsFiles(dir) {
  for (const entry of await readdir(dir)) {
    const path = join(dir, entry)
    const info = await stat(path)
    if (info.isDirectory()) {
      yield* jsFiles(path)
    } else if (entry.endsWith('.js')) {
      yield path
    }
  }
}

for await (const file of jsFiles(distDir)) {
  const source = await readFile(file, 'utf8')
  const rewritten = rewriteImports(source)
  if (rewritten !== source) await writeFile(file, rewritten)
}
