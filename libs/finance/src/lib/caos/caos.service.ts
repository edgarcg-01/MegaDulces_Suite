import { Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { diaMxDeInstante } from '@megadulces/contracts';
import type { Knex } from 'knex';

/**
 * ⚠️ `[CG.163]` El default de la ventana se calculaba con
 * `new Date(Date.now() - N*86400000).toISOString().slice(0, 10)` — o sea el día en **UTC**,
 * mientras el `to` de la pantalla usa `todayMx()`. Después de las 18:00 de México el ISO ya
 * marca el día siguiente, así que la ventana por omisión se corría un día y nadie lo veía
 * porque sólo pasa de tarde. El día de negocio de este proyecto es México (`ADR` de TZ).
 */
const diaMxHace = (dias: number): string =>
  diaMxDeInstante(new Date(Date.now() - dias * 86400000)) ?? new Date().toISOString().slice(0, 10);

/**
 * El día siguiente a `YYYY-MM-DD`, para un `<` exclusivo que incluya el día completo de `to`.
 *
 * ⚠️ Se ancla a mediodía UTC (06:00 de México) a propósito: así ni el horario de verano ni el
 * desfase de zona pueden mover el día. Y se pasa un `Date`, no un número de ms —
 * `diaMxDeInstante` hace `new Date(String(v))` con lo que no es `Date`, y `String(1760000000000)`
 * no es una fecha parseable.
 */
const diaSiguiente = (dia: string): string =>
  diaMxDeInstante(new Date(new Date(`${dia}T12:00:00Z`).getTime() + 86400000)) ?? dia;

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

/**
 * ⛔⛔ `[CG.161]`+`[CG.163]` **ACÁ VIVÍA UNA REGEX DE RUTA. SE FUE, Y ESA ES LA CORRECCIÓN.**
 *
 * El panel «Por ruta» extraía el número de ruta del `ref` con
 * `substring(lower(ref) from '(?:rd|ruta|r)\\s*(\\d+)')`, repetida en el `SELECT` y en el
 * `GROUP BY`. Tres defectos encadenados, los tres medidos contra producción el 2026-10-15:
 *
 *  1. **500 en prod.** `knex` convierte **todo `?` final** en `$n` vía `positionBindings`,
 *     incluido el del grupo no-capturador. A Postgres llegaba
 *     `'($1:rd|ruta|r)…'` en el `SELECT` y `'($5:…)'` en el `GROUP BY` — dos expresiones
 *     distintas para el planificador ⇒ `42803 column "caos_cash_movements.ref" must appear in
 *     the GROUP BY clause`. El endpoint devolvía 500 **cada vez que alguien abría el arqueo**.
 *  2. **Escapar el `?` no alcanzaba.** Con `\\?` la consulta corre, y entonces el `(\\d+)` glotón
 *     se come la fecha pegada al número: `ruta22240926` publicaba **«Ruta 22240926»**. Medido:
 *     **19 rutas inventadas** con $328,520, y la ruta 22 real caía a 4 depósitos cuando sus
 *     hermanas tienen 20–23. Una ruta inventada le cobra el depósito a un camión que no fue.
 *  3. **Ya existía el resolvedor bueno.** `[CG.58.6]` dejó `atribuirDeposito` y la tabla
 *     `finance.caos_deposito_grano` —con sus pruebas— resolviendo los MISMOS depósitos al grano
 *     que el texto aguanta (`ruta_dia` · `ruta` · `plaza` · `sin_declarar`). Dos extractores de
 *     lo mismo, y la pantalla usaba el peor.
 *
 * ⭐ Por eso el panel ahora **deriva del grano** (ADR-056: el primitivo vive en un lugar) y no
 * parsea nada. Medido sobre la misma ventana de 30 días: la ruta 22 recupera sus **21 depósitos /
 * $335,240**, Canindo se declara como `plaza` —no se le inventa una ruta—, y la consulta baja de
 * 500 a **7 ms**.
 */
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
    const desde = q.from || diaMxHace(7);
    const hasta = q.to ? diaSiguiente(q.to) : null;

    return this.tk.run(async (trx) => {
      const filtros = (qb: any) => {
        let x = qb.where('tenant_id', tenantId).where('occurred_at', '>=', desde);
        if (hasta) x = x.where('occurred_at', '<', hasta);
        if (q.tipo) x = x.where((b: any) => b.where('type_label', q.tipo).orWhere('type_id', Number(q.tipo) || -999));
        if (q.usuario) x = x.whereILike('user_external', `%${q.usuario}%`);
        if (q.ref) x = x.whereILike('ref', `%${q.ref}%`);
        return x;
      };

      const rows = await filtros(trx('analytics.caos_cash_movements'))
        .orderBy([{ column: 'occurred_at', order: 'desc' }, { column: 'external_id', order: 'desc' }])
        .limit(limit)
        /**
         * ⚠️ `[CG.163]` `shift_id` salió del `SELECT`: está **100 % en NULL** en los 1,165
         * movimientos de prod (`cash-cut.service.ts` ya lo tenía medido y documentado) y ninguna
         * pantalla lo leía. Una columna muerta que viaja en cada respuesta se lee como un dato
         * que alguien algún día va a usar.
         */
        .select('id', 'device', 'external_id', 'type_id', 'type_label', 'occurred_at',
          'accounting_date', 'user_external', 'total', 'currency', 'ref');

      /**
       * ⛔⛔ `[CG.163]` **EL KPI «BALANCE» CORRÍA SOBRE 2 DE LOS 7 TIPOS Y NO LO DECLARABA.**
       *
       * `movimientos` cuenta `count(*)` de TODO; `depositos` y `dispensado` filtran `type_id`
       * 0 y 4. Medido en prod el 2026-10-15 sobre el histórico completo:
       *
       *     en los KPI de dinero   1,128 movs   $36,750,000
       *     SÓLO en el conteo         37 movs    $4,870,730   ← Vaciar Stocks, Dotar,
       *                                                         Fin de Dia, Contenido
       *                                                         Modificado, Cambio
       *
       * Esos 37 **aparecen en la tabla de abajo** y en el contador «Movimientos», pero no entran
       * a ninguna cifra de dinero. La tira se contradecía a sí misma sin decirlo, y un `Dotar`
       * de $1.7 M o un `Vaciar Stocks` de $2.9 M mueven efectivo de la máquina igual que un
       * depósito.
       *
       * ⛔ Lo que NO se hace acá: sumarlos al balance. El **signo** de `Vaciar Stocks` y `Dotar`
       * no está decodificado contra el dispositivo (ambos llegan con `total` positivo), y meterlos
       * con un signo supuesto sería inventar la cifra que la gente va a usar para cuadrar. Se
       * publica `otros_n`/`otros_total` **aparte y declarado**, y `balance` pasa a llamarse por lo
       * que es: depósitos − dispensado. Declarar el hueco con su monto es la regla; dibujarlo como
       * cero o como parte del balance es el defecto (ADR-056).
       */
      const kpi: any = await filtros(trx('analytics.caos_cash_movements'))
        .select(trx.raw(`
          count(*)::int AS movimientos,
          coalesce(sum(total) FILTER (WHERE type_id = 0), 0) AS depositos,
          coalesce(sum(total) FILTER (WHERE type_id = 4), 0) AS dispensado,
          coalesce(sum(total) FILTER (WHERE type_id = 0), 0)
            - coalesce(sum(total) FILTER (WHERE type_id = 4), 0) AS balance,
          count(*) FILTER (WHERE type_id NOT IN (0, 4))::int AS otros_n,
          coalesce(sum(abs(total)) FILTER (WHERE type_id NOT IN (0, 4)), 0) AS otros_total,
          max(synced_at) AS datos_al
        `)).first();

      /**
       * ⭐ `[CG.163]` El catálogo de tipos que de verdad existen en el rango, para que el combo
       * no se los invente ni se los pierda. El combo estaba escrito a mano con 4 tipos
       * (`0,4,8,7`) y en prod hay **7**: `Fin de Dia`, `Vaciar Stocks` y `Contenido Modificado`
       * —17 movimientos, $3.2 M— no se podían filtrar porque la lista no los nombraba.
       *
       * ⚠️ Se calcula sobre la VENTANA, ignorando el filtro de tipo: si lo respetara, elegir un
       * tipo dejaría el combo con una sola opción y no habría forma de volver.
       */
      const tipos = await trx('analytics.caos_cash_movements')
        .where('tenant_id', tenantId)
        .where('occurred_at', '>=', desde)
        .modify((qb: Knex.QueryBuilder) => { if (hasta) qb.where('occurred_at', '<', hasta); })
        .select('type_id', 'type_label')
        .count({ n: '*' })
        .groupBy('type_id', 'type_label')
        .orderBy('type_id');

      return {
        rows,
        kpi,
        tipos,
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
    const desde = q.from || diaMxHace(30);
    const hasta = q.to ? diaSiguiente(q.to) : null;

    return this.tk.run(async (trx) => {
      const rango = (qb: any) => {
        let x = qb.where('tenant_id', tenantId).where('occurred_at', '>=', desde);
        if (hasta) x = x.where('occurred_at', '<', hasta);
        return x;
      };

      /**
       * ⭐ `[CG.163]` Por RUTA: sólo depósitos, y **derivado de `finance.caos_deposito_grano`** —
       * el veredicto que `[CG.58.6]` ya escribe para cada depósito con `atribuirDeposito`, que
       * tiene sus pruebas y sabe bajar de grano en vez de inventar.
       *
       * ⚠️ Se agrupa también por `motivo` a propósito: es lo que separa las DOS ausencias que
       * `sin_declarar` mete en la misma bolsa (contrato de `esVecinal`) — *la vecinal es otro
       * circuito y se arquea en SU caja* vs *el texto no dice nada y el dinero queda sin dueño*.
       * Sumarlas borraría la diferencia, y las arregla gente distinta.
       *
       * `grano` NULL = el carril de clasificación todavía no vio ese depósito. Se DECLARA como
       * `sin_clasificar`; no se cuenta como «sin ruta», que es otra cosa.
       */
      const porRuta = await trx('analytics.caos_cash_movements as m')
        .leftJoin('finance.caos_deposito_grano as g', function joinGrano(this: Knex.JoinClause) {
          this.on('g.tenant_id', '=', 'm.tenant_id')
            .andOn('g.caos_device', '=', 'm.device')
            .andOn('g.caos_external_id', '=', 'm.external_id')
            .andOnNull('g.deleted_at');
        })
        .where('m.tenant_id', tenantId)
        .where('m.type_id', 0)
        .where('m.occurred_at', '>=', desde)
        .modify((qb: Knex.QueryBuilder) => { if (hasta) qb.where('m.occurred_at', '<', hasta); })
        .select(trx.raw(`coalesce(g.grano, 'sin_clasificar') AS grano`))
        .select('g.ruta', 'g.plaza')
        .select(trx.raw(`coalesce(g.motivo, 'el carril de clasificación todavía no lo vio') AS motivo`))
        .count({ movimientos: '*' })
        .sum({ total: 'm.total' })
        .groupByRaw('1, g.ruta, g.plaza, 4')
        .orderByRaw('sum(m.total) desc nulls last');

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
    const desde = q.from || diaMxHace(30);
    const hasta = q.to || diaMxHace(0);

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

      /**
       * ⚠️ `[CG.163]` El desglose **no siempre suma el total** del movimiento, y callarlo deja
       * que el drill se lea como una comprobación que nadie hizo. Medido en prod el 2026-10-15
       * sobre los 1,165 movimientos: **1 descuadrado** — `Vaciar Stocks` ext. `1478`
       * (30-sep 17:53) declara `total = $20.00` y su desglose suma **$86,220**.
       *
       * No se corrige ninguno de los dos lados: los dos vienen del dispositivo y no sabemos cuál
       * miente. Se publica la suma al lado del total para que la diferencia se VEA (ADR-056).
       */
      const denominaciones_total = denom.reduce(
        (a: number, d: { denom: string | number; quantity: string | number }) =>
          a + Number(d.denom) * Number(d.quantity), 0,
      );
      return {
        ...mov,
        denominaciones: denom,
        denominaciones_total: Math.round(denominaciones_total * 100) / 100,
      };
    });
  }
}
