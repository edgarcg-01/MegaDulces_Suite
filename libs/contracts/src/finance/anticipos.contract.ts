/**
 * `[PGP.118]` **Anticipos a proveedor** — el submódulo de *Deuda con proveedores*.
 *
 * Un anticipo es el documento `X-D-60` de Kepler (`kdxe.c4 = 60`) que todavía no se aplicó entero a
 * una factura (`kdxf`). Sirve a `GET /finance/payment-calendar/anticipos` (la lista) y a
 * `GET /finance/payment-calendar/anticipos/deuda` (lo que le debemos a esos mismos acreedores, que
 * es contra lo que se puede aplicar).
 *
 * ⭐ El árbitro es Kepler: `a_favor` (importe − lo aplicado en `kdxf`) coincide con el remanente que
 * guarda Kepler (`kdxe.c20`) en 64 de 64 documentos sin aplicar, y los 144 aplicados enteros de 12
 * meses tienen `c20 = 0` (prod, sólo lectura, 2026-11-13).
 *
 * ⚠️ **No todo `X-D-60` es anticipo de mercancía** (D2 de PGP, 2026-11-13). El tipo de acreedor sale
 * del prefijo de su código: `C*` mercancía, `G*` gasto, `TC*` tarjeta. Los tres se publican, por
 * separado: esconder `G*`/`TC*` haría que el total no cuadre con Kepler; mezclarlos haría que la
 * cifra de «anticipos a proveedor» mienta. Medido: $4.96 M `C*` · $1.68 M `G*` · $0.38 M `TC*`.
 *
 * ⚠️ Las cifras llegan como `number`: el SQL castea a `::float8` (sin eso node-pg entrega texto).
 */

/** De qué es el acreedor, por el prefijo de su código en Kepler. */
export type AnticipoTipoAcreedor = 'mercancia' | 'gasto' | 'tarjeta' | 'otro';

/** En qué grupo del submódulo cae un anticipo. `calculando` = la deuda todavía no llega: nunca se pinta como «sin deuda». */
export type AnticipoGrupo = 'aplicable' | 'sin_contra_que' | 'no_mercancia' | 'calculando';

/** Antigüedad del documento. `+90` es lo que se le exige a Compras: factura o reembolso (D4). */
export type AnticipoTramo = '0-30' | '31-90' | '+90' | 'sin_fecha';

/** Un anticipo sin aplicar. */
export interface AnticipoRow {
  /** Código de sucursal de Kepler. La pantalla muestra el NOMBRE, nunca el código. */
  sucursal: string;
  /** Código del acreedor en Kepler. */
  proveedor: string;
  /** Razón social; `null` si el catálogo no la tiene (se muestra el código, nunca vacío). */
  proveedor_nombre: string | null;
  folio: string;
  /** Texto libre que capturaron en Kepler (`kdxe.c16`); `null` si vino vacío. */
  referencia: string | null;
  /** `YYYY-MM-DD`. */
  fecha: string | null;
  /** Días desde la fecha del documento; `null` sin fecha. */
  dias: number | null;
  importe: number;
  /** Lo que Kepler ya aplicó contra alguna factura. */
  aplicado: number;
  /** Lo que queda por aplicar (= `kdxe.c20`). */
  a_favor: number;
  /**
   * `[PGP.120]` Lo ya apartado en pagos NO CANCELADOS del Calendario (renglones «Anticipo» de sus
   * facturas) que Kepler todavía no aplica. Lo que queda para otra factura es `a_favor − apartado`.
   */
  apartado: number;
}

/**
 * `[PGP.120]` La deuda viva de un acreedor EN UNA SUCURSAL. Un anticipo sólo se aplica contra facturas
 * de su misma sucursal: Kepler aplica abono y factura en la misma base (115 de 115 aplicaciones de
 * `X-D-60` en 12 meses, medido el 2026-11-13). Sumar la deuda de todas las sucursales inflaba lo
 * aplicable hoy: $2.18 M contra $2.02 M reales.
 */
export interface AnticipoDeudaRow {
  proveedor: string;
  sucursal: string;
  /** Facturas con saldo. */
  facturas: number;
  /** Lo que le debemos, en pesos. */
  deuda: number;
  /** El vencimiento más próximo, `YYYY-MM-DD`. */
  vence_primero: string | null;
}

/** Tolerancia de redondeo: medio centavo, como el resto de PGP. */
const CENTAVO = 0.005;

export function tipoDeAcreedor(codigo: string | null | undefined): AnticipoTipoAcreedor {
  const c = String(codigo ?? '').trim().toUpperCase();
  if (c.startsWith('TC')) return 'tarjeta';
  if (c.startsWith('G')) return 'gasto';
  if (c.startsWith('C')) return 'mercancia';
  return 'otro';
}

/**
 * El grupo. `deuda` es lo que le debemos al acreedor: `null` mientras no llegó (la consulta va en
 * diferido) — y eso es `calculando`, no «sin contra qué».
 */
export function grupoDeAnticipo(proveedor: string | null | undefined, deuda: number | null | undefined): AnticipoGrupo {
  if (tipoDeAcreedor(proveedor) !== 'mercancia') return 'no_mercancia';
  if (deuda === null || deuda === undefined || !Number.isFinite(deuda)) return 'calculando';
  return deuda > CENTAVO ? 'aplicable' : 'sin_contra_que';
}

export function tramoDeAnticipo(dias: number | null | undefined): AnticipoTramo {
  if (dias === null || dias === undefined || !Number.isFinite(dias)) return 'sin_fecha';
  if (dias <= 30) return '0-30';
  if (dias <= 90) return '31-90';
  return '+90';
}

/** `[PGP.120]` La llave acreedor + sucursal: la que casa un anticipo con su deuda y con una factura del pago. */
export function llaveAnticipo(proveedor: string | null | undefined, sucursal: string | null | undefined): string {
  return `${String(proveedor ?? '').trim().toUpperCase()}|${String(sucursal ?? '').trim()}`;
}

/** `[PGP.120]` Lo que queda de un anticipo para aplicar en otra factura: lo que Kepler guarda menos lo apartado. */
export function disponibleDeAnticipo(r: Pick<AnticipoRow, 'a_favor' | 'apartado'>): number {
  const d = Number(r.a_favor) - Number(r.apartado ?? 0);
  return Number.isFinite(d) ? Math.max(0, Math.round(d * 100) / 100) : 0;
}

/** Lo que se puede netear hoy contra la deuda de ese acreedor: nunca más que ninguno de los dos. */
export function neteableHoy(aFavor: number, deuda: number | null | undefined): number | null {
  if (deuda === null || deuda === undefined || !Number.isFinite(deuda) || !Number.isFinite(aFavor)) return null;
  return Math.max(0, Math.min(aFavor, deuda));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// `[PGP.119]` **Solicitar un anticipo desde la Suite** — Compras lo pide, entra al Calendario como
// cualquier obligación y sale por el carril de siempre (Dirección autoriza el pago, Tesorería paga).
// Se liga solo con el `X-D-60` cuando Cuentas por pagar lo captura en Kepler, y se cierra cuando Kepler
// lo aplica a una factura. Medido el 2026-11-13: 16 a 31 anticipos por mes (~$1.5 M) salían por fuera.
// ════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `[PGP.119]` D6: el anticipo no pasa del saldo de su OC (100 %). Constante en el contrato por ahora:
 * cambiarla es cambiar este número (todavía no hay dónde configurarlo sin código).
 */
export const TOPE_ANTICIPO_SOBRE_OC = 1;

/** Lo que manda la pantalla para pedir un anticipo. */
export interface AnticipoSolicitudBody {
  supplier_id: string;
  /** Sucursal de Kepler donde se capturará el `X-D-60`: sólo se aplica contra facturas de ESA sucursal. */
  sucursal: string;
  monto: number;
  motivo: string;
  /** OC de la Suite a la que va atado (opcional: la referencia de Kepler no cita OC, medido 2026-11-13). */
  purchase_order_id?: string | null;
  /** Día en que se quiere pagar, `YYYY-MM-DD`; sin él, hoy. */
  fecha?: string | null;
}

/** Una OC abierta del proveedor, con lo que ya se le pidió de anticipo. */
export interface AnticipoOcRow {
  id: string;
  folio: string;
  /** Código de la sucursal de la OC (`commercial.warehouses.code` = clave de Kepler). */
  sucursal: string | null;
  estado: string;
  total: number;
  /** Anticipos ya pedidos sobre esta OC (no cancelados). */
  anticipado: number;
  creada: string | null;
}

/** Un proveedor que puede recibir anticipo (de mercancía, activo). */
export interface AnticipoProveedorRow {
  id: string;
  code: string;
  name: string;
}

/** En qué va una solicitud. */
export type EtapaSolicitudAnticipo = 'por_programar' | 'programado' | 'pagado' | 'en_kepler' | 'aplicado' | 'cancelado';

/** Un `X-D-60` de Kepler que podría ser el de una solicitud. */
export interface CandidatoAnticipoKepler {
  folio: string;
  fecha: string;
  importe: number;
  /** Lo que Kepler guarda sin aplicar (`kdxe.c20`). */
  remanente: number;
}

/** Una solicitud de anticipo con su seguimiento. */
export interface AnticipoSolicitadoRow {
  obligation_id: string;
  proveedor: string;
  proveedor_nombre: string;
  sucursal: string | null;
  monto: number;
  motivo: string | null;
  oc_folio: string | null;
  creado_por: string | null;
  /** `YYYY-MM-DD`. */
  creado: string;
  fecha_deseada: string | null;
  estado_obligacion: string;
  pagado: number;
  /** El pago del Calendario que lo lleva (el más reciente no cancelado). */
  programado_dia: string | null;
  allocation_id: string | null;
  /** El `X-D-60` con que se ligó; null si todavía no está en Kepler. */
  kepler: CandidatoAnticipoKepler | null;
  /** Cuántos `X-D-60` podían ser (más de 1 = se eligió el de fecha más cercana; se dice). */
  posibles: number;
  etapa: EtapaSolicitudAnticipo;
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * `[PGP.119]` **Por qué todavía no se puede pedir** (null = se puede). La MISMA regla en la pantalla
 * (botón apagado con la razón) y en el servidor (que vuelve a leer la OC de la base, no le cree al cliente).
 */
export function faltaSolicitudAnticipo(s: {
  supplier_code: string | null | undefined; sucursal: string | null | undefined; monto: unknown; motivo: string | null | undefined;
  fecha?: string | null; oc?: { total: number; anticipado: number; folio?: string } | null;
}): string | null {
  if (!s.supplier_code) return 'Elige el proveedor.';
  if (tipoDeAcreedor(s.supplier_code) !== 'mercancia') return 'Sólo se da anticipo a proveedores de mercancía (código C…): gasto y tarjeta no llevan anticipo.';
  if (!/^\d{2}$/.test(String(s.sucursal ?? '').trim())) return 'Elige la sucursal donde se capturará el anticipo en Kepler.';
  const monto = Number(s.monto);
  if (!Number.isFinite(monto) || !(r2(monto) > 0)) return 'Captura el importe del anticipo.';
  if ((s.motivo ?? '').trim().length < 3) return 'Di para qué es el anticipo (motivo).';
  if (s.fecha) {
    const d = new Date(`${s.fecha}T12:00:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.fecha) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s.fecha) return 'La fecha de pago no se entiende.';
  }
  if (s.oc) {
    const queda = r2(Number(s.oc.total) * TOPE_ANTICIPO_SOBRE_OC - Number(s.oc.anticipado));
    if (r2(monto) > queda + 0.005) {
      return `La OC${s.oc.folio ? ' ' + s.oc.folio : ''} es de $${Number(s.oc.total).toFixed(2)} y ya tiene $${Number(s.oc.anticipado).toFixed(2)} en anticipos: quedan $${Math.max(0, queda).toFixed(2)}.`;
    }
  }
  return null;
}

/**
 * `[PGP.119]` **Liga cada solicitud con su `X-D-60`**, uno a uno: mismo acreedor y sucursal, importe ±$1
 * y fecha cercana al alta (los candidatos ya vienen filtrados así por la consulta). Se recorre de la
 * solicitud más vieja a la más nueva y cada una toma el candidato libre de fecha más cercana.
 * ⭐ Control negativo medido el 2026-11-13: de 143 `X-D-60` de 12 meses, sólo 4 tienen otro del mismo
 * acreedor + sucursal ±$1 en ±30 días; por eso el pareo es casi siempre único, y cuando no, se dice.
 */
export function parearSolicitudes<T extends { obligation_id: string; proveedor: string; sucursal: string | null; creado: string; candidatos: CandidatoAnticipoKepler[] }>(
  sols: readonly T[],
): Map<string, { kepler: CandidatoAnticipoKepler | null; posibles: number }> {
  const usados = new Set<string>();
  const out = new Map<string, { kepler: CandidatoAnticipoKepler | null; posibles: number }>();
  const dia = (s: string) => new Date(`${s.slice(0, 10)}T12:00:00`).getTime();
  for (const s of [...sols].sort((a, b) => a.creado.localeCompare(b.creado) || a.obligation_id.localeCompare(b.obligation_id))) {
    const llave = (c: CandidatoAnticipoKepler) => `${llaveAnticipo(s.proveedor, s.sucursal)}|${c.folio}`;
    const libres = (s.candidatos ?? []).filter((c) => !usados.has(llave(c)))
      .sort((a, b) => Math.abs(dia(a.fecha) - dia(s.creado)) - Math.abs(dia(b.fecha) - dia(s.creado)) || a.folio.localeCompare(b.folio));
    const elegido = libres[0] ?? null;
    if (elegido) usados.add(llave(elegido));
    out.set(s.obligation_id, { kepler: elegido, posibles: (s.candidatos ?? []).length });
  }
  return out;
}

/** `[PGP.119]` La etapa: lo que dice Kepler manda sobre lo que dice la Suite (el pago puede no estar marcado). */
export function etapaDeSolicitud(s: {
  estado_obligacion: string; monto: number; pagado: number; programado_dia: string | null; kepler: CandidatoAnticipoKepler | null;
}): EtapaSolicitudAnticipo {
  if (s.estado_obligacion === 'cancelled') return 'cancelado';
  if (s.kepler) return Number(s.kepler.remanente) <= 0.005 ? 'aplicado' : 'en_kepler';
  if (Number(s.pagado) >= Number(s.monto) - 0.005) return 'pagado';
  if (s.programado_dia) return 'programado';
  return 'por_programar';
}
