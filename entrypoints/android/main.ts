// The apps' wallet page (android/, ios/, macos/): the extension's background and popup in one page, on the API that
// entrypoints/android-shim.ts provides. The app shows it for the home screen and for approvals.
import background from '../background'
import { extras, h, rearm, render } from '../popup/main'
import { isUnlocked, unlock, unlockWithKey } from '@/lib/store'

// Messages to and from the app, beyond what the shim handles itself.
const app = (globalThis as any).plainwalletApp as { send(msg: object): void; listen(fn: (msg: any) => void): void }

// The Mac app has no browser of its own (dapps use the Safari extension), so no favorites; and it keeps the auto-lock
// switch: the phones lock whenever you leave the app, the Mac only when it sleeps or its screen locks.
const mac = (globalThis as any).plainwalletNative.platform === 'macos'
// The App Store doesn't take apps that sell lottery tickets.
if ((globalThis as any).plainwalletNative.platform === 'ios') extras.megapot = false

background.main()
extras.autolockSetting = mac
extras.files = false // copy and paste only: a web view has nowhere to save or pick a file
extras.autolockOff = 'When off, the wallet stays unlocked until you lock it, quit the app, or your Mac sleeps or locks its screen.'
// The app just brought this page up: an approval, or you opened the wallet.
addEventListener('plainwallet-render', () => {
  asked = false
  void render()
})

// Sites starred in the app's browser, on top of the home screen, with the icons the app got from them. Labeled with
// the host, which a site can't choose the way it chooses its title.
if (!mac) extras.home = () => {
  const nav = h('nav', { className: 'favorites', ariaLabel: 'Favorite sites' })
  void browser.storage.local.get('favorites').then(({ favorites = [] }: { favorites?: { url: string; title: string; icon?: string }[] }) =>
    nav.replaceChildren(...(favorites.length ? favorites.map(({ url, title, icon }) => {
      const host = new URL(url).hostname.replace(/^www\./, '')
      return h('button', { title: `${title} · ${url}`, onclick: () => browser.tabs.create({ url }) },
        icon ? h('img', { src: icon, alt: '' }) : h('span', {}, host[0]!.toUpperCase()), h('span', {}, host))
    }) : [h('p', {}, 'Tap ☆ in the address bar to pin a site here.')])))
  return [nav]
}

// Fingerprint unlock (Face ID or Touch ID on iOS). The app keeps the vault key where only your fingerprint or face
// releases it (MainActivity.java: an Android Keystore key; ios/: the Keychain); what comes back still has to open the
// vault. Turning it on takes the password, the password keeps working, and export still asks for it.
let fingerprint = { available: false, enabled: false, name: 'fingerprint' }
let note = '' // why the last attempt didn't work
let asked = false // the prompt comes up by itself once each time the locked wallet is shown
let section: HTMLElement | undefined // Settings' fingerprint section, redrawn when the app reports a change

app.listen(async (msg) => {
  // The wallet just came on screen: its Approve and Send wait a moment, whenever they were drawn.
  if (msg.type === 'visible') return rearm()
  // On start, on coming back to the app, and after any change: ask again, unless asking just failed (a lockout
  // would only fail again).
  if (msg.type === 'fingerprint') {
    fingerprint = { available: msg.available, enabled: msg.enabled, name: msg.name ?? 'fingerprint' }
    note = msg.error ?? ''
    if (!note) asked = false
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
  return [h('button', { onclick: () => app.send({ type: 'fingerprint-unlock' }) }, `Unlock with ${fingerprint.name}`),
    ...(note ? [h('p', { className: 'bad' }, note)] : [])]
}

function settings(open = false) {
  const { name } = fingerprint
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
    h('summary', {}, `${name[0]!.toUpperCase()}${name.slice(1)} unlock: `, h('span', {}, fingerprint.enabled ? 'on' : 'off')),
    h('div', { className: 'dialog-content' },
      h('p', {}, name === 'fingerprint'
        ? 'Unlock with your fingerprint instead of typing the password, which keeps working. Android keeps the wallet key behind your fingerprint; adding or removing a fingerprint on the phone turns this off.'
        : `Unlock with ${name} instead of typing the password, which keeps working. The iPhone keeps the wallet key behind ${name}; changing ${name} on the phone turns this off.`),
      ...(fingerprint.enabled ? [h('button', { onclick: () => app.send({ type: 'fingerprint-disable' }) }, 'Turn off')]
        : [h('label', {}, 'Your password', pw), h('button', { className: 'primary', onclick: turnOn }, 'Turn on')]),
      failure))
}
extras.settings = () => (fingerprint.available ? [(section = settings())] : [])
