// Every language's table (locales/<code>.json) has every string the sources pass to t(), tn(), msg(), msgn() or
// problem(), with the same {placeholders}, and the plural forms its language needs. `node test-i18n.js --keys` prints the English keys.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { ACTIONS } from './lib/jev.ts'
import { english, LANGUAGES, msgn, pick, problem, say, shown, t, useLanguage } from './lib/i18n.ts'

const sources = ['lib', 'entrypoints', 'entrypoints/popup', 'entrypoints/android']
  .flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(`${dir}/${f}`, 'utf8')))
const literal = String.raw`('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")`
const unquote = (s) => s.slice(1, -1).replace(/\\(.)/g, '$1')
const plain = new Set(), plural = new Set()
for (const code of sources) {
  for (const [, s] of code.matchAll(new RegExp(String.raw`\b(?:t|msg|problem)\(\s*${literal}`, 'g'))) plain.add(unquote(s))
  for (const [, , other] of code.matchAll(new RegExp(String.raw`\b(?:tn|msgn)\([^'"]*?,\s*${literal},\s*${literal}`, 'g'))) plural.add(unquote(other))
}
// Keys that reach t() through a variable: Jev's answers and the tampered-state message.
for (const actions of Object.values(ACTIONS)) for (const action of Object.keys(actions)) plain.add(action)
plain.add(readFileSync('lib/store.ts', 'utf8').match(/export const TAMPERED = '([^']+)'/)[1])

if (process.argv.includes('--keys')) {
  console.log(JSON.stringify({ plain: [...plain].sort(), plural: [...plural].sort() }, null, 1))
  process.exit()
}

const names = (s) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map(([, n]) => n))].sort()
const files = readdirSync('locales').map((f) => f.replace(/\.json$/, '')).sort()
assert.deepEqual(files, [...LANGUAGES].sort(), 'one table per language in lib/i18n.ts')
for (const code of files) {
  const table = JSON.parse(readFileSync(`locales/${code}.json`, 'utf8'))
  const problems = []
  for (const key of plain) {
    const value = table[key]
    if (typeof value !== 'string' || !value.trim()) problems.push(`missing: ${key}`)
    else if (names(value).join() !== names(key).join()) problems.push(`placeholders: ${key} → ${value}`)
  }
  const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories
  for (const key of plural) {
    const forms = table[key]
    if (typeof forms !== 'object' || !forms) { problems.push(`missing plural: ${key}`); continue }
    for (const category of categories) {
      const form = forms[category]
      if (typeof form !== 'string' || !form.trim()) problems.push(`missing ${category}: ${key}`)
      // A form for one count may spell the count out ("one character"), but never names a value the key lacks.
      else if (!names(form).every((n) => names(key).includes(n))) problems.push(`placeholders (${category}): ${key} → ${form}`)
    }
    if (!names(forms.other ?? '').includes('n')) problems.push(`plural other needs {n}: ${key}`)
  }
  for (const key of Object.keys(table)) if (!plain.has(key) && !plural.has(key)) problems.push(`unused: ${key}`)
  assert.deepEqual(problems, [], `locales/${code}.json`)
}

// The device's language picks a table: by region for English, Portuguese and Spanish, by script for Chinese.
assert.equal(pick(['de-AT', 'en-US']), 'de')
assert.equal(pick(['en-US']), 'en')
assert.equal(pick(['en-AU']), 'en-GB')
assert.equal(pick(['pt-BR']), 'pt-BR')
assert.equal(pick(['pt']), 'pt-BR') // Intl likely-subtags: Portuguese alone is Brazil's
assert.equal(pick(['pt-AO']), 'pt-PT')
assert.equal(pick(['es-MX']), 'es-419')
assert.equal(pick(['es-ES']), 'es')
assert.equal(pick(['zh-TW']), 'zh-Hant')
assert.equal(pick(['zh-HK']), 'zh-Hant')
assert.equal(pick(['zh-CN']), 'zh-Hans')
assert.equal(pick(['zh']), 'zh-Hans')
assert.equal(pick(['xx', 'fy-NL', 'nl-BE']), 'nl')
assert.equal(pick([]), 'en')

// In another language, what sites, code and Jev read stays English; the wallet shows the translation.
const HOLDERS = ['token {name} ({symbol}) with {n} holder', 'token {name} ({symbol}) with {n} holders']
await useLanguage(['de-DE'], async () => ({ 'Wallet is locked': 'Wallet ist gesperrt',
  [HOLDERS[1]]: { one: 'Token {name} ({symbol}) mit einem Inhaber', other: 'Token {name} ({symbol}) mit {n} Inhabern' } }))
const locked = problem('Wallet is locked')
assert.equal(locked.message, 'Wallet is locked')
assert.equal(shown(locked), 'Wallet ist gesperrt')
assert.equal(shown(new Error('raw')), 'raw')
const holders = msgn(1234567, ...HOLDERS, { name: 'USD Coin', symbol: 'USDC' })
assert.equal(say(holders), 'Token USD Coin (USDC) mit 1.234.567 Inhabern') // counts in the language's grouping
assert.equal(english(holders), 'token USD Coin (USDC) with 1,234,567 holders')
assert.equal(english(msgn(1, ...HOLDERS, { name: 'A', symbol: 'A' })), 'token A (A) with 1 holder')
assert.equal(say('Some {tag}'), 'Some {tag}') // text from outside is shown as it is
// Only a template's own values fill it, and only the table's own keys translate.
assert.equal(t('{toString} {constructor}'), '{toString} {constructor}')
assert.equal(t('constructor'), 'constructor')
console.log(`i18n: ${files.length} languages × ${plain.size + plural.size} strings ok`)
