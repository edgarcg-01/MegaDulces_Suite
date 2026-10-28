import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { diaMxDeInstante } from '@megadulces/contracts';
// `[CGA-A.57]`/`[CGA-A.58]` La forma del boundary de vinculos vive en libs/contracts (ADR-052).
import type { CaosVinculos, CaosVinculoFila, CaosVinculoAlta, CaosVinculoBaja } from '@megadulces/contracts';
// `[CGA-A.61]` El lote de vínculos de la reposición y «cambiar de retiro».
import type { VincularLoteInput, VincularLoteResultado, MoverVinculoInput, MoverVinculoResultado } from '@megadulces/contracts';
import type { Knex } from 'knex';
import { sqlDisponibleCaos } from '../caja/caja-custodia.service';
import { tomaDelRetiro } from '../caja/caja-lote.engine';
import {
  CAOS_EFECTO_POR_TIPO, aplicarMovimientos, sqlFolioCajaGeneral, cuadrarFotos, importeDeVector, sqlSignoPorTipo, tiposIndeterminados,
  type CaosFoto, type CaosMovDenom, type CaosParCuadre, type Vector,
} from './caos-saldo';

// ── `[CGA-A.33]` La forma del saldo ──────────────────────────────────────────────────────────

/**
 * `[CGA-A.33]` Una fila del KPI de CAOS, tal como la devuelve el `select` de `kpi()`.
 *
 * ⚠️ Los `sum(...)` se declaran **string**, no `number`: node-pg entrega `numeric` como TEXTO.
 * Tiparlos de número invita a sumarlos sin convertirlos, que es como se fabrica un total
 * equivocado que se lee igual que uno correcto.
 */
export interface CaosKpiFila {
  movimientos: number;
  depositos: string;
  dispensado: string;
  dotado: string;
  vaciado: string;
  neto: string;
  fotos_n: number;
  indeterminados_n: number;
  indeterminados_total: string;
  datos_al: Date | null;
}

export interface CaosLatidoConteo { cuando: string | null; al: Date | null; status: string; nota: string | null; error: string | null }
export interface CaosLatidos { movimientos: CaosLatidoConteo | null; conteo: CaosLatidoConteo | null; atribucion: CaosLatidoConteo | null }
export interface CaosDenomFila { denom: number; billetes: number; importe: number }

export interface CaosSaldo {
  /** `sin_tabla`: la migración no está aplicada · `sin_foto`: el demonio aún no tomó ninguna. */
  estado: 'medido' | 'sin_tabla' | 'sin_foto';
  maquina: {
    tomada_at: Date; confirmada_at: Date; tras_movimiento: number; online: boolean | null;
    con_miscount: boolean; total: number; por_denominacion: CaosDenomFila[];
    contenedores: { tipo: string; indice: number; denom: number; billetes: number; miscount: boolean }[];
  } | null;
  posteriores: { movimientos: number; neto: number; ambiguos: string[]; ultimo_at: Date | null } | null;
  saldo: { total: number; por_denominacion: CaosDenomFila[]; origen: 'maquina' | 'foto_mas_movimientos'; parcial: boolean } | null;
  cuadre: { pares: number; cuadran: number; descuadres: CaosParCuadre[]; no_verificables: CaosParCuadre[] } | null;
  conteo_fisico: { medido: false; motivo: string };
  latido: CaosLatidoConteo | null;
  /** Los tres carriles: la pantalla avisa una falla aunque su panel esté plegado. */
  latidos: CaosLatidos;
  /** [CGA-A.41] Lo que falta registrar en Caja General (con su fecha de inicio derivada). */
  pendientes: CaosPendientes;
}

export interface CaosPendientes {
  medido: boolean; desde: string | null; movimientos: number; monto: number;
  depositos: { n: number; monto: number }; dispensaciones: { n: number; monto: number };
  mas_viejo: Date | null;
}

interface FotoCruda {
  id: string; device: string; after_external_id: string; captured_at: Date; confirmed_at: Date;
  online: boolean | null; any_miscount: boolean; total: string;
}
interface LineaCruda { container_kind: string; container_index: number; denom: string; quantity: number; miscount: boolean }

const aFilas = (v: Vector): CaosDenomFila[] => Object.entries(v)
  .map(([d, q]) => ({ denom: Number(d), billetes: q, importe: Number(d) * q }))
  .sort((a, b) => b.denom - a.denom);

const saldoSinFoto = (estado: 'sin_tabla' | 'sin_foto', latidos: CaosLatidos, pendientes: CaosPendientes): CaosSaldo => ({
  estado, maquina: null, posteriores: null, saldo: null, cuadre: null, latido: latidos.conteo, latidos, pendientes,
  conteo_fisico: { medido: false, motivo: 'Ningún dato registra un conteo a mano de la máquina.' },
});

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
  /** `[CGA-A.41]` Una sola caja de búsqueda: referencia u operador. */
  buscar?: string;
  /** `[CGA-A.41]` 'sin_registrar' = lo que falta en Caja General desde que se registra CAOS (ignora el rango). */
  estado?: string;
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
      const T = 'analytics.caos_cash_movements';
      const folio = sqlFolioCajaGeneral(T);
      const registroDesde = await this.registroDesde(trx, tenantId);
      const sinRegistrar = q.estado === 'sin_registrar';
      const filtros = (qb: any) => {
        let x = qb.where('tenant_id', tenantId);
        /**
         * ⭐ `[CGA-A.41]` «Sin registrar» tiene su PROPIO universo y no el rango: desde el primer
         * movimiento de CAOS que se registró en Caja General (derivado, 2026-10-09). Antes de esa
         * fecha la práctica no existía y nada está registrado: contar 45 días daba **279 movs /
         * $8.23 M** «sin registrar», una acusación falsa del tamaño de la de `[CG.162]`.
         */
        if (sinRegistrar) {
          x = x.whereIn('type_id', [0, 4]).whereRaw(`${folio} IS NULL`);
          x = registroDesde ? x.where('occurred_at', '>=', registroDesde) : x.whereRaw('false');
        } else {
          x = x.where('occurred_at', '>=', desde);
          if (hasta) x = x.where('occurred_at', '<', hasta);
        }
        if (q.buscar) {
          const b = `%${String(q.buscar).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
          x = x.where((w: Knex.QueryBuilder) => w.whereRaw(`ref ILIKE ? ESCAPE '\\'`, [b]).orWhereRaw(`user_external ILIKE ? ESCAPE '\\'`, [b]));
        }
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
          'accounting_date', 'user_external', 'total', 'currency', 'ref',
          // `[CGA-A.41]` En qué folio de Caja General quedó (NULL = falta registrarlo).
          trx.raw(`CASE WHEN type_id IN (0, 4) THEN ${folio} END AS folio_caja_general`),
          // `[CGA-A.57]` CUÁNTOS movimientos de Caja General lo explican: el folio de arriba es UNO
          // (`LIMIT 1`) y el retiro 1775 pagó 20. Sin el conteo, el rótulo afirma que pagó uno.
          trx.raw(`CASE WHEN type_id IN (0, 4) THEN (
             SELECT count(*) FROM finance.caos_cash_links k
               JOIN finance.cash_ledger l ON l.id = k.cash_ledger_id AND l.deleted_at IS NULL
              WHERE k.tenant_id = ${T}.tenant_id AND k.caos_device = ${T}.device
                AND k.caos_external_id = ${T}.external_id AND k.deleted_at IS NULL)::int END AS vinculos_n`));

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
       * ⚠️ SUPERADO el 2026-10-20 por `[CGA-A.33]` (abajo): el signo se decodificó contra el
       * equipo. Lo que sigue es el razonamiento de entonces, que era correcto con lo que se sabía.
       *
       * ⛔ Lo que NO se hace acá: sumarlos al balance. El **signo** de `Vaciar Stocks` y `Dotar`
       * no está decodificado contra el dispositivo (ambos llegan con `total` positivo), y meterlos
       * con un signo supuesto sería inventar la cifra que la gente va a usar para cuadrar. Se
       * publica `otros_n`/`otros_total` **aparte y declarado**, y `balance` pasa a llamarse por lo
       * que es: depósitos − dispensado. Declarar el hueco con su monto es la regla; dibujarlo como
       * cero o como parte del balance es el defecto (ADR-056).
       */
      /**
       * ⭐ `[CGA-A.33]` **El signo ya está decodificado** (`caos-saldo.ts`, medido contra el
       * equipo), así que el KPI deja de apartar `Dotar` y `Vaciar Stocks` como «otros»: entran
       * con su signo al NETO del rango. Lo que sigue sin decodificar —`Cambio`, `Contenido
       * Modificado`, un tipo nuevo— se declara aparte, y el `Fin de Dia` se cuenta como lo que
       * es: una foto, no dinero. El neto es un FLUJO del rango; el saldo vive en `/saldo`.
       *
       * ⛔ Antes `otros_total` era `sum(abs(total))` de todo eso junto: sumaba entradas, salidas
       * y una foto en una sola cifra ($4.87 M en el histórico) que no significaba nada.
       */
      const signo = sqlSignoPorTipo();
      const indet = tiposIndeterminados().join(',') || '-1';
      const kpi: CaosKpiFila | undefined = await filtros(trx('analytics.caos_cash_movements'))
        .select(trx.raw(`
          count(*)::int AS movimientos,
          coalesce(sum(total) FILTER (WHERE type_id = 0), 0) AS depositos,
          coalesce(sum(total) FILTER (WHERE type_id = 4), 0) AS dispensado,
          coalesce(sum(total) FILTER (WHERE type_id = 8), 0) AS dotado,
          coalesce(sum(total) FILTER (WHERE type_id = 5), 0) AS vaciado,
          coalesce(sum(${signo} * total), 0) AS neto,
          count(*) FILTER (WHERE type_id = 2)::int AS fotos_n,
          count(*) FILTER (WHERE type_id IN (${indet}) OR ${signo} = 0 AND type_id <> 2)::int AS indeterminados_n,
          coalesce(sum(total) FILTER (WHERE type_id IN (${indet}) OR ${signo} = 0 AND type_id <> 2), 0) AS indeterminados_total,
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
        // `[CGA-A.33]` El efecto de cada tipo viaja con la respuesta: la pantalla pinta la
        // dirección con el MISMO mapa que suma el neto, en vez de copiarlo a mano.
        efectos: CAOS_EFECTO_POR_TIPO,
        registro_desde: registroDesde,
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

  /**
   * ⭐ `[CGA-A.33]` **El saldo de la caja fuerte, con sus tres testigos separados.**
   *
   *  1. **La máquina** — la última foto de su inventario de casetes (`getCounting`, la escribe
   *     el demonio `caos-live` en `analytics.caos_cash_counts`).
   *  2. **Los movimientos** — cada foto se cuadra contra la anterior más lo que entró entre las
   *     dos, por denominación (`cuadrarFotos`). Si no cierra, es un hallazgo con monto.
   *  3. **El conteo físico** — no existe en ningún dato. Se publica `medido: false`, nunca un
   *     verde (ADR-056): dos lecturas del mismo equipo que coinciden no prueban que el billete
   *     esté adentro; en septiembre el equipo se corrigió solo −$25,420.
   *
   * ⚠️ Si la migración de las fotos todavía no se aplicó, se DECLARA (`estado: 'sin_tabla'`) en
   * vez de tirar un 500: el despliegue del código y el de la migración pueden no caer juntos.
   */
  async saldo(): Promise<CaosSaldo> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx): Promise<CaosSaldo> => {
      const reg = await trx.raw(`SELECT to_regclass('analytics.caos_cash_counts') IS NOT NULL AS hay`);
      const latidos = await this.latidos(trx, tenantId);
      const pendientes = await this.pendientes(trx, tenantId);
      const latido = latidos.conteo;
      if (!reg.rows?.[0]?.hay) return saldoSinFoto('sin_tabla', latidos, pendientes);

      const ult: FotoCruda | undefined = await trx('analytics.caos_cash_counts')
        .where({ tenant_id: tenantId })
        .orderBy([{ column: 'after_external_id', order: 'desc' }, { column: 'captured_at', order: 'desc' }])
        .first('id', 'device', 'after_external_id', 'captured_at', 'confirmed_at', 'online', 'any_miscount', 'total');
      if (!ult) return saldoSinFoto('sin_foto', latidos, pendientes);

      const lineas: LineaCruda[] = await trx('analytics.caos_cash_count_lines')
        .where({ tenant_id: tenantId, count_id: ult.id })
        .orderBy([{ column: 'container_kind', order: 'desc' }, { column: 'container_index' }])
        .select('container_kind', 'container_index', 'denom', 'quantity', 'miscount');

      // Las fotos de los últimos 30 días, para el cuadre continuo (con tope: ~10 por día).
      const fotosCrudas: { id: string; after_external_id: string; captured_at: Date; denom: string; q: string }[] =
        await trx.raw(`
          WITH f AS (
            SELECT id, after_external_id, captured_at FROM analytics.caos_cash_counts
             WHERE tenant_id = ? AND device = ? AND captured_at >= now() - interval '30 days'
             ORDER BY after_external_id DESC, captured_at DESC LIMIT 400)
          SELECT f.id, f.after_external_id, f.captured_at, l.denom::text AS denom, sum(l.quantity)::text AS q
            FROM f LEFT JOIN analytics.caos_cash_count_lines l ON l.tenant_id = ? AND l.count_id = f.id
           GROUP BY f.id, f.after_external_id, f.captured_at, l.denom`,
        [tenantId, ult.device, tenantId]).then((r: { rows: never[] }) => r.rows);
      const fotos = new Map<string, CaosFoto>();
      for (const r of fotosCrudas) {
        const f = fotos.get(r.id) ?? { id: r.id, after_external_id: Number(r.after_external_id), captured_at: r.captured_at, por_denominacion: {} };
        if (r.denom != null) f.por_denominacion[String(Number(r.denom))] = Number(r.q);
        fotos.set(r.id, f);
      }
      const desdeId = Math.min(...[...fotos.values()].map((f) => f.after_external_id), Number(ult.after_external_id));

      // Los movimientos desde la foto más vieja del cuadre, con su desglose.
      const movsCrudos: { external_id: string; type_id: number; total: string; occurred_at: Date; denom: string | null; q: string | null }[] =
        await trx.raw(`
          SELECT m.external_id, m.type_id, m.total::text AS total, m.occurred_at,
                 d.denom::text AS denom, d.quantity::text AS q
            FROM analytics.caos_cash_movements m
            LEFT JOIN analytics.caos_cash_denominations d ON d.tenant_id = m.tenant_id AND d.movement_id = m.id
           WHERE m.tenant_id = ? AND m.device = ? AND m.external_id > ?
           ORDER BY m.external_id`,
        [tenantId, ult.device, desdeId]).then((r: { rows: never[] }) => r.rows);
      const movs = new Map<number, CaosMovDenom & { occurred_at: Date }>();
      for (const r of movsCrudos) {
        const id = Number(r.external_id);
        const m = movs.get(id) ?? { external_id: id, type_id: Number(r.type_id), total: Number(r.total), occurred_at: r.occurred_at, por_denominacion: {} };
        if (r.denom != null) m.por_denominacion[String(Number(r.denom))] = (m.por_denominacion[String(Number(r.denom))] ?? 0) + Number(r.q);
        movs.set(id, m);
      }
      const listaMovs = [...movs.values()];

      // La foto vale por sí sola; lo que entró DESPUÉS de tomarla se suma y se dice.
      const base: Vector = {};
      for (const l of lineas) base[String(Number(l.denom))] = (base[String(Number(l.denom))] ?? 0) + Number(l.quantity);
      const despues = listaMovs.filter((m) => m.external_id > Number(ult.after_external_id));
      const { vector, ambiguos } = aplicarMovimientos(base, despues);

      const pares = cuadrarFotos([...fotos.values()], listaMovs);
      const ultimoMov = listaMovs.length ? listaMovs[listaMovs.length - 1] : null;

      return {
        estado: 'medido',
        maquina: {
          tomada_at: ult.captured_at,
          confirmada_at: ult.confirmed_at,
          tras_movimiento: Number(ult.after_external_id),
          online: ult.online,
          con_miscount: ult.any_miscount,
          total: Number(ult.total),
          por_denominacion: aFilas(base),
          contenedores: lineas.map((l) => ({
            tipo: l.container_kind, indice: Number(l.container_index), denom: Number(l.denom),
            billetes: Number(l.quantity), miscount: Boolean(l.miscount),
          })),
        },
        posteriores: {
          movimientos: despues.length,
          neto: Math.round((importeDeVector(vector) - importeDeVector(base)) * 100) / 100,
          ambiguos,
          ultimo_at: ultimoMov?.occurred_at ?? null,
        },
        saldo: {
          total: importeDeVector(vector),
          por_denominacion: aFilas(vector),
          // 'maquina' = la foto ya contiene todo; 'foto_mas_movimientos' = se le sumaron flujos.
          origen: despues.length ? 'foto_mas_movimientos' : 'maquina',
          parcial: ambiguos.length > 0,
        },
        cuadre: {
          pares: pares.length,
          cuadran: pares.filter((p) => p.estado === 'cuadra').length,
          descuadres: pares.filter((p) => p.estado === 'descuadre'),
          no_verificables: pares.filter((p) => p.estado === 'no_verificable'),
        },
        conteo_fisico: {
          medido: false,
          motivo: 'Ningún dato registra un conteo a mano de la máquina. Lo cierra contar a ciegas lo que salga en el próximo «Vaciar Stocks».',
        },
        latido,
        latidos,
        pendientes,
      };
    });
  }

  /**
   * `[CGA-A.41]` Desde cuándo se registra CAOS en Caja General: el día (México) del primer
   * movimiento que tiene folio. DERIVADO, no escrito a mano — medido 2026-10-09. `null` si
   * nunca se registró ninguno (y entonces «sin registrar» no se puede medir: se declara).
   */
  private async registroDesde(trx: Knex, tenantId: string): Promise<string | null> {
    const r = await trx.raw(
      `SELECT min((m.occurred_at AT TIME ZONE 'America/Mexico_City')::date)::text AS d
         FROM analytics.caos_cash_movements m
        WHERE m.tenant_id = ? AND m.type_id IN (0, 4) AND ${sqlFolioCajaGeneral('m')} IS NOT NULL`,
      [tenantId],
    );
    return r.rows?.[0]?.d ?? null;
  }

  /** `[CGA-A.41]` Lo que falta registrar en Caja General, desde `registroDesde`. */
  private async pendientes(trx: Knex, tenantId: string): Promise<CaosPendientes> {
    const desde = await this.registroDesde(trx, tenantId);
    if (!desde) return { medido: false, desde: null, movimientos: 0, monto: 0, depositos: { n: 0, monto: 0 }, dispensaciones: { n: 0, monto: 0 }, mas_viejo: null };
    const r = await trx.raw(
      `SELECT count(*)::int AS n, coalesce(sum(total), 0)::text AS monto,
              count(*) FILTER (WHERE type_id = 0)::int AS dep_n,
              coalesce(sum(total) FILTER (WHERE type_id = 0), 0)::text AS dep_monto,
              count(*) FILTER (WHERE type_id = 4)::int AS dis_n,
              coalesce(sum(total) FILTER (WHERE type_id = 4), 0)::text AS dis_monto,
              min(occurred_at) AS mas_viejo
         FROM analytics.caos_cash_movements m
        WHERE m.tenant_id = ? AND m.type_id IN (0, 4) AND m.occurred_at >= ?
          AND ${sqlFolioCajaGeneral('m')} IS NULL`,
      [tenantId, desde],
    );
    const x = r.rows[0];
    return {
      medido: true, desde, movimientos: Number(x.n), monto: Number(x.monto),
      depositos: { n: Number(x.dep_n), monto: Number(x.dep_monto) },
      dispensaciones: { n: Number(x.dis_n), monto: Number(x.dis_monto) },
      mas_viejo: x.mas_viejo ?? null,
    };
  }

  /**
   * ⭐ `[CGA-A.33]` Los latidos de los TRES carriles de CAOS, en una sola lectura barata.
   *
   * ⛔ Por qué viajan acá y no en cada panel: el carril de atribución (`caos_ingreso_conciliar`)
   * estaba en `error` el 2026-10-20 y `finance.caos_ingreso_atribucion` tenía **0 filas en toda
   * su vida** — pero el panel que lo declara nace PLEGADO y sólo pide su estado al abrirse. Plegar
   * no es esconder (estándar §2.1): la pantalla tiene que poder avisar con el panel cerrado.
   */
  private async latidos(trx: Knex, tenantId: string): Promise<CaosLatidos> {
    const filas: { job_key: string; cuando: string | null; al: Date | null; status: string; note: string | null; error: string | null }[] =
      await trx('analytics.cron_runs')
        .where({ tenant_id: tenantId })
        .whereIn('job_key', ['caos_movimientos', 'caos_conteo', 'caos_ingreso_conciliar'])
        .select(
          'job_key',
          trx.raw(`to_char(last_finish AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS cuando`),
          trx.raw('last_finish AS al'),
          'status', 'note', 'error',
        );
    const de = (k: string): CaosLatidoConteo | null => {
      const l = filas.find((f) => f.job_key === k);
      return l ? { cuando: l.cuando ?? null, al: l.al ?? null, status: l.status, nota: l.note ?? null, error: l.error ?? null } : null;
    };
    return { movimientos: de('caos_movimientos'), conteo: de('caos_conteo'), atribucion: de('caos_ingreso_conciliar') };
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

  /**
   * ⭐ `[CGA-A.57]` A qué movimientos de Caja General se vinculó un movimiento de CAOS, y cuánto
   * tomó cada uno. Edgar, 2026-10-28: *«¿dónde puedo visualizar los movimientos que se vincularon
   * a cada movimiento de CAOS? sólo como supervisor»*.
   *
   * ⛔ La columna «Caja General» del reporte da UN folio (`sqlFolioCajaGeneral`, `LIMIT 1`): el
   * retiro 1775 pagó 20 egresos y decía sólo `CG-2026-00512`. Esto publica TODOS, y lo libre.
   *
   * ⚠️ Un movimiento que NACIÓ en la máquina (`origen_tipo='caos'`) también sale: es la otra forma
   * de que Caja General lo explique, y omitirlo haría ver «sin vincular» a uno registrado.
   */
  async vinculos(id: string): Promise<CaosVinculos | null> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const mov = await trx('analytics.caos_cash_movements')
        .where({ tenant_id: tenantId, id })
        .first('id', 'device', 'external_id', 'type_id', 'total');
      if (!mov) return null;
      const enlaces = await trx('finance.caos_cash_links as k')
        .join('finance.cash_ledger as l', 'l.id', 'k.cash_ledger_id')
        .where({ 'k.tenant_id': tenantId, 'k.caos_device': mov.device, 'k.caos_external_id': mov.external_id })
        .whereNull('k.deleted_at').whereNull('l.deleted_at')
        .orderBy([{ column: 'k.created_at', order: 'asc' }, { column: 'l.folio', order: 'asc' }])
        .select('k.id as link_id', 'l.id as cash_ledger_id', 'l.folio', 'l.tipo', 'l.fecha', 'l.monto', 'l.estado',
          'k.monto_enlazado', 'k.created_at as vinculado_at',
          trx.raw(`'vinculo' AS via`));
      const nacidos = await trx('finance.cash_ledger as l')
        .where({ 'l.tenant_id': tenantId, 'l.origen_tipo': 'caos', 'l.origen_ref': `${mov.device}|${mov.external_id}` })
        .whereNull('l.deleted_at')
        .select(trx.raw('NULL::uuid AS link_id'), 'l.id as cash_ledger_id', 'l.folio', 'l.tipo', 'l.fecha', 'l.monto', 'l.estado',
          'l.monto as monto_enlazado', 'l.created_at as vinculado_at',
          trx.raw(`'nacio_en_la_maquina' AS via`));
      // node-pg entrega `numeric` como TEXTO y `timestamptz` como Date: el crudo lo declara asi y
      // aca se convierte UNA vez, para que nadie sume dos textos y publique un total que se lee
      // igual que uno correcto.
      type FilaCruda = Omit<CaosVinculoFila, 'monto' | 'monto_enlazado' | 'fecha' | 'vinculado_at'> & {
        monto: string | number; monto_enlazado: string | number; fecha: string | Date; vinculado_at: string | Date;
      };
      const filas: CaosVinculoFila[] = ([...nacidos, ...enlaces] as FilaCruda[]).map((r) => ({
        ...r,
        fecha: String(r.fecha), vinculado_at: String(r.vinculado_at),
        monto: Number(r.monto), monto_enlazado: Number(r.monto_enlazado),
      }));
      // Lo cancelado se publica (se ve que existió) pero no consume el movimiento.
      const vivos = filas.filter((r) => r.estado !== 'cancelado');
      const total = Math.abs(Number(mov.total));
      const vinculado = Math.round(vivos.reduce((a, r) => a + r.monto_enlazado, 0) * 100) / 100;
      return {
        movimiento_id: mov.id, external_id: Number(mov.external_id), total,
        vinculado, libre: Math.round((total - vinculado) * 100) / 100,
        filas,
      };
    });
  }

  /**
   * ⭐ `[CGA-A.58]` Corregir un vínculo es de SUPERADMIN, no de admin (Edgar, 2026-10-28: *«permiso
   * sólo superadmin»*). El guard deja pasar a los dos por god-mode, así que aquí se exige el rol
   * exacto sobre los roles FRESCOS de la base (`roles_frescos`), no sobre el JWT.
   */
  private exigeSuperadmin(user: ActorCaos): void {
    const roles = (user.roles_frescos ?? []).map((r) => String(r).toLowerCase());
    if (!roles.includes('superadmin')) {
      throw new ForbiddenException('Corregir un vínculo de CAOS es sólo de superadmin.');
    }
  }

  /**
   * `[CGA-A.58]` Da de BAJA un vínculo (no lo borra): queda quién, cuándo y por qué, y el
   * movimiento de CAOS recupera ese monto como libre para volver a vincularlo o registrarlo.
   *
   * ⚠️ El esperado del corte no se mueve (`[CG.96]`: sale de los movimientos de la máquina, no del
   * vínculo). Lo que cambia es `en_boveda` del movimiento de Caja General, que es lo que se muestra.
   */
  async quitarVinculo(linkId: string, motivo: string, user: ActorCaos): Promise<CaosVinculoBaja> {
    this.exigeSuperadmin(user);
    const tenantId = this.tenantCtx.requireTenantId();
    const m = String(motivo ?? '').trim();
    if (m.length < 10) throw new BadRequestException('Di por qué se quita el vínculo (mínimo 10 caracteres).');
    return this.tk.run(async (trx) => {
      const k = await trx('finance.caos_cash_links').where({ tenant_id: tenantId, id: linkId }).first('id', 'deleted_at');
      if (!k) throw new NotFoundException('Ese vínculo no existe.');
      if (k.deleted_at) throw new ConflictException('Ese vínculo ya se había quitado.');
      await trx('finance.caos_cash_links').where({ tenant_id: tenantId, id: linkId })
        .update({ deleted_at: trx.fn.now(), updated_at: trx.fn.now(), deleted_by: user.id, motivo_baja: m });
      return { ok: true, link_id: linkId };
    });
  }

  /**
   * `[CGA-A.58]` Vincula un movimiento de Caja General YA GUARDADO a un movimiento de CAOS. Hasta
   * hoy el vínculo sólo nacía al capturar; corregir uno exigía SQL a mano (así se vincularon los 10
   * cobros de ruta del 28-oct).
   *
   * Reglas, cada una con su mensaje:
   *  · depósito (type 0) ↔ ingreso · retiro (type 4) ↔ egreso. Al revés no tiene sentido de dinero.
   *  · Un movimiento que NACIÓ en la máquina ya está explicado entero: no se le agrega vínculo.
   *  · Un egreso que dice que salió del CAJÓN no se vincula a un retiro: es uno u otro, como en la
   *    captura. Ese error se corrige en el egreso, no aquí.
   *  · El monto no pasa de lo que le falta al movimiento ni de lo libre de CAOS (esto último lo
   *    exige además `trg_caos_link_no_excede`).
   */
  async vincular(movId: string, body: { folio?: string; monto?: number }, user: ActorCaos): Promise<CaosVinculoAlta> {
    this.exigeSuperadmin(user);
    const tenantId = this.tenantCtx.requireTenantId();
    const folio = String(body?.folio ?? '').trim().toUpperCase();
    const monto = Math.round(Number(body?.monto) * 100) / 100;
    if (!folio) throw new BadRequestException('Falta el folio de Caja General.');
    if (!(monto > 0)) throw new BadRequestException('El monto a vincular tiene que ser mayor que cero.');
    return this.tk.run(async (trx) => {
      const mov = await trx('analytics.caos_cash_movements').where({ tenant_id: tenantId, id: movId })
        .first('device', 'external_id', 'type_id', 'total');
      if (!mov) throw new NotFoundException('Ese movimiento de CAOS no existe.');
      const l = await trx('finance.cash_ledger').where({ tenant_id: tenantId, folio }).whereNull('deleted_at')
        .first('id', 'folio', 'tipo', 'monto', 'estado', 'origen_tipo', 'origen_efectivo');
      if (!l) throw new NotFoundException(`No hay un movimiento de Caja General con folio ${folio}.`);
      const linkId = await this.altaVinculo(trx, tenantId, l, mov, monto,
        { manual: true, via: 'correccion_superadmin', por: user.username ?? null }, user);
      return { ok: true, link_id: linkId, folio, monto };
    });
  }

  /**
   * `[CGA-A.58]`→`[CGA-A.61]` Las reglas de UN vínculo nuevo, dentro de la transacción de quien lo
   * pide. Las comparten el alta suelta (`vincular`), el lote de la reposición (`vincularLote`) y
   * «cambiar de retiro» (`moverVinculo`): una regla, no tres copias que se separan con el tiempo.
   *
   * `ampliar`: si el egreso YA tiene un vínculo vivo con ese retiro, el índice
   * `ux_caos_link_par_vivo` no deja un segundo. Entonces el viejo se da de BAJA (con motivo, queda
   * su historia) y nace uno por la suma. Así cayó la propuesta de Morelia: CG-2026-00532 ya tenía
   * $4,290 de «gnf 26/10» y le faltaban $4,575 del mismo retiro.
   */
  private async altaVinculo(
    trx: Knex.Transaction,
    tenantId: string,
    l: { id: string; folio: string; tipo: string; monto: string | number; estado: string; origen_tipo: string | null; origen_efectivo: string | null },
    mov: { device: string; external_id: string | number; type_id: string | number },
    monto: number,
    senales: Record<string, unknown>,
    user: ActorCaos,
    opts: { ampliar?: boolean } = {},
  ): Promise<string> {
    const folio = l.folio;
    const tipoEsperado = Number(mov.type_id) === 0 ? 'ingreso' : Number(mov.type_id) === 4 ? 'gasto' : null;
    if (!tipoEsperado) throw new BadRequestException('Sólo los depósitos y los retiros se vinculan a Caja General.');
    if (l.estado === 'cancelado') throw new BadRequestException(`${folio} está cancelado.`);
    if (l.tipo !== tipoEsperado) {
      throw new BadRequestException(`${folio} es ${l.tipo === 'gasto' ? 'un egreso' : `un ${l.tipo}`}: un ${Number(mov.type_id) === 0 ? 'depósito' : 'retiro'} de CAOS sólo se vincula a ${tipoEsperado === 'gasto' ? 'un egreso' : 'un ingreso'}.`);
    }
    if (l.origen_tipo === 'caos') throw new BadRequestException(`${folio} se registró desde CAOS: ya está explicado entero.`);
    if (l.tipo === 'gasto' && l.origen_efectivo === 'cajon') {
      throw new BadRequestException(`${folio} dice que salió del cajón. Si salió de CAOS, eso se corrige en el egreso.`);
    }
    const [{ ya }] = await trx('finance.caos_cash_links').where({ tenant_id: tenantId, cash_ledger_id: l.id })
      .whereNull('deleted_at').select(trx.raw('coalesce(sum(monto_enlazado),0)::numeric AS ya'));
    const falta = Math.round((Number(l.monto) - Number(ya)) * 100) / 100;
    if (monto > falta + 0.005) {
      throw new BadRequestException(`A ${folio} sólo le faltan $${falta.toFixed(2)} por explicar.`);
    }
    let total = monto;
    if (opts.ampliar) {
      const previo = await trx('finance.caos_cash_links')
        .where({ tenant_id: tenantId, cash_ledger_id: l.id, caos_device: mov.device, caos_external_id: mov.external_id })
        .whereNull('deleted_at').first('id', 'monto_enlazado');
      if (previo) {
        total = Math.round((Number(previo.monto_enlazado) + monto) * 100) / 100;
        await trx('finance.caos_cash_links').where({ tenant_id: tenantId, id: previo.id }).update({
          deleted_at: trx.fn.now(), updated_at: trx.fn.now(), deleted_by: user.id,
          motivo_baja: `[CGA-A.61] se amplía de $${Number(previo.monto_enlazado).toFixed(2)} a $${total.toFixed(2)} en la reposición`,
        });
      }
    }
    try {
      const [k] = await trx('finance.caos_cash_links').insert({
        tenant_id: tenantId, cash_ledger_id: l.id, caos_device: mov.device, caos_external_id: mov.external_id,
        monto_enlazado: total, senales: JSON.stringify(senales), confirmed_by: user.id,
      }).returning('id');
      return (k?.id ?? k) as string;
    } catch (e: unknown) {
      const err = e as { code?: string; constraint?: string };
      if (err.code === '23505') throw new ConflictException(`${folio} ya está vinculado a este movimiento de CAOS.`);
      // `trg_caos_link_no_excede` dice cuál candado fue: cada uno se dice con su nombre, y con el folio.
      const porCandado: Record<string, string> = {
        caos_link_excede_movimiento: `${folio}: el movimiento de CAOS no tiene libre ese monto.`,
        caos_link_excede_captura: `Con ese monto, ${folio} quedaría explicado de más.`,
        caos_link_custodia_cerrada: `${folio}: ese retiro tiene una custodia cerrada, ya no se puede vincular.`,
      };
      const porConstraint = err.constraint ? porCandado[err.constraint] : undefined;
      if (err.code === '23514' && porConstraint) throw new ConflictException(porConstraint);
      throw e;
    }
  }

  /**
   * ⭐ `[CGA-A.61]` La propuesta de la reposición, confirmada: varios vínculos en UNA transacción.
   * Edgar, 2026-10-28: *«hagámoslo, pero desde una sola interfaz»* — los 10 egresos de Canindo del
   * 27/10 eran diez altas sueltas tecleando folio y monto.
   *
   * ⛔ **Todo o nada**, a propósito: la propuesta se calculó como un conjunto (cada retiro se llena en
   * orden); aplicarla a medias dejaría un reparto que nadie propuso. Si uno no pasa, no se guarda
   * ninguno y el mensaje dice cuál y por qué.
   */
  async vincularLote(body: VincularLoteInput, user: ActorCaos): Promise<VincularLoteResultado> {
    this.exigeSuperadmin(user);
    const tenantId = this.tenantCtx.requireTenantId();
    const lista = Array.isArray(body?.asignaciones) ? body.asignaciones : [];
    if (!lista.length) throw new BadRequestException('No hay vínculos que guardar.');
    if (lista.length > 300) throw new BadRequestException('Son demasiados vínculos de una vez (máximo 300).');
    const limpias = lista.map((a) => ({
      ledger_id: String(a?.ledger_id ?? ''), device: String(a?.device ?? ''),
      external_id: Number(a?.external_id), monto: Math.round(Number(a?.monto) * 100) / 100,
    }));
    if (limpias.some((a) => !a.ledger_id || !a.device || !Number.isFinite(a.external_id) || !(a.monto > 0))) {
      throw new BadRequestException('Cada vínculo lleva egreso, retiro y un monto mayor que cero.');
    }
    const motivo = String(body?.motivo ?? '').trim() || null;
    return this.tk.run(async (trx) => {
      let monto = 0;
      for (const a of limpias) {
        const mov = await trx('analytics.caos_cash_movements')
          .where({ tenant_id: tenantId, device: a.device, external_id: a.external_id })
          .first('device', 'external_id', 'type_id');
        if (!mov) throw new NotFoundException(`El retiro ${a.external_id} no existe en CAOS.`);
        const l = await trx('finance.cash_ledger').where({ tenant_id: tenantId, id: a.ledger_id }).whereNull('deleted_at')
          .first('id', 'folio', 'tipo', 'monto', 'estado', 'origen_tipo', 'origen_efectivo');
        if (!l) throw new NotFoundException('Uno de los egresos ya no existe en Caja General.');
        await this.altaVinculo(trx, tenantId, l, mov, a.monto,
          { manual: true, via: 'reposicion', por: user.username ?? null, motivo }, user, { ampliar: true });
        monto += a.monto;
      }
      return { ok: true, vinculos: limpias.length, monto: Math.round(monto * 100) / 100 };
    });
  }

  /**
   * ⭐ `[CGA-A.61]` Pasar un vínculo a OTRO retiro: la baja (con motivo) y el alta, juntas. Era el
   * caso de CG-2026-00512: quitarlo en un movimiento de CAOS y volverlo a vincular en otro, a mano.
   *
   * El destino toma lo que tenía el vínculo mientras le alcance (`tomaDelRetiro`, la misma regla del
   * lote); lo que no alcance queda sin explicar y se dice. Si el destino no tiene nada libre, no se
   * hace nada (la baja tampoco: es una sola transacción).
   */
  async moverVinculo(linkId: string, body: MoverVinculoInput, user: ActorCaos): Promise<MoverVinculoResultado> {
    this.exigeSuperadmin(user);
    const tenantId = this.tenantCtx.requireTenantId();
    const motivo = String(body?.motivo ?? '').trim();
    if (motivo.length < 10) throw new BadRequestException('Di por qué se cambia de retiro (mínimo 10 caracteres).');
    const destino = { device: String(body?.device ?? ''), external_id: Number(body?.external_id) };
    if (!destino.device || !Number.isFinite(destino.external_id)) throw new BadRequestException('Falta el retiro destino.');
    return this.tk.run(async (trx) => {
      const k = await trx('finance.caos_cash_links').where({ tenant_id: tenantId, id: linkId })
        .first('id', 'cash_ledger_id', 'caos_device', 'caos_external_id', 'monto_enlazado', 'deleted_at');
      if (!k) throw new NotFoundException('Ese vínculo no existe.');
      if (k.deleted_at) throw new ConflictException('Ese vínculo ya se había quitado.');
      if (k.caos_device === destino.device && Number(k.caos_external_id) === destino.external_id) {
        throw new BadRequestException('El vínculo ya es de ese retiro.');
      }
      const mov = await trx('analytics.caos_cash_movements as m')
        .where({ 'm.tenant_id': tenantId, 'm.device': destino.device, 'm.external_id': destino.external_id })
        .first('m.device', 'm.external_id', 'm.type_id', trx.raw(`${sqlDisponibleCaos('m')} AS libre`));
      if (!mov) throw new NotFoundException(`El retiro ${destino.external_id} no existe en CAOS.`);
      const l = await trx('finance.cash_ledger').where({ tenant_id: tenantId, id: k.cash_ledger_id }).whereNull('deleted_at')
        .first('id', 'folio', 'tipo', 'monto', 'estado', 'origen_tipo', 'origen_efectivo');
      if (!l) throw new NotFoundException('El movimiento de Caja General de ese vínculo ya no existe.');
      const antes = Math.round(Number(k.monto_enlazado) * 100) / 100;
      const toma = tomaDelRetiro(antes, Number(mov.libre));
      if (toma <= 0) throw new ConflictException(`El retiro ${destino.external_id} no tiene dinero libre.`);
      await trx('finance.caos_cash_links').where({ tenant_id: tenantId, id: linkId }).update({
        deleted_at: trx.fn.now(), updated_at: trx.fn.now(), deleted_by: user.id,
        motivo_baja: `${motivo} (se pasa al retiro ${destino.external_id})`,
      });
      const alta = await this.altaVinculo(trx, tenantId, l, mov, toma,
        { manual: true, via: 'mover', por: user.username ?? null, desde: Number(k.caos_external_id), motivo }, user, { ampliar: true });
      return { ok: true, link_baja: linkId, link_alta: alta, monto: toma, queda: Math.round((antes - toma) * 100) / 100 };
    });
  }
}

/** `[CGA-A.58]` Quien corrige: lo que `RolesGuard` deja en el request. */
export interface ActorCaos { id?: string; username?: string; roles_frescos?: string[] }
