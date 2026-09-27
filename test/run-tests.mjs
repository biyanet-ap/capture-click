// 회귀 테스트: 원본(legacy) 북마클릿과 v2 를 같은 픽스처에서 실행해 항목별로 비교한다.
//   node test/run-tests.mjs            → 결과 표 출력 + test/out/report.md
// 종료 코드: v2 가 하나라도 실패하면 1
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { startServers } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(here, 'out');
const A = 'http://127.0.0.1:4101';
const VIEWPORT = { width: 1000, height: 900 };

const VERSIONS = {
  legacy: await readFile(path.join(root, 'legacy/original-bookmarklet.txt'), 'utf8'),
  v2: await readFile(path.join(root, 'dist/bookmarklet.txt'), 'utf8'),
};
const toCode = (bm) => decodeURIComponent(bm.trim().slice('javascript:'.length));

// ─────────────────────────────────────────────────────────────
async function capture(browser, version, url, { prepare, tag } = {}) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: true });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load' });
  if (prepare) await prepare(page);
  const shot = await page.screenshot({ fullPage: false });
  let download = null;
  try {
    [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      page.evaluate(toCode(VERSIONS[version])),
    ]);
  } catch (e) {
    await ctx.close();
    return { ok: false, error: e.message.split('\n')[0] };
  }
  const file = path.join(outDir, `${tag}-${version}.html`);
  await download.saveAs(file);
  const result = { ok: true, file, suggested: download.suggestedFilename(), shot };
  result.intercepted = await page.evaluate(() => window.__intercepted || 0).catch(() => 0);
  await ctx.close();
  return result;
}

async function openCapture(browser, file, { offline = false } = {}) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, offline });
  const page = await ctx.newPage();
  const failed = [];
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('requestfailed', (r) => failed.push(r.url()));
  page.on('response', (r) => r.status() >= 400 && failed.push(`${r.status()} ${r.url()}`));
  await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return { ctx, page, failed, errors };
}

// 캡처 파일 안에서 실행: 결과 수집
const inspectMain = () => {
  const $ = (s) => document.querySelector(s);
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const bg = (id) => cs(document.getElementById(id))?.backgroundColor;
  // <template> 내부까지 포함한 전체 요소
  const all = [];
  const walk = (r) => r.querySelectorAll('*').forEach((el) => { all.push(el); if (el.localName === 'template') walk(el.content); });
  walk(document);
  const norm = (v) => v.replace(/[\u0000-\u0020]/g, '').toLowerCase();
  const card = $('#card');
  const sr = card && card.shadowRoot;
  const cv = $('#cv');
  const fr = $('#frame');
  return {
    charset: document.characterSet,
    titleText: $('#title')?.textContent,
    brandFont: [...document.fonts].some((f) => f.family.replace(/["']/g, '') === 'Brand' && f.status === 'loaded'),
    heroBg: cs($('#hero'))?.backgroundImage,
    extra: bg('extra'), cdn: bg('cdn'), cdnsub: bg('cdnsub'), legacy: bg('legacy'),
    sri: bg('sri'), sc: bg('sc-box'), adopted: bg('adopted'),
    cardVisible: cs(card)?.visibility,
    shadow: !!sr,
    inner: sr ? cs(sr.querySelector('.inner'))?.color : null,
    inner2: sr ? cs(sr.querySelector('.inner2'))?.color : null,
    canvas: cv ? cv.tagName + ':' + (cv.getAttribute('src') || '').slice(0, 15) : null,
    t: $('#t')?.value, pw: $('#pw')?.value, cb: $('#cb')?.checked, sel: $('#sel')?.value, ta: $('#ta')?.value,
    submitAttr: $('#submit')?.getAttribute('value'),
    hid2: $('#hid2')?.value,
    scripts: all.filter((e) => e.localName === 'script').length,
    handlers: all.filter((e) => [...e.attributes].some((a) => a.name.toLowerCase().startsWith('on'))).length,
    jsUrls: all.filter((e) => [...e.attributes].some((a) => norm(a.value).startsWith('javascript:'))).length,
    frame: fr ? { tag: fr.localName, src: fr.getAttribute('src'), sandbox: fr.hasAttribute('sandbox') } : null,
    refresh: !!$('meta[http-equiv="refresh" i]'),
    dupMainCss: document.querySelectorAll('link[rel=stylesheet][href*="main.css"]').length,
    formAction: $('#form')?.getAttribute('action'),
    toast: !!$('[data-ds-capture-ui]'),
    integrity: all.filter((e) => e.hasAttribute('integrity')).length,
    formaction: $('#fa')?.getAttribute('formaction'),
    tplIframe: (() => {
      const f = $('#tpl')?.content.querySelector('iframe');
      return f ? { src: f.getAttribute('src'), sandbox: f.hasAttribute('sandbox') } : null;
    })(),
    pwShown: $('#pw-shown')?.value, cc: $('#cc')?.value, cvc: $('#cvc')?.value, otp: $('#otp')?.value,
    cardnote: $('#cardnote')?.value,
    propsUser: (() => { try { return JSON.parse($('#props').dataset.props).user; } catch { return null; } })(),
  };
};

// ─────────────────────────────────────────────────────────────
const CHECKS = [
  // [id, 설명, (r, raw, extra) => boolean]
  ['charset', 'Shift_JIS 페이지 문자 깨짐 없음', (r) => r.titleText === '日本語タイトル Brand'],
  ['font', '@font-face 폰트 로드 (CSS 상대경로)', (r) => r.brandFont],
  ['bg-url', '배경 이미지 경로 = CSS 파일 기준', (r) => (r.heroBg || '').includes('/assets/img/bg.png')],
  ['import', '동일 출처 @import', (r) => r.extra === 'rgb(120, 60, 160)'],
  ['cdn', '교차 출처 CDN CSS', (r) => r.cdn === 'rgb(0, 128, 128)'],
  ['cdn-import', 'CDN CSS 안의 @import', (r) => r.cdnsub === 'rgb(200, 100, 0)'],
  ['nocors', 'CORS 불가 CDN (온라인)', (r) => r.legacy === 'rgb(90, 90, 20)'],
  ['sri', 'integrity(SRI) 걸린 CDN CSS', (r) => r.sri === 'rgb(30, 30, 160)'],
  ['insertRule', 'CSS-in-JS(insertRule) 스타일', (r) => r.sc === 'rgb(10, 120, 200)'],
  ['adopted', 'document.adoptedStyleSheets', (r) => r.adopted === 'rgb(160, 20, 120)'],
  ['shadow', 'Shadow DOM 내용·스타일', (r) => r.shadow && r.inner === 'rgb(200, 0, 0)' && r.inner2 === 'rgb(0, 150, 0)'],
  ['defined', ':not(:defined) 로 숨겨지지 않음', (r) => r.cardVisible === 'visible'],
  ['canvas', 'canvas → 이미지', (r) => (r.canvas || '').startsWith('IMG:data:image/png')],
  ['form', '입력값·체크·선택 상태 보존', (r) => r.t === 'hello' && r.cb === true && r.sel === 'b' && r.ta === 'メモ入力'],
  ['submit', 'submit 버튼 라벨 유지', (r) => r.submitAttr === null],
  ['secrets', '비밀번호·CSRF 토큰 파일에 없음', (r, raw) =>
    !['SECRET-CSRF-123', 'SECRET-HIDDEN-456', 'preset-pw', 'typed-secret'].some((s) => raw.includes(s)) && r.hid2 === '3'],
  ['no-script', 'script 0개 (template 포함)', (r) => r.scripts === 0],
  ['no-handler', 'on* 속성 0개 (template 포함)', (r) => r.handlers === 0],
  ['no-js-url', 'javascript: URL 0개 (우회 표기 포함)', (r) => r.jsUrls === 0],
  ['iframe', 'iframe 무력화 (sandbox, src 없음)', (r) => r.frame && r.frame.tag === 'iframe' && !r.frame.src && r.frame.sandbox],
  ['form-action', 'form action 제거', (r) => r.formAction === null],
  ['refresh', 'meta refresh 제거', (r) => !r.refresh],
  // ── 4-2 경계 사례 ──
  ['sri-attr', '[B] integrity 속성·SRI 차단 오류 0건', (r, raw, x) => r.integrity === 0 && x.sriErrors === 0],
  ['tpl-iframe', '[E] template 안 iframe 도 무력화', (r) => !!r.tplIframe && !r.tplIframe.src && r.tplIframe.sandbox],
  ['formaction', '[F] 버튼 formaction 제거', (r) => r.formaction === null],
  ['secret-input', '[G] 비밀번호 보기·카드번호·CVC·OTP 값 없음', (r, raw) =>
    [r.pwShown, r.cc, r.cvc, r.otp].every((v) => v === '') &&
    !['shown-secret-pw', '4111111111111111', '987654'].some((s) => raw.includes(s))],
  ['secret-attr', '[G] data-* 속성·JSON·JWT 토큰 없음', (r, raw) =>
    !['SECRET-DATA-789', 'SECRET-KEY-000', 'SECRET-JSON-111', 'SECRETJWTSIGNATURE123', 'SECRET-TPL-222'].some((s) => raw.includes(s))],
  ['no-over-redact', '[G] 일반 입력값·JSON 은 보존 (과잉 제거 없음)', (r) =>
    r.cardnote === 'memo-ok' && r.propsUser === 'kim' && r.t === 'hello'],
  ['dup-css', '동일 CSS 중복 적용 없음', (r) => r.dupMainCss === 0],
  ['no-toast', '안내 UI 가 캡처에 섞이지 않음', (r) => !r.toast],
  ['unused-font', '화면에 안 쓰인 폰트는 내장 안 함 (절대경로 유지)', (r, raw) =>
    raw.includes('url("http://127.0.0.1:4101/assets/fonts/brand.ttf?unused")')],
  ['off-font', '[오프라인] 폰트 내장', (r, raw, x) => x.offline.brandFont],
  ['off-cdn', '[오프라인] CDN CSS 내장', (r, raw, x) => x.offline.cdn === 'rgb(0, 128, 128)' && x.offline.sri === 'rgb(30, 30, 160)'],
];

// ─────────────────────────────────────────────────────────────
async function runVersion(browser, version) {
  const res = { version, checks: {}, notes: [] };

  // 메인 페이지
  const main = await capture(browser, version, `${A}/index.html`, {
    tag: 'main',
    prepare: async (p) => {
      await p.waitForFunction(() => window.__taintedReady === true);
      await p.evaluate(() => document.fonts.ready);
      await p.fill('#t', 'hello');
      await p.fill('#pw', 'typed-secret');
      await p.check('#cb');
      await p.selectOption('#sel', 'b');
      await p.fill('#ta', 'メモ入力');
      await p.fill('#pw-shown', 'shown-secret-pw');
      await p.evaluate(() => { document.getElementById('pw-shown').type = 'text'; }); // "비밀번호 보기" 토글
      await p.fill('#cc', '4111111111111111');
      await p.fill('#cvc', '123');
      await p.fill('#otp', '987654');
      await p.fill('#cardnote', 'memo-ok');
    },
  });
  if (!main.ok) {
    res.notes.push('메인 캡처 실패: ' + main.error);
  } else {
    res.fileName = main.suggested;
    const raw = await readFile(main.file, 'utf8');
    const on = await openCapture(browser, main.file);
    const r = await on.page.evaluate(inspectMain);
    const shot = await on.page.screenshot({ fullPage: false });
    await on.ctx.close();
    const off = await openCapture(browser, main.file, { offline: true });
    const ro = await off.page.evaluate(inspectMain);
    await off.ctx.close();

    for (const [id, , fn] of CHECKS) {
      const sriErrors = on.errors.filter((e) => /integrity|digest|Subresource/i.test(e)).length;
      try { res.checks[id] = !!fn(r, raw, { offline: ro, sriErrors }); } catch { res.checks[id] = false; }
    }
    res.failedRequests = on.failed.filter((u) => !u.includes('nope.png'));
    res.sizeKB = Math.round(Buffer.byteLength(raw) / 1024);

    // 시각 비교
    const a = PNG.sync.read(main.shot);
    const b = PNG.sync.read(shot);
    const diff = new PNG({ width: a.width, height: a.height });
    const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
    res.diffPct = +((n / (a.width * a.height)) * 100).toFixed(2);
    await writeFile(path.join(outDir, `main-${version}-original.png`), main.shot);
    await writeFile(path.join(outDir, `main-${version}-captured.png`), shot);
    await writeFile(path.join(outDir, `main-${version}-diff.png`), PNG.sync.write(diff));
  }

  // quirks + 원본 <base>
  const q = await capture(browser, version, `${A}/sub/quirks.html`, { tag: 'quirks' });
  if (q.ok) {
    const o = await openCapture(browser, q.file);
    const r = await o.page.evaluate(() => ({
      mode: document.compatMode,
      img: document.getElementById('img').currentSrc,
      w: document.getElementById('img').naturalWidth,
    }));
    await o.ctx.close();
    res.checks['quirks'] = r.mode === 'BackCompat';
    res.checks['base'] = r.img === `${A}/assets/img/bg.png` && r.w === 40;
  } else {
    res.checks['quirks'] = res.checks['base'] = false;
  }

  // CSP meta 페이지
  const c = await capture(browser, version, `${A}/csp.html`, { tag: 'csp' });
  if (c.ok) {
    const o = await openCapture(browser, c.file);
    const r = await o.page.evaluate(() => ({
      box: getComputedStyle(document.getElementById('csp')).backgroundColor,
      title: getComputedStyle(document.getElementById('title')).color,
    }));
    await o.ctx.close();
    res.checks['csp'] = r.box === 'rgb(0, 200, 100)' && r.title === 'rgb(180, 30, 60)';
  } else {
    res.checks['csp'] = false;
  }

  // SPA 클릭 위임 페이지
  const s = await capture(browser, version, `${A}/spa.html`, { tag: 'spa' });
  res.checks['spa'] = s.ok;
  if (!s.ok) res.notes.push('SPA 페이지: 다운로드 이벤트 없음 (문서 클릭 위임에 가로채짐)');

  return res;
}

const EXTRA_CHECKS = [
  ['quirks', 'doctype 없는 quirks 모드 유지'],
  ['base', '원본 <base> 기준 상대경로'],
  ['csp', 'CSP meta 가 있어도 스타일 적용'],
  ['spa', '클릭 가로채는 SPA 에서도 다운로드'],
];

// ─────────────────────────────────────────────────────────────
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
const stop = await startServers();
const browser = await chromium.launch();
let results;
try {
  results = {};
  for (const v of Object.keys(VERSIONS)) results[v] = await runVersion(browser, v);
} finally {
  await browser.close();
  await stop();
}

const all = [...CHECKS.map(([id, desc]) => [id, desc]), ...EXTRA_CHECKS];
const mark = (b) => (b ? 'PASS' : 'FAIL');
const lines = [
  '| # | 항목 | legacy | v2 |',
  '|---|---|---|---|',
  ...all.map(([id, desc], i) => `| ${i + 1} | ${desc} | ${mark(results.legacy.checks[id])} | ${mark(results.v2.checks[id])} |`),
];
const sum = (v) => Object.values(results[v].checks).filter(Boolean).length;
lines.push('', `통과: legacy ${sum('legacy')}/${all.length}, v2 ${sum('v2')}/${all.length}`);
lines.push(`원본 화면 대비 픽셀 차이: legacy ${results.legacy.diffPct}%, v2 ${results.v2.diffPct}%`);
lines.push(`캡처 파일 크기: legacy ${results.legacy.sizeKB}KB, v2 ${results.v2.sizeKB}KB`);
lines.push(`파일명 예: legacy \`${results.legacy.fileName}\`, v2 \`${results.v2.fileName}\``);
for (const v of ['legacy', 'v2']) {
  if (results[v].failedRequests?.length) lines.push(`${v} 캡처 파일의 실패 요청: ${results[v].failedRequests.join(', ')}`);
  for (const n of results[v].notes) lines.push(`${v}: ${n}`);
}
const md = lines.join('\n');
await writeFile(path.join(outDir, 'report.md'), md + '\n');
await writeFile(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
console.log(md);

const v2Fail = all.filter(([id]) => !results.v2.checks[id]).map(([id]) => id);
if (v2Fail.length) {
  console.error('\nv2 실패 항목: ' + v2Fail.join(', '));
  process.exit(1);
}
