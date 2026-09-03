import { Injectable, Logger, BadRequestException, Inject, Optional } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { RECON_NOTIFIER_PORT, ReconNotifierPort } from '@megadulces/contracts';
import { MovementReconcileService, RawDiscrepancy } from './movement-reconcile.service';

/**
 * SM.8 / P1 — Arqueo ciego. El cajero captura el conteo físico por denominación
 * ANTES de ver el esperado; recién al guardar el motor revela la diferencia REAL
 * (total ciego vs efectivo esperado de Kepler), independiente del c25 contaminado.
 *
 * SM.9 — Autolineado: al capturar un cierre divergente, el arqueo se convierte al
 * INSTANTE en un descuadre `arqueo_ciego_divergente` en la bandeja del supervisor
 * (/almacen/cuadre), sin esperar al scan nocturno, + alerta WS best-effort.
 *
 * `reconciliation.blind_counts` tiene RLS forzado → TenantKnexService.run().
 */

/** Denominaciones MXN válidas (billetes + monedas). */
const DENOMS = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5];
/** Motivos tipificados de incidencia (opcional, alineado al CHECK de la migración SM.9). */
const INCIDENCIAS = ['faltante_justificado', 'billete_falso', 'robo', 'error_cobro', 'otro'];
/** Umbrales del descuadre autolineado (espejan la regla `arqueo_ciego_divergente`). */
const ARQ_UMBRAL = 50;
const ARQ_CRITICO = 1000;
/**
 * Ventana de turnos por arquear.
 *
 * Para la **cajera es HOY y nada más** (`0`). El arqueo es un acto físico sobre el
 * cajón que tiene enfrente: un corte de anteayer ya no se puede contar —ese
 * efectivo se depositó o se fue en sangrías— así que ofrecérselo no le da trabajo,
 * le da una tarea imposible. Peor: con la regla de orden (SM.16) el corte viejo le
 * bloqueaba el de hoy, y la dejaba sin poder arquear nada.
 *
 * El corte viejo sin contar NO se pierde: vive en la bandeja del supervisor como
 * `arqueo_no_realizado` y en el tablero de cumplimiento. Es un problema de
 * supervisión, no una tarea de mostrador.
 *
 * El **supervisor** sí ve la ventana ancha (`2`): captura por otros, en relevo y
 * en contingencia, y necesita alcanzar el cierre de ayer capturado hoy temprano.
 */
const TURNOS_DIAS_CAJERA = 0;
const TURNOS_DIAS_SUPERVISOR = 2;

/** Un turno de caja abierto/cerrado por Kepler — lo que toca arquear. Sin montos. */
export interface TurnoPendiente {
  warehouse_code: string;
  warehouse_name?: string | null;
  caja: string;
  folio: string;
  business_date: string;
  hora_apertura: string | null;
  hora_cierre: string | null;
  cajero_code: string | null;
  turno: string | null;
  abierto: boolean;
  abierto_at?: string | null;
  /**
   * Minutos desde que Kepler cerró el turno. `null` mientras sigue abierto.
   * Es lo que convierte la lista en una PETICIÓN: en cuanto el ERP cierra la
   * caja, el arqueo se vuelve exigible y la pantalla lo pide sola.
   */
  cerrado_hace_min?: number | null;
  /** SM.17 — hora a la que ESA caja suele cortar (mediana histórica). */
  corte_tipico?: string | null;
  /** Minutos que faltan para esa hora. Negativo = ya se pasó. */
  corte_en_min?: number | null;
  /** Dispersión (IQR) de esa hora en minutos: si es grande, el pronóstico no sirve. */
  corte_iqr_min?: number | null;
}
const money = (n: number) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

export interface BlindCountDto {
  warehouse_code: string;
  caja: string;
  business_date: string;          // 'YYYY-MM-DD'
  turno?: string;
  cajero_code?: string;           // cierre: cajero que cierra · relevo: cajero SALIENTE
  cajero_entrante?: string;       // solo relevo: quién recibe la caja
  tipo?: 'cierre' | 'relevo';     // default 'cierre'
  denominations: Record<string, number>;  // {"1000":2,"0.5":10,…}
  nota?: string;
  photo_url?: string;
  incidencia_tipo?: string;       // SM.9: motivo cualitativo del descuadre (opcional)
  cash_cut_folio?: string;        // SM.12: folio del turno de Kepler que se está arqueando
  caja_kepler?: string;           // SM.12: la caja tal como la reporta Kepler en ese turno
  turno_abierto_at?: string | Date | null; // SM.12: cuándo abrió el turno (c5 + c6)
}

@Injectable()
export class BlindCountService {
  private readonly logger = new Logger(BlindCountService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly engine: MovementReconcileService,
    @Optional() @Inject(RECON_NOTIFIER_PORT) private readonly notifier?: ReconNotifierPort,
  ) {}

  private computeTotal(denoms: Record<string, number>): number {
    let total = 0;
    for (const [d, n] of Object.entries(denoms || {})) {
      const denom = Number(d); const count = Number(n);
      if (!DENOMS.includes(denom)) throw new BadRequestException(`Denominación inválida: ${d}`);
      if (!Number.isFinite(count) || count < 0) throw new BadRequestException(`Conteo inválido para ${d}`);
      total += denom * count;
    }
    return Math.round(total * 100) / 100;
  }

  /**
   * SM.12 — Los TURNOS de Kepler que a esta persona le toca arquear.
   *
   * Kepler ya dice cuándo y en qué caja: abre un renglón en `kdpv_folio_caja` con
   * la caja (`c2`), la cajera asignada (`c8`), la hora de apertura (`c6`) y el
   * folio (`c3`). Mientras el turno está abierto `c10` viene en `1800-01-01` y los
   * montos en cero. Eso es la señal: **no se arquea a mano, se arquea el turno que
   * el ERP abrió** — así la caja no se elige (es la que te tocó) y no se inventan
   * arqueos de turnos que no existieron.
   *
   * Se lee del ODS EN VIVO (`kepler_ods`, mismo Postgres, replicado por el CDC) y no
   * de `analytics.cash_cuts`: esa tabla guarda solo cortes CERRADOS y la leen 12
   * lugares que no filtran `cerrado` — meterle los turnos abiertos (esperado 0,
   * diff 0) ensuciaría KPIs, focos y el propio `compare()`.
   *
   * **No devuelve montos.** Es la lista de qué contar, no de cuánto debería haber.
   */
  async turnosPendientes(q: { cajeroCode?: string; warehouseCodes?: string[] | null; dias?: number; revela?: boolean }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const cajero = (q.cajeroCode || '').trim().toUpperCase();
    if (!cajero) return [];
    if (q.warehouseCodes && !q.warehouseCodes.length) return []; // alcance vacío → nada
    const porDefecto = q.revela ? TURNOS_DIAS_SUPERVISOR : TURNOS_DIAS_CAJERA;
    // `?? porDefecto` y no `|| porDefecto`: un `dias=0` explícito ("solo hoy") es
    // una respuesta válida y `||` lo tomaría como ausente.
    const pedidos = q.dias == null ? porDefecto : Number(q.dias);
    const tope = q.revela ? 30 : TURNOS_DIAS_CAJERA;   // la cajera no amplía su ventana
    const dias = Math.min(tope, Math.max(0, Number.isFinite(pedidos) ? pedidos : porDefecto));
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT k.sucursal                          AS warehouse_code,
                w.name                              AS warehouse_name,
                k.c2                                AS caja,
                k.c3::bigint::text                  AS folio,
                k.c5::date::text                    AS business_date,
                NULLIF(btrim(k.c6), '')             AS hora_apertura,
                NULLIF(btrim(k.c11), '')            AS hora_cierre,
                NULLIF(btrim(k.c8), '')             AS cajero_code,
                NULLIF(btrim(k.c13), '')            AS turno,
                (k.c10::date = DATE '1800-01-01')   AS abierto,
                CASE WHEN k.c10::date = DATE '1800-01-01' THEN NULL ELSE
                  GREATEST(0, floor(EXTRACT(EPOCH FROM (
                    (now() AT TIME ZONE 'America/Mexico_City')
                    - (k.c10::date + COALESCE(NULLIF(btrim(k.c11), ''), '00:00:00')::time)
                  )) / 60))::int
                END                                  AS cerrado_hace_min,
                -- SM.17 — a qué hora suele cortar ESTA caja (solo si sigue abierta).
                CASE WHEN k.c10::date = DATE '1800-01-01' THEN to_char(p.prox, 'HH24:MI') END AS corte_tipico,
                CASE WHEN k.c10::date = DATE '1800-01-01' AND p.prox IS NOT NULL
                     THEN round(EXTRACT(EPOCH FROM (p.prox - (now() AT TIME ZONE 'America/Mexico_City')::time)) / 60)::int
                END                                  AS corte_en_min,
                CASE WHEN k.c10::date = DATE '1800-01-01' THEN p.iqr END AS corte_iqr_min
           FROM kepler_ods.kdpv_folio_caja k
           /**
            * El horario del corte NO es global: cada caja tiene el suyo y cada
            * sucursal cierra a una hora distinta (04 ~19:57 · 05 ~18:52 · 02/03
            * ~20:35). Y una misma caja hace DOS cortes al día — mediodía y cierre —
            * así que una sola mediana cae en el hueco entre los dos y no sirve.
            * Por eso se calculan por separado y se elige el próximo que aún no pasó.
            */
           LEFT JOIN LATERAL (
             SELECT (ARRAY_REMOVE(ARRAY[med_dia, med_cierre], NULL))[1] AS prox,
                    CASE WHEN med_dia IS NOT NULL THEN iqr_dia ELSE iqr_cierre END AS iqr
               FROM (
                 SELECT
                   (percentile_cont(0.5) WITHIN GROUP (ORDER BY h.cierre)
                      FILTER (WHERE h.cierre < TIME '17:30' AND h.cierre > (now() AT TIME ZONE 'America/Mexico_City')::time)) AS med_dia,
                   (percentile_cont(0.5) WITHIN GROUP (ORDER BY h.cierre)
                      FILTER (WHERE h.cierre >= TIME '17:30' AND h.cierre > (now() AT TIME ZONE 'America/Mexico_City')::time)) AS med_cierre,
                   round(EXTRACT(EPOCH FROM (
                     (percentile_cont(0.75) WITHIN GROUP (ORDER BY h.cierre) FILTER (WHERE h.cierre < TIME '17:30'))
                   - (percentile_cont(0.25) WITHIN GROUP (ORDER BY h.cierre) FILTER (WHERE h.cierre < TIME '17:30'))
                   )) / 60)::int AS iqr_dia,
                   round(EXTRACT(EPOCH FROM (
                     (percentile_cont(0.75) WITHIN GROUP (ORDER BY h.cierre) FILTER (WHERE h.cierre >= TIME '17:30'))
                   - (percentile_cont(0.25) WITHIN GROUP (ORDER BY h.cierre) FILTER (WHERE h.cierre >= TIME '17:30'))
                   )) / 60)::int AS iqr_cierre
                 FROM (
                   SELECT (btrim(g.c11))::time AS cierre
                     FROM kepler_ods.kdpv_folio_caja g
                    WHERE g.sucursal = k.sucursal AND g.c2 = k.c2
                      AND g.c10::date <> DATE '1800-01-01'
                      AND btrim(COALESCE(g.c11, '')) ~ '^[0-9]{1,2}:'
                      AND g.c5::date < current_date        -- historia, no el turno de hoy
                    LIMIT 400
                 ) h
               ) m
           ) p ON true
           LEFT JOIN commercial.warehouses w
             ON w.tenant_id = ? AND w.code = k.sucursal AND w.deleted_at IS NULL
          WHERE upper(btrim(k.c8)) = ?
            AND k.c5::date >= (current_date - ?::int)
            AND (?::text[] IS NULL OR k.sucursal = ANY(?::text[]))
            AND NOT EXISTS (
                  SELECT 1 FROM reconciliation.blind_counts b
                   WHERE b.tenant_id = ?
                     AND b.warehouse_code = k.sucursal
                     AND b.tipo = 'cierre'
                     AND b.cash_cut_folio = k.c3::bigint::text)
          -- Del MÁS VIEJO al más nuevo: el primero de la lista es el que toca.
          -- Al revés (que es como estaba) la pantalla preseleccionaba el turno de
          -- hoy y dejaba saltarse el corte pendiente de ayer — justo el que hay
          -- que mirar, porque un turno sin arquear es donde se esconde el hueco.
          ORDER BY k.c5 ASC, k.c2
          LIMIT 50`,
        [tenantId, cajero, dias, q.warehouseCodes ?? null, q.warehouseCodes ?? null, tenantId],
      );
      return rows as TurnoPendiente[];
    });
  }

  /**
   * ¿Este turno YA tiene conteo de cierre? Sirve para distinguir un arqueo nuevo
   * de una **corrección** del que ya se hizo — que no es lo mismo y no se puede
   * tratar igual (ver `exigirElMasViejo` en el controlador).
   */
  async yaArqueado(warehouseCode: string, folio: string): Promise<boolean> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const row = await trx('reconciliation.blind_counts')
        .where({ tenant_id: tenantId, warehouse_code: warehouseCode, tipo: 'cierre', cash_cut_folio: String(folio) })
        .first('id');
      return !!row;
    });
  }

  /** Un turno concreto de Kepler, para validar que existe y es de quien dice ser. */
  async buscarTurno(warehouseCode: string, folio: string, cajero?: string): Promise<TurnoPendiente | null> {
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT k.sucursal AS warehouse_code, k.c2 AS caja, k.c3::bigint::text AS folio,
                k.c5::date::text AS business_date, NULLIF(btrim(k.c6), '') AS hora_apertura,
                NULLIF(btrim(k.c11), '') AS hora_cierre, NULLIF(btrim(k.c8), '') AS cajero_code,
                NULLIF(btrim(k.c13), '') AS turno, (k.c10::date = DATE '1800-01-01') AS abierto,
                (k.c5 + COALESCE(btrim(k.c6), '00:00:00')::time) AS abierto_at
           FROM kepler_ods.kdpv_folio_caja k
          WHERE k.sucursal = ? AND k.c3::bigint::text = ?
            AND (?::text IS NULL OR upper(btrim(k.c8)) = ?::text)
          LIMIT 1`,
        [warehouseCode, String(folio), cajero ? cajero.toUpperCase() : null, cajero ? cajero.toUpperCase() : null],
      );
      return (rows[0] as TurnoPendiente) || null;
    });
  }

  /** Captura (o re-captura) un arqueo ciego y devuelve la comparación contra el corte de Kepler. */
  async submit(dto: BlindCountDto, username?: string) {
    if (!dto?.warehouse_code || !dto?.caja || !dto?.business_date) {
      throw new BadRequestException('warehouse_code, caja y business_date son obligatorios');
    }
    const tenantId = this.tenantCtx.requireTenantId();
    const total = this.computeTotal(dto.denominations || {});
    const tipo = dto.tipo === 'relevo' ? 'relevo' : 'cierre';
    const incidencia = dto.incidencia_tipo && INCIDENCIAS.includes(dto.incidencia_tipo) ? dto.incidencia_tipo : null;
    if (dto.incidencia_tipo && !incidencia) throw new BadRequestException(`incidencia_tipo inválido (${INCIDENCIAS.join('|')})`);

    const { result, badCut } = await this.tk.run(async (trx) => {
      const row = {
        tenant_id: tenantId, tipo,
        warehouse_code: dto.warehouse_code, caja: dto.caja, business_date: dto.business_date,
        turno: dto.turno || null, cajero_code: dto.cajero_code || null, cajero_entrante: dto.cajero_entrante || null,
        denominations: JSON.stringify(dto.denominations || {}), total_contado: total,
        nota: dto.nota || null, photo_url: dto.photo_url || null, captured_by: username || null,
        incidencia_tipo: incidencia,
        // SM.12 — de qué turno de Kepler es este conteo.
        cash_cut_folio: dto.cash_cut_folio ? String(dto.cash_cut_folio) : null,
        caja_kepler: dto.caja_kepler ? String(dto.caja_kepler) : null,
        turno_abierto_at: dto.turno_abierto_at || null,
      };
      await trx('reconciliation.blind_counts')
        .insert(row)
        .onConflict(trx.raw("(tenant_id, warehouse_code, caja, business_date, COALESCE(cajero_code,''), tipo)"))
        // Re-capturar NO borra la validación por accidente: si la encargada ya firmó
        // y el conteo cambia, se limpia la firma a propósito — un arqueo distinto es
        // un arqueo sin validar.
        .merge({
          denominations: row.denominations, total_contado: total, cajero_entrante: row.cajero_entrante,
          nota: row.nota, photo_url: row.photo_url, captured_by: row.captured_by, incidencia_tipo: incidencia,
          cash_cut_folio: row.cash_cut_folio, caja_kepler: row.caja_kepler, turno_abierto_at: row.turno_abierto_at,
          validado_por: null, validado_at: null, validado_nota: null,
          captured_at: trx.fn.now(),
        });
      // El relevo no se compara contra el corte del día (es intra-turno): solo sella el traspaso.
      if (tipo === 'relevo') {
        this.logger.log(`arqueo relevo suc${dto.warehouse_code} caja${dto.caja} ${dto.business_date}: ${dto.cajero_code || '?'}→${dto.cajero_entrante || '?'} entregó ${total}`);
        return { result: { tipo, total_contado: total, matched: false, ambiguous: false, esperado: null, kepler_contado: null, kepler_diff: null, diff_real: null, kepler_enmascaro: false }, badCut: null as any };
      }
      const cmp = await this.compare(trx, tenantId, dto, total);
      this.logger.log(`arqueo cierre suc${dto.warehouse_code} caja${dto.caja} ${dto.business_date}: contado ${total} vs esperado ${cmp.esperado ?? '?'}`);
      // SM.9 — Autolineado: cierre divergente → descuadre al instante en la bandeja del supervisor.
      const badCut = await this.raiseIfDivergent(trx, tenantId, dto, total, cmp, incidencia, username);
      return { result: { tipo, total_contado: total, ...cmp }, badCut };
    });

    // WS best-effort FUERA de la transacción (no bloquea ni revierte la captura).
    if (badCut && this.notifier) {
      this.notifier.notifyBadCut(tenantId, badCut).catch((e) => this.logger.warn(`notifyBadCut falló: ${e?.message || e}`));
    }
    return result;
  }

  /**
   * SM.9 — Si el cierre matchea corte y diverge ≥ umbral, levanta (UPSERT idempotente)
   * el descuadre `arqueo_ciego_divergente` al instante y devuelve el payload de la alerta
   * cuando es crítico (Kepler enmascaró o supera el crítico). Espeja el detector homónimo.
   */
  private async raiseIfDivergent(trx: any, tenantId: string, dto: BlindCountDto, total: number, cmp: any, incidencia: string | null, username?: string) {
    if (!cmp?.matched || cmp.diff_real == null) return null;
    const diffReal = Number(cmp.diff_real);
    if (Math.abs(diffReal) < ARQ_UMBRAL) return null;
    const abs = Math.abs(diffReal);
    const esperado = Number(cmp.esperado);
    const keplerDiff = Number(cmp.kepler_diff || 0);
    const enmascaro = !!cmp.kepler_enmascaro;
    const faltante = diffReal > 0;
    const critical = enmascaro || abs >= ARQ_CRITICO;
    const fecha = dto.business_date; // ya 'YYYY-MM-DD' (sin corrimiento TZ)
    const cajero = dto.cajero_code || '?';
    const incTxt = incidencia ? ` Incidencia: ${incidencia.replace(/_/g, ' ')}.` : '';
    const d: RawDiscrepancy = {
      rule_key: 'arqueo_ciego_divergente', plano: 'caja',
      severity: critical ? 'critical' : 'warn',
      score: Math.min(1, abs / (ARQ_CRITICO * 2)),
      titulo: `Arqueo ciego: ${faltante ? 'faltan' : 'sobran'} ${money(abs)} — suc ${dto.warehouse_code} caja ${dto.caja}${enmascaro ? ' (Kepler lo dio por cuadrado)' : ''}`,
      resumen: `Corte ${fecha} (${cajero}): conteo ciego ${money(total)} vs esperado ${money(esperado)} = ${faltante ? 'faltante' : 'sobrante'} real ${money(abs)}.${enmascaro ? ` Kepler reportó diff ${money(keplerDiff)} — el arqueo ciego destapa lo que el corte ocultó.` : ''}${incTxt}`,
      entity: { sucursal: dto.warehouse_code, caja: dto.caja, cajero: dto.cajero_code || null, folio: cmp.folio || null, fecha, incidencia_tipo: incidencia },
      periodo: fecha,
      esperado, observado: total, diferencia: diffReal,
      importe: abs,
      causa_probable: enmascaro ? 'arqueo_no_ciego' : (faltante ? 'faltante_caja' : 'sobrante_caja'),
      evidencia: { params: { umbral: ARQ_UMBRAL, critico: ARQ_CRITICO }, contado_ciego: total, esperado, kepler_diff: keplerDiff, kepler_enmascaro: enmascaro, incidencia_tipo: incidencia, origen: 'arqueo_captura' },
      dedup_key: `arqueo_ciego_divergente:${dto.warehouse_code}:${dto.caja}:${fecha}:${cmp.folio || 's-folio'}`,
    };
    await this.engine.ensureRule(trx, tenantId, 'arqueo_ciego_divergente');
    await this.engine.upsertDiscrepancy(trx, tenantId, d);
    this.logger.log(`autolineado: descuadre ${d.severity} suc${dto.warehouse_code} caja${dto.caja} ${fecha} = ${money(abs)}`);
    return critical
      ? { warehouse_code: dto.warehouse_code, caja: dto.caja, business_date: fecha, cajero: dto.cajero_code || null, diff_real: diffReal, kepler_enmascaro: enmascaro, captured_by: username || null, incidencia_tipo: incidencia }
      : null;
  }

  /** Compara el total ciego vs el corte de Kepler (matchea por suc/caja/fecha[/cajero]). */
  private async compare(trx: any, tenantId: string, dto: BlindCountDto, total: number) {
    // SM.12 — Con el folio del turno el match es exacto y se acabó la ambigüedad:
    // el arqueo cuenta ESE corte, no "alguno de los de esa caja ese día" (el ~4.5%
    // de caja-días con 2+ cortes era justo lo que obligaba a devolver `ambiguous`).
    if (dto.cash_cut_folio) {
      const cut = await trx('analytics.cash_cuts')
        .where({ tenant_id: tenantId, warehouse_code: dto.warehouse_code, folio: String(dto.cash_cut_folio) })
        .first();
      if (cut) return this.armarComparacion(cut, total);
      // El turno existe en Kepler pero todavía no cerró (o el feed no lo trajo):
      // se guarda el conteo y la diferencia aparece cuando el corte llegue.
      return { matched: false, ambiguous: false, esperado: null, kepler_contado: null, kepler_diff: null, diff_real: null, kepler_enmascaro: false };
    }
    const q = trx('analytics.cash_cuts').where({ tenant_id: tenantId, warehouse_code: dto.warehouse_code, caja: dto.caja, business_date: dto.business_date });
    if (dto.cajero_code) q.where('cajero_cierre', dto.cajero_code);
    const cuts: any[] = await q.orderBy('efectivo_esperado', 'desc');
    if (!cuts.length) return { matched: false, ambiguous: false, esperado: null, kepler_contado: null, kepler_diff: null, diff_real: null, kepler_enmascaro: false };
    // Varios cortes en la caja/día y no se especificó cajero: NO elegir el mayor
    // arbitrariamente (revelaría un "faltante" de otro turno). Se pide desambiguar.
    if (!dto.cajero_code && cuts.length > 1) {
      return { matched: false, ambiguous: true, esperado: null, kepler_contado: null, kepler_diff: null, diff_real: null, kepler_enmascaro: false };
    }
    return this.armarComparacion(cuts[0], total);
  }

  /** Contado ciego vs el corte de Kepler. `+` faltante · `−` sobrante. */
  private armarComparacion(cut: any, total: number) {
    const esperado = Number(cut.efectivo_esperado);
    const keplerContado = Number(cut.efectivo_contado);
    const keplerDiff = Number(cut.efectivo_diff);
    const diffReal = Math.round((esperado - total) * 100) / 100;
    // Kepler dijo "cuadrado" (|diff|<50) pero el arqueo ciego revela ≥$50 → enmascaró.
    const keplerEnmascaro = Math.abs(keplerDiff) < 50 && Math.abs(diffReal) >= 50;
    // El desglose de Kepler viaja con la comparación para que el ticket se pueda
    // imprimir COMPLETO en el momento del conteo, sin ir a buscarlo al historial.
    return {
      matched: true, ambiguous: false, folio: cut.folio,
      esperado, kepler_contado: keplerContado, kepler_diff: keplerDiff,
      diff_real: diffReal, kepler_enmascaro: keplerEnmascaro,
      kepler_billetes: cut.arqueo_billetes == null ? null : Number(cut.arqueo_billetes),
      kepler_monedas: cut.arqueo_monedas == null ? null : Number(cut.arqueo_monedas),
      kepler_retirado: cut.efectivo_retirado == null ? null : Number(cut.efectivo_retirado),
    };
  }

  /**
   * SM.12 — La encargada va al lugar, cuenta con la cajera y **firma**.
   *
   * `validado_at IS NULL` es el estado inicial y lo que alimenta la bandeja de
   * "por validar". No se puede validar en nombre de otro: el username lo pone el
   * controller desde el JWT, igual que la captura.
   */
  async validar(id: string, username?: string, nota?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('reconciliation.blind_counts')
        .where({ tenant_id: trx.raw('current_tenant_id()') as any, id })
        .update({ validado_por: username || null, validado_at: trx.fn.now(), validado_nota: nota || null })
        .returning(['id', 'warehouse_code', 'caja', 'business_date', 'cajero_code', 'total_contado', 'validado_por', 'validado_at']);
      if (!row) throw new BadRequestException('Arqueo no encontrado');
      this.logger.log(`arqueo ${id} validado por ${username || '?'} (suc${row.warehouse_code} caja${row.caja})`);
      return row;
    });
  }

  /**
   * SM.14 — Historial de arqueos: el detalle más el acumulado **por cajera**.
   *
   * El agregado contesta la pregunta que el detalle no: no "qué pasó el martes"
   * sino "a quién le pasa seguido". Por eso separa faltantes de sobrantes en vez
   * de sumarlos — una cajera con +$500 y −$500 no cuadra en promedio, tiene dos
   * errores; netearlos la haría ver perfecta.
   *
   * `sin_validar` sale acá para que la encargada vea de un vistazo qué le falta
   * firmar, sin recorrer el detalle.
   */
  /**
   * SM.19 — El historial visto por PERSONA: una tarjeta por cajera con todos sus
   * cortes.
   *
   * Cambia la fuente respecto de `historial()`: aquélla parte de NUESTROS conteos,
   * así que un turno que nadie arqueó simplemente no existía en la pantalla. Ésta
   * parte de los **cortes de Kepler** (`analytics.cash_cuts`) y le cuelga nuestro
   * arqueo cuando lo hay — de modo que **el turno sin contar también se ve**, que
   * es justo el que hay que perseguir.
   *
   * Trae el horario (apertura, cierre y duración) porque la pregunta operativa no
   * es solo cuánto, sino cuándo: los turnos largos duplican la tasa de descuadre
   * (12% vs 6%, medido en SM.7b).
   */
  async porCajera(q: {
    from?: string; to?: string; warehouse_codes?: string[] | null;
    cajero_code?: string; limit?: number;
  }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limite = Math.min(1000, Math.max(1, Number(q.limit) || 400));
    if (q.warehouse_codes && !q.warehouse_codes.length) return { cajeras: [], totales: { cajeras: 0, cortes: 0, sin_arqueo: 0 } };

    const filas = await this.tk.run(async (trx) => {
      const b = trx('analytics.cash_cuts as cc')
        .where('cc.tenant_id', tenantId)
        .whereNotNull('cc.cajero_cierre')
        .leftJoin('analytics.pos_cashiers as pc', function (this: any) {
          this.on('pc.tenant_id', '=', 'cc.tenant_id')
            .andOn('pc.warehouse_code', '=', 'cc.warehouse_code')
            .andOn('pc.cajero_code', '=', 'cc.cajero_cierre');
        })
        // Nuestro conteo del mismo turno, si existe. Por folio: es la liga exacta.
        .leftJoin('reconciliation.blind_counts as bc', function (this: any) {
          this.on('bc.tenant_id', '=', 'cc.tenant_id')
            .andOn('bc.warehouse_code', '=', 'cc.warehouse_code')
            .andOn('bc.cash_cut_folio', '=', 'cc.folio')
            .andOn(trx.raw("bc.tipo = 'cierre'"));
        })
        .select(
          'cc.warehouse_code', 'cc.warehouse_name', 'cc.caja', 'cc.folio',
          trx.raw('cc.business_date::text AS business_date'),
          trx.raw('cc.cajero_cierre AS cajero_code'),
          trx.raw('pc.nombre AS cajero_nombre'),
          'cc.hora_apertura', 'cc.hora_cierre', 'cc.duracion_horas', 'cc.handoff',
          trx.raw('cc.efectivo_esperado::numeric AS esperado'),
          trx.raw('cc.efectivo_contado::numeric AS kepler_contado'),
          trx.raw('cc.arqueo_billetes::numeric AS kepler_billetes'),
          trx.raw('cc.arqueo_monedas::numeric AS kepler_monedas'),
          trx.raw('cc.efectivo_retirado::numeric AS kepler_retirado'),
          trx.raw('cc.venta_total::numeric AS venta'),
          trx.raw('bc.id AS arqueo_id'),
          trx.raw('bc.total_contado::numeric AS nuestro_contado'),
          'bc.denominations', 'bc.validado_por', 'bc.validado_at', 'bc.captured_by', 'bc.captured_at',
        )
        .orderBy('cc.business_date', 'desc').orderBy('cc.hora_cierre', 'desc')
        .limit(limite);
      if (q.warehouse_codes) b.whereIn('cc.warehouse_code', q.warehouse_codes);
      if (q.cajero_code) b.whereRaw('upper(cc.cajero_cierre) = ?', [q.cajero_code.toUpperCase()]);
      if (q.from) b.where('cc.business_date', '>=', q.from);
      if (q.to) b.where('cc.business_date', '<=', q.to);
      return b;
    });

    const acc = new Map<string, any>();
    for (const r of filas as any[]) {
      const key = String(r.cajero_code).toUpperCase();
      let g = acc.get(key);
      if (!g) {
        g = {
          cajero_code: r.cajero_code, cajero_nombre: r.cajero_nombre || null,
          warehouse_code: r.warehouse_code, warehouse_name: r.warehouse_name || null,
          cortes: 0, dias: new Set<string>(), sin_arqueo: 0, sin_validar: 0,
          faltante_total: 0, sobrante_total: 0, venta_total: 0,
          ultimo: null as string | null, turnos: [] as any[],
        };
        acc.set(key, g);
      }
      const esperado = r.esperado != null ? Number(r.esperado) : null;
      const nuestro = r.nuestro_contado != null ? Number(r.nuestro_contado) : null;
      const diff = esperado != null && nuestro != null ? Math.round((esperado - nuestro) * 100) / 100 : null;
      const den: Record<string, number> = (typeof r.denominations === 'string' ? JSON.parse(r.denominations) : r.denominations) || {};
      const denominaciones = DENOMS
        .map((d) => ({ denominacion: d, cantidad: Number(den[String(d)]) || 0 }))
        .filter((x) => x.cantidad > 0)
        .map((x) => ({ ...x, subtotal: Math.round(x.denominacion * x.cantidad * 100) / 100 }));

      g.cortes++;
      g.dias.add(String(r.business_date).slice(0, 10));
      g.venta_total = Math.round((g.venta_total + Number(r.venta || 0)) * 100) / 100;
      if (nuestro == null) g.sin_arqueo++;
      else if (!r.validado_at) g.sin_validar++;
      if (diff != null && Math.abs(diff) >= ARQ_UMBRAL) {
        if (diff > 0) g.faltante_total = Math.round((g.faltante_total + diff) * 100) / 100;
        else g.sobrante_total = Math.round((g.sobrante_total - diff) * 100) / 100;
      }
      const f = String(r.business_date).slice(0, 10);
      if (!g.ultimo || f > g.ultimo) g.ultimo = f;

      g.turnos.push({
        arqueo_id: r.arqueo_id || null,
        business_date: f, caja: r.caja, folio: r.folio,
        hora_apertura: r.hora_apertura, hora_cierre: r.hora_cierre,
        duracion_horas: r.duracion_horas != null ? Number(r.duracion_horas) : null,
        handoff: r.handoff === true,
        esperado, kepler_contado: r.kepler_contado != null ? Number(r.kepler_contado) : null,
        kepler_billetes: r.kepler_billetes != null ? Number(r.kepler_billetes) : null,
        kepler_monedas: r.kepler_monedas != null ? Number(r.kepler_monedas) : null,
        kepler_retirado: r.kepler_retirado != null ? Number(r.kepler_retirado) : null,
        venta: r.venta != null ? Number(r.venta) : null,
        nuestro_contado: nuestro, diff_real: diff, denominaciones,
        capturado_por: r.captured_by || null, capturado_at: r.captured_at || null,
        validado_por: r.validado_por || null, validado_at: r.validado_at || null,
      });
    }

    const cajeras = Array.from(acc.values())
      .map((g) => ({ ...g, dias: g.dias.size }))
      .sort((a, b) => (b.faltante_total + b.sobrante_total) - (a.faltante_total + a.sobrante_total) || b.cortes - a.cortes);

    return {
      cajeras,
      totales: {
        cajeras: cajeras.length,
        cortes: cajeras.reduce((s, g) => s + g.cortes, 0),
        sin_arqueo: cajeras.reduce((s, g) => s + g.sin_arqueo, 0),
        faltante_total: Math.round(cajeras.reduce((s, g) => s + g.faltante_total, 0) * 100) / 100,
      },
    };
  }

  async historial(q: {
    from?: string; to?: string; warehouse_codes?: string[] | null;
    cajero_code?: string; solo_sin_validar?: boolean; limit?: number;
  }) {
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
    const arqueos = await this.list({ ...q, limit });
    const filtrados = q.solo_sin_validar ? arqueos.filter((a: any) => !a.validado_at) : arqueos;

    const acc = new Map<string, any>();
    for (const a of filtrados as any[]) {
      const key = (a.cajero_code || '—').toUpperCase();
      let g = acc.get(key);
      if (!g) {
        g = {
          cajero_code: a.cajero_code || null, cajero_nombre: a.cajero_nombre || null,
          warehouse_code: a.warehouse_code, arqueos: 0, total_contado: 0,
          con_diferencia: 0, faltante_total: 0, sobrante_total: 0,
          sin_validar: 0, ultima_fecha: null as string | null,
        };
        acc.set(key, g);
      }
      g.arqueos++;
      g.total_contado = Math.round((g.total_contado + Number(a.total_contado || 0)) * 100) / 100;
      if (!a.validado_at) g.sin_validar++;
      const f = String(a.business_date).slice(0, 10);
      if (!g.ultima_fecha || f > g.ultima_fecha) g.ultima_fecha = f;
      const d = a.diff_real;
      if (d != null && Math.abs(Number(d)) >= ARQ_UMBRAL) {
        g.con_diferencia++;
        // Faltante y sobrante NO se netean: son dos errores distintos.
        if (Number(d) > 0) g.faltante_total = Math.round((g.faltante_total + Number(d)) * 100) / 100;
        else g.sobrante_total = Math.round((g.sobrante_total - Number(d)) * 100) / 100;
      }
    }
    // `Array.from`, NO `[...acc.values()]`: con el target de compilación de la lib
    // el helper de spread no reconoce el iterador de Map y lo mete como ÚNICO
    // elemento — y un iterador serializa a `{}`, así que la respuesta salía con
    // una fila vacía y los totales en NaN, sin romperse. Mismo landmine que ya
    // estaba anotado para el spread de Set en `[ID.5]`.
    const por_cajera = Array.from(acc.values()).sort(
      (a, b) => (b.faltante_total + b.sobrante_total) - (a.faltante_total + a.sobrante_total) || b.arqueos - a.arqueos,
    );

    return {
      arqueos: filtrados,
      por_cajera,
      totales: {
        arqueos: filtrados.length,
        sin_validar: filtrados.filter((a: any) => !a.validado_at).length,
        faltante_total: Math.round(por_cajera.reduce((s, g) => s + g.faltante_total, 0) * 100) / 100,
        sobrante_total: Math.round(por_cajera.reduce((s, g) => s + g.sobrante_total, 0) * 100) / 100,
      },
    };
  }

  /**
   * Lista arqueos ciegos con su comparación (para la consola).
   *
   * `warehouse_codes` es el alcance ya resuelto por `ScopeService` (`[ID.4]`):
   * `null` = sin filtro (alcance `all`), `[]` = no ve ninguna sucursal → cero
   * filas, no un 403 (un historial vacío es una respuesta legítima; un error
   * rompe la pantalla). `warehouse_code` (singular) queda para los llamadores
   * que todavía filtran a mano — la consola del supervisor.
   */
  async list(q: { from?: string; to?: string; warehouse_code?: string; warehouse_codes?: string[] | null; cajero_code?: string; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    return this.tk.run(async (trx) => {
      const b = trx('reconciliation.blind_counts as bc')
        .where('bc.tenant_id', trx.raw('current_tenant_id()'))
        .leftJoin('analytics.cash_cuts as cc', function (this: any) {
          this.on('cc.tenant_id', '=', 'bc.tenant_id').andOn('cc.warehouse_code', '=', 'bc.warehouse_code')
            .andOn('cc.caja', '=', 'bc.caja').andOn('cc.business_date', '=', 'bc.business_date')
            .andOn(trx.raw('cc.cajero_cierre IS NOT DISTINCT FROM bc.cajero_code'));
        })
        .leftJoin('analytics.pos_cashiers as pc', function (this: any) {
          this.on('pc.tenant_id', '=', 'bc.tenant_id').andOn('pc.warehouse_code', '=', 'bc.warehouse_code').andOn('pc.cajero_code', '=', 'bc.cajero_code');
        })
        .select('bc.id', 'bc.tipo', 'bc.warehouse_code', 'bc.caja', 'bc.business_date', 'bc.turno', 'bc.cajero_code', 'bc.cajero_entrante',
          // Se necesita el JSONB crudo para partir NUESTRO conteo en billetes y
          // monedas y poder compararlo contra el desglose de Kepler.
          'bc.denominations',
          'bc.cash_cut_folio', 'bc.caja_kepler', 'bc.turno_abierto_at',
          'bc.validado_por', 'bc.validado_at', 'bc.validado_nota',
          trx.raw('pc.nombre AS cajero_nombre'), trx.raw('bc.total_contado::numeric AS total_contado'),
          'bc.captured_by', 'bc.captured_at', 'bc.nota', 'bc.incidencia_tipo',
          trx.raw('cc.efectivo_esperado::numeric AS esperado'),
          trx.raw('cc.efectivo_contado::numeric AS kepler_contado'),
          trx.raw('cc.efectivo_diff::numeric AS kepler_diff'),
          // SM.18 — el desglose que Kepler sí manda. No es por denominación (eso
          // no existe en el ERP), pero sí separa billetes de monedas.
          trx.raw('cc.arqueo_billetes::numeric AS kepler_billetes'),
          trx.raw('cc.arqueo_monedas::numeric AS kepler_monedas'),
          trx.raw('cc.efectivo_retirado::numeric AS kepler_retirado'))
        .orderBy('bc.captured_at', 'desc').limit(limit);
      if (q.warehouse_code) b.where('bc.warehouse_code', q.warehouse_code);
      if (q.warehouse_codes) {
        if (!q.warehouse_codes.length) b.whereRaw('false');
        else b.whereIn('bc.warehouse_code', q.warehouse_codes);
      }
      // La cajera ve SUS arqueos, no los de la caja de al lado. La sucursal sola no
      // alcanza: en una tienda con 5 cajas le mostraría el conteo de sus compañeras.
      if (q.cajero_code) b.whereRaw('upper(bc.cajero_code) = ?', [q.cajero_code.toUpperCase()]);
      if (q.from) b.where('bc.business_date', '>=', q.from);
      if (q.to) b.where('bc.business_date', '<=', q.to);
      const rows = await b;
      return rows.map((r: any) => {
        const total = Number(r.total_contado);
        // El relevo es intra-turno: no compara contra el corte del día.
        const esperado = r.tipo === 'relevo' ? null : (r.esperado != null ? Number(r.esperado) : null);
        const diffReal = esperado != null ? Math.round((esperado - total) * 100) / 100 : null;
        const keplerDiff = r.tipo === 'relevo' ? null : (r.kepler_diff != null ? Number(r.kepler_diff) : null);
        // El arqueo que DECLARÓ Kepler (c25), al lado del nuestro. Es la
        // comparación que valida la encargada: los dos dicen contar el mismo
        // cajón y casi nunca coinciden.
        const keplerContado = r.tipo === 'relevo' ? null : (r.kepler_contado != null ? Number(r.kepler_contado) : null);
        // Nuestro conteo partido igual que el de Kepler, para poder compararlos:
        // en MXN el billete arranca en $20 y de ahí para abajo es moneda.
        const den: Record<string, number> = (typeof r.denominations === 'string' ? JSON.parse(r.denominations) : r.denominations) || {};
        let nuestroBilletes = 0, nuestroMonedas = 0;
        for (const [d, q] of Object.entries(den)) {
          const v = Math.round(Number(d) * Number(q) * 100) / 100;
          if (!Number.isFinite(v)) continue;
          if (Number(d) >= 20) nuestroBilletes += v; else nuestroMonedas += v;
        }
        nuestroBilletes = Math.round(nuestroBilletes * 100) / 100;
        nuestroMonedas = Math.round(nuestroMonedas * 100) / 100;
        /**
         * El conteo pieza por pieza — `1000 × 2 = 2000`. Kepler NO tiene esto
         * (verificado sobre las 307 tablas del catálogo: solo guarda el total de
         * billetes y el de monedas), así que este desglose existe únicamente
         * porque nuestra cajera lo captura. Es la evidencia de cómo se llegó al
         * total: sin él, "conté $17,190.50" es una afirmación sin respaldo.
         */
        const denominaciones = DENOMS
          .map((d) => ({ denominacion: d, cantidad: Number(den[String(d)]) || 0 }))
          .filter((x) => x.cantidad > 0)
          .map((x) => ({ ...x, subtotal: Math.round(x.denominacion * x.cantidad * 100) / 100 }));
        const keplerBilletes = r.tipo === 'relevo' ? null : (r.kepler_billetes != null ? Number(r.kepler_billetes) : null);
        const keplerMonedas = r.tipo === 'relevo' ? null : (r.kepler_monedas != null ? Number(r.kepler_monedas) : null);
        const keplerRetirado = r.tipo === 'relevo' ? null : (r.kepler_retirado != null ? Number(r.kepler_retirado) : null);
        /**
         * Chequeo de coherencia del corte de Kepler: billetes + monedas + retirado
         * debe dar el contado. Cuando no cierra, el hueco suele ser un número
         * redondo — un retiro que nadie registró.
         */
        const sumaKepler = (keplerBilletes ?? 0) + (keplerMonedas ?? 0) + (keplerRetirado ?? 0);
        const keplerDesgloseCuadra = keplerContado != null && keplerBilletes != null
          ? Math.abs(sumaKepler - keplerContado) < 1 : null;
        return {
          id: r.id, tipo: r.tipo, warehouse_code: r.warehouse_code, caja: r.caja, business_date: r.business_date, turno: r.turno,
          cajero_code: r.cajero_code, cajero_entrante: r.cajero_entrante || null, cajero_nombre: r.cajero_nombre || null, total_contado: total,
          cash_cut_folio: r.cash_cut_folio || null, caja_kepler: r.caja_kepler || null, turno_abierto_at: r.turno_abierto_at || null,
          validado_por: r.validado_por || null, validado_at: r.validado_at || null, validado_nota: r.validado_nota || null,
          captured_by: r.captured_by, captured_at: r.captured_at, nota: r.nota, incidencia_tipo: r.incidencia_tipo || null,
          esperado, kepler_contado: keplerContado, kepler_diff: keplerDiff, diff_real: diffReal,
          kepler_billetes: keplerBilletes, kepler_monedas: keplerMonedas, kepler_retirado: keplerRetirado,
          kepler_desglose_cuadra: keplerDesgloseCuadra,
          kepler_desglose_faltante: keplerDesgloseCuadra === false
            ? Math.round((keplerContado! - sumaKepler) * 100) / 100 : null,
          nuestro_billetes: nuestroBilletes, nuestro_monedas: nuestroMonedas, denominaciones,
          kepler_enmascaro: keplerDiff != null && diffReal != null && Math.abs(keplerDiff) < 50 && Math.abs(diffReal) >= 50,
        };
      });
    });
  }
}
