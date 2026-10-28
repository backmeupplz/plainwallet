#!/usr/bin/env python3
# python3 scripts/shots/android.py <emulator serial> <raw dir> <phone|tab7|tab10> [UI language ...]
# The debug Play build (its WebViews open to DevTools) on an emulator with WebView 140 or later, per language from fresh
# app data, through the same five screens as ios/Shots: 1 the wallet with favorite sites, 2 a site's permit approval,
# 3 a site in the browser, 4 sending, 5 the password that keeps the keys on the device. PNGs go to
# <raw>/<target>/<language>/<n>.png for compose.py. The wallet page and sites are driven over CDP, the app's own
# address bar with adb. All three run on one 10" emulator (1600x2560, 320 dpi), the phone at 1080x2160, 420 dpi, and the
# 7" tablet at 1200x1920, 320 dpi (600 dp wide): a second emulator restarts the shared netsim, which aborts the first.
# SHOTS_ONLY=3 takes just shot 3, starring only its site; give it its own raw dir, since a language that fails drops its 3.png.
import asyncio, json, os, re, shutil, struct, subprocess, sys, time, urllib.request, zlib
import websockets

SERIAL, RAW, TARGET = sys.argv[1:4]
LANGUAGES = sys.argv[4:] or ['en', 'en-GB', 'de', 'fr', 'es', 'es-419', 'pt-BR', 'pt-PT', 'it', 'nl', 'ru', 'uk', 'pl', 'tr', 'sv', 'ar',
                             'ja', 'ko', 'zh-Hans', 'zh-Hant', 'hi', 'id', 'vi', 'th']
SIZE, DENSITY = {'phone': ('1080x2160', '420'), 'tab7': ('1200x1920', '320')}.get(TARGET, (None, None))
OUT = None
PKG = 'com.borodutch.plainwallet'
ADB = ['/opt/homebrew/share/android-commandlinetools/platform-tools/adb', '-s', SERIAL]
PORT = 9530 + int(SERIAL.rsplit('-', 1)[-1]) % 100  # one per emulator
SITES = ['app.uniswap.org', 'app.aave.com', 'veydrift.com']  # starred in this order; the last is shot 3
DAPP = 'metamask.github.io/test-dapp/'
# veydrift.com's strip about its token sale, which ends November 5, 2026: dated, and in English on every locale (as ios/Shots)
SITE_CSS = '.auction-banner { display: none !important } :root { --auction-banner-h: 0px !important }'
ONLY3 = os.environ.get('SHOTS_ONLY') == '3'
RECIPIENT = '0x8ba1f109551bD432803012645Ac136ddd64DBA72'
PASSWORD = 'correct horse battery staple'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def adb(*args):
    return subprocess.run(ADB + list(args), capture_output=True, text=True, check=True).stdout


def status_bar(png, y=12):
    """The mean RGB of row y of a screencap (8-bit RGBA PNG), decoding only the rows up to it"""
    pos, idat = 8, b''
    while pos < len(png):
        n, kind = struct.unpack('>I4s', png[pos:pos + 8])
        if kind == b'IHDR':
            w = struct.unpack('>I', png[pos + 8:pos + 12])[0]
        elif kind == b'IDAT':
            idat += png[pos + 8:pos + 8 + n]
        pos += 12 + n
    stride = w * 4
    rows = zlib.decompressobj().decompress(idat, (stride + 1) * (y + 1))
    prev = bytearray(stride)
    for r in range(y + 1):
        f, line = rows[r * (stride + 1)], bytearray(rows[r * (stride + 1) + 1:(r + 1) * (stride + 1)])
        for i in range(stride):
            a, b, c = (line[i - 4] if i >= 4 else 0), prev[i], (prev[i - 4] if i >= 4 else 0)
            p = a + b - c
            line[i] = (line[i] + [0, a, b, (a + b) // 2,
                                  a if abs(p - a) <= abs(p - b) and abs(p - a) <= abs(p - c) else b if abs(p - b) <= abs(p - c) else c][f]) & 255
        prev = line
    return tuple(sum(prev[k::4]) // w for k in range(3))


def shot(name, wallet=False):
    """A screencap to <name>.png; a wallet shot is retaken until the screen shows the wallet's blue status bar, since
    DevTools can call the wallet visible before a loaded emulator has redrawn the site above it"""
    for _ in range(10):
        time.sleep(2)
        png = subprocess.run(ADB + ['exec-out', 'screencap', '-p'], capture_output=True, check=True).stdout
        r, g, b = status_bar(png)
        if not wallet or (b > 150 and r < 120 and b - r > 80):
            break
    else:
        raise AssertionError(f'shot {name}: the screen still has a {(r, g, b)} status bar, not the wallet')
    open(f'{OUT}/{name}.png', 'wb').write(png)
    print('shot', name, flush=True)
    return png


def nodes():
    try:
        adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml')
    except subprocess.CalledProcessError:  # a loaded emulator kills the dump now and then (137): find_bar dumps again
        return []
    out = []
    for m in re.finditer(r'<node [^>]*?class="([^"]+)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', adb('shell', 'cat', '/sdcard/ui.xml')):
        out.append((m[1], *map(int, m.groups()[1:])))
    return out


def tap(node):
    adb('shell', 'input', 'tap', str((node[1] + node[3]) // 2), str((node[2] + node[4]) // 2))


BAR = {}


def find_bar(rtl):
    """The address bar's field and wallet button, measured on the wallet page: a busy site never lets uiautomator
    settle. On a site the star takes the field's last 44 dp. Right to left, the bar is mirrored."""
    for _ in range(5):  # a dump taken while the page settles can miss the bar
        all_nodes = nodes()
        webs = [n[2] for n in all_nodes if n[0] == 'android.webkit.WebView']
        buttons = [n for n in all_nodes if webs and n[0] == 'android.widget.ImageButton' and n[4] <= min(webs) + 4]
        if buttons and any(n[0] == 'android.widget.EditText' for n in all_nodes):
            break
        time.sleep(2)
    BAR['field'] = next(n for n in all_nodes if n[0] == 'android.widget.EditText')
    BAR['web'] = min(webs)
    BAR['wallet'] = min(buttons, key=lambda n: n[1]) if rtl else max(buttons, key=lambda n: n[1])
    density = re.findall(r'(\d+)', adb('shell', 'wm', 'density'))[-1]
    dp = BAR['dp'] = int(density) / 160
    f = BAR['field']
    x = round(f[1] + 22 * dp) if rtl else round(f[3] - 22 * dp)
    BAR['star'] = ('star', x - 11, f[2], x + 11, f[4])


def wallet_shown():
    """Whether the wallet page is on screen: DevTools marks the visible WebView's page"""
    pages = [t for t in json.load(opener.open(f'http://127.0.0.1:{PORT}/json')) if t['type'] == 'page' and WALLET in t['url']]
    return any('"visible":true' in t.get('description', '') for t in pages)


def toggle_wallet(on):
    """Taps the bar's wallet button until the wallet is shown (on) or hidden: a tap while a site settles can go unheard"""
    for _ in range(4):
        tap(BAR['wallet'])
        for _ in range(8):
            time.sleep(1)
            if wallet_shown() == on:
                time.sleep(2)  # the bar's colors and the status bar icons follow
                return
    raise AssertionError(f'the wallet is still {"hidden" if on else "shown"}')


async def visit(site):
    """Opens a site the way a favorite tile does (typing into the address bar over adb races its focus), and waits
    until it has loaded"""
    await js(WALLET, f"plainwalletNative.postMessage(JSON.stringify({{ type: 'open', url: 'https://{site}' }}))")
    host = site.split('/')[0]
    for _ in range(60):
        await asyncio.sleep(1)
        try:
            if await js(host, "document.readyState") == 'complete':
                break
        except Exception:
            pass
    await asyncio.sleep(6)


def forward():
    for _ in range(30):  # a loaded host can take a minute to start the app
        pid = subprocess.run(ADB + ['shell', 'pidof', PKG], capture_output=True, text=True).stdout.split()
        if pid:
            break
        time.sleep(2)
    else:
        raise AssertionError('the app did not start')
    adb('forward', f'tcp:{PORT}', f'localabstract:webview_devtools_remote_{pid[0]}')


async def js(where, expr):
    """Evaluates expr in the visible page whose URL has `where` in it"""
    pages = []
    for _ in range(30):
        try:
            pages = [t for t in json.load(opener.open(f'http://127.0.0.1:{PORT}/json')) if t['type'] == 'page' and where in t['url']]
        except OSError:  # the WebView's DevTools socket isn't up yet
            pages = []
        if pages:
            break
        await asyncio.sleep(1)
    assert pages, f'no {where} page'
    page = next((t for t in pages if '"visible":true' in t.get('description', '')), pages[-1])
    async with websockets.connect(page['webSocketDebuggerUrl'], proxy=None, max_size=None, open_timeout=60) as ws:
        await ws.send(json.dumps({'id': 1, 'method': 'Runtime.evaluate', 'params': {'expression': expr, 'returnByValue': True, 'awaitPromise': True}}))
        while True:
            m = json.loads(await ws.recv())
            if m.get('id') == 1:
                return m.get('result', {}).get('result', {}).get('value')


WALLET = 'android.html'
VISIBLE = "[...document.querySelectorAll('button')].filter((b) => b.offsetParent)"
FILL = "(i, v) => { i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })) }"


async def wallet(expr, wait=2):
    r = await js(WALLET, expr)
    await asyncio.sleep(wait)
    return r


DEMO = [  # a clean status bar: 9:41, full battery and signal, no notifications
    ['clock', '-e', 'hhmm', '0941'], ['battery', '-e', 'level', '100', '-e', 'plugged', 'false'],
    ['network', '-e', 'wifi', 'show', '-e', 'level', '4', '-e', 'fully', 'true'], ['network', '-e', 'mobile', 'hide'],
    ['notifications', '-e', 'visible', 'false'],
]


async def run(lang):
    adb('shell', 'pm', 'clear', PKG)
    # an app locale of plain zh-Hant reaches the WebView as "zh" (Simplified); Taiwan's zh-TW is what such devices send
    adb('shell', 'cmd', 'locale', 'set-app-locales', PKG, '--locales', {'zh-Hant': 'zh-TW'}.get(lang, lang))
    adb('shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1')
    time.sleep(10)
    forward()
    shown = await js(WALLET, 'document.documentElement.lang')
    assert shown == lang, f'the wallet shows {shown}, not {lang}'
    await wallet(f"{VISIBLE}.find((b) => !b.classList.contains('quiet')).click()")  # a new wallet
    await wallet(f"document.querySelectorAll('input[type=password]').forEach((i) => ({FILL})(i, {json.dumps(PASSWORD)}))", 1)
    if not ONLY3:
        shot('5', wallet=True)
    await wallet("document.querySelector('button.primary').click()", 3)  # the seed phrase
    await wallet("document.querySelector('button.primary').click()", 4)  # saved it: create the wallet
    find_bar(lang == 'ar')
    count = "JSON.parse(localStorage.getItem('favorites') || '[]').length"
    for i, site in enumerate(SITES[-1:] if ONLY3 else SITES):
        await visit(site)
        for _ in range(3):  # a star tapped while the site still settles can go unheard
            tap(BAR['star'])
            time.sleep(3)
            if await js(WALLET, count) == i + 1:
                break
        else:  # still not starred (the tap can miss the star right to left): send the star button's own message
            await js(WALLET, "plainwalletNative.onmessage({ data: JSON.stringify({ type: 'star' }) })")
            await asyncio.sleep(2)
        assert await js(WALLET, count) == i + 1, f'{site} not starred'
    # a star tap that hit the field leaves it focused, showing the whole URL (and maybe the keyboard): close the keyboard,
    # then show the wallet and the site again, which clears the field's focus
    if 'mInputShown=true' in adb('shell', 'dumpsys', 'input_method'):
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
        time.sleep(2)
    toggle_wallet(True)
    toggle_wallet(False)
    hide = f"document.head.append(Object.assign(document.createElement('style'), {{ textContent: {json.dumps(SITE_CSS)} }}))"
    for _ in range(5):  # the style can miss the page on screen, so the shot is retaken until the site's first row isn't
        await js(SITES[-1], hide)  # the strip's cyan: 8 dp down, below the 4 dp progress bar, inside the strip's 43 dp or more
        time.sleep(2)
        r, g, b = status_bar(shot('3'), BAR['web'] + round(8 * BAR['dp']))
        if g < 150:
            break
    else:
        raise AssertionError(f'shot 3 still shows the auction banner: {(r, g, b)} under the bar')
    if ONLY3:
        return
    toggle_wallet(True)
    shot('1', wallet=True)
    await wallet(f"{VISIBLE}.at(-1).click()")  # Send
    await wallet(f"(() => {{ const f = [...document.querySelectorAll('dialog input, .sheet input')].filter((i) => i.offsetParent && i.type !== 'hidden'); ({FILL})(f.at(-2), '{RECIPIENT}'); ({FILL})(f.at(-1), '0.25') }})()", 1)
    shot('4', wallet=True)
    await wallet(f"{VISIBLE}.at(-1).click()")  # close
    toggle_wallet(False)  # back to the browser
    await visit(DAPP)
    await js('test-dapp', "document.querySelector('#connectButton').click()")
    await asyncio.sleep(4)
    shot('2-connect', wallet=True)
    await wallet("document.querySelector('button.primary').click()", 2)  # connect
    for _ in range(20):  # until the site has the account
        if await js('test-dapp', "document.querySelector('#accounts').textContent.trim()"):
            break
        await asyncio.sleep(1)
    await js('test-dapp', "document.querySelector('#signPermit').click()")
    for _ in range(30):  # until the wallet shows the permit
        await asyncio.sleep(1)
        if await js(WALLET, "document.body.innerText.includes('message.spender')"):
            break
    await asyncio.sleep(3)
    shot('2', wallet=True)


async def main():
    global OUT
    adb('shell', 'svc', 'power', 'stayon', 'true')  # an idle emulator dims its screen
    adb('shell', 'settings', 'put', 'global', 'hide_error_dialogs', '1')  # a loaded host's "System UI isn't responding"
    adb('shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1')
    for d in [['exit'], ['enter'], *DEMO]:  # from scratch: repeated network commands add icons
        adb('shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', *d)
    adb('shell', 'wm', 'size', SIZE or 'reset')  # an interrupted run may have left another size
    adb('shell', 'wm', 'density', DENSITY or 'reset')
    failed = []
    for lang in LANGUAGES:
        OUT = os.path.join(RAW, TARGET, lang)
        os.makedirs(OUT, exist_ok=True)
        for attempt in range(2):
            try:
                print(lang, 'attempt', attempt + 1, flush=True)
                await run(lang)
                break
            except Exception as error:
                print(lang, 'failed:', repr(error)[:300], flush=True)
        else:  # no half-taken set for compose.py, or a stray frame that a re-run would count as taken
            if ONLY3:  # into a full set's folder, only the frame this run retook
                if os.path.exists(f'{OUT}/3.png'):
                    os.remove(f'{OUT}/3.png')
            else:
                shutil.rmtree(OUT)
            failed.append(lang)
    print('failed:', failed or 'none', flush=True)


try:
    asyncio.run(main())
finally:
    if SIZE:
        adb('shell', 'wm', 'size', 'reset')
        adb('shell', 'wm', 'density', 'reset')
