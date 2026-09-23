// opening_hours.js 등 프로세스 로컬 타임존에 의존하는 라이브러리 평가를 KST로 고정한다.
// 실행 환경(로컬 KST, GitHub Actions UTC)에 따라 판정이 달라지지 않게 한다.
// 사용: opening_hours import보다 먼저 이 모듈을 import한다 (ESM은 선언 순서대로 평가).
process.env.TZ = "Asia/Seoul";
