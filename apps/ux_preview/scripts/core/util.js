'use strict';
/* Core utilities: DOM, escaping, formatting, deterministic randomness and
   browser-native exports (work under file://, no server). */
const NOW = Date.now(), MIN = 6e4, HOUR = 36e5, DAY = 864e5;
const ago = ms => NOW - ms;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cx = (...a) => a.filter(Boolean).join(' ');
const dataAttrs = o => Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== false).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = (p = 'id') => p + '-' + Math.random().toString(36).slice(2, 8);
const clone = o => JSON.parse(JSON.stringify(o));
const fmtNum = n => Number(n).toLocaleString('en-US');
const fmtCompact = n => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
const plural = (n, one, many = one + 's') => `${fmtNum(n)} ${n === 1 ? one : many}`;
const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;
function fmtSize(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return Math.round(b / 1024) + ' KB'; if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB'; return (b / 1073741824).toFixed(1) + ' GB'; }
function rel(ts) {
  const d = Date.now() - ts; if (d < MIN) return 'Just now'; if (d < HOUR) return Math.round(d / MIN) + ' min ago';
  if (d < DAY) return Math.round(d / HOUR) + ' h ago'; if (d < 2 * DAY) return 'Yesterday';
  if (d < 7 * DAY) return Math.floor(d / DAY) + ' days ago'; return fmtDate(ts);
}
function relFuture(ts) { const d = ts - Date.now(); if (d < HOUR) return 'in ' + Math.max(1, Math.round(d / MIN)) + ' min'; if (d < DAY) return 'in ' + Math.round(d / HOUR) + ' h'; return 'in ' + Math.round(d / DAY) + ' days'; }
const fmtDate = ts => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: new Date(ts).getFullYear() === new Date(NOW).getFullYear() ? undefined : 'numeric' });
const fmtDateTime = ts => new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtTime = ts => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
function fmtDuration(ms) { const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + (s % 60) + 's'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
let _seed = 7; const rnd = () => (_seed = (_seed * 16807) % 2147483647) / 2147483647;
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const initials = n => String(n || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const hashOf = s => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;

/* ── Browser-native exports ── */
const fileNameSafe = name => String(name || 'bomesh-export').replace(/[\\/:*?"<>|]/g, '-');
const withExt = (name, ext) => fileNameSafe(name).replace(/\.[^.]+$/, '') + ext;
function saveLocalFile(name, content, type = 'text/plain;charset=utf-8', message = '') {
  const file = fileNameSafe(name);
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.hidden = true; link.href = url; link.download = file;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(message || `Downloaded ${file}`);
}
async function copyText(value, success = 'Copied') {
  const text = String(value ?? '');
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const area = document.createElement('textarea');
      area.value = text; area.setAttribute('readonly', ''); area.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(area); area.select();
      const ok = document.execCommand('copy'); area.remove();
      if (!ok) throw new Error('Copy rejected');
    }
    toast(success);
    return true;
  } catch {
    toast('Couldn’t copy. Select the text and copy it manually.', { tone: 'danger' });
    return false;
  }
}
const csvCell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
function saveCsv(name, rows, message = '') { saveLocalFile(name, '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8', message); }
function saveWord(name, title, bodyHtml, message = '') {
  saveLocalFile(name, `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1>${bodyHtml}</body></html>`, 'application/msword', message);
}
function savePdf(name, title, lines, message = '') {
  const ascii = [title, ...lines].map(l => String(l ?? '').normalize('NFKD').replace(/[^\x20-\x7e]/g, '?').slice(0, 92));
  const pe = v => v.replace(/([\\()])/g, '\\$1');
  const cmds = `BT\n/F1 11 Tf\n72 744 Td\n15 TL\n${ascii.map((l, i) => `(${pe(l)}) Tj${i < ascii.length - 1 ? ' T*' : ''}`).join('\n')}\nET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${cmds.length} >>\nstream\n${cmds}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offs = [0];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  saveLocalFile(name, pdf, 'application/pdf', message);
}
