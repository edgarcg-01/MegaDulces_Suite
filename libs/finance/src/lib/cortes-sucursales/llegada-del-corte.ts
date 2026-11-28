import type {
  CobroLlegada, CorteCuadre, CorteLlegada, CorteLlegadaEstado, CorteVentaTurno, CortesSucursalesResponse,
} from '@megadulces/contracts';
import type { LlegadaDeposito, LlegadaEstado } from './llegada-al-banco';

/**
 * `[CSU.27]` **El corte dice si su dinero llegó, y la venta sin forma de pago deja de ser «Corte distinto».**
 * Anexo FB (`FASE_CSU_ANEXO_FACTURA_AL_BANCO_2026-11-26.md`). Lógica pura; la evidencia la traen `SQL_VENTA_TURNO`
 * (abajo) y `SQL_LLEGADA` (CSU.26).
 *
 * ── VENTA SIN FORMA DE PAGO ─────────────────────────────────────────────────────────────────────────────────────
 * Medido en prod el 2026-11-26 (1–25 nov, 707 cortes de 8 sucursales): **el corte es igual, al centavo, a los
 * tickets del turno menos sus devoluciones en 698 de 707** (98.7 %). Ése es el testigo. De los 34 cortes que hoy
 * salen «Corte distinto» con el corte ARRIBA de lo esperado, 33 cumplen esa igualdad: el turno vendió más de lo que
 * la caja registró cobrado (ej. Morelia Abastos `0000161`, ticket 3-5114 de $66,086.21 sin forma de pago). El que no
 * la cumple (Zamora Centro `0000154`, $188.33) sigue «Corte distinto»: sin testigo no se le pone causa (ADR-056).
 * Sólo se renombra `corte_distinto`; `sobrante_arqueo` ya tiene explicación (el corte es lo que contó el cajero).
 *
 * ── ¿LLEGÓ EL DINERO DEL CORTE? ─────────────────────────────────────────────────────────────────────────────────
 * Suma lo que cada depósito APLICÓ a este corte (un depósito puede repartirse en varios cortes) según su clase de
 * CSU.26, y decide con esta prioridad —la primera que se cumple—:
 *  1. `sin_deposito`   Kepler no le ha aplicado ningún depósito. Lleva su EDAD en días: no es un veredicto
 *                      (Kepler aplica el depósito días después; la alerta la decide D5).
 *  2. `sin_conciliar`  parte de lo aplicado no tiene testigo aunque podría tenerlo (sin pareo, caja sin asiento,
 *                      sin cuenta).
 *  3. `parcial`        lo aplicado tiene testigo, pero falta depositar parte del corte.
 *  4. `por_saber`      parte de lo aplicado está en una cuenta cuyo libro de Bancos no llega a esa fecha.
 *  5. `llego`          todo el corte está en el banco o en Caja General (lo «puente» no cuenta como faltante).
 */

/** Tolerancia de centavos, la misma del cuadre (`TOLERANCIA_CUADRE`). */
const TOL = 1;
const r2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

/**
 * La venta del turno, por (sucursal, caja, turno, día de los tickets). Parámetros: desde, hasta, sucursales.
 * El día va de uno antes a uno después del periodo: el turno cruza la medianoche. ⛔ El folio de turno se REPITE
 * entre fechas (CSU.0): se casa con el corte por ±1 día y se declara ambiguo si dos cortes de la misma caja-turno
 * están a ±3 días (medido en nov: 0 casos).
 * Por la forma de `ix_kdm1_venta_fecha` (`c9::date`, parcial `c2='U' AND c3='D'`). Medido: la red, un mes, 379 ms.
 */
export const SQL_VENTA_TURNO = `
SELECT k.sucursal, btrim(k.c5::text) AS caja, btrim(k.c80::text) AS turno, to_char(k.c9::date, 'YYYY-MM-DD') AS dia,
       count(*)::int AS tickets, round(sum(k.c16::numeric), 2) AS total
  FROM kepler_ods.kdm1 k
 WHERE k.c2 = 'U' AND k.c3 = 'D' AND k.c4 = 10
   AND k.c9::date >= (?::date - 1) AND k.c9::date < (?::date + 2)
   AND btrim(k.c1) = k.sucursal AND coalesce(k.c43, '') <> 'C'
   AND k.sucursal = ANY(?::text[])
 GROUP BY 1, 2, 3, 4`;

export interface VentaTurnoCruda { sucursal: string; caja: string; turno: string; dia: string; tickets: number; total: number | string }

export interface VentaDelTurno {
  tickets: number;
  /** Suma de los tickets del turno (bruto, antes de devoluciones). */
  total: number;
}

export const dias = (a: string, b: string): number => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
const sinCeros = (s: string | null | undefined): string => String(s ?? '').trim().replace(/^0+(?=\d)/, '');

/** Días entre un ticket y el corte de su turno. Medido en nov: con ±1 el corte = venta del turno en 698 de 707. */
export const DIAS_TURNO = 1;

/**
 * `[CSU.27]` ¿Este ticket (o grupo de tickets) es del turno de este corte? La regla ÚNICA, la usan la venta del turno
 * y las facturas (CSU.28): misma sucursal, misma caja, mismo folio de turno (sin ceros a la izquierda) y a ±1 día.
 */
export function mismoTurno(
  corte: { sucursal: string; caja: string | null; turno: string | null; fecha: string },
  ticket: { sucursal: string; caja: string | null; turno: string | null; fecha: string },
): boolean {
  if (!corte.caja || !corte.turno || !ticket.caja || !ticket.turno) return false;
  return corte.sucursal === ticket.sucursal && sinCeros(corte.caja) === sinCeros(ticket.caja)
    && sinCeros(corte.turno) === sinCeros(ticket.turno) && Math.abs(dias(ticket.fecha, corte.fecha)) <= DIAS_TURNO;
}

/**
 * La venta del turno de UN corte. `null` si no hay tickets, o si es ambiguo (`otrosCortesMismoTurno` > 0: otro corte
 * de la misma caja y folio de turno a ±3 días, y los tickets no se pueden repartir).
 */
export function ventaDelTurno(
  corte: { sucursal: string; caja: string | null; turno: string | null; fecha: string },
  grupos: ReadonlyArray<VentaTurnoCruda>,
  otrosCortesMismoTurno = 0,
): VentaDelTurno | null {
  if (!corte.caja || !corte.turno || otrosCortesMismoTurno > 0) return null;
  const mios = grupos.filter((g) => mismoTurno(corte, { sucursal: g.sucursal, caja: g.caja, turno: g.turno, fecha: g.dia }));
  if (!mios.length) return null;
  return { tickets: mios.reduce((t, g) => t + Number(g.tickets), 0), total: r2(mios.reduce((t, g) => t + Number(g.total), 0)) };
}

/**
 * `[CSU.27]` La venta sin forma de pago de un corte, o `null`. Sólo cuando las TRES cosas son ciertas: el corte salió
 * «Corte distinto», está ARRIBA de lo esperado, y es igual a la venta del turno menos sus devoluciones.
 */
export function ventaSinFormaDePago(
  corte: { monto: number; cuadre: CorteCuadre; diferencia: number | null; devoluciones_total: number },
  venta: VentaDelTurno | null,
): number | null {
  if (corte.cuadre !== 'corte_distinto' || corte.diferencia === null || corte.diferencia < TOL || !venta) return null;
  const neto = r2(venta.total - corte.devoluciones_total);
  return Math.abs(neto - corte.monto) < TOL ? r2(corte.diferencia) : null;
}

/** `[CSU.29]` Los tipos públicos viven en el contrato (una sola definición). */
export type LlegadaCorteEstado = CorteLlegadaEstado;
export type LlegadaDelCorte = CorteLlegada;

const SIN_TESTIGO: ReadonlySet<LlegadaEstado> = new Set(['sin_conciliar', 'caja_sin_asiento', 'sin_cuenta']);

/**
 * `[CSU.27]` ¿Llegó el dinero del corte? `aplicaciones` = lo que cada depósito aplicó a ESTE corte, con la clase del
 * depósito (CSU.26). `hoy` en `AAAA-MM-DD`, hora de México.
 */
export function llegadaDelCorte(
  corte: { monto: number; fecha: string },
  aplicaciones: ReadonlyArray<{ monto: number; llegada: Pick<LlegadaDeposito, 'estado'> }>,
  hoy: string,
): LlegadaDelCorte {
  const s = { llego: 0, por_saber: 0, sin_conciliar: 0, puente: 0 };
  for (const a of aplicaciones) {
    const e = a.llegada.estado;
    if (e === 'en_banco' || e === 'en_caja_general') s.llego += a.monto;
    else if (e === 'banco_sin_libro') s.por_saber += a.monto;
    else if (e === 'puente') s.puente += a.monto;
    else if (SIN_TESTIGO.has(e)) s.sin_conciliar += a.monto;
  }
  const aplicado = aplicaciones.reduce((t, a) => t + a.monto, 0);
  const sin_deposito = r2(Math.max(0, corte.monto - aplicado));
  const r = {
    llego: r2(s.llego), por_saber: r2(s.por_saber), sin_conciliar: r2(s.sin_conciliar), puente: r2(s.puente), sin_deposito,
    edad_dias: sin_deposito >= TOL ? Math.max(0, dias(hoy, corte.fecha)) : null,
  };
  const estado: LlegadaCorteEstado =
    aplicado < TOL ? 'sin_deposito'
      : r.sin_conciliar >= TOL ? 'sin_conciliar'
        : sin_deposito >= TOL ? 'parcial'
          : r.por_saber >= TOL ? 'por_saber'
            : 'llego';
  return { estado, ...r };
}

/** `[CSU.27]` El resumen de la venta del turno que va en la lista (sin las facturas: ésas, en su consulta, CSU.30). */
export function resumenVentaTurno(corte: { monto: number; devoluciones_total: number }, venta: VentaDelTurno | null): CorteVentaTurno | null {
  if (!venta) return null;
  const neto = r2(venta.total - corte.devoluciones_total);
  return { tickets: venta.tickets, total: venta.total, devoluciones: r2(corte.devoluciones_total), neto, igual_al_corte: Math.abs(neto - corte.monto) < TOL };
}

const llaveTurno = (c: { sucursal: string; caja: string | null; turno: string | null }): string =>
  `${c.sucursal}|${sinCeros(c.caja)}|${sinCeros(c.turno)}`;

/**
 * `[CSU.29]` Cuelga de la respuesta de Cortes / Sucursales lo del anexo FB: la llegada de cada depósito y de cada
 * corte, la venta del turno y la venta sin forma de pago, y sus resúmenes del periodo.
 *  · `llegadas`  la clase de cada depósito por `sucursal|doc_prefix|folio` (CSU.26); `null` = la consulta no se pudo
 *                hacer → todo lo de llegada queda `null` y `resp.llegada = null` (no se pinta como «no llegó»).
 *  · `ventas`    la venta por turno (`SQL_VENTA_TURNO`); `null` = no se midió → venta del turno y venta sin forma
 *                de pago quedan `null`.
 * Muta `resp` (como `completarCobros` en el servicio). `hoy` en `AAAA-MM-DD`, hora de México.
 */
export function anexarLlegadaYVenta(
  resp: CortesSucursalesResponse,
  llegadas: ReadonlyMap<string, CobroLlegada> | null,
  ventas: ReadonlyArray<VentaTurnoCruda> | null,
  hoy: string,
): void {
  // Cuántos cortes comparten caja y folio de turno a ±3 días: con más de uno, los tickets no se pueden repartir.
  const porTurno = new Map<string, Array<{ fecha: string }>>();
  for (const c of resp.cortes) {
    const k = llaveTurno(c);
    (porTurno.get(k) ?? porTurno.set(k, []).get(k)!).push(c);
  }
  const cuenta: Record<CorteLlegadaEstado, number> = { sin_deposito: 0, sin_conciliar: 0, parcial: 0, por_saber: 0, llego: 0 };
  const suma = { aplicado: 0, llego: 0, por_saber: 0, sin_conciliar: 0, puente: 0, sin_deposito: 0 };
  let vsfpCortes = 0, vsfpMonto = 0;
  for (const c of resp.cortes) {
    if (llegadas) {
      for (const b of c.cobros) b.llegada = llegadas.get(`${c.sucursal}|${b.doc_prefix}|${b.folio}`) ?? null;
      // Un depósito sin clase (no vino en la consulta) cuenta como «sin cuenta», nunca como llegado.
      c.llegada = llegadaDelCorte(c, c.cobros.map((b) => ({ monto: b.monto, llegada: b.llegada ?? { estado: 'sin_cuenta' as const } })), hoy);
      cuenta[c.llegada.estado] += 1;
      suma.aplicado += c.cobros.reduce((t, b) => t + b.monto, 0);
      suma.llego += c.llegada.llego; suma.por_saber += c.llegada.por_saber; suma.sin_conciliar += c.llegada.sin_conciliar;
      suma.puente += c.llegada.puente; suma.sin_deposito += c.llegada.sin_deposito;
    }
    if (ventas) {
      const otros = (porTurno.get(llaveTurno(c)) ?? []).filter((o) => o !== c && Math.abs(dias(o.fecha, c.fecha)) <= 3).length;
      const venta = ventaDelTurno(c, ventas, otros);
      c.venta_turno = resumenVentaTurno(c, venta);
      c.venta_sin_forma_de_pago = ventaSinFormaDePago(c, venta);
      if (c.venta_sin_forma_de_pago !== null) { vsfpCortes += 1; vsfpMonto += c.venta_sin_forma_de_pago; }
    }
  }
  resp.llegada = llegadas
    ? {
      aplicado: r2(suma.aplicado), llego: r2(suma.llego), por_saber: r2(suma.por_saber), sin_conciliar: r2(suma.sin_conciliar),
      puente: r2(suma.puente), sin_deposito: r2(suma.sin_deposito), cortes: cuenta,
    }
    : null;
  resp.venta_sin_forma_de_pago = ventas ? { cortes: vsfpCortes, monto: r2(vsfpMonto) } : null;
}
