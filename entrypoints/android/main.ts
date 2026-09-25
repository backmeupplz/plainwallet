// The Android app's wallet page (android/): the extension's background and popup in one page, on the API that
// entrypoints/android-shim.ts provides. The app shows it for the home screen and for approvals.
import background from '../background'
import { extras, h, render } from '../popup/main'
import { isUnlocked, unlock, unlockWithKey } from '@/lib/store'

// Messages to and from the app, beyond what the shim handles itself.
const app = (globalThis as any).plainwalletApp as { send(msg: object): void; listen(fn: (msg: any) => void): void }

background.main()
// The app just brought this page up: an approval, or you opened the wallet.
addEventListener('plainwallet-render', () => {
  asked = false
  void render()
})

// Sites starred in the app's browser, on top of the home screen, with the icons the app got from them.
extras.home = () => {
  const nav = h('nav', { className: 'favorites', ariaLabel: 'Favorite sites' })
  void browser.storage.local.get('favorites').then(({ favorites = [] }: { favorites?: { url: string; title: string; icon?: string }[] }) =>
    nav.replaceChildren(...(favorites.length ? favorites.map(({ url, title, icon }) => {
      const name = title || new URL(url).hostname
      return h('button', { title: url, onclick: () => browser.tabs.create({ url }) },
        icon ? h('img', { src: icon, alt: '' }) : h('span', {}, name[0]!.toUpperCase()), h('span', {}, name))
    }) : [h('p', {}, 'Tap ☆ in the address bar to pin a site here.')])))
  return [nav]
}

// Fingerprint unlock. The app keeps the vault key encrypted under an Android Keystore key that only your fingerprint
// releases (MainActivity.java); what comes back still has to open the vault. Turning it on takes the password, the
// password keeps working, and export still asks for it.
let fingerprint = { available: false, enabled: false }
let note = '' // why the last attempt didn't work
let asked = false // the prompt comes up by itself once each time the locked wallet is shown
let section: HTMLElement | undefined // Settings' fingerprint section, redrawn when the app reports a change

app.listen(async (msg) => {
  if (msg.type === 'fingerprint') {
    fingerprint = { available: msg.available, enabled: msg.enabled }
    note = msg.error ?? ''
    section?.replaceWith((section = settings(true)))
    if (!(await isUnlocked())) void render()
  } else if (msg.type === 'fingerprint-key') {
    // Unlocking redraws by itself (the session key changes); a key that doesn't fit leaves a note.
    await unlockWithKey(msg.key).then(() => (note = ''), (e: Error) => { note = e.message; void render() })
  }
})

extras.unlock = () => {
  if (!fingerprint.enabled) return []
  if (!asked) {
    asked = true
    app.send({ type: 'fingerprint-unlock' })
  }
  return [h('button', { onclick: () => app.send({ type: 'fingerprint-unlock' }) }, 'Unlock with fingerprint'),
    ...(note ? [h('p', { className: 'bad' }, note)] : [])]
}

function settings(open = false) {
  const pw = h('input', { type: 'password', autocomplete: 'off' })
  const failure = h('p', { className: 'bad' }, note)
  const turnOn = async () => {
    try {
      await unlock(pw.value) // checks the password; the key it derives is the one in use
      app.send({ type: 'fingerprint-enable', key: (await browser.storage.session.get('key')).key })
    } catch (e) {
      failure.textContent = (e as Error).message
    } finally {
      pw.value = ''
    }
  }
  return h('details', { className: 'fold', open },
    h('summary', {}, 'Fingerprint unlock: ', h('span', {}, fingerprint.enabled ? 'on' : 'off')),
    h('div', { className: 'dialog-content' },
      h('p', {}, 'Unlock with your fingerprint instead of typing the password, which keeps working. Android keeps the wallet key behind your fingerprint; adding or removing a fingerprint on the phone turns this off.'),
      ...(fingerprint.enabled ? [h('button', { onclick: () => app.send({ type: 'fingerprint-disable' }) }, 'Turn off')]
        : [h('label', {}, 'Your password', pw), h('button', { className: 'primary', onclick: turnOn }, 'Turn on')]),
      failure))
}
extras.settings = () => (fingerprint.available ? [(section = settings())] : [])
