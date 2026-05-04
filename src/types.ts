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
  households: number | null;
  householdsSource: string | null;
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
    householdFileLoaded?: boolean;
    householdMatchRequired?: boolean;
    complexNameFilter?: {
      mode: "none" | "officetel_only" | "officetel_and_villa";
      appliedKeywords: string[];
      officetelOnlyKeywords: string[];
      officetelAndVillaKeywords: string[];
    };
    minHouseholds?: number;
    householdAllowedClassifications?: string[];
    pythonMergedCsv?: string | null;
  };
  summary: {
    rawRows: number;
    filteredRowsCsv?: number;
    preprocessDroppedNoHouseholdMatch?: number;
    preprocessDroppedMinHouseholds?: number;
    filteredRows: number;
    skippedComplexFilter?: number;
    skippedComplexSamples?: string[];
    householdsMatched?: number;
    householdsMissing?: number;
    skippedHouseholdsFilter?: number;
    apartmentsBeforeTransit: number;
    apartments: number;
    geocodeMissing: number;
    transitMissing: number;
    skippedTransitOverOneHour?: number;
    dedupeDroppedOlderSameComplexArea?: number;
  };
  apartments: Apartment[];
};
