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
}

/** La deuda viva de un acreedor que tiene anticipo sin aplicar. */
export interface AnticipoDeudaRow {
  proveedor: string;
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

/** Lo que se puede netear hoy contra la deuda de ese acreedor: nunca más que ninguno de los dos. */
export function neteableHoy(aFavor: number, deuda: number | null | undefined): number | null {
  if (deuda === null || deuda === undefined || !Number.isFinite(deuda) || !Number.isFinite(aFavor)) return null;
  return Math.max(0, Math.min(aFavor, deuda));
}
