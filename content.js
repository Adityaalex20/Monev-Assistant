/*
 * Monev Assistant v1.3
 * Copyright (c) 2026 @l3x.me. All rights reserved.
 *
 * Auto-fill laporan harian MagangHub Kemnaker dengan Gemini API.
 * Dilarang menjual, memodifikasi, atau mendistribusikan ulang
 * tanpa izin pemilik.
 */

// Content script — injected into monev.maganghub.kemnaker.go.id
// ponytail: adaptive selectors, pin exact ones after DOM inspection

// Idempotence guard: manifest + popup executeScript can inject this file twice into
// the same isolated world; a second run must be a no-op or top-level `let` redeclaration throws
if (!window.__blmLoaded) {
window.__blmLoaded = true;

/**
 * Find a textarea by searching for labels/headers containing the keyword.
 * Multi-strategy: label text → preceding text → placeholder → name/id.
 */
function findTextareaByKeyword(keyword) {
  // Strategy 1: label element containing keyword → associated textarea
  const labels = document.querySelectorAll('label');
  for (const label of labels) {
    const text = label.textContent.toLowerCase();
    if (text.includes(keyword)) {
      if (label.htmlFor) {
        const el = document.getElementById(label.htmlFor);
        if (el && el.tagName === 'TEXTAREA') return el;
      }
      const parent = label.closest('.form-group, .mb-3, .form-control, div');
      if (parent) {
        const ta = parent.querySelector('textarea');
        if (ta) return ta;
      }
    }
  }

  // Strategy 2: text nodes / headings / spans containing keyword
  const allElements = document.querySelectorAll('h1,h2,h3,h4,h5,h6,span,p,th,td,strong,b,div');
  for (const el of allElements) {
    if (el.children.length > 3) continue;
    const text = el.textContent.toLowerCase().trim();
    if (text.includes(keyword) && text.length < 100) {
      let container = el.closest('.form-group, .mb-3, .card-body, .col, div');
      if (container) {
        const ta = container.querySelector('textarea');
        if (ta) return ta;
      }
    }
  }

  // Strategy 3: textarea with matching placeholder/name/id
  const textareas = document.querySelectorAll('textarea');
  for (const ta of textareas) {
    const placeholder = (ta.placeholder || '').toLowerCase();
    const name = (ta.name || '').toLowerCase();
    const id = (ta.id || '').toLowerCase();
    if (placeholder.includes(keyword) || name.includes(keyword) || id.includes(keyword)) {
      return ta;
    }
  }

  return null;
}

/**
 * Fill a textarea and trigger events so the framework detects the change.
 */
function fillTextarea(textarea, value) {
  if (!textarea) return false;

  // Native setter to bypass React/Vue/Angular interceptors
  const nativeSet = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  )?.set;

  if (nativeSet) {
    nativeSet.call(textarea, value);
  } else {
    textarea.value = value;
  }

  // Dispatch events for framework detection
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
  textarea.dispatchEvent(new Event('blur', { bubbles: true }));
  textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
  textarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));

  return textarea.value === value;
}

/**
 * Fill the report form with generated data.
 */
function fillReport(data) {
  const uraianEl = findTextareaByKeyword('uraian') || findTextareaByKeyword('aktivitas');
  const pembelajaranEl = findTextareaByKeyword('pembelajaran');
  const kendalaEl = findTextareaByKeyword('kendala');

  if (!uraianEl && !pembelajaranEl && !kendalaEl) {
    return {
      success: false,
      filled: [false, false, false],
      error: 'Form laporan tidak ditemukan. Pastikan Anda membuka halaman tambah laporan.'
    };
  }

  const filled = [
    fillTextarea(uraianEl, data.uraian),
    fillTextarea(pembelajaranEl, data.pembelajaran),
    fillTextarea(kendalaEl, data.kendala)
  ];
  const allFilled = filled.every(Boolean);

  return {
    success: allFilled,
    filled,
    error: allFilled ? null : 'Beberapa kolom gagal diisi'
  };
}

// ---- Calendar day status (Riwayat Kehadiran) + day status card ----

function todayKey(date = new Date()) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

/** Today's status from the Riwayat Kehadiran calendar, e.g. "Belum Diisi" — aria-label is "<Hari>, <tanggal>, <status>". */
function todayCalendarStatus() {
  const label = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  return calendarStatusFor(label);
}

/** Status for one calendar cell — "<Hari>, <tanggal>, <status>" → status part after the second comma. */
function calendarStatusFor(dateLabel) {
  const needle = ', ' + dateLabel + ', ';
  for (const btn of document.querySelectorAll('button.calendar-day-button[aria-label]')) {
    const aria = btn.getAttribute('aria-label') || '';
    const at = aria.indexOf(needle);
    if (at >= 0) return aria.slice(at + needle.length).trim();
  }
  return null;
}

/**
 * Read every calendar cell the site renders (the grid spans one period, from the 10th
 * to the 9th of the next month) — aria-label is "<Hari>, <tanggal>, <status>".
 */
function readCalendarHistory() {
  const MONTHS = { januari: 0, februari: 1, maret: 2, april: 3, mei: 4, juni: 5, juli: 6, agustus: 7, september: 8, oktober: 9, november: 10, desember: 11 };
  const entries = {};
  for (const btn of document.querySelectorAll('button.calendar-day-button[aria-label]')) {
    const aria = btn.getAttribute('aria-label') || '';
    const m = aria.match(/,\s*(\d{1,2})\s+([^\s,]+)\s+(\d{4}),\s*(.+)$/);
    if (!m) continue;
    const month = MONTHS[m[2].toLowerCase()];
    if (month === undefined) continue;
    entries[m[3] + '-' + String(month + 1).padStart(2, '0') + '-' + m[1].padStart(2, '0')] = m[4].trim();
  }
  return entries;
}

function pillFor(status) {
  const s = String(status || '').toLowerCase();
  if (/disetujui|menunggu/.test(s)) {
    return { text: 'Sudah absen', cls: 'blm-pill-ok', note: 'Laporan beres. Pengingat hari ini dihentikan.' };
  }
  if (/libur/.test(s)) {
    return { text: 'Hari libur', cls: 'blm-pill-off', note: 'Hari ini libur — tidak perlu isi laporan.' };
  }
  if (/perlu tindakan/.test(s)) {
    return { text: 'Perlu tindakan', cls: 'blm-pill-bad', note: 'Mentor meminta tindakan lanjutan — cek Riwayat Kehadiran.' };
  }
  if (/ditolak|tidak hadir/.test(s)) {
    return { text: 'Tidak hadir', cls: 'blm-pill-bad', note: 'Kehadiran perlu diperbaiki di MagangHub.' };
  }
  return { text: 'Belum absen', cls: 'blm-pill-warn', note: 'Laporan hari ini belum diisi. Bot bisa mengisinya sekarang.' };
}

let panelDayManual = false; // today's manual mark state, synced by refreshDayCard

async function refreshDayCard() {
  if (!panelDayCard || !chrome.runtime?.id) return; // context dead after extension reload
  const today = todayKey();
  const cal = todayCalendarStatus();
  let doneDate = '';
  let storedDay = null;
  let weekHist = null;
  try {
    ({ doneDate, dayStatus: storedDay, blmDayHist: weekHist } = await chrome.storage.local.get(['doneDate', 'dayStatus', 'blmDayHist']));
  } catch (e) {
    return;
  }
  const manualDone = doneDate === today;
  panelDayManual = manualDone;

  let pill;
  let showToggle = true;
  // Calendar not on this page (Beranda, etc.) — reuse the status captured on Riwayat so the pill stays in sync
  const hasCalendar = Boolean(document.querySelector('button.calendar-day-button[aria-label]'));
  const calOrStored = cal || (storedDay?.date === today ? storedDay.status : null);
  if (hasCalendar) {
    // Read the whole visible period even when today's cell isn't in it (e.g. browsing an older period)
    if (!cal) chrome.runtime.sendMessage({ action: 'dayHistory', entries: readCalendarHistory() }).catch(() => {});
    if (cal) {
      chrome.runtime.sendMessage({ action: 'dayStatus', date: today, status: cal }).catch(() => {});
      chrome.runtime.sendMessage({ action: 'dayHistory', entries: readCalendarHistory() }).catch(() => {});
    }
    const p = pillFor(calOrStored);
    // Manual "sudah absen" wins over the calendar's "Belum Diisi" (site can lag behind a manual fill)
    pill = p.cls === 'blm-pill-warn' && manualDone
      ? { text: 'Sudah absen', cls: 'blm-pill-ok', note: 'Laporan beres (ditandai manual).' }
      : p;
    // Nothing to mark when the calendar already settled the day (done / libur)
    showToggle = p.cls === 'blm-pill-warn' || p.cls === 'blm-pill-bad';
  } else {
    pill = manualDone
      ? { text: 'Sudah absen', cls: 'blm-pill-ok', note: 'Laporan beres. Pengingat hari ini dihentikan.' }
      : { text: 'Belum absen', cls: 'blm-pill-warn', note: 'Laporan hari ini belum diisi. Bot bisa mengisinya sekarang.' };
  }

  panelDayDate.textContent = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  panelDayPill.textContent = pill.text;
  panelDayPill.className = `blm-daypill ${pill.cls}`;
  panelDayNote.textContent = pill.note;
  panelDayLink.classList.toggle('blm-hidden', !showToggle);
  panelDayLink.textContent = manualDone ? 'Batalkan tanda sudah absen' : 'Tandai sudah absen hari ini';

  // Holiday: block generation and say why (re-enables automatically once the day changes)
  const isHoliday = /libur/i.test(String(calOrStored || ''));
  panelGenerateBtn.disabled = isHoliday;
  panelGenerateBtn.classList.toggle('blm-btn-disabled', isHoliday);
  if (isHoliday && panelStatusEl.classList.contains('blm-status-idle')) {
    panelStatusEl.textContent = 'Hari ini libur — tidak perlu isi laporan.';
  } else if (!isHoliday && panelStatusEl.classList.contains('blm-status-idle')) {
    panelStatusEl.textContent = 'AI hanya mengisi 3 kolom (Aktivitas, Pembelajaran, Kendala) — kamu tetap perlu menekan "Kirim & Simpan" di form.';
  }

  renderWeekStrip(weekHist);
}

/** Last-7-days strip — filled days (calendar or manual mark) light up. Hidden until history exists. */
function renderWeekStrip(hist) {
  if (!panelWeekStrip || !chrome.runtime?.id) return;
  const entries = hist && typeof hist === 'object' ? hist : {};
  const fmt = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  const DAY_SHORT = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
  const NOTE_FOR = {
    on: 'Laporan sudah disetujui.',
    wait: 'Menunggu peninjauan mentor.',
    hol: 'Hari libur — tidak perlu isi laporan.',
    bad: 'Perlu perbaikan — cek Riwayat Kehadiran.',
    off: 'Belum ada laporan untuk hari ini.'
  };
  let any = false;
  const chips = [];
  for (let i = 0; i <= 6; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = todayKey(d);
    const status = entries[key] || (i === 0 && panelDayManual ? 'Sudah absen' : '');
    const s = status.toLowerCase();
    // MagangHub marks weekends as "Hari Libur" too — same navy treatment even without a calendar cell
    const isWeekend = (d.getDay() + 6) % 7 >= 5;
    const state = /disetujui|izin/.test(s) ? 'on'
      : /menunggu/.test(s) ? 'wait'
      : /perlu tindakan|ditolak|tidak hadir/.test(s) ? 'bad'
      : (/libur/.test(s) || isWeekend ? 'hol' : 'off');
    if (status) any = true;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'blm-wchip'
      + (state === 'on' ? ' blm-wchip-on' : '')
      + (state === 'wait' ? ' blm-wchip-wait' : '')
      + (state === 'bad' ? ' blm-wchip-bad' : '')
      + (state === 'hol' ? ' blm-wchip-hol' : '');
    chip.title = fmt.format(d) + (status ? ' — ' + status : ' — belum diisi');
    const dot = document.createElement('span');
    dot.className = 'blm-wdot';
    const name = document.createElement('span');
    name.textContent = DAY_SHORT[(d.getDay() + 6) % 7];
    chip.append(dot, name);
    chip.addEventListener('click', () => {
      const same = panelWeekDetail.dataset.day === key;
      panelWeekDetail.dataset.day = same ? '' : key;
      panelWeekDetail.classList.toggle('blm-hidden', same);
      if (!same) {
        panelWeekDetail.textContent = DAY_SHORT[(d.getDay() + 6) % 7] + ', ' + fmt.format(d) + ' — ' + NOTE_FOR[state];
      }
    });
    chips.push(chip);
  }
  panelWeekStrip.classList.toggle('blm-hidden', !any);
  panelWeekStrip.replaceChildren(...chips);
}

// Push calendar status changes into the panel + background
let calDebounce = null;
const calObserver = new MutationObserver(() => {
  if (!chrome.runtime?.id) {
    calObserver.disconnect(); // extension reloaded — old context is dead, stop watching
    return;
  }
  clearTimeout(calDebounce);
  calDebounce = setTimeout(refreshDayCard, 800);
});
calObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] });

// ---- Floating panel (stays open; closes only via its close button) ----

let panelEl = null;
let panelFab = null;
let panelStatusEl = null;
let panelGenerateBtn = null;
let panelInputEl = null;
let panelKendalaCb = null;
let panelKendalaInput = null;
let panelKeySection = null;
let panelKeyInput = null;
let panelKeyBtn = null;
let panelKeyMsg = null;
let panelKeyRow = null;
let panelKeyCard = null;
let panelKeyBadge = null;
let panelKeyWarn = null;
let panelDayCard = null;
let panelWeekStrip = null;
let panelWeekDetail = null;
let pengingatCard = null;
let panelDayDate = null;
let panelDayPill = null;
let panelDayNote = null;
let panelDayLink = null;
let panelTabs = null;
let panelPanes = {};
let panelShareCard = null;
let panelThemeBtn = null;
let lastShareMessage = null;

// Floating launcher — built at page load so it shows immediately, no toolbar click needed
if (document.body) {
  panelFab = document.createElement('button');
  panelFab.type = 'button';
  panelFab.className = 'blm-fab';
  panelFab.title = 'Buka Monev Assistant';
  panelFab.setAttribute('aria-label', 'Buka panel Monev Assistant');
  panelFab.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">
    <defs>
      <linearGradient id="blm-fab-g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#6D6AF0"/>
        <stop offset="1" stop-color="#4F46D6"/>
      </linearGradient>
    </defs>
    <rect x="1" y="1" width="22" height="22" rx="5.5" fill="url(#blm-fab-g)"/>
    <rect x="6.8" y="4.6" width="10.4" height="14.4" rx="1.6" fill="#FFFFFF"/>
    <rect x="8.8" y="7.4" width="6.4" height="1.3" rx="0.65" fill="#C7C7D1"/>
    <rect x="8.8" y="10" width="6.4" height="1.3" rx="0.65" fill="#C7C7D1"/>
    <rect x="8.8" y="12.6" width="3.8" height="1.3" rx="0.65" fill="#C7C7D1"/>
    <circle cx="16.8" cy="17" r="4.2" fill="#4438CA"/>
    <path d="M14.8 17.2l1.4 1.4 2.6-2.8" fill="none" stroke="#FFFFFF" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  panelFab.addEventListener('click', () => {
    ensurePanel();
    setPanelOpen(!panelEl.classList.contains('blm-open'));
  });
  document.body.appendChild(panelFab);
}

// Single source of truth for panel visibility (✕ button, toolbar icon, FAB all use this)
function setPanelOpen(open) {
  if (!panelEl) return;
  panelEl.classList.toggle('blm-open', open);
  panelFab?.classList.toggle('blm-fab-active', open);
}

function setPanelStatus(message, type) {
  if (!panelStatusEl) return;
  panelStatusEl.textContent = message;
  panelStatusEl.className = `blm-status blm-status-${type}`;
}

function ensurePanel() {
  if (panelEl) return;

  panelEl = document.createElement('div');
  panelEl.className = 'blm-panel';

  const header = document.createElement('div');
  header.className = 'blm-header';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'blm-title-wrap';

  const title = document.createElement('span');
  title.className = 'blm-title';
  title.textContent = 'Monev Assistant';

  const subtitle = document.createElement('span');
  subtitle.className = 'blm-subtitle';
  subtitle.textContent = 'MagangHub Kemnaker · ';

  const byline = document.createElement('span');
  byline.className = 'blm-byline';
  byline.textContent = 'by @l3x.me · v' + chrome.runtime.getManifest().version;

  subtitle.append(byline);

  titleWrap.append(title, subtitle);

  // Mini logo — inline SVG (same design as icons/icon128.png), no manifest change needed
  const brand = document.createElement('div');
  brand.className = 'blm-brand';

  const logo = document.createElement('span');
  logo.className = 'blm-logo';
  logo.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">
    <defs>
      <linearGradient id="blm-logo-g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#6D6AF0"/>
        <stop offset="1" stop-color="#4F46D6"/>
      </linearGradient>
    </defs>
    <rect x="1" y="1" width="22" height="22" rx="5.5" fill="url(#blm-logo-g)"/>
    <rect x="6.8" y="4.6" width="10.4" height="14.4" rx="1.6" fill="#FFFFFF"/>
    <rect x="8.8" y="7.4" width="6.4" height="1.3" rx="0.65" fill="#C7C7D1"/>
    <rect x="8.8" y="10" width="6.4" height="1.3" rx="0.65" fill="#C7C7D1"/>
    <rect x="8.8" y="12.6" width="3.8" height="1.3" rx="0.65" fill="#C7C7D1"/>
    <circle cx="16.8" cy="17" r="4.2" fill="#4438CA"/>
    <path d="M14.8 17.2l1.4 1.4 2.6-2.8" fill="none" stroke="#FFFFFF" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  brand.append(logo, titleWrap);

  panelThemeBtn = document.createElement('button');
  panelThemeBtn.className = 'blm-theme-btn';
  panelThemeBtn.title = 'Mode gelap/terang';
  panelThemeBtn.addEventListener('click', togglePanelTheme);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'blm-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.title = 'Tutup';
  closeBtn.addEventListener('click', () => setPanelOpen(false));

  header.append(brand, panelThemeBtn, closeBtn);

  // Tab bar — Laporan / Pengingat / Pengaturan
  panelTabs = document.createElement('nav');
  panelTabs.className = 'blm-tabs';

  panelPanes = {};
  for (const [id, name] of [['laporan', 'Laporan'], ['pengingat', 'Pengingat'], ['pengaturan', 'Pengaturan']]) {
    const tabBtn = document.createElement('button');
    tabBtn.type = 'button';
    tabBtn.dataset.tab = id;
    tabBtn.className = 'blm-tab' + (id === 'laporan' ? ' blm-tab-active' : '');
    tabBtn.textContent = name;
    tabBtn.addEventListener('click', () => switchTab(id));
    panelTabs.append(tabBtn);

    panelPanes[id] = document.createElement('div');
    panelPanes[id].className = 'blm-tabpane' + (id === 'laporan' ? '' : ' blm-hidden');
  }

  // API key activation section — lives in the Pengaturan tab
  // API key card — header (icon + title + status badge) with form / saved-row inside
  panelKeyCard = document.createElement('div');
  panelKeyCard.className = 'blm-keycard';

  const keyHead = document.createElement('div');
  keyHead.className = 'blm-keyhead';

  const keyIcon = document.createElement('span');
  keyIcon.className = 'blm-keyicon';
  keyIcon.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>';

  const keyTitle = document.createElement('span');
  keyTitle.className = 'blm-keytitle';
  keyTitle.textContent = 'Gemini API Key';

  panelKeyBadge = document.createElement('span');
  panelKeyBadge.className = 'blm-keybadge blm-keybadge-off';
  panelKeyBadge.textContent = 'Belum aktif';

  keyHead.append(keyIcon, keyTitle, panelKeyBadge);

  panelKeySection = document.createElement('div');
  panelKeySection.className = 'blm-key blm-hidden';

  panelKeyInput = document.createElement('input');
  panelKeyInput.className = 'blm-key-input';
  panelKeyInput.type = 'password';
  panelKeyInput.placeholder = 'Paste API key kamu di sini';
  panelKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSaveKey();
  });

  // Show/hide toggle for the key input
  const keyEye = document.createElement('button');
  keyEye.type = 'button';
  keyEye.className = 'blm-key-eye';
  keyEye.title = 'Tampilkan / sembunyikan API key';
  const eyeSvg = (open) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${open
    ? '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'
    : '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M1 1l22 22"/>'
  }</svg>`;
  keyEye.innerHTML = eyeSvg(false);
  keyEye.addEventListener('click', () => {
    const show = panelKeyInput.type === 'password';
    panelKeyInput.type = show ? 'text' : 'password';
    keyEye.innerHTML = eyeSvg(show);
  });

  const keyRow = document.createElement('div');
  keyRow.className = 'blm-key-row';
  keyRow.append(panelKeyInput, keyEye);

  panelKeyBtn = document.createElement('button');
  panelKeyBtn.className = 'blm-generate';
  panelKeyBtn.textContent = 'Simpan & Cek';
  panelKeyBtn.addEventListener('click', handleSaveKey);

  panelKeyMsg = document.createElement('div');
  panelKeyMsg.className = 'blm-keymsg';

  const keyHint = document.createElement('div');
  keyHint.className = 'blm-hint';
  keyHint.append('Ambil key gratis di ');

  const keyLink = document.createElement('a');
  keyLink.className = 'blm-hint-link';
  keyLink.href = 'https://aistudio.google.com/app/apikey';
  keyLink.target = '_blank';
  keyLink.rel = 'noopener';
  keyLink.textContent = 'aistudio.google.com/app/apikey';

  keyHint.append(keyLink, '. Key hanya tersimpan di browser kamu.');

  panelKeySection.append(keyRow, panelKeyBtn, panelKeyMsg, keyHint);

  // Saved-key actions row (shown inside the card instead of the activation form)
  panelKeyRow = document.createElement('div');
  panelKeyRow.className = 'blm-keyrow blm-hidden';

  const keyChangeBtn = document.createElement('button');
  keyChangeBtn.className = 'blm-keylink';
  keyChangeBtn.textContent = 'Ganti key';
  keyChangeBtn.addEventListener('click', () => updateKeyUi(false));

  const keyDeleteBtn = document.createElement('button');
  keyDeleteBtn.className = 'blm-keylink blm-keylink-danger';
  keyDeleteBtn.textContent = 'Hapus';

  // Inline confirm replaces the actions row, auto-reverts after 5s so it never gets stuck
  const confirmDelete = document.createElement('span');
  confirmDelete.className = 'blm-keyconfirm blm-hidden';
  const confirmText = document.createElement('span');
  confirmText.className = 'blm-keyconfirm-text';
  confirmText.textContent = 'Yakin hapus key?';
  const confirmYes = document.createElement('button');
  confirmYes.type = 'button';
  confirmYes.className = 'blm-keylink blm-keylink-danger';
  confirmYes.textContent = 'Ya, hapus';
  const confirmNo = document.createElement('button');
  confirmNo.type = 'button';
  confirmNo.className = 'blm-keylink';
  confirmNo.textContent = 'Batal';
  confirmDelete.append(confirmText, confirmYes, confirmNo);

  function showConfirm(on) {
    keyChangeBtn.classList.toggle('blm-hidden', on);
    keyDeleteBtn.classList.toggle('blm-hidden', on);
    confirmDelete.classList.toggle('blm-hidden', !on);
  }

  keyDeleteBtn.addEventListener('click', () => showConfirm(true));
  confirmNo.addEventListener('click', () => showConfirm(false));
  confirmYes.addEventListener('click', async () => {
    showConfirm(false);
    try {
      await chrome.storage.local.remove('blmApiKey');
    } catch (e) {}
    updateKeyUi(false);
  });

  const keyRowActions = document.createElement('span');
  keyRowActions.className = 'blm-keyrow-actions';
  keyRowActions.append(keyChangeBtn, keyDeleteBtn, confirmDelete);

  panelKeyRow.append(keyRowActions);

  panelKeyCard.append(keyHead, panelKeySection, panelKeyRow);

  const privacyCard = document.createElement('div');
  privacyCard.className = 'blm-privacy';

  const privacyTitle = document.createElement('span');
  privacyTitle.className = 'blm-label';
  privacyTitle.textContent = 'Privasi';

  const privacyText = document.createElement('span');
  privacyText.className = 'blm-hint';
  privacyText.textContent = 'API key hanya tersimpan di browser ini dan hanya dikirim ke Google — bukan ke pihak mana pun.';

  privacyCard.append(privacyTitle, privacyText);

  // Tools — test the reminder chain & restore default reminder settings
  const toolsCard = document.createElement('div');
  toolsCard.className = 'blm-privacy';

  const toolsTitle = document.createElement('span');
  toolsTitle.className = 'blm-label';
  toolsTitle.textContent = 'Pengingat';

  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'blm-btn-soft';
  testBtn.textContent = 'Tes notifikasi';

  const toolsMsg = document.createElement('span');
  toolsMsg.className = 'blm-hint';

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ action: 'testNotif' });
      toolsMsg.textContent = res.ok ? 'Notifikasi tes terkirim — cek pojok kanan bawah layar.' : res.error;
    } catch (e) {
      toolsMsg.textContent = 'Gagal mengirim tes — coba lagi.';
    } finally {
      testBtn.disabled = false;
    }
  });

  const resetLink = document.createElement('button');
  resetLink.type = 'button';
  resetLink.className = 'blm-keylink';
  resetLink.textContent = 'Reset pengingat ke default';
  resetLink.addEventListener('click', () => {
    remindTimes = [{ t: '11:30', on: true }, { t: '13:30', on: true }, { t: '16:30', on: true }];
    customTimes = [];
    remindDays = [true, true, true, true, true, true, false];
    saveRemindSettings();
    toolsMsg.textContent = 'Jam & hari pengingat kembali ke default.';
  });

  toolsCard.append(toolsTitle, testBtn, resetLink, toolsMsg);

  // About card — collapsible, closed by default
  const aboutCard = document.createElement('div');
  aboutCard.className = 'blm-about';

  const aboutHead = document.createElement('button');
  aboutHead.type = 'button';
  aboutHead.className = 'blm-abouthead';
  aboutHead.setAttribute('aria-expanded', 'false');

  const aboutTitle = document.createElement('span');
  aboutTitle.className = 'blm-label';
  aboutTitle.textContent = 'Tentang';

  const aboutChev = document.createElement('span');
  aboutChev.className = 'blm-aboutchev';
  aboutChev.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

  const aboutText = document.createElement('span');
  aboutText.className = 'blm-hint blm-aboutbody blm-hidden';
  aboutText.textContent = 'Monev Assistant adalah teman isi laporan harian di MagangHub Kemnaker. Tulis ringkasan kegiatanmu dengan bahasa sendiri, AI mengembangkannya menjadi tiga kolom laporan (Aktivitas, Pembelajaran, Kendala) dengan gaya bahasa freshgraduate yang natural. Tujuannya memangkas rutinitas menulis laporan tiap sore jadi beberapa menit, tanpa menembus laporanmu sendiri: kamu tetap memilih kata, meninjau hasilnya, dan menekan Kirim & Simpan. Semua data hanya lewat browser kamu. API key dan isi kegiatan tidak dikirim ke pihak mana pun selain Google (untuk menulis) dan MagangHub (untuk mengisi).';

  aboutHead.addEventListener('click', () => {
    const closed = aboutText.classList.toggle('blm-hidden');
    aboutChev.classList.toggle('blm-aboutchev-open', !closed);
    aboutHead.setAttribute('aria-expanded', String(!closed));
  });

  aboutHead.append(aboutTitle, aboutChev);
  aboutCard.append(aboutHead, aboutText);

  // Support card — collapsible, shows the developer's QRIS when opened
  const supportCard = document.createElement('div');
  supportCard.className = 'blm-about';

  const supportHead = document.createElement('button');
  supportHead.type = 'button';
  supportHead.className = 'blm-abouthead';
  supportHead.setAttribute('aria-expanded', 'false');

  const supportTitle = document.createElement('span');
  supportTitle.className = 'blm-label';
  supportTitle.textContent = 'Dukung saya';

  const supportChev = document.createElement('span');
  supportChev.className = 'blm-aboutchev';
  supportChev.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

  const supportBody = document.createElement('span');
  supportBody.className = 'blm-hint blm-aboutbody blm-hidden';
  supportBody.textContent = 'Apresiasi untuk developer — scan QRIS di bawah.';

  const supportImg = document.createElement('img');
  supportImg.className = 'blm-qris';
  supportImg.src = chrome.runtime.getURL('qris.jpeg');
  supportImg.alt = 'QRIS untuk dukungan developer';
  supportImg.title = 'Buka di tab baru untuk zoom';
  supportImg.addEventListener('click', () => {
    try { window.open(supportImg.src, '_blank'); } catch (e) {}
  });

  supportBody.append(supportImg);

  supportHead.addEventListener('click', () => {
    const closed = supportBody.classList.toggle('blm-hidden');
    supportChev.classList.toggle('blm-aboutchev-open', !closed);
    supportHead.setAttribute('aria-expanded', String(!closed));
  });

  supportHead.append(supportTitle, supportChev);
  supportCard.append(supportHead, supportBody);

  // Pengingat — user-configured reminder times & days
  pengingatCard = document.createElement('div');
  pengingatCard.className = 'blm-remind';

  const rHead = document.createElement('div');
  rHead.className = 'blm-rhead';

  const rIcon = document.createElement('span');
  rIcon.className = 'blm-ricon';
  rIcon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';

  const rTitleWrap = document.createElement('span');
  rTitleWrap.className = 'blm-rtitle';
  const rTitle = document.createElement('span');
  rTitle.className = 'blm-rtitle-main';
  rTitle.textContent = 'Notifikasi browser';
  const rSub = document.createElement('span');
  rSub.className = 'blm-rtitle-sub';
  rSub.textContent = 'Muncul selama browser aktif';
  rTitleWrap.append(rTitle, rSub);

  const notifSwitch = document.createElement('label');
  notifSwitch.className = 'blm-switch';
  const notifCb = document.createElement('input');
  notifCb.type = 'checkbox';
  const notifTrack = document.createElement('span');
  notifTrack.className = 'blm-switch-track';
  notifSwitch.append(notifCb, notifTrack);

  rHead.append(rIcon, rTitleWrap, notifSwitch);

  const timesSec = document.createElement('div');
  timesSec.className = 'blm-rsec';
  const timesLabel = document.createElement('span');
  timesLabel.className = 'blm-rlabel';
  timesLabel.textContent = 'Jam pengingat (' + tzAbbr() + ')';
  const timeList = document.createElement('div');
  timeList.className = 'blm-timelist';
  timesSec.append(timesLabel, timeList);

  const addForm = document.createElement('div');
  addForm.className = 'blm-addform blm-hidden';
  const addInput = document.createElement('input');
  addInput.type = 'time';
  const addConfirm = document.createElement('button');
  addConfirm.type = 'button';
  addConfirm.className = 'blm-btn-mini';
  addConfirm.textContent = 'Tambah';
  const addCancel = document.createElement('button');
  addCancel.type = 'button';
  addCancel.className = 'blm-keylink';
  addCancel.textContent = 'Batal';
  addForm.append(addInput, addConfirm, addCancel);

  const addRow = document.createElement('button');
  addRow.type = 'button';
  addRow.className = 'blm-timeadd';
  addRow.textContent = '+ Tambah jam';

  const daysSec = document.createElement('div');
  daysSec.className = 'blm-rsec';
  const daysLabel = document.createElement('span');
  daysLabel.className = 'blm-rlabel';
  daysLabel.textContent = 'Hari aktif';
  const dayBar = document.createElement('div');
  dayBar.className = 'blm-daybar';
  daysSec.append(daysLabel, dayBar);

  pengingatCard.append(rHead, timesSec, addForm, daysSec);

  const DEFAULT_REMIND_TIMES = [{ t: '11:30', on: true }, { t: '13:30', on: true }, { t: '16:30', on: true }];
  const DAY_SHORT = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
  let remindTimes = [];
  let customTimes = [];
  let remindDays = [];
  let notifOn = true;

  function tzAbbr() {
    const east = -new Date().getTimezoneOffset();
    if (east === 420) return 'WIB';
    if (east === 480) return 'WITA';
    if (east === 540) return 'WIT';
    return 'waktu lokal';
  }

  function makeTimeRow(t, on, onClick, removable) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'blm-timerow' + (on ? ' blm-timerow-on' : '');
    const time = document.createElement('span');
    time.className = 'blm-timetime';
    time.textContent = t;
    const status = document.createElement('span');
    status.className = 'blm-timestatus';
    if (removable) {
      row.title = 'Klik untuk menghapus jam ini';
      const x = document.createElement('span');
      x.className = 'blm-chip-x';
      x.textContent = '\u00d7';
      status.append(x);
    } else {
      const dot = document.createElement('span');
      dot.className = 'blm-timedot';
      const txt = document.createElement('span');
      txt.textContent = on ? 'aktif' : 'mati';
      status.append(dot, txt);
    }
    row.append(time, status);
    row.addEventListener('click', onClick);
    return row;
  }

  function saveRemindSettings() {
    chrome.storage.local.set({
      blmNotifOn: notifOn,
      blmRemindTimes: remindTimes,
      blmCustomTimes: customTimes,
      blmDays: remindDays
    });
    renderChips();
  }

  function renderChips() {
    notifCb.checked = notifOn;
    timeList.replaceChildren();
    for (const item of remindTimes) {
      timeList.append(makeTimeRow(item.t, item.on, () => {
        item.on = !item.on;
        saveRemindSettings();
      }, false));
    }
    for (const t of customTimes) {
      timeList.append(makeTimeRow(t, true, () => {
        customTimes = customTimes.filter((v) => v !== t);
        saveRemindSettings();
      }, true));
    }
    if (customTimes.length < 3) timeList.append(addRow);
    dayBar.replaceChildren();
    DAY_SHORT.forEach((name, i) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'blm-daycell' + (remindDays[i] ? ' blm-daycell-on' : '');
      cell.textContent = name;
      cell.addEventListener('click', () => {
        remindDays[i] = !remindDays[i];
        saveRemindSettings();
      });
      dayBar.append(cell);
    });
  }

  notifCb.addEventListener('change', () => {
    notifOn = notifCb.checked;
    saveRemindSettings();
  });

  addRow.addEventListener('click', () => {
    addForm.classList.remove('blm-hidden');
    addInput.value = '';
    addInput.focus();
  });
  addCancel.addEventListener('click', () => addForm.classList.add('blm-hidden'));
  addConfirm.addEventListener('click', () => {
    const t = addInput.value;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return;
    if (remindTimes.some((d) => d.t === t) || customTimes.includes(t)) return; // already exists
    customTimes.push(t);
    customTimes.sort();
    saveRemindSettings();
    addForm.classList.add('blm-hidden');
  });

  (async () => {
    try {
      const d = await chrome.storage.local.get(['blmNotifOn', 'blmRemindTimes', 'blmCustomTimes', 'blmDays']);
      notifOn = d.blmNotifOn !== false;
      remindTimes = Array.isArray(d.blmRemindTimes) && d.blmRemindTimes.length ? d.blmRemindTimes : DEFAULT_REMIND_TIMES.slice();
      customTimes = Array.isArray(d.blmCustomTimes) ? d.blmCustomTimes : [];
      remindDays = Array.isArray(d.blmDays) && d.blmDays.length === 7 ? d.blmDays.slice() : [true, true, true, true, true, true, false];
    } catch (e) {
      remindTimes = DEFAULT_REMIND_TIMES.slice();
      remindDays = [true, true, true, true, true, true, false];
    }
    renderChips();
  })();

  // Day status card — mirrors the Riwayat Kehadiran calendar for today
  panelDayCard = document.createElement('div');
  panelDayCard.className = 'blm-daycard';

  panelDayDate = document.createElement('span');
  panelDayDate.className = 'blm-daydate';

  panelDayPill = document.createElement('span');
  panelDayPill.className = 'blm-daypill';

  panelDayNote = document.createElement('span');
  panelDayNote.className = 'blm-daynote';

  panelDayLink = document.createElement('button');
  panelDayLink.type = 'button';
  panelDayLink.className = 'blm-btn-soft';
  panelDayLink.addEventListener('click', async () => {
    panelDayLink.disabled = true;
    try {
      await chrome.runtime.sendMessage({ action: 'markDone', done: !panelDayManual });
    } catch (e) {}
    panelDayLink.disabled = false;
    refreshDayCard();
  });

  // Last-7-days attendance strip — lives inside the day card, scrolls horizontally when tight
  panelWeekStrip = document.createElement('div');
  panelWeekStrip.className = 'blm-weekstrip blm-hidden';

  panelWeekDetail = document.createElement('div');
  panelWeekDetail.className = 'blm-wdetail blm-hidden';

  panelDayCard.append(panelDayDate, panelDayPill, panelDayNote, panelDayLink, panelWeekStrip, panelWeekDetail);

  // Key-missing warning card — jumps to the Pengaturan tab
  panelKeyWarn = document.createElement('div');
  panelKeyWarn.className = 'blm-keywarn blm-hidden';

  const warnText = document.createElement('span');
  warnText.className = 'blm-keywarn-text';
  warnText.textContent = 'Atur Gemini API key dulu supaya AI bisa menulis laporan.';

  const warnDesc = document.createElement('span');
  warnDesc.className = 'blm-keywarn-desc';
  warnDesc.append('Gratis dari Google AI Studio — ambil key gratis di ');

  const warnLink = document.createElement('a');
  warnLink.className = 'blm-hint-link';
  warnLink.href = 'https://aistudio.google.com/app/apikey';
  warnLink.target = '_blank';
  warnLink.rel = 'noopener';
  warnLink.textContent = 'aistudio.google.com/app/apikey';

  warnDesc.append(warnLink, '.');

  const warnBtn = document.createElement('button');
  warnBtn.type = 'button';
  warnBtn.className = 'blm-btn-soft';
  warnBtn.textContent = 'Atur sekarang';
  warnBtn.addEventListener('click', () => switchTab('pengaturan'));

  panelKeyWarn.append(warnText, warnDesc, warnBtn);

  const label = document.createElement('label');
  label.className = 'blm-label';
  label.textContent = 'Kegiatan Hari Ini';

  panelInputEl = document.createElement('textarea');
  panelInputEl.className = 'blm-input';
  panelInputEl.placeholder = 'Contoh: Hari ini saya melakukan input data karyawan ke sistem HRIS dan mengikuti rapat tim divisi IT tentang pengembangan fitur baru';

  panelKendalaCb = document.createElement('input');
  panelKendalaCb.type = 'checkbox';

  const kendalaCheckLabel = document.createElement('label');
  kendalaCheckLabel.className = 'blm-check';
  const kendalaCheckText = document.createElement('span');
  kendalaCheckText.textContent = 'Ada kendala hari ini? centang jika ada.';
  kendalaCheckLabel.append(panelKendalaCb, kendalaCheckText);

  panelKendalaInput = document.createElement('textarea');
  panelKendalaInput.className = 'blm-kendala blm-hidden';
  panelKendalaInput.rows = 2;
  panelKendalaInput.placeholder = 'Contoh: internet lambat, aplikasi error, bingung pakai tools baru...';
  panelKendalaCb.addEventListener('change', () => {
    panelKendalaInput.classList.toggle('blm-hidden', !panelKendalaCb.checked);
  });

  panelGenerateBtn = document.createElement('button');
  panelGenerateBtn.className = 'blm-generate';
  panelGenerateBtn.textContent = 'Generate & Isi Laporan';

  panelStatusEl = document.createElement('div');
  panelStatusEl.className = 'blm-status blm-status-idle';
  panelStatusEl.textContent = 'AI hanya mengisi 3 kolom (Aktivitas, Pembelajaran, Kendala) — kamu tetap perlu menekan "Kirim & Simpan" di form.';

  panelShareCard = document.createElement('div');
  panelShareCard.className = 'blm-share blm-hidden';

  const shareText = document.createElement('span');
  shareText.className = 'blm-share-text';
  shareText.textContent = 'Laporan sudah terisi ✓';

  const shareBtn = document.createElement('button');
  shareBtn.className = 'blm-share-btn';
  shareBtn.textContent = 'Kirim Bukti ke WhatsApp';
  shareBtn.addEventListener('click', () => {
    if (lastShareMessage) {
      window.open(`https://wa.me/?text=${encodeURIComponent(lastShareMessage)}`, '_blank');
    }
  });

  panelShareCard.append(shareText, shareBtn);

  panelGenerateBtn.addEventListener('click', handlePanelGenerate);

  panelPanes.laporan.append(panelDayCard, panelKeyWarn, label, panelInputEl, kendalaCheckLabel, panelKendalaInput, panelGenerateBtn, panelStatusEl, panelShareCard);
  panelPanes.pengingat.append(pengingatCard);
  panelPanes.pengaturan.append(panelKeyCard, privacyCard, toolsCard, aboutCard, supportCard);

  panelEl.append(header, panelTabs, panelPanes.laporan, panelPanes.pengingat, panelPanes.pengaturan);
  document.body.appendChild(panelEl);

  // Floating launcher — see top-level block; visibility is handled by setPanelOpen

  // Restore saved theme synchronously (page localStorage — reliable in content scripts)
  let dark = false;
  try { dark = localStorage.getItem('blmTheme') === 'dark'; } catch (e) {}
  applyPanelTheme(dark);

  // Key-dependent UI: warning card on Laporan, saved row vs activation form on Pengaturan
  chrome.storage.local.get('blmApiKey', (d) => updateKeyUi(Boolean(d.blmApiKey)));
  refreshDayCard();
}

// ---- Tab switching ----

function switchTab(name) {
  for (const id of ['laporan', 'pengingat', 'pengaturan']) {
    panelPanes[id].classList.toggle('blm-hidden', id !== name);
  }
  for (const btn of panelTabs.querySelectorAll('.blm-tab')) {
    btn.classList.toggle('blm-tab-active', btn.dataset.tab === name);
  }
}

// ---- API key (user-provided, stored in chrome.storage.local) ----

function updateKeyUi(hasKey) {
  panelKeySection.classList.toggle('blm-hidden', hasKey);
  panelKeyRow.classList.toggle('blm-hidden', !hasKey);
  panelKeyWarn.classList.toggle('blm-hidden', hasKey);
  panelKeyBadge.textContent = hasKey ? 'Tersimpan' : 'Belum aktif';
  panelKeyBadge.className = 'blm-keybadge ' + (hasKey ? 'blm-keybadge-ok' : 'blm-keybadge-off');
  if (!hasKey) {
    panelKeyInput.value = '';
    panelKeyMsg.textContent = '';
  }
}

async function handleSaveKey() {
  const key = panelKeyInput.value.trim();
  if (!key) {
    panelKeyMsg.textContent = '⚠️ Masukkan API key dulu';
    panelKeyMsg.className = 'blm-keymsg blm-keymsg-err';
    return;
  }

  panelKeyBtn.disabled = true;
  panelKeyBtn.textContent = 'Mengecek key...';
  panelKeyMsg.textContent = '⏳ Mengecek key ke Google...';
  panelKeyMsg.className = 'blm-keymsg';

  try {
    const res = await chrome.runtime.sendMessage({ action: 'saveKey', apiKey: key });
    if (!res.ok) throw new Error(res.error);
    panelKeyInput.value = '';
    updateKeyUi(true);
  } catch (e) {
    panelKeyMsg.textContent = `❌ ${e.message}`;
    panelKeyMsg.className = 'blm-keymsg blm-keymsg-err';
  } finally {
    panelKeyBtn.disabled = false;
    panelKeyBtn.textContent = 'Simpan & Cek';
  }
}

// ---- Theme (manual dark/light toggle, persisted per device via page localStorage) ----

function applyPanelTheme(dark) {
  if (!panelEl) return;
  panelEl.classList.toggle('blm-dark', dark);
  panelThemeBtn.textContent = dark ? '\u2600' : '\ud83c\udf19';
}

function togglePanelTheme() {
  const dark = !panelEl.classList.contains('blm-dark');
  applyPanelTheme(dark);
  try { localStorage.setItem('blmTheme', dark ? 'dark' : 'light'); } catch (e) {}
}

// Build the WhatsApp proof message — 100% ASCII: wa.me mangles non-ASCII symbols
// (even BMP-safe ones) into U+FFFD, so only plain text + [OK] markers survive
function buildShareMessage() {
  const tanggal = new Date().toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return `*LAPORAN MAGANG HARIAN*\nTanggal: ${tanggal}\n\n[OK] Uraian Aktivitas\n[OK] Pembelajaran\n[OK] Kendala\n\nLaporan sudah diisi di MagangHub Kemnaker.`;
}

async function handlePanelGenerate() {
  const kegiatan = panelInputEl.value.trim();

  if (!kegiatan) {
    setPanelStatus('⚠️ Masukkan kegiatan terlebih dahulu', 'warning');
    return;
  }
  if (kegiatan.length < 10) {
    setPanelStatus('⚠️ Deskripsi kegiatan terlalu pendek', 'warning');
    return;
  }

  // Optional kendala input: checked but empty → block, so the AI never invents generic filler
  const kendalaInfo = panelKendalaCb.checked ? panelKendalaInput.value.trim() : null;
  if (panelKendalaCb.checked && !kendalaInfo) {
    setPanelStatus('⚠️ Isi kendala dulu atau hilangkan centangnya', 'warning');
    return;
  }

  panelGenerateBtn.disabled = true;
  panelShareCard?.classList.add('blm-hidden');
  setPanelStatus('⏳ Menghasilkan laporan & mengisi form...', 'loading');

  try {
    const res = await chrome.runtime.sendMessage({ action: 'generate', kegiatan, kendalaInfo });
    if (!res.ok) throw new Error(res.error);

    const fillResult = fillReport(res.result);
    const filledCount = fillResult.filled.filter(Boolean).length;

    if (fillResult.success) {
      setPanelStatus('✅ Berhasil mengisi 3 kolom laporan', 'success');
      lastShareMessage = buildShareMessage(res.result);
      panelShareCard.classList.remove('blm-hidden');
      chrome.runtime.sendMessage({ action: 'filled' }).catch(() => {});
      refreshDayCard();
    } else if (filledCount > 0) {
      setPanelStatus(`⚠️ Hanya berhasil mengisi ${filledCount}/3 kolom`, 'warning');
    } else {
      setPanelStatus(`❌ ${fillResult.error || 'Gagal mengisi form'}`, 'error');
    }
  } catch (e) {
    setPanelStatus(`❌ ${e.message}`, 'error');
  } finally {
    panelGenerateBtn.disabled = false;
  }
}

/**
 * Listen for messages from popup/background
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'ping') {
    sendResponse({ ok: true });
    return;
  }

  if (message.action === 'fillForm') {
    try {
      sendResponse(fillReport(message.data));
    } catch (err) {
      sendResponse({
        success: false,
        filled: [false, false, false],
        error: err.message
      });
    }
    return;
  }

  if (message.action === 'togglePanel') {
    ensurePanel();
    setPanelOpen(panelEl.classList.contains('blm-open'));
    sendResponse({ ok: true });
  }
});
}
