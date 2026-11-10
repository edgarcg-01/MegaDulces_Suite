/**
 * `[PQ.94]` Compras › Temporadas — las consultas, como funciones que reciben la transacción.
 *
 * Por qué así: la prueba contra base real (`database/tests/test-newdb-pq94-temporadas-api.js`) carga ESTE
 * archivo con ts-node y ejerce el mismo SQL que la API, con el payload de la pantalla (CLAUDE.md regla 13).
 * Una copia del SQL en la prueba se pondría verde midiendo una consulta que ya nadie corre.
 *
 * ⛔ Una sola puerta de escritura (plan §19.8): `guardarDecisiones` y `confirmarFechas` son las únicas que
 *    escriben la temporada. Lo propuesto no frena nada (ADR-056): sólo `confirmada` llega al estado de hoy.
 * ⚠️ Las fechas salen de SQL como TEXTO (`to_char`): un `date` de node-pg llega como medianoche LOCAL y
 *    `toISOString()` daría el día anterior en un proceso con zona UTC+.
 */
import type { Knex } from 'knex';
import {
  TEMPORADAS_LOTE_MAX, validarDecisionTemporada, validarFechasTemporada,
  type CandidatoTemporada, type CandidatosTemporada, type ConfirmarFechasTemporadaDto, type ConfirmarFechasTemporadaRespuesta,
  type DecisionesTemporadaDto, type DecisionesTemporadaRespuesta, type DecisionFueraDePropuesta, type FechasTemporada,
  type MomentoTemporada, type TemporadaResumen, type TemporadasVista,
} from '@megadulces/contracts';

export interface Quien {
  readonly userId: string;
  readonly username: string | null;
}

/** Error de regla de negocio: el servicio lo vuelve 400/404 con este mensaje. */
export class TemporadasError extends Error {
  constructor(readonly tipo: 'no_encontrada' | 'invalida', mensaje: string) {
    super(mensaje);
  }
}

const HOY_MX = `(now() AT TIME ZONE 'America/Mexico_City')::date`;
const dia = (col: string, alias: string): string => `to_char(${col}, 'YYYY-MM-DD') AS ${alias}`;
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const num = (v: unknown): number => Number(v ?? 0) || 0;

/** Dónde está una temporada-año respecto de hoy. `YYYY-MM-DD` se compara como texto. */
export function momentoDe(hoy: string, saleFrom: string, saleTo: string): MomentoTemporada {
  if (hoy < saleFrom) return 'por_iniciar';
  if (hoy <= saleTo) return 'en_venta';
  return 'terminada';
}

/**
 * El orden que contesta «¿qué sigue?» (criterio PQ.UI.T8): la que está en venta, después las por iniciar
 * (la más cercana primero) y al final las terminadas (la más reciente primero). Una temporada sin fechas va al final.
 */
export function ordenarTemporadas(ts: TemporadaResumen[]): TemporadaResumen[] {
  const clave = (t: TemporadaResumen): [number, string] => {
    const enVenta = t.fechas.find((f) => f.momento === 'en_venta');
    if (enVenta) return [0, enVenta.sale_from];
    const proximas = t.fechas.filter((f) => f.momento === 'por_iniciar').sort((a, b) => a.sale_from.localeCompare(b.sale_from));
    if (proximas.length) return [1, proximas[0].sale_from];
    const ult = [...t.fechas].sort((a, b) => b.sale_to.localeCompare(a.sale_to))[0];
    // Terminadas: la más reciente primero → se invierte la fecha para que el orden ascendente la ponga arriba.
    return ult ? [2, String(99999999 - Number(ult.sale_to.replace(/-/g, '')))] : [3, t.name];
  };
  return [...ts].sort((a, b) => {
    const [ga, ka] = clave(a);
    const [gb, kb] = clave(b);
    return ga - gb || ka.localeCompare(kb) || a.name.localeCompare(b.name);
  });
}

/**
 * ¿Una decisión vigente aplica a ESTE año? Descartar es por temporada (vale todos los años); confirmar «anual»
 * también; confirmar «sólo un año» vale únicamente en ese año. Sin esto, lo confirmado «sólo 2025» se pintaba
 * como «Confirmado» en 2026 aunque el estado de hoy no lo publica (revisión independiente, hallazgo 2).
 */
export function decisionAplica(d: { decision: string; recurrence: string | null; only_year: number | null }, year: number): boolean {
  return d.decision === 'descartada' || d.recurrence === 'anual' || Number(d.only_year) === year;
}

export async function hoyMx(trx: Knex | Knex.Transaction): Promise<string> {
  const { rows } = await trx.raw(`SELECT to_char(${HOY_MX}, 'YYYY-MM-DD') AS d`);
  return rows[0].d;
}

/** El calendario: temporadas, sus fechas por año y cuántos productos confirmados/descartados lleva cada una. */
export async function leerTemporadas(trx: Knex | Knex.Transaction, tenant: string): Promise<TemporadasVista> {
  const hoy = await hoyMx(trx);
  const { rows: ts } = await trx.raw(
    `SELECT s.id, s.key, s.name, s.date_rule,
            count(sp.id) FILTER (WHERE sp.decision = 'confirmada')::int AS confirmados,
            count(sp.id) FILTER (WHERE sp.decision = 'descartada')::int AS descartados
       FROM catalog.seasons s
       LEFT JOIN catalog.season_products sp ON sp.tenant_id = s.tenant_id AND sp.season_id = s.id AND sp.deleted_at IS NULL
      WHERE s.tenant_id = ? AND s.deleted_at IS NULL AND s.active
      GROUP BY s.id ORDER BY s.sort_order, s.name`,
    [tenant],
  );
  const { rows: fs } = await trx.raw(
    `SELECT d.id, d.season_id, d.year, ${dia('d.sale_from', 'sale_from')}, ${dia('d.sale_to', 'sale_to')},
            ${dia('d.buy_by', 'buy_by')}, ${dia('d.cutoff', 'cutoff')}, ${dia('d.clearance_from', 'clearance_from')},
            d.status, d.proposal_source, d.confirmed_at, u.nombre AS confirmed_by_name
       FROM catalog.season_dates d
       LEFT JOIN identity.users u ON u.id = d.confirmed_by
      WHERE d.tenant_id = ? AND d.deleted_at IS NULL
      ORDER BY d.year DESC`,
    [tenant],
  );
  const porTemporada = new Map<string, FechasTemporada[]>();
  for (const f of fs) {
    const lista = porTemporada.get(f.season_id) ?? [];
    lista.push({
      id: f.id, year: Number(f.year), sale_from: f.sale_from, sale_to: f.sale_to,
      buy_by: f.buy_by ?? null, cutoff: f.cutoff ?? null, clearance_from: f.clearance_from ?? null,
      status: f.status, proposal_source: f.proposal_source ?? null,
      confirmed_by_name: f.confirmed_by_name ?? null, confirmed_at: iso(f.confirmed_at),
      momento: momentoDe(hoy, f.sale_from, f.sale_to),
    });
    porTemporada.set(f.season_id, lista);
  }
  const temporadas: TemporadaResumen[] = ts.map((t: { id: string; key: string; name: string; date_rule: 'fija' | 'movil'; confirmados: number; descartados: number }) => ({
    id: t.id, key: t.key, name: t.name, date_rule: t.date_rule,
    fechas: porTemporada.get(t.id) ?? [],
    productos: { confirmados: Number(t.confirmados), descartados: Number(t.descartados) },
  }));
  return { hoy, temporadas: ordenarTemporadas(temporadas) };
}

/** La cabecera de una temporada-año, SIEMPRE fresca (es barata): sus fechas son parte de la llave de la caché. */
export type CabeceraCandidatos = Omit<CandidatosTemporada, 'candidatos' | 'fuera_de_propuesta' | 'resumen' | 'calculado_at' | 'base'>;

export async function leerCabecera(trx: Knex | Knex.Transaction, tenant: string, seasonDateId: string): Promise<CabeceraCandidatos | null> {
  const { rows } = await trx.raw(
    `SELECT d.id, d.season_id, s.name AS temporada, d.year, ${dia('d.sale_from', 'sale_from')}, ${dia('d.sale_to', 'sale_to')}, d.status,
            to_char(w.m_ini, 'YYYY-MM') AS desde, to_char(w.m_fin, 'YYYY-MM') AS hasta,
            (w.m_fin + interval '2 months')::date <= ${HOY_MX} AS cerrada
       FROM catalog.season_dates d
       JOIN catalog.seasons s ON s.tenant_id = d.tenant_id AND s.id = d.season_id AND s.deleted_at IS NULL
       CROSS JOIN LATERAL catalog.fn_season_window_months(d.sale_from, d.sale_to) w
      WHERE d.tenant_id = ? AND d.id = ? AND d.deleted_at IS NULL`,
    [tenant, seasonDateId],
  );
  if (!rows.length) return null;
  const c = rows[0];
  return {
    season_date_id: c.id, season_id: c.season_id, temporada: c.temporada, year: Number(c.year),
    sale_from: c.sale_from, sale_to: c.sale_to, fechas_status: c.status,
    meses: { desde: c.desde, hasta: c.hasta }, ventana_cerrada: Boolean(c.cerrada),
  };
}

/** Lo caro (la vista sobre el sell-out, ~0.4-1.6 s): lo que propone la venta, SIN decisiones, para guardarlo en caché. */
export interface FilasCalculadas {
  readonly filas: ReadonlyArray<Omit<CandidatoTemporada, 'decision' | 'decidido_at'>>;
  readonly base: { readonly meses: number; readonly completa: boolean };
}

export async function calcularFilas(trx: Knex | Knex.Transaction, tenant: string, seasonDateId: string): Promise<FilasCalculadas> {
  const { rows } = await trx.raw(
    `SELECT sku, nombre, sales_window, sales_12m, concentration, sales_next_month, collapsed_after, name_match, base_months
       FROM catalog.v_season_candidates
      WHERE tenant_id = ? AND season_date_id = ?
      ORDER BY sales_window DESC, sku`,
    [tenant, seasonDateId],
  );
  const meses = rows.length ? Number(rows[0].base_months) : 0;
  return {
    filas: rows.map((r: Record<string, unknown>) => ({
      sku: String(r.sku), nombre: String(r.nombre ?? ''),
      venta_temporada: num(r.sales_window), venta_12m: num(r.sales_12m), concentracion: num(r.concentration),
      venta_mes_siguiente: num(r.sales_next_month),
      cayo_despues: r.collapsed_after == null ? null : Boolean(r.collapsed_after),
      por_nombre: Boolean(r.name_match),
    })),
    // Sin candidatos no hay con qué medir la base: se declara incompleta (no se afirma lo que no se midió).
    base: { meses, completa: meses >= 12 },
  };
}

/** Lo barato y siempre fresco: las decisiones vigentes que APLICAN a ese año, unidas a lo calculado. */
export async function unirDecisiones(
  trx: Knex | Knex.Transaction, tenant: string, cab: CabeceraCandidatos, calc: FilasCalculadas, calculadoAt: string,
): Promise<CandidatosTemporada> {
  const { rows: dec } = await trx.raw(
    `SELECT sp.sku, sp.decision, sp.origin, sp.recurrence, sp.only_year, sp.decided_at, p.nombre
       FROM catalog.season_products sp
       LEFT JOIN catalog.products p ON p.tenant_id = sp.tenant_id AND p.sku = sp.sku AND p.deleted_at IS NULL
      WHERE sp.tenant_id = ? AND sp.season_id = ? AND sp.deleted_at IS NULL`,
    [tenant, cab.season_id],
  );
  type Fila = { sku: string; decision: 'confirmada' | 'descartada'; origin: 'propuesta_del_sistema' | 'manual'; recurrence: string | null; only_year: number | null; decided_at: unknown; nombre: string | null };
  const porSku = new Map<string, Fila>((dec as Fila[]).filter((d) => decisionAplica(d, cab.year)).map((d) => [d.sku, d]));
  const candidatos: CandidatoTemporada[] = calc.filas.map((f) => {
    const d = porSku.get(f.sku);
    return { ...f, decision: d?.decision ?? null, decidido_at: d ? iso(d.decided_at) : null };
  });
  const enPropuesta = new Set(calc.filas.map((f) => f.sku));
  const fuera: DecisionFueraDePropuesta[] = [...porSku.entries()]
    .filter(([sku]) => !enPropuesta.has(sku))
    .map(([sku, d]) => ({ sku, nombre: d.nombre ?? null, decision: d.decision, origin: d.origin }))
    .sort((a, b) => a.sku.localeCompare(b.sku));
  const confirmados = candidatos.filter((x) => x.decision === 'confirmada').length;
  const descartados = candidatos.filter((x) => x.decision === 'descartada').length;
  return {
    ...cab,
    base: calc.base,
    calculado_at: calculadoAt,
    candidatos,
    fuera_de_propuesta: fuera,
    resumen: { propuestos: candidatos.length, confirmados, descartados, por_decidir: candidatos.length - confirmados - descartados },
  };
}

/**
 * Guarda un lote de decisiones (confirmar/descartar) de UNA temporada. Cada renglón en su SAVEPOINT: uno que
 * falla no tumba a los demás y se reporta con su motivo (lote parcial, nunca «todo falló»).
 * Una clave que viene más de una vez en el lote no se guarda en ninguna de sus apariciones: no se adivina cuál quiso.
 */
export async function guardarDecisiones(
  trx: Knex.Transaction, tenant: string, quien: Quien, seasonId: string, dto: DecisionesTemporadaDto,
): Promise<DecisionesTemporadaRespuesta> {
  const lote = Array.isArray(dto?.decisiones) ? dto.decisiones : [];
  if (!lote.length) throw new TemporadasError('invalida', 'No llegó ninguna decisión.');
  if (lote.length > TEMPORADAS_LOTE_MAX) throw new TemporadasError('invalida', `Un lote lleva hasta ${TEMPORADAS_LOTE_MAX} productos.`);
  if (!quien.userId) throw new TemporadasError('invalida', 'No sabemos quién decide: vuelve a entrar.');
  const t = await trx('catalog.seasons').where({ id: seasonId, tenant_id: tenant }).whereNull('deleted_at').first('id');
  if (!t) throw new TemporadasError('no_encontrada', 'No encontramos esa temporada.');

  const veces = new Map<string, number>();
  for (const d of lote) veces.set(String(d?.sku ?? ''), (veces.get(String(d?.sku ?? '')) ?? 0) + 1);
  const fallidas: Array<{ sku: string; motivo: string }> = [];
  const repetidas = new Set<string>();
  const validas = lote.filter((d) => {
    const sku = String(d?.sku ?? '');
    if ((veces.get(sku) ?? 0) > 1) {
      if (!repetidas.has(sku)) fallidas.push({ sku, motivo: `Viene ${veces.get(sku)} veces en el mismo lote: mándalo una sola vez.` });
      repetidas.add(sku);
      return false;
    }
    const motivo = validarDecisionTemporada(d);
    if (motivo) fallidas.push({ sku, motivo });
    return !motivo;
  });
  // La clave tiene que existir en el catálogo (la propuesta sale de la venta; una manual puede venir mal escrita).
  const existen = new Set<string>(
    validas.length
      ? (await trx('catalog.products').where({ tenant_id: tenant }).whereIn('sku', validas.map((d) => d.sku)).whereNull('deleted_at').distinct('sku'))
        .map((r: { sku: string }) => r.sku)
      : [],
  );
  let guardadas = 0;
  for (const d of validas) {
    if (!existen.has(d.sku)) { fallidas.push({ sku: d.sku, motivo: 'Esa clave no está en el catálogo.' }); continue; }
    const confirmar = d.decision === 'confirmada';
    const fila = {
      decision: d.decision,
      recurrence: confirmar ? d.recurrence : null,
      only_year: confirmar && d.recurrence === 'solo_un_anio' ? d.only_year : null,
      replenishment: confirmar ? d.replenishment : null,
      reason: String(d.reason ?? '').trim().slice(0, 500) || null,
      origin: d.origin,
      // Lo que el cliente dice que vio. Se guarda tal cual, como su declaración; no se coteja contra la propuesta.
      evidence: d.evidence && typeof d.evidence === 'object' && !Array.isArray(d.evidence) ? JSON.stringify(d.evidence) : null,
      decided_by: quien.userId,
      decided_at: trx.fn.now(),
      updated_at: trx.fn.now(),
      updated_by: quien.userId,
      updated_by_username: quien.username,
    };
    await trx.raw('SAVEPOINT temporada_decision');
    try {
      const actual = await trx('catalog.season_products')
        .where({ tenant_id: tenant, season_id: seasonId, sku: d.sku }).whereNull('deleted_at').forUpdate().first('id');
      if (actual) await trx('catalog.season_products').where({ id: actual.id }).update(fila);
      else await trx('catalog.season_products').insert({ ...fila, tenant_id: tenant, season_id: seasonId, sku: d.sku, created_by: quien.userId, created_by_username: quien.username });
      await trx.raw('RELEASE SAVEPOINT temporada_decision');
      guardadas += 1;
    } catch (e) {
      await trx.raw('ROLLBACK TO SAVEPOINT temporada_decision');
      const code = (e as { code?: string }).code;
      fallidas.push({ sku: d.sku, motivo: code === '23514' ? 'No cumple las reglas de la temporada.' : code === '23505' ? 'Alguien la decidió al mismo tiempo: recarga.' : 'No se pudo guardar.' });
    }
  }
  return { guardadas, fallidas };
}

/** Confirma (o corrige) las fechas de una temporada-año. La venta tiene que empezar en el año de esa temporada-año. */
export async function confirmarFechas(
  trx: Knex.Transaction, tenant: string, quien: Quien, seasonDateId: string, dto: ConfirmarFechasTemporadaDto,
): Promise<ConfirmarFechasTemporadaRespuesta> {
  if (!quien.userId) throw new TemporadasError('invalida', 'No sabemos quién confirma: vuelve a entrar.');
  const actual = await trx('catalog.season_dates').where({ id: seasonDateId, tenant_id: tenant }).whereNull('deleted_at').forUpdate().first('year');
  if (!actual) throw new TemporadasError('no_encontrada', 'No encontramos esas fechas.');
  const motivo = validarFechasTemporada(dto, Number(actual.year));
  if (motivo) throw new TemporadasError('invalida', motivo);
  await trx('catalog.season_dates')
    .where({ id: seasonDateId, tenant_id: tenant })
    .update({
      sale_from: dto.sale_from, sale_to: dto.sale_to,
      buy_by: dto.buy_by ?? null, cutoff: dto.cutoff ?? null, clearance_from: dto.clearance_from ?? null,
      status: 'confirmada', confirmed_by: quien.userId, confirmed_at: trx.fn.now(),
      updated_at: trx.fn.now(), updated_by: quien.userId, updated_by_username: quien.username,
    });
  return { id: seasonDateId, status: 'confirmada' };
}
