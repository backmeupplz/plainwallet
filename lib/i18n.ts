// The wallet's words in the device's language. English is both the key and the fallback: t('Send') looks 'Send' up in
// the language's table (locales/<code>.json) and is 'Send' itself until one is in use. Pages pick a table with
// useLanguage(). In the apps the background shares the popup's page and table, so what sites, code and Jev read is
// English by construction: lib/ throws Problems (English message, shown translated) and Jev gets english() renderings.
// test-i18n.js checks that every table has every t()/tn()/msg()/msgn()/problem() key in the sources, with the same
// {placeholders}.

/** A translation, or one per plural category ('one', 'few', 'many', 'other'...) for tn(). */
export type Table = Record<string, string | Partial<Record<Intl.LDMLPluralRule, string>>>
/** Text decided in one place and shown in another (the background's summary of a request, shown by the popup): the
 * key, its values, and values that are themselves text to translate. Survives being sent as a message. With a `count`,
 * it is tn()'s: `text` is the plural key and `one` English's singular. */
export type Msg = { text: string; vars?: Record<string, string | number | Msg>; count?: number; one?: string }
/** Text from outside (an explorer's names and tags) shown as it is, or a Msg to translate. */
export type Text = string | Msg

// The store listings' languages (fastlane/metadata); the Android and Apple apps' own strings come in the same ones.
export const LANGUAGES = ['ar', 'de', 'en-GB', 'es', 'es-419', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'nl', 'pl', 'pt-BR', 'pt-PT', 'ru', 'sv',
  'th', 'tr', 'uk', 'vi', 'zh-Hans', 'zh-Hant'] as const

let table: Table = {}
let language = 'en'

/** The first of the device's languages we have, or English: Portuguese and Spanish by region, Chinese by script. */
export function pick(preferred: readonly string[]): string {
  for (const tag of preferred) {
    let locale: Intl.Locale
    try { locale = new Intl.Locale(tag).maximize() } catch { continue }
    const { language, script, region } = locale
    const code = language === 'en' ? (['GB', 'IE', 'AU', 'NZ'].includes(region!) ? 'en-GB' : 'en')
      : language === 'zh' ? `zh-${script === 'Hant' ? 'Hant' : 'Hans'}`
      : language === 'pt' ? `pt-${region === 'BR' ? 'BR' : 'PT'}`
      : language === 'es' ? (region === 'ES' ? 'es' : 'es-419')
      : language
    if (code === 'en' || (LANGUAGES as readonly string[]).includes(code)) return code
  }
  return 'en'
}

/** Switches to the device's language. `get` loads a table; if it fails, the wallet stays in English. */
export async function useLanguage(preferred: readonly string[], get: (code: string) => Promise<Table>) {
  const code = pick(preferred)
  if (code !== 'en') {
    try {
      table = await get(code)
      language = code
    } catch {}
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr'
  }
}

// One pass over the template only: a value that happens to contain {braces} (a site's text, say) is left as it is.
const fill = (template: string, vars: Msg['vars'] = {}, show: (m: Msg) => string = say): string =>
  template.replace(/\{(\w+)\}/g, (match, name: string): string => {
    const value = Object.hasOwn(vars, name) ? vars[name] : undefined
    return value === undefined ? match : typeof value === 'object' ? show(value) : String(value)
  })
// Counts in the language's digit grouping, always with Latin digits like the amounts around them.
const count = (n: number, code: string) => n.toLocaleString(code === 'en' ? 'en-US' : code, { numberingSystem: 'latn' } as Intl.NumberFormatOptions)

export function t(text: string, vars?: Msg['vars']): string {
  const found = Object.hasOwn(table, text) ? table[text] : undefined
  return fill(typeof found === 'string' ? found : text, vars)
}

/** Text with a count in it: `{n}` is the count, and `one` is English's singular (the key is the plural). */
export function tn(n: number, one: string, other: string, vars?: Msg['vars']) {
  const found = Object.hasOwn(table, other) ? table[other] : undefined
  const form = typeof found === 'object' ? found[new Intl.PluralRules(language).select(n)] ?? found.other : undefined
  return fill(form ?? (n === 1 ? one : other), { n: count(n, language), ...vars })
}

/** Text to translate later, where it's shown: `text` is a t() key (test-i18n.js finds msg() and msgn() calls too). */
export const msg = (text: string, vars?: Msg['vars']): Msg => (vars ? { text, vars } : { text })
export const msgn = (n: number, one: string, other: string, vars?: Msg['vars']): Msg => ({ text: other, one, count: n, ...(vars && { vars }) })
export const say = (m: Text): string => typeof m === 'string' ? m : m.count === undefined ? t(m.text, m.vars) : tn(m.count, m.one!, m.text, m.vars)
/** The same text in English, whatever the wallet's language: for Jev, sites and code. */
export const english = (m: Text): string => typeof m === 'string' ? m
  : fill(m.count === undefined ? m.text : m.count === 1 ? m.one! : m.text, { ...(m.count !== undefined && { n: count(m.count, 'en') }), ...m.vars }, english)

/** An error whose message stays English, for sites and code, while the wallet shows it in its language (shown()). */
export class Problem extends Error {
  msg: Msg
  constructor(m: Msg) { super(english(m)); this.msg = m }
}
export const problem = (text: string, vars?: Msg['vars']) => new Problem(msg(text, vars))
/** What the wallet shows for a caught error. */
export const shown = (e: unknown): string => e instanceof Problem ? say(e.msg) : e instanceof Error ? e.message : String(e)
