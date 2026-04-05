/**
 * main.ts – AccessNYC app entry point
 *
 * Wires together:
 *   • MapLibre GL map
 *   • OfflineManager (Cache Area & Cache Route)
 *   • SanitizedPopup (elevator alerts, curb-cut details)
 *   • Offline toggle UI
 *   • Curb-cut and elevator map layers
 */

import { OfflineManager } from './OfflineManager.js';
import { cacheRoute }     from './RouteCacher.js';
import { SanitizedPopup } from './SanitizedPopup.js';
import { openDB, saveElevatorStatus } from './db.js';
import type { ElevatorStatus } from './db.js';
import type { Map as MLMap } from 'maplibre-gl';
import type { Style } from 'maplibre-gl';

/* ── MapLibre is loaded as a global via CDN script tag ─────── */
declare const maplibregl: typeof import('maplibre-gl');

/* ── Configuration ───────────────────────────────────────────── */
// Replace with a real MapTiler / self-hosted tile URL
const TILE_URL_TEMPLATE =
  'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

// NYC Open Data / MTA curb-cut & elevator layer endpoints are handled
// inside OfflineManager.  Set your MTA API key here or via env variable.
const MTA_API_KEY: string | undefined = undefined; // 'YOUR_MTA_KEY'
const DEFAULT_ZOOM_LEVEL = 15;
const MIN_ROUTE_COORDS = 2;
const COORDINATE_TUPLE_LENGTH = 2;
const MAP_STYLE: Style = {
  version: 8,
  sources: {
    'osm-raster': {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution:
        '© OpenStreetMap contributors',
    },
    terrain: {
      type: 'raster-dem',
      encoding: 'terrarium',
      tiles: [
        'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      maxzoom: 15,
    },
  },
  layers: [
    {
      id: 'osm-raster-layer',
      type: 'raster',
      source: 'osm-raster',
      minzoom: 0,
      maxzoom: 22,
    },
  ],
};
const NYC_BOUNDS: [number, number, number, number] = [-74.30, 40.45, -73.65, 40.95];
const NYC_BOUNDS_BOX = {
  minLon: NYC_BOUNDS[0],
  minLat: NYC_BOUNDS[1],
  maxLon: NYC_BOUNDS[2],
  maxLat: NYC_BOUNDS[3],
};
type CurbStatusFilter = 'compliant' | 'high_incline' | 'damaged';
type MutableGeoJSONSource = { setData: (data: GeoJSON.FeatureCollection) => void };
interface CurbFeatureRecord {
  id: string;
  lat: number;
  lon: number;
  status: CurbStatusFilter;
  location: string;
  updatedAt: string;
}
interface ComplaintRecord {
  unique_key?: string;
  latitude?: string;
  longitude?: string;
  complaint_type?: string;
  descriptor?: string;
  incident_address?: string;
  created_date?: string;
}
interface GeocoderRecord {
  display_name?: string;
  the_geom?: {
    coordinates?: [number, number];
  };
}
const CONDITION_STATUS_MAP: Record<string, CurbStatusFilter> = {
  good: 'compliant',
  fair: 'high_incline',
  poor: 'damaged',
  damaged: 'damaged',
};
const appState: {
  map: MLMap | null;
  popup: SanitizedPopup | null;
  routeCaptureEnabled: boolean;
  routeCoords: [number, number][];
  is3d: boolean;
  curbFeatures: CurbFeatureRecord[];
  complaintsGeoJson: GeoJSON.FeatureCollection<GeoJSON.Point>;
} = {
  map: null,
  popup: null,
  routeCaptureEnabled: false,
  routeCoords: [],
  is3d: false,
  curbFeatures: [],
  complaintsGeoJson: {
    type: 'FeatureCollection',
    features: [],
  },
};

/* ── Bootstrap ───────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', async () => {
  /* ── 1. Open IndexedDB ──────────────────────────────────── */
  const db = await openDB();

  /* ── 2. Init map ────────────────────────────────────────── */
  const map = new maplibregl.Map({
    container: 'map',
    style:     MAP_STYLE,
    center:    [-73.9857, 40.7484], // Midtown Manhattan
    zoom:      13,
    maxBounds: NYC_BOUNDS,
    pitch: 25,
  });
  appState.map = map;

  /* ── 3. Offline Manager ─────────────────────────────────── */
  const offlineManager = new OfflineManager({
    tileUrlTemplate: TILE_URL_TEMPLATE,
    ...(MTA_API_KEY !== undefined ? { mtaApiKey: MTA_API_KEY } : {}),
    onProgress:      updateProgressBar,
  });
  await offlineManager.init();

  /* ── 4. Popup ───────────────────────────────────────────── */
  const popupContainer = document.getElementById('popup-container');
  const popup = popupContainer ? new SanitizedPopup(popupContainer) : null;
  appState.popup = popup;

  /* ── 5. UI wiring ───────────────────────────────────────── */
  wireOfflineToggle();
  wireCacheAreaButton(offlineManager, map);
  wireCacheRouteButton(offlineManager);
  wireMapControls(map, offlineManager);

  /* ── 6. Map layers ──────────────────────────────────────── */
  map.on('load', () => {
    addCurbCutLayer(map);
    addElevatorLayer(map);
    addRouteLayer(map);
    addComplaintLayer(map);
    restoreRouteFromSession(map);
    void refreshData(map);
  });

  /* ── 7. "Save for Offline" elevator listener ─────────────── */
  document.addEventListener('accessnyc:saveElevator', async (e) => {
    const detail = (e as CustomEvent<{ status: ElevatorStatus }>).detail;
    await saveElevatorStatus(db, detail.status);
  });

  /* ── Popup on curb-cut click ──────────────────────────────── */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  map.on('click', 'curb-cuts', (e: any) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const feature = e.features?.[0] as { properties: Record<string, unknown> } | undefined;
    if (!feature || !popup) return;
    const props = feature.properties;
    popup.renderCurbCut({
      id:        String(props['id'] ?? ''),
      lat:       (e as { lngLat: { lat: number } }).lngLat.lat,
      lon:       (e as { lngLat: { lng: number } }).lngLat.lng,
      status:    (props['status'] as 'compliant' | 'high_incline' | 'damaged') ?? 'compliant',
      location:  String(props['location'] ?? ''),
      updatedAt: String(props['updatedAt'] ?? ''),
    });
  });
  map.on('click', 'complaints', (e) => {
    const feature = e.features?.[0];
    if (!feature || !popup) return;
    popup.renderInfoCard(
      String(feature.properties?.['title'] ?? '311 accessibility complaint'),
      String(feature.properties?.['address'] ?? 'Location details unavailable'),
      String(feature.properties?.['created'] ?? ''),
    );
  });
  map.on('click', (e) => handleMapClickForRouteCapture(e.lngLat.lng, e.lngLat.lat));

  map.on('mouseenter', 'curb-cuts', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'curb-cuts', () => { map.getCanvas().style.cursor = ''; });
  map.on('mouseenter', 'complaints', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'complaints', () => { map.getCanvas().style.cursor = ''; });
});

/* ── Layer definitions ──────────────────────────────────────── */

function addCurbCutLayer(map: MLMap): void {
  // GeoJSON source — populated from IndexedDB / live API
  map.addSource('curb-cuts', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addLayer({
    id:     'curb-cuts',
    type:   'circle',
    source: 'curb-cuts',
    paint:  {
      'circle-radius': 6,
      // Data-driven colour: Green = compliant, Yellow = high_incline, Red = damaged
      'circle-color': [
        'match',
        ['get', 'status'],
        'compliant',    '#4caf50',
        'high_incline', '#ff9800',
        'damaged',      '#f44336',
        /* fallback */  '#9e9e9e',
      ],
      'circle-stroke-width': 1.5,
      'circle-stroke-color': 'rgba(0,0,0,0.35)',
    },
  });
}

function addElevatorLayer(map: MLMap): void {
  map.addSource('elevators', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addLayer({
    id:     'elevators',
    type:   'circle',
    source: 'elevators',
    paint: {
      'circle-radius': 5,
      'circle-color': '#2196f3',
      'circle-stroke-width': 1,
      'circle-stroke-color': '#0b1d32',
    },
  });
  map.addLayer({
    id: 'elevator-labels',
    type: 'symbol',
    source: 'elevators',
    layout: {
      'text-field': ['get', 'stationName'],
      'text-offset': [0, 1.2],
      'text-size': 11,
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#90caf9',
      'text-halo-color': 'rgba(0,0,0,0.72)',
      'text-halo-width': 1,
    },
  });
}

function addRouteLayer(map: MLMap): void {
  map.addSource('user-route', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: [],
    },
  });
  map.addLayer({
    id: 'user-route',
    source: 'user-route',
    type: 'line',
    paint: {
      'line-color': '#03a9f4',
      'line-width': 4,
      'line-opacity': 0.9,
    },
  });
}

function addComplaintLayer(map: MLMap): void {
  map.addSource('complaints', {
    type: 'geojson',
    data: appState.complaintsGeoJson,
  });
  map.addLayer({
    id: 'complaints',
    source: 'complaints',
    type: 'circle',
    paint: {
      'circle-radius': 4,
      'circle-color': '#ab47bc',
      'circle-stroke-width': 1,
      'circle-stroke-color': '#2a0b2f',
      'circle-opacity': 0.85,
    },
  });
}

/* ── Offline toggle UI ──────────────────────────────────────── */

function wireOfflineToggle(): void {
  const btn   = document.getElementById('btn-offline-toggle');
  const panel = document.getElementById('offline-panel');
  if (!btn || !panel) return;

  btn.addEventListener('click', () => {
    const isOpen = btn.getAttribute('aria-pressed') === 'true';
    btn.setAttribute('aria-pressed', String(!isOpen));
    btn.textContent = isOpen ? 'Go Offline' : 'Online ✓';
    panel.hidden = isOpen;
  });
}

function wireMapControls(managerMap: MLMap, manager: OfflineManager): void {
  const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
  const btnSearch = document.getElementById('btn-search');
  const btnLocate = document.getElementById('btn-locate');
  const btn3d = document.getElementById('btn-3d');
  const btnRefresh = document.getElementById('btn-refresh-data');
  const toggleCurbCuts = document.getElementById('toggle-curbcuts') as HTMLInputElement | null;
  const toggleComplaints = document.getElementById('toggle-complaints') as HTMLInputElement | null;
  const btnRouteCapture = document.getElementById('btn-route-capture');
  const btnRouteClear = document.getElementById('btn-route-clear');
  const filterCompliant = document.getElementById('filter-compliant') as HTMLInputElement | null;
  const filterHighIncline = document.getElementById('filter-high-incline') as HTMLInputElement | null;
  const filterDamaged = document.getElementById('filter-damaged') as HTMLInputElement | null;

  const runSearch = (): void => {
    const query = searchInput?.value.trim();
    if (!query) return;
    void geocodeAndFlyTo(managerMap, query);
  };
  btnSearch?.addEventListener('click', runSearch);
  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });

  btnLocate?.addEventListener('click', () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((position) => {
      managerMap.flyTo({
        center: [position.coords.longitude, position.coords.latitude],
        zoom: DEFAULT_ZOOM_LEVEL,
      });
    });
  });

  btn3d?.addEventListener('click', () => {
    appState.is3d = !appState.is3d;
    btn3d.setAttribute('aria-pressed', String(appState.is3d));
    managerMap.setPitch(appState.is3d ? 60 : 25);
    const mapWithTerrain = managerMap as MLMap & {
      setTerrain?: (config: { source: string; exaggeration?: number } | null) => void;
    };
    if (appState.is3d) {
      try {
        if (typeof mapWithTerrain.setTerrain === 'function') {
          mapWithTerrain.setTerrain({ source: 'terrain', exaggeration: 1.2 });
        }
      } catch {
        managerMap.setPitch(60);
      }
    } else {
      if (typeof mapWithTerrain.setTerrain === 'function') {
        mapWithTerrain.setTerrain(null);
      }
    }
  });

  btnRefresh?.addEventListener('click', () => {
    void manager.init().then(() => refreshData(managerMap)).catch((error) => {
      console.error('[AccessNYC] Refresh init failed:', error);
      updateSummary('Refresh failed. Please try again.');
    });
  });

  toggleCurbCuts?.addEventListener('change', () => {
    managerMap.setLayoutProperty('curb-cuts', 'visibility', toggleCurbCuts.checked ? 'visible' : 'none');
  });
  toggleComplaints?.addEventListener('change', () => {
    managerMap.setLayoutProperty('complaints', 'visibility', toggleComplaints.checked ? 'visible' : 'none');
  });

  btnRouteCapture?.addEventListener('click', () => {
    appState.routeCaptureEnabled = !appState.routeCaptureEnabled;
    btnRouteCapture.setAttribute('aria-pressed', String(appState.routeCaptureEnabled));
  });
  btnRouteClear?.addEventListener('click', () => {
    appState.routeCoords = [];
    persistRoute();
    renderRoute(managerMap);
  });

  const applyStatusFilter = (): void => {
    const active: CurbStatusFilter[] = [];
    if (filterCompliant?.checked) active.push('compliant');
    if (filterHighIncline?.checked) active.push('high_incline');
    if (filterDamaged?.checked) active.push('damaged');
    const filtered = appState.curbFeatures.filter((feature) => active.includes(feature.status));
    updateCurbSource(managerMap, filtered);
  };
  filterCompliant?.addEventListener('change', applyStatusFilter);
  filterHighIncline?.addEventListener('change', applyStatusFilter);
  filterDamaged?.addEventListener('change', applyStatusFilter);
}

/* ── Cache Area button ──────────────────────────────────────── */

function wireCacheAreaButton(
  manager: OfflineManager,
  map: MLMap,
): void {
  const btn = document.getElementById('btn-cache-area');
  if (!btn) return;

  btn.addEventListener('click', () => {
    const centre = map.getCenter();
    showProgress();
    manager
      .cacheArea(centre.lat, centre.lng)
      .then((result) => {
        hideProgress();
        console.info('[AccessNYC] Area cached:', result);
        void refreshData(map);
      })
      .catch((err) => {
        hideProgress();
        console.error('[AccessNYC] Cache area failed:', err);
      });
  });
}

/* ── Cache Route button ─────────────────────────────────────── */

function wireCacheRouteButton(manager: OfflineManager): void {
  const btn = document.getElementById('btn-cache-route');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    // Example: retrieve the current route from sessionStorage / a global
    const stored = sessionStorage.getItem('currentRoute');
    if (!stored) {
      alert('No active route.  Start navigation first.');
      return;
    }
    try {
      const lineString = JSON.parse(stored) as GeoJSON.LineString;
      showProgress();
      const result = await cacheRoute(lineString, {
        tileUrlTemplate: TILE_URL_TEMPLATE,
        onProgress:      updateProgressBar,
      });
      hideProgress();
      console.info('[AccessNYC] Route cached:', result);
      const map = appState.map;
      if (map) await refreshData(map);
    } catch (err) {
      hideProgress();
      console.error('[AccessNYC] Cache route failed:', err);
    }
  });
}

function handleMapClickForRouteCapture(lon: number, lat: number): void {
  if (!appState.routeCaptureEnabled) return;
  appState.routeCoords.push([lon, lat]);
  persistRoute();
  if (appState.map) renderRoute(appState.map);
}

function persistRoute(): void {
  if (appState.routeCoords.length < MIN_ROUTE_COORDS) return;
  const lineString: GeoJSON.LineString = {
    type: 'LineString',
    coordinates: appState.routeCoords,
  };
  sessionStorage.setItem('currentRoute', JSON.stringify(lineString));
}

function restoreRouteFromSession(map: MLMap): void {
  const stored = sessionStorage.getItem('currentRoute');
  if (!stored) return;
  try {
    const line = JSON.parse(stored) as GeoJSON.LineString;
    if (line.type !== 'LineString' || line.coordinates.length < MIN_ROUTE_COORDS) return;
    appState.routeCoords = line.coordinates
      .filter((coord): coord is [number, number] =>
        Array.isArray(coord) &&
        coord.length === COORDINATE_TUPLE_LENGTH &&
        Number.isFinite(coord[0]) &&
        Number.isFinite(coord[1]))
      .map((coord) => [coord[0], coord[1]]);
    renderRoute(map);
  } catch {
    sessionStorage.removeItem('currentRoute');
  }
}

function renderRoute(map: MLMap): void {
  const src = map.getSource('user-route') as MutableGeoJSONSource | undefined;
  if (!src) return;
  const featureCollection: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features:
      appState.routeCoords.length < MIN_ROUTE_COORDS
        ? []
        : [{
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: appState.routeCoords,
            },
            properties: {},
          }],
  };
  src.setData(featureCollection);
}

function updateSummary(text: string): void {
  const el = document.getElementById('data-summary');
  if (el) el.textContent = text;
}

async function geocodeAndFlyTo(map: MLMap, query: string): Promise<void> {
  try {
    const searchParams = new URLSearchParams({
      '$limit': '1',
      '$select': 'display_name,the_geom',
      '$q': query,
    });
    const url = `https://data.cityofnewyork.us/resource/ge8j-uqbf.json?${searchParams.toString()}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return;
    const data = (await response.json()) as GeocoderRecord[];
    const first = data[0];
    const coords = first?.the_geom?.coordinates;
    if (!coords) return;
    map.flyTo({ center: [Number(coords[0]), Number(coords[1])], zoom: DEFAULT_ZOOM_LEVEL });
  } catch {
    updateSummary('Search unavailable right now.');
  }
}

async function refreshData(map: MLMap): Promise<void> {
  updateSummary('Loading NYC accessibility data…');
  try {
    const bounds = map.getBounds();
    const minLon = sanitizeBound(bounds.getWest(), 'lon', NYC_BOUNDS_BOX.minLon, NYC_BOUNDS_BOX.maxLon);
    const minLat = sanitizeBound(bounds.getSouth(), 'lat', NYC_BOUNDS_BOX.minLat, NYC_BOUNDS_BOX.maxLat);
    const maxLon = sanitizeBound(bounds.getEast(), 'lon', NYC_BOUNDS_BOX.minLon, NYC_BOUNDS_BOX.maxLon);
    const maxLat = sanitizeBound(bounds.getNorth(), 'lat', NYC_BOUNDS_BOX.minLat, NYC_BOUNDS_BOX.maxLat);
    const safeMaxLat = maxLat.toFixed(6);
    const safeMinLon = minLon.toFixed(6);
    const safeMinLat = minLat.toFixed(6);
    const safeMaxLon = maxLon.toFixed(6);
    // Socrata within_box order: top-left(lat, lon), bottom-right(lat, lon)
    const curbWhereClause = encodeURIComponent(`within_box(the_geom, ${safeMaxLat}, ${safeMinLon}, ${safeMinLat}, ${safeMaxLon})`);
    const curbUrl = `https://data.cityofnewyork.us/resource/mz9f-kzab.json?$limit=5000&$where=${curbWhereClause}`;
    const complaintsUrl = `https://data.cityofnewyork.us/resource/erm2-nwe9.json?$limit=300&$where=${encodeURIComponent(
      `within_box(location, ${safeMaxLat}, ${safeMinLon}, ${safeMinLat}, ${safeMaxLon}) AND descriptor like '%Access%'`,
    )}`;
    const [curbResp, complaintsResp] = await Promise.all([
      fetch(curbUrl, { headers: { Accept: 'application/json' } }),
      fetch(complaintsUrl, { headers: { Accept: 'application/json' } }),
    ]);
    const curbRaw = curbResp.ok ? (await curbResp.json()) as Array<Record<string, unknown>> : [];
    const complaintsRaw = complaintsResp.ok ? (await complaintsResp.json()) as ComplaintRecord[] : [];
    const curbFeatures = curbRaw
      .map((item) => {
        const lat = Number(item['latitude']);
        const lon = Number(item['longitude']);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        const condition = String(item['physical_condition'] ?? '').toLowerCase();
        const status = inferCurbStatus(condition);
        const sourceUpdatedAt = item['updated_at'];
        const sourceTimestamp = typeof sourceUpdatedAt === 'string' ? sourceUpdatedAt : new Date().toISOString();
        return {
          id: String(item['objectid'] ?? `${lat},${lon}`),
          lat,
          lon,
          status,
          location: String(item['on_street'] ?? ''),
          updatedAt: sourceTimestamp,
        } satisfies CurbFeatureRecord;
      })
      .filter((feature): feature is CurbFeatureRecord => feature !== null);
    appState.curbFeatures = curbFeatures;
    updateCurbSource(map, curbFeatures);
    const complaintFeatures: GeoJSON.Feature<GeoJSON.Point>[] = [];
    for (const row of complaintsRaw) {
      const lat = Number(row.latitude);
      const lon = Number(row.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      complaintFeatures.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [lon, lat],
        },
        properties: {
          id: row.unique_key ?? '',
          title: row.descriptor ?? row.complaint_type ?? '311 accessibility complaint',
          created: row.created_date ?? '',
          address: row.incident_address ?? '',
        },
      });
    }
    const complaintsGeoJson: GeoJSON.FeatureCollection<GeoJSON.Point> = {
      type: 'FeatureCollection',
      features: complaintFeatures,
    };
    appState.complaintsGeoJson = complaintsGeoJson;
    const complaintsSource = map.getSource('complaints') as MutableGeoJSONSource | undefined;
    if (complaintsSource) complaintsSource.setData(complaintsGeoJson);
    updateSummary(`Loaded ${curbFeatures.length} curb cuts and ${complaintsGeoJson.features.length} 311 records.`);
  } catch {
    updateSummary('Could not load NYC data. Check network and retry.');
  }
}

function updateCurbSource(map: MLMap, features: CurbFeatureRecord[]): void {
  const source = map.getSource('curb-cuts') as MutableGeoJSONSource | undefined;
  if (!source) return;
  const geojson: GeoJSON.FeatureCollection<GeoJSON.Point> = {
    type: 'FeatureCollection',
    features: features.map((feature) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [feature.lon, feature.lat],
      },
      properties: {
        id: feature.id,
        status: feature.status,
        location: feature.location,
        updatedAt: feature.updatedAt,
      },
    })),
  };
  source.setData(geojson);
}

function sanitizeBound(
  value: number,
  axis: 'lat' | 'lon',
  min: number,
  max: number,
): number {
  const fallback = axis === 'lat' ? 40.75 : -73.98;
  const safe = Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, safe));
}

function inferCurbStatus(condition: string): CurbStatusFilter {
  if (condition === '') return 'compliant';
  const mapped = Object.entries(CONDITION_STATUS_MAP).find(([key]) => condition.includes(key))?.[1];
  if (mapped) return mapped;
  if (condition.includes('slope')) return 'high_incline';
  return 'damaged';
}

/* ── Progress bar helpers ────────────────────────────────────── */

function showProgress(): void {
  const el = document.getElementById('cache-progress');
  if (el) el.hidden = false;
}

function hideProgress(): void {
  const el = document.getElementById('cache-progress');
  if (el) el.hidden = true;
  updateProgressBar(0);
}

function updateProgressBar(fraction: number): void {
  const fill  = document.querySelector<HTMLElement>('.cache-progress__fill');
  const bar   = document.querySelector('[role="progressbar"]');
  const label = document.querySelector<HTMLElement>('.cache-progress__label');
  const pct   = Math.round(fraction * 100);

  if (fill)  fill.style.width = `${pct}%`;
  if (bar)   bar.setAttribute('aria-valuenow', String(pct));
  if (label) label.textContent = pct < 100 ? `Downloading… ${pct}%` : 'Download complete ✓';
}
