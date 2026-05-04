import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { loadKakaoMap } from "./lib/kakaoMap";
import type { Apartment, ApartmentData } from "./types";

const GANGNAM_STATION = { lat: 37.497952, lng: 127.027619 };
/** Kakao level↑ = 축소(더 멀리). 라벨이 겹치기 시작하는 구간에서 단지 정보는 숨기고 금액만 노출한다. */
const MAP_LEVEL_PRICE_ONLY_LABEL_MIN = 10;
const AUTH_STORAGE_KEY = "dulzip-authenticated";
const FINANCE_STORAGE_KEY = "dulzip-finance-plan";

const LOGIN_USERNAME = import.meta.env.VITE_LOGIN_USERNAME ?? "dulzip";
const LOGIN_PASSWORD = import.meta.env.VITE_LOGIN_PASSWORD ?? "gangnam60";

export type FinancePlan = {
  cashManwon: string;
  loanManwon: string;
  annualRate: string;
  loanYears: string;
  extraCostManwon: string;
  reserveManwon: string;
  memo: string;
};

const DEFAULT_FINANCE_PLAN: FinancePlan = {
  cashManwon: "",
  loanManwon: "",
  annualRate: "4.0",
  loanYears: "30",
  extraCostManwon: "",
  reserveManwon: "",
  memo: "",
};

function getInitialAuthState() {
  try {
    return sessionStorage.getItem(AUTH_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function coerceFinanceText(value: unknown, fallback: string) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return fallback;
}

function normalizeFinancePlan(raw: Partial<Record<keyof FinancePlan, unknown>>): FinancePlan {
  return {
    cashManwon: coerceFinanceText(raw.cashManwon, DEFAULT_FINANCE_PLAN.cashManwon),
    loanManwon: coerceFinanceText(raw.loanManwon, DEFAULT_FINANCE_PLAN.loanManwon),
    annualRate: coerceFinanceText(raw.annualRate, DEFAULT_FINANCE_PLAN.annualRate),
    loanYears: coerceFinanceText(raw.loanYears, DEFAULT_FINANCE_PLAN.loanYears),
    extraCostManwon: coerceFinanceText(raw.extraCostManwon, DEFAULT_FINANCE_PLAN.extraCostManwon),
    reserveManwon: coerceFinanceText(raw.reserveManwon, DEFAULT_FINANCE_PLAN.reserveManwon),
    memo: typeof raw.memo === "string" ? raw.memo : raw.memo != null ? String(raw.memo) : "",
  };
}

function getInitialFinancePlan() {
  try {
    const saved = localStorage.getItem(FINANCE_STORAGE_KEY);
    if (!saved) return DEFAULT_FINANCE_PLAN;
    return normalizeFinancePlan(JSON.parse(saved) as Partial<Record<keyof FinancePlan, unknown>>);
  } catch {
    return DEFAULT_FINANCE_PLAN;
  }
}

function persistFinancePlan(plan: FinancePlan) {
  try {
    localStorage.setItem(FINANCE_STORAGE_KEY, JSON.stringify(plan));
  } catch {
    console.warn("[finance] 브라우저 저장소에 쓸 수 없습니다 (사생활 보호 창 또는 용량 제한 등).");
  }
}

function formatPrice(priceManwon: number) {
  const eok = Math.floor(priceManwon / 10_000);
  const rest = priceManwon % 10_000;
  return rest ? `${eok}억 ${rest.toLocaleString("ko-KR")}만` : `${eok}억`;
}

function formatManwon(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value >= 10_000) return formatPrice(Math.round(value));
  return `${Math.round(value).toLocaleString("ko-KR")}만`;
}

export function parseManwon(value: string) {
  const normalized = value.replaceAll(",", "").trim();
  if (!normalized) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function calculateMonthlyPayment(loanManwon: number, annualRate: number, years: number) {
  const months = Math.round(years * 12);
  if (loanManwon <= 0 || months <= 0) return 0;

  const principalWon = loanManwon * 10_000;
  const monthlyRate = annualRate / 100 / 12;
  if (monthlyRate <= 0) return principalWon / months;

  const factor = (1 + monthlyRate) ** months;
  return (principalWon * monthlyRate * factor) / (factor - 1);
}

function formatArea(areaM2: number) {
  return `${areaM2.toFixed(areaM2 % 1 === 0 ? 0 : 2)}㎡`;
}

const HOUSEHOLDS_SLIDER_MIN = 0;
const HOUSEHOLDS_SLIDER_MAX = 5000;
const HOUSEHOLDS_SLIDER_STEP = 50;

function matchesHouseholdSliderBand(households: number | null, bandMin: number, bandMax: number) {
  const isFullSweep = bandMin <= HOUSEHOLDS_SLIDER_MIN && bandMax >= HOUSEHOLDS_SLIDER_MAX;
  if (isFullSweep) return true;
  if (households === null) return false;
  return households >= bandMin && households <= bandMax;
}

/** 실거래일(YYYY-MM-DD) 구간. 비어 있는 쪽은 제한 없음. 형식이 맞지 않는 입력은 무시합니다. 역전이면 맞바꿉니다. */
function parseTradeDateBounds(
  fromRaw: string,
  toRaw: string,
): { low: string | null; high: string | null } | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/;
  const a = fromRaw.trim();
  const b = toRaw.trim();
  let low = a && iso.test(a) ? a : null;
  let high = b && iso.test(b) ? b : null;

  if (!low && !high) return null;
  if (low && high && low > high) {
    const t = low;
    low = high;
    high = t;
  }
  return { low, high };
}

function latestTradeInDateRange(dealDate: string, bounds: { low: string | null; high: string | null }) {
  const d = dealDate.trim();
  if (bounds.low && d < bounds.low) return false;
  if (bounds.high && d > bounds.high) return false;
  return true;
}

function HouseholdDualRangeFilter({
  bandMin,
  bandMax,
  onMinChange,
  onMaxChange,
}: {
  bandMin: number;
  bandMax: number;
  onMinChange: (value: number) => void;
  onMaxChange: (value: number) => void;
}) {
  const span = HOUSEHOLDS_SLIDER_MAX - HOUSEHOLDS_SLIDER_MIN;
  const pctLeft = span > 0 ? ((bandMin - HOUSEHOLDS_SLIDER_MIN) / span) * 100 : 0;
  const pctRight = span > 0 ? ((bandMax - HOUSEHOLDS_SLIDER_MIN) / span) * 100 : 100;

  return (
    <div className="household-slider-block">
      <div className="household-slider-readout">
        <span>{bandMin.toLocaleString("ko-KR")}</span>
        <span className="household-slider-dash">~</span>
        <span>{bandMax.toLocaleString("ko-KR")}</span>
        <span className="household-slider-unit">세대</span>
      </div>
      <div className="household-slider-wrap">
        <div className="household-slider-visual" aria-hidden>
          <div
            className="household-slider-selected"
            style={{
              marginLeft: `${pctLeft}%`,
              width: `${Math.max(pctRight - pctLeft, 0)}%`,
            }}
          />
        </div>
        <label className="visually-hidden" htmlFor="household-band-min-range">
          세대 하한
        </label>
        <input
          aria-label={`세대 수 하한. 현재 ${bandMin.toLocaleString("ko-KR")} 세대`}
          aria-valuemax={HOUSEHOLDS_SLIDER_MAX}
          aria-valuemin={HOUSEHOLDS_SLIDER_MIN}
          className="household-slider-thumb household-slider-thumb--lower"
          id="household-band-min-range"
          max={HOUSEHOLDS_SLIDER_MAX}
          min={HOUSEHOLDS_SLIDER_MIN}
          step={HOUSEHOLDS_SLIDER_STEP}
          type="range"
          value={bandMin}
          onChange={(event) => {
            const raw = Number(event.target.value);
            const nextMin = Number.isFinite(raw) ? raw : HOUSEHOLDS_SLIDER_MIN;
            onMinChange(Math.min(nextMin, bandMax - HOUSEHOLDS_SLIDER_STEP));
          }}
        />
        <label className="visually-hidden" htmlFor="household-band-max-range">
          세대 상한
        </label>
        <input
          aria-label={`세대 수 상한. 현재 ${bandMax.toLocaleString("ko-KR")} 세대`}
          aria-valuemax={HOUSEHOLDS_SLIDER_MAX}
          aria-valuemin={HOUSEHOLDS_SLIDER_MIN}
          className="household-slider-thumb household-slider-thumb--upper"
          id="household-band-max-range"
          max={HOUSEHOLDS_SLIDER_MAX}
          min={HOUSEHOLDS_SLIDER_MIN}
          step={HOUSEHOLDS_SLIDER_STEP}
          type="range"
          value={bandMax}
          onChange={(event) => {
            const raw = Number(event.target.value);
            const nextMax = Number.isFinite(raw) ? raw : HOUSEHOLDS_SLIDER_MAX;
            onMaxChange(Math.max(nextMax, bandMin + HOUSEHOLDS_SLIDER_STEP));
          }}
        />
      </div>
    </div>
  );
}

function markerLabel(apartment: Apartment) {
  return `${apartment.complexName} · ${formatPrice(apartment.latestTrade.priceManwon)} · ${formatArea(apartment.latestTrade.areaM2)}`;
}

/** Kakao map level: 숫자가 작을수록 확대. 라벨은 확대 시 같이 커지게 스케일한다. */
function zoomLevelToPriceMarkerScale(level: number) {
  const s = 0.39 + (15 - level) * 0.075;
  return Math.min(1.62, Math.max(0.4, s));
}

function applyPriceMarkerZoomPresentation(map: KakaoMap, mapRootEl: HTMLElement) {
  try {
    const level = typeof map.getLevel === "function" ? map.getLevel() : 8;
    mapRootEl.style.setProperty("--map-price-marker-scale", String(zoomLevelToPriceMarkerScale(level)));
    const compact = level >= MAP_LEVEL_PRICE_ONLY_LABEL_MIN;
    mapRootEl.classList.toggle("map--price-marker-compact", compact);
    const nodes = mapRootEl.querySelectorAll(".price-marker");
    const fallback = nodes.length === 0 ? document.querySelectorAll(".price-marker") : nodes;
    fallback.forEach((el) => {
      el.classList.toggle("price-marker--compact", compact);
    });
  } catch {
    mapRootEl.style.setProperty("--map-price-marker-scale", "1");
  }
}

function createOverlayElement(apartment: Apartment, onClick: () => void) {
  const button = document.createElement("button");
  button.className = "price-marker";
  button.type = "button";

  const price = document.createElement("strong");
  price.className = "price-marker-price";
  price.textContent = formatPrice(apartment.latestTrade.priceManwon);

  const name = document.createElement("span");
  name.className = "price-marker-nameplate";
  name.textContent = apartment.complexName;

  const meta = document.createElement("span");
  meta.className = "price-marker-meta price-marker-meta--plain";
  meta.textContent = `${apartment.latestTrade.dealDate} · ${formatArea(apartment.latestTrade.areaM2)}`;

  button.append(name, price, meta);
  button.addEventListener("click", onClick);
  return button;
}

export default function App() {
  const [financePlan, setFinancePlan] = useState(getInitialFinancePlan);
  const [isAuthenticated, setIsAuthenticated] = useState(getInitialAuthState);
  const financePlanRef = useRef(financePlan);
  financePlanRef.current = financePlan;

  useEffect(() => {
    persistFinancePlan(financePlan);
  }, [financePlan]);

  useEffect(() => {
    const flush = () => persistFinancePlan(financePlanRef.current);
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  const handleLogin = (username: string, password: string) => {
    if (username.trim() !== LOGIN_USERNAME || password !== LOGIN_PASSWORD) {
      return false;
    }

    sessionStorage.setItem(AUTH_STORAGE_KEY, "true");
    setIsAuthenticated(true);
    return true;
  };

  const handleLogout = () => {
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
    setIsAuthenticated(false);
  };

  if (!isAuthenticated) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <div className="app-shell-root">
      <AuthenticatedHeader onLogout={handleLogout} />

      <Routes>
        <Route path="/" element={<MapExplorer />} />
        <Route
          path="/finance"
          element={<FinanceStandalonePage financePlan={financePlan} financeOnChange={setFinancePlan} />}
        />
        <Route path="*" element={<Navigate replace to="/" />} />
      </Routes>
    </div>
  );
}

/** --- 헤더 : 지도 / 자금 --- */
function AuthenticatedHeader({ onLogout }: { onLogout: () => void }) {
  return (
    <header className="app-header">
      <div className="brand">
        <p className="eyebrow brand-eyebrow">신혼부부 집 매매</p>
        <div className="brand-row">
          <strong className="brand-name">DulZip</strong>
          <span className="brand-tag">강남역 교통·실거래</span>
        </div>
      </div>

      <nav className="global-nav">
        <NavLink className="nav-link" end to="/">
          지도
        </NavLink>
        <NavLink className="nav-link" to="/finance">
          자금 계획
        </NavLink>
      </nav>

      <button className="header-logout" type="button" onClick={onLogout}>
        로그아웃
      </button>
    </header>
  );
}

/** --- 지도 화면 --- */
function MapExplorer() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<KakaoMap | null>(null);
  const clustererRef = useRef<KakaoClusterer | null>(null);
  const markerRef = useRef<KakaoMarker[]>([]);
  const overlayRef = useRef<KakaoOverlay[]>([]);

  const [data, setData] = useState<ApartmentData | null>(null);
  const [selected, setSelected] = useState<Apartment | null>(null);
  const [query, setQuery] = useState("");
  const [maxGangnamMinutesInput, setMaxGangnamMinutesInput] = useState("");
  const [householdBandMin, setHouseholdBandMin] = useState(HOUSEHOLDS_SLIDER_MIN);
  const [householdBandMax, setHouseholdBandMax] = useState(HOUSEHOLDS_SLIDER_MAX);
  const [tradeDateFrom, setTradeDateFrom] = useState("");
  const [tradeDateTo, setTradeDateTo] = useState("");
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/apartments.json`)
      .then((response) => {
        if (!response.ok) throw new Error("아파트 데이터를 불러오지 못했습니다.");
        return response.json() as Promise<ApartmentData>;
      })
      .then(setData)
      .catch((error: unknown) => setMapError(error instanceof Error ? error.message : "데이터 로딩 실패"));
  }, []);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    loadKakaoMap(import.meta.env.VITE_KAKAO_JS_KEY ?? "")
      .then((kakao) => {
        const center = new kakao.maps.LatLng(GANGNAM_STATION.lat, GANGNAM_STATION.lng);
        const map = new kakao.maps.Map(mapContainerRef.current as HTMLDivElement, {
          center,
          level: 8,
        });
        mapRef.current = map;

        const gangnamMarker = new kakao.maps.Marker({
          position: center,
          title: "강남역",
          map,
        });
        markerRef.current.push(gangnamMarker);

        clustererRef.current = new kakao.maps.MarkerClusterer({
          map,
          averageCenter: true,
          minLevel: 7,
        });
        setMapReady(true);
      })
      .catch((error: unknown) => setMapError(error instanceof Error ? error.message : "카카오지도 로딩 실패"));
  }, []);

  const gangnamTransitMax = useMemo(() => {
    const raw = maxGangnamMinutesInput.trim();
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  }, [maxGangnamMinutesInput]);

  const tradeDateBounds = useMemo(
    () => parseTradeDateBounds(tradeDateFrom, tradeDateTo),
    [tradeDateFrom, tradeDateTo],
  );

  const visibleApartments = useMemo(() => {
    const apartments = data?.apartments ?? [];
    const normalizedQuery = query.trim().toLowerCase();

    return apartments.filter((apartment) => {
      if (!matchesHouseholdSliderBand(apartment.households, householdBandMin, householdBandMax)) {
        return false;
      }

      if (tradeDateBounds && !latestTradeInDateRange(apartment.latestTrade.dealDate, tradeDateBounds)) {
        return false;
      }

      if (gangnamTransitMax !== null) {
        if (!Number.isFinite(apartment.transitMinutes) || apartment.transitMinutes > gangnamTransitMax) {
          return false;
        }
      }

      if (!normalizedQuery) return true;
      const haystack = `${apartment.complexName} ${apartment.address}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [
    data,
    gangnamTransitMax,
    householdBandMin,
    householdBandMax,
    query,
    tradeDateBounds,
  ]);

  useEffect(() => {
    if (!selected) return;
    const stillVisible = visibleApartments.some((a) => a.id === selected.id);
    if (!stillVisible) setSelected(null);
  }, [selected, visibleApartments]);

  useEffect(() => {
    const kakao = window.kakao;
    const map = mapRef.current;
    if (!mapReady || !kakao || !map) return;

    markerRef.current.forEach((marker) => marker.setMap(null));
    overlayRef.current.forEach((overlay) => overlay.setMap(null));
    clustererRef.current?.clear();
    markerRef.current = [];
    overlayRef.current = [];

    const gangnamPosition = new kakao.maps.LatLng(GANGNAM_STATION.lat, GANGNAM_STATION.lng);
    markerRef.current.push(
      new kakao.maps.Marker({
        position: gangnamPosition,
        title: "강남역",
        map,
      }),
    );

    const markers = visibleApartments.map((apartment) => {
      const position = new kakao.maps.LatLng(apartment.lat, apartment.lng);
      const marker = new kakao.maps.Marker({
        position,
        title: markerLabel(apartment),
      });
      kakao.maps.event.addListener(marker, "click", () => setSelected(apartment));

      const overlay = new kakao.maps.CustomOverlay({
        position,
        content: createOverlayElement(apartment, () => setSelected(apartment)),
        yAnchor: 1.35,
      });
      overlay.setMap(map);
      overlayRef.current.push(overlay);
      return marker;
    });

    markerRef.current.push(...markers);
    clustererRef.current?.addMarkers(markers);
    map.relayout();
    const mapRootEl = mapContainerRef.current;
    if (mapRootEl) applyPriceMarkerZoomPresentation(map, mapRootEl);
  }, [mapReady, visibleApartments]);

  useEffect(() => {
    const root = mapContainerRef.current;
    const map = mapRef.current;
    const kakao = window.kakao;
    if (!mapReady || !root || !map || !kakao) return;

    const syncPresentation = () => applyPriceMarkerZoomPresentation(map, root);

    syncPresentation();
    kakao.maps.event.addListener(map, "zoom_changed", syncPresentation);
    kakao.maps.event.addListener(map, "idle", syncPresentation);

    return () => {
      kakao.maps.event.removeListener(map, "zoom_changed", syncPresentation);
      kakao.maps.event.removeListener(map, "idle", syncPresentation);
    };
  }, [mapReady]);

  useEffect(() => {
    if (!selected || !window.kakao || !mapRef.current) return;
    const position = new window.kakao.maps.LatLng(selected.lat, selected.lng);
    mapRef.current.setCenter(position);
    mapRef.current.setLevel(5);
  }, [selected]);

  const summaryText = data
    ? `${visibleApartments.length.toLocaleString("ko-KR")}개 표시 · ${data.summary.apartments.toLocaleString("ko-KR")}개 후보`
    : "데이터 로딩 중";

  return (
    <div className="app-shell map-shell">
      <aside className="sidebar sidebar-wide">
        <section className="stats-card compact-top">
          <div>
            <span>표시 단지</span>
            <strong>{summaryText}</strong>
          </div>
        </section>

        <label className="search-box">
          단지명 또는 주소 검색
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="예: 래미안, 성남시" />
        </label>

        <section className="filter-card" aria-label="세대수 필터">
          <div className="section-heading flush">
            <div>
              <p className="eyebrow">필터</p>
              <h2>세대수 범위</h2>
            </div>
          </div>
          <div className="household-range-field">
            <span>단지 규모 ({HOUSEHOLDS_SLIDER_STEP}세대 단위)</span>
            <HouseholdDualRangeFilter
              bandMax={householdBandMax}
              bandMin={householdBandMin}
              onMaxChange={setHouseholdBandMax}
              onMinChange={setHouseholdBandMin}
            />
          </div>
          <small>
            두 막대 동그라미 사이 세대 구간만 표시합니다. 바를 끝(0과 {HOUSEHOLDS_SLIDER_MAX.toLocaleString("ko-KR")})까지
            벌려 두면 세대 미확인 단지까지 모두 포함됩니다.
          </small>

          <fieldset className="deal-date-filter">
            <legend className="deal-date-filter-legend">실거래일 (단지별 대표 거래)</legend>
            <div className="deal-date-filter-row">
              <label className="gangnam-filter-field deal-date-field">
                시작일
                <input
                  aria-label="실거래 시작일"
                  className="deal-date-input"
                  type="date"
                  value={tradeDateFrom}
                  onChange={(event) => setTradeDateFrom(event.target.value)}
                />
              </label>
              <label className="gangnam-filter-field deal-date-field">
                종료일
                <input
                  aria-label="실거래 종료일"
                  className="deal-date-input"
                  type="date"
                  value={tradeDateTo}
                  onChange={(event) => setTradeDateTo(event.target.value)}
                />
              </label>
            </div>
            <small>
              데이터의 계약일(YYYY-MM-DD)이 해당 구간 안에 있는 단지만 표시합니다. 한쪽만 넣어도 됩니다. 둘 다 비우면
              날짜 제한 없음. 시작이 끝보다 늦으면 자동으로 바꿔 적용합니다.
            </small>
          </fieldset>

          <label className="gangnam-filter-field">
            강남역까지 교통 시간 (분 이하만 표시)
            <input
              inputMode="numeric"
              placeholder="예: 45 · 비워 두면 전체"
              type="number"
              min={1}
              value={maxGangnamMinutesInput}
              onChange={(event) => setMaxGangnamMinutesInput(event.target.value)}
            />
          </label>
          <small>
            데이터상 강남역 도착 예상 시간(분)이 입력값 이하인 단지만 지도와 목록에 남습니다. 교통 시간이 계산되지 않은 단지는 제외됩니다.
          </small>
        </section>

        {mapError ? <div className="notice">{mapError}</div> : null}

        <section className="list list-scroll" aria-label="필터된 아파트 목록">
          {visibleApartments.length === 0 ? (
            <div className="empty">
              <strong>표시할 아파트가 없습니다.</strong>
              <span>로컬에서 `npm run data:build`로 `public/data/apartments.json`을 최신 상태로 만들어 주세요.</span>
            </div>
          ) : (
            visibleApartments.map((apartment) => (
              <button
                className={`apt-row ${selected?.id === apartment.id ? "selected" : ""}`}
                key={apartment.id}
                type="button"
                onClick={() => setSelected(apartment)}
              >
                <span className="apt-row-nameplate">{apartment.complexName}</span>
                <span className="apt-row-price">{formatPrice(apartment.latestTrade.priceManwon)}</span>
                <span className="apt-row-address">{apartment.address}</span>
                <span className="apt-row-meta">
                  <span>{apartment.latestTrade.dealDate}</span>
                  <span className="apt-row-meta-sep">·</span>
                  <span>{formatArea(apartment.latestTrade.areaM2)}</span>
                  <span className="apt-row-meta-sep">·</span>
                  <span>{apartment.transitMinutes}분</span>
                  <span className="apt-row-meta-sep">·</span>
                  <span>
                    {apartment.households ? `${apartment.households.toLocaleString("ko-KR")}세대` : "세대 미확인"}
                  </span>
                </span>
              </button>
            ))
          )}
        </section>
      </aside>

      <main className="map-area">
        <div ref={mapContainerRef} className="map" />
        {selected ? <ApartmentPanel apartment={selected} onClose={() => setSelected(null)} /> : null}
      </main>
    </div>
  );
}

/** --- 자금 전체 화면 --- */
function FinanceStandalonePage({
  financePlan,
  financeOnChange,
}: {
  financePlan: FinancePlan;
  financeOnChange: (plan: FinancePlan) => void;
}) {
  return (
    <div className="finance-page">
      <div className="finance-page-intro">
        <p className="eyebrow">자금계획</p>
        <h2>자금 자동 계산기 및 메모</h2>
        <p className="info-plain muted">
          숫자·메모 포함 전체 플랜은 이 PC의 브라우저 저장소(localStorage)에 수정할 때마다 자동으로 저장됩니다. 다른 기기와
          맞추거나 서버에 남기려면 별도 API·데이터베이스가 필요합니다.
        </p>
      </div>
      <FinancePlanCard plan={financePlan} onChange={financeOnChange} />
      <nav className="back-to-map">
        <NavLink className="back-link" to="/">
          ← 지도로 돌아가기
        </NavLink>
      </nav>
    </div>
  );
}

export function FinancePlanCard({
  plan,
  onChange,
}: {
  plan: FinancePlan;
  onChange: (plan: FinancePlan) => void;
}) {
  const loanManwon = parseManwon(plan.loanManwon);
  const cashManwon = parseManwon(plan.cashManwon);
  const extraCostManwon = parseManwon(plan.extraCostManwon);
  const reserveManwon = parseManwon(plan.reserveManwon);
  const annualRate = Number(plan.annualRate);
  const loanYears = Number(plan.loanYears);
  const monthlyPaymentWon = calculateMonthlyPayment(loanManwon, annualRate, loanYears);
  const totalPaymentWon = monthlyPaymentWon * loanYears * 12;
  const totalInterestManwon = totalPaymentWon / 10_000 - loanManwon;
  const buyingPowerManwon = cashManwon + loanManwon - extraCostManwon - reserveManwon;

  const updatePlan = (key: keyof FinancePlan, value: string) => {
    onChange({ ...plan, [key]: value });
  };

  return (
    <section className="finance-card finance-card-wide">
      <div className="section-heading">
        <div>
          <p className="eyebrow">계산기</p>
          <h2>대출 원리금 계산</h2>
        </div>
        <span>자동 저장</span>
      </div>

      <div className="finance-grid">
        <label>
          보유 현금
          <div className="money-input">
            <input
              inputMode="numeric"
              value={plan.cashManwon}
              onChange={(event) => updatePlan("cashManwon", event.target.value)}
              placeholder="30000"
            />
            <span>만원</span>
          </div>
        </label>
        <label>
          대출금
          <div className="money-input">
            <input
              inputMode="numeric"
              value={plan.loanManwon}
              onChange={(event) => updatePlan("loanManwon", event.target.value)}
              placeholder="50000"
            />
            <span>만원</span>
          </div>
        </label>
        <label>
          연 이자
          <div className="money-input">
            <input
              inputMode="decimal"
              value={plan.annualRate}
              onChange={(event) => updatePlan("annualRate", event.target.value)}
              placeholder="4.0"
            />
            <span>%</span>
          </div>
        </label>
        <label>
          대출 기간
          <div className="money-input">
            <input
              inputMode="numeric"
              value={plan.loanYears}
              onChange={(event) => updatePlan("loanYears", event.target.value)}
              placeholder="30"
            />
            <span>년</span>
          </div>
        </label>
        <label>
          취득/중개/이사비
          <div className="money-input">
            <input
              inputMode="numeric"
              value={plan.extraCostManwon}
              onChange={(event) => updatePlan("extraCostManwon", event.target.value)}
              placeholder="5000"
            />
            <span>만원</span>
          </div>
        </label>
        <label>
          남길 비상금
          <div className="money-input">
            <input
              inputMode="numeric"
              value={plan.reserveManwon}
              onChange={(event) => updatePlan("reserveManwon", event.target.value)}
              placeholder="3000"
            />
            <span>만원</span>
          </div>
        </label>
      </div>

      <dl className="finance-results finance-results-three">
        <div>
          <dt>월 원리금</dt>
          <dd>{monthlyPaymentWon > 0 ? `${Math.round(monthlyPaymentWon).toLocaleString("ko-KR")}원` : "-"}</dd>
        </div>
        <div>
          <dt>총 이자</dt>
          <dd>{formatManwon(totalInterestManwon)}</dd>
        </div>
        <div>
          <dt>실매수 가능 예산</dt>
          <dd>{formatManwon(buyingPowerManwon)}</dd>
        </div>
      </dl>

      <label className="finance-memo">
        메모
        <textarea
          rows={18}
          value={plan.memo ?? ""}
          onChange={(event) => updatePlan("memo", event.target.value)}
          placeholder="예: 월 상환 250만 이하, 전세보증금 회수 후 진행"
        />
        <small className="finance-memo-hint">
          작성 내용은 이 브라우저 저장소에 자동으로 들어가며 다른 기기와는 연결되지 않습니다.
        </small>
      </label>
    </section>
  );
}

/** --- 로그인 --- */

function LoginScreen({ onLogin }: { onLogin: (username: string, password: string) => boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");

    if (!onLogin(username, password)) {
      setError("아이디 또는 비밀번호가 올바르지 않습니다.");
    }
  };

  return (
    <main className="login-shell">
      <section className="login-card">
        <p className="eyebrow">신혼부부 집 매매</p>
        <h1>DulZip</h1>
        <p className="login-copy">허용된 계정으로만 지도와 자금 계획을 확인할 수 있습니다.</p>

        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            아이디
            <input
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="아이디 입력"
            />
          </label>
          <label>
            비밀번호
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="비밀번호 입력"
            />
          </label>
          {error ? <div className="login-error">{error}</div> : null}
          <button type="submit">시작하기</button>
        </form>
      </section>
    </main>
  );
}

function ApartmentPanel({ apartment, onClose }: { apartment: Apartment; onClose: () => void }) {
  return (
    <section className="detail-panel">
      <button className="close-button" type="button" onClick={onClose} aria-label="상세 닫기">
        ×
      </button>
      <p className="eyebrow">{apartment.transitText} · 강남역까지</p>
      <h2>{apartment.complexName}</h2>
      <p className="address">{apartment.address}</p>
      <dl className="detail-grid">
        <div>
          <dt>최근 실거래가</dt>
          <dd>{formatPrice(apartment.latestTrade.priceManwon)}</dd>
        </div>
        <div>
          <dt>계약일</dt>
          <dd>{apartment.latestTrade.dealDate}</dd>
        </div>
        <div>
          <dt>전용면적</dt>
          <dd>{formatArea(apartment.latestTrade.areaM2)}</dd>
        </div>
        <div>
          <dt>건축년도</dt>
          <dd>{apartment.builtYear ?? "-"}</dd>
        </div>
        <div>
          <dt>세대수</dt>
          <dd>{apartment.households ? `${apartment.households.toLocaleString("ko-KR")}세대` : "미확인"}</dd>
        </div>
      </dl>

      <h3>최근 실거래 내역</h3>
      <div className="trade-table" role="table" aria-label="최근 실거래 내역">
        <div className="trade-row header" role="row">
          <span>계약일</span>
          <span>가격</span>
          <span>면적</span>
          <span>층</span>
        </div>
        {apartment.recentTrades.map((trade) => (
          <div className="trade-row" role="row" key={trade.id}>
            <span>{trade.dealDate}</span>
            <span>{formatPrice(trade.priceManwon)}</span>
            <span>{formatArea(trade.areaM2)}</span>
            <span>{trade.floor}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
