/*!
 * Design Studio Capture v2
 * 현재 페이지를 "스크립트 없는 정지 화면" 단일 HTML 파일로 저장하는 북마클릿 소스.
 * 빌드: npm run build → dist/bookmarklet.txt
 */
(async () => {
  'use strict';

  // ────────────────────────────────────────────────────────────────
  // 설정
  // ────────────────────────────────────────────────────────────────
  const CONFIG = {
    FETCH_TIMEOUT_MS: 8000, // CDN CSS·폰트 요청 1건당 타임아웃
    MAX_IMPORT_DEPTH: 4, // @import 재귀 한도
    INLINE_FONTS: true, // @font-face 폰트를 data: URL로 내장
    FONT_MAX_BYTES: 2 * 1024 * 1024, // 폰트 1개 최대 크기
    FONT_TOTAL_MAX_BYTES: 8 * 1024 * 1024, // 폰트 내장 총량 한도
    REVOKE_DELAY_MS: 60 * 1000, // Blob URL 해제 지연 (즉시 해제 시 다운로드가 취소되는 브라우저 대응)
    FILENAME_SLUG_MAX: 80,
    TOAST_MS: 12 * 1000,
    // 값을 비워야 하는 hidden input / meta 이름 패턴
    REDACT_NAME_RE: /csrf|xsrf|token|nonce|authenticity|session|secret|api[-_]?key/i,
  };

  // ── 상수 (본 흐름보다 먼저 선언해야 TDZ 오류가 나지 않는다) ──
  const REMOVE_SELECTOR = [
    'script',
    'base', // 새 <base> 를 다시 넣는다
    'link[rel~="modulepreload" i]',
    'link[rel~="preload" i]',
    'link[rel~="prefetch" i]',
    'link[rel~="prerender" i]',
    'meta[http-equiv="refresh" i]',
    'meta[http-equiv="content-security-policy" i]', // 남아 있으면 인라인 <style> 이 차단될 수 있음
    'meta[http-equiv="set-cookie" i]',
    'meta[charset]',
    'meta[http-equiv="content-type" i]',
    '[data-ds-capture-ui]',
  ].join(',');
  const URL_ATTRS = new Set([
    'href', 'src', 'action', 'formaction', 'xlink:href', 'data',
    'poster', 'background', 'lowsrc', 'dynsrc', 'cite', 'codebase',
  ]);
  const DROP_ATTRS = new Set(['nonce', 'integrity', 'crossorigin', 'ping', 'action', 'formaction']);
  // ── 폰트 내장 ─────────────────────────────────────────────────────
  const fontCache = new Map(); // url → Promise<dataURL|null>
  let fontBytes = 0;
  const FONT_RANK = { woff2: 4, woff: 3, truetype: 2, opentype: 2, '': 1 };
  // 페이지가 실제로 내려받은 리소스 목록. 일본어·한국어 웹폰트는 unicode-range 로
  // 100개 넘게 쪼개져 있어서, 화면에 쓰인 서브셋만 내장해야 파일이 비대해지지 않는다.
  // (Resource Timing 버퍼 기본값 250개가 가득 찼으면 목록을 믿을 수 없으므로 한도 내 전부 내장)
  const loadedResources = new Set(
    (performance.getEntriesByType ? performance.getEntriesByType('resource') : []).map((e) => e.name)
  );
  const resourceListReliable = loadedResources.size > 0 && loadedResources.size < 250;

  const w = window;
  const d = document;

  // 중복 실행 방지 (버튼 연타)
  if (w.__dsCaptureRunning) return;
  w.__dsCaptureRunning = true;

  const report = {
    sheetsInlined: 0, // CSSOM에서 직접 읽어 인라인한 시트
    sheetsFetched: 0, // 교차 출처라 fetch로 받아 인라인한 시트
    sheetsFailed: [], // 인라인 실패 → <link> 절대경로로 유지 (온라인에서만 적용)
    importsFailed: [],
    fontsInlined: 0,
    fontsSkipped: 0,
    fontsUnused: 0,
    shadowRoots: 0,
    canvases: 0,
    canvasesTainted: 0,
    framesReplaced: 0,
    unsafeUrls: 0,
    redacted: 0,
  };

  const toast = createToast();

  try {
    // ── 1단계 (동기): 복제 + 원본/사본 1:1 매칭 처리 ─────────────────
    // 원본과 사본의 구조가 완전히 같은 시점에 querySelectorAll('*') 순서로 짝을 맞춘다.
    // (정적 NodeList 이므로 이후 사본을 수정해도 매칭이 깨지지 않음)
    const docEl = d.documentElement;
    const cloneRoot = docEl.cloneNode(true);
    const styleJobs = [];
    processPairs(
      [docEl, ...docEl.querySelectorAll('*')],
      [cloneRoot, ...cloneRoot.querySelectorAll('*')],
      styleJobs
    );

    const head = ensureHead(cloneRoot);
    const body = childByName(cloneRoot, 'body') || cloneRoot;

    // document.adoptedStyleSheets 는 문서 트리 맨 뒤에 적용되는 것과 같으므로 body 끝에 둔다.
    for (const sheet of d.adoptedStyleSheets || []) {
      const st = d.createElement('style');
      st.setAttribute('data-ds-adopted', '');
      body.appendChild(st);
      styleJobs.push({ sheet, clone: st });
    }

    sanitize(cloneRoot);
    prepareHead(head);

    // ── 2단계 (비동기): 스타일시트 직렬화 · CDN fetch · 폰트 내장 ──────
    toast.show('Design Studio 캡처 중…\n스타일시트와 폰트를 정리하고 있습니다.');
    // 시트 하나의 예외가 캡처 전체를 실패시키지 않도록 작업별로 격리
    await Promise.all(
      styleJobs.map((job) =>
        runStyleJob(job).catch((e) => {
          console.warn('[Design Studio Capture] 스타일시트 처리 실패', job.orig || job.sheet, e);
          report.sheetsFailed.push((job.sheet && job.sheet.href) || (job.orig && job.orig.href) || 'inline <style>');
        })
      )
    );

    // ── 3단계: 직렬화 · 다운로드 ─────────────────────────────────────
    const html = doctypeString() + '\n' + cloneRoot.outerHTML;
    const fileName = buildFileName();
    downloadHtml(html, fileName);

    const kb = Math.round(new Blob([html]).size / 1024);
    toast.show(buildReportMessage(fileName, kb), CONFIG.TOAST_MS);
    console.info('[Design Studio Capture] 완료', { fileName, sizeKB: kb, ...report });
  } catch (err) {
    console.error('[Design Studio Capture] 실패', err);
    toast.show('캡처 실패: ' + (err && err.message ? err.message : err), CONFIG.TOAST_MS);
  } finally {
    w.__dsCaptureRunning = false;
  }

  // ════════════════════════════════════════════════════════════════
  // 1단계: 원본/사본 쌍 처리
  // ════════════════════════════════════════════════════════════════

  function processPairs(origEls, cloneEls, jobs) {
    if (origEls.length !== cloneEls.length) {
      throw new Error('DOM 복제 결과가 원본과 일치하지 않습니다.');
    }
    for (let i = 0; i < origEls.length; i++) {
      const o = origEls[i];
      const c = cloneEls[i];

      if (o.shadowRoot) attachShadowTemplate(o, c, jobs);

      switch (o.localName) {
        case 'style':
          jobs.push({ orig: o, clone: c });
          break;
        case 'link':
          if (isStylesheetLink(o)) jobs.push({ orig: o, clone: c });
          break;
        case 'canvas':
          replaceCanvas(o, c);
          break;
        case 'input':
          syncInput(o, c);
          break;
        case 'textarea':
          c.textContent = o.value;
          break;
        case 'option':
          c.toggleAttribute('selected', o.selected);
          break;
        case 'iframe':
        case 'frame':
          neutralizeFrame(c, frameLabel(o), o);
          break;
        case 'object':
        case 'embed':
          replaceWithPlaceholder(o, c);
          break;
      }
    }
  }

  /** 열린 Shadow Root → Declarative Shadow DOM(<template shadowrootmode="open">) */
  function attachShadowTemplate(o, c, jobs) {
    const sr = o.shadowRoot;
    const frag = d.createDocumentFragment();
    for (const n of sr.childNodes) frag.appendChild(n.cloneNode(true));
    processPairs([...sr.querySelectorAll('*')], [...frag.querySelectorAll('*')], jobs);

    for (const sheet of sr.adoptedStyleSheets || []) {
      const st = d.createElement('style');
      st.setAttribute('data-ds-adopted', '');
      frag.appendChild(st);
      jobs.push({ sheet, clone: st });
    }

    const tpl = d.createElement('template');
    tpl.setAttribute('shadowrootmode', 'open');
    if (sr.delegatesFocus) tpl.setAttribute('shadowrootdelegatesfocus', '');
    tpl.content.appendChild(frag);
    c.insertBefore(tpl, c.firstChild);
    report.shadowRoots++;
  }

  function replaceCanvas(o, c) {
    report.canvases++;
    let dataUrl;
    try {
      dataUrl = o.toDataURL('image/png');
    } catch (e) {
      // 교차 출처 이미지를 그린 "오염된" canvas 는 읽을 수 없다
      report.canvasesTainted++;
      return;
    }
    const img = d.createElement('img');
    for (const a of c.attributes) img.setAttribute(a.name, a.value);
    img.setAttribute('src', dataUrl);
    if (!img.hasAttribute('alt')) img.setAttribute('alt', '');
    img.setAttribute('data-ds-canvas', '');
    c.replaceWith(img);
  }

  function syncInput(o, c) {
    const type = (o.type || '').toLowerCase();
    switch (type) {
      case 'password':
        // 비밀번호는 입력값·속성값 모두 파일에 남기지 않는다
        if (o.value || c.hasAttribute('value')) report.redacted++;
        c.removeAttribute('value');
        return;
      case 'file':
      case 'submit':
      case 'reset':
      case 'button':
      case 'image':
        return; // 버튼류는 value 가 라벨이므로 건드리지 않음
      case 'checkbox':
      case 'radio':
        c.toggleAttribute('checked', o.checked);
        return;
      case 'hidden':
        if (CONFIG.REDACT_NAME_RE.test(o.name || o.id || '') && o.value) {
          c.setAttribute('value', '');
          report.redacted++;
        }
        return;
      default:
        c.setAttribute('value', o.value);
    }
  }

  function frameLabel(o) {
    let label = o.localName;
    try {
      const src = o.getAttribute('src');
      if (src) label += ' · ' + new URL(src, d.baseURI).host;
    } catch (e) {
      /* 잘못된 URL 은 라벨만 생략 */
    }
    return label;
  }

  /**
   * iframe 은 요소 자체를 유지해야 페이지 CSS(`.video iframe {…}`)가 그대로 적용된다.
   * src 를 떼고, 스크립트가 불가능한 sandbox + srcdoc 자리표시로 바꾼다.
   */
  function neutralizeFrame(c, label, o) {
    for (const name of ['src', 'srcdoc', 'allow', 'allowfullscreen', 'loading', 'name']) {
      c.removeAttribute(name);
    }
    c.setAttribute('sandbox', '');
    c.setAttribute('data-ds-placeholder', label);
    if (c.localName === 'iframe') {
      c.setAttribute(
        'srcdoc',
        '<!DOCTYPE html><body style="margin:0;height:100vh;display:flex;align-items:center;' +
          'justify-content:center;font:12px/1.4 system-ui,sans-serif;color:#6b7280;' +
          'background:repeating-linear-gradient(45deg,#f3f4f6 0 10px,#e5e7eb 10px 20px)">' +
          escapeHtml(label) +
          '</body>'
      );
    } else {
      c.setAttribute('src', 'about:blank');
    }
    if (o) report.framesReplaced++;
  }

  /** object/embed(플러그인 콘텐츠)는 같은 크기의 자리표시 박스로 대체 */
  function replaceWithPlaceholder(o, c) {
    const rect = o.getBoundingClientRect();
    const cs = getComputedStyle(o);
    const ph = d.createElement('div');
    for (const name of ['id', 'class', 'style', 'title']) {
      if (c.hasAttribute(name)) ph.setAttribute(name, c.getAttribute(name));
    }
    const label = o.localName;
    ph.setAttribute('data-ds-placeholder', label);
    const s = ph.style;
    s.display = cs.display === 'none' ? 'none' : cs.display.startsWith('inline') ? 'inline-flex' : 'flex';
    s.alignItems = 'center';
    s.justifyContent = 'center';
    s.boxSizing = 'border-box';
    s.width = rect.width + 'px';
    s.height = rect.height + 'px';
    s.font = '12px/1.4 system-ui,sans-serif';
    s.color = '#6b7280';
    s.background = 'repeating-linear-gradient(45deg,#f3f4f6 0 10px,#e5e7eb 10px 20px)';
    ph.textContent = label;
    c.replaceWith(ph);
    report.framesReplaced++;
  }

  // ════════════════════════════════════════════════════════════════
  // 정화 (sanitize)
  // ════════════════════════════════════════════════════════════════



  function sanitize(root) {
    root.querySelectorAll(REMOVE_SELECTOR).forEach((e) => e.remove());

    // SVG <animate>/<set> 으로 href 를 javascript: 로 바꾸는 우회 차단
    root.querySelectorAll('animate, set, animateTransform, animateMotion').forEach((e) => {
      const target = (e.getAttribute('attributeName') || '').toLowerCase();
      if (target === 'href' || target === 'xlink:href') e.remove();
    });

    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (!el.attributes) continue;
      for (let k = el.attributes.length - 1; k >= 0; k--) {
        const name = el.attributes[k].name.toLowerCase();
        const value = el.attributes[k].value;
        if (name.startsWith('on') || DROP_ATTRS.has(name)) {
          el.removeAttribute(el.attributes[k].name);
        } else if (URL_ATTRS.has(name) && isUnsafeUrl(value)) {
          report.unsafeUrls++;
          if (name === 'href') el.setAttribute(el.attributes[k].name, '#');
          else el.removeAttribute(el.attributes[k].name);
        }
      }
      if (el.localName === 'meta') redactMeta(el);
      // 1단계에서 짝이 없던 iframe(<template> 안 등)도 동일하게 무력화
      if ((el.localName === 'iframe' || el.localName === 'frame') && !el.hasAttribute('data-ds-placeholder')) {
        neutralizeFrame(el, el.localName, null);
      }
      if (el.localName === 'object' || el.localName === 'embed') {
        // 1단계에서 짝이 없던 플러그인 요소(<template> 내부 등): 크기를 모르므로 제거만 한다
        el.remove();
        continue;
      }
      // <template>(Shadow DOM 포함) 내부는 querySelectorAll 로 닿지 않으므로 재귀
      if (el.localName === 'template' && el.content) sanitize(el.content);
    }
  }

  function redactMeta(el) {
    const name = el.getAttribute('name') || el.getAttribute('property') || '';
    if (CONFIG.REDACT_NAME_RE.test(name) && el.getAttribute('content')) {
      el.setAttribute('content', '');
      report.redacted++;
    }
  }

  function isUnsafeUrl(value) {
    // 브라우저는 스킴 앞뒤의 공백·제어문자를 무시하므로 동일하게 정규화 후 판정
    // eslint-disable-next-line no-control-regex
    const v = String(value).replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();
    return (
      v.startsWith('javascript:') ||
      v.startsWith('vbscript:') ||
      v.startsWith('data:text/html') ||
      v.startsWith('data:application/xhtml')
    );
  }

  function prepareHead(head) {
    const meta = d.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    const base = d.createElement('base');
    // document.baseURI: 원본 페이지의 <base> 까지 반영된 실제 기준 URL
    base.setAttribute('href', d.baseURI);
    const origBase = d.querySelector('base[target]');
    if (origBase) base.setAttribute('target', origBase.getAttribute('target'));
    const src = d.createElement('meta');
    src.setAttribute('name', 'ds-capture-source');
    src.setAttribute('content', location.origin + location.pathname); // 쿼리스트링(토큰 가능성) 제외
    const time = d.createElement('meta');
    time.setAttribute('name', 'ds-capture-time');
    time.setAttribute('content', new Date().toISOString());
    // charset 선언은 문서 앞 1024바이트 안에 있어야 하므로 head 맨 앞에 둔다
    head.insertBefore(time, head.firstChild);
    head.insertBefore(src, head.firstChild);
    head.insertBefore(base, head.firstChild);
    head.insertBefore(meta, head.firstChild);
  }

  // ════════════════════════════════════════════════════════════════
  // 2단계: 스타일시트
  // ════════════════════════════════════════════════════════════════

  async function runStyleJob(job) {
    const { orig, clone } = job;
    const sheet = job.sheet || (orig && orig.sheet);
    const isLink = orig && orig.localName === 'link';

    if (!sheet) {
      // 로드 실패한 <link> 등: 절대경로로만 보정
      if (isLink && orig.href) {
        clone.setAttribute('href', orig.href);
        report.sheetsFailed.push(orig.href);
      }
      return;
    }
    if (sheet.disabled) {
      // 대체 스타일시트(alternate) 등 비활성 시트는 원형 유지
      if (isLink) clone.setAttribute('href', orig.href);
      return;
    }

    const baseUrl = sheet.href || d.baseURI;
    let css = await serializeSheet(sheet, baseUrl, 0);

    if (css == null) {
      // 교차 출처 + CORS 불가 → <link> 유지 (integrity/crossorigin 은 sanitize 에서 제거됨)
      if (isLink) clone.setAttribute('href', sheet.href);
      report.sheetsFailed.push(sheet.href);
      return;
    }

    css = rewriteDefinedPseudo(css);
    if (CONFIG.INLINE_FONTS) css = await inlineFonts(css);

    if (isLink) {
      // <link> 자리에 그대로 <style> 을 넣어 cascade 순서를 보존 (원본 코드의 중복 적용 문제 해결)
      const st = d.createElement('style');
      for (const name of ['media', 'title']) {
        if (orig.hasAttribute(name)) st.setAttribute(name, orig.getAttribute(name));
      }
      st.setAttribute('data-ds-href', sheet.href);
      st.textContent = css;
      clone.replaceWith(st);
    } else {
      // <style> 요소: CSS-in-JS(insertRule)로 textContent 가 비어 있는 경우까지 CSSOM 기준으로 교체
      clone.textContent = css;
    }
  }

  /** @returns {Promise<string|null>} null = 읽기·fetch 모두 실패 */
  async function serializeSheet(sheet, baseUrl, depth) {
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch (e) {
      rules = null; // 교차 출처 시트: SecurityError
    }

    if (!rules) {
      if (!sheet.href) return null;
      const text = await fetchText(sheet.href);
      if (text == null) return null;
      report.sheetsFetched++;
      return serializeCssText(text, sheet.href, depth);
    }

    report.sheetsInlined++;
    const hoisted = []; // 인라인 실패한 @import 는 규칙상 맨 앞에 있어야 함
    const parts = await Promise.all(
      Array.from(rules, async (rule) => {
        if (rule.type === 3 /* CSSRule.IMPORT_RULE */) {
          const r = await serializeImportRule(rule, baseUrl, depth);
          if (!r.inline) hoisted.push(r.text);
          return r.inline ? r.text : '';
        }
        return rewriteUrls(rule.cssText, baseUrl);
      })
    );
    return hoisted.concat(parts.filter(Boolean)).join('\n');
  }

  async function serializeImportRule(rule, baseUrl, depth) {
    let href;
    try {
      href = (rule.styleSheet && rule.styleSheet.href) || new URL(rule.href, baseUrl).href;
    } catch (e) {
      return { inline: false, text: '' };
    }
    const media = rule.media && rule.media.mediaText ? rule.media.mediaText : '';
    const layer = rule.layerName; // null: 없음, '': 익명 레이어
    const supports = rule.supportsText || '';

    let inner = null;
    if (depth < CONFIG.MAX_IMPORT_DEPTH) {
      if (rule.styleSheet) {
        inner = await serializeSheet(rule.styleSheet, href, depth + 1);
      } else {
        const text = await fetchText(href);
        if (text != null) inner = await serializeCssText(text, href, depth + 1);
      }
    }

    if (inner == null) {
      report.importsFailed.push(href);
      let text = `@import url("${href}")`;
      if (layer != null) text += layer ? ` layer(${layer})` : ' layer';
      if (supports) text += ` supports(${supports})`;
      if (media) text += ' ' + media;
      return { inline: false, text: text + ';' };
    }

    let wrapped = inner;
    if (layer != null) wrapped = `@layer ${layer} {\n${wrapped}\n}`;
    if (supports) wrapped = `@supports (${supports}) {\n${wrapped}\n}`;
    if (media && media !== 'all') wrapped = `@media ${media} {\n${wrapped}\n}`;
    return { inline: true, text: wrapped };
  }

  /** fetch 로 받은 CSS 원문 처리: @charset 제거, @import 재귀, url() 절대경로화 */
  async function serializeCssText(text, href, depth) {
    let body = text
      .replace(/^﻿/, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@charset\s+["'][^"']*["']\s*;/gi, '');

    const imports = [];
    body = body.replace(
      /@import\s+(?:url\(\s*(["']?)([^"')]+)\1\s*\)|(["'])([^"']+)\3)([^;]*);/gi,
      (m, q1, u1, q2, u2, tail) => {
        imports.push({ url: u1 || u2, tail: (tail || '').trim() });
        return '';
      }
    );

    const hoisted = [];
    const inlined = await Promise.all(
      imports.map(async ({ url, tail }) => {
        let abs;
        try {
          abs = new URL(url, href).href;
        } catch (e) {
          return '';
        }
        // media/layer/supports 조건이 붙은 @import 는 원형(절대경로) 유지
        if (!tail && depth < CONFIG.MAX_IMPORT_DEPTH) {
          const t = await fetchText(abs);
          if (t != null) return serializeCssText(t, abs, depth + 1);
        }
        report.importsFailed.push(abs);
        hoisted.push(`@import url("${abs}")${tail ? ' ' + tail : ''};`);
        return '';
      })
    );

    return hoisted.concat(inlined.filter(Boolean), rewriteUrls(body, href)).join('\n');
  }

  /**
   * CSS 안의 url() 을 "그 CSS 파일 위치" 기준 절대경로로 변환.
   * 원본 코드는 인라인 후 페이지 기준으로 재해석되어 폰트·배경 이미지가 깨졌다.
   */
  function rewriteUrls(css, baseUrl) {
    return css.replace(
      /url\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|([^)'"\s]+))\s*\)/gi,
      (match, dq, sq, bare) => {
        const raw = (dq != null ? dq : sq != null ? sq : bare).trim();
        if (!raw || /^(data:|#|about:|blob:)/i.test(raw)) return match;
        try {
          return `url("${new URL(raw, baseUrl).href}")`;
        } catch (e) {
          return match;
        }
      }
    );
  }

  /**
   * 캡처 파일에는 스크립트가 없어 커스텀 엘리먼트가 영원히 :defined 가 되지 않는다.
   * 흔한 FOUC 방지 규칙(`x-foo:not(:defined){visibility:hidden}`)에 가려지지 않도록 치환.
   */
  function rewriteDefinedPseudo(css) {
    return css.replace(/:not\(\s*:defined\s*\)/g, ':not(*)').replace(/:defined\b/g, ':is(*)');
  }


  async function inlineFonts(css) {
    const blocks = css.match(/@font-face\s*\{[^}]*\}/gi);
    if (!blocks) return css;
    const replacements = await Promise.all(blocks.map(inlineFontFaceBlock));
    let i = 0;
    return css.replace(/@font-face\s*\{[^}]*\}/gi, () => replacements[i++]);
  }

  async function inlineFontFaceBlock(block) {
    // src 목록 중 브라우저가 실제로 고를 가장 좋은 포맷 하나만 내장 (용량 절약)
    const re = /url\("([^"]+)"\)\s*(?:format\(\s*["']?([\w-]+)["']?\s*\))?/g;
    let best = null;
    let loaded = null;
    let m;
    while ((m = re.exec(block))) {
      const url = m[1];
      if (/^data:/i.test(url)) return block; // 이미 내장됨
      if (!loaded && loadedResources.has(url)) loaded = { url };
      const rank = FONT_RANK[(m[2] || '').toLowerCase()] || 0;
      if (rank > 0 && (!best || rank > best.rank)) best = { url, rank };
    }
    if (loaded) best = loaded; // 브라우저가 실제로 고른 파일 우선
    else if (resourceListReliable) {
      report.fontsUnused++; // 화면에서 쓰이지 않은 폰트: 절대경로로만 남김
      return block;
    }
    if (!best) return block;
    const dataUrl = await fetchFontDataUrl(best.url);
    if (!dataUrl) return block;
    return block.split(`url("${best.url}")`).join(`url("${dataUrl}")`);
  }

  function fetchFontDataUrl(url) {
    if (!fontCache.has(url)) {
      fontCache.set(
        url,
        (async () => {
          const blob = await fetchBlob(url);
          if (!blob) {
            report.fontsSkipped++;
            return null;
          }
          if (blob.size > CONFIG.FONT_MAX_BYTES || fontBytes + blob.size > CONFIG.FONT_TOTAL_MAX_BYTES) {
            report.fontsSkipped++;
            return null;
          }
          fontBytes += blob.size;
          const dataUrl = await blobToDataUrl(blob);
          if (dataUrl) report.fontsInlined++;
          return dataUrl;
        })()
      );
    }
    return fontCache.get(url);
  }

  // ════════════════════════════════════════════════════════════════
  // 네트워크 유틸 (원본 페이지가 이미 불러온 리소스를 GET 으로만 다시 읽음)
  // ════════════════════════════════════════════════════════════════

  async function fetchWithTimeout(url) {
    let u;
    try {
      u = new URL(url, d.baseURI);
    } catch (e) {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), CONFIG.FETCH_TIMEOUT_MS) : null;
    try {
      const res = await fetch(u.href, {
        mode: 'cors',
        // 교차 출처에는 쿠키를 보내지 않는다
        credentials: u.origin === location.origin ? 'same-origin' : 'omit',
        signal: ctrl ? ctrl.signal : undefined,
      });
      return res.ok ? res : null;
    } catch (e) {
      return null; // CORS 거부, CSP connect-src 차단, 타임아웃 등
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function fetchText(url) {
    const res = await fetchWithTimeout(url);
    if (!res) return null;
    try {
      return await res.text();
    } catch (e) {
      return null;
    }
  }

  async function fetchBlob(url) {
    const res = await fetchWithTimeout(url);
    if (!res) return null;
    try {
      return await res.blob();
    } catch (e) {
      return null;
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  }

  // ════════════════════════════════════════════════════════════════
  // 3단계: 출력
  // ════════════════════════════════════════════════════════════════

  /** 원본 doctype 유지 (doctype 없는 quirks 모드 페이지를 표준 모드로 바꾸면 레이아웃이 달라진다) */
  function doctypeString() {
    const dt = d.doctype;
    if (!dt) return '';
    let s = '<!DOCTYPE ' + dt.name;
    if (dt.publicId) s += ` PUBLIC "${dt.publicId}"`;
    else if (dt.systemId) s += ' SYSTEM';
    if (dt.systemId) s += ` "${dt.systemId}"`;
    return s + '>';
  }

  function buildFileName() {
    const slug =
      (location.hostname + location.pathname)
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, CONFIG.FILENAME_SLUG_MAX)
        .replace(/-+$/, '') || 'page';
    const t = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
    return `capture-${slug}-${stamp}.html`;
  }

  function downloadHtml(html, fileName) {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const a = d.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    // 토스트의 closed Shadow DOM 안에서 클릭한다. 문서에 연결돼 있어 모든 브라우저에서
    // 다운로드가 동작하고, 바깥 리스너에는 event.target 이 호스트 div 로 보이고
    // composedPath() 에도 <a> 가 드러나지 않아 SPA 라우터·pjax 의 클릭 위임이 가로채지 못한다.
    const container = toast.container();
    if (container) {
      container.appendChild(a);
      a.click();
      a.remove();
    } else {
      a.click(); // 토스트를 붙일 수 없는 페이지: 분리된 요소 클릭 (Chromium 계열에서 동작 확인)
    }
    setTimeout(() => URL.revokeObjectURL(url), CONFIG.REVOKE_DELAY_MS);
  }

  function buildReportMessage(fileName, kb) {
    const r = report;
    const lines = [
      'Design Studio 캡처 완료',
      `파일: ${fileName} (${kb.toLocaleString()} KB)`,
      `스타일시트 ${r.sheetsInlined + r.sheetsFetched}개 내장 (CDN ${r.sheetsFetched}) · 폰트 ${r.fontsInlined}개 내장`,
    ];
    const extra = [];
    if (r.shadowRoots) extra.push(`Shadow DOM ${r.shadowRoots}`);
    if (r.canvases) extra.push(`canvas ${r.canvases - r.canvasesTainted}/${r.canvases}`);
    if (r.framesReplaced) extra.push(`iframe·embed ${r.framesReplaced}개 자리표시`);
    if (extra.length) lines.push(extra.join(' · '));
    if (r.redacted || r.unsafeUrls) {
      lines.push(`보안: 민감값 ${r.redacted}개 비움 · 위험 URL ${r.unsafeUrls}개 무력화`);
    }
    const failed = r.sheetsFailed.length + r.importsFailed.length;
    if (failed) lines.push(`⚠ CSS ${failed}개는 CORS 제한으로 내장 실패 (온라인에서만 적용, 콘솔 참고)`);
    if (r.fontsSkipped) lines.push(`⚠ 폰트 ${r.fontsSkipped}개 미내장 (CORS 또는 용량 한도)`);
    lines.push('스튜디오에서 [내 PC 에서 html 파일 불러오기]로 여세요.');
    return lines.join('\n');
  }

  // ════════════════════════════════════════════════════════════════
  // 공통 유틸
  // ════════════════════════════════════════════════════════════════

  function isStylesheetLink(el) {
    return /(^|\s)stylesheet(\s|$)/i.test(el.getAttribute('rel') || '');
  }

  function childByName(parent, name) {
    for (const ch of parent.children) if (ch.localName === name) return ch;
    return null;
  }

  function ensureHead(root) {
    let head = childByName(root, 'head');
    if (!head) {
      head = d.createElement('head');
      root.insertBefore(head, root.firstChild);
    }
    return head;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  }

  /**
   * alert() 대신 비차단 토스트. 페이지 CSS 영향을 받지 않도록 closed Shadow DOM 사용,
   * 스타일은 CSSOM(style 프로퍼티)으로만 지정 → 페이지 CSP 의 style-src 에 막히지 않음.
   */
  function createToast() {
    let host = null;
    let box = null;
    let timer = null;
    function mount() {
      host = d.createElement('div');
      host.setAttribute('data-ds-capture-ui', '');
      host.style.setProperty('all', 'initial', 'important');
      host.style.setProperty('display', 'block', 'important');
      const root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
      shadow = root;
      box = d.createElement('div');
      Object.assign(box.style, {
        position: 'fixed',
        zIndex: '2147483647',
        right: '16px',
        bottom: '16px',
        maxWidth: '420px',
        padding: '12px 14px',
        borderRadius: '8px',
        background: '#1f2937',
        color: '#f9fafb',
        font: '13px/1.55 system-ui,-apple-system,"Segoe UI","Malgun Gothic","Hiragino Sans",sans-serif',
        boxShadow: '0 6px 24px rgba(0,0,0,.3)',
        whiteSpace: 'pre-line',
        cursor: 'pointer',
      });
      box.title = '클릭해서 닫기';
      box.addEventListener('click', () => host.remove());
      root.appendChild(box);
    }
    let shadow = null;
    return {
      container() {
        return host && host.isConnected ? shadow : null;
      },
      show(text, autoHideMs) {
        try {
          if (!host) mount();
          box.textContent = text;
          if (!host.isConnected) (d.body || d.documentElement).appendChild(host);
          if (timer) clearTimeout(timer);
          if (autoHideMs) timer = setTimeout(() => host.remove(), autoHideMs);
        } catch (e) {
          // DOM 에 붙일 수 없는 극단적인 페이지: 최후 수단
          if (autoHideMs) alert(text);
        }
      },
    };
  }
})();
