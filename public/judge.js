'use strict';
const { LEVELS, BASIS_LABEL, VERIFY_ITEMS, itemsFor, needsVerify } = window.CRITERIA;
let META = { rounds: [], judges: [] };   // 관리자가 설정한 심사 구분·심사위원 명단
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k, d) { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
  draft(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { return null; } },
};

let auth = store.get('auth', null);           // { name, code, round, level }
let sheet = { entries: [], mine: {} };
let currentId = null;

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) { headers['X-Judge-Name'] = encodeURIComponent(auth.name); headers['X-Judge-Code'] = auth.code; }
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || '서버 오류'), { status: res.status });
  return data;
}

// ---------- 로그인 ----------
function segGroup(el, options, value, onPick) {
  el.innerHTML = options.map(([v, label]) => `<button type="button" class="seg ${v === value ? 'on' : ''}" data-v="${v}">${label}</button>`).join('');
  el.querySelectorAll('button').forEach((b) => b.onclick = () => { el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); onPick(b.dataset.v); });
}
let loginRound = auth?.round || null, loginLevel = auth?.level || 'ALL';
async function openLogin() {
  try { META = await api('/api/meta'); } catch (e) { alert(e.message); }
  const inputCls = 'w-full rounded-lg border border-slate-300 text-sm py-2.5 px-3 focus:outline-none focus:ring-2 focus:ring-indigo-500';
  $('#login-name-wrap').innerHTML = META.judges.length
    ? `<select id="login-name" required class="${inputCls}"><option value="">선택하세요</option>${META.judges.map((j) => `<option ${j === auth?.name ? 'selected' : ''}>${esc(j)}</option>`).join('')}</select>`
    : `<input id="login-name" required class="${inputCls}" placeholder="예: 김평가" value="${esc(auth?.name || '')}"/>`;
  $('#login-code').value = auth?.code || '';
  if (!META.rounds.some((r) => r.id === loginRound)) loginRound = META.rounds[0]?.id;
  segGroup($('#login-round'), META.rounds.map((r) => [r.id, `${esc(r.name)}<br><span class="text-[11px] font-normal text-slate-400">${esc(r.date)} · ${BASIS_LABEL[r.basis]}</span>`]), loginRound, (v) => loginRound = v);
  const showDesc = (v) => {
    $('#login-level-desc').innerHTML = Object.values(LEVELS).filter((l) => v === 'ALL' || l.code === v)
      .map((l) => `<li><b class="text-slate-700">${l.badge} ${l.name}</b>: ${esc(l.desc)}</li>`).join('');
  };
  segGroup($('#login-level'), [['ALL', '전체'], ...Object.values(LEVELS).map((l) => [l.code, l.short])], loginLevel, (v) => { loginLevel = v; showDesc(v); });
  showDesc(loginLevel);
  $('#login-modal').classList.remove('hidden');
}
$('#login-form').onsubmit = async (ev) => {
  ev.preventDefault();
  const err = $('#login-error'); err.classList.add('hidden');
  try {
    const name = $('#login-name').value.trim(), code = $('#login-code').value;
    await api('/api/judge/login', { method: 'POST', body: JSON.stringify({ name, code }) });
    auth = { name, code, round: loginRound, level: loginLevel };
    store.set('auth', auth);
    $('#login-modal').classList.add('hidden');
    currentId = null;
    await load();
  } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
};
$('#change-btn').onclick = openLogin;

// ---------- 데이터 ----------
async function load() {
  try { sheet = await api(`/api/judge/sheet?round=${encodeURIComponent(auth.round)}`); }
  catch (e) {
    if (e.status === 401) { auth = null; store.set('auth', null); return openLogin(); }
    if (e.status === 400) { alert(e.message); return openLogin(); }
    alert(e.message); return;
  }
  renderHeader();
  renderList();
}
const visible = () => sheet.entries.filter((e) => auth.level === 'ALL' || e.level === auth.level);
const draftKey = (id) => `draft|${auth.round}|${auth.name}|${id}`;
function statusOf(e) {
  const s = sheet.mine[e.id];
  if (s) return s.recuse ? 'recuse' : 'done';
  return store.draft(draftKey(e.id)) ? 'draft' : 'none';
}

// ---------- 머리글·목록 ----------
function renderHeader() {
  const r = sheet.round;
  $('#round-badge').textContent = `${r.name}${r.date ? ` · ${r.date}` : ''}`;
  $('#judge-badge').textContent = `${auth.name} 심사위원`;
  const v = visible();
  const done = v.filter((e) => sheet.mine[e.id]).length;
  $('#progress-badge').textContent = `${done} / ${v.length} 제출`;
  const tabs = [['ALL', '전체', sheet.entries.length], ...Object.values(LEVELS).map((l) => [l.code, `${l.short} · ${l.name}`, sheet.entries.filter((e) => e.level === l.code).length])];
  $('#level-tabs').innerHTML = tabs.map(([c, label, n]) => `<button class="tab ${auth.level === c ? 'on' : ''}" data-c="${c}">${label} <span class="ml-1 text-[11px] text-slate-400">${n}</span></button>`).join('');
  $('#level-tabs').querySelectorAll('button').forEach((b) => b.onclick = () => { auth.level = b.dataset.c; store.set('auth', auth); currentId = null; renderHeader(); renderList(); });
}

function renderList() {
  const v = visible();
  const icon = { done: '<span class="text-emerald-600">●</span>', recuse: '<span class="text-slate-400">⊘</span>', draft: '<span class="text-amber-500">◐</span>', none: '<span class="text-slate-300">○</span>' };
  let html = '', opts = '';
  for (const lv of Object.values(LEVELS)) {
    const list = v.filter((e) => e.level === lv.code);
    if (!list.length) continue;
    html += `<div class="px-4 pt-3 pb-1 text-[11px] font-bold text-slate-400">${lv.badge} ${lv.name}</div>`;
    opts += `<optgroup label="${lv.badge} ${lv.name}">`;
    list.forEach((e, i) => {
      const st = statusOf(e);
      html += `<button data-id="${e.id}" class="w-full text-left px-4 py-2.5 text-sm flex gap-2 items-start hover:bg-slate-50 ${e.id === currentId ? 'bg-indigo-50 border-l-4 border-indigo-500' : 'border-l-4 border-transparent'}">
        <span class="w-4 flex-shrink-0">${icon[st]}</span>
        <span class="min-w-0"><span class="block font-semibold text-slate-800 leading-snug">${i + 1}. ${esc(e.title)}</span>
        <span class="block text-xs text-slate-400">${esc(e.leader)}${st === 'recuse' ? ' · 회피' : ''}</span></span></button>`;
      opts += `<option value="${e.id}" ${e.id === currentId ? 'selected' : ''}>${i + 1}. ${esc(e.title)} (${esc(e.leader)})</option>`;
    });
    opts += '</optgroup>';
  }
  $('#sidebar').innerHTML = html;
  $('#mobile-select').innerHTML = opts;
  $('#sidebar').querySelectorAll('button').forEach((b) => b.onclick = () => select(Number(b.dataset.id)));
  $('#mobile-select').onchange = (ev) => select(Number(ev.target.value));
  $('#empty').classList.toggle('hidden', v.length > 0);
  if (!v.length) { $('#detail').innerHTML = ''; return; }
  if (!v.some((e) => e.id === currentId)) select((v.find((e) => !sheet.mine[e.id]) || v[0]).id);
  else renderDetail();
}
function select(id) { currentId = id; renderList(); window.scrollTo({ top: 0 }); }

// ---------- 심사표 ----------
function renderDetail() {
  const e = sheet.entries.find((x) => x.id === currentId);
  if (!e) return;
  const round = sheet.round, lv = LEVELS[e.level], items = itemsFor(e.level, round), verify = needsVerify(e.level, round);
  const sub = sheet.mine[e.id];
  const locked = !!sub;
  const st = sub || store.draft(draftKey(e.id)) || { scores: {}, verify: {}, recuse: false };
  st.verify = st.verify || {}; st.verify.notes = st.verify.notes || {};
  const idx = visible().filter((x) => x.level === e.level).findIndex((x) => x.id === e.id) + 1;

  const links = (e.links || []).map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener" class="inline-flex items-center px-3 py-1.5 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 text-xs font-semibold hover:bg-indigo-100">${esc(l.label)} ↗</a>`).join(' ') || '<span class="text-xs text-slate-400">등록된 자료 링크 없음</span>';

  const itemRows = items.map((it) => {
    const val = st.scores[it.key] ?? '';
    return `<div class="p-4 sm:p-5 grid grid-cols-1 md:grid-cols-12 gap-3 items-center">
      <div class="md:col-span-6">
        <p class="font-semibold text-sm text-slate-800">${esc(it.label)} <span class="text-xs text-slate-400 font-medium">(${it.max}점)</span></p>
        <p class="text-xs text-slate-500 mt-1 leading-relaxed">${esc(it.desc)}</p>
      </div>
      <div class="md:col-span-4"><input type="range" min="0" max="${it.max}" step="1" value="${val === '' ? 0 : val}" data-range="${it.key}" class="w-full ${val === '' ? 'opacity-40' : ''}"/></div>
      <div class="md:col-span-2 flex items-center gap-1 justify-end">
        <input type="number" min="0" max="${it.max}" step="1" inputmode="numeric" value="${val}" data-score="${it.key}" class="w-20 text-right rounded-lg border border-slate-300 py-2 px-2 text-base font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500" placeholder="-"/>
        <span class="text-xs text-slate-400">/ ${it.max}</span>
      </div></div>`;
  }).join('');

  const verifyHtml = !verify ? '' : `
  <section class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
    <div class="px-5 py-3.5 bg-slate-50/80 border-b border-slate-200">
      <h2 class="font-bold text-sm sm:text-base text-slate-800">작동 검증표 [서식 3]</h2>
      <p class="text-xs text-slate-500 mt-0.5">4개 항목을 모두 통과해야 "작동 검증 통과"입니다. 작동 검증을 통과한 출품작만 수상 대상입니다.</p>
    </div>
    <div class="divide-y divide-slate-100">
      ${VERIFY_ITEMS.map((vi, i) => `<div class="p-4 grid grid-cols-1 md:grid-cols-12 gap-3 items-center">
        <div class="md:col-span-5"><p class="font-semibold text-sm">${i + 1}. ${vi.label}</p><p class="text-xs text-slate-500 mt-0.5">${vi.desc}</p></div>
        <input data-vnote="${vi.key}" value="${esc(st.verify.notes[vi.key] || '')}" class="md:col-span-5 rounded-lg border border-slate-300 py-2 px-3 text-sm" placeholder="실제 결과(시연·실행로그)"/>
        <div class="md:col-span-2 flex gap-1 justify-end">
          <button type="button" class="pick ${st.verify[vi.key] === true ? 'yes' : ''}" data-v="${vi.key}" data-val="1">통과</button>
          <button type="button" class="pick ${st.verify[vi.key] === false ? 'no' : ''}" data-v="${vi.key}" data-val="0">미통과</button>
        </div></div>`).join('')}
      <div class="p-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
        <label><span class="block text-xs font-semibold text-slate-500 mb-1">자동화 전 1회 평균 처리시간(분)</span><input type="number" step="0.1" min="0" data-time="timeBefore" value="${st.verify.timeBefore ?? ''}" class="w-full rounded-lg border border-slate-300 py-2 px-3"/></label>
        <label><span class="block text-xs font-semibold text-slate-500 mb-1">자동화 후 1회 평균 처리시간(분)</span><input type="number" step="0.1" min="0" data-time="timeAfter" value="${st.verify.timeAfter ?? ''}" class="w-full rounded-lg border border-slate-300 py-2 px-3"/></label>
        <div><span class="block text-xs font-semibold text-slate-500 mb-1">절감률</span><p id="saving" class="py-2 font-bold text-indigo-700">-</p></div>
        <div class="sm:col-span-3 flex flex-wrap items-center gap-2">
          <span class="text-xs font-semibold text-slate-500">결과 정확도</span>
          <button type="button" class="pick ${st.verify.accuracy === 'keep' ? 'yes' : ''}" data-acc="keep">유지</button>
          <button type="button" class="pick ${st.verify.accuracy === 'drop' ? 'no' : ''}" data-acc="drop">저하</button>
          <input data-accreason value="${esc(st.verify.accuracyReason || '')}" class="flex-1 min-w-[12rem] rounded-lg border border-slate-300 py-2 px-3 text-sm" placeholder="저하 사유 (저하인 경우)"/>
        </div>
        <p class="sm:col-span-3 text-xs text-slate-400">※ 측정값은 참가팀 [양식 5] 처리시간 측정 기록표와 대조합니다. 처리시간이 줄었더라도 정확도가 낮아지면 업무개선 효과를 높게 평가하지 않습니다.</p>
      </div>
    </div>
  </section>`;

  const total = items.reduce((a, it) => a + (Number(st.scores[it.key]) || 0), 0);
  $('#detail').innerHTML = `
  ${locked ? `<div class="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl px-4 py-3 text-sm font-semibold">${sub.recuse ? '회피로 제출한 심사표입니다.' : `제출 완료된 심사표입니다 (${sub.total}점).`} ${new Date(sub.submittedAt).toLocaleString('ko-KR')} 제출 · 수정은 사업단에 제출 취소 요청</div>` : ''}
  <section class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
    <div class="px-5 py-3.5 bg-slate-50/80 border-b border-slate-200 flex items-center justify-between gap-2">
      <h2 class="font-bold text-sm sm:text-base text-slate-800">심사 대상 출품작</h2>
      <span class="text-xs font-semibold px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700">${lv.badge} ${lv.name} · ${idx}번</span>
    </div>
    <div class="p-5 space-y-3">
      <p class="text-xs text-indigo-700 bg-indigo-50/60 rounded-lg px-3 py-2"><b>${lv.name}</b>: ${esc(lv.desc)}</p>
      <p class="text-lg font-bold text-slate-900 leading-snug">${esc(e.title)}</p>
      <div class="flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600">
        <span>대표자 <b class="text-slate-800">${esc(e.leader)}</b></span>
        <span>학과 <b class="text-slate-800">${esc(e.dept)}</b></span>
        ${e.advisor ? `<span>지도교수 <b class="text-slate-800">${esc(e.advisor)}</b></span>` : ''}
      </div>
      <div class="flex flex-wrap gap-2 pt-1">${links}</div>
      ${e.note ? `<p class="text-xs text-slate-500 bg-slate-50 rounded-lg p-3">${esc(e.note)}</p>` : ''}
    </div>
  </section>

  <section class="bg-white rounded-xl border border-slate-200 shadow-sm p-4 ${locked ? 'locked' : ''}">
    <label class="flex items-start gap-3 cursor-pointer">
      <input type="checkbox" id="recuse" ${st.recuse ? 'checked' : ''} ${locked ? 'disabled' : ''} class="mt-1 w-4 h-4"/>
      <span><span class="font-semibold text-sm">이해충돌로 이 출품작 심사를 회피합니다</span>
      <span class="block text-xs text-slate-500">지도교수이거나 팀원과 친족·지도 관계인 경우. 회피한 출품작은 나머지 심사위원 점수의 평균으로 산정합니다.</span></span>
    </label>
    <input id="recuse-reason" value="${esc(st.recuseReason || '')}" class="${st.recuse ? '' : 'hidden'} mt-3 w-full rounded-lg border border-slate-300 py-2 px-3 text-sm" placeholder="관계 (예: 지도교수)"/>
  </section>

  <div id="score-wrap" class="space-y-6 ${st.recuse ? 'hidden' : ''} ${locked ? 'locked' : ''}">
    <section class="bg-gradient-to-br from-slate-900 to-indigo-950 rounded-xl text-white p-5 flex flex-wrap items-center justify-between gap-4 shadow-lg">
      <div><p class="text-xs text-indigo-200">${esc(round.name)} · ${BASIS_LABEL[round.basis]} · ${lv.name} 평가표</p>
      <p class="text-sm text-slate-300 mt-1">${round.mode === 'advance' ? `분야별 고득점순 ${round.count}팀이 다음 심사에 진출합니다. 이 점수는 진출팀 선정에만 씁니다.` : '심사위원 평균 점수로 분야별 1·2·3등을 정합니다.'}</p></div>
      <div class="text-right"><p class="text-xs text-indigo-200">현재 총점</p><p class="text-3xl font-extrabold"><span id="total">${total}</span><span class="text-base text-slate-400"> / 100</span></p></div>
    </section>
    <section class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div class="px-5 py-3.5 bg-slate-50/80 border-b border-slate-200">
        <h2 class="font-bold text-sm sm:text-base text-slate-800">평가 항목</h2>
        <p class="text-xs text-slate-500 mt-0.5">항목별 배점 안에서 정수로 입력하세요.</p>
      </div>
      <div class="divide-y divide-slate-100">${itemRows}</div>
    </section>
    ${verifyHtml}
  </div>

  <section class="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-3 ${locked ? 'locked' : ''}">
    <label class="block"><span class="block text-xs font-semibold text-slate-500 mb-1">심사 의견 (선택${verify ? ', 작동 검증 의견 포함' : ''})</span>
      <textarea id="comment" rows="3" class="w-full rounded-lg border border-slate-300 py-2 px-3 text-sm" placeholder="${round.basis === 'plan' ? '보완 기획안에 반영할 의견 등' : '판단 근거, 보완 사항 등'}">${esc(st.comment || '')}</textarea></label>
    <div class="flex flex-wrap items-center justify-between gap-3 pt-1">
      <p class="text-xs text-slate-500">심사위원 <b>${esc(auth.name)}</b> · 심사일 ${esc(round.date)} · 배점 기준에 따라 공정하게 평가하였음을 확인합니다.</p>
      ${locked ? '' : `<div class="flex gap-2"><button id="save-draft" class="px-4 py-2.5 rounded-lg border border-slate-300 text-sm font-semibold hover:bg-slate-50">임시 저장</button>
      <button id="submit" class="px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold">제출</button></div>`}
    </div>
  </section>`;

  if (locked) { updateSaving(st); return; }
  bindEditor(e, items, verify, st);
}

function collect(items, st) {
  const out = { recuse: $('#recuse').checked, recuseReason: $('#recuse-reason').value.trim(), scores: {}, verify: { ...st.verify, notes: {} }, comment: $('#comment').value };
  for (const it of items) { const v = document.querySelector(`[data-score="${it.key}"]`).value; if (v !== '') out.scores[it.key] = Number(v); }
  document.querySelectorAll('[data-vnote]').forEach((i) => out.verify.notes[i.dataset.vnote] = i.value);
  document.querySelectorAll('[data-time]').forEach((i) => out.verify[i.dataset.time] = i.value === '' ? null : Number(i.value));
  const ar = document.querySelector('[data-accreason]'); if (ar) out.verify.accuracyReason = ar.value;
  return out;
}

function pickState(v) {
  const o = { accuracy: v.accuracy ?? null };
  for (const vi of VERIFY_ITEMS) if (typeof v[vi.key] === 'boolean') o[vi.key] = v[vi.key];
  return o;
}

function updateSaving(st) {
  const el = $('#saving'); if (!el) return;
  const b = Number(st.verify?.timeBefore), a = Number(st.verify?.timeAfter);
  el.textContent = b > 0 && a >= 0 && st.verify.timeBefore != null && st.verify.timeAfter != null ? `${(((b - a) / b) * 100).toFixed(1)}%` : '-';
}

function bindEditor(e, items, verify, st) {
  const key = draftKey(e.id);
  const persist = () => { Object.assign(st, collect(items, st)); store.draft(key, st); renderListIconsOnly(); };
  const recalc = () => { $('#total').textContent = items.reduce((a, it) => a + (Number(document.querySelector(`[data-score="${it.key}"]`).value) || 0), 0); };

  document.querySelectorAll('[data-score]').forEach((inp) => {
    const it = items.find((x) => x.key === inp.dataset.score);
    const range = document.querySelector(`[data-range="${it.key}"]`);
    inp.addEventListener('input', () => {
      let v = inp.value;
      if (v !== '') { v = Math.max(0, Math.min(it.max, Math.round(Number(v)))); if (String(v) !== inp.value) inp.value = v; range.value = v; range.classList.remove('opacity-40'); }
      recalc(); persist();
    });
    range.addEventListener('input', () => { inp.value = range.value; range.classList.remove('opacity-40'); recalc(); persist(); });
  });
  $('#recuse').onchange = () => { $('#score-wrap').classList.toggle('hidden', $('#recuse').checked); $('#recuse-reason').classList.toggle('hidden', !$('#recuse').checked); persist(); };
  $('#recuse-reason').oninput = persist;
  $('#comment').oninput = persist;
  document.querySelectorAll('[data-v]').forEach((b) => b.onclick = () => {
    st.verify[b.dataset.v] = b.dataset.val === '1';
    document.querySelectorAll(`[data-v="${b.dataset.v}"]`).forEach((x) => x.classList.remove('yes', 'no'));
    b.classList.add(b.dataset.val === '1' ? 'yes' : 'no'); persist();
  });
  document.querySelectorAll('[data-acc]').forEach((b) => b.onclick = () => {
    st.verify.accuracy = b.dataset.acc;
    document.querySelectorAll('[data-acc]').forEach((x) => x.classList.remove('yes', 'no'));
    b.classList.add(b.dataset.acc === 'keep' ? 'yes' : 'no'); persist();
  });
  document.querySelectorAll('[data-vnote],[data-time],[data-accreason]').forEach((i) => i.addEventListener('input', () => { persist(); updateSaving(st); }));
  updateSaving(st);

  $('#save-draft').onclick = () => { persist(); const b = $('#save-draft'); b.textContent = '저장됨'; setTimeout(() => (b.textContent = '임시 저장'), 1200); };
  $('#submit').onclick = () => {
    const d = collect(items, st);
    const missing = d.recuse ? (d.recuseReason ? [] : ['회피 사유']) : [
      ...items.filter((it) => d.scores[it.key] == null).map((it) => it.label),
      ...(verify ? VERIFY_ITEMS.filter((vi) => typeof st.verify[vi.key] !== 'boolean').map((vi) => `작동 검증: ${vi.label}`) : []),
    ];
    if (missing.length) return alert(`아래 항목을 입력하세요.\n- ${missing.join('\n- ')}`);
    const total = items.reduce((a, it) => a + d.scores[it.key], 0);
    const pass = verify ? VERIFY_ITEMS.every((vi) => st.verify[vi.key] === true) : null;
    $('#confirm-body').innerHTML = `<p class="font-semibold">${esc(e.title)} <span class="text-slate-400 font-normal">(${esc(e.leader)})</span></p>` + (d.recuse
      ? `<p>이해충돌 <b>회피</b>로 제출합니다. 사유: ${esc(d.recuseReason)}</p>`
      : `<ul class="text-xs space-y-1">${items.map((it) => `<li class="flex justify-between"><span>${esc(it.label)}</span><b>${d.scores[it.key]} / ${it.max}</b></li>`).join('')}</ul>
         <p class="flex justify-between border-t pt-2"><span>총점</span><b class="text-indigo-700">${total} / 100</b></p>
         ${verify ? `<p class="flex justify-between"><span>작동 검증</span><b class="${pass ? 'text-emerald-600' : 'text-rose-600'}">${pass ? '통과' : '미통과'}</b></p>` : ''}`);
    $('#confirm-modal').classList.remove('hidden');
    $('#confirm-ok').onclick = async () => {
      $('#confirm-ok').disabled = true;
      try {
        const r = await api('/api/judge/submit', { method: 'POST', body: JSON.stringify({ round: auth.round, entryId: e.id, ...d, verify: { ...d.verify, ...pickState(st.verify) } }) });
        sheet.mine[e.id] = r.submission; store.draft(key, null);
        $('#confirm-modal').classList.add('hidden');
        const next = visible().find((x) => !sheet.mine[x.id]);
        renderHeader();
        if (next) select(next.id); else { renderList(); alert('선택한 분야의 심사표를 모두 제출했습니다. 감사합니다.'); }
      } catch (err) { alert(err.message); }
      finally { $('#confirm-ok').disabled = false; }
    };
  };
}
$('#confirm-cancel').onclick = () => $('#confirm-modal').classList.add('hidden');

function renderListIconsOnly() {
  // 작성중 표시만 갱신 (입력 포커스 유지)
  document.querySelectorAll('#sidebar button').forEach((b) => {
    const e = sheet.entries.find((x) => x.id === Number(b.dataset.id));
    const st = statusOf(e);
    const span = b.querySelector('span');
    if (st === 'draft') span.innerHTML = '<span class="text-amber-500">◐</span>';
  });
}

// ---------- 시작 ----------
if (auth) load(); else openLogin();
