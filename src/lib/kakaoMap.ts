let kakaoPromise: Promise<KakaoMapApi> | null = null;

export function loadKakaoMap(appKey: string) {
  if (!appKey) {
    return Promise.reject(new Error("VITE_KAKAO_JS_KEY is missing."));
  }

  if (window.kakao?.maps) {
    return new Promise<KakaoMapApi>((resolve) => window.kakao?.maps.load(() => resolve(window.kakao as KakaoMapApi)));
  }

  if (kakaoPromise) return kakaoPromise;

  kakaoPromise = new Promise<KakaoMapApi>((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>("script[data-kakao-map]");
    if (existingScript) {
      existingScript.addEventListener("load", () => window.kakao?.maps.load(() => resolve(window.kakao as KakaoMapApi)));
      existingScript.addEventListener("error", () => reject(new Error("Failed to load Kakao map script.")));
      return;
    }

    const script = document.createElement("script");
    script.dataset.kakaoMap = "true";
    script.async = true;
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${appKey}&autoload=false&libraries=clusterer`;
    script.addEventListener("load", () => window.kakao?.maps.load(() => resolve(window.kakao as KakaoMapApi)));
    script.addEventListener("error", () => reject(new Error("Failed to load Kakao map script.")));
    document.head.appendChild(script);
  });

  return kakaoPromise;
}
