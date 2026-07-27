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

export interface FleetProviderPort {
  /** Trae la última lectura de TODOS los objetos de la cuenta. */
  fetchObjects(): Promise<FleetObject[]>;
  /** Nombre del proveedor (para columna `provider`). */
  readonly providerName: string;
  /** ¿Hay credenciales configuradas? Si no, el poller no corre. */
  isConfigured(): boolean;
}

export const FLEET_PROVIDER_PORT = 'FLEET_PROVIDER_PORT';
