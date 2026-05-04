export type Trade = {
  id: string;
  city: string;
  lotNumber: string;
  complexName: string;
  areaM2: number;
  dealDate: string;
  priceManwon: number;
  building: string;
  floor: string;
  builtYear: number | null;
  roadName: string;
  tradeType: string;
  brokerageLocation: string;
};

export type Apartment = {
  id: string;
  complexName: string;
  address: string;
  city: string;
  roadName: string;
  builtYear: number | null;
  lat: number;
  lng: number;
  transitMinutes: number;
  transitText: string;
  latestTrade: Trade;
  recentTrades: Trade[];
};

export type ApartmentData = {
  generatedAt: string | null;
  sourceFiles: string[];
  criteria: {
    maxPriceManwon: number;
    minAreaM2: number;
    transitOrigin: string;
    maxTransitMinutes: number;
    departureLabel: string;
  };
  summary: {
    rawRows: number;
    filteredRows: number;
    apartmentsBeforeTransit: number;
    apartments: number;
    geocodeMissing: number;
    transitMissing: number;
  };
  apartments: Apartment[];
};
