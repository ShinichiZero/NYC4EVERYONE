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

/* ── MapLibre is loaded as a global via CDN script tag ─────── */
declare const maplibregl: typeof import('maplibre-gl');

/* ── Configuration ───────────────────────────────────────────── */
// Replace with a real MapTiler / self-hosted tile URL
const TILE_URL_TEMPLATE =
  'https://api.maptiler.com/maps/streets/tiles/{z}/{x}/{y}.png?key=YOUR_MAPTILER_KEY';

// NYC Open Data / MTA curb-cut & elevator layer endpoints are handled
// inside OfflineManager.  Set your MTA API key here or via env variable.
const MTA_API_KEY: string | undefined = undefined; // 'YOUR_MTA_KEY'

/* ── Bootstrap ───────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', async () => {
  /* ── 1. Open IndexedDB ──────────────────────────────────── */
  const db = await openDB();

  /* ── 2. Init map ────────────────────────────────────────── */
  const map = new maplibregl.Map({
    container: 'map',
    style:     'https://api.maptiler.com/maps/streets/style.json?key=YOUR_MAPTILER_KEY',
    center:    [-73.9857, 40.7484], // Midtown Manhattan
    zoom:      13,
  });

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

  /* ── 5. UI wiring ───────────────────────────────────────── */
  wireOfflineToggle();
  wireCacheAreaButton(offlineManager, map);
  wireCacheRouteButton(offlineManager);

  /* ── 6. Map layers ──────────────────────────────────────── */
  map.on('load', () => {
    addCurbCutLayer(map);
    addElevatorLayer(map);
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

  map.on('mouseenter', 'curb-cuts', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'curb-cuts', () => { map.getCanvas().style.cursor = ''; });
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
    type:   'symbol',
    source: 'elevators',
    layout: {
      'icon-image':           'elevator-icon',
      'icon-size':            0.8,
      'icon-allow-overlap':   true,
      'text-field':           ['get', 'stationName'],
      'text-offset':          [0, 1.5],
      'text-size':            11,
      'text-allow-overlap':   false,
    },
    paint: {
      'text-color': '#e0e0e0',
      'text-halo-color': 'rgba(0,0,0,0.7)',
      'text-halo-width': 1,
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
    } catch (err) {
      hideProgress();
      console.error('[AccessNYC] Cache route failed:', err);
    }
  });
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
