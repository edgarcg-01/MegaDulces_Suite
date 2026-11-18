/**
 * `[PGP.147]` **La factura ya debe menos de lo que el pago le lleva.** El caso que lo pidió (Edgar, 2026-11-18):
 * Mondelez, factura 20-1-0010007 de la 00, programada el 26-oct para pagarse el 13-nov por $469,071.93. El 12-nov
 * Kepler le aplicó dos notas de crédito (55-0001512 por $120,000 y 55-0001513 por $2,142.69) y su saldo bajó a
 * $346,929.24. El pago siguió en $469,071.93 y así salió del banco el 13-nov: **$122,142.69 de más**.
 *
 * El importe de un pago se fija al armarlo y nada lo volvía a comparar con lo que la factura debe. Aquí se compara,
 * al leer, cada factura de un pago PENDIENTE contra su saldo de hoy en Kepler (`v_supplier_payables.pendiente`, que
 * ya llega en la misma consulta de su etiqueta), y se dice qué documentos de Kepler lo bajaron.
 *
 * Medido en prod el 2026-11-18 (sólo lectura): además de Mondelez, 3 pagos pendientes llevaban $78,047 de más por
 * notas que Kepler ya había aplicado (CD015 en diciembre, CE012 del 17-nov); y 4 ya pagados del Calendario llevaban
 * $161,744 sobre lo que se debía (lo que de verdad salió de esos 4 no está MEDIDO: pudo pagarlos Tesorería por el neto).
 *
 * ⛔ La factura saldada por completo no entra aquí: ésa ya la dice `[PGP.35]` (`kepler_saldada`).
 * Sólo lee: no cambia el importe del pago (eso es `[PGP.148]`, con su decisión).
 */
import type { AbonoQueBajoElSaldo, DebeMenosDelPago } from '@megadulces/contracts';

/** Pesos de tolerancia: redondeos de Kepler. */
export const TOLERANCIA_DEBE_MENOS = 1;

/** Lo que la regla lee de una factura del pago. */
export interface FacturaParaDebeMenos {
  id: string;
  applied_amount: number;
  /** Saldo de hoy en Kepler; null = no es factura de Kepler o no se midió. */
  kepler_debe: number | null;
  kepler_saldada: boolean;
  /** `oblig:sucursal|tipo|sub|folio`, la llave natural de la factura (`[PGP.58]`). */
  entity_ref: string | null;
  /** El acreedor en Kepler (`[PGP.120]`). */
  payee_code: string | null;
}

/** La factura en Kepler, para buscar quién le bajó el saldo. */
export interface CargoKepler {
  llave: string;
  sucursal: string;
  acreedor: string;
  tipo: number;
  sub: number;
  folio: string;
}

/** `oblig:00|20|1|0010007` + acreedor → la llave del cargo en `kdxf`. Null si no se puede leer. */
export function cargoDeLaFactura(f: Pick<FacturaParaDebeMenos, 'entity_ref' | 'payee_code'>): CargoKepler | null {
  const m = /^oblig:([^|]+)\|(\d+)\|(\d+)\|(.+)$/.exec(f.entity_ref ?? '');
  const acreedor = (f.payee_code ?? '').trim();
  if (!m || !acreedor) return null;
  const folio = m[4].trim();
  return { llave: `${m[1]}|${Number(m[2])}|${Number(m[3])}|${folio}`, sucursal: m[1], acreedor, tipo: Number(m[2]), sub: Number(m[3]), folio };
}

/** Las facturas de un pago que hoy deben menos de lo que el pago les lleva (sin las ya saldadas). */
export function facturasQueDebenMenos<T extends FacturaParaDebeMenos>(items: readonly T[]): T[] {
  return items.filter((it) => !it.kepler_saldada && it.kepler_debe !== null && it.kepler_debe > 0.005
    && it.applied_amount > it.kepler_debe + TOLERANCIA_DEBE_MENOS);
}

const CLASE: Record<number, string> = {
  25: 'Cheque', 26: 'Transferencia', 60: 'Anticipo', 55: 'Nota de crédito', 56: 'Nota de crédito CFDI',
  40: 'Devolución de compra', 45: 'Bonificación', 50: 'Ajuste de abono', 30: 'Salida por devolución', 35: 'Aplica devolución',
};
export const claseDeAbono = (tipo: number): string => CLASE[tipo] ?? `Abono tipo ${tipo}`;

/**
 * Arma lo que se dice del pago: cuánto lleva de más y, por factura, qué abonos de Kepler explican el saldo.
 * `abonos` viene por llave de cargo, el más nuevo primero. Null si ninguna factura debe menos.
 */
export function debeMenosDelPago(items: readonly FacturaParaDebeMenos[], abonos: ReadonlyMap<string, AbonoQueBajoElSaldo[]>): DebeMenosDelPago | null {
  const malas = facturasQueDebenMenos(items);
  if (!malas.length) return null;
  const facturas = malas.map((it) => {
    const c = cargoDeLaFactura(it);
    const debe = it.kepler_debe as number;
    return {
      item_id: it.id,
      factura: c ? `${c.tipo}-${c.sub}-${c.folio}` : (it.entity_ref ?? '—'),
      programado: it.applied_amount,
      debe,
      de_mas: Math.round((it.applied_amount - debe) * 100) / 100,
      abonos: c ? abonos.get(c.llave) ?? [] : [],
    };
  });
  return { de_mas: Math.round(facturas.reduce((s, f) => s + f.de_mas, 0) * 100) / 100, facturas };
}

/**
 * Los abonos VIVOS que Kepler aplicó a esas facturas (pagos, notas, devoluciones, anticipos), por llave de cargo.
 * Parámetros: `[sucursales, acreedores, tipos, subs, folios]`, arreglos paralelos.
 */
export const SQL_ABONOS_DE_LAS_FACTURAS = `
SELECT k.suc || '|' || k.tipo || '|' || k.sub || '|' || k.folio AS llave,
       x.c4::int AS tipo, btrim(x.c6) AS folio, to_char(min(x.c3), 'YYYY-MM-DD') AS fecha, sum(x.c10)::float8 AS monto
  FROM unnest(?::text[], ?::text[], ?::int[], ?::int[], ?::text[]) AS k(suc, acr, tipo, sub, folio)
  JOIN kepler_ods.kdxf x ON x.sucursal = k.suc AND btrim(x.c1) = x.sucursal AND btrim(x.c2) = k.acr
                        AND x.c7 = k.tipo AND x.c8 = k.sub AND btrim(x.c9) = k.folio
  LEFT JOIN kepler_ods.kdm1 m ON m.sucursal = x.sucursal AND m.c1 = x.c1 AND m.c2 = 'X' AND m.c3 = 'D'
                             AND m.c4 = x.c4 AND m.c5 = x.c5 AND m.c6 = x.c6
 WHERE coalesce(m.c43, '') <> 'C'
 GROUP BY 1, 2, 3
 ORDER BY 1, 4 DESC`;
