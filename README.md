# 강남역 1시간 이내 아파트 지도

서울·경기 아파트 실거래 CSV 4개를 기반으로 11억 이하, 전용 40㎡ 이상, 강남역 대중교통 60분 이내 단지를 카카오지도에 표시하는 정적 웹사이트입니다.

## 준비

`.env.local`을 만들고 아래 키를 입력합니다.

```bash
VITE_KAKAO_JS_KEY=your_kakao_javascript_key
KAKAO_REST_API_KEY=your_kakao_rest_api_key
GOOGLE_MAPS_API_KEY=your_google_maps_api_key
VITE_LOGIN_USERNAME=dulzip
VITE_LOGIN_PASSWORD=gangnam60
```

대중교통 계산 기준 시간은 기본적으로 다음 평일 오전 10시입니다. 특정 날짜를 고정하려면 아래 값을 추가합니다.

```bash
TRANSIT_DEPARTURE_ISO=2026-05-04T10:00:00+09:00
```

## 실행

```bash
npm install
npm run data:build
npm run dev
```

`npm run data:build`는 `public/data/apartments.json`을 생성합니다. API 키가 없으면 CSV 필터 결과는 계산하지만 좌표와 대중교통 결과가 없어 지도 표시 데이터는 비어 있습니다.

실거래가 CSV에 이름에 따라 오피스텔·주상복합 등이 함께 섞여 들어오는 경우가 있습니다. 단지 이름 키워드로 빼도록 기본 처리해 두었고, 필요하면 `.env.local`에서 강하게 조정하면 됩니다.

- `FILTER_COMPLEX_MODE=officetel_only` 기본값. `오피스텔`, `근린생활*` 계열 이름을 제외합니다.
- 빌라·연립·주상복합까지 줄이려면 `FILTER_COMPLEX_MODE=officetel_and_villa`
- 이름 기반 규칙을 끄려면 `FILTER_COMPLEX_MODE=none`
- 필요하면 추가 키워드를 `FILTER_COMPLEX_EXCLUDE_KEYWORDS=키워드1,키워드2`처럼 콤마로 넣습니다.

새 규칙을 적용했다면 로컬에서 `npm run data:build`로 JSON을 다시 만들고 변경분을 깃허브에 포함시켜 두면 배포 사이트에도 반영됩니다.

세대수 필터는 `data/households.csv`가 있으면 자동으로 붙습니다. 컬럼명은 아래 중 하나를 인식합니다.

- 단지명: `단지명`, `아파트명`, `공동주택명`, `kaptName`
- 주소: `도로명주소`, `도로명 주소`, `새주소`, `주소`, `kaptAddr`
- 세대수: `세대수`, `총세대수`, `전체세대수`, `kaptdaCnt`, `households`

예시는 `data/households.example.csv`를 참고하세요. 공공데이터 K-apt 자료를 CSV로 내려받아 이 형식에 맞추면 됩니다. `MIN_HOUSEHOLDS=300`처럼 설정하면 데이터 생성 단계에서 해당 세대수 미만 또는 미확인 단지를 제외합니다. 앱 화면에서는 `전체`, `300세대+`, `500세대+`, `1000세대+` 필터를 제공합니다.

## Kakao 403 오류 확인

`Kakao geocode failed: 403 Forbidden`이 나오면 보통 아래 중 하나입니다.

- `KAKAO_REST_API_KEY`에 JavaScript 키를 넣은 경우: Kakao Developers의 `앱 키` 화면에서 `REST API 키`를 넣어야 합니다.
- `disabled OPEN_MAP_AND_LOCAL service` 메시지가 나오는 경우: Kakao Developers에서 해당 앱의 `제품 설정` 또는 `카카오맵/로컬` 관련 메뉴에서 지도/로컬 API 사용을 활성화합니다.
- Kakao 앱이 삭제/비활성화되었거나 키가 잘못 복사된 경우: 앞뒤 공백 없이 다시 복사합니다.
- Kakao Developers 보안 설정에서 허용 IP 제한을 걸어둔 경우: 현재 PC의 외부 IP를 허용하거나 제한을 해제합니다.

## 배포

### Vercel

```bash
npm run build
npx vercel --prod
```

Vercel 프로젝트 환경변수에는 `VITE_KAKAO_JS_KEY`만 필요합니다. Kakao REST 키와 Google 키는 로컬 데이터 생성에만 사용하며 공개 배포물에는 포함하지 않습니다.

로그인 계정을 바꾸려면 Vercel 환경변수에 `VITE_LOGIN_USERNAME`, `VITE_LOGIN_PASSWORD`도 추가하고 다시 배포합니다.

자금계획의 대출 계산값과 메모는 브라우저 `localStorage`에 저장됩니다. 같은 브라우저에서는 새로고침 후에도 유지되지만, 다른 기기와 자동 동기화되지는 않습니다.

### GitHub Pages

GitHub 저장소에 push한 뒤, 저장소 설정에서 Pages 배포 소스를 GitHub Actions로 선택합니다.

메뉴 이동은 `HashRouter`를 사용합니다. 자금 계획 화면은 주소 표시줄에 `#/finance`가 붙으면 됩니다.

1. GitHub 저장소 `Settings` → `Pages`
2. `Build and deployment` → `Source`를 `GitHub Actions`로 선택
3. 저장소 `Settings` → `Secrets and variables` → `Actions`
4. `New repository secret`으로 `VITE_KAKAO_JS_KEY` 추가
5. `main` 브랜치에 push하면 `.github/workflows/deploy-pages.yml`이 `dist`를 GitHub Pages에 배포합니다.

GitHub Pages 배포 주소도 Kakao Developers의 JavaScript SDK 도메인에 추가해야 합니다.

```text
https://사용자명.github.io
https://사용자명.github.io/저장소명
```
# land_ebwg
