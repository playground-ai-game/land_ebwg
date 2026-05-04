/// <reference types="vite/client" />

type KakaoMapApi = {
  maps: {
    load: (callback: () => void) => void;
    LatLng: new (lat: number, lng: number) => unknown;
    Map: new (container: HTMLElement, options: Record<string, unknown>) => KakaoMap;
    Marker: new (options: Record<string, unknown>) => KakaoMarker;
    CustomOverlay: new (options: Record<string, unknown>) => KakaoOverlay;
    MarkerClusterer: new (options: Record<string, unknown>) => KakaoClusterer;
    event: {
      addListener: (target: unknown, event: string, callback: () => void) => void;
    };
  };
};

type KakaoMap = {
  setCenter: (position: unknown) => void;
  setLevel: (level: number) => void;
  relayout: () => void;
};

type KakaoMarker = {
  setMap: (map: KakaoMap | null) => void;
};

type KakaoOverlay = {
  setMap: (map: KakaoMap | null) => void;
};

type KakaoClusterer = {
  addMarkers: (markers: KakaoMarker[]) => void;
  clear: () => void;
};

interface Window {
  kakao?: KakaoMapApi;
}
