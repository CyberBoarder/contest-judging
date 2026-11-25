// 공모전 온라인 심사평가 시스템 서버 (Node.js 18 이상, 외부 패키지 없음)
// 실행: JUDGE_CODE=심사코드 ADMIN_PASSWORD=관리자비번 node server.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./public/criteria.js');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const JUDGE_CODE = process.env.JUDGE_CODE || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
// 구글 폼 응답 불러오기 (선택): 응답 시트에 배포한 Apps Script 웹 앱 주소와 비밀 키
const FORM_SYNC_URL = process.env.FORM_SYNC_URL || '';
const FORM_SYNC_KEY = process.env.FORM_SYNC_KEY || '';
const IMPORT_DEADLINE = process.env.IMPORT_DEADLINE || '2026-11-25T23:59:59+09:00';   // 이후 제출은 "마감 후"로 표시

if (!JUDGE_CODE || !ADMIN_PASSWORD) {
  console.error('환경변수 JUDGE_CODE(심사위원 접속 코드)와 ADMIN_PASSWORD(관리자 비밀번호)를 지정하세요.');
  process.exit(1);
}

// ---------- 저장소 (JSON 파일, 원자적 저장 + 직전본 백업) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { entries: [], submissions: {}, settings: {}, log: [] };
if (fs.existsSync(DB_FILE)) db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
db.settings.judges = db.settings.judges || [];
db.settings.rounds = db.settings.rounds && db.settings.rounds.length ? db.settings.rounds : C.DEFAULT_ROUNDS.map((r) => ({ ...r }));
for (const e of db.entries) {           // 이전 형식(r1/r2) 변환
  if (!e.targets) { e.targets = { R1: e.r1 !== false, R2: e.r2 === true }; delete e.r1; delete e.r2; }
}

// 처음 실행할 때(db.json 없음) seed/entries.json의 출품작·심사위원 명단을 자동 등록
const SEED_FILE = path.join(__dirname, 'seed', 'entries.json');
let seeded = 0;
if (!fs.existsSync(DB_FILE) && fs.existsSync(SEED_FILE)) {
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const first = db.settings.rounds[0].id;
  db.entries = (seed.entries || []).map((e, i) => ({
    id: i + 1, level: e.level, title: e.title || '', leader: e.leader || '', dept: e.dept || '',
    advisor: e.advisor || '', note: e.note || '', links: e.links || [], order: Number(e.order) || 0,
    targets: Object.fromEntries(db.settings.rounds.map((r) => [r.id, r.id === first])),
  }));
  if (Array.isArray(seed.judges)) db.settings.judges = seed.judges;
  seeded = db.entries.length;
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, DB_FILE + '.bak');
  fs.renameSync(tmp, DB_FILE);
}
function addLog(who, action, detail) {
  db.log.push({ at: new Date().toISOString(), who, action, detail });
  if (db.log.length > 2000) db.log = db.log.slice(-2000);
}

// ---------- 공통 ----------
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > 2e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});
const judgeName = (req) => decodeURIComponent(req.headers['x-judge-name'] || '').trim();
function judgeOk(req) {
  const name = judgeName(req);
  if (!name || !safeEq(req.headers['x-judge-code'] || '', JUDGE_CODE)) return null;
  if (db.settings.judges.length && !db.settings.judges.includes(name)) return null;
  return name;
}
const adminOk = (req) => safeEq(req.headers['x-admin-pass'] || '', ADMIN_PASSWORD);
const subKey = (round, entryId, judge) => `${round}|${entryId}|${judge}`;
const getRound = (id) => db.settings.rounds.find((r) => r.id === id);
const roundIndex = (id) => db.settings.rounds.findIndex((r) => r.id === id);
// 첫 심사 구분은 기본 대상(체크 해제 시 제외), 이후 심사 구분은 진출 지정된 출품작만 대상
const inRound = (e, id) => (roundIndex(id) === 0 ? e.targets?.[id] !== false : e.targets?.[id] === true);

// ---------- 결과 집계 (세부계획서 5.3.4, 5.4) ----------
function computeResults(rid) {
  const round = getRound(rid);
  const out = {};
  for (const level of Object.keys(C.LEVELS)) {
    const items = C.itemsFor(level, round);
    const rows = db.entries.filter((e) => e.level === level && inRound(e, rid)).map((e) => {
      const subs = Object.values(db.submissions).filter((s) => s.round === rid && s.entryId === e.id);
      const scored = subs.filter((s) => !s.recuse);
      const avg = (fn) => (scored.length ? scored.reduce((a, s) => a + fn(s), 0) / scored.length : null);
      const itemAvg = {};
      for (const it of items) itemAvg[it.key] = avg((s) => Number(s.scores[it.key] || 0));
      let verify = null;
      if (C.needsVerify(level, round)) {
        const v = scored.filter((s) => s.verify);
        const passCount = v.filter((s) => C.VERIFY_ITEMS.every((vi) => s.verify[vi.key] === true)).length;
        verify = { judged: v.length, pass: passCount, passed: v.length > 0 && passCount * 2 > v.length };
      }
      return {
        id: e.id, title: e.title, leader: e.leader, dept: e.dept,
        judges: subs.map((s) => ({ judge: s.judge, total: s.recuse ? null : s.total, recuse: !!s.recuse })),
        scoredCount: scored.length, recuseCount: subs.length - scored.length,
        average: avg((s) => s.total), itemAvg, verify,
      };
    });
    const tb = C.TIE_BREAK[level];
    rows.sort((a, b) => {
      const d = (b.average ?? -1) - (a.average ?? -1);
      if (Math.abs(d) > 1e-9) return d;
      for (const k of tb) { const x = (b.itemAvg[k] ?? -1) - (a.itemAvg[k] ?? -1); if (Math.abs(x) > 1e-9) return x; }
      return 0;
    });
    let picked = 0;
    rows.forEach((r, i) => {
      r.rank = r.average == null ? null : i + 1;
      const eligible = r.average != null && (!r.verify || r.verify.passed);
      if (r.average == null) r.result = '미채점';
      else if (eligible && picked < round.count) { picked++; r.result = round.mode === 'award' ? `${picked}등` : '진출'; }
      else r.result = r.verify && !r.verify.passed ? '작동검증 미통과' : round.mode === 'award' ? '-' : '미진출';
    });
    out[level] = rows;
  }
  return out;
}

function resultsCsv(rid) {
  const res = computeResults(rid);
  const judges = [...new Set(Object.values(db.submissions).filter((s) => s.round === rid).map((s) => s.judge))];
  const head = ['분야', '번호', '결과물명', '대표자', '학과', ...judges, '평균', '순위', '작동검증', '결과'];
  const lines = [head];
  for (const [lv, rows] of Object.entries(res)) {
    for (const r of rows) {
      lines.push([C.LEVELS[lv].name, r.id, r.title, r.leader, r.dept,
        ...judges.map((j) => { const x = r.judges.find((y) => y.judge === j); return !x ? '' : x.recuse ? '회피' : x.total; }),
        r.average == null ? '' : r.average.toFixed(2), r.rank ?? '',
        r.verify ? `${r.verify.passed ? '통과' : '미통과'}(${r.verify.pass}/${r.verify.judged})` : '',
        r.result]);
    }
  }
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + lines.map((l) => l.map(esc).join(',')).join('\r\n');
}

// ---------- 입력 검증 ----------
const str = (v, n = 300) => String(v ?? '').trim().slice(0, n);
function cleanEntry(e, i) {
  const level = ['L1', 'L2', 'L3'].includes(e.level) ? e.level : null;
  if (!level) throw new Error(`${i + 1}번째 출품작의 분야가 올바르지 않습니다.`);
  const targets = {};
  for (const r of db.settings.rounds) targets[r.id] = e.targets?.[r.id] === undefined ? roundIndex(r.id) === 0 : !!e.targets[r.id];
  return {
    id: Number(e.id) || 0, level,
    title: str(e.title) || '(결과물명 미입력)', leader: str(e.leader, 80), dept: str(e.dept, 80),
    advisor: str(e.advisor, 80), note: str(e.note, 500),
    links: (Array.isArray(e.links) ? e.links : []).slice(0, 20)
      .map((l) => ({ label: str(l.label, 40) || '자료', url: str(l.url, 1000) }))
      .filter((l) => /^https?:\/\//i.test(l.url)),
    targets, order: Number(e.order) || 0,
  };
}

function cleanRounds(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('심사 구분을 1개 이상 두어야 합니다.');
  const used = new Set();
  const rounds = list.slice(0, 6).map((r, i) => {
    let id = str(r.id, 20).replace(/[^A-Za-z0-9_-]/g, '');
    if (!id || used.has(id)) { let n = i + 1; while (used.has(`R${n}`) || list.some((x) => x !== r && x.id === `R${n}`)) n++; id = `R${n}`; }
    used.add(id);
    const name = str(r.name, 40);
    if (!name) throw new Error(`${i + 1}번째 심사 구분의 이름을 입력하세요.`);
    const count = Math.max(1, Math.min(30, Number(r.count) || 1));
    return { id, name, date: str(r.date, 40), basis: r.basis === 'plan' ? 'plan' : 'demo', verify: !!r.verify, mode: r.mode === 'award' ? 'award' : 'advance', count };
  });
  const removed = db.settings.rounds.filter((r) => !used.has(r.id));
  for (const r of removed) {
    const n = Object.values(db.submissions).filter((s) => s.round === r.id).length;
    if (n) throw new Error(`"${r.name}"에 제출된 심사표가 ${n}건 있어 삭제할 수 없습니다. 먼저 제출을 취소하세요.`);
  }
  return rounds;
}

function validateSubmission(body, judge) {
  const round = getRound(body.round);
  if (!round) throw new Error('심사 구분이 올바르지 않습니다.');
  const entry = db.entries.find((e) => e.id === Number(body.entryId));
  if (!entry || !inRound(entry, round.id)) throw new Error('이 심사 구분의 대상 출품작이 아닙니다.');
  const key = subKey(round.id, entry.id, judge);
  if (db.submissions[key]) throw new Error('이미 제출한 심사표입니다. 수정이 필요하면 관리자에게 제출 취소를 요청하세요.');
  const sub = { round: round.id, entryId: entry.id, level: entry.level, judge, recuse: !!body.recuse, submittedAt: new Date().toISOString() };
  if (sub.recuse) {
    sub.recuseReason = str(body.recuseReason, 200);
    if (!sub.recuseReason) throw new Error('회피 사유(관계)를 적어 주세요.');
    sub.scores = {}; sub.total = null;
  } else {
    sub.scores = {};
    for (const it of C.itemsFor(entry.level, round)) {
      const v = Number(body.scores?.[it.key]);
      if (!Number.isInteger(v) || v < 0 || v > it.max) throw new Error(`"${it.label}" 점수는 0~${it.max} 사이의 정수로 입력하세요.`);
      sub.scores[it.key] = v;
    }
    sub.total = Object.values(sub.scores).reduce((a, b) => a + b, 0);
    if (C.needsVerify(entry.level, round)) {
      const v = body.verify || {};
      sub.verify = {};
      for (const vi of C.VERIFY_ITEMS) {
        if (typeof v[vi.key] !== 'boolean') throw new Error(`작동 검증 "${vi.label}" 통과 여부를 선택하세요.`);
        sub.verify[vi.key] = v[vi.key];
      }
      const num = (x) => (x === '' || x == null || isNaN(Number(x)) ? null : Number(x));
      sub.verify.timeBefore = num(v.timeBefore); sub.verify.timeAfter = num(v.timeAfter);
      sub.verify.accuracy = v.accuracy === 'drop' ? 'drop' : v.accuracy === 'keep' ? 'keep' : null;
      sub.verify.accuracyReason = str(v.accuracyReason, 200);
      sub.verify.notes = Object.fromEntries(C.VERIFY_ITEMS.map((vi) => [vi.key, str(v.notes?.[vi.key])]));
    }
  }
  sub.comment = str(body.comment, 2000);
  return { key, sub };
}

// ---------- 구글 폼 응답 불러오기 ----------
// 원천: ① Apps Script 웹 앱(FORM_SYNC_URL) 또는 ② 응답 시트에서 내려받은 CSV.
// 학번·연락처·이메일은 읽지 않고 버림. 같은 분야·같은 대표자 제출은 1건(마지막 제출본)으로 묶음.
const LEVEL_WORDS = [['L1', /lv\.?\s*1|level\s*1|아이디어/i], ['L2', /lv\.?\s*2|level\s*2|해커톤/i], ['L3', /lv\.?\s*3|level\s*3|poc|캡스톤|ic-pbl/i]];
const TITLE_PLACEHOLDER = '(결과물명은 제출 신청서 참조)';

function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  text = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter((r) => r.some((v) => v.trim())).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}
function parseTime(v) {
  const m = String(v || '').match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*(오전|오후)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {   // 구글 시트 한국어 표기(KST): 2026. 11. 19 오후 12:47:06
    let h = Number(m[5]);
    if (m[4] === '오후' && h < 12) h += 12;
    if (m[4] === '오전' && h === 12) h = 0;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], h - 9, +m[6], +(m[7] || 0)));
  }
  const d = v ? new Date(v) : null;
  return d && !isNaN(d) ? d : null;
}
const kstLabel = (d) => {
  if (!d) return '시각 미상';
  const k = new Date(d.getTime() + 9 * 3600e3), p = (n) => String(n).padStart(2, '0');
  return `${k.getUTCMonth() + 1}.${k.getUTCDate()}. ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
};
const formKey = (level, leader) => `${level}|${String(leader || '').replace(/\s+/g, '').toLowerCase()}`;
function normalizeRecord(rec) {
  const col = (prefix) => { const k = Object.keys(rec).find((h) => h.replace(/\s/g, '').startsWith(prefix)); return k ? String(rec[k] ?? '').trim() : ''; };
  const lv = LEVEL_WORDS.find(([, re]) => re.test(col('참가분야')));
  const leader = str(col('대표자성명'), 80);
  if (!lv || !leader) return null;
  let title = str(col('결과물'));
  const titleIsFile = /\d{8,}/.test(title) || /\.(pdf|hwpx?|docx?|pptx?|zip)$/i.test(title);
  if (titleIsFile) title = '';
  // 팀원 명단에서 학번이 없는 줄(대표자 제외) = 지도교수로 추정
  const advisorLine = col('팀원명단').split(/\r?\n/).map((s) => s.trim())
    .filter((s) => s && !/\d{6,}/.test(s) && !/01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}/.test(s) && !/@/.test(s))
    .map((s) => s.replace(/[「」『』"']/g, '').replace(/^\s*지도\s*교수\s*[:：]?\s*/, '').split(/[\/,(]/)[0].replace(/\s*교수(님)?\s*$/, '').trim())
    .find((n) => n && n !== leader && !/\d/.test(n)) || '';
  const dept = col('대표자학과');
  const urls = (s) => s.match(/https?:\/\/[^\s,]+/g) || [];
  return {
    at: parseTime(col('타임스탬프')), level: lv[0], title, titleIsFile, leader,
    dept: /\d{6,}/.test(dept) ? '' : str(dept, 80),   // 학과 칸에 학번을 적은 경우 버림
    advisor: str(advisorLine, 80),
    files: [...new Set([...urls(col('제출파일')), ...urls(col('대용량'))])],
  };
}

async function fetchFormRecords() {
  if (!FORM_SYNC_URL || !FORM_SYNC_KEY) throw new Error('서버에 FORM_SYNC_URL·FORM_SYNC_KEY가 설정되지 않았습니다. "CSV 파일로 불러오기"를 사용하세요.');
  const u = new URL(FORM_SYNC_URL);
  u.searchParams.set('key', FORM_SYNC_KEY);
  let text;
  try { text = await (await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(30000) })).text(); }
  catch (e) { throw new Error(`Apps Script에 연결하지 못했습니다(${e.message}).`); }
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('Apps Script 응답을 읽지 못했습니다. 웹 앱 배포의 액세스 권한이 "모든 사용자"인지, 주소가 /exec로 끝나는지 확인하세요.'); }
  if (j.error) throw new Error(`Apps Script: ${j.error}`);
  if (!Array.isArray(j.rows)) throw new Error('Apps Script 응답 형식이 올바르지 않습니다.');
  return j.rows;
}

function buildImportPlan(records, includeLate) {
  const deadline = IMPORT_DEADLINE ? new Date(IMPORT_DEADLINE) : null;
  const recs = records.map(normalizeRecord).filter(Boolean);
  const groups = new Map();
  for (const r of recs) { const k = formKey(r.level, r.leader); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const plan = { total: records.length, skipped: records.length - recs.length, late: 0, add: [], update: [], unchanged: 0, deadline: IMPORT_DEADLINE };
  for (const [key, subs] of groups) {
    subs.sort((a, b) => (a.at?.getTime() || 0) - (b.at?.getTime() || 0));
    const isLate = (r) => !!(deadline && r.at && r.at > deadline);
    const ok = subs.filter((r) => includeLate || !isLate(r));
    plan.late += subs.filter(isLate).length;
    if (!ok.length) continue;
    const last = ok[ok.length - 1];
    const lateFlag = ok.some(isLate);
    const existing = db.entries.find((e) => formKey(e.level, e.leader) === key);
    if (existing) {
      const have = new Set((existing.links || []).map((l) => l.url));
      const newLinks = [];
      for (const r of ok) {
        const fresh = r.files.filter((u) => !have.has(u));
        fresh.forEach((u, i) => { have.add(u); newLinks.push({ label: `추가 제출(${kstLabel(r.at)})${fresh.length > 1 ? ` ${i + 1}` : ''}`, url: u }); });
      }
      if (newLinks.length) plan.update.push({ key, id: existing.id, level: existing.level, title: existing.title, leader: existing.leader, newLinks, lastAt: last.at, late: lateFlag });
      else plan.unchanged++;
    } else {
      const links = last.files.map((u, i) => ({ label: `제출자료${i + 1}`, url: u }));
      for (const r of ok.slice(0, -1).reverse()) r.files.forEach((u, i) => {
        if (!links.some((l) => l.url === u)) links.push({ label: `이전 제출(${kstLabel(r.at)})${r.files.length > 1 ? ` ${i + 1}` : ''}`, url: u });
      });
      const notes = [];
      if (ok.length > 1) notes.push(`같은 팀이 ${ok.length}회 제출하여 마지막 제출본(${kstLabel(last.at)}) 기준으로 정리함(이전 제출 파일도 연결).`);
      if (!last.title) notes.push('접수 폼 결과물명 칸이 비어 있거나 파일명이 입력되어 있음. 결과물명은 제출 신청서에서 확인.');
      if (last.advisor) notes.push('지도교수는 팀원 명단에서 추정함.');
      if (lateFlag) notes.push(`마감 후 제출 포함(${kstLabel(last.at)}).`);
      plan.add.push({ key, level: last.level, title: last.title || TITLE_PLACEHOLDER, leader: last.leader, dept: last.dept, advisor: last.advisor, links: links.slice(0, 20), note: notes.join(' '), lastAt: last.at, count: ok.length, late: lateFlag });
    }
  }
  return plan;
}

async function importRecords(b) {
  if (b.source === 'csv') {
    if (!b.csv) throw new Error('CSV 내용이 비어 있습니다.');
    return parseCsv(b.csv);
  }
  return fetchFormRecords();
}

function applyImportPlan(plan, exclude) {
  const skip = new Set(Array.isArray(exclude) ? exclude : []);
  const first = db.settings.rounds[0].id;
  let maxId = db.entries.reduce((m, e) => Math.max(m, e.id), 0);
  let added = 0, updated = 0;
  for (const a of plan.add) {
    if (skip.has(a.key)) continue;
    const order = db.entries.filter((e) => e.level === a.level).reduce((m, e) => Math.max(m, Number(e.order) || 0), 0) + 1;
    db.entries.push({
      id: ++maxId, level: a.level, title: a.title, leader: a.leader, dept: a.dept, advisor: a.advisor, note: a.note, links: a.links, order,
      targets: Object.fromEntries(db.settings.rounds.map((r) => [r.id, r.id === first])),
    });
    added++;
  }
  for (const u of plan.update) {
    if (skip.has(u.key)) continue;
    const e = db.entries.find((x) => x.id === u.id);
    if (!e) continue;
    e.links = [...(e.links || []), ...u.newLinks].slice(0, 20);
    updated++;
  }
  return { added, updated };
}

// ---------- 라우팅 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    try {
      // 접속 화면에 필요한 공개 정보 (심사 구분, 등록된 심사위원 성함)
      if (p === '/api/meta' && req.method === 'GET') return send(res, 200, { rounds: db.settings.rounds, judges: db.settings.judges });

      if (p === '/api/judge/login' && req.method === 'POST') {
        const b = await readBody(req);
        const name = str(b.name, 40);
        if (!name) return send(res, 400, { error: '성함을 입력하세요.' });
        if (!safeEq(b.code || '', JUDGE_CODE)) return send(res, 401, { error: '접속 코드가 올바르지 않습니다.' });
        if (db.settings.judges.length && !db.settings.judges.includes(name)) return send(res, 403, { error: '등록된 심사위원 명단에 없는 성함입니다. 관리자에게 문의하세요.' });
        return send(res, 200, { ok: true, name });
      }

      if (p === '/api/judge/sheet' && req.method === 'GET') {
        const judge = judgeOk(req); if (!judge) return send(res, 401, { error: '심사위원 인증이 필요합니다.' });
        const round = getRound(url.searchParams.get('round'));
        if (!round) return send(res, 400, { error: '심사 구분이 변경되었습니다. 다시 선택해 주세요.' });
        const entries = db.entries.filter((e) => inRound(e, round.id))
          .sort((a, b) => a.level.localeCompare(b.level) || (a.order || 999) - (b.order || 999) || a.id - b.id);
        const mine = {};
        for (const s of Object.values(db.submissions)) if (s.round === round.id && s.judge === judge) mine[s.entryId] = s;
        return send(res, 200, { judge, round, entries, mine });
      }

      if (p === '/api/judge/submit' && req.method === 'POST') {
        const judge = judgeOk(req); if (!judge) return send(res, 401, { error: '심사위원 인증이 필요합니다.' });
        const { key, sub } = validateSubmission(await readBody(req), judge);
        db.submissions[key] = sub;
        addLog(judge, 'submit', key);
        save();
        return send(res, 200, { ok: true, submission: sub });
      }

      // ----- 관리자 -----
      if (p.startsWith('/api/admin/')) {
        if (!adminOk(req)) return send(res, 401, { error: '관리자 비밀번호가 올바르지 않습니다.' });

        if (p === '/api/admin/state' && req.method === 'GET') {
          return send(res, 200, { entries: db.entries, submissions: db.submissions, settings: db.settings,
            importConfig: { form: !!(FORM_SYNC_URL && FORM_SYNC_KEY), deadline: IMPORT_DEADLINE } });
        }

        // 구글 폼 응답 불러오기: 미리보기(저장 안 함) → 반영(선택 제외 후 저장)
        if (p === '/api/admin/import/preview' && req.method === 'POST') {
          const b = await readBody(req);
          return send(res, 200, buildImportPlan(await importRecords(b), !!b.includeLate));
        }
        if (p === '/api/admin/import/apply' && req.method === 'POST') {
          const b = await readBody(req);
          const plan = buildImportPlan(await importRecords(b), !!b.includeLate);
          const r = applyImportPlan(plan, b.exclude);
          addLog('admin', 'import', `${b.source === 'csv' ? 'CSV' : '구글 폼'} 신규 ${r.added}건, 파일 추가 ${r.updated}건`);
          save();
          return send(res, 200, { ok: true, ...r, entries: db.entries });
        }

        if (p === '/api/admin/entries' && req.method === 'PUT') {
          const b = await readBody(req);
          if (!Array.isArray(b.entries)) return send(res, 400, { error: 'entries' });
          let maxId = db.entries.reduce((m, e) => Math.max(m, e.id), 0);
          const cleaned = b.entries.map(cleanEntry).map((e) => { if (!e.id) e.id = ++maxId; return e; });
          const ids = new Set(cleaned.map((e) => e.id));
          const orphan = Object.values(db.submissions).filter((s) => !ids.has(s.entryId));
          if (orphan.length) return send(res, 409, { error: `삭제하려는 출품작에 제출된 심사표가 ${orphan.length}건 있습니다. 먼저 심사 현황에서 제출을 취소하세요.` });
          db.entries = cleaned;
          addLog('admin', 'entries', `${cleaned.length}건`);
          save();
          return send(res, 200, { ok: true, entries: db.entries });
        }

        if (p === '/api/admin/settings' && req.method === 'PUT') {
          const b = await readBody(req);
          if (b.rounds) {
            db.settings.rounds = cleanRounds(b.rounds);
            for (const e of db.entries) for (const r of db.settings.rounds) if (e.targets[r.id] === undefined) e.targets[r.id] = roundIndex(r.id) === 0;
          }
          if (b.judges) db.settings.judges = [...new Set(b.judges.map((s) => str(s, 40)).filter(Boolean))].slice(0, 30);
          addLog('admin', 'settings', JSON.stringify({ rounds: db.settings.rounds.map((r) => r.name), judges: db.settings.judges }));
          save();
          return send(res, 200, { ok: true, settings: db.settings });
        }

        if (p === '/api/admin/submission' && req.method === 'DELETE') {
          const key = url.searchParams.get('key');
          if (!db.submissions[key]) return send(res, 404, { error: '없는 제출입니다.' });
          delete db.submissions[key];
          addLog('admin', 'unsubmit', key);
          save();
          return send(res, 200, { ok: true });
        }

        if (p === '/api/admin/results' && req.method === 'GET') {
          const rid = url.searchParams.get('round');
          if (!getRound(rid)) return send(res, 400, { error: '심사 구분이 없습니다.' });
          return send(res, 200, { round: getRound(rid), results: computeResults(rid) });
        }

        // 이 심사 구분의 "진출" 결과로 다음 심사 구분 대상 지정
        if (p === '/api/admin/advance' && req.method === 'POST') {
          const b = await readBody(req);
          const i = roundIndex(b.round);
          const next = db.settings.rounds[i + 1];
          if (i < 0 || !next) return send(res, 400, { error: '다음 심사 구분이 없습니다.' });
          if (db.settings.rounds[i].mode !== 'advance') return send(res, 400, { error: '진출팀 선정 방식의 심사 구분이 아닙니다.' });
          const r = computeResults(b.round);
          let n = 0;
          for (const rows of Object.values(r)) for (const row of rows) {
            const e = db.entries.find((x) => x.id === row.id);
            if (e) { e.targets[next.id] = row.result === '진출'; if (e.targets[next.id]) n++; }
          }
          addLog('admin', 'advance', `${b.round}→${next.id} ${n}팀`);
          save();
          return send(res, 200, { ok: true, advanced: n, next: next.name, entries: db.entries });
        }

        if (p === '/api/admin/export' && req.method === 'GET') {
          const rid = url.searchParams.get('round');
          const round = getRound(rid);
          if (!round) return send(res, 400, { error: '심사 구분이 없습니다.' });
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`심사결과_${round.name}.csv`)}`,
          });
          return res.end(resultsCsv(rid));
        }

        if (p === '/api/admin/backup' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="db-backup.json"' });
          return res.end(JSON.stringify(db, null, 2));
        }
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 400, { error: e.message || '요청을 처리하지 못했습니다.' });
    }
  }

  // ----- 정적 파일 -----
  let file = p === '/' ? '/index.html' : p === '/admin' ? '/admin.html' : p;
  file = path.normalize(path.join(PUBLIC_DIR, file));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

if (seeded) { addLog('system', 'seed', `${seeded}건`); save(); console.log(`seed/entries.json에서 출품작 ${seeded}건을 등록했습니다.`); }

http.createServer((req, res) => { handle(req, res).catch((e) => send(res, 500, { error: e.message })); })
  .listen(PORT, HOST, () => console.log(`심사 시스템 실행: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (관리자: /admin)`));
