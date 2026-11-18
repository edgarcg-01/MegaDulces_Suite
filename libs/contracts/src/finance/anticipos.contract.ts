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
import { clabeValida } from './clabe.contract';
import { Permission } from '../authz/permissions';

/**
 * `[PGP.138]` ADR-120 + `[PGP.142]` — **quién pide un anticipo**: Compras, que lo negocia con el proveedor
 * (`COMPRAS_OBLIGACIONES_GESTIONAR`), y Dirección, que autoriza el Calendario (`FINANCE_PAYMENT_CALENDAR_AUTORIZAR`).
 * Basta UNA. **Tesorería, Finanzas y Contabilidad (`FINANCE_PAYMENTS_GESTIONAR`) no**: «Tesorería paga, Compras
 * registra la deuda» (`[TP.13]`, ADR-064). La MISMA lista para el servidor (`@RequireAnyPermission` de pedir, sus
 * lecturas y su cancelación) y para las pantallas (los botones): ninguna puerta ofrece un botón que el servidor rechaza.
 *
 * Historia: el 2026-11-17 Francisco había decidido D14 («Finanzas y Compras»: también quien programa pagos) y Edgar,
 * el mismo día, el ADR-120 («sólo Dirección»). El 2026-11-18 Francisco se alineó al ADR-120: D14 queda sustituida.
 */
export const PERMISOS_PEDIR_ANTICIPO = [
  Permission.COMPRAS_OBLIGACIONES_GESTIONAR, Permission.FINANCE_PAYMENT_CALENDAR_AUTORIZAR,
] as const;

/**
 * `[PGP.142]` Lo que responden las dos cancelaciones de obligación a proveedor (`POST :id/cancelar`, de
 * Compras, y `POST anticipos/:id/cancelar`): la fila ya cancelada. Viaja la fila entera; esto es lo que se
 * puede leer de ella. Las pantallas sólo releen su lista.
 */
export interface ObligacionCancelada {
  id: string;
  nature: 'factura' | 'anticipo';
  status: string;
  /** El motivo del pedido y, al final, `[cancelado] <razón>` (ver `partirMotivo`). */
  notes: string | null;
  updated_by: string | null;
}

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

/**
 * `[PGP.127]` Una orden de compra de Kepler (`X-A-35`) a la que va el anticipo. La llave del documento
 * es sucursal + serie + folio (`kdm1.c1`, `c5`, `c6`). Se guarda como REFERENCIA: la OC se lee viva.
 */
export interface RefOcKepler { sucursal: string; serie: string; folio: string }

/** `[PGP.127]` La cotización ya subida al almacenamiento privado (`POST …/anticipo/cotizacion`). */
export interface CotizacionSubida { key: string; kind: 'pdf' | 'image' }

/**
 * `[PGP.127]` D12 — **a qué cuenta se paga el anticipo.** La cuenta aprobada del proveedor, una CLABE
 * nueva de la cotización (nace la solicitud de alta y Dirección la aprueba antes de pagar), o efectivo.
 */
export type CuentaDelAnticipo =
  | { tipo: 'aprobada'; account_id: string }
  | { tipo: 'nueva'; clabe: string; banco: string }
  | { tipo: 'efectivo' };

/** Lo que manda la pantalla para pedir un anticipo. */
export interface AnticipoSolicitudBody {
  supplier_id: string;
  /** Sucursal de Kepler donde se capturará el `X-D-60`: sólo se aplica contra facturas de ESA sucursal. `[PGP.127]` = la de sus OC. */
  sucursal: string;
  monto: number;
  motivo: string;
  /**
   * OC de la Suite. `[PGP.127]` Ya no la ofrece la pantalla: la Suite dejó de hacer OC el 26-oct (D21 de
   * PQ). Se sigue aceptando para no romper a un cliente viejo; la OC que se exige es la de Kepler.
   */
  purchase_order_id?: string | null;
  /** Día en que se quiere pagar, `YYYY-MM-DD`; sin él, hoy. */
  fecha?: string | null;
  /** `[PGP.127]` D11 — las `X-A-35` de Kepler del anticipo (una o varias, de la misma sucursal). */
  kepler_ocs?: RefOcKepler[] | null;
  /** `[PGP.127]` D10 — la cotización (obligatoria). */
  cotizacion?: CotizacionSubida | null;
  /** `[PGP.127]` D12 — a qué cuenta se paga. */
  cuenta?: CuentaDelAnticipo | null;
}

/**
 * `[PGP.127]` Una OC de Kepler del proveedor, pendiente (`N`) o recibida en parte (`R`), con los anticipos
 * de la Suite (no cancelados) que la incluyen. ⚠️ El estado `A` (9 en 90 días) no se midió y no se ofrece.
 */
export interface AnticipoOcKeplerRow extends RefOcKepler {
  /** `YYYY-MM-DD` (`kdm1.c9`). */
  fecha: string;
  estado: string;
  /** `kdm1.c16`. */
  total: number;
  /** Cada anticipo una vez, aunque abarque varias OC: el tope de varias se cuenta sin repetirlo. */
  pedidos: { id: string; monto: number }[];
}

/** `[PGP.127]` La llave de una OC de Kepler. */
export function llaveOcKepler(o: RefOcKepler): string {
  return `${String(o.sucursal ?? '').trim()}|${String(o.serie ?? '').trim()}|${String(o.folio ?? '').trim()}`;
}

/**
 * `[PGP.127]` D6 sobre las OC de Kepler: **la suma de sus totales menos lo ya pedido sobre ellas**, cada
 * pedido una sola vez aunque abarque varias de las elegidas. Medido: una OC alcanza el importe en 34 de
 * 49 anticipos; la suma de las del periodo, en 40.
 */
export function topeDeOcs(ocs: readonly Pick<AnticipoOcKeplerRow, 'total' | 'pedidos'>[]): { total: number; anticipado: number; queda: number } {
  const total = r2(ocs.reduce((s, o) => s + Number(o.total || 0), 0));
  const vistos = new Map<string, number>();
  for (const o of ocs) for (const p of o.pedidos ?? []) vistos.set(p.id, Number(p.monto || 0));
  const anticipado = r2([...vistos.values()].reduce((s, m) => s + m, 0));
  return { total, anticipado, queda: r2(total * TOPE_ANTICIPO_SOBRE_OC - anticipado) };
}

/** `[PGP.127]` La CLABE con sólo sus dígitos (se acepta pegada con espacios o guiones). */
export function digitosClabe(t: string | null | undefined): string {
  return String(t ?? '').replace(/\D/g, '');
}

/** `[PGP.127]` D12 — por qué la cuenta todavía no sirve (null = sirve). */
export function faltaCuentaAnticipo(c: CuentaDelAnticipo | null | undefined): string | null {
  if (!c) return 'Di a qué cuenta se paga (la de la cotización) o si se paga en efectivo.';
  if (c.tipo === 'efectivo') return null;
  if (c.tipo === 'aprobada') return /^[0-9a-f-]{36}$/i.test(String(c.account_id ?? '')) ? null : 'Elige la cuenta aprobada.';
  if (c.tipo === 'nueva') {
    const d = digitosClabe(c.clabe);
    if (d.length !== 18) return `La CLABE lleva 18 dígitos${d.length ? ` (van ${d.length})` : ''}.`;
    if (!clabeValida(d)) return 'La CLABE no es válida: el dígito de control no cuadra. Revísala contra la cotización.';
    if (String(c.banco ?? '').trim().length < 2) return 'Escribe el banco de la CLABE.';
    return null;
  }
  return 'Di a qué cuenta se paga.';
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
  /**
   * `[PGP.144]` El día (`YYYY-MM-DD`, hora de México) en que ese pago se dio por pagado: desde ahí está
   * CUBIERTO. `null` mientras no se paga. Opcional para los consumidores de antes.
   */
  cubierto_el?: string | null;
  allocation_id: string | null;
  /** El `X-D-60` con que se ligó; null si todavía no está en Kepler. */
  kepler: CandidatoAnticipoKepler | null;
  /** Cuántos `X-D-60` podían ser (más de 1 = se eligió el de fecha más cercana; se dice). */
  posibles: number;
  etapa: EtapaSolicitudAnticipo;
  /** `[PGP.129]` El proveedor: con él, el Calendario arma la llave del pago sin adivinarla. */
  supplier_id: string;
  /** `[PGP.129]` Lo que falta programar: importe − reservado − pagado. */
  disponible: number;
  /** `[PGP.127]` Las OC de Kepler del pedido (vacío en los pedidos de antes). */
  ocs: RefOcKepler[];
  /** `[PGP.127]` Tiene cotización (se abre con `GET …/anticipos/:id/cotizacion`). */
  tiene_cotizacion: boolean;
  /** `[PGP.127]` La cuenta, derivada al leer del catálogo y sus solicitudes. */
  cuenta: { estado: EstadoCuentaAnticipo; clabe: string | null; banco: string | null };
}

/**
 * `[PGP.127]` D12 — **en qué va la cuenta del anticipo.** Se deriva de la CLABE guardada en el pedido
 * contra el catálogo (`supplier_payment_accounts`) y sus solicitudes: nunca se copia, para que no pueda
 * contradecirlas.
 *  · `aprobada` — hay una cuenta ACTIVA del proveedor con esa CLABE.
 *  · `en_aprobacion` — su solicitud de alta espera a Dirección.
 *  · `rechazada` — Dirección la rechazó: hay que pedirle otra cuenta al proveedor.
 *  · `sin_cuenta` — ni activa ni pendiente (p. ej. se dio de baja después).
 *  · `efectivo` — se pidió para pagarse en efectivo.
 *  · `sin_dato` — pedido antes de `[PGP.127]`: no trae ni cotización ni cuenta.
 */
export type EstadoCuentaAnticipo = 'aprobada' | 'en_aprobacion' | 'rechazada' | 'sin_cuenta' | 'efectivo' | 'sin_dato';

export function estadoCuentaAnticipo(s: {
  payee_clabe: string | null; tiene_cotizacion: boolean; banco_aprobada: string | null; solicitud_estado: string | null;
}): EstadoCuentaAnticipo {
  if (!s.payee_clabe) return s.tiene_cotizacion ? 'efectivo' : 'sin_dato';
  if (s.banco_aprobada != null) return 'aprobada';
  if (s.solicitud_estado === 'pending_approval') return 'en_aprobacion';
  if (s.solicitud_estado === 'rejected') return 'rechazada';
  return 'sin_cuenta';
}

/**
 * `[PGP.129]` D13 — **los anticipos que el Calendario ofrece en un día**: por programar, con algo que
 * programar, pedidos para ESE día. En HOY también los pedidos para un día que ya pasó y nadie programó
 * (`atrasado`): si no, se perderían en el pasado, donde el Calendario ya no deja agregar.
 */
export function anticiposDelDia<T extends Pick<AnticipoSolicitadoRow, 'etapa' | 'fecha_deseada' | 'disponible'>>(
  rows: readonly T[], dia: string, hoy: string,
): (T & { atrasado: boolean })[] {
  return rows
    .filter((r) => r.etapa === 'por_programar' && Number(r.disponible) > 0.005 && !!r.fecha_deseada
      && (r.fecha_deseada === dia || (dia === hoy && r.fecha_deseada < hoy)))
    .map((r) => ({ ...r, atrasado: r.fecha_deseada! < dia }))
    .sort((a, b) => String(a.fecha_deseada).localeCompare(String(b.fecha_deseada)));
}

/**
 * `[PGP.128]` D12 — **por qué no se puede transferir el pago de un anticipo** (null = se puede). Sólo a una
 * cuenta APROBADA del catálogo, y si el pedido trae la CLABE de su cotización, a ésa. Quien llama decide
 * que el método sea transferencia o cargo automático y le pasa las CLABE de los anticipos del pago.
 */
export function faltaCuentaParaTransferirAnticipo(p: {
  clabesDeAnticipos: readonly (string | null)[];
  cuentaElegida: { clabe: string | null } | null;
}): string | null {
  if (!p.clabesDeAnticipos.length) return null;
  const clabes = [...new Set(p.clabesDeAnticipos.filter((c): c is string => !!c))];
  if (clabes.length > 1) return 'Este pago junta anticipos con CLABE distintas: sácalos a pagos separados.';
  const fin = clabes[0] ? ` (la de su cotización, CLABE terminación ${clabes[0].slice(-4)})` : '';
  if (!p.cuentaElegida) {
    return `Este pago es un anticipo: se transfiere sólo a una cuenta aprobada por Dirección${fin}. Elígela del catálogo; si no aparece, su alta todavía espera aprobación en Cuentas de pago.`;
  }
  if (clabes[0] && p.cuentaElegida.clabe !== clabes[0]) {
    return `La cuenta elegida no es la de la cotización del anticipo${fin}. Elige ésa.`;
  }
  return null;
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * `[PGP.119]` **Por qué todavía no se puede pedir** (null = se puede). La MISMA regla en la pantalla
 * (botón apagado con la razón) y en el servidor (que vuelve a leer la OC de la base, no le cree al cliente).
 */
export function faltaSolicitudAnticipo(s: {
  supplier_code: string | null | undefined; sucursal: string | null | undefined; monto: unknown; motivo: string | null | undefined;
  fecha?: string | null; oc?: { total: number; anticipado: number; folio?: string } | null;
  /** `[PGP.127]` D11 — las OC de Kepler elegidas, con su total y lo ya pedido (obligatorias). */
  ocs: readonly (Pick<AnticipoOcKeplerRow, 'sucursal' | 'folio' | 'total' | 'pedidos'>)[];
  /** `[PGP.127]` D10 — ya hay cotización subida. */
  cotizacion: boolean;
  /** `[PGP.127]` D12. */
  cuenta: CuentaDelAnticipo | null | undefined;
}): string | null {
  // El orden de los avisos es el del diálogo: proveedor → OC → importe → cotización → cuenta → día → motivo.
  if (!s.supplier_code) return 'Elige el proveedor.';
  if (tipoDeAcreedor(s.supplier_code) !== 'mercancia') return 'Sólo se da anticipo a proveedores de mercancía (código C…): gasto y tarjeta no llevan anticipo.';
  if (!s.ocs?.length) return 'Elige la orden de compra de Kepler a la que va el anticipo.';
  const sucs = new Set(s.ocs.map((o) => String(o.sucursal ?? '').trim()));
  if (sucs.size > 1) return 'Las órdenes elegidas son de sucursales distintas: un anticipo se aplica sólo en una sucursal. Elige las de una.';
  if (!/^\d{2}$/.test(String(s.sucursal ?? '').trim()) || !sucs.has(String(s.sucursal).trim())) return 'La sucursal del anticipo es la de su orden de compra.';
  const monto = Number(s.monto);
  if (!Number.isFinite(monto) || !(r2(monto) > 0)) return 'Captura el importe del anticipo.';
  const tope = topeDeOcs(s.ocs);
  if (r2(monto) > tope.queda + 0.005) {
    const que = s.ocs.length === 1 ? `La OC ${s.ocs[0].folio} es` : `Las ${s.ocs.length} OC suman`;
    return `${que} $${tope.total.toFixed(2)} y ya tiene${s.ocs.length === 1 ? '' : 'n'} $${tope.anticipado.toFixed(2)} en anticipos: quedan $${Math.max(0, tope.queda).toFixed(2)}.`;
  }
  if (s.oc) {
    const queda = r2(Number(s.oc.total) * TOPE_ANTICIPO_SOBRE_OC - Number(s.oc.anticipado));
    if (r2(monto) > queda + 0.005) {
      return `La OC${s.oc.folio ? ' ' + s.oc.folio : ''} es de $${Number(s.oc.total).toFixed(2)} y ya tiene $${Number(s.oc.anticipado).toFixed(2)} en anticipos: quedan $${Math.max(0, queda).toFixed(2)}.`;
    }
  }
  if (!s.cotizacion) return 'Adjunta la cotización del proveedor (PDF o foto).';
  const cta = faltaCuentaAnticipo(s.cuenta);
  if (cta) return cta;
  if (s.fecha) {
    const d = new Date(`${s.fecha}T12:00:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.fecha) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s.fecha) return 'La fecha de pago no se entiende.';
  }
  if ((s.motivo ?? '').trim().length < 3) return 'Di para qué es el anticipo (motivo).';
  return null;
}

/**
 * `[PGP.119]` **Liga cada solicitud con su `X-D-60`**, uno a uno: mismo acreedor y sucursal, importe ±$1
 * y fecha cercana al alta (los candidatos ya vienen filtrados así por la consulta). Se recorre de la
 * solicitud más vieja a la más nueva y cada una toma el candidato libre de fecha más cercana.
 * ⭐ Control negativo medido el 2026-11-13: de 143 `X-D-60` de 12 meses, sólo 4 tienen otro del mismo
 * acreedor + sucursal ±$1 en ±30 días; por eso el pareo es casi siempre único, y cuando no, se dice.
 */
export function parearSolicitudes<T extends { obligation_id: string; proveedor: string; sucursal: string | null; creado: string; candidatos: CandidatoAnticipoKepler[]; estado_obligacion?: string }>(
  sols: readonly T[],
): Map<string, { kepler: CandidatoAnticipoKepler | null; posibles: number }> {
  const usados = new Set<string>();
  const out = new Map<string, { kepler: CandidatoAnticipoKepler | null; posibles: number }>();
  const dia = (s: string) => new Date(`${s.slice(0, 10)}T12:00:00`).getTime();
  for (const s of [...sols].sort((a, b) => a.creado.localeCompare(b.creado) || a.obligation_id.localeCompare(b.obligation_id))) {
    // `[PGP.126]` Un pedido cancelado no se pagó (cancelar se niega con pago reservado o hecho): no
    // toma candidato. Si lo tomara, por ser más viejo le quitaría su `X-D-60` al pedido vivo de al lado.
    if (s.estado_obligacion === 'cancelled') { out.set(s.obligation_id, { kepler: null, posibles: 0 }); continue; }
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

/**
 * `[PGP.126]` La marca con que el cancelar de obligaciones (`POST supplier-obligations/:id/cancelar`)
 * agrega la razón a las notas. En un anticipo las notas son su motivo: la pantalla los separa.
 */
export const MARCA_CANCELADO = '[cancelado] ';

/** `[PGP.126]` Separa el motivo del pedido y la razón de su cancelación (la última, si hubiera varias). */
export function partirMotivo(notas: string | null | undefined): { motivo: string | null; cancelacion: string | null } {
  const t = String(notas ?? '');
  const i = t.lastIndexOf(MARCA_CANCELADO);
  if (i < 0) return { motivo: t.trim() || null, cancelacion: null };
  return { motivo: t.slice(0, i).trim() || null, cancelacion: t.slice(i + MARCA_CANCELADO.length).trim() || null };
}

/**
 * `[PGP.126]` Por qué un pedido de anticipo todavía no se puede cancelar (null = se puede). Sólo se
 * cancela lo que no tiene pago: con pago reservado en el Calendario el servidor lo niega igual.
 */
export function faltaCancelarAnticipo(s: { etapa: EtapaSolicitudAnticipo }, razon: string | null | undefined): string | null {
  if (s.etapa === 'cancelado') return 'Ya está cancelado.';
  if (s.etapa === 'programado') return 'Está en un pago del Calendario: quítalo primero de ese pago.';
  if (s.etapa !== 'por_programar') return 'Ya se pagó: no se cancela; se pide el reembolso o se aplica contra una factura.';
  if ((razon ?? '').trim().length < 3) return 'Di por qué se cancela (queda en su historia).';
  return null;
}

/**
 * `[PGP.143]` La etapa de un anticipo pedido, en palabras: la misma en Anticipos, OC abiertas y el embudo.
 * `[PGP.144]` Con las palabras de Francisco (2026-11-17): «solicitado» hasta que tiene día y «cubierto» cuando el
 * programa de pagos lo pagó (antes «Por programar» y «Pagado»).
 */
export const ETAPA_ANTICIPO_TEXTO: Readonly<Record<EtapaSolicitudAnticipo, string>> = {
  por_programar: 'Solicitado', programado: 'Programado', pagado: 'Cubierto', en_kepler: 'En Kepler', aplicado: 'Aplicado', cancelado: 'Cancelado',
};

/**
 * `[PGP.144]` Un `X-D-60` de mercancía que Kepler tiene SIN solicitud en la Suite: el anticipo se pagó fuera del
 * embudo (la forma de antes: OC → cotización → firma → alguien lo agrega a mano).
 */
export interface AnticipoKeplerSinSolicitudRow {
  sucursal: string;
  proveedor: string;
  /** Del catálogo; `null` si el código no está (se muestra el código). */
  proveedor_nombre: string | null;
  folio: string;
  fecha: string;
  importe: number;
  /** Lo que Kepler guarda sin aplicar (`kdxe.c20`). */
  remanente: number;
  referencia: string | null;
}

/** `[PGP.144]` Los cinco pasos del embudo, en orden. Cancelado sale del embudo (se cuenta aparte). */
export type PasoEmbudoAnticipo = 'por_programar' | 'programado' | 'pagado' | 'en_kepler' | 'aplicado';
export const PASOS_EMBUDO_ANTICIPO: readonly PasoEmbudoAnticipo[] = ['por_programar', 'programado', 'pagado', 'en_kepler', 'aplicado'];

/** `YYYY-MM-DD` → días del primero al segundo (sin horas: el calendario de México ya viene en la fecha). */
function diasEntre(desde: string, hasta: string): number {
  const a = Date.UTC(+desde.slice(0, 4), +desde.slice(5, 7) - 1, +desde.slice(8, 10));
  const b = Date.UTC(+hasta.slice(0, 4), +hasta.slice(5, 7) - 1, +hasta.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/**
 * `[PGP.144]` **Cuántos días lleva en su etapa** (para decir dónde se atora el embudo). Cada etapa cuenta desde
 * el hecho que la abrió:
 * - Solicitado: desde que se pidió (nadie le ha dado día).
 * - Programado: desde su día de pago, sólo si YA pasó (antes de su día no está atorado: `0`).
 * - Cubierto: desde que el programa lo pagó (espera su `X-D-60` en Kepler).
 * - En Kepler: desde la fecha del `X-D-60` (espera aplicarse a una factura).
 * `null` = la etapa no tiene esa fecha (no se inventa un cero), o está aplicado/cancelado.
 */
export function diasEnEtapa(
  r: { etapa: EtapaSolicitudAnticipo; creado: string; programado_dia: string | null; cubierto_el?: string | null; kepler: { fecha: string } | null },
  hoy: string,
): number | null {
  switch (r.etapa) {
    case 'por_programar': return r.creado ? Math.max(0, diasEntre(r.creado, hoy)) : null;
    case 'programado': return r.programado_dia ? Math.max(0, diasEntre(r.programado_dia, hoy)) : null;
    case 'pagado': return r.cubierto_el ? Math.max(0, diasEntre(r.cubierto_el, hoy)) : null;
    case 'en_kepler': return r.kepler?.fecha ? Math.max(0, diasEntre(r.kepler.fecha, hoy)) : null;
    default: return null;
  }
}

/** `[PGP.144]` Un paso del embudo. */
export interface PasoEmbudo {
  paso: PasoEmbudoAnticipo;
  /** Los que LLEGARON a este paso (o más allá). */
  llegaron: { n: number; monto: number };
  /** Los que están AQUÍ ahora (ni más atrás ni más adelante): donde se atora. */
  aqui: { n: number; monto: number; masViejo: number | null };
  /** De los solicitados, qué parte llegó aquí (por número). `null` sin solicitudes (no hay 0 %). */
  pct: number | null;
}

/**
 * `[PGP.144]` **El embudo de los anticipos que pide Compras**: Solicitado → Programado → Cubierto → En Kepler →
 * Aplicado. Cada paso dice cuántos llegaron y cuántos se quedaron ahí (con el más viejo). Los cancelados salen
 * del embudo y se cuentan aparte. Una sola regla para la pantalla y sus pruebas.
 */
export function embudoAnticipos<T extends Parameters<typeof diasEnEtapa>[0] & { monto: number }>(
  rows: readonly T[], hoy: string,
): { pasos: PasoEmbudo[]; cancelados: { n: number; monto: number } } {
  const vivos = rows.filter((r) => r.etapa !== 'cancelado');
  const suma = (xs: readonly T[]) => Math.round(xs.reduce((s, r) => s + Number(r.monto), 0) * 100) / 100;
  const nivel = (e: EtapaSolicitudAnticipo) => PASOS_EMBUDO_ANTICIPO.indexOf(e as PasoEmbudoAnticipo);
  const total = vivos.length;
  const pasos = PASOS_EMBUDO_ANTICIPO.map((paso, i) => {
    const llegaron = vivos.filter((r) => nivel(r.etapa) >= i);
    const aqui = vivos.filter((r) => nivel(r.etapa) === i);
    const dias = aqui.map((r) => diasEnEtapa(r, hoy)).filter((d): d is number => d !== null);
    return {
      paso,
      llegaron: { n: llegaron.length, monto: suma(llegaron) },
      aqui: { n: aqui.length, monto: suma(aqui), masViejo: dias.length ? Math.max(...dias) : null },
      pct: total ? Math.round((llegaron.length / total) * 1000) / 10 : null,
    };
  });
  const canc = rows.filter((r) => r.etapa === 'cancelado');
  return { pasos, cancelados: { n: canc.length, monto: suma(canc) } };
}

/**
 * `[PGP.143]` **Los anticipos pedidos sobre UNA orden de compra de Kepler** (sucursal + folio), para que la OC
 * de Compras los muestre. Salen del seguimiento (`listAnticiposSolicitados`), que ya trae la etapa: no se
 * recalcula. Los cancelados no cuentan.
 *
 * ⚠️ Un anticipo pedido sobre DOS OC aparece en las dos con su importe entero (no se reparte: Kepler tampoco lo
 * reparte). Por eso cada fila dice con qué otras OC va (`otras`), y el total de una OC puede no sumarse con el
 * de otra sin contarlo dos veces.
 */
export function anticiposDeOc<T extends { etapa: EtapaSolicitudAnticipo; monto: number; ocs?: readonly RefOcKepler[] | null }>(
  rows: readonly T[], sucursal: string, folio: string,
): { filas: Array<{ anticipo: T; otras: string[] }>; total: number } {
  const suc = String(sucursal ?? '').trim(), fol = String(folio ?? '').trim();
  const filas = rows
    .filter((r) => r.etapa !== 'cancelado' && (r.ocs ?? []).some((o) => o.sucursal === suc && String(o.folio).trim() === fol))
    .map((anticipo) => ({ anticipo, otras: (anticipo.ocs ?? []).filter((o) => !(o.sucursal === suc && String(o.folio).trim() === fol)).map((o) => o.folio) }));
  return { filas, total: Math.round(filas.reduce((s, f) => s + Number(f.anticipo.monto), 0) * 100) / 100 };
}
