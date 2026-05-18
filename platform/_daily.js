/* Phase 7 Step 8 — `daily.html`은 backend가 아직 없는 demo surface.
 *
 * 데이터 출처:
 *   - 사이드바 / 프로필 : 공통 `_shared.js`의 `/me` 경로
 *   - 키워드 / 경쟁사    : 페이지 로컬 상태 (user-typed). 새로고침하면 초기화
 *   - 트렌드 / To-Do     : DEMO_* 상수
 *   - 내보내기           : 화면의 현재 demo 데이터를 그대로 HTML/PDF/DOC/XLSX/PPTX로 직렬화
 *
 * 안 한 것 (Step 8 범위 밖):
 *   - 네이버 검색 API adapter / scheduler / queue
 *   - AI To-Do generation backend
 *   - 키워드/경쟁사 persistence
 *
 * XSS gate:
 *   - 키워드, 경쟁사 입력은 user-typed이므로 innerHTML 보간 전에 escapeHtml 적용
 *   - DEMO_TRENDS / DEMO_TODOS는 로컬 상수라 escape 불필요하지만, 향후 server-supplied로 교체할 때 escape 누락하지 말 것
 */

renderSidebar('daily');

/* Page-local XSS escape — daily는 user-typed 키워드/경쟁사를 innerHTML로
 * 보간하므로 반드시 통과시킨다. dashboard / newsletter도 동일 helper를
 * 페이지마다 두고 있다. shared util화는 demo cleanup 범위 밖. */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Today date
const today = new Date();
const days = ['일','월','화','수','목','금','토'];
document.getElementById('todayDate').textContent =
  `${today.getFullYear()}년 ${today.getMonth()+1}월 ${today.getDate()}일 (${days[today.getDay()]}요일)`;

/* ──────── Keywords (demo · local · user-typed) ──────── */
let keywords = ['B2B SaaS 도입', 'AI 콜센터', '통화 분석', 'CRM 통합', '영업 자동화', 'HubSpot', 'Salesforce'];

function renderKeywords() {
  const list = document.getElementById('kwList');
  const listModal = document.getElementById('kwListModal');
  // user-typed 키워드 → escapeHtml 통과시켜야 XSS 안전.
  const html = keywords.map((k, i) => `
    <span class="kw-chip">
      ${escapeHtml(k)}
      <button onclick="removeKeyword(${i})" title="삭제">
        <svg width="9" height="9" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </span>
  `).join('');
  list.innerHTML = html;
  listModal.innerHTML = html || '<span class="text-[.75rem] text-slate-400 italic">등록된 키워드가 없습니다.</span>';
  document.getElementById('kwCount').textContent = keywords.length;
  document.getElementById('kwCount2').textContent = keywords.length;
}

function addKeyword() {
  const input = document.getElementById('kwInput');
  const v = input.value.trim();
  if (!v) return;
  if (keywords.length >= 30) { alert('최대 30개까지 등록 가능합니다.'); return; }
  if (keywords.includes(v)) { alert('이미 등록된 키워드입니다.'); return; }
  keywords.push(v);
  input.value = '';
  renderKeywords();
}

function removeKeyword(idx) {
  keywords.splice(idx, 1);
  renderKeywords();
}

/* ──────── Competitors (demo · local · user-typed) ──────── */
let competitors = [
  { name: 'NexusAI', domain: 'nexusai.io' },
  { name: 'OrbitSales', domain: 'orbitsales.com' },
  { name: 'TalkSphere', domain: 'talksphere.kr' },
  { name: 'GongChat', domain: 'gongchat.io' },
];

function renderCompetitors() {
  // c.name / c.domain 둘 다 user-typed (addCompetitor에서 들어옴) → escape 필수.
  document.getElementById('cpList').innerHTML = competitors.map((c, i) => `
    <li class="flex items-center gap-2 p-2.5 rounded-lg border border-slate-200 bg-white">
      <div class="w-7 h-7 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center font-black text-[.7rem] shrink-0">${escapeHtml(c.name.slice(0,1))}</div>
      <div class="flex-1 min-w-0">
        <div class="text-[.82rem] font-bold text-slate-800 truncate">${escapeHtml(c.name)}</div>
        <div class="text-[.68rem] text-slate-400 truncate">${escapeHtml(c.domain)}</div>
      </div>
      <button onclick="removeCompetitor(${i})" class="w-7 h-7 rounded hover:bg-rose-50 hover:text-rose-600 text-slate-400 flex items-center justify-center transition-colors">
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </li>
  `).join('') || '<li class="text-[.75rem] text-slate-400 italic px-2">등록된 경쟁사가 없습니다.</li>';
  document.getElementById('cpCount').textContent = competitors.length;
}

function addCompetitor() {
  const name = document.getElementById('cpName').value.trim();
  const domain = document.getElementById('cpDomain').value.trim();
  if (!name || !domain) { alert('회사명과 도메인 모두 입력해 주세요.'); return; }
  if (competitors.length >= 10) { alert('최대 10개까지 등록 가능합니다.'); return; }
  competitors.push({ name, domain });
  document.getElementById('cpName').value = '';
  document.getElementById('cpDomain').value = '';
  renderCompetitors();
}

function removeCompetitor(idx) {
  competitors.splice(idx, 1);
  renderCompetitors();
}

/* ──────── Trends (demo · local constant) ──────── */
const DEMO_TRENDS = [
  { kw: 'B2B SaaS 도입', volume: 12400, change: 42, dir: 'up', desc: '신규 기사 32건 · 도입 사례 글 증가', spark: [40,50,55,60,72,80,88] },
  { kw: 'AI 콜센터', volume: 8910, change: 28, dir: 'up', desc: '신규 기사 18건 · 정부 지원 사업 발표', spark: [50,52,55,58,65,72,80] },
  { kw: '통화 분석 솔루션', volume: 4520, change: 15, dir: 'up', desc: '신규 기사 11건', spark: [55,58,55,62,68,65,72] },
  { kw: '영업 자동화', volume: 5800, change: 11, dir: 'up', desc: '컨퍼런스 시즌 효과', spark: [60,62,64,66,68,70,72] },
  { kw: 'HubSpot', volume: 14700, change: 4, dir: 'up', desc: '안정적 검색량 유지', spark: [70,69,71,72,71,73,74] },
  { kw: 'Salesforce', volume: 22300, change: 4, dir: 'up', desc: '신제품 출시 영향', spark: [72,74,73,76,75,78,80] },
  { kw: 'CRM 통합', volume: 2100, change: -6, dir: 'down', desc: '검색량 다소 감소', spark: [68,65,62,60,58,55,55] },
];

function renderTrends() {
  // DEMO_TRENDS는 로컬 상수라 escape 생략 가능. 단 server-supplied로 교체할 때
  // t.kw / t.desc 둘 다 escapeHtml 통과 필수.
  const html = DEMO_TRENDS.map(t => {
    const color = t.dir === 'up' ? 'text-emerald-600' : 'text-rose-500';
    const arrow = t.dir === 'up' ? '↑' : '↓';
    const max = Math.max(...t.spark);
    const sparkBars = t.spark.map(v => `<span style="height: ${(v/max*100).toFixed(0)}%"></span>`).join('');
    return `
      <div class="trend-row">
        <div class="trend-spark">${sparkBars}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-0.5 flex-wrap">
            <span class="text-[.88rem] font-bold text-slate-800">${t.kw}</span>
            <span class="text-[.65rem] text-slate-400 tnum">검색 ${t.volume.toLocaleString()}회/일</span>
          </div>
          <p class="text-[.74rem] text-slate-500 truncate">${t.desc}</p>
        </div>
        <div class="text-right shrink-0">
          <div class="${color} font-bold text-[.85rem] tnum">${arrow} ${Math.abs(t.change)}%</div>
          <div class="text-[.62rem] text-slate-400 tnum">7일</div>
        </div>
      </div>
    `;
  }).join('');
  document.getElementById('trendsList').innerHTML = html;
}

/* ──────── To-Do (demo · local constant) ──────── */
const DEMO_TODOS = [
  { done: false, priority: 'high', text: 'A사 김대표님 후속 미팅 예약 (10:00)', tag: '미팅', source: '통화 #1245' },
  { done: false, priority: 'high', text: 'B사 정유진 고객 도입 사례 자료 발송', tag: '발송', source: 'AI 추천' },
  { done: false, priority: 'high', text: '경쟁사 NexusAI 신규 기능 분석', tag: '리서치', source: '경쟁사 알림' },
  { done: false, priority: 'med', text: 'OrbitSales 가격 인하 대응 — 영업팀 공유', tag: '회의', source: '경쟁사 알림' },
  { done: false, priority: 'med', text: 'B2B SaaS 도입 키워드 인입 리드 5명 검토', tag: '리뷰', source: '트렌드' },
  { done: false, priority: 'med', text: '5월 뉴스레터 초안 검토 후 발송', tag: '발송', source: 'AI 추천' },
  { done: false, priority: 'low', text: '다음 주 CRM 통합 웨비나 일정 잡기', tag: '미팅', source: 'AI 추천' },
  { done: false, priority: 'low', text: 'HubSpot 동기화 오류 1건 확인', tag: '점검', source: '시스템' },
];

const tagColors = { '미팅': 'badge-blue', '발송': 'badge-emerald', '리서치': 'badge-violet', '회의': 'badge-amber', '리뷰': 'badge-slate', '점검': 'badge-rose' };

function renderTodos() {
  const list = document.getElementById('todoList');
  // DEMO_TODOS는 로컬 상수 (t.text / t.tag / t.source 모두 정적). 향후 server
  // 데이터로 바꿀 때 세 필드 모두 escapeHtml 필요.
  list.innerHTML = DEMO_TODOS.map((t, i) => {
    const priColor = t.priority === 'high' ? 'rose' : t.priority === 'med' ? 'amber' : 'slate';
    return `
      <li class="flex items-start gap-2.5 p-2.5 rounded-lg ${t.done ? 'bg-slate-50/60' : 'hover:bg-blue-50/50'} cursor-pointer transition-colors" onclick="toggleTodo(${i})">
        <button class="w-4 h-4 rounded border-2 mt-0.5 ${t.done ? 'border-blue-500 bg-blue-500' : 'border-slate-300'} flex items-center justify-center shrink-0">
          ${t.done ? '<svg width="9" height="9" fill="none" stroke="white" stroke-width="3.5" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>' : ''}
        </button>
        <div class="flex-1 min-w-0">
          <div class="text-[.82rem] ${t.done ? 'line-through text-slate-400' : 'text-slate-800 font-medium'} leading-snug">${t.text}</div>
          <div class="flex items-center gap-1.5 mt-1 flex-wrap">
            <span class="badge ${tagColors[t.tag] || 'badge-slate'}">${t.tag}</span>
            <span class="text-[.62rem] text-slate-400">${t.source}</span>
          </div>
        </div>
        <span class="w-1 h-full rounded-full bg-${priColor}-400 shrink-0 self-stretch"></span>
      </li>
    `;
  }).join('');
  const done = DEMO_TODOS.filter(t => t.done).length;
  document.getElementById('todoDone').textContent = done;
  document.getElementById('todoTotal').textContent = DEMO_TODOS.length;
  document.getElementById('todoDoneTop').textContent = done;
}

function toggleTodo(i) {
  DEMO_TODOS[i].done = !DEMO_TODOS[i].done;
  renderTodos();
}
window.toggleTodo = toggleTodo;

/* ──────── Modal ──────── */
function openSettings() { document.getElementById('settingsModal').classList.add('show'); }
function closeSettings() { document.getElementById('settingsModal').classList.remove('show'); }
function saveSettings() {
  closeSettings();
  // Step 8 — 저장하는 backend가 없으므로 demo 임을 명시.
  showToast('✓ 데모 설정이 저장되었습니다 (브라우저 메모리)');
}
function showToast(text) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.classList.remove('opacity-0'); t.classList.add('opacity-100');
  setTimeout(() => { t.classList.remove('opacity-100'); t.classList.add('opacity-0'); }, 2400);
}
window.openSettings = openSettings; window.closeSettings = closeSettings;
window.saveSettings = saveSettings; window.addKeyword = addKeyword; window.addCompetitor = addCompetitor;
window.removeKeyword = removeKeyword; window.removeCompetitor = removeCompetitor;

/* ──────── "지금 갱신" demo button ──────── */
function refreshDailyDemo() {
  // backend가 없으므로 실제 refresh는 없다. demo임을 toast로 표시.
  showToast('이 화면은 demo 데이터입니다 (실제 갱신 backend 없음)');
}
window.refreshDailyDemo = refreshDailyDemo;

/* ──────── Export / Download ──────── */
function toggleDownloadMenu(e) {
  if (e) e.stopPropagation();
  document.getElementById('dlMenu').classList.toggle('hidden');
}
document.addEventListener('click', e => {
  const wrap = document.getElementById('dlWrap');
  if (wrap && !wrap.contains(e.target)) document.getElementById('dlMenu').classList.add('hidden');
});

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function fileBaseName() {
  return `Kloser_오늘의일_${todayStr()}`;
}

// Phase 7 Step 8 — export helpers serialise the current demo screen into
// HTML/PDF/Word/Excel/PPT. user-typed keywords/competitors flow into the
// HTML and DOC outputs via template literals; escape them so the export
// is XSS-safe even if the user later opens the file in a browser.

// ── 1. HTML 다운로드 ──
function dlHtml() {
  document.getElementById('dlMenu').classList.add('hidden');
  const date = todayStr();
  const kwList = keywords.map(k => `<span class="kw">${escapeHtml(k)}</span>`).join('');
  const trendsHtml = DEMO_TRENDS.map(t => `
    <tr>
      <td>${t.kw}</td>
      <td class="num">${t.volume.toLocaleString()}</td>
      <td class="num ${t.dir==='up'?'up':'down'}">${t.dir==='up'?'↑':'↓'} ${Math.abs(t.change)}%</td>
      <td>${t.desc}</td>
    </tr>`).join('');
  const todosHtml = DEMO_TODOS.map(t => `<li class="${t.done?'done':''}"><span class="pri pri-${t.priority}"></span>${t.text}<span class="src">[${t.tag} · ${t.source}]</span></li>`).join('');
  const exportCompetitors = [
    { name:'NexusAI', tag:'신규 기능 출시', desc:'실시간 통화 분석에 감정 분석 기능 추가. 기존 고객 무료 업그레이드 발표.' },
    { name:'OrbitSales', tag:'가격 인하', desc:'Pro 플랜 월 89,000원 → 69,000원으로 인하. 초기 셋팅 비용 면제.' },
    { name:'TalkSphere', tag:'투자 유치', desc:'시리즈 B 200억 투자 유치. AI 통화 분석 시장 공격적 확장.' },
    { name:'GongChat', tag:'파트너십', desc:'HubSpot과 공식 파트너십 발표 — 기본 통합 제공 예정.' },
  ];
  const cpHtml = exportCompetitors.map(c => `<li><b>${c.name}</b> <span class="tag">${c.tag}</span><br><span>${c.desc}</span></li>`).join('');

  const html = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"/><title>Kloser 오늘의 일 — ${date}</title>
<link href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css" rel="stylesheet">
<style>
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:'Pretendard',system-ui,sans-serif; color:#1e293b; background:#f8fafc; padding:32px 24px; line-height:1.5; -webkit-font-smoothing:antialiased; }
.wrap { max-width: 980px; margin:0 auto; }
header { border-bottom:2px solid #2563eb; padding-bottom:16px; margin-bottom:24px; }
h1 { font-size:1.75rem; font-weight:900; letter-spacing:-.04em; }
h1 span { color:#2563eb; }
.meta { color:#64748b; font-size:.85rem; margin-top:6px; }
section { background:white; border:1px solid #e2e8f0; border-radius:14px; padding:20px 24px; margin-bottom:18px; }
h2 { font-size:1.05rem; font-weight:900; margin-bottom:12px; letter-spacing:-.03em; }
.kpi { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:18px; }
.kpi > div { background:white; border:1px solid #e2e8f0; border-radius:12px; padding:14px; }
.kpi small { color:#64748b; font-size:.7rem; font-weight:700; text-transform:uppercase; letter-spacing:.06em; }
.kpi .v { font-size:1.4rem; font-weight:900; margin-top:4px; }
.kw { display:inline-block; padding:5px 11px; margin:2px; border-radius:999px; background:#eff6ff; color:#1d4ed8; border:1px solid #bfdbfe; font-size:.78rem; font-weight:600; }
table { width:100%; border-collapse:collapse; }
th, td { padding:8px 10px; text-align:left; font-size:.85rem; border-bottom:1px solid #f1f5f9; }
th { background:#f8fafc; font-size:.7rem; font-weight:700; color:#64748b; text-transform:uppercase; letter-spacing:.04em; }
td.num { text-align:right; font-variant-numeric:tabular-nums; }
td.up { color:#059669; font-weight:700; } td.down { color:#dc2626; font-weight:700; }
ul.todo { list-style:none; }
ul.todo li { padding:9px 0; border-bottom:1px solid #f1f5f9; display:flex; align-items:center; gap:10px; }
ul.todo li.done { color:#94a3b8; text-decoration:line-through; }
.pri { width:6px; height:18px; border-radius:3px; flex-shrink:0; }
.pri-high { background:#f87171; } .pri-med { background:#fbbf24; } .pri-low { background:#cbd5e1; }
.src { color:#94a3b8; font-size:.72rem; margin-left:auto; }
ul.cp { list-style:none; }
ul.cp li { padding:12px 0; border-bottom:1px solid #f1f5f9; }
ul.cp .tag { background:#fee2e2; color:#dc2626; padding:2px 7px; border-radius:5px; font-size:.7rem; font-weight:700; margin-left:6px; }
footer { text-align:center; color:#94a3b8; font-size:.72rem; margin-top:24px; padding-top:16px; border-top:1px solid #e2e8f0; }
.demo-note { background:#fef9c3; color:#854d0e; padding:8px 12px; border-radius:6px; font-size:.72rem; font-weight:700; margin-bottom:16px; text-align:center; }
</style></head><body><div class="wrap">
<header><h1>오늘의 일 <span>· Kloser</span></h1>
<div class="meta">${date} · ${new Date().toLocaleString('ko-KR')} 기준 (demo)</div></header>

<div class="demo-note">⚠ 이 문서는 demo 데이터로 생성되었습니다. 실 운영 데이터로 교체되기 전까지 참고용으로만 사용하세요.</div>

<div class="kpi">
  <div><small>신규 키워드</small><div class="v">128</div></div>
  <div><small>상승 트렌드</small><div class="v" style="color:#059669">+23</div></div>
  <div><small>추천 To-Do</small><div class="v" style="color:#2563eb">${DEMO_TODOS.length}</div></div>
  <div><small>긴급 알림</small><div class="v" style="color:#dc2626">3</div></div>
</div>

<section><h2>모니터링 관심사 (${keywords.length}개)</h2>${kwList}</section>

<section><h2>시장 트렌드 알림 (demo)</h2>
<table><thead><tr><th>키워드</th><th class="num" style="text-align:right">검색량/일</th><th class="num" style="text-align:right">변화율(7일)</th><th>비고</th></tr></thead>
<tbody>${trendsHtml}</tbody></table></section>

<section><h2>오늘의 추천 To-Do (${DEMO_TODOS.filter(t=>t.done).length}/${DEMO_TODOS.length}) (demo)</h2>
<ul class="todo">${todosHtml}</ul></section>

<section><h2>경쟁사 동향 (demo)</h2>
<ul class="cp">${cpHtml}</ul></section>

<footer>Kloser 오늘의 일 demo export · ${new Date().toLocaleString('ko-KR')}</footer>
</div></body></html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  triggerDownload(blob, fileBaseName() + '.html');
}

// ── 2. PDF 다운로드 (html2canvas + jsPDF) ──
async function dlPdf() {
  document.getElementById('dlMenu').classList.add('hidden');
  showToast('PDF 생성 중...');
  try {
    const main = document.querySelector('main');
    const canvas = await html2canvas(main, { scale: 2, backgroundColor: '#f8fafc', useCORS: true, logging: false });
    const imgData = canvas.toDataURL('image/png');
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageWidth = 210, pageHeight = 297;
    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;

    if (imgHeight <= pageHeight) {
      pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, imgHeight);
    } else {
      let position = 0;
      let heightLeft = imgHeight;
      while (heightLeft > 0) {
        pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
        position -= pageHeight;
        if (heightLeft > 0) pdf.addPage();
      }
    }
    pdf.save(fileBaseName() + '.pdf');
    showToast('✓ PDF 다운로드 완료 (demo)');
  } catch (err) {
    console.error(err);
    showToast('⚠ PDF 생성 실패');
  }
}

// ── 3. Word 다운로드 (html-docx-js) ──
function dlWord() {
  document.getElementById('dlMenu').classList.add('hidden');
  const date = todayStr();
  const cps = [
    { name: 'NexusAI', tag: '신규 기능 출시', when: '2시간 전', desc: '실시간 통화 분석에 감정 분석 기능 추가. 기존 고객 무료 업그레이드 발표.' },
    { name: 'OrbitSales', tag: '가격 인하', when: '5시간 전', desc: 'Pro 플랜 월 89,000원 → 69,000원으로 인하. 초기 셋팅 비용 면제.' },
    { name: 'TalkSphere', tag: '투자 유치', when: '어제', desc: '시리즈 B 200억 투자 유치. AI 통화 분석 시장 공격적 확장 예고.' },
    { name: 'GongChat', tag: '파트너십', when: '2일 전', desc: 'HubSpot과 공식 파트너십 발표 — 기본 통합 제공 예정.' },
  ];
  const weekly = [
    ['B2B SaaS 도입', 8200, 9100, 9800, 10500, 11200, 11800, 12400, '+42%'],
    ['AI 콜센터', 6400, 6900, 7200, 7800, 8100, 8500, 8900, '+28%'],
    ['통화 분석', 3800, 4100, 4000, 4300, 4500, 4400, 4500, '+15%'],
    ['CRM 통합', 2400, 2300, 2200, 2200, 2100, 2100, 2100, '-6%'],
    ['영업 자동화', 5200, 5400, 5500, 5600, 5700, 5700, 5800, '+11%'],
    ['HubSpot', 14200, 14100, 14300, 14500, 14400, 14600, 14700, '+4%'],
    ['Salesforce', 21500, 21700, 21600, 22000, 21900, 22100, 22300, '+4%'],
  ];

  const trendsRows = DEMO_TRENDS.map(t => `<tr>
    <td><b>${t.kw}</b></td>
    <td style="text-align:right">${t.volume.toLocaleString()}</td>
    <td style="text-align:right;color:${t.dir==='up'?'#059669':'#dc2626'}"><b>${t.dir==='up'?'↑':'↓'} ${Math.abs(t.change)}%</b></td>
    <td>${t.desc}</td>
  </tr>`).join('');

  const todoRows = DEMO_TODOS.map((t, i) => `<tr>
    <td style="text-align:center">${t.done ? '✓' : ''}</td>
    <td style="text-align:center"><b>${i + 1}</b></td>
    <td style="color:${t.priority==='high'?'#dc2626':t.priority==='med'?'#d97706':'#64748b'}"><b>${t.priority==='high'?'높음':t.priority==='med'?'중간':'낮음'}</b></td>
    <td>${t.text}</td>
    <td>${t.tag}</td>
    <td>${t.source}</td>
  </tr>`).join('');

  const weeklyRows = weekly.map(r => `<tr>
    <td><b>${r[0]}</b></td>
    ${r.slice(1, 8).map(v => `<td style="text-align:right">${v.toLocaleString()}</td>`).join('')}
    <td style="text-align:right;color:${String(r[8]).startsWith('+')?'#059669':'#dc2626'}"><b>${r[8]}</b></td>
  </tr>`).join('');

  const cpRows = cps.map(c => `<tr>
    <td><b>${c.name}</b></td>
    <td>${c.tag}</td>
    <td>${c.when}</td>
    <td>${c.desc}</td>
  </tr>`).join('');

  const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="UTF-8">
<title>Kloser 오늘의 일 — ${date} (demo)</title>
<style>
@page { size: A4; margin: 2cm 2cm 2cm 2cm; }
body { font-family: 맑은 고딕, '맑은 고딕', 'Malgun Gothic', sans-serif; color: #1e293b; font-size: 11pt; line-height: 1.5; }
h1 { color: #2563eb; font-size: 22pt; margin: 0 0 4pt 0; }
h2 { color: #0f172a; font-size: 14pt; margin: 18pt 0 8pt 0; padding-bottom: 4pt; border-bottom: 2pt solid #2563eb; }
h3 { color: #0f172a; font-size: 12pt; margin: 14pt 0 6pt 0; }
.meta { color: #64748b; font-size: 9pt; margin-bottom: 14pt; }
.demo-note { background: #fef9c3; color: #854d0e; padding: 6pt 10pt; border-radius: 4pt; font-size: 9pt; font-weight: bold; margin-bottom: 12pt; }
.kpi { width: 100%; border-collapse: collapse; margin: 10pt 0 18pt 0; }
.kpi td { border: 0.5pt solid #cbd5e1; padding: 10pt; width: 25%; text-align: center; }
.kpi .label { color: #64748b; font-size: 8pt; font-weight: bold; text-transform: uppercase; }
.kpi .value { font-size: 18pt; font-weight: bold; margin-top: 4pt; }
table.data { width: 100%; border-collapse: collapse; margin: 6pt 0 14pt 0; }
table.data th { background: #f1f5f9; color: #334155; font-weight: bold; font-size: 9pt; padding: 8pt; text-align: left; border-bottom: 1pt solid #cbd5e1; }
table.data td { padding: 7pt 8pt; border-bottom: 0.5pt solid #e2e8f0; font-size: 10pt; vertical-align: top; }
.kw { display: inline-block; padding: 3pt 8pt; margin: 2pt; border: 0.5pt solid #93c5fd; background: #eff6ff; color: #1d4ed8; border-radius: 6pt; font-size: 9pt; font-weight: bold; }
.footer { color: #94a3b8; font-size: 8pt; text-align: center; margin-top: 24pt; padding-top: 8pt; border-top: 0.5pt solid #e2e8f0; }
</style></head><body>

<h1>오늘의 일 · Kloser</h1>
<div class="meta">${date} · ${new Date().toLocaleString('ko-KR')} 기준 (demo)</div>

<div class="demo-note">⚠ 이 문서는 demo 데이터입니다. 실 운영 데이터로 교체되기 전까지 참고용으로만 사용하세요.</div>

<table class="kpi"><tr>
  <td><div class="label">신규 키워드</div><div class="value">128</div></td>
  <td><div class="label">상승 트렌드</div><div class="value" style="color:#059669">+23</div></td>
  <td><div class="label">추천 To-Do</div><div class="value" style="color:#2563eb">${DEMO_TODOS.length}</div></td>
  <td><div class="label">긴급 알림</div><div class="value" style="color:#dc2626">3</div></td>
</tr></table>

<h2>모니터링 관심사 (${keywords.length}개)</h2>
<p>${keywords.map(k => `<span class="kw">${escapeHtml(k)}</span>`).join(' ')}</p>

<h2>시장 트렌드 알림 (지난 7일, demo)</h2>
<table class="data">
<thead><tr><th>키워드</th><th style="text-align:right">검색량/일</th><th style="text-align:right">변화율</th><th>비고</th></tr></thead>
<tbody>${trendsRows}</tbody></table>

<h2>최근 7일 검색량 변화 (demo)</h2>
<table class="data">
<thead><tr><th>키워드</th><th style="text-align:right">월</th><th style="text-align:right">화</th><th style="text-align:right">수</th><th style="text-align:right">목</th><th style="text-align:right">금</th><th style="text-align:right">토</th><th style="text-align:right">일</th><th style="text-align:right">변화율</th></tr></thead>
<tbody>${weeklyRows}</tbody></table>

<h2>오늘의 추천 To-Do (${DEMO_TODOS.filter(t=>t.done).length} / ${DEMO_TODOS.length} 완료, demo)</h2>
<table class="data">
<thead><tr><th style="width:8%">완료</th><th style="width:6%">#</th><th style="width:10%">우선순위</th><th>내용</th><th style="width:10%">태그</th><th style="width:14%">출처</th></tr></thead>
<tbody>${todoRows}</tbody></table>

<h2>경쟁사 동향 (demo)</h2>
<table class="data">
<thead><tr><th style="width:14%">경쟁사</th><th style="width:14%">카테고리</th><th style="width:10%">시점</th><th>내용</th></tr></thead>
<tbody>${cpRows}</tbody></table>

<div class="footer">Kloser 오늘의 일 demo export · ${new Date().toLocaleString('ko-KR')}</div>

</body></html>`;

  try {
    const blob = window.htmlDocx.asBlob(html, { orientation: 'portrait', margins: { top: 720, right: 720, bottom: 720, left: 720 } });
    triggerDownload(blob, fileBaseName() + '.docx');
    showToast('✓ Word 다운로드 완료 (demo)');
  } catch (err) {
    console.error(err);
    // Fallback: simple .doc with msword MIME
    const fallback = new Blob(['﻿' + html], { type: 'application/msword' });
    triggerDownload(fallback, fileBaseName() + '.doc');
    showToast('✓ Word(.doc) 다운로드 완료 (demo)');
  }
}

// ── 4. Excel 다운로드 (SheetJS) ──
function dlExcel() {
  document.getElementById('dlMenu').classList.add('hidden');
  const wb = XLSX.utils.book_new();

  // Sheet 1: Summary
  const summary = [
    ['Kloser 오늘의 일 보고서 (demo)'],
    ['생성일', new Date().toLocaleString('ko-KR')],
    ['데이터 출처', 'demo · 실 backend 미연결'],
    [],
    ['항목', '값'],
    ['신규 키워드', 128],
    ['상승 트렌드', 23],
    ['추천 To-Do', DEMO_TODOS.length],
    ['긴급 알림', 3],
    [],
    ['모니터링 키워드', keywords.length + '개'],
    ['등록 키워드', keywords.join(', ')],
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(summary);
  wsSummary['!cols'] = [{ wch: 18 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, '요약');

  // Sheet 2: Trends
  const trendsAOA = [['키워드', '검색량/일', '변화율(7일)', '방향', '비고']];
  DEMO_TRENDS.forEach(t => trendsAOA.push([t.kw, t.volume, Math.abs(t.change) + '%', t.dir === 'up' ? '상승' : '하락', t.desc]));
  const wsTrends = XLSX.utils.aoa_to_sheet(trendsAOA);
  wsTrends['!cols'] = [{ wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, wsTrends, '시장 트렌드');

  // Sheet 3: Weekly trend
  const weekly = [
    ['키워드', '월', '화', '수', '목', '금', '토', '일', '변화율'],
    ['B2B SaaS 도입', 8200, 9100, 9800, 10500, 11200, 11800, 12400, '+42%'],
    ['AI 콜센터', 6400, 6900, 7200, 7800, 8100, 8500, 8900, '+28%'],
    ['통화 분석', 3800, 4100, 4000, 4300, 4500, 4400, 4500, '+15%'],
    ['CRM 통합', 2400, 2300, 2200, 2200, 2100, 2100, 2100, '-6%'],
    ['영업 자동화', 5200, 5400, 5500, 5600, 5700, 5700, 5800, '+11%'],
    ['HubSpot', 14200, 14100, 14300, 14500, 14400, 14600, 14700, '+4%'],
    ['Salesforce', 21500, 21700, 21600, 22000, 21900, 22100, 22300, '+4%'],
  ];
  const wsWeekly = XLSX.utils.aoa_to_sheet(weekly);
  wsWeekly['!cols'] = [{ wch: 20 }, ...Array(7).fill({ wch: 9 }), { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsWeekly, '주간 트렌드');

  // Sheet 4: To-Do
  const todoAOA = [['#', '완료', '우선순위', '내용', '태그', '출처']];
  DEMO_TODOS.forEach((t, i) => todoAOA.push([i + 1, t.done ? '✓' : '', t.priority === 'high' ? '높음' : t.priority === 'med' ? '중간' : '낮음', t.text, t.tag, t.source]));
  const wsTodo = XLSX.utils.aoa_to_sheet(todoAOA);
  wsTodo['!cols'] = [{ wch: 4 }, { wch: 6 }, { wch: 10 }, { wch: 50 }, { wch: 10 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, wsTodo, 'To-Do');

  // Sheet 5: Competitors
  const cp = [
    ['경쟁사', '카테고리', '시점', '내용'],
    ['NexusAI', '신규 기능 출시', '2시간 전', '실시간 통화 분석에 감정 분석 기능 추가. 기존 고객 무료 업그레이드 발표.'],
    ['OrbitSales', '가격 인하', '5시간 전', 'Pro 플랜 월 89,000원 → 69,000원으로 인하. 초기 셋팅 비용 면제 행사.'],
    ['TalkSphere', '투자 유치', '어제', '시리즈 B 200억 투자 유치. AI 통화 분석 시장 공격적 확장 예고.'],
    ['GongChat', '파트너십', '2일 전', 'HubSpot과 공식 파트너십 발표 — 기본 통합 제공 예정.'],
  ];
  const wsCp = XLSX.utils.aoa_to_sheet(cp);
  wsCp['!cols'] = [{ wch: 14 }, { wch: 16 }, { wch: 10 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, wsCp, '경쟁사 동향');

  XLSX.writeFile(wb, fileBaseName() + '.xlsx');
  showToast('✓ Excel 다운로드 완료 (demo)');
}

// ── 5. PPT 다운로드 (PptxGenJS) ──
function dlPpt() {
  document.getElementById('dlMenu').classList.add('hidden');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5"
  pptx.title = 'Kloser 오늘의 일 (demo)';

  const C = { primary: '2563EB', text: '0F172A', sub: '64748B', bg: 'F8FAFC', emerald: '059669', rose: 'DC2626', amber: 'D97706' };

  // Slide 1: Title
  let s = pptx.addSlide();
  s.background = { color: 'FFFFFF' };
  s.addText('Kloser', { x: 0.6, y: 0.6, w: 4, h: 0.5, fontSize: 16, bold: true, color: C.primary, fontFace: 'Pretendard' });
  s.addText('오늘의 일 (demo)', { x: 0.6, y: 2.4, w: 12, h: 1.2, fontSize: 56, bold: true, color: C.text, fontFace: 'Pretendard' });
  s.addText('시장 트렌드 · 추천 To-Do · 경쟁사 동향', { x: 0.6, y: 3.8, w: 12, h: 0.5, fontSize: 22, color: C.sub, fontFace: 'Pretendard' });
  s.addText(`${todayStr()} · 데이터는 demo`, { x: 0.6, y: 6.6, w: 12, h: 0.4, fontSize: 14, color: C.sub, fontFace: 'Pretendard' });
  s.addShape(pptx.ShapeType.line, { x: 0.6, y: 5.8, w: 4, h: 0, line: { color: C.primary, width: 3 } });

  // Slide 2: KPI
  s = pptx.addSlide();
  s.background = { color: C.bg };
  s.addText('오늘의 핵심 지표 (demo)', { x: 0.6, y: 0.4, w: 12, h: 0.5, fontSize: 24, bold: true, color: C.text, fontFace: 'Pretendard' });
  const kpis = [
    { label: '신규 키워드', value: '128', color: C.text },
    { label: '상승 트렌드', value: '+23', color: C.emerald },
    { label: '추천 To-Do', value: String(DEMO_TODOS.length), color: C.primary },
    { label: '긴급 알림', value: '3', color: C.rose },
  ];
  kpis.forEach((k, i) => {
    const x = 0.6 + i * 3.05;
    s.addShape(pptx.ShapeType.rect, { x, y: 1.6, w: 2.85, h: 2.4, fill: { color: 'FFFFFF' }, line: { color: 'E2E8F0', width: 1 }, rectRadius: 0.15 });
    s.addText(k.label, { x: x + 0.2, y: 1.85, w: 2.4, h: 0.4, fontSize: 11, bold: true, color: C.sub, fontFace: 'Pretendard' });
    s.addText(k.value, { x: x + 0.2, y: 2.4, w: 2.4, h: 1.2, fontSize: 44, bold: true, color: k.color, fontFace: 'Pretendard' });
  });

  // Slide 3: Trends
  s = pptx.addSlide();
  s.background = { color: 'FFFFFF' };
  s.addText('시장 트렌드 알림 (지난 7일, demo)', { x: 0.6, y: 0.4, w: 12, h: 0.5, fontSize: 24, bold: true, color: C.text, fontFace: 'Pretendard' });
  const tRows = [['키워드', '검색량/일', '변화율', '비고'], ...DEMO_TRENDS.map(t => [t.kw, t.volume.toLocaleString(), (t.dir === 'up' ? '↑ ' : '↓ ') + Math.abs(t.change) + '%', t.desc])];
  s.addTable(tRows, {
    x: 0.6, y: 1.3, w: 12.1, h: 5,
    colW: [3, 1.6, 1.5, 6],
    fontFace: 'Pretendard', fontSize: 12,
    border: { type: 'solid', color: 'E2E8F0', pt: 0.5 },
    rowH: 0.5,
  });

  // Slide 4: To-Do
  s = pptx.addSlide();
  s.background = { color: 'FFFFFF' };
  s.addText('오늘의 추천 To-Do (demo)', { x: 0.6, y: 0.4, w: 12, h: 0.5, fontSize: 24, bold: true, color: C.text, fontFace: 'Pretendard' });
  DEMO_TODOS.forEach((t, i) => {
    const y = 1.3 + i * 0.6;
    if (y > 6.8) return;
    const priColor = t.priority === 'high' ? C.rose : t.priority === 'med' ? C.amber : 'CBD5E1';
    s.addShape(pptx.ShapeType.rect, { x: 0.6, y, w: 0.12, h: 0.45, fill: { color: priColor } });
    s.addText(`${i + 1}. ${t.text}`, { x: 0.9, y, w: 9, h: 0.45, fontSize: 14, color: C.text, fontFace: 'Pretendard', valign: 'middle' });
    s.addText(`[${t.tag}] ${t.source}`, { x: 10, y, w: 2.7, h: 0.45, fontSize: 11, color: C.sub, fontFace: 'Pretendard', align: 'right', valign: 'middle' });
  });

  // Slide 5: Competitors
  s = pptx.addSlide();
  s.background = { color: 'FFFFFF' };
  s.addText('경쟁사 동향 (demo)', { x: 0.6, y: 0.4, w: 12, h: 0.5, fontSize: 24, bold: true, color: C.text, fontFace: 'Pretendard' });
  const cps = [
    { name: 'NexusAI', tag: '신규 기능 출시', desc: '실시간 통화 분석에 감정 분석 기능 추가. 기존 고객 무료 업그레이드 발표.', when: '2시간 전' },
    { name: 'OrbitSales', tag: '가격 인하', desc: 'Pro 플랜 월 89,000원 → 69,000원으로 인하. 초기 셋팅 비용 면제.', when: '5시간 전' },
    { name: 'TalkSphere', tag: '투자 유치', desc: '시리즈 B 200억 투자 유치. AI 통화 분석 시장 공격적 확장 예고.', when: '어제' },
    { name: 'GongChat', tag: '파트너십', desc: 'HubSpot과 공식 파트너십 발표 — 기본 통합 제공 예정.', when: '2일 전' },
  ];
  cps.forEach((c, i) => {
    const y = 1.3 + i * 1.4;
    s.addShape(pptx.ShapeType.rect, { x: 0.6, y, w: 12.1, h: 1.2, fill: { color: 'F8FAFC' }, line: { color: 'E2E8F0', width: 0.5 }, rectRadius: 0.1 });
    s.addText(c.name, { x: 0.85, y: y + 0.1, w: 3, h: 0.35, fontSize: 16, bold: true, color: C.text, fontFace: 'Pretendard' });
    s.addText(c.tag, { x: 3.5, y: y + 0.15, w: 2, h: 0.3, fontSize: 11, bold: true, color: C.rose, fontFace: 'Pretendard' });
    s.addText(c.when, { x: 11, y: y + 0.15, w: 1.6, h: 0.3, fontSize: 10, color: C.sub, fontFace: 'Pretendard', align: 'right' });
    s.addText(c.desc, { x: 0.85, y: y + 0.55, w: 11.6, h: 0.55, fontSize: 12, color: C.text, fontFace: 'Pretendard' });
  });

  // Slide 6: Closing
  s = pptx.addSlide();
  s.background = { color: '0F172A' };
  s.addText('실 백엔드 연결 시점에\n오늘의 일이 실시간 데이터로 채워집니다', { x: 0.6, y: 2.8, w: 12, h: 1.6, fontSize: 32, bold: true, color: 'FFFFFF', fontFace: 'Pretendard' });
  s.addText('Kloser · AI Sales Assistant (demo export)', { x: 0.6, y: 6.5, w: 12, h: 0.5, fontSize: 14, color: '94A3B8', fontFace: 'Pretendard' });

  pptx.writeFile({ fileName: fileBaseName() + '.pptx' });
  showToast('✓ PowerPoint 다운로드 완료 (demo)');
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
  showToast('✓ ' + filename + ' 다운로드 (demo)');
}

window.toggleDownloadMenu = toggleDownloadMenu;
window.dlHtml = dlHtml; window.dlPdf = dlPdf; window.dlWord = dlWord; window.dlExcel = dlExcel; window.dlPpt = dlPpt;

// Initial render
renderKeywords();
renderCompetitors();
renderTrends();
renderTodos();
