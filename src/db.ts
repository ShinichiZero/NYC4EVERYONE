/**
 * db.ts – IndexedDB helper for AccessNYC offline storage
 *
 * Stores:
 *   • curbCuts   – CurbCut features from NYC Open Data
 *   • elevators  – MTA elevator last-known status + timestamp
 */

export const DB_NAME    = 'accessnyc-offline';
export const DB_VERSION = 1;

export const STORE_CURBS     = 'curbCuts';
export const STORE_ELEVATORS = 'elevatorStatus';

/** Accessibility compliance state for a curb cut. */
export type CurbCutStatus = 'compliant' | 'high_incline' | 'damaged';

export interface CurbCut {
  /** Unique identifier from NYC Open Data */
  id: string;
  lat: number;
  lon: number;
  status: CurbCutStatus;
  /** Raw address / cross-street description */
  location: string;
  /** ISO 8601 timestamp of last data refresh */
  updatedAt: string;
}

/** Operational state for an MTA elevator. */
export type ElevatorState = 'operational' | 'out_of_service' | 'planned_work' | 'unknown';

export interface ElevatorStatus {
  /** MTA equipment ID */
  equipmentId: string;
  stationName: string;
  /** Human-readable description of the outage */
  reason: string;
  lastKnownState: ElevatorState;
  /** ISO 8601 timestamp of when this status was last fetched/stored */
  timestamp: string;
}

/* ── Open (or upgrade) the database ────────────────────────── */
export function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains(STORE_CURBS)) {
        const curbStore = db.createObjectStore(STORE_CURBS, { keyPath: 'id' });
        curbStore.createIndex('by_lat', 'lat');
        curbStore.createIndex('by_lon', 'lon');
      }

      if (!db.objectStoreNames.contains(STORE_ELEVATORS)) {
        db.createObjectStore(STORE_ELEVATORS, { keyPath: 'equipmentId' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

/* ── Curb Cuts ──────────────────────────────────────────────── */

/** Upsert a batch of curb cuts into the database. */
export function saveCurbCuts(db: IDBDatabase, cuts: CurbCut[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_CURBS, 'readwrite');
    const store = tx.objectStore(STORE_CURBS);
    for (const cut of cuts) {
      store.put(cut);
    }
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

/**
 * Returns all curb cuts whose coordinates fall inside the given bounding box.
 * bbox: [minLon, minLat, maxLon, maxLat]
 */
export function getCurbCutsInBBox(
  db: IDBDatabase,
  bbox: [number, number, number, number],
): Promise<CurbCut[]> {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(STORE_CURBS, 'readonly');
    const store   = tx.objectStore(STORE_CURBS);
    const results: CurbCut[] = [];

    // Use a cursor over the lat index and filter lon in JS
    const latRange = IDBKeyRange.bound(minLat, maxLat);
    const latIndex = store.index('by_lat');
    const req      = latIndex.openCursor(latRange);

    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (!cursor) {
        resolve(results);
        return;
      }
      const cut = cursor.value as CurbCut;
      if (cut.lon >= minLon && cut.lon <= maxLon) {
        results.push(cut);
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/* ── Elevator Status ────────────────────────────────────────── */

/** Upsert a single elevator status record. */
export function saveElevatorStatus(db: IDBDatabase, status: ElevatorStatus): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_ELEVATORS, 'readwrite');
    const store = tx.objectStore(STORE_ELEVATORS);
    store.put(status);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

/** Retrieve the last-known status for a specific elevator by equipment ID. */
export function getElevatorStatus(
  db: IDBDatabase,
  equipmentId: string,
): Promise<ElevatorStatus | null> {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_ELEVATORS, 'readonly');
    const store = tx.objectStore(STORE_ELEVATORS);
    const req   = store.get(equipmentId);
    req.onsuccess = () => resolve((req.result as ElevatorStatus | undefined) ?? null);
    req.onerror   = () => reject(req.error);
  });
}
