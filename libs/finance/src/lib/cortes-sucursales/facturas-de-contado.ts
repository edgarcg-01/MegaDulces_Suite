import type {
  CorteRow, CorteVentaTurno, CortesAlcance, FacturaContado, FacturaCorte, FacturaEstadoCorte, FacturaNotaCredito, FacturaSinCorte,
  FacturaTicket, FacturasContadoResponse, FacturasContadoTipo,
} from '@megadulces/contracts';
import type { VentaDelTurno } from './llegada-del-corte';
import { dias, mismoTurno, resumenVentaTurno } from './llegada-del-corte';

/**
 * `[CSU.28]` **La venta del turno: tickets, devoluciones y las facturas de contado con sus notas de crédito.**
 * Anexo FB (`FASE_CSU_ANEXO_FACTURA_AL_BANCO_2026-11-26.md`). La misma consulta sirve a la pestaña «Facturas de
 * contado» (CSU.30): trae las facturas del periodo Y las de los tickets del periodo.
 *
 * Una factura de contado (`U-D-12` «Factura Cont No Fiscal», `U-D-5` «Factura TK Contado») NO es dinero aparte: es un
 * ticket facturado (`kdm1.c37 = 10`, `c38` = caja, `c39` = folio del ticket). El dinero lo trae el corte de su turno,
 * y el ticket se liga al corte con `mismoTurno` — la MISMA regla de la venta del turno (CSU.27), para que la factura
 * y la venta no puedan contradecirse.
 *
 * Medido en prod el 2026-11-26 (1–25 nov, 8 sucursales): 1,576 `U-D-5` y 2,082 `U-D-12` no canceladas, **todas** con
 * su ticket en `kdm1`. La factura sale el mismo día o el siguiente en el 95 %, pero hasta **83 días** después: por
 * eso se busca por la fecha del TICKET, no por la de la factura.
 *
 * Las notas de crédito (`U-A-21` fiscal, `U-A-25` no fiscal) se ligan a la FACTURA (`c36='D'`, `c37` = tipo,
 * `c39` = folio). El corte ya las resta como devolución del turno (CSU.7): aquí se ven, no se vuelven a restar.
 * ⛔ La forma de pago del ticket NO se decodifica: `c97` («pagó|cambio») se muestra tal cual. Si un ticket
 * pagado con tarjeta trae «0|0» está NO MEDIDO.
 */

/** El corte de caja POS (`U-D-23`) empezó el 1-oct-2026: un ticket anterior no tiene corte (CSU.0). */
export const INICIO_CORTE_POS = '2026-10-01';

/**
 * Parámetros (`parametrosFacturas`): desde, sucursales ×3, desde, sucursales, y el periodo dos veces (por fecha de
 * factura y por fecha de ticket ±1 día).
 *  · `f`  las facturas `U-D-5`/`U-D-12` no canceladas que salen de un ticket, desde 5 días antes del periodo (una
 *         factura puede llevar fecha hasta 4 días ANTES que su ticket: medido) — por `ix_kdm1_venta_fecha`.
 *  · `t`  cada factura CON su ticket, por la forma de `ix_kdm1_venta_doc`.
 *  · `n`  sus notas de crédito, por la forma de `ix_kdm1_abono_doc`.
 * ⛔ Lo de `n` y `tn` se casa por LLAVE en un mapa jsonb, no por JOIN (la lección de CSU.22): el planner estima 1 fila
 * por CTE y casaba facturas contra tickets con un Nested Loop — medido en prod el 2026-11-26, 22,302,733 filas
 * descartadas por Join Filter y 3.7 s para 4,723 facturas.
 */
export const SQL_FACTURAS_CONTADO = `
WITH f AS MATERIALIZED (
  SELECT f.sucursal, (f.c4)::integer AS tipo, (f.c5)::integer AS sub, btrim(f.c6) AS folio, f.c9::date AS fecha_d,
         nullif(btrim(f.c32), '') AS cliente, round(f.c16::numeric, 2) AS total, nullif(btrim(f.c43), '') AS estado,
         CASE WHEN btrim(f.c38::text) ~ '^[0-9]+$' THEN btrim(f.c38::text)::integer END AS ticket_caja,
         btrim(f.c39) AS ticket_folio
    FROM kepler_ods.kdm1 f
   WHERE f.c2 = 'U' AND f.c3 = 'D' AND f.c4 IN (5, 12)
     AND f.c9::date >= (?::date - 5)
     AND btrim(f.c1) = f.sucursal AND coalesce(f.c43, '') <> 'C' AND btrim(f.c37::text) = '10'
     AND f.sucursal = ANY(?::text[])
),
t AS MATERIALIZED (
  SELECT f.*, k.c9::date AS ticket_fecha_d, btrim(k.c80::text) AS ticket_turno,
         round(k.c16::numeric, 2) AS ticket_total, nullif(btrim(k.c97), '') AS ticket_pago
    FROM f
    LEFT JOIN LATERAL (
      SELECT k.c9, k.c80, k.c16, k.c97 FROM kepler_ods.kdm1 k
       WHERE k.c2 = 'U' AND k.c3 = 'D' AND btrim(k.sucursal) = f.sucursal AND (k.c4)::integer = 10
         AND (k.c5)::integer = f.ticket_caja AND btrim(k.c6) = f.ticket_folio AND btrim(k.c1) = f.sucursal
       ORDER BY coalesce(k.c43, '') = 'C'
       LIMIT 1
    ) k ON true
),
n AS MATERIALIZED (
  SELECT n.sucursal, (n.c37)::integer AS tipo, btrim(n.c39) AS folio,
         jsonb_agg(jsonb_build_object(
           'doc_prefix', 'UA' || lpad(btrim(n.c4::text), 2, '0') || lpad(btrim(n.c5::text), 2, '0'), 'folio', btrim(n.c6),
           'fecha', to_char(n.c9::date, 'YYYY-MM-DD'), 'monto', round(n.c16::numeric, 2), 'motivo', nullif(btrim(n.c24), ''))
           ORDER BY btrim(n.c6)) AS notas
    FROM kepler_ods.kdm1 n
   WHERE n.c2 = 'U' AND n.c3 = 'A'
     AND btrim(n.sucursal) = ANY(?::text[]) AND btrim(n.c1) = ANY(?::text[]) AND (n.c4)::integer IN (21, 25)
     AND btrim(n.c1) = n.sucursal AND coalesce(n.c43, '') <> 'C'
     AND btrim(n.c36) = 'D' AND btrim(n.c37::text) IN ('5', '12')
     AND n.c9::date >= (?::date - 5)
   GROUP BY 1, 2, 3
),
tn AS MATERIALIZED (
  -- El nombre del tipo, UNA vez. Medido en prod (2026-11-26): buscarlo por factura (LATERAL) recorría el catálogo
  -- entero (1,548 filas, sin índice) 4,000 veces, y la consulta tardaba 5.7 s.
  SELECT DISTINCT ON (mm.sucursal, btrim(mm.c3::text), btrim(mm.c4::text))
         mm.sucursal, btrim(mm.c3::text) AS tipo, btrim(mm.c4::text) AS sub, btrim(mm.c5) AS nombre
    FROM kepler_ods.kdmm mm
   WHERE btrim(mm.c1) = 'U' AND btrim(mm.c2) = 'D' AND btrim(mm.c3::text) IN ('5', '12') AND mm.sucursal = ANY(?::text[])
   ORDER BY 1, 2, 3
),
nmap AS MATERIALIZED (SELECT jsonb_object_agg(sucursal || '|' || tipo || '|' || folio, notas) AS m FROM n),
tnmap AS MATERIALIZED (SELECT jsonb_object_agg(sucursal || '|' || tipo || '|' || sub, nombre) AS m FROM tn)
SELECT t.sucursal, t.tipo, t.sub, tnmap.m ->> (t.sucursal || '|' || t.tipo || '|' || t.sub) AS tipo_nombre,
       t.folio, to_char(t.fecha_d, 'YYYY-MM-DD') AS fecha,
       t.cliente, t.total, t.estado, t.ticket_caja::text AS ticket_caja, t.ticket_folio,
       to_char(t.ticket_fecha_d, 'YYYY-MM-DD') AS ticket_fecha, t.ticket_turno, t.ticket_total, t.ticket_pago,
       coalesce(nmap.m -> (t.sucursal || '|' || t.tipo || '|' || t.folio), '[]'::jsonb) AS notas
  FROM t CROSS JOIN nmap CROSS JOIN tnmap
 WHERE t.fecha_d BETWEEN ?::date AND ?::date
    OR t.ticket_fecha_d BETWEEN (?::date - 1) AND (?::date + 1)`;

export function parametrosFacturas(desde: string, hasta: string, sucursales: string[]): Array<string | string[]> {
  return [desde, sucursales, sucursales, sucursales, desde, sucursales, desde, hasta, desde, hasta];
}

/** `[CSU.30]` Los tipos públicos viven en el contrato (una sola definición). */
export type NotaDeCredito = FacturaNotaCredito;
export type TicketDeOrigen = FacturaTicket;
/** La factura sin su corte (el corte lo pone `armarFacturas`). */
export type FacturaDeContado = Omit<FacturaContado, 'corte' | 'sin_corte'>;

/** Una fila de `SQL_FACTURAS_CONTADO` (los `numeric` llegan como texto). */
export interface FacturaCruda {
  sucursal: string;
  tipo: number;
  sub: number;
  tipo_nombre: string | null;
  folio: string;
  fecha: string;
  cliente: string | null;
  total: number | string;
  estado: string | null;
  ticket_caja: string | null;
  ticket_folio: string | null;
  ticket_fecha: string | null;
  ticket_turno: string | null;
  ticket_total: number | string | null;
  ticket_pago: string | null;
  notas: Array<{ doc_prefix: string; folio: string; fecha: string; monto: number | string; motivo: string | null }>;
}

const r2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

/** `'18900|35.73'` → `{ pago: 18900, cambio: 35.73 }`; vacío o ilegible → `null` (no se inventa un cero). */
export function pagoDelTicket(c97: string | null | undefined): { pago: number; cambio: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*\|\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(c97 ?? ''));
  return m ? { pago: r2(Number(m[1])), cambio: r2(Number(m[2])) } : null;
}

export function facturaDeContado(x: FacturaCruda): FacturaDeContado {
  const notas: NotaDeCredito[] = (x.notas || []).map((n) => ({
    doc_prefix: n.doc_prefix, folio: n.folio, fecha: n.fecha, monto: r2(Number(n.monto)), motivo: n.motivo ?? null,
  }));
  const total = r2(Number(x.total));
  const notas_total = r2(notas.reduce((t, n) => t + n.monto, 0));
  const ticket: TicketDeOrigen | null = x.ticket_caja && x.ticket_folio && x.ticket_fecha
    ? {
      caja: x.ticket_caja, folio: x.ticket_folio, fecha: x.ticket_fecha, turno: x.ticket_turno ?? null,
      total: r2(Number(x.ticket_total)), pago: pagoDelTicket(x.ticket_pago),
    }
    : null;
  return {
    sucursal: x.sucursal, tipo: Number(x.tipo), tipo_nombre: x.tipo_nombre ?? null, folio: x.folio, fecha: x.fecha,
    cliente: x.cliente ?? null, total, notas, notas_total, neto: r2(total - notas_total), ticket,
  };
}

interface CorteDelTurno { sucursal: string; caja: string | null; turno: string | null; fecha: string }

const delTicket = (f: FacturaDeContado) =>
  f.ticket ? { sucursal: f.sucursal, caja: f.ticket.caja, turno: f.ticket.turno, fecha: f.ticket.fecha } : null;

/** Las facturas de contado del turno de un corte, la más reciente primero. */
export function facturasDelTurno(corte: CorteDelTurno, facturas: ReadonlyArray<FacturaDeContado>): FacturaDeContado[] {
  return facturas
    .filter((f) => { const t = delTicket(f); return !!t && mismoTurno(corte, t); })
    .sort((a, b) => b.fecha.localeCompare(a.fecha) || b.folio.localeCompare(a.folio));
}

export type CorteDeFactura<C> =
  | { corte: C; por_que: null }
  | { corte: null; por_que: FacturaSinCorte };

/**
 * `[CSU.28]` El corte de una factura (la pestaña de CSU.30 lo usa para decir a dónde llegó). Sin corte se dice POR QUÉ:
 * no se encontró su ticket · su ticket es de antes del 1-oct-2026 (no existía el corte POS) · `[CSU.30]` su ticket es
 * de fuera de los días en que se buscaron cortes (`rango`) · no hay corte de ese turno · dos cortes casan.
 */
export function corteDeFactura<C extends CorteDelTurno>(
  f: FacturaDeContado, cortes: ReadonlyArray<C>, rango?: { desde: string; hasta: string },
): CorteDeFactura<C> {
  const t = delTicket(f);
  if (!t) return { corte: null, por_que: 'sin_ticket' };
  // Primero se busca: en septiembre SÍ hubo 5 cortes POS (Padre Hidalgo, CSU.0).
  const mios = cortes.filter((c) => mismoTurno(c, t));
  if (mios.length === 1) return { corte: mios[0], por_que: null };
  if (mios.length > 1) return { corte: null, por_que: 'ambiguo' };
  if (t.fecha < INICIO_CORTE_POS) return { corte: null, por_que: 'antes_del_corte_pos' };
  // Un ticket de fuera de los días buscados puede tener corte en su periodo: no se afirma que no lo tiene.
  // [CSU.31] revisión: la ORILLA también. Un ticket del primer o último día buscado puede ser de un corte del día de
  // junto (`mismoTurno` acepta ±1 día), que no se buscó: tampoco se afirma que no lo tiene.
  if (rango && (t.fecha <= rango.desde || t.fecha >= rango.hasta)) return { corte: null, por_que: 'otro_periodo' };
  return { corte: null, por_que: 'sin_corte' };
}

const ESTADOS: readonly FacturaEstadoCorte[] = [
  'llego', 'por_saber', 'parcial', 'sin_conciliar', 'sin_deposito',
  'sin_ticket', 'antes_del_corte_pos', 'otro_periodo', 'sin_corte', 'ambiguo', 'no_medido',
];

const aFacturaCorte = (c: CorteRow): FacturaCorte => ({
  clave: c.clave, sucursal: c.sucursal, documento: c.documento, folio: c.folio, fecha: c.fecha, referencia: c.referencia,
  caja: c.caja, turno: c.turno, monto: c.monto, cuadre: c.cuadre, diferencia: c.diferencia, cobros: c.cobros,
  llegada: c.llegada, venta_turno: c.venta_turno, venta_sin_forma_de_pago: c.venta_sin_forma_de_pago,
});

/**
 * `[CSU.30]` Arma la respuesta de `GET /finance/cortes-sucursales/facturas` (pura).
 *  · `facturas`  todas las que trajo `SQL_FACTURAS_CONTADO`, ya normalizadas.
 *  · `cortes`    los cortes del periodo ±1 día, con su llegada (la MISMA respuesta de la pestaña Cortes).
 *  · Sin `corte`: las facturas del periodo por su fecha (y de `sucursal`, si se pidió). Con `corte`: las de su turno,
 *    sin importar la fecha de la factura (una factura sale hasta 83 días después del ticket).
 */
export function armarFacturas(
  facturas: ReadonlyArray<FacturaDeContado>,
  cortes: ReadonlyArray<CorteRow>,
  o: {
    periodo: { from: string; to: string }; alcance: CortesAlcance; sucursal: string | null; corte: string | null;
    rango: { desde: string; hasta: string }; llegada_medida: boolean;
  },
): FacturasContadoResponse {
  const pedido = o.corte ? cortes.find((c) => c.clave === o.corte) ?? null : null;
  const elegidas = o.corte
    ? (pedido ? facturasDelTurno(pedido, facturas) : [])
    : facturas.filter((f) => f.fecha >= o.periodo.from && f.fecha <= o.periodo.to && (!o.sucursal || f.sucursal === o.sucursal));
  const usados: Record<string, FacturaCorte> = {};
  const porTipo = new Map<number, FacturasContadoTipo>();
  const salida: FacturaContado[] = [];
  for (const f of [...elegidas].sort((a, b) => b.fecha.localeCompare(a.fecha) || b.folio.localeCompare(a.folio))) {
    const r = pedido ? { corte: pedido, por_que: null } : corteDeFactura(f, cortes, o.rango);
    if (r.corte) usados[r.corte.clave] = aFacturaCorte(r.corte);
    salida.push({ ...f, corte: r.corte ? r.corte.clave : null, sin_corte: r.por_que });
    let t = porTipo.get(f.tipo);
    if (!t) {
      t = { tipo: f.tipo, tipo_nombre: f.tipo_nombre, facturas: 0, monto: 0, notas: 0, notas_monto: 0, neto: 0,
        por_corte: Object.fromEntries(ESTADOS.map((e) => [e, { facturas: 0, monto: 0 }])) as FacturasContadoTipo['por_corte'] };
      porTipo.set(f.tipo, t);
    }
    t.facturas += 1; t.monto = r2(t.monto + f.total); t.notas += f.notas.length; t.notas_monto = r2(t.notas_monto + f.notas_total);
    t.neto = r2(t.neto + f.neto);
    const estado: FacturaEstadoCorte = r.corte ? (r.corte.llegada?.estado ?? 'no_medido') : r.por_que;
    t.por_corte[estado].facturas += 1;
    t.por_corte[estado].monto = r2(t.por_corte[estado].monto + f.total);
  }
  return {
    periodo: o.periodo, alcance: o.alcance, sucursal: o.sucursal, corte: o.corte,
    tipos: [...porTipo.values()].sort((a, b) => b.monto - a.monto),
    facturas: salida, cortes: usados, cortes_desde: o.rango.desde, cortes_hasta: o.rango.hasta, llegada_medida: o.llegada_medida,
  };
}

/** El resumen de la lista (`CorteVentaTurno`, CSU.27) más las facturas del turno. */
export interface VentaDelTurnoDetalle extends CorteVentaTurno {
  facturas: FacturaDeContado[];
}

/** El paso «La venta del turno» del detalle del corte: el MISMO resumen de la lista, con sus facturas. */
export function ventaDelTurnoDetalle(
  corte: CorteDelTurno & { monto: number; devoluciones_total: number },
  venta: VentaDelTurno | null,
  facturas: ReadonlyArray<FacturaDeContado>,
): VentaDelTurnoDetalle | null {
  const r = resumenVentaTurno(corte, venta);
  return r ? { ...r, facturas: facturasDelTurno(corte, facturas) } : null;
}

/** Días entre el ticket y su factura (para decir «facturado N días después»). */
export const diasHastaFacturar = (f: FacturaDeContado): number | null => (f.ticket ? dias(f.fecha, f.ticket.fecha) : null);
