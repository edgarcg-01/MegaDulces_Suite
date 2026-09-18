/**
 * LT.0 — Puerto del proveedor de rastreo de flota (hereda ADR-016: el motor
 * decide, el adaptador solo trae datos). Aísla al proveedor externo (hoy
 * MagniTracking / GPS-Server.net) para poder cambiarlo sin tocar el resto.
 */

export type FleetObjectStatus = 'moving' | 'stopped' | 'offline' | 'unknown';

/** Una lectura normalizada de un dispositivo del proveedor. */
export interface FleetObject {
  imei: string; // id del objeto en el proveedor
  name: string; // nombre crudo (suele traer placa + ruta)
  plate?: string; // placa (la API oficial la trae aparte)
  status: FleetObjectStatus;
  statusText?: string; // texto humano del proveedor ("Detenido 16 S")
  simNumber?: string;
  protocol?: string; // ruptela | streamax | ...
  odometer?: number;
  capturedAt?: string; // ISO 8601 del último fix (dt_tracker)
  lat?: number;
  lng?: number;
  speedKmh?: number;
  heading?: number;
  ignition?: boolean;
  altitude?: number;
  /** LT.9 — de qué cuenta del proveedor salió (para depurar, no se persiste). */
  account?: string;
}

/** Operador (chofer/vendedor) del proveedor. */
export interface ProviderOperator {
  id: string;
  name: string;
  contact?: string;
  groupName?: string;
}

/** Un punto histórico de recorrido (para backfill de "información anterior"). */
export interface FleetHistoryPoint {
  imei: string;
  capturedAt: string; // ISO 8601 (dt_tracker → -06:00 MX)
  lat: number;
  lng: number;
  speedKmh?: number;
  heading?: number;
  altitude?: number;
  odometer?: number;
}

/**
 * LT.9 — Resultado de UNA cuenta del proveedor. La flota de Mega Dulces vive en
 * DOS cuentas MagniTracking (medido 2026-09-17: 49 camionetas en la primera, 7
 * unidades pesadas en la segunda, 2 IMEIs compartidos → 54 únicos). Se reporta
 * cuenta por cuenta a propósito: si una se cae y la otra responde, el total
 * baja sin que nada falle — y eso, sin este desglose, se ve igual que "todo bien".
 */
export interface FleetAccountResult {
  label: string; // nombre de la var de entorno de la cuenta (MAGNI_USER, MAGNI_USER2…)
  ok: boolean;
  count: number; // objetos que devolvió ESA cuenta (antes de deduplicar)
  error?: string;
}

/** Lectura de la flota + de dónde salió cada parte. */
export interface FleetFetchResult {
  objects: FleetObject[]; // unión deduplicada por IMEI
  accounts: FleetAccountResult[];
}

/** Ruta de bitácora del proveedor: amarra ruta ↔ operador ↔ camión (IMEI). */
export interface ProviderTravel {
  noPlaneacion: string; // número de planeación (nº de ruta)
  operatorId?: string;
  imei?: string;
  origen?: string;
  destino?: string;
  status?: string;
  fechaSalida?: string;
  fechaLlegada?: string;
}

export interface FleetProviderPort {
  /** Trae la última lectura de TODOS los objetos de TODAS las cuentas. */
  fetchObjects(): Promise<FleetObject[]>;
  /**
   * Igual que `fetchObjects()` pero declarando qué aportó cada cuenta. El
   * llamador debe preferirlo cuando existe: sin el desglose, una cuenta que
   * dejó de responder es indistinguible de una flota más chica.
   */
  fetchObjectsDetailed?(): Promise<FleetFetchResult>;
  /** Operadores de la cuenta (vacío si el proveedor/adaptador no lo soporta). */
  fetchOperators?(): Promise<ProviderOperator[]>;
  /** Rutas activas (para el puente ruta↔operador↔camión). Vacío si no soportado. */
  fetchTravels?(): Promise<ProviderTravel[]>;
  /**
   * Histórico de recorrido de uno o varios IMEIs en un rango (para backfill de
   * "información anterior"). `imeis`=['*'] trae todos. Vacío si no soportado.
   */
  fetchHistory?(imeis: string[], from: string, to: string): Promise<FleetHistoryPoint[]>;
  /** Nombre del proveedor (para columna `provider`). */
  readonly providerName: string;
  /** ¿Hay credenciales configuradas? Si no, el poller no corre. */
  isConfigured(): boolean;
}

export const FLEET_PROVIDER_PORT = 'FLEET_PROVIDER_PORT';
