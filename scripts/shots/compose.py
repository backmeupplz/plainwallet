#!/usr/bin/env python3
# python3 scripts/shots/compose.py <raw dir> [locale ...]   (from the repo root, after ios.sh and android.py)
# Puts each raw device screenshot under its locale's caption (`## Screenshot captions` in appstore/<locale>/listing.md,
# en-US in appstore/listing.md) at every store size, plus the 1024x500 feature graphic with its `## Feature graphic
# tagline`, in one headless Chrome, and checks every frame's layout in the page: the caption takes at most two lines,
# and every box hugs its content and stays 24 px or more from the edges and from the next box. Arabic is laid out right
# to left. Raw shots: <raw>/<target>/<UI language>/<n>.png, a target being ios (6.9" iPhone), duo-outer, duo-inner,
# phone, tab7 or tab10. Writes JPEGs to
#   appstore/screenshots/<locale>/<n>.jpg                      iPhone 6.9" (1320x2868)
#   appstore/screenshots/<locale>/duo-outer|duo-inner/<n>.jpg   iPhone Duo (1398x2034 and 2007x2853)
#   fastlane/metadata/android/<Play code>/images/{phone,sevenInch,tenInch}Screenshots/<n>.jpg and featureGraphic.jpg
# and prints a JSON report; exits 1 if any check fails or a raw shot is missing.
import asyncio, base64, html, json, os, re, subprocess, sys, tempfile, time, urllib.request
import websockets

raw = os.path.abspath(sys.argv[1])
repo = os.getcwd()
QUALITY = 85
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
ICON = os.path.join(repo, 'fastlane/metadata/android/en-US/images/icon.png')
# App Store locale -> (the app's UI language, Google Play code)
LOCALES = {
    'en-US': ('en', 'en-US'), 'en-GB': ('en-GB', 'en-GB'), 'de-DE': ('de', 'de-DE'), 'fr-FR': ('fr', 'fr-FR'), 'es-ES': ('es', 'es-ES'),
    'es-MX': ('es-419', 'es-419'), 'pt-BR': ('pt-BR', 'pt-BR'), 'pt-PT': ('pt-PT', 'pt-PT'), 'it': ('it', 'it-IT'), 'nl-NL': ('nl', 'nl-NL'),
    'ru': ('ru', 'ru-RU'), 'uk': ('uk', 'uk'), 'pl': ('pl', 'pl-PL'), 'tr': ('tr', 'tr-TR'), 'sv': ('sv', 'sv-SE'), 'ar-SA': ('ar', 'ar'),
    'ja': ('ja', 'ja-JP'), 'ko': ('ko', 'ko-KR'), 'zh-Hans': ('zh-Hans', 'zh-CN'), 'zh-Hant': ('zh-Hant', 'zh-TW'), 'hi': ('hi', 'hi-IN'),
    'id': ('id', 'id'), 'vi': ('vi', 'vi'), 'th': ('th', 'th'),
}
TARGETS = {  # final size
    'ios': (1320, 2868), 'duo-outer': (1398, 2034), 'duo-inner': (2007, 2853),
    'phone': (1080, 2160), 'tab7': (1200, 1920), 'tab10': (1600, 2560),
}
PLAY = {'phone': 'phoneScreenshots', 'tab7': 'sevenInchScreenshots', 'tab10': 'tenInchScreenshots'}
only = sys.argv[2:] or list(LOCALES)
FONTS = "-apple-system, 'Helvetica Neue', 'Hiragino Sans', 'PingFang SC', 'Apple SD Gothic Neo', 'Geeza Pro', 'Kohinoor Devanagari', 'Thonburi', sans-serif"
CJK = {'zh-Hans': "'PingFang SC'", 'zh-Hant': "'PingFang TC'", 'ja': "'Hiragino Sans'", 'ko': "'Apple SD Gothic Neo'"}
# line breaks between words: Korean has spaces but the browser breaks inside its words; Japanese has neither; Chinese
# captions break at their spaces (around EVM), not inside a word such as 网络. PingFang's glyphs stand taller than
# 1.18 lines (1.35 em), which overflows the caption's box.
BREAKS = {'ko': 'word-break: keep-all;', 'ja': 'word-break: auto-phrase;', 'zh-Hans': 'word-break: keep-all;', 'zh-Hant': 'word-break: keep-all;'}
LINE = {'zh-Hans': 1.4, 'zh-Hant': 1.4}
BG = 'linear-gradient(160deg, #3d5bdc 0%, #2443c4 45%, #15297f 100%)'  # the app's wallet blue
# the width of an element's longest line: a range gives a rect per direction run, so an Arabic line with EVM in it is
# two rects, joined here by the line they sit on
LONGEST = '''const longest = (el) => {
    const r = document.createRange(), rows = []; r.selectNodeContents(el)
    for (const x of r.getClientRects()) {
      if (!x.width) continue
      const mid = (x.top + x.bottom) / 2, row = rows.find((w) => mid > w.t && mid < w.b)
      if (row) { row.l = Math.min(row.l, x.left); row.r = Math.max(row.r, x.right) } else rows.push({ t: x.top, b: x.bottom, l: x.left, r: x.right })
    }
    return Math.max(...rows.map((w) => w.r - w.l)) }
'''
CHECK = '''(() => {
  ''' + LONGEST + '''  const W = innerWidth, H = innerHeight, out = []
  const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } }
  const cap = document.querySelector('.cap')
  const lines = cap ? Math.round(cap.getBoundingClientRect().height / parseFloat(getComputedStyle(cap).lineHeight)) : 0
  const boxes = [...document.querySelectorAll('[data-box]')].map((el) => ({ n: el.dataset.box, ...box(el) }))
  for (const b of boxes) {
    if (b.l < 24 || b.t < 24 || W - b.r < 24 || H - b.b < 24) out.push(`${b.n} within 24 px of the edge`)
    if (b.r - b.l < 1 || b.b - b.t < 1) out.push(`${b.n} is empty`)
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]
    const gap = Math.max(b.l - a.r, a.l - b.r, b.t - a.b, a.t - b.b)
    if (gap < 24) out.push(`${a.n} and ${b.n} are ${Math.round(gap)} px apart`)
  }
  for (const el of document.querySelectorAll('[data-box]')) if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) out.push(`${el.dataset.box} overflows: ${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight}`)
  // the text boxes hug their text: an inline-block as wide as its longest line
  for (const el of document.querySelectorAll('.cap, [data-box="name"]')) {
    const w = longest(el)
    if (el.getBoundingClientRect().width - w > 2) out.push(`${el.dataset.box} is ${Math.round(el.getBoundingClientRect().width - w)} px wider than its text`)
  }
  for (const img of document.images) if (Math.abs(img.getBoundingClientRect().width / img.getBoundingClientRect().height - img.naturalWidth / img.naturalHeight) > 0.01) out.push('a screenshot is stretched')
  return { problems: out, lines, font: cap ? parseFloat(getComputedStyle(cap).fontSize) : 0 }
})()'''
# shrink the caption until it takes at most two lines and fits its area, then narrow it to its longest line (CHECK
# catches a caption that re-wraps when narrowed)
FIT = '''(() => { ''' + LONGEST + '''  const c = document.querySelector('.cap'), area = document.querySelector('.area'); let f = parseFloat(getComputedStyle(c).fontSize)
  const lines = () => Math.round(c.getBoundingClientRect().height / parseFloat(getComputedStyle(c).lineHeight))
  while (f > 20 && (lines() > 2 || c.getBoundingClientRect().width > area.clientWidth || c.getBoundingClientRect().height > area.clientHeight)) { f -= 2; c.style.fontSize = f + 'px' }
  c.style.width = Math.ceil(longest(c)) + 1 + 'px'
  return f })()'''


def sections(path):
    out, name = {}, None
    for line in open(path, encoding='utf8').read().split('\n'):
        m = re.match(r'^## (.+?)(?: \(max \d+\))?$', line)
        if m:
            name = m[1]
            out[name] = []
        elif name:
            out[name].append(line)
    return {k: '\n'.join(v).strip() for k, v in out.items()}


def texts(locale):
    s = sections(os.path.join(repo, 'appstore', 'listing.md' if locale == 'en-US' else f'{locale}/listing.md'))
    captions = [re.sub(r'^\d+\.\s*', '', c).strip() for c in s['Screenshot captions'].split('\n') if c.strip()]
    assert len(captions) == 5, f'{locale}: {len(captions)} captions'
    return captions, s['Feature graphic tagline']


def page(locale, body, W, H):
    lang = LOCALES[locale][0]
    fonts = (CJK[lang] + ', ' if lang in CJK else '') + FONTS
    return f'''<!doctype html><html lang="{lang}" dir="{'rtl' if lang == 'ar' else 'ltr'}"><meta charset="utf-8"><style>
html, body {{ margin: 0; width: {W}px; height: {H}px; overflow: hidden; }}
body {{ background: {BG}; font-family: {fonts}; color: #fff; position: relative; -webkit-font-smoothing: antialiased; {BREAKS.get(lang, '')} }}
</style><body>{body}</body></html>'''


def shot_frame(target, locale, caption, img, size):
    W, H = TARGETS[target]
    m = round(W * 0.06)
    cap = round(H * 0.15)  # the caption's area, from the top edge
    gap = 48
    # the whole screenshot, as large as fits under the caption, centered
    rw, rh = size
    scale = min((W - 2 * m) / rw, (H - cap - gap - m) / rh)
    iw, ih = round(rw * scale), round(rh * scale)
    left, top = (W - iw) // 2, cap + gap + (H - cap - gap - m - ih) // 2
    fs = round(W * (0.072 if W / H < 0.6 else 0.058))
    radius = round(iw * 0.06)
    body = f'''<div class="area" style="position:absolute; left:{m}px; right:{m}px; top:{round(m * 1.1)}px; height:{cap - round(m * 1.1)}px; display:flex; align-items:center; justify-content:center;">
<div class="cap" data-box="caption" style="display:inline-block; font-size:{fs}px; line-height:{LINE.get(LOCALES[locale][0], 1.18)}; font-weight:750; letter-spacing:-0.01em; text-align:center; text-wrap:balance; max-width:100%;">{html.escape(caption)}</div></div>
<img data-box="screenshot" src="file://{img}" style="position:absolute; left:{left}px; top:{top}px; width:{iw}px; height:{ih}px; border-radius:{radius}px; box-shadow:0 {round(m * 0.3)}px {round(m * 0.9)}px rgb(5 10 60 / 0.45); display:block;">'''
    return page(locale, body, W, H)


def feature(locale, tagline):
    body = f'''<div style="position:absolute; inset:0; display:flex; align-items:center; gap:52px; padding:0 72px; box-sizing:border-box;">
<img data-box="icon" src="file://{ICON}" style="width:180px; height:180px; border-radius:40px; box-shadow:0 18px 50px rgb(5 10 60 / 0.45); flex:none;">
<div class="area" style="flex:1; min-width:0; height:300px; display:flex; flex-direction:column; justify-content:center; align-items:flex-start; gap:28px;">
<div data-box="name" dir="ltr" style="display:inline-block; font-size:88px; line-height:1.2; font-weight:800; letter-spacing:-0.03em; font-family:-apple-system, 'Helvetica Neue', sans-serif;">Plain Wallet</div>
<div class="cap" data-box="tagline" style="display:inline-block; font-size:36px; line-height:1.3; font-weight:500; opacity:0.92; text-wrap:balance; max-width:100%;">{html.escape(tagline)}</div></div></div>'''
    return page(locale, body, 1024, 500)


def png_size(path):
    with open(path, 'rb') as f:
        head = f.read(24)
    return int.from_bytes(head[16:20], 'big'), int.from_bytes(head[20:24], 'big')


def jobs():
    for loc in only:
        ui, play = LOCALES[loc]
        captions, tagline = texts(loc)
        for target in TARGETS:
            for n in range(1, 6):
                img = os.path.join(raw, target, ui, f'{n}.png')
                if target == 'ios':
                    out = os.path.join(repo, 'appstore/screenshots', loc, f'{n}.jpg')
                elif target.startswith('duo'):
                    out = os.path.join(repo, 'appstore/screenshots', loc, target, f'{n}.jpg')
                else:
                    out = os.path.join(repo, 'fastlane/metadata/android', play, 'images', PLAY[target], f'{n}.jpg')
                yield out, target, img, (lambda target=target, loc=loc, c=captions[n - 1], img=img: shot_frame(target, loc, c, img, png_size(img)))
        yield os.path.join(repo, 'fastlane/metadata/android', play, 'images/featureGraphic.jpg'), 'feature', None, (lambda loc=loc, t=tagline: feature(loc, t))


port = 9900 + (os.getpid() % 50)
prof = tempfile.mkdtemp(prefix='shots-chrome-')
work = tempfile.mkdtemp(prefix='shots-frames-')
chrome = subprocess.Popen([CHROME, '--headless=new', f'--remote-debugging-port={port}', f'--user-data-dir={prof}', '--use-mock-keychain',
                           '--no-first-run', '--remote-allow-origins=*', '--hide-scrollbars', '--allow-file-access-from-files', 'about:blank'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
report, bad = [], 0


async def main():
    global bad
    tabs = None
    for _ in range(80):
        time.sleep(0.25)
        try:
            tabs = json.load(opener.open(f'http://127.0.0.1:{port}/json'))
            if any(t['type'] == 'page' for t in tabs):
                break
        except Exception:
            pass
    pg = next(t for t in tabs if t['type'] == 'page')
    async with websockets.connect(pg['webSocketDebuggerUrl'], proxy=None, max_size=None) as ws:
        n = 0

        async def send(method, params={}):
            nonlocal n
            n += 1
            await ws.send(json.dumps({'id': n, 'method': method, 'params': params}))
            while True:
                m = json.loads(await ws.recv())
                if m.get('id') == n:
                    return m

        async def js(expr):
            r = await send('Runtime.evaluate', {'expression': expr, 'returnByValue': True, 'awaitPromise': True})
            return r.get('result', {}).get('result', {}).get('value')

        size, cleared = None, set()
        for i, (out, target, img, doc) in enumerate(jobs()):
            if img and not os.path.exists(img):
                if target.startswith('duo'):  # optional: see ios.sh
                    continue
                report.append({'out': os.path.relpath(out, repo), 'problems': [f'missing raw shot {os.path.relpath(img, raw)}']})
                bad += 1
                continue
            W, H = (1024, 500) if target == 'feature' else TARGETS[target]
            if size != (W, H):
                await send('Emulation.setDeviceMetricsOverride', {'width': W, 'height': H, 'deviceScaleFactor': 1, 'mobile': False})
                size = (W, H)
            path = os.path.join(work, f'{i}.html')
            open(path, 'w', encoding='utf8').write(doc())
            await send('Page.navigate', {'url': 'file://' + path})
            for _ in range(50):
                await asyncio.sleep(0.1)
                if await js("document.readyState === 'complete' && [...document.images].every((i) => i.complete && i.naturalWidth)"):
                    break
            await js('document.fonts.ready.then(() => 1)')
            await js(FIT)
            r = await js(CHECK)
            if target != 'feature' and r['lines'] > 2:
                r['problems'].append(f"caption takes {r['lines']} lines")
            r['out'] = os.path.relpath(out, repo)
            report.append({k: r[k] for k in ('out', 'problems', 'lines', 'font')})
            bad += bool(r['problems'])
            s = await send('Page.captureScreenshot', {'format': 'jpeg', 'quality': QUALITY, 'clip': {'x': 0, 'y': 0, 'width': W, 'height': H, 'scale': 1}})
            folder = os.path.dirname(out)
            os.makedirs(folder, exist_ok=True)
            if target != 'feature' and folder not in cleared:  # a set is exactly these frames: releases upload every image in it
                cleared.add(folder)
                for f in os.listdir(folder):
                    if f.lower().endswith(('.png', '.jpg', '.jpeg')):
                        os.remove(os.path.join(folder, f))
            open(out, 'wb').write(base64.b64decode(s['result']['data']))


try:
    asyncio.run(main())
finally:
    chrome.kill()
json.dump(report, open(os.path.join(work, 'report.json'), 'w'), ensure_ascii=False, indent=1)
print(json.dumps({'frames': len(report), 'failed': bad, 'report': os.path.join(work, 'report.json'), 'problems': [r for r in report if r['problems']][:20]}, ensure_ascii=False))
sys.exit(1 if bad else 0)
