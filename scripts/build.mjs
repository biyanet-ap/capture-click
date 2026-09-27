// src/capture.js → dist/bookmarklet.min.js, dist/bookmarklet.txt, dist/install.html
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { minify } from 'terser';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const src = await readFile(path.join(root, 'src/capture.js'), 'utf8');

const { code } = await minify(src, {
  ecma: 2020,
  compress: { passes: 2, drop_debugger: true },
  mangle: true,
  format: { comments: false },
});
if (!code) throw new Error('minify 결과가 비어 있습니다.');

// void(...) 로 감싸 북마클릿 실행 후 페이지가 결과값으로 바뀌지 않게 한다.
const body = `void(${code.replace(/;\s*$/, '')})`;
// 전체 encodeURIComponent: %, #, 줄바꿈, 한글 등 어떤 문자도 URL 에서 깨지지 않도록
const bookmarklet = 'javascript:' + encodeURIComponent(body);

// 브라우저 북마크 URL 길이 여유 확인 (Chrome/Edge 는 사실상 제한 없음, 보수적으로 64KB 경고)
if (bookmarklet.length > 65536) {
  console.warn(`⚠ 북마클릿 길이 ${bookmarklet.length}자: 일부 브라우저에서 잘릴 수 있습니다.`);
}

await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist/bookmarklet.min.js'), body + '\n');
await writeFile(path.join(root, 'dist/bookmarklet.txt'), bookmarklet + '\n');

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const installHtml = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Design Studio 캡처 설치</title>
<style>
  :root { color-scheme: light dark; --fg:#111827; --muted:#6b7280; --bg:#ffffff; --card:#f3f4f6; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --fg:#f3f4f6; --muted:#9ca3af; --bg:#111827; --card:#1f2937; --accent:#60a5fa; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.7 system-ui,"Segoe UI","Malgun Gothic",sans-serif; }
  main { max-width:640px; margin:0 auto; padding:40px 16px; }
  h1 { font-size:22px; margin:0 0 4px; }
  p.sub { color:var(--muted); margin:0 0 28px; }
  .bm { display:inline-block; padding:10px 18px; border-radius:8px; background:var(--accent); color:#fff; text-decoration:none; font-weight:600; cursor:grab; }
  ol { padding-left:20px; }
  .card { background:var(--card); border-radius:8px; padding:14px 16px; margin-top:24px; }
  button { font:inherit; padding:6px 12px; border-radius:6px; border:1px solid var(--muted); background:transparent; color:var(--fg); cursor:pointer; }
  code { font-family:ui-monospace,Consolas,monospace; font-size:13px; }
</style>
</head>
<body>
<main>
  <h1>Design Studio 캡처</h1>
  <p class="sub">v${pkg.version} · ${bookmarklet.length.toLocaleString()}자</p>
  <p>아래 버튼을 <strong>북마크바로 드래그</strong>하세요.</p>
  <p><a class="bm" href="${escapeAttr(bookmarklet)}">DS 캡처</a></p>
  <ol>
    <li>캡처할 페이지를 열고 원하는 상태(메뉴 펼침, 입력값 등)로 맞춥니다.</li>
    <li>북마크바의 <strong>DS 캡처</strong>를 누릅니다. 오른쪽 아래 진행 상황이 표시됩니다.</li>
    <li>다운로드된 <code>capture-*.html</code> 을 스튜디오의 [내 PC 에서 html 파일 불러오기]로 엽니다.</li>
  </ol>
  <div class="card">
    드래그가 안 되면 북마크를 새로 만들고 URL 칸에 붙여넣으세요.
    <p><button id="copy" type="button">북마클릿 코드 복사</button> <span id="msg"></span></p>
  </div>
</main>
<script>
  document.getElementById('copy').addEventListener('click', async () => {
    const msg = document.getElementById('msg');
    try {
      await navigator.clipboard.writeText(document.querySelector('.bm').getAttribute('href'));
      msg.textContent = '복사했습니다.';
    } catch (e) {
      msg.textContent = '복사 실패: dist/bookmarklet.txt 를 직접 여세요.';
    }
  });
  document.querySelector('.bm').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('msg').textContent = '클릭이 아니라 북마크바로 드래그해 주세요.';
  });
</script>
</body>
</html>
`;
await writeFile(path.join(root, 'dist/install.html'), installHtml);

console.log(`build ok: minified ${body.length.toLocaleString()} bytes, bookmarklet ${bookmarklet.length.toLocaleString()} chars`);
