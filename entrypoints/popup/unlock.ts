// Shared by redraws in this view; never stores a password or changes the vault's lock lifecycle.
let pending = false
let current: { form: HTMLFormElement; update: () => void; focus: () => void } | undefined
let generation = 0
let closed = false
let failure = ''
// Harmless locked-view redraws share feedback; navigation/authentication starts a new lifecycle.
export function invalidateUnlockView() {
  generation++
  failure = ''
  current = undefined
}
addEventListener('pagehide', () => { closed = true; generation++; failure = '' })
addEventListener('pageshow', () => {
  closed = false
  if (current?.form.isConnected) current.update()
})

/** A real frame boundary, not a microtask: the first frame can paint before scrypt starts in the next. */
const afterPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

export function unlockForm(unlock: (password: string) => Promise<unknown>, done: () => Promise<void>) {
  const form = document.createElement('form')
  form.className = 'dialog-content'
  const label = document.createElement('label')
  label.textContent = 'Password'
  const input = document.createElement('input')
  input.type = 'password'
  input.autofocus = true
  input.autocomplete = 'current-password'
  label.append(input)
  const button = document.createElement('button')
  button.type = 'submit'
  button.className = 'primary'
  const status = document.createElement('p')
  status.role = 'status'
  status.ariaLive = 'polite'
  const update = () => {
    form.ariaBusy = String(pending)
    input.disabled = button.disabled = pending
    button.textContent = pending ? 'Unlocking...' : 'Unlock'
    status.textContent = pending ? 'Unlocking your wallet…' : failure
  }
  current = { form, update, focus: () => input.focus() }
  update()
  const active = () => current?.form === form && form.isConnected && !closed
  form.onsubmit = async (event) => {
    event.preventDefault()
    if (pending || !active()) return
    const started = generation
    const stillActive = () => active() && started === generation
    const sameView = () => started === generation && !closed && current?.form.isConnected
    pending = true
    failure = ''
    update()
    let password = input.value
    try {
      await afterPaint()
      if (!stillActive()) return
      await unlock(password)
      password = ''
      if (stillActive()) await done()
    } catch (e) {
      if (sameView()) {
        failure = e instanceof Error && e.message === 'Wrong password'
          ? 'Wrong password. Please try again.' : 'Could not unlock your wallet. Please try again.'
      }
    } finally {
      password = ''
      input.value = ''
      pending = false
      if (!closed && current?.form.isConnected) {
        current.update()
        if (sameView()) current.focus()
      }
    }
  }
  // Keep the live region outside aria-busy: assistive technology need not defer the progress announcement.
  form.append(label, button)
  const section = document.createElement('div')
  section.className = 'dialog-content'
  section.append(form, status)
  return { section, form }
}
