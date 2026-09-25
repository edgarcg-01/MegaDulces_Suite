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
