import { useEffect, useMemo, useRef, useState } from "react";
import { loadKakaoMap } from "./lib/kakaoMap";
import type { Apartment, ApartmentData } from "./types";

const GANGNAM_STATION = { lat: 37.497952, lng: 127.027619 };

function formatPrice(priceManwon: number) {
  const eok = Math.floor(priceManwon / 10_000);
  const rest = priceManwon % 10_000;
  return rest ? `${eok}억 ${rest.toLocaleString("ko-KR")}만` : `${eok}억`;
}

function formatArea(areaM2: number) {
  return `${areaM2.toFixed(areaM2 % 1 === 0 ? 0 : 2)}㎡`;
}

function markerLabel(apartment: Apartment) {
  return `${formatPrice(apartment.latestTrade.priceManwon)} · ${formatArea(apartment.latestTrade.areaM2)}`;
}

function createOverlayElement(apartment: Apartment, onClick: () => void) {
  const button = document.createElement("button");
  button.className = "price-marker";
  button.type = "button";
  button.innerHTML = `
    <strong>${formatPrice(apartment.latestTrade.priceManwon)}</strong>
    <span>${apartment.latestTrade.dealDate} · ${formatArea(apartment.latestTrade.areaM2)}</span>
  `;
  button.addEventListener("click", onClick);
  return button;
}

export default function App() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<KakaoMap | null>(null);
  const clustererRef = useRef<KakaoClusterer | null>(null);
  const markerRef = useRef<KakaoMarker[]>([]);
  const overlayRef = useRef<KakaoOverlay[]>([]);
  const [data, setData] = useState<ApartmentData | null>(null);
  const [selected, setSelected] = useState<Apartment | null>(null);
  const [query, setQuery] = useState("");
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

  const visibleApartments = useMemo(() => {
    const apartments = data?.apartments ?? [];
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return apartments;

    return apartments.filter((apartment) => {
      const haystack = `${apartment.complexName} ${apartment.address}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [data, query]);

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
  }, [mapReady, visibleApartments]);

  useEffect(() => {
    if (!selected || !window.kakao || !mapRef.current) return;
    const position = new window.kakao.maps.LatLng(selected.lat, selected.lng);
    mapRef.current.setCenter(position);
    mapRef.current.setLevel(5);
  }, [selected]);

  const summaryText = data
    ? `${data.summary.apartments.toLocaleString("ko-KR")}개 단지 · ${data.summary.filteredRows.toLocaleString("ko-KR")}건 거래`
    : "데이터 로딩 중";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <header className="hero">
          <p className="eyebrow">서울·경기 실거래 기반</p>
          <h1>강남역 대중교통 1시간 이내 아파트</h1>
          <p>
            11억 이하, 전용 40㎡ 이상, 취소거래 제외 기준으로 최근 거래가 있는 아파트를 카카오지도 위에 표시합니다.
          </p>
        </header>

        <section className="stats-card">
          <div>
            <span>표시 단지</span>
            <strong>{summaryText}</strong>
          </div>
          <div>
            <span>기준</span>
            <strong>강남역 · 평일 오전 10시 · 60분 이내</strong>
          </div>
          {data?.generatedAt ? <small>데이터 생성: {new Date(data.generatedAt).toLocaleString("ko-KR")}</small> : null}
        </section>

        <label className="search-box">
          단지명 또는 주소 검색
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="예: 래미안, 성남시" />
        </label>

        {mapError ? <div className="notice">{mapError}</div> : null}

        <section className="list">
          {visibleApartments.length === 0 ? (
            <div className="empty">
              <strong>표시할 아파트가 없습니다.</strong>
              <span>API 키를 설정한 뒤 `npm run data:build`를 실행하면 지도 데이터가 생성됩니다.</span>
            </div>
          ) : (
            visibleApartments.slice(0, 80).map((apartment) => (
              <button
                className={`apt-row ${selected?.id === apartment.id ? "selected" : ""}`}
                key={apartment.id}
                type="button"
                onClick={() => setSelected(apartment)}
              >
                <strong>{apartment.complexName}</strong>
                <span>{apartment.address}</span>
                <em>
                  {formatPrice(apartment.latestTrade.priceManwon)} · {apartment.latestTrade.dealDate} ·{" "}
                  {formatArea(apartment.latestTrade.areaM2)} · {apartment.transitMinutes}분
                </em>
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
