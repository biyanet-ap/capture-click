// CSS-in-JS 흉내: 빈 <style> 에 insertRule (styled-components speedy 모드와 같은 방식)
document.getElementById('sc').sheet.insertRule('.sc-box { background: rgb(10, 120, 200); }');

// 문서 adoptedStyleSheets
const docSheet = new CSSStyleSheet();
docSheet.replaceSync('.adopted-box { background: rgb(160, 20, 120); }');
document.adoptedStyleSheets = [docSheet];

// 열린 Shadow DOM 웹 컴포넌트 (+ 내부 <style>, <link>, adoptedStyleSheets)
const cardSheet = new CSSStyleSheet();
cardSheet.replaceSync('.inner2 { color: rgb(0, 150, 0); font-weight: bold; }');
customElements.define('fancy-card', class extends HTMLElement {
  connectedCallback() {
    const sr = this.attachShadow({ mode: 'open' });
    sr.innerHTML = '<style>:host{display:block;border:2px solid rgb(0,0,0)}</style>' +
      '<link rel="stylesheet" href="/assets/css/card.css"><div class="inner">カード</div><div class="inner2">adopted</div><slot></slot>';
    sr.adoptedStyleSheets = [cardSheet];
  }
});
customElements.define('closed-card', class extends HTMLElement {
  connectedCallback() { this.attachShadow({ mode: 'closed' }).textContent = 'closed shadow'; }
});

// canvas: 정상 / 교차 출처 이미지로 오염
const c1 = document.getElementById('cv');
const g = c1.getContext('2d');
g.fillStyle = 'rgb(220,40,40)'; g.fillRect(0, 0, 120, 60);
g.fillStyle = '#fff'; g.font = '20px sans-serif'; g.fillText('canvas', 20, 38);
const c2 = document.getElementById('cv-tainted');
const im = new Image();
im.onload = () => { c2.getContext('2d').drawImage(im, 0, 0, 60, 60); window.__taintedReady = true; };
im.src = 'http://127.0.0.1:4102/nocors/pixel.png';
