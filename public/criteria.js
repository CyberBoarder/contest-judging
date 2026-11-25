// 2026년도 지능형 업무 프로세스 자동화 공모전 심사 기준
// 근거: 세부계획서 5.2 심사 기준, 5.3.4 수상작 선정, 5.4 이해충돌 방지, 6.4 작동 검증 / 심사서류 [서식 1-1~5]
(function (root) {
  const LEVELS = {
    L1: { code: 'L1', name: '아이디어 공모전', short: 'Lv1 아이디어', badge: 'Level 1', color: 'sky',
      desc: '자동화가 필요한 문제를 찾아 해결방안을 기획. 기획서와 업무흐름도(자동화 전·후) 제출' },
    L2: { code: 'L2', name: 'AI 자동화 해커톤', short: 'Lv2 해커톤', badge: 'Level 2', color: 'indigo',
      desc: '반복 업무의 입력·처리·검증·출력 과정을 AI로 실제 자동화한 결과물' },
    L3: { code: 'L3', name: 'IC-PBL·캡스톤 PoC', short: 'Lv3 PoC', badge: 'Level 3', color: 'emerald',
      desc: 'IC-PBL·캡스톤디자인 결과물을 수업 종료 후 추가 개선하고 현장에서 검증한 결과물' },
  };

  // 심사 구분 기본값. 관리자 화면 "설정 > 심사 구분"에서 이름·일자·방식·선발 수를 바꾸거나 추가·삭제할 수 있다.
  //  basis: 'plan' = 기획안(서면) 기준 평가, 'demo' = 발표·시연(실제 구현) 기준 평가
  //  verify: 해커톤·PoC 작동 검증표 사용 여부
  //  mode: 'advance' = 상위 count팀 다음 심사 진출, 'award' = 상위 count팀 1·2·3등 수상
  const DEFAULT_ROUNDS = [
    { id: 'R1', name: '1차 심사(기획안 서면)', date: '2026. 11. 26.(목)', basis: 'plan', verify: false, mode: 'advance', count: 6 },
    { id: 'R2', name: '2차 최종심사(발표·시연)', date: '2026. 12. 9.(수)', basis: 'demo', verify: true, mode: 'award', count: 3 },
  ];
  const BASIS_LABEL = { plan: '기획안 서면 평가', demo: '발표·시연 평가' };
  const MODE_LABEL = { advance: '다음 심사 진출팀 선정', award: '수상작 선정(1·2·3등)' };

  // 항목 키는 분야 공통으로 쓰고 배점만 분야별로 다르게 둔다. (null = 해당 분야 평가 안 함)
  const ITEMS = [
    {
      key: 'problem', label: '문제 정의 및 필요성',
      desc: '자동화 대상 업무의 문제점과 개선 필요성',
      max: { L1: 30, L2: 10, L3: 15 },
    },
    {
      key: 'creative', label: '창의성·해결방안 적절성',
      desc: '해결 방식의 새로움과 적절성',
      max: { L1: 30, L2: 15, L3: 15 },
    },
    {
      key: 'impl',
      label: { plan: '구현 계획의 실현가능성', demo: '실제 구현·작동성' },
      desc: {
        plan: '서면 심사에서는 기획안의 구현 계획이 실제로 구현 가능한지를 평가 ("실제 구현·작동성"을 계획 기준으로 평가)',
        demo: '입력·처리·검증·출력 자동화 수준, 테스트 시나리오 통과 여부',
      },
      max: { L1: null, L2: 35, L3: 25 },
    },
    {
      key: 'effect', label: '업무개선 효과·현장적합성',
      desc: {
        L1: '처리시간 절감, 정확도 유지, 현장 적용 적합성',
        L2: '처리시간 절감, 정확도 유지, 현장 적용 적합성. 처리시간이 줄었더라도 결과 정확도가 낮아진 경우 높게 평가하지 않음',
        L3: '처리시간 절감, 정확도 유지, 현장 적용 적합성(수업 종료 후 추가 개선성과 포함). 수업 제출본을 그대로 다시 제출한 경우 추가 개선성과 0점',
      },
      max: { L1: 20, L2: 25, L3: 30 },
    },
    {
      key: 'feasible', label: '실현가능성·재현성·확장성',
      desc: '다른 사용자·부서가 같은 결과를 재현하고 확장할 수 있는지',
      max: { L1: 20, L2: 15, L3: 15 },
    },
  ];

  // 동점자 처리 순서 (세부계획서 5.3.4)
  const TIE_BREAK = { L1: ['problem', 'creative'], L2: ['impl', 'effect'], L3: ['effect', 'impl'] };

  // 2차 작동 검증표 [서식 3] (해커톤·PoC만)
  const VERIFY_ITEMS = [
    { key: 'normal', label: '정상 실행', desc: '정상 입력값으로 입력·처리·출력이 끝까지 자동 수행되는지' },
    { key: 'change', label: '입력값 변경 시 실행', desc: '입력 데이터를 바꿔도 같은 절차로 올바르게 처리되는지' },
    { key: 'error', label: '오류 입력 시 대응', desc: '누락·형식 오류 입력 시 안내·중단·예외 처리가 되는지' },
    { key: 'correct', label: '결과값 정확성', desc: '출력 결과가 기대 결과(수작업 결과)와 일치하는지' },
  ];

  // round: 심사 구분 객체 { basis, verify, ... }
  function itemsFor(level, round) {
    const basis = round && round.basis === 'plan' ? 'plan' : 'demo';
    return ITEMS.filter((it) => it.max[level] != null).map((it) => ({
      key: it.key,
      label: typeof it.label === 'string' ? it.label : it.label[basis],
      desc: typeof it.desc === 'string' ? it.desc : (it.desc[basis] || it.desc[level]),
      max: it.max[level],
    }));
  }

  function needsVerify(level, round) {
    return !!(round && round.verify) && (level === 'L2' || level === 'L3');
  }

  const api = { LEVELS, DEFAULT_ROUNDS, BASIS_LABEL, MODE_LABEL, ITEMS, TIE_BREAK, VERIFY_ITEMS, itemsFor, needsVerify };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CRITERIA = api;
})(typeof window !== 'undefined' ? window : globalThis);
