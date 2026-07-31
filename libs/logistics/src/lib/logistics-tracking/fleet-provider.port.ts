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
}

/** Operador (chofer/vendedor) del proveedor. */
export interface ProviderOperator {
  id: string;
  name: string;
  contact?: string;
  groupName?: string;
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
  /** Trae la última lectura de TODOS los objetos de la cuenta. */
  fetchObjects(): Promise<FleetObject[]>;
  /** Operadores de la cuenta (vacío si el proveedor/adaptador no lo soporta). */
  fetchOperators?(): Promise<ProviderOperator[]>;
  /** Rutas activas (para el puente ruta↔operador↔camión). Vacío si no soportado. */
  fetchTravels?(): Promise<ProviderTravel[]>;
  /** Nombre del proveedor (para columna `provider`). */
  readonly providerName: string;
  /** ¿Hay credenciales configuradas? Si no, el poller no corre. */
  isConfigured(): boolean;
}

export const FLEET_PROVIDER_PORT = 'FLEET_PROVIDER_PORT';
