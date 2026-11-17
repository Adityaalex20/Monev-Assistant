/*
 * Monev Assistant v1.3
 * Copyright (c) 2026 @l3x.me. All rights reserved.
 *
 * Auto-fill laporan harian MagangHub Kemnaker dengan Gemini API.
 * Dilarang menjual, memodifikasi, atau mendistribusikan ulang
 * tanpa izin pemilik.
 */

// Background service worker — handles Gemini API calls (content scripts cannot cross-origin fetch in MV3)
// API key is user-provided (saved in chrome.storage.local as 'blmApiKey') — never bundled with the file

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Fallback chain ordered by speed first (lite generates fastest);
// per-section top-up handles undershoot, so sloppiness is cheap to fix
const GEMINI_MODELS = ['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-3.5-flash'];
const GEMINI_ENDPOINT = (model) => `${GEMINI_API_BASE}/models/${model}:generateContent`;

const SECTIONS = [
  { key: 'uraian', label: 'Uraian Aktivitas' },
  { key: 'pembelajaran', label: 'Pembelajaran yang Diperoleh' },
  { key: 'kendala', label: 'Kendala yang Dialami' }
];

// 30s per request: a hanging fetch becomes an error and the chain moves to the next model
const FETCH_TIMEOUT_MS = 30000;

/* ---------------- Daily reminder (user-configured times & days) ---------------- */

const REMIND_PREFIX = 'remind|';
const NOTIF_ID = 'blmRemindNotif';
// Calendar statuses that mean "no report needed today" — from MagangHub's Riwayat Kehadiran calendar.
// "Perlu Tindakan Anda" / "Kehadiran Ditolak" / "Tidak Hadir" deliberately NOT here: reminder keeps firing.
const DAY_SKIP_RE = /disetujui|menunggu|libur/i;
const LATE_LIMIT_MS = 60 * 60 * 1000; // skip reminders more than 1h late (laptop just woke up)
const SCHEDULE_KEYS = ['blmNotifOn', 'blmRemindTimes', 'blmCustomTimes', 'blmDays'];
const DEFAULT_REMIND_TIMES = [{ t: '11:30', on: true }, { t: '13:30', on: true }, { t: '16:30', on: true }];
const FORM_URL = (dateKey) => `https://monev.maganghub.kemnaker.go.id/dashboard/riwayat?date=${dateKey}&view=edit`;

function todayKey(date = new Date()) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

function isValidTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

/** Default chips turned on + custom times — unique and sorted. */
function activeTimes(times, custom) {
  const on = (times || []).filter((d) => d && d.on && isValidTime(d.t)).map((d) => d.t);
  const extra = (custom || []).filter(isValidTime);
  return Array.from(new Set(on.concat(extra))).sort();
}

/** Next occurrence of "HH:MM" (ms) — today or tomorrow. */
function nextOccurrence(time, now = new Date()) {
  const [h, m] = time.split(':').map(Number);
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
}

function tzAbbr() {
  const east = -new Date().getTimezoneOffset();
  if (east === 420) return 'WIB';
  if (east === 480) return 'WITA';
  if (east === 540) return 'WIT';
  return 'waktu lokal';
}

async function rescheduleAlarms() {
  const s = await chrome.storage.local.get(['blmNotifOn', 'blmRemindTimes', 'blmCustomTimes']);
  const existing = await chrome.alarms.getAll();
  await Promise.all(existing.filter((a) => a.name.startsWith(REMIND_PREFIX)).map((a) => chrome.alarms.clear(a.name)));
  if (s.blmNotifOn === false) return;
  const defaults = Array.isArray(s.blmRemindTimes) && s.blmRemindTimes.length ? s.blmRemindTimes : DEFAULT_REMIND_TIMES;
  for (const t of activeTimes(defaults, s.blmCustomTimes)) {
    await chrome.alarms.create(REMIND_PREFIX + t, { when: nextOccurrence(t), periodInMinutes: 24 * 60 });
  }
}

/** Indonesian national holiday check via date.nager.at — cached per day; network failure is not fatal. */
async function isNationalHoliday() {
  const today = todayKey();
  const { blmHolidayCache } = await chrome.storage.local.get('blmHolidayCache');
  if (blmHolidayCache?.date === today) return Boolean(blmHolidayCache.isHoliday);

  let isHoliday = null;
  try {
    const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${new Date().getFullYear()}/ID`);
    if (res.ok) {
      const list = await res.json();
      isHoliday = Array.isArray(list) && list.some((h) => h.date === today);
      await chrome.storage.local.set({ blmHolidayCache: { date: today, isHoliday: Boolean(isHoliday) } });
    }
  } catch (e) {
    // Offline / API down: fall back to day-chips check only
  }
  return isHoliday === true;
}

async function handleReminder(time, scheduledTime) {
  if (scheduledTime && Date.now() - scheduledTime > LATE_LIMIT_MS) return;
  const s = await chrome.storage.local.get(['blmNotifOn', 'blmDays', 'doneDate', 'dayStatus']);
  if (s.blmNotifOn === false) return;

  const days = Array.isArray(s.blmDays) && s.blmDays.length === 7
    ? s.blmDays
    : [true, true, true, true, true, true, false];
  const now = new Date();
  if (!days[(now.getDay() + 6) % 7]) return; // Senin = index 0

  if (await isNationalHoliday()) return;

  const today = todayKey();
  if (s.doneDate === today) return clearNotif();
  if (s.dayStatus?.date === today && DAY_SKIP_RE.test(s.dayStatus.status)) return clearNotif();

  await chrome.notifications.clear(NOTIF_ID);
  chrome.notifications.create(NOTIF_ID, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Waktunya isi laporan MagangHub',
    message: 'Laporan hari ini belum diisi. Pengingat ' + time + ' ' + tzAbbr() + '.',
    buttons: [{ title: 'Buka form laporan' }, { title: 'Sudah absen hari ini' }],
    requireInteraction: true,
    priority: 2
  });
}

function clearNotif() {
  chrome.notifications.clear(NOTIF_ID);
}

function openReportForm() {
  chrome.tabs.create({ url: FORM_URL(todayKey()) });
}

async function markDoneLocal(done) {
  await chrome.storage.local.set({ doneDate: done ? todayKey() : '' });
  clearNotif();
}

chrome.runtime.onInstalled.addListener(rescheduleAlarms);
chrome.runtime.onStartup.addListener(rescheduleAlarms);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && SCHEDULE_KEYS.some((k) => k in changes)) rescheduleAlarms();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(REMIND_PREFIX)) handleReminder(alarm.name.slice(REMIND_PREFIX.length), alarm.scheduledTime);
});

chrome.notifications.onClicked.addListener((id) => {
  if (id !== NOTIF_ID) return;
  openReportForm();
  chrome.notifications.clear(id);
});

chrome.notifications.onButtonClicked.addListener((id, index) => {
  if (id !== NOTIF_ID) return;
  if (index === 0) openReportForm();
  else markDoneLocal(true);
  chrome.notifications.clear(id);
});

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildPrompt(kegiatan, kendalaInfo) {
  return {
    system_instruction: {
      parts: [{
        text: `Kamu adalah seorang peserta magang MagangHub Kemnaker yang sedang menulis laporan harianmu sendiri. Tugasmu adalah mengembangkan ringkasan kegiatan menjadi tiga bagian laporan yang lengkap dalam bahasa Indonesia.

ATURAN KETAT:
- Tulis dari sudut pandang orang pertama ("saya") sebagai peserta magang yang mengalami kegiatannya sendiri
- Tulis seperti mahasiswa magang sungguhan yang menulis laporan dengan bahasanya sendiri — bukan seperti mesin atau template
- Nada tetap sopan dan rapi, tapi kalimatnya mengalir dan personal (misal: "hari ini saya belajar...", "saya dibantu mentor...")
- Gunakan kata kerja sehari-hari (input, cek, bantu, tanya, coba, catat), bukan kata birokrasi (melaksanakan, menyempurnakan, meningkatkan kualitas)
- HINDARI frasa klise seperti: "sangat bermanfaat", "menambah wawasan", "ilmu baru", "kegiatan berjalan dengan lancar", "sehingga proses berjalan dengan baik"
- Contoh kontras:
  KAKU (hindari): "Saya melakukan input data karyawan ke dalam sistem HRIS dengan baik dan tepat."
  NATURAL (contoh): "Hari ini saya input data karyawan ke HRIS, dibantu mentor sampai selesai."
- Setiap bagian HARUS antara 110-150 karakter (tidak boleh kurang dari 110, tidak boleh lebih dari 150)
- Jangan mengarang aktivitas yang tidak disebutkan
- Jangan mengulang isi secara berlebihan
- Pertahankan konteks kegiatan asli

FORMAT OUTPUT - Jawab HANYA dalam JSON valid (tanpa markdown, tanpa backtick):
{
  "uraian": "...",
  "pembelajaran": "...",
  "kendala": "..."
}

PANDUAN PER BAGIAN:

1. "uraian" - Uraian Aktivitas:
Kembangkan ringkasan menjadi deskripsi aktivitas yang detail dan kronologis. Jelaskan apa yang dilakukan, bagaimana prosesnya, dan hasilnya.

2. "pembelajaran" - Pembelajaran yang Diperoleh:
Susun pemahaman atau keterampilan yang secara wajar berkaitan dengan aktivitas tersebut. Fokus pada insight, skill teknis, atau soft skill yang didapat.

3. "kendala" - Kendala yang Dialami:
- Jika informasi "KENDALA HARI INI" disertakan di pesan user: kembangkan informasi ITU untuk bagian "kendala" — jangan mengarang tambahan di luar itu
- Jika TIDAK disertakan: tuliskan keterangan bahwa tidak ada kendala pada pelaksanaan kegiatan hari ini dan semuanya berjalan lancar — JANGAN mengarang kendala apa pun`
      }]
    },
    contents: [{
      parts: [{
        text: `Ringkasan kegiatan hari ini:\n${kegiatan}` + (kendalaInfo ? `\n\nKENDALA HARI INI — kembangkan ini untuk bagian "kendala", jangan mengarang di luar informasi ini:\n${kendalaInfo}` : '')
      }]
    }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048
    }
  };
}

async function callGemini(apiKey, kegiatan, kendalaInfo) {
  // One request per model, no waiting: 503/429/404 immediately falls to the next model
  const failures = [];

  for (const model of GEMINI_MODELS) {
    let response;
    try {
      response = await fetchWithTimeout(GEMINI_ENDPOINT(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(buildPrompt(kegiatan, kendalaInfo))
      });
    } catch (e) {
      if (e?.name === 'AbortError') {
        failures.push(`${model} (timeout)`);
        continue;
      }
      throw e;
    }

    if (response.ok) {
      return processResponse(response);
    }

    // 503/429: overloaded; 404: model not available to this account — switch immediately
    if (response.status !== 503 && response.status !== 429 && response.status !== 404) {
      const err = await response.text();
      throw new Error(`API Error ${response.status}: ${err}`);
    }

    failures.push(`${model} (${response.status})`);
  }

  throw new Error(`Semua model gagal — ${failures.join(', ')}. Coba lagi nanti.`);
}

async function processResponse(response) {
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Response AI kosong');

  // Parse JSON — strip markdown code fences if present
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  let result;
  try {
    result = JSON.parse(cleaned);
  } catch (e) {
    // Try to fix truncated JSON by closing open strings and braces
    let fixed = cleaned;
    const quoteCount = (fixed.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) fixed += '"';
    if (!fixed.trimEnd().endsWith('}')) fixed += '}';
    try {
      result = JSON.parse(fixed);
    } catch (e2) {
      throw new Error('AI menghasilkan format yang tidak valid. Coba generate ulang.');
    }
  }

  // Structure check only — length is handled per-section by top-up (see generateReport)
  for (const key of ['uraian', 'pembelajaran', 'kendala']) {
    if (typeof result[key] !== 'string') {
      throw new Error('AI menghasilkan format yang tidak lengkap. Coba generate ulang.');
    }
    if (result[key].length > 150) {
      // Trim to 150 chars at last complete word
      result[key] = result[key].substring(0, 150).replace(/\s+\S*$/, '');
    }
  }

  return result;
}

// Best-effort rewrite of ONE short section: focused single-sentence request, explicit length target
async function topUpSection(apiKey, kegiatan, section, current, kendalaInfo) {
  const prompt = `Tulis SATU kalimat untuk bagian "${section.label}" laporan magang berdasarkan kegiatan berikut.

Kegiatan:
${kegiatan}
${section.key === 'kendala' && kendalaInfo ? `\nKendala yang dilaporkan user (gunakan sebagai bahan, jangan mengarang):\n${kendalaInfo}\n` : ''}
Draf sebelumnya (${current.length} karakter, terlalu pendek — kembangkan tanpa mengubah maknanya):
${current}

ATURAN:
- Bahasa Indonesia, sudut pandang orang pertama ("saya"), nada sopan tapi natural seperti mahasiswa magang sungguhan — bukan kalimat birokrasi kaku
- Hindari frasa klise seperti "sangat bermanfaat" atau "menambah wawasan"
- Panjang HARUS 110-150 karakter termasuk spasi
- Jawab HANYA satu kalimat itu, tanpa JSON, tanpa penjelasan, tanpa tanda kutip`;

  for (const model of GEMINI_MODELS) {
    let response;
    try {
      response = await fetchWithTimeout(GEMINI_ENDPOINT(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: 'Kamu menulis satu kalimat laporan magang dengan panjang karakter yang tepat. Jawab hanya kalimatnya, tanpa format lain.' }]
          },
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 256 }
        })
      });
    } catch (e) {
      continue; // timeout/transport error — best effort, try next model
    }
    if (!response.ok) continue;

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) continue;

    const cleaned = text.trim().replace(/^["']|["']$/g, '').trim();
    if (cleaned.length > 150) {
      return cleaned.substring(0, 150).replace(/\s+\S*$/, '');
    }
    if (cleaned.length > 0) {
      return cleaned;
    }
  }

  return null;
}

// Full pipeline: one complete generation, then silent top-up for short sections.
// Never fails on length — the result is always filled in.
async function generateReport(apiKey, kegiatan, kendalaInfo) {
  const result = await callGemini(apiKey, kegiatan, kendalaInfo);

  for (const section of SECTIONS) {
    if (result[section.key].length < 110) {
      const improved = await topUpSection(apiKey, kegiatan, section, result[section.key], kendalaInfo);
      if (improved && improved.length > result[section.key].length) {
        result[section.key] = improved;
      }
    }
  }

  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'saveKey') {
    (async () => {
      try {
        const res = await fetchWithTimeout(`${GEMINI_API_BASE}/models?pageSize=1`, {
          headers: { 'x-goog-api-key': message.apiKey }
        });
        if (res.ok) {
          await chrome.storage.local.set({ blmApiKey: message.apiKey });
          sendResponse({ ok: true });
          return;
        }
        const err = await res.json().catch(() => ({}));
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          sendResponse({ ok: false, error: 'API key tidak valid — salin ulang dari Google AI Studio.' });
        } else {
          sendResponse({ ok: false, error: `API key ditolak (eror ${res.status}): ${err?.error?.message || 'coba lagi'}` });
        }
      } catch (e) {
        sendResponse({ ok: false, error: 'Tidak bisa menghubungi Google. Cek koneksi internet.' });
      }
    })();
    return true;
  }

  if (message.action === 'filled') {
    (async () => {
      await chrome.storage.local.set({ doneDate: todayKey() });
      clearNotif();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.action === 'markDone') {
    (async () => {
      await markDoneLocal(Boolean(message.done));
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.action === 'dayStatus') {
    (async () => {
      const today = todayKey();
      if (message.date === today) {
        await chrome.storage.local.set({ dayStatus: { date: today, status: message.status } });
        // Calendar truth beats local notes: approved/waiting/libur → no reminder today
        if (DAY_SKIP_RE.test(message.status)) {
          await chrome.storage.local.set({ doneDate: today });
          clearNotif();
        }
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.action === 'testNotif') {
    (async () => {
      const { blmNotifOn } = await chrome.storage.local.get('blmNotifOn');
      if (blmNotifOn === false) {
        sendResponse({ ok: false, error: 'Notifikasi dimatikan — nyalakan dulu di tab Pengingat.' });
        return;
      }
      await chrome.notifications.clear(NOTIF_ID);
      chrome.notifications.create(NOTIF_ID, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Tes notifikasi Monev Assistant',
        message: 'Contoh pengingat: waktunya isi laporan MagangHub.',
        buttons: [{ title: 'Buka form laporan' }],
        requireInteraction: true,
        priority: 2
      });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.action === 'dayHistory') {
    (async () => {
      // Merge into the rolling history map, prune anything older than 31 days
      const { blmDayHist } = await chrome.storage.local.get('blmDayHist');
      const hist = Object.assign({}, blmDayHist, message.entries || {});
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 31);
      for (const d of Object.keys(hist)) {
        if (d < todayKey(cutoff)) delete hist[d];
      }
      await chrome.storage.local.set({ blmDayHist: hist });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.action === 'generate') {
    (async () => {
      try {
        const { blmApiKey } = await chrome.storage.local.get('blmApiKey');
        if (!blmApiKey) {
          sendResponse({ ok: false, error: 'API key belum diatur' });
          return;
        }
        const result = await generateReport(blmApiKey, message.kegiatan, message.kendalaInfo);
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});

// Clicking the extension icon toggles the floating panel (no action popup)
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !tab.url?.includes('monev.maganghub.kemnaker.go.id')) return;

  const toggle = () => chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' }, () => void chrome.runtime.lastError);

  chrome.tabs.sendMessage(tab.id, { action: 'ping' }, () => {
    if (!chrome.runtime.lastError) {
      toggle();
      return;
    }
    // Page predates the extension reload — inject, then toggle
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }, () => {
      void chrome.runtime.lastError;
      toggle();
    });
  });
});
