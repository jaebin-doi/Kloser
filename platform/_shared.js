/* Kloser Platform - Shared Sidebar Renderer */

const SIDEBAR_HTML = `
<aside id="sidebar" class="sidebar w-[232px] h-full bg-white border-r border-slate-200 flex flex-col flex-shrink-0">
  <div class="h-[60px] px-5 flex items-center border-b border-slate-100">
    <a href="../index.html" class="flex items-center gap-2.5 no-underline">
      <img src="../assets/logo.png" alt="Kloser" class="h-5 w-auto" />
      <span class="px-1.5 py-0.5 rounded text-[.55rem] font-black text-blue-600 bg-blue-50 tracking-wider">DEMO</span>
    </a>
  </div>

  <div class="border-b border-slate-100">
    <button class="w-full flex items-center gap-2.5 px-5 py-2.5">
      <div class="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center text-[.65rem] font-black text-white shadow-sm shrink-0">K</div>
      <div class="flex-1 text-left min-w-0">
        <div class="text-[.78rem] font-bold text-slate-800 truncate">Kloser Inc.</div>
        <div class="text-[.62rem] text-slate-400 truncate">Pro · 14명</div>
      </div>
    </button>
  </div>

  <nav class="flex-1 px-3 pt-3 pb-3 overflow-y-auto scroll-area">
    <div class="text-[.6rem] font-black tracking-[.18em] uppercase text-slate-400 px-3 mt-1 mb-2">메인</div>
    <a href="dashboard.html" data-page="dashboard" class="nav-item">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
      대시보드
    </a>
    <a href="live.html" data-page="live" class="nav-item">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.33 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
      실시간 통화
      <span class="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[.55rem] font-black">
        <span class="w-1 h-1 rounded-full bg-emerald-500"></span>LIVE
      </span>
    </a>
    <a href="calls.html" data-page="calls" class="nav-item">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      통화 기록
      <span class="ml-auto text-[.62rem] text-slate-400 tnum">1,243</span>
    </a>
    <a href="daily.html" data-page="daily" class="nav-item">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
      오늘의 일
      <span class="ml-auto text-[.62rem] text-slate-400 tnum">17</span>
    </a>
    <a href="customers.html" data-page="customers" class="nav-item">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      고객
      <span class="ml-auto text-[.62rem] text-slate-400 tnum">2,486</span>
    </a>
    <a href="newsletter.html" data-page="newsletter" class="nav-item">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="m22 6-10 7L2 6"/></svg>
      뉴스레터
    </a>

    <div class="text-[.6rem] font-black tracking-[.18em] uppercase text-slate-400 px-3 mt-5 mb-2">조직</div>
    <a href="team.html" data-page="team" class="nav-item">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      팀 & 계정
    </a>
    <a href="settings.html" data-page="settings" class="nav-item">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      설정
    </a>
  </nav>

  <div class="border-t border-slate-100 p-2">
    <button class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg">
      <div class="w-9 h-9 rounded-full bg-gradient-to-br from-emerald-500 to-blue-500 flex items-center justify-center text-[.78rem] font-black text-white shrink-0">김</div>
      <div class="flex-1 text-left min-w-0">
        <div class="text-[.85rem] font-bold text-slate-800 truncate">김민수</div>
        <div class="text-[.65rem] text-slate-500 truncate">영업1팀 · 대리</div>
      </div>
    </button>
  </div>
</aside>
<div id="sidebarOverlay" class="sidebar-overlay" onclick="toggleSidebar()"></div>
`;

function renderSidebar(activePage) {
  document.getElementById('sidebarSlot').innerHTML = SIDEBAR_HTML;
  if (activePage) {
    const el = document.querySelector(`.nav-item[data-page="${activePage}"]`);
    if (el) el.classList.add('active');
  }
}

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('sidebarOverlay');
  sb.classList.toggle('open');
  ov.classList.toggle('show');
}

/* ─────────────────────────────────────────────
   Notification panel (used in topbars)
───────────────────────────────────────────── */
const NOTIF_DATA = [
  { id: 1, type: 'call', read: false, title: '통화 #2026-1453 요약 완료', desc: 'Kloser Inc. 김민수 · CRM 통합 검토 · 다음 액션 3건', time: '5분 전', icon: 'call', tone: 'blue' },
  { id: 2, type: 'alert', read: false, title: '경쟁사 NexusAI — 긴급 알림', desc: '신규 감정 분석 기능 출시. 기존 고객 무료 업그레이드 발표.', time: '2시간 전', icon: 'alert', tone: 'rose' },
  { id: 3, type: 'todo', read: false, title: '오늘의 To-Do 17개 갱신됨', desc: 'AI가 시장 트렌드와 통화 기록 기반으로 우선순위 정렬', time: '오늘 06:00', icon: 'sparkle', tone: 'emerald' },
  { id: 4, type: 'customer', read: true, title: '신규 고객 3명 추가됨', desc: '이지은님이 DesignCo. 외 2개 회사 추가', time: '어제', icon: 'user', tone: 'violet' },
  { id: 5, type: 'newsletter', read: true, title: '뉴스레터 "5월 업데이트" 발송 완료', desc: '수신자 1,245명 · 전달률 98.2%', time: '어제', icon: 'mail', tone: 'blue' },
  { id: 6, type: 'meeting', read: true, title: '5/8 데모 일정 확정', desc: 'Kloser Inc. 김민수님과 화상 미팅 (14:00)', time: '2일 전', icon: 'calendar', tone: 'amber' },
  { id: 7, type: 'system', read: true, title: 'Kloser 데스크톱 앱 v2.4.1 업데이트', desc: '버그 픽스 및 성능 개선 — 자동 적용됨', time: '3일 전', icon: 'info', tone: 'slate' },
];

const NOTIF_ICON = {
  call: '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.33 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  alert: '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01"/></svg>',
  sparkle: '<svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2 L14 9 L21 11 L14 13 L12 20 L10 13 L3 11 L10 9 Z"/></svg>',
  user: '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>',
  mail: '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="m22 6-10 7L2 6"/></svg>',
  calendar: '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  info: '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

const TONE_BG = {
  blue: 'bg-blue-100 text-blue-600',
  rose: 'bg-rose-100 text-rose-600',
  emerald: 'bg-emerald-100 text-emerald-600',
  violet: 'bg-violet-100 text-violet-600',
  amber: 'bg-amber-100 text-amber-600',
  slate: 'bg-slate-100 text-slate-600',
};

function renderNotification(notifBtnId) {
  const btn = document.getElementById(notifBtnId);
  if (!btn) return;

  // Wrap button so panel can be absolute-positioned next to it
  const wrap = document.createElement('div');
  wrap.className = 'relative';
  wrap.id = notifBtnId + 'Wrap';
  btn.parentNode.insertBefore(wrap, btn);
  wrap.appendChild(btn);

  // Build panel
  const panel = document.createElement('div');
  panel.id = notifBtnId + 'Panel';
  panel.className = 'hidden absolute right-0 top-full mt-2 w-[360px] rounded-xl border border-slate-200 bg-white shadow-[0_12px_40px_-8px_rgba(15,23,42,0.18)] overflow-hidden z-50';

  function unreadCount() { return NOTIF_DATA.filter(n => !n.read).length; }
  function dot() {
    const oldDot = btn.querySelector('.notif-dot');
    if (oldDot) oldDot.remove();
    if (unreadCount() > 0) {
      const d = document.createElement('span');
      d.className = 'notif-dot absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-rose-500 ring-2 ring-white';
      btn.appendChild(d);
      btn.style.position = 'relative';
    }
  }
  // Replace any existing static dot
  const existingDot = btn.querySelector('.absolute.top-1\\.5.right-1\\.5');
  if (existingDot) existingDot.remove();

  function renderItems() {
    const list = NOTIF_DATA.map(n => `
      <button class="notif-item w-full flex items-start gap-3 px-4 py-3 hover:bg-slate-50 text-left transition-colors ${n.read ? '' : 'bg-blue-50/30'}" data-id="${n.id}">
        <span class="w-9 h-9 rounded-lg ${TONE_BG[n.tone]} flex items-center justify-center shrink-0 mt-0.5">${NOTIF_ICON[n.icon]}</span>
        <div class="flex-1 min-w-0">
          <div class="flex items-start gap-2 mb-0.5">
            <div class="text-[.85rem] font-bold text-slate-800 ${n.read ? '' : ''}">${n.title}</div>
            ${n.read ? '' : '<span class="w-1.5 h-1.5 rounded-full bg-blue-500 mt-1.5 shrink-0"></span>'}
          </div>
          <div class="text-[.74rem] text-slate-500 leading-snug">${n.desc}</div>
          <div class="text-[.65rem] text-slate-400 mt-1">${n.time}</div>
        </div>
      </button>
    `).join('');
    panel.innerHTML = `
      <div class="px-4 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/40">
        <div>
          <div class="text-[.92rem] font-black text-slate-800">알림</div>
          <div class="text-[.65rem] text-slate-500"><b id="${notifBtnId}Unread">${unreadCount()}</b>건 읽지 않음</div>
        </div>
        <button id="${notifBtnId}MarkAll" class="text-[.7rem] font-bold text-blue-600 hover:underline">모두 읽음</button>
      </div>
      <div class="max-h-[420px] overflow-y-auto scroll-area divide-y divide-slate-100">${list}</div>
      <div class="px-4 py-2.5 border-t border-slate-100 text-center bg-slate-50/40">
        <button class="text-[.72rem] font-bold text-slate-600 hover:text-slate-900">알림 설정 →</button>
      </div>
    `;
    // Click to mark single read
    panel.querySelectorAll('.notif-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = parseInt(el.dataset.id);
        const n = NOTIF_DATA.find(x => x.id === id);
        if (n) { n.read = true; renderItems(); dot(); }
      });
    });
    // Mark all
    const ma = document.getElementById(notifBtnId + 'MarkAll');
    if (ma) ma.addEventListener('click', e => {
      e.stopPropagation();
      NOTIF_DATA.forEach(n => n.read = true);
      renderItems(); dot();
    });
  }

  wrap.appendChild(panel);
  renderItems();
  dot();

  // Toggle on button click
  btn.addEventListener('click', e => {
    e.stopPropagation();
    panel.classList.toggle('hidden');
  });
  // Close on outside click
  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) panel.classList.add('hidden');
  });
}
