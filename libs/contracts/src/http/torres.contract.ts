/**
 * `[TOR.1.1]` Contrato de las torres de control (Fase TOR): **Sistemas** (servidores y carriles de
 * Kepler) y **Desarrollo** (nuestra infraestructura). Reemplazan `/admin/db-health`.
 *
 * El primitivo es la **señal**: algo que hay que atender, con su estado, desde cuándo y de quién
 * es. Vive aquí (ADR-056) para que cualquier bandeja futura lo reuse en vez de inventar la suya.
 */

/** `no_medido` NO es sano: se dibuja gris punteado y nunca cuenta como «todo bien». */
export type EstadoSenal = 'ok' | 'riesgo' | 'falla' | 'no_medido';

export interface SenalTorre {
  /** Llave estable (la del carril o la de la regla). */
  clave: string;
  /** Qué es, en palabras: «Respaldo fuera del servidor». */
  que: string;
  /** Por qué importa o qué dice el dato. */
  porque: string;
  estado: EstadoSenal;
  /** El estado en palabras para la pastilla: «en error», «4 pendientes», «no medido». */
  texto_estado: string;
  /** ISO. Desde cuándo está así; `null` si no se sabe. */
  desde: string | null;
  /** Quién la atiende. `null` = sin dueño, y la pantalla lo dice. */
  dueno: string | null;
  /** id de la alerta persistida, si la hay (para marcarla como vista). */
  alerta_id: string | null;
  vista: boolean;
}

/** Un servidor Kepler de sucursal. Todo lo que no se pudo leer viaja `null`, nunca 0. */
export interface ServidorKepler {
  codigo: string;
  nombre: string;
  /** ¿Responde? `no_medido` si no hay latido del servidor ni del poller. */
  estado: EstadoSenal;
  texto_estado: string;
  /** Motivo de la falla vigente (inalcanzable / lento / slot / tablas). */
  falla: string | null;
  replica_s: number | null;
  errores_replica: number | null;
  disco_retenido_bytes: number | null;
  sin_tope_wal: boolean | null;
  tablas_publicadas: number | null;
  arranque: string | null;
  /** Horario habitual de HOY, derivado de su propia venta («08:09»). `null` = sin venta al público. */
  abre: string | null;
  cierra: string | null;
  caidas_30d: number | null;
  caida_mas_larga_min: number | null;
  ultimo_latido: string | null;
}

export interface CaidaKepler {
  codigo: string;
  desde: string;
  hasta: string;
  minutos: number;
  /** `inalcanzable` (red o servidor apagado) · `lento` (contesta pero no termina) · `otro`. */
  tipo: 'inalcanzable' | 'lento' | 'otro';
}

export interface CarrilTorre {
  clave: string;
  nombre: string;
  estado: EstadoSenal;
  texto_estado: string;
  lineas: string[];
}

export interface TorreSistemas {
  verificado_al: string;
  servidores: ServidorKepler[];
  /** Caídas de 10 min o más en 30 días, la más reciente primero. `null` = no se pudo leer. */
  caidas: CaidaKepler[] | null;
  atender: SenalTorre[];
  otros: CarrilTorre[];
  /** Alertas abiertas en 30 días y cuántas se avisaron fuera de la pantalla. */
  avisos: { abiertas_30d: number; notificadas_30d: number } | null;
  mesa: { abiertos: number; asignados: number; en_espera: number } | null;
}

export interface EntregaTorre {
  /** `null` en los tres = no se pudo leer GitHub (se declara, no se inventa). */
  main: string | null;
  sellado: string | null;
  soltado: string | null;
  corriendo: string;
  arriba_desde: string | null;
  /** Commits sellados que todavía no se sueltan; `null` = no medido. */
  sin_soltar: number | null;
  /** Migraciones sin aplicar; `null` = no medido. */
  migraciones_pendientes: number | null;
}

export interface TorreDesarrollo {
  verificado_al: string;
  entrega: EntregaTorre;
  atender: SenalTorre[];
  carriles: CarrilTorre[];
}

/** Lo que cuenta el encabezado. Lo `no_medido` se cuenta aparte: nunca suma a «bien». */
export function resumenDeSenales(senales: readonly { estado: EstadoSenal }[]): { fallas: number; riesgos: number; no_medidos: number; ok: number } {
  let fallas = 0, riesgos = 0, no_medidos = 0, ok = 0;
  for (const s of senales) {
    if (s.estado === 'falla') fallas++;
    else if (s.estado === 'riesgo') riesgos++;
    else if (s.estado === 'no_medido') no_medidos++;
    else ok++;
  }
  return { fallas, riesgos, no_medidos, ok };
}

/** Orden de la bandeja: lo roto primero, después el riesgo, después lo no medido; dentro, lo más viejo primero. */
export function ordenarSenales<T extends { estado: EstadoSenal; desde: string | null }>(senales: readonly T[]): T[] {
  const peso: Record<EstadoSenal, number> = { falla: 0, riesgo: 1, no_medido: 2, ok: 3 };
  return [...senales].sort((a, b) =>
    (peso[a.estado] - peso[b.estado])
    || ((a.desde ? Date.parse(a.desde) : Number.MAX_SAFE_INTEGER) - (b.desde ? Date.parse(b.desde) : Number.MAX_SAFE_INTEGER)));
}

/**
 * `[TOR.1.2]` ¿A qué torre va un carril? A **Sistemas** lo que LLEGA de otro servidor (Kepler, los
 * puntos de venta, ContPAQi, CAOS, los relojes, el GPS): su falla se arregla en ese servidor o en su
 * enlace. Todo lo demás es nuestra plataforma y va a **Desarrollo**. Ninguna llave queda sin torre.
 */
export const TORRE_SISTEMAS_RX = /^(kepler_|ods_|cdc_|store_|caja_general|wincaja|route_|rd_route|feed_|fleet|consolidado|stock|cedis|hr_attendance|libro_kepler|libro_caos|gastos_cierre_kepler|caos_movimientos|caos_conteo|contpaqi_add|sales_daily)/;

export function torreDeLlave(clave: string): 'sistemas' | 'desarrollo' {
  return TORRE_SISTEMAS_RX.test(clave) ? 'sistemas' : 'desarrollo';
}
