import { Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * CS.2 — Lectura del espejo de CAOS (`analytics.caos_cash_movements`).
 *
 * La tabla NO tiene RLS (es un espejo alimentado por un importer, patrón `kepler_bank_movements`),
 * así que el filtro de tenant va EXPLÍCITO en cada query — igual que la bandeja de Caja General
 * sobre `kepler_bank_movements`. Se corre dentro de `tk.run` para tomar el tenant del contexto.
 */
export interface CaosQuery {
  from?: string;
  to?: string;
  tipo?: string;       // type_label o type_id
  usuario?: string;    // busca en user_external
  ref?: string;        // busca en ref
  limit?: number;
}

@Injectable()
export class CaosService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Lista de movimientos + KPIs del rango. Default: últimos 7 días (la caja mueve ~8/día, así que
   * una ventana corta ya trae contexto sin listar 4 meses). `has_more` avisa si se topó.
   */
  async movimientos(q: CaosQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 1000);
    const desde = q.from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

    return this.tk.run(async (trx) => {
      const filtros = (qb: any) => {
        let x = qb.where('tenant_id', tenantId).where('occurred_at', '>=', desde);
        if (q.to) x = x.where('occurred_at', '<', new Date(new Date(q.to).getTime() + 86400000).toISOString().slice(0, 10));
        if (q.tipo) x = x.where((b: any) => b.where('type_label', q.tipo).orWhere('type_id', Number(q.tipo) || -999));
        if (q.usuario) x = x.whereILike('user_external', `%${q.usuario}%`);
        if (q.ref) x = x.whereILike('ref', `%${q.ref}%`);
        return x;
      };

      const rows = await filtros(trx('analytics.caos_cash_movements'))
        .orderBy([{ column: 'occurred_at', order: 'desc' }, { column: 'external_id', order: 'desc' }])
        .limit(limit)
        .select('id', 'device', 'external_id', 'type_id', 'type_label', 'occurred_at',
          'accounting_date', 'user_external', 'total', 'currency', 'ref', 'shift_id');

      // KPIs del rango completo (no del tope): depósitos entran, dispensaciones salen.
      const kpi: any = await filtros(trx('analytics.caos_cash_movements'))
        .select(trx.raw(`
          count(*)::int AS movimientos,
          coalesce(sum(total) FILTER (WHERE type_id = 0), 0) AS depositos,
          coalesce(sum(total) FILTER (WHERE type_id = 4), 0) AS dispensado,
          coalesce(sum(total) FILTER (WHERE type_id = 0), 0)
            - coalesce(sum(total) FILTER (WHERE type_id = 4), 0) AS balance,
          max(synced_at) AS datos_al
        `)).first();

      return {
        rows,
        kpi,
        desde,
        limit,
        has_more: rows.length === limit,
      };
    });
  }

  /**
   * CS.6/CS.7 — Resumen INTERNO de CAOS: por ruta (del `ref` de los depósitos) y por operador.
   *
   * No cruza contra nada (no tiene el problema de grano del árbitro): son agregaciones sobre el
   * propio espejo. La ruta se extrae del `ref` (`"ruta 27 240926"`); lo que no parsea como ruta se
   * DECLARA como "sin ruta", nunca se inventa una (regla del proyecto).
   */
  async resumen(q: CaosQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const desde = q.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const hasta = q.to ? new Date(new Date(q.to).getTime() + 86400000).toISOString().slice(0, 10) : null;

    return this.tk.run(async (trx) => {
      const rango = (qb: any) => {
        let x = qb.where('tenant_id', tenantId).where('occurred_at', '>=', desde);
        if (hasta) x = x.where('occurred_at', '<', hasta);
        return x;
      };

      // Por RUTA: sólo depósitos. El `ref` es TEXTO LIBRE del operador ("rd28", "ruta 21 09 26",
      // "rd morelia", "r23…"), sin formato forzado. Medido contra prod: `(?:rd|ruta|r)\\s*(\\d+)`
      // extrae el número de ruta en ~40% de los depósitos; el resto no trae número reconocible
      // (ej. "rd morelia"). `ruta` NULL = "sin ruta reconocida" → se agrupa aparte y la pantalla
      // muestra el ref crudo. NO se inventa una ruta (regla del proyecto: declarar, no dibujar).
      const porRuta = await rango(trx('analytics.caos_cash_movements'))
        .where('type_id', 0)
        .select(trx.raw(`substring(lower(ref) from '(?:rd|ruta|r)\\s*(\\d+)') AS ruta`))
        .count({ movimientos: '*' })
        .sum({ total: 'total' })
        .groupByRaw(`substring(lower(ref) from '(?:rd|ruta|r)\\s*(\\d+)')`)
        .orderByRaw('sum(total) desc nulls last');

      // Por OPERADOR: depósitos (entra) y dispensaciones (sale) por persona.
      const porOperador = await rango(trx('analytics.caos_cash_movements'))
        .select('user_external')
        .select(trx.raw(`
          count(*) FILTER (WHERE type_id = 0)::int AS depositos_n,
          coalesce(sum(total) FILTER (WHERE type_id = 0), 0) AS depositos_total,
          count(*) FILTER (WHERE type_id = 4)::int AS dispensado_n,
          coalesce(sum(total) FILTER (WHERE type_id = 4), 0) AS dispensado_total
        `))
        .groupBy('user_external')
        .orderByRaw('coalesce(sum(total) FILTER (WHERE type_id = 0),0) desc');

      return { porRuta, porOperador, desde };
    });
  }

  /**
   * CS.4 — Cuadre de TOTAL DE CONTROL: CAOS (máquina) vs Caja General de Kepler (`c45=0011`, suc 00).
   *
   * ⚠️ NO es un árbitro 1:1. La medición (2026-09-25) lo refutó: 0% de cruce por importe (CAOS
   * registra en bulto y redondo, Kepler individual con centavos) y por CAOS pasa sólo ~40% del
   * efectivo de la Caja General. Marcar movimiento por movimiento daría ~60% de falsos hallazgos.
   *
   * Lo defendible es el TOTAL por día/período: cuánto del efectivo de la caja pasó por la máquina y
   * cuál es la brecha. Se PUBLICA la cobertura (ratio CAOS/Kepler), no se dibuja un cuadre perfecto.
   * No levanta hallazgos automáticos: es informativo hasta que se defina operativamente qué flujo
   * debe pasar por CAOS (sin esa definición, cualquier "diferencia" es sólo lo que no usa la máquina).
   *
   * ⚠️ Frescura desalineada: el feed de CAOS es más nuevo que el contable de Kepler (medido: un día
   * CAOS con datos y Kepler caja en $0). El último día del rango puede verse "descuadrado" por lag,
   * no por un problema real — por eso se muestran los días, no un veredicto.
   */
  async conciliacion(q: CaosQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const desde = q.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const hasta = q.to || new Date().toISOString().slice(0, 10);

    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `WITH caos AS (
           SELECT occurred_at::date AS dia,
                  coalesce(sum(total) FILTER (WHERE type_id = 0), 0) AS caos_dep,
                  coalesce(sum(total) FILTER (WHERE type_id = 4), 0) AS caos_dis
             FROM analytics.caos_cash_movements
            WHERE tenant_id = ? AND occurred_at::date BETWEEN ? AND ?
            GROUP BY 1
         ), kep AS (
           SELECT fecha_valor AS dia,
                  coalesce(sum(importe) FILTER (WHERE signo = 1), 0) AS kep_ing,
                  coalesce(sum(importe) FILTER (WHERE signo = -1), 0) AS kep_egr
             FROM analytics.kepler_bank_movements
            WHERE tenant_id = ? AND sucursal = '00' AND tipo_cuenta = 'caja'
              AND fecha_valor BETWEEN ? AND ?
            GROUP BY 1
         )
         SELECT to_char(coalesce(c.dia, k.dia), 'YYYY-MM-DD') AS dia,
                coalesce(c.caos_dep, 0) AS caos_dep, coalesce(k.kep_ing, 0) AS kepler_ing,
                coalesce(c.caos_dis, 0) AS caos_dis, coalesce(k.kep_egr, 0) AS kepler_egr
           FROM caos c FULL OUTER JOIN kep k ON c.dia = k.dia
          ORDER BY 1 DESC`,
        [tenantId, desde, hasta, tenantId, desde, hasta],
      );

      const n = (v: any) => Number(v) || 0;
      const tot = rows.reduce((a: any, r: any) => ({
        caos_dep: a.caos_dep + n(r.caos_dep), kepler_ing: a.kepler_ing + n(r.kepler_ing),
        caos_dis: a.caos_dis + n(r.caos_dis), kepler_egr: a.kepler_egr + n(r.kepler_egr),
      }), { caos_dep: 0, kepler_ing: 0, caos_dis: 0, kepler_egr: 0 });

      // Cobertura: qué fracción del efectivo de la caja pasó por CAOS. NULL si no hay base (no 0%).
      const cobertura = {
        depositos: tot.kepler_ing ? tot.caos_dep / tot.kepler_ing : null,
        dispensado: tot.kepler_egr ? tot.caos_dis / tot.kepler_egr : null,
      };

      return { dias: rows, totales: tot, cobertura, desde, hasta };
    });
  }

  /** Detalle por denominación de un movimiento (para el drill del reporte). */
  async detalle(id: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const mov = await trx('analytics.caos_cash_movements')
        .where({ tenant_id: tenantId, id })
        .first('id', 'device', 'external_id', 'type_label', 'occurred_at', 'user_external',
          'total', 'currency', 'ref', 'cheques', 'tickets');
      if (!mov) return null;
      const denom = await trx('analytics.caos_cash_denominations')
        .where({ tenant_id: tenantId, movement_id: id })
        .orderBy('denom', 'desc')
        .select('denom', 'pieza_tipo', 'quantity');
      return { ...mov, denominaciones: denom };
    });
  }
}
