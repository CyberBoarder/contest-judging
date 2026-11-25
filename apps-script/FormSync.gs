/**
 * 공모전 심사 시스템 - 구글 폼 응답 연동 (Apps Script 웹 앱)
 *
 * 붙일 곳: 「2026년도 지능형 업무 프로세스 자동화(P-AI Automation) 참가 접수(응답)」 시트
 *          > 확장 프로그램 > Apps Script 에 이 파일 내용을 붙여 넣기
 *
 * 설정 (1회)
 *  1) 프로젝트 설정(톱니바퀴) > 스크립트 속성 > 속성 추가: SYNC_KEY = 임의의 긴 문자열(서버 .env의 FORM_SYNC_KEY와 같게)
 *  2) 배포 > 새 배포 > 유형: 웹 앱
 *     - 실행 사용자: 나(시트 소유자/편집자 계정)
 *     - 액세스 권한: 모든 사용자 (심사 서버가 로그인 없이 호출하므로)
 *  3) 발급된 웹 앱 URL(…/exec)을 서버 .env의 FORM_SYNC_URL에 넣기
 *
 * 보내는 항목: 타임스탬프, 참가 분야, 결과물명, 대표자 성명·학과, 팀원 명단 중 학번 없는 줄(지도교수 추정용), 제출 파일 링크
 * 보내지 않는 항목: 이메일 주소, 학번, 연락처, 학번이 들어간 팀원 줄, 동의 여부
 * SYNC_KEY가 맞지 않으면 아무것도 보내지 않습니다.
 */

var SHEET_NAME = ''; // 비우면 첫 번째 시트(폼 응답 시트)

// [시트 제목의 앞부분(공백 무시), 보낼 때 쓰는 제목]
var COLUMNS = [
  ['타임스탬프', '타임스탬프'],
  ['참가분야', '참가 분야'],
  ['결과물', '결과물(기획안)명'],
  ['대표자성명', '대표자 성명'],
  ['대표자학과', '대표자 학과'],
  ['팀원명단', '팀원 명단'],
  ['제출파일', '제출 파일'],
  ['대용량', '대용량 영상·산출물 링크']
];

function doGet(e) {
  var key = PropertiesService.getScriptProperties().getProperty('SYNC_KEY');
  if (!key || !e || !e.parameter || e.parameter.key !== key) return json_({ error: 'unauthorized' });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return json_({ ok: true, rows: [] });

  var head = values[0].map(function (h) { return String(h).replace(/\s/g, ''); });
  var idx = COLUMNS.map(function (c) {
    for (var i = 0; i < head.length; i++) if (head[i].indexOf(c[0]) === 0) return i;
    return -1;
  });

  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var v = values[r];
    if (!v.join('').trim()) continue;
    var o = {};
    COLUMNS.forEach(function (c, k) {
      var x = idx[k] < 0 ? '' : v[idx[k]];
      if (x instanceof Date) x = x.toISOString();
      x = String(x == null ? '' : x);
      if (c[0] === '팀원명단') { // 학번이 들어간 줄은 보내지 않음
        x = x.split(/\r?\n/).filter(function (s) { return s.trim() && !/\d{6,}/.test(s); }).join('\n');
      }
      if (c[0] === '결과물' && /\d{8,}/.test(x)) x = ''; // 파일명(학번 포함)이 입력된 경우
      o[c[1]] = x;
    });
    rows.push(o);
  }
  return json_({ ok: true, generatedAt: new Date().toISOString(), rows: rows });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
