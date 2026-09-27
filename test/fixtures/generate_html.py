"""HTML 픽스처 생성 (Shift_JIS 인코딩 페이지를 만들기 위해 Python 사용)
사용법: python3 generate_html.py  (test/fixtures 에서 실행)
"""
import base64
import hashlib
from pathlib import Path

here = Path(__file__).parent
sri_css = (here / 'origin-b/cors/sri.css').read_bytes()
sri = 'sha384-' + base64.b64encode(hashlib.sha384(sri_css).digest()).decode()

# ── 메인 페이지: Shift_JIS, 교차 출처 CSS, SRI, Shadow DOM, canvas, 폼, 위험 URL 등 ──
index = f'''<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="Shift_JIS">
<meta http-equiv="refresh" content="3600">
<meta name="csrf-token" content="SECRET-CSRF-123">
<title>キャプチャ検証ページ</title>
<link rel="preload" href="assets/fonts/brand.ttf" as="font" crossorigin>
<link rel="stylesheet" href="assets/css/main.css">
<link rel="stylesheet" href="http://127.0.0.1:4102/cors/cdn.css">
<link rel="stylesheet" href="http://127.0.0.1:4102/nocors/legacy.css">
<link rel="stylesheet" href="http://127.0.0.1:4102/cors/sri.css" integrity="{sri}" crossorigin="anonymous">
<style id="sc"></style>
<script src="assets/app.js" defer></script>
</head>
<body onload="window.__loaded=1">
<div class="wrap">
  <h1 class="title" id="title">日本語タイトル Brand</h1>
  <div class="hero" id="hero"></div>
  <div class="box extra-box" id="extra">@import</div>
  <div class="box cdn-box" id="cdn">CDN(fetch)</div>
  <div class="box cdn-sub-box" id="cdnsub">CDN @import</div>
  <div class="box legacy-box" id="legacy">CORS不可 CDN</div>
  <div class="box sri-box" id="sri">SRI</div>
  <div class="box sc-box" id="sc-box">insertRule</div>
  <div class="box adopted-box" id="adopted">adoptedStyleSheets</div>
  <fancy-card id="card"><span>スロット</span></fancy-card>
  <closed-card id="closed"></closed-card>
  <canvas id="cv" width="120" height="60"></canvas>
  <canvas id="cv-tainted" width="60" height="60"></canvas>
  <iframe class="embed-frame" id="frame" src="http://127.0.0.1:4102/frame.html" allow="camera"></iframe>
  <object id="obj" data="assets/img/bg.png" type="image/png" width="60" height="40"></object>
  <form id="form" action="http://127.0.0.1:4101/submit" method="post">
    <input id="t" type="text" name="q">
    <input id="pw" type="password" name="pw" value="preset-pw">
    <input id="hid" type="hidden" name="authenticity_token" value="SECRET-HIDDEN-456">
    <input id="hid2" type="hidden" name="page" value="3">
    <input id="cb" type="checkbox" name="cb">
    <select id="sel"><option value="a">A</option><option value="b">B</option></select>
    <textarea id="ta"></textarea>
    <input id="submit" type="submit">
    <button id="btn" type="button" onclick="alert(1)">ボタン</button>
  </form>
  <a id="js1" href="javascript:alert(1)">js link</a>
  <a id="js2" href=" &#10;JaVaScRiPt:alert(2)">js link 2</a>
  <a id="ok" href="sub/quirks.html">normal link</a>
  <img id="img-onerror" src="nope.png" onerror="window.__x=1" alt="">
  <svg id="svg" width="40" height="20"><script>alert(3)</script><a href="javascript:alert(4)"><text x="0" y="15">svg</text></a><set attributeName="href" to="javascript:alert(5)"/></svg>
  <template id="tpl"><img src="x" onerror="alert(6)"><script>alert(7)</script><iframe src="https://example.com"></iframe></template>
</div>
</body>
</html>
'''
(here / 'origin-a/index.html').write_bytes(index.encode('shift_jis'))

# ── quirks 모드(doctype 없음) + 원본 <base> ──
quirks = '''<html>
<head><base href="/assets/"><title>quirks</title>
<style>table { font-size: 30px; } .q { width: 100px; padding: 10px; border: 5px solid #000; }</style></head>
<body><img id="img" src="img/bg.png" alt=""><table><tr><td id="td">quirks table font-size</td></tr></table><div class="q" id="q">box</div></body></html>
'''
(here / 'origin-a/sub').mkdir(exist_ok=True)
(here / 'origin-a/sub/quirks.html').write_text(quirks, encoding='utf-8')

# ── 문서 단위 클릭 위임이 모든 <a> 클릭을 막는 SPA 흉내 ──
spa = '''<!DOCTYPE html><html><head><meta charset="utf-8"><title>spa</title></head><body>
<script>document.addEventListener('click', e => { if (e.target.closest && e.target.closest('a')) { e.preventDefault(); window.__intercepted = (window.__intercepted||0)+1; } }, true);</script>
<p id="p">SPA router page</p></body></html>
'''
(here / 'origin-a/spa.html').write_text(spa, encoding='utf-8')

# ── CSP meta(nonce) 페이지 ──
csp = '''<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="style-src 'self' 'nonce-abc123'">
<title>csp</title>
<link rel="stylesheet" href="assets/css/main.css">
<style nonce="abc123">.csp-box { background: rgb(0, 200, 100); }</style>
</head><body><div class="box csp-box" id="csp">csp</div><h1 class="title" id="title">CSP</h1></body></html>
'''
(here / 'origin-a/csp.html').write_text(csp, encoding='utf-8')
print('fixtures generated')
