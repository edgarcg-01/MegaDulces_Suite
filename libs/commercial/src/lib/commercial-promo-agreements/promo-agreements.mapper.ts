/**
 * `[MKT.1]` — El recorte del dinero y la forma de salida, como funciones PURAS.
 *
 * ── Por qué viven fuera del servicio ─────────────────────────────────────────────────────────
 * Esto es la regla que decide si el **monto negociado con el proveedor** sale del servidor o no.
 * Si vive como método privado, la única forma de probarla es a través de una consulta a Postgres
 * — y entonces el test que vigila la fuga de datos depende de que la base esté levantada, o sea
 * que en la práctica no corre. Acá es TypeScript puro: se prueba directo y siempre.
 *
 * ── La distinción que sostiene todo ──────────────────────────────────────────────────────────
 *   · la clave **ausente** (`undefined`)  → «no te toca verlo»
 *   · la clave **en `null`**              → «te toca verlo, y no se pactó monto»
 *
 * No son lo mismo y por eso no se colapsan a 0. Un `monto: 0` se lee como «no cuesta nada», que
 * es la conclusión contraria a la verdadera (ADR-056).
 */

export type AgreementStatus = 'borrador' | 'autorizado' | 'vigente' | 'cerrado' | 'cancelado';
export type ApoyoTipo = 'sell_out' | 'sell_in' | 'exhibicion' | 'promocional' | 'otro';

/** Los `numeric` de Postgres llegan como string por el driver: se convierten en un solo lugar. */
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
export const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/**
 * Una fecha de Postgres a `YYYY-MM-DD` sin re-interpretarla.
 *
 * ⚠️ `new Date('2026-09-01').toLocaleDateString()` devuelve **el 31 de agosto** en hora de México:
 * pg entrega `date` como medianoche UTC y al renderizarlo en −06:00 se cae un día. Ese error
 * exacto ya se pagó en la Fase LC (facturas del día 1 fechadas el 31 en el TXT y en el respaldo).
 * Se corta el string y no se construye ningún `Date`.
 */
export const soloFecha = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v).slice(0, 10);

export interface AcuerdoResumen {
  id: string;
  folio: string | null;
  proveedor: string;
  apoyo: ApoyoTipo;
  mecanica: string;
  status: AgreementStatus;
  vigencia_desde: string | null;
  vigencia_hasta: string | null;
  vigencia_hasta_texto: string | null;
  /** Presente SÓLO con `MKT_AGREEMENTS_GESTIONAR`. Ausente ≠ `null`. */
  monto?: number | null;
  canales_total: number;
  canales_con_evidencia: number;
  evidencia_total: number;
}

export interface CanalExpediente {
  id: string;
  warehouse_code: string;
  warehouse_name: string | null;
  cajas_texto: string | null;
  cajas_lp: number | null;
  cajas_can: number | null;
  cajas_mor: number | null;
  con_cargo: boolean | null;
  evidence_required: number;
  evidence_count: number;
  evidence_last_at: string | null;
  completo: boolean;
}

/** Fila del tablero. `verDinero=false` omite la clave `monto`, no la pone en 0. */
export function mapearResumen(r: Record<string, unknown>, verDinero: boolean): AcuerdoResumen {
  const base: AcuerdoResumen = {
    id: String(r['id']),
    folio: (r['folio'] as string) ?? null,
    proveedor: String(r['proveedor']),
    apoyo: r['apoyo'] as ApoyoTipo,
    mecanica: String(r['mecanica'] ?? ''),
    status: r['status'] as AgreementStatus,
    vigencia_desde: soloFecha(r['vigencia_desde']),
    vigencia_hasta: soloFecha(r['vigencia_hasta']),
    vigencia_hasta_texto: (r['vigencia_hasta_texto'] as string) ?? null,
    canales_total: num(r['canales_total']),
    canales_con_evidencia: num(r['canales_con_evidencia']),
    evidencia_total: num(r['evidencia_total']),
  };
  if (verDinero) base.monto = numOrNull(r['monto']);
  return base;
}

/** Las cinco claves que sólo puede ver quien gestiona los acuerdos. */
export const CLAVES_DE_DINERO = [
  'monto',
  'presupuesto_tipo',
  'presupuesto_detalle',
  'presupuesto_fecha',
  'conceptos',
] as const;

/**
 * Carátula del formato. Con `verDinero=false` **ninguna** de `CLAVES_DE_DINERO` aparece en el
 * objeto: el recorte es en el servidor, no un `*ngIf` en la pantalla (ese JSON se abre con F12).
 */
export function mapearCabecera(fila: Record<string, unknown>, verDinero: boolean): Record<string, unknown> {
  const salida: Record<string, unknown> = {
    id: fila['id'],
    folio: fila['folio'],
    formato: fila['formato'],
    empresa: fila['empresa'],
    proveedor: fila['proveedor'],
    apoyo: fila['apoyo'],
    agente_ventas: fila['agente_ventas'],
    fecha_negociacion: soloFecha(fila['fecha_negociacion']),
    periodo: fila['periodo'],
    vigencia_desde: soloFecha(fila['vigencia_desde']),
    vigencia_hasta: soloFecha(fila['vigencia_hasta']),
    vigencia_hasta_texto: fila['vigencia_hasta_texto'],
    oferta_negociada: fila['oferta_negociada'],
    mecanica: fila['mecanica'],
    recurso: fila['recurso'],
    recurso_otros: fila['recurso_otros'],
    distribucion_producto: fila['distribucion_producto'],
    distribucion_codigo: fila['distribucion_codigo'],
    distribucion_cargo: fila['distribucion_cargo'],
    autoriza_nombre: fila['autoriza_nombre'],
    status: fila['status'],
    authorized_by_username: fila['authorized_by_username'],
    authorized_at: fila['authorized_at'],
    created_by_username: fila['created_by_username'],
    created_at: fila['created_at'],
  };
  if (verDinero) {
    salida['monto'] = numOrNull(fila['monto']);
    salida['presupuesto_tipo'] = fila['presupuesto_tipo'];
    salida['presupuesto_detalle'] = fila['presupuesto_detalle'];
    salida['presupuesto_fecha'] = soloFecha(fila['presupuesto_fecha']);
    salida['conceptos'] = fila['conceptos'];
  }
  return salida;
}

/** Un expediente de plaza. `completo` se DERIVA, no se guarda: un flag guardado se desincroniza. */
export function mapearCanal(c: Record<string, unknown>): CanalExpediente {
  const req = num(c['evidence_required']);
  const hay = num(c['evidence_count']);
  return {
    id: String(c['id']),
    warehouse_code: String(c['warehouse_code']),
    warehouse_name: (c['warehouse_name'] as string) ?? null,
    cajas_texto: (c['cajas_texto'] as string) ?? null,
    cajas_lp: numOrNull(c['cajas_lp']),
    cajas_can: numOrNull(c['cajas_can']),
    cajas_mor: numOrNull(c['cajas_mor']),
    con_cargo: (c['con_cargo'] as boolean) ?? null,
    evidence_required: req,
    evidence_count: hay,
    evidence_last_at: c['evidence_last_at'] ? String(c['evidence_last_at']) : null,
    // `>=` y no `===`: si alguien sube una foto de más, el expediente sigue completo.
    completo: hay >= req,
  };
}
