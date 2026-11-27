import type { Knex } from 'knex';
import type { EntradaConMonto, MismaFacturaDuplicado } from '@megadulces/contracts';

/**
 * `[RE.86]` La factura COMPARTIDA: una liga de `fiscal.cfdi_assignments` con `shared_reason` (el motivo) liga una
 * entrada a una factura que ya citan otras entradas del mismo proveedor. Una sola definición para el servicio que
 * la crea, el expediente que la compara en grupo y la lista que deja de pedirle papel.
 */

/** El mínimo del motivo: el mismo que el CHECK de la migración `20261123165526`. */
export const MOTIVO_LIGA_MIN = 10;

/** ¿Ya está la columna `shared_reason`? El código puede llegar a prod antes que la migración. */
export async function hayLigaCompartida(trx: Knex | Knex.Transaction): Promise<boolean> {
  const r = await trx.raw(`SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('fiscal.cfdi_assignments')
    AND attname = 'shared_reason' AND NOT attisdropped) AS ok`);
  return !!(r.rows[0] as { ok: boolean }).ok;
}

/**
 * Condición SQL «la entrada `c` tiene una factura compartida ligada»: cuenta como papel (su documento ES la
 * factura original). Sin la migración, `false` — la lista se comporta como antes.
 */
export const tieneLigaCompartidaSql = (hay: boolean, alias = 'c'): string => (hay
  ? `EXISTS (SELECT 1 FROM fiscal.cfdi_assignments fa WHERE fa.tenant_id = ${alias}.tenant_id AND fa.sucursal = ${alias}.sucursal
       AND fa.doc_folio = ${alias}.folio AND fa.status = 'confirmed' AND fa.shared_reason IS NOT NULL)`
  : 'false');

/**
 * `[RE.88]` La referencia de Kepler NORMALIZADA si de verdad nombra una factura; `null` si es genérica. Medido en prod
 * (2026-11-25, entradas sin papel cuya «hermana» con la misma referencia sí lo tiene): 106 de 120 compartían `LPA`,
 * `40-S/N`, `40 S/N` o `S/N` — eso no es una factura, es un relleno. Una referencia cita factura si, quitando
 * `S/N`/`SN`, le quedan al menos 3 dígitos (`0-F-1979`, `1115`).
 */
export function referenciaCitable(ref: string | null | undefined): string | null {
  const r = String(ref ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!r) return null;
  const sinSn = r.replace(/S\s*\/\s*N|\bSN\b/g, '');
  return (sinSn.match(/\d/g) ?? []).length >= 3 ? r : null;
}

/** Lo que el servicio lee de la base para armar `MismaFacturaDuplicado`. */
export interface DatosMismaFactura {
  entrada: { proveedor_code: string | null; proveedor_rfc: string | null; referencia: string | null; monto: number };
  hermana: { sucursal: string; folio: string; proveedor_code: string | null; referencia: string | null; monto: number };
  otras: EntradaConMonto[];
  cfdi: { uuid: string; total: number; emisor_rfc: string | null } | null;
  /** Total leído del papel que ya estaba (respaldo si el CFDI no está en ContPAQi). */
  papelTotal: number | null;
  /** La entrada destino ya tiene una factura ligada (confirmada o automática). */
  entradaYaLigada: boolean;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * `[RE.88]` ¿El PDF repetido es la MISMA factura que cita la entrada destino? Sólo si las dos son del mismo proveedor
 * de Kepler y citan la misma referencia citable. Si no, `null`: el duplicado sigue siendo un duplicado.
 * No decide ligar: arma lo que la persona necesita para decidir (la suma contra la factura) y por qué aún no se puede.
 */
export function armarMismaFacturaDuplicado(d: DatosMismaFactura): MismaFacturaDuplicado | null {
  const ref = referenciaCitable(d.entrada.referencia);
  if (!ref || ref !== referenciaCitable(d.hermana.referencia)) return null;
  const prov = (d.entrada.proveedor_code ?? '').trim();
  if (!prov || prov !== (d.hermana.proveedor_code ?? '').trim()) return null;
  const suma = r2(d.entrada.monto + d.hermana.monto + d.otras.reduce((s, o) => s + o.monto, 0));
  const total = d.cfdi ? d.cfdi.total : d.papelTotal;
  const rfcEntrada = (d.entrada.proveedor_rfc ?? '').trim().toUpperCase();
  const rfcCfdi = (d.cfdi?.emisor_rfc ?? '').trim().toUpperCase();
  const noSePuede = !d.cfdi ? 'La factura todavía no está en ContPAQi como recibida vigente: se podrá ligar cuando llegue.'
    : d.entradaYaLigada ? 'Esta entrada ya tiene una factura ligada.'
    : !rfcEntrada ? 'El proveedor no tiene RFC en Kepler: hay que capturarlo en su ficha antes de ligar.'
    : rfcEntrada !== rfcCfdi ? `El RFC del proveedor en Kepler (${rfcEntrada}) no es el de la factura (${rfcCfdi}): hay que corregirlo en la ficha del proveedor en Kepler.`
    : null;
  return {
    referencia: ref,
    hermana: { sucursal: d.hermana.sucursal, folio: d.hermana.folio, monto: r2(d.hermana.monto) },
    otras_ligadas: d.otras.map((o) => ({ ...o, monto: r2(o.monto) })),
    monto_entrada: r2(d.entrada.monto),
    suma_entradas: suma,
    cfdi_uuid: d.cfdi?.uuid ?? null,
    factura_total: total == null ? null : r2(total),
    factura_fuente: d.cfdi ? 'sat' : total == null ? null : 'papel',
    diferencia: total == null ? null : r2(suma - total),
    no_se_puede: noSePuede,
  };
}
