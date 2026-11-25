'use strict';
const { LEVELS, BASIS_LABEL, MODE_LABEL, itemsFor, needsVerify } = window.CRITERIA;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let pass = (() => { try { return sessionStorage.getItem('adminPass') || ''; } catch { return ''; } })();
let state = { entries: [], submissions: {}, settings: { judges: [], rounds: [] } };
let rows = [];          // 편집 중인 출품작
let roundRows = [];     // 편집 중인 심사 구분
let dirty = false, roundsDirty = false;
let statusRound = null, resultRound = null;

const rounds = () => state.settings.rounds || [];
const roundOf = (id) => rounds().find((r) => r.id === id);
const isTarget = (e, id) => (rounds()[0]?.id === id ? e.targets?.[id] !== false : e.targets?.[id] === true);

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Admin-Pass': pass } });
  if (opts.raw) { if (!res.ok) throw new Error('요청 실패'); return res; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || '서버 오류'), { status: res.status });
  return data;
}

// ---------- 로그인 ----------
$('#login-form').onsubmit = async (ev) => {
  ev.preventDefault();
  pass = $('#pw').value;
  try { await refresh(); try { sessionStorage.setItem('adminPass', pass); } catch {} $('#login').classList.add('hidden'); }
  catch (e) { $('#login-error').textContent = e.message; $('#login-error').classList.remove('hidden'); }
};

async function refresh() {
  state = await api('/api/admin/state');
  if (!dirty) rows = state.entries.map((e) => ({ ...e, targets: { ...e.targets } }));
  if (!roundsDirty) roundRows = rounds().map((r) => ({ ...r }));
  if (!roundOf(statusRound)) statusRound = rounds()[0]?.id;
  if (!roundOf(resultRound)) resultRound = rounds()[0]?.id;
  renderEntries(); renderStatus(); renderResults(); renderRounds(); renderImportHint();
  $('#judges').value = (state.settings.judges || []).join('\n');
}

// ---------- 탭 ----------
const TABS = [['entries', '출품작 관리'], ['status', '심사 현황'], ['results', '결과 집계'], ['settings', '설정(심사위원·심사 구분)']];
let tab = 'entries';
function renderTabs() {
  $('#tabs').innerHTML = TABS.map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" data-k="${k}">${l}</button>`).join('');
  $('#tabs').querySelectorAll('button').forEach((b) => b.onclick = () => {
    tab = b.dataset.k; renderTabs();
    document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== tab));
    if (tab !== 'entries') refresh().catch((e) => alert(e.message));
  });
}
function roundButtons(el, value, onPick) {
  el.innerHTML = rounds().map((r) => `<button class="seg ${r.id === value ? 'on' : ''}" data-r="${r.id}">${esc(r.name)}</button>`).join('');
  el.querySelectorAll('button').forEach((b) => b.onclick = () => onPick(b.dataset.r));
}

// ---------- 출품작 ----------
const linksToText = (links) => (links || []).map((l) => `${l.label}|${l.url}`).join('\n');
const textToLinks = (t) => t.split('\n').map((s) => s.trim()).filter(Boolean).map((s, i) => {
  const [a, b] = s.includes('|') ? s.split('|') : [`자료${i + 1}`, s];
  return { label: a.trim(), url: (b || '').trim() };
});
const newTargets = () => Object.fromEntries(rounds().map((r, i) => [r.id, i === 0]));
function renderEntries() {
  $('#entry-head').innerHTML = `<tr><th class="p-2 text-left">ID</th><th class="p-2 text-left">분야</th><th class="p-2 text-left">결과물명</th><th class="p-2 text-left">대표자</th><th class="p-2 text-left">학과</th><th class="p-2 text-left">지도교수</th><th class="p-2 text-left">자료 링크</th><th class="p-2">순서</th>${rounds().map((r) => `<th class="p-2 whitespace-nowrap" title="${esc(r.name)}">${esc(r.name.replace(/\(.*\)/, ''))}</th>`).join('')}<th class="p-2 text-left">비고</th><th class="p-2"></th></tr>`;
  const input = (i, f, v, cls = '') => `<input data-i="${i}" data-f="${f}" value="${esc(v)}" class="w-full rounded border border-slate-300 py-1 px-1.5 ${cls}"/>`;
  $('#entry-rows').innerHTML = rows.map((e, i) => `<tr class="align-top">
    <td class="p-2 text-slate-400">${e.id || '신규'}</td>
    <td class="p-2"><select data-i="${i}" data-f="level" class="rounded border border-slate-300 py-1">${Object.values(LEVELS).map((l) => `<option value="${l.code}" ${e.level === l.code ? 'selected' : ''}>${l.short}</option>`).join('')}</select></td>
    <td class="p-2">${input(i, 'title', e.title, 'min-w-[16rem]')}</td>
    <td class="p-2">${input(i, 'leader', e.leader, 'min-w-[6rem]')}</td>
    <td class="p-2">${input(i, 'dept', e.dept, 'min-w-[8rem]')}</td>
    <td class="p-2">${input(i, 'advisor', e.advisor, 'min-w-[5rem]')}</td>
    <td class="p-2"><textarea data-i="${i}" data-f="links" rows="2" class="min-w-[14rem] w-full rounded border border-slate-300 py-1 px-1.5 font-mono text-[11px]">${esc(linksToText(e.links))}</textarea></td>
    <td class="p-2 w-14">${input(i, 'order', e.order || '', 'text-center')}</td>
    ${rounds().map((r) => `<td class="p-2 text-center"><input type="checkbox" data-i="${i}" data-t="${r.id}" ${isTarget(e, r.id) ? 'checked' : ''}/></td>`).join('')}
    <td class="p-2">${input(i, 'note', e.note, 'min-w-[10rem]')}</td>
    <td class="p-2"><button data-del="${i}" class="text-rose-500 hover:underline whitespace-nowrap">삭제</button></td></tr>`).join('')
    || `<tr><td colspan="${11 + rounds().length}" class="p-6 text-center text-slate-400">출품작이 없습니다. "+ 출품작 추가" 또는 붙여넣기로 등록하세요.</td></tr>`;
  $('#entry-rows').querySelectorAll('[data-f]').forEach((el) => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
    const r = rows[Number(el.dataset.i)], f = el.dataset.f;
    r[f] = f === 'links' ? textToLinks(el.value) : el.value;
    dirty = true;
  }));
  $('#entry-rows').querySelectorAll('[data-t]').forEach((el) => el.onchange = () => {
    const r = rows[Number(el.dataset.i)];
    r.targets = { ...(r.targets || {}), [el.dataset.t]: el.checked }; dirty = true;
  });
  $('#entry-rows').querySelectorAll('[data-del]').forEach((b) => b.onclick = () => {
    const r = rows[Number(b.dataset.del)];
    if (!confirm(`"${r.title || '신규'}"을(를) 목록에서 뺄까요? (저장해야 반영)`)) return;
    rows.splice(Number(b.dataset.del), 1); dirty = true; renderEntries();
  });
}
$('#add-row').onclick = () => { rows.push({ id: 0, level: 'L2', title: '', leader: '', dept: '', advisor: '', links: [], targets: newTargets(), order: '', note: '' }); dirty = true; renderEntries(); };
$('#save-entries').onclick = async () => {
  try {
    const r = await api('/api/admin/entries', { method: 'PUT', body: JSON.stringify({ entries: rows }) });
    dirty = false; await refresh(); alert(`저장했습니다 (${r.entries.length}건).`);
  } catch (e) { alert(e.message); }
};
const LEVEL_WORDS = [['L1', /lv\.?\s*1|level\s*1|아이디어/i], ['L2', /lv\.?\s*2|level\s*2|해커톤/i], ['L3', /lv\.?\s*3|level\s*3|poc|캡스톤|ic-pbl/i]];
$('#paste-add').onclick = () => {
  const lines = $('#paste').value.split(/\r?\n/).filter((l) => l.trim());
  let n = 0;
  for (const line of lines) {
    const c = line.split('\t');
    const lv = LEVEL_WORDS.find(([, re]) => re.test(c[0] || ''));
    if (!lv) continue;           // 제목 행 등
    rows.push({ id: 0, level: lv[0], title: (c[1] || '').trim(), leader: (c[2] || '').trim(), dept: (c[3] || '').trim(), advisor: (c[4] || '').trim(),
      links: (c[5] || '').split(/[,\s]+/).filter((u) => /^https?:/.test(u)).map((u, i) => ({ label: `제출자료${i + 1}`, url: u })), targets: newTargets(), order: '', note: '' });
    n++;
  }
  dirty = true; renderEntries(); $('#paste').value = '';
  alert(`${n}건을 목록에 추가했습니다. 확인 후 "저장"을 누르세요.`);
};

// ---------- 구글 폼 응답 불러오기 ----------
let importReq = null;   // 미리보기에 쓴 요청(반영 때 같은 원천으로 다시 계산)
const fmtAt = (s) => { if (!s) return ''; const d = new Date(s); return `${d.getMonth() + 1}.${d.getDate()}. ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
function renderImportHint() {
  const c = state.importConfig || {};
  $('#imp-form').disabled = !c.form;
  $('#imp-hint').innerHTML = (c.form
    ? '서버에 연결된 구글 폼 응답 시트에서 접수 목록을 가져옵니다.'
    : '구글 폼 연결(FORM_SYNC_URL·FORM_SYNC_KEY)이 설정되지 않았습니다. 응답 시트에서 <b>파일 &gt; 다운로드 &gt; CSV</b>로 받은 파일을 올리면 같은 방식으로 불러옵니다.')
    + ' 학번·연락처·이메일은 읽지 않습니다. 같은 분야·같은 대표자의 중복 제출은 마지막 제출본 1건으로 묶고, 이미 등록된 출품작은 새 파일 링크만 덧붙입니다.'
    + (c.deadline ? ` 마감 기준: ${esc(fmtAt(c.deadline))}` : '');
}
async function runImportPreview(req) {
  if (dirty && !confirm('저장하지 않은 출품작 수정 내용이 있습니다. 불러오기를 반영하면 수정 내용이 사라집니다. 계속할까요?')) return;
  const box = $('#imp-preview');
  box.classList.remove('hidden'); box.innerHTML = '<p class="text-slate-500">불러오는 중...</p>';
  try {
    importReq = { ...req, includeLate: $('#imp-late').checked };
    const plan = await api('/api/admin/import/preview', { method: 'POST', body: JSON.stringify(importReq) });
    const lvShort = (c) => LEVELS[c]?.short || c;
    const row = (it, kind) => `<tr class="align-top"><td class="p-1.5"><input type="checkbox" data-key="${esc(it.key)}" checked/></td>
      <td class="p-1.5 whitespace-nowrap">${kind === 'add' ? '<b class="text-emerald-700">신규</b>' : '<b class="text-amber-700">파일 추가</b>'}${it.late ? ' <b class="text-rose-600">마감 후</b>' : ''}</td>
      <td class="p-1.5">${esc(lvShort(it.level))}</td><td class="p-1.5">${esc(it.title)}</td><td class="p-1.5 whitespace-nowrap">${esc(it.leader)}</td>
      <td class="p-1.5 whitespace-nowrap">${esc(fmtAt(it.lastAt))}${it.count > 1 ? ` (${it.count}회)` : ''}</td>
      <td class="p-1.5">${(kind === 'add' ? it.links : it.newLinks).map((l) => esc(l.label)).join(', ')}</td></tr>`;
    const items = [...plan.add.map((x) => row(x, 'add')), ...plan.update.map((x) => row(x, 'upd'))];
    box.innerHTML = `<p class="text-slate-700">응답 ${plan.total}건 확인 · 신규 출품작 <b>${plan.add.length}</b>건 · 기존 출품작 파일 추가 <b>${plan.update.length}</b>건 · 변동 없음 ${plan.unchanged}건${plan.late ? ` · 마감 후 제출 ${plan.late}건${importReq.includeLate ? '(포함)' : '(제외)'}` : ''}${plan.skipped ? ` · 분야·대표자 누락으로 제외 ${plan.skipped}건` : ''}</p>`
      + (items.length
        ? `<div class="overflow-x-auto bg-white rounded border border-slate-200"><table class="min-w-full"><thead class="bg-slate-50 text-slate-500"><tr><th></th><th class="p-1.5 text-left">구분</th><th class="p-1.5 text-left">분야</th><th class="p-1.5 text-left">결과물명</th><th class="p-1.5 text-left">대표자</th><th class="p-1.5 text-left">마지막 제출</th><th class="p-1.5 text-left">연결 파일</th></tr></thead><tbody class="divide-y divide-slate-100">${items.join('')}</tbody></table></div>
           <div class="flex gap-2"><button id="imp-apply" class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold">체크한 항목 반영(저장)</button><button id="imp-close" class="px-3 py-1.5 rounded-lg border border-slate-300 bg-white font-semibold">닫기</button></div>`
        : '<p class="text-slate-500">새로 반영할 내용이 없습니다.</p>');
    const close = $('#imp-close'); if (close) close.onclick = () => box.classList.add('hidden');
    const apply = $('#imp-apply');
    if (apply) apply.onclick = async () => {
      const exclude = [...box.querySelectorAll('[data-key]')].filter((c) => !c.checked).map((c) => c.dataset.key);
      try {
        const r = await api('/api/admin/import/apply', { method: 'POST', body: JSON.stringify({ ...importReq, exclude }) });
        dirty = false; await refresh();
        box.innerHTML = `<p class="text-emerald-700 font-semibold">신규 ${r.added}건 등록, 기존 ${r.updated}건에 파일 링크를 추가했습니다. 아래 목록에서 결과물명·지도교수를 확인하세요.</p>`;
      } catch (e) { alert(e.message); }
    };
  } catch (e) { box.innerHTML = `<p class="text-rose-600 font-semibold">${esc(e.message)}</p>`; }
}
$('#imp-form').onclick = () => runImportPreview({ source: 'form' });
$('#imp-csv').onchange = async (ev) => {
  const f = ev.target.files[0]; ev.target.value = '';
  if (f) runImportPreview({ source: 'csv', csv: await f.text() });
};

// ---------- 심사 현황 ----------
function renderStatus() {
  roundButtons($('#status-round'), statusRound, (r) => { statusRound = r; renderStatus(); });
  if (!statusRound) { $('#status-body').innerHTML = ''; return; }
  const subs = Object.entries(state.submissions).filter(([, s]) => s.round === statusRound);
  const judges = [...new Set([...(state.settings.judges || []), ...subs.map(([, s]) => s.judge)])];
  let html = '';
  for (const lv of Object.values(LEVELS)) {
    const list = state.entries.filter((e) => e.level === lv.code && isTarget(e, statusRound));
    if (!list.length) continue;
    html += `<div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-x-auto"><div class="px-4 py-2.5 border-b font-bold text-sm">${lv.badge} ${lv.name} <span class="text-xs text-slate-400 font-normal">${list.length}건</span></div>
    <table class="min-w-full text-xs"><thead class="bg-slate-50 text-slate-500"><tr><th class="p-2 text-left">결과물명(대표자)</th>${judges.map((j) => `<th class="p-2">${esc(j)}</th>`).join('')}</tr></thead><tbody class="divide-y divide-slate-100">
    ${list.map((e) => `<tr><td class="p-2">${esc(e.title)} <span class="text-slate-400">(${esc(e.leader)})</span></td>${judges.map((j) => {
      const k = `${statusRound}|${e.id}|${j}`, s = state.submissions[k];
      if (!s) return '<td class="p-2 text-center text-slate-300">-</td>';
      return `<td class="p-2 text-center whitespace-nowrap"><b class="${s.recuse ? 'text-slate-400' : 'text-indigo-700'}">${s.recuse ? '회피' : s.total}</b> <button data-undo="${esc(k)}" class="text-[11px] text-rose-500 underline ml-1">취소</button></td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  $('#status-body').innerHTML = html || '<p class="text-sm text-slate-400">이 심사 구분의 대상 출품작이 없습니다.</p>';
  $('#status-body').querySelectorAll('[data-undo]').forEach((b) => b.onclick = async () => {
    if (!confirm('이 제출을 취소할까요? 심사위원이 다시 입력·제출할 수 있게 됩니다.')) return;
    try { await api(`/api/admin/submission?key=${encodeURIComponent(b.dataset.undo)}`, { method: 'DELETE' }); await refresh(); } catch (e) { alert(e.message); }
  });
}
$('#refresh').onclick = () => refresh().catch((e) => alert(e.message));

// ---------- 결과 ----------
async function renderResults() {
  roundButtons($('#result-round'), resultRound, (r) => { resultRound = r; renderResults(); });
  const round = roundOf(resultRound);
  if (!round) { $('#result-body').innerHTML = ''; return; }
  const idx = rounds().indexOf(round), next = rounds()[idx + 1];
  $('#advance').classList.toggle('hidden', !(round.mode === 'advance' && next));
  if (next) $('#advance').textContent = `이 결과로 "${next.name}" 진출팀 지정`;
  let data;
  try { data = await api(`/api/admin/results?round=${encodeURIComponent(resultRound)}`); } catch { return; }
  let html = `<p class="text-xs text-slate-600 bg-white rounded-lg border border-slate-200 px-3 py-2"><b>${esc(round.name)}</b> · ${BASIS_LABEL[round.basis]} · ${MODE_LABEL[round.mode]} · 분야별 ${round.count}팀${round.verify ? ' · 해커톤·PoC 작동 검증 적용' : ''}</p>`;
  for (const lv of Object.values(LEVELS)) {
    const list = data.results[lv.code] || [];
    if (!list.length) { html += `<div class="bg-white rounded-xl border border-slate-200 p-4 text-sm"><b>${lv.badge} ${lv.name}</b> <span class="text-slate-400 ml-2">대상 출품작 없음 (적격 출품작이 없으면 해당 부문 미선정)</span></div>`; continue; }
    const items = itemsFor(lv.code, round);
    const verify = needsVerify(lv.code, round);
    html += `<div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-x-auto"><div class="px-4 py-2.5 border-b font-bold text-sm">${lv.badge} ${lv.name} <span class="ml-2 text-xs font-normal text-slate-400">${esc(lv.desc)}</span></div>
    <table class="min-w-full text-xs"><thead class="bg-slate-50 text-slate-500"><tr><th class="p-2">순위</th><th class="p-2 text-left">결과물명(대표자)</th><th class="p-2">위원별 점수</th>${items.map((it) => `<th class="p-2">${esc(it.label)}<br><span class="font-normal">평균/${it.max}</span></th>`).join('')}<th class="p-2">평균</th>${verify ? '<th class="p-2">작동 검증</th>' : ''}<th class="p-2">결과</th></tr></thead><tbody class="divide-y divide-slate-100">
    ${list.map((r) => `<tr class="${/진출|등/.test(r.result) ? 'bg-emerald-50/60' : ''}"><td class="p-2 text-center font-bold">${r.rank ?? '-'}</td><td class="p-2">${esc(r.title)} <span class="text-slate-400">(${esc(r.leader)})</span></td>
      <td class="p-2 text-center whitespace-nowrap">${r.judges.map((j) => `<span title="${esc(j.judge)}" class="inline-block px-1.5 rounded bg-slate-100 mr-1">${j.recuse ? '회피' : j.total}</span>`).join('') || '-'}</td>
      ${items.map((it) => `<td class="p-2 text-center">${r.itemAvg[it.key] == null ? '-' : r.itemAvg[it.key].toFixed(1)}</td>`).join('')}
      <td class="p-2 text-center font-bold text-indigo-700">${r.average == null ? '-' : r.average.toFixed(2)}</td>
      ${verify ? `<td class="p-2 text-center">${r.verify ? `${r.verify.passed ? '<b class="text-emerald-600">통과</b>' : '<b class="text-rose-600">미통과</b>'} (${r.verify.pass}/${r.verify.judged})` : '-'}</td>` : ''}
      <td class="p-2 text-center font-bold">${esc(r.result)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  $('#result-body').innerHTML = html;
}
$('#advance').onclick = async () => {
  const round = roundOf(resultRound), next = rounds()[rounds().indexOf(round) + 1];
  if (!confirm(`"${round.name}" 결과(분야별 상위 ${round.count}팀)로 "${next.name}" 대상을 지정합니다. 기존 "${next.name}" 체크는 덮어씁니다. 진행할까요?`)) return;
  try { const r = await api('/api/admin/advance', { method: 'POST', body: JSON.stringify({ round: resultRound }) }); dirty = false; await refresh(); alert(`${r.advanced}팀을 "${r.next}" 대상으로 지정했습니다. 출품작 관리에서 확인·조정할 수 있습니다.`); } catch (e) { alert(e.message); }
};
async function download(path, name) {
  try { const res = await api(path, { raw: true }); const blob = await res.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href); }
  catch (e) { alert(e.message); }
}
$('#csv').onclick = () => download(`/api/admin/export?round=${encodeURIComponent(resultRound)}`, `심사결과_${roundOf(resultRound)?.name || ''}.csv`);
$('#backup').onclick = () => download('/api/admin/backup', 'db-backup.json');

// ---------- 설정: 심사위원 ----------
$('#save-judges').onclick = async () => {
  try { await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ judges: $('#judges').value.split('\n') }) }); await refresh(); alert('심사위원 명단을 저장했습니다. 접속 화면에서 목록으로 선택합니다.'); } catch (e) { alert(e.message); }
};

// ---------- 설정: 심사 구분 ----------
function renderRounds() {
  const sel = (i, f, opts, v) => `<select data-ri="${i}" data-rf="${f}" class="rounded border border-slate-300 py-1">${opts.map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  $('#round-rows').innerHTML = roundRows.map((r, i) => `<tr>
    <td class="p-2 text-center whitespace-nowrap"><b>${i + 1}</b> <button data-up="${i}" class="text-slate-400 hover:text-slate-700 ${i === 0 ? 'invisible' : ''}">▲</button><button data-down="${i}" class="text-slate-400 hover:text-slate-700 ${i === roundRows.length - 1 ? 'invisible' : ''}">▼</button></td>
    <td class="p-2"><input data-ri="${i}" data-rf="name" value="${esc(r.name)}" class="min-w-[12rem] w-full rounded border border-slate-300 py-1 px-1.5"/></td>
    <td class="p-2"><input data-ri="${i}" data-rf="date" value="${esc(r.date)}" class="min-w-[9rem] w-full rounded border border-slate-300 py-1 px-1.5" placeholder="2026. 12. 9.(수)"/></td>
    <td class="p-2 text-center">${sel(i, 'basis', [['plan', '기획안 서면'], ['demo', '발표·시연']], r.basis)}</td>
    <td class="p-2 text-center"><input type="checkbox" data-ri="${i}" data-rf="verify" ${r.verify ? 'checked' : ''}/></td>
    <td class="p-2 text-center">${sel(i, 'mode', [['advance', '다음 심사 진출'], ['award', '수상(1·2·3등)']], r.mode)}</td>
    <td class="p-2 text-center"><input type="number" min="1" max="30" data-ri="${i}" data-rf="count" value="${r.count}" class="w-16 text-center rounded border border-slate-300 py-1"/></td>
    <td class="p-2"><button data-rdel="${i}" class="text-rose-500 hover:underline whitespace-nowrap">삭제</button></td></tr>`).join('');
  $('#round-rows').querySelectorAll('[data-rf]').forEach((el) => el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
    const r = roundRows[Number(el.dataset.ri)], f = el.dataset.rf;
    r[f] = el.type === 'checkbox' ? el.checked : f === 'count' ? Number(el.value) : el.value;
    roundsDirty = true;
  }));
  const move = (i, d) => { const [x] = roundRows.splice(i, 1); roundRows.splice(i + d, 0, x); roundsDirty = true; renderRounds(); };
  $('#round-rows').querySelectorAll('[data-up]').forEach((b) => b.onclick = () => move(Number(b.dataset.up), -1));
  $('#round-rows').querySelectorAll('[data-down]').forEach((b) => b.onclick = () => move(Number(b.dataset.down), 1));
  $('#round-rows').querySelectorAll('[data-rdel]').forEach((b) => b.onclick = () => {
    if (roundRows.length === 1) return alert('심사 구분은 1개 이상 있어야 합니다.');
    if (!confirm(`"${roundRows[Number(b.dataset.rdel)].name}"을(를) 삭제할까요? (저장해야 반영)`)) return;
    roundRows.splice(Number(b.dataset.rdel), 1); roundsDirty = true; renderRounds();
  });
}
$('#add-round').onclick = () => { roundRows.push({ id: '', name: '추가 심사', date: '', basis: 'demo', verify: true, mode: 'award', count: 3 }); roundsDirty = true; renderRounds(); };
$('#save-rounds').onclick = async () => {
  try {
    await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ rounds: roundRows }) });
    roundsDirty = false; dirty = false; await refresh(); alert('심사 구분을 저장했습니다.');
  } catch (e) { alert(e.message); }
};

window.addEventListener('beforeunload', (e) => { if (dirty || roundsDirty) { e.preventDefault(); e.returnValue = ''; } });

renderTabs();
if (pass) refresh().then(() => $('#login').classList.add('hidden')).catch(() => {});
