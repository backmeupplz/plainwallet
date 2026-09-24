// The Android app's wallet page (android/): the extension's background and popup in one page, on the API that
// entrypoints/android-shim.ts provides. The app shows it for the home screen and for approvals.
import background from '../background'
import { extras, h, render } from '../popup/main'

background.main()
addEventListener('plainwallet-render', () => void render())

// Sites starred in the app's browser, on top of the home screen.
extras.home = () => {
  const nav = h('nav', { className: 'favorites', ariaLabel: 'Favorite sites' })
  void browser.storage.local.get('favorites').then(({ favorites = [] }: { favorites?: { url: string; title: string }[] }) =>
    nav.replaceChildren(...(favorites.length ? favorites.map(({ url, title }) => {
      const name = title || new URL(url).hostname
      return h('button', { title: url, onclick: () => browser.tabs.create({ url }) }, h('span', {}, name[0]!.toUpperCase()), h('span', {}, name))
    }) : [h('p', {}, 'Tap ☆ next to the address bar to pin a site here.')])))
  return [nav]
}
