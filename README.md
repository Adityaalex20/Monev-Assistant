# Monev Assistant

Ekstensi Chrome untuk AI auto-fill form laporan magang di [MagangHub Kemnaker](https://monev.maganghub.kemnaker.go.id/).

## Fitur

- Auto-fill form laporan magang dengan bantuan AI (Gemini)
- Reminder otomatis via alarm & notifikasi
- Info hari libur nasional dari [date.nager.at](https://date.nager.at/)

## Cara Install

1. Download / clone repo ini
2. Buka `chrome://extensions` di Chrome
3. Aktifkan **Developer mode** (kanan atas)
4. Klik **Load unpacked**, pilih folder ini
5. Ekstensi "Monev Assistant" siap dipakai

## Izin yang Dipakai

| Izin | Kebutuhan |
|------|-----------|
| `activeTab`, `scripting` | Mengisi form di halaman monev |
| `storage` | Menyimpan pengaturan & data |
| `alarms`, `notifications` | Reminder laporan |
| `host_permissions` | Google Gemini API, MagangHub, date.nager.at |
