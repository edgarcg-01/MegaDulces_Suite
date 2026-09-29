import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

/**
 * [IC.0] El descuadre del conteo físico de Kepler, visible.
 *
 * Kepler hace el inventario completo cada trimestre y emite el ajuste. El dato existe desde
 * nov-2025 y **no se ve en ninguna pantalla**: medido en sep-2026, $6.60M de sobrante contra
 * $2.26M de faltante sobre $34.1M contados, con el sobrante entre 6.5% y 31% del valor
 * contado según la sucursal. No falta información: falta dónde mirarla.
 *
 * Lee de `analytics.v_erp_physical_count_variance` (derivada del ODS, cero importers).
 *
 * ── Dos cosas que este servicio NO puede dejar de declarar ──────────────────────────────
 *
 * 1. **Una carga inicial no es un descuadre.** Cuando una sucursal migra de Wincaja a Kepler
 *    emite, el día antes del corte, una captura y una entrada que cuadran línea por línea con
 *    faltante cero. Son **$30.8M** en el histórico. Se excluyen del descuadre por default y
 *    se informan aparte — mezclarlos convierte cualquier promedio en ruido.
 *
 * 2. **La cobertura.** El trimestral deja fuera SKUs con existencia (4,022 en sep-2026, entre
 *    7% y 31% por sucursal). Un tablero que muestre sólo lo contado se lee como si eso fuera
 *    todo el almacén. Ver `coverage()`.
 */
@Injectable()
export class InventoryVarianceService {
  private readonly logger = new Logger(InventoryVarianceService.name);

  constructor(private readonly tk: TenantKnexService) {}

  /**
   * Resumen por evento de conteo: una fila por (almacén, fecha), con su descuadre.
   * `include_initial_load` existe para poder VER las cargas iniciales, no para mezclarlas:
   * vienen con `tipo_evento` y el consumidor las pinta distinto.
   */
  async summary(params: {
    warehouse_id?: string;
    date_from?: string;
    date_to?: string;
    include_initial_load?: boolean;
  }) {
    return this.tk.run(async (knex) => {
      const q = knex('analytics.v_erp_physical_count_variance as v')
        .select(
          'v.warehouse_id',
          'v.warehouse_code',
          'v.warehouse_name',
          'v.fecha',
          'v.tipo_evento',
          knex.raw("count(*) filter (where v.signo = 'sobrante')::int as skus_sobrante"),
          knex.raw("count(*) filter (where v.signo = 'faltante')::int as skus_faltante"),
          knex.raw("coalesce(round(sum(v.importe) filter (where v.signo = 'sobrante'), 2), 0) as pesos_sobrante"),
          knex.raw("coalesce(round(sum(v.importe) filter (where v.signo = 'faltante'), 2), 0) as pesos_faltante"),
          knex.raw("coalesce(round(sum(case when v.signo = 'sobrante' then v.importe else -v.importe end), 2), 0) as pesos_neto"),
        )
        .groupBy('v.warehouse_id', 'v.warehouse_code', 'v.warehouse_name', 'v.fecha', 'v.tipo_evento')
        .orderBy([{ column: 'v.fecha', order: 'desc' }, { column: 'v.warehouse_code' }]);

      if (!params.include_initial_load) q.where('v.tipo_evento', 'conteo');
      if (params.warehouse_id) q.where('v.warehouse_id', params.warehouse_id);
      if (params.date_from) q.where('v.fecha', '>=', params.date_from);
      if (params.date_to) q.where('v.fecha', '<=', params.date_to);

      const rows = await q;
      return rows.map((r: Record<string, unknown>) => ({
        ...r,
        // El % se calcula sobre lo que se contó, no sobre el total del almacén: es la
        // pregunta que el supervisor hace ("de lo que conté, cuánto bailó").
        pesos_sobrante: Number(r['pesos_sobrante']),
        pesos_faltante: Number(r['pesos_faltante']),
        pesos_neto: Number(r['pesos_neto']),
      }));
    });
  }

  /** Detalle SKU por SKU de un evento (almacén + fecha). Es la lista accionable. */
  async detail(params: {
    warehouse_id: string;
    fecha: string;
    signo?: 'sobrante' | 'faltante';
    limit?: number;
  }) {
    const limit = Math.min(Math.max(Number(params.limit) || 200, 1), 2000);
    return this.tk.run(async (knex) => {
      const q = knex('analytics.v_erp_physical_count_variance as v')
        .select(
          'v.sku', 'v.product_id', 'v.descripcion', 'v.unidad_erp', 'v.signo',
          'v.cantidad', 'v.costo_unitario', 'v.importe', 'v.folio',
          'v.kepler_sucursal', 'v.kepler_almacen', 'v.tipo_evento',
        )
        .where('v.warehouse_id', params.warehouse_id)
        .andWhere('v.fecha', params.fecha)
        .orderBy('v.importe', 'desc')
        .limit(limit);
      if (params.signo) q.andWhere('v.signo', params.signo);
      return q;
    });
  }

  /**
   * ⛔ LA COBERTURA — lo que el conteo NO tocó.
   *
   * Sin esto el tablero miente por omisión: muestra el descuadre de lo contado y el lector
   * asume que eso es el almacén. Medido en sep-2026: entre 192 y 923 SKUs **con existencia**
   * quedaron fuera por sucursal.
   *
   * ⚠️ Se compara contra la existencia de HOY (`v_erp_stock_on_hand`), no contra la del día
   * del conteo — el ODS no guarda historia de saldos. Para un conteo reciente es una buena
   * aproximación; para uno viejo es orientativo, y por eso se devuelve `dias_desde_conteo`
   * en vez de dejar que el número se lea con la misma confianza en los dos casos.
   */
  async coverage(params: { warehouse_id: string; fecha: string }) {
    return this.tk.run(async (knex) => {
      const { rows } = await knex.raw(
        `WITH contado AS (
           SELECT DISTINCT v.sku
             FROM analytics.v_erp_physical_count_variance v
            WHERE v.warehouse_id = ? AND v.fecha = ?
         ),
         -- La captura incluye SKUs que NO descuadraron y por eso no están en la vista de
         -- varianza. Para la cobertura hace falta el universo CONTADO, no el DESCUADRADO.
         capturado AS (
           SELECT DISTINCT btrim(l.c8) AS sku
             FROM kepler_ods.kdm1 m
             JOIN kepler_ods.kdm2 l
               ON l.sucursal = m.sucursal AND l.c1 = m.c1 AND l.c2 = m.c2 AND l.c3 = m.c3
              AND l.c4 = m.c4 AND l.c5 = m.c5 AND l.c6 = m.c6
             JOIN commercial.warehouses w
               ON w.kepler_code = m.sucursal AND w.id = ? AND w.deleted_at IS NULL
            WHERE m.c2 = 'N' AND m.c3 = 'A' AND m.c4 = '45' AND m.c9::date = ?
              -- ⛔ ANTI-RÉPLICA, igual que en la vista: la sucursal 03 arrastra 220 cabeceras
              -- del almacén 02. Sin esto la cobertura de 8ESQ cuenta como "contados" SKUs
              -- que se contaron en La Piedad — y la cobertura queda inflada justo en la
              -- pantalla que existe para declarar lo que NO se contó.
              -- Faltaba acá cuando ya estaba en la vista y en el KPI: un filtro que se
              -- aplica en dos de tres lugares es peor que no aplicarlo, porque las cifras
              -- se contradicen entre sí sin que nada falle.
              AND (m.c1 = m.sucursal OR m.c1 LIKE m.sucursal || '-%')
         )
         SELECT count(*) FILTER (WHERE s.sku IN (SELECT sku FROM capturado))::int AS contados,
                count(*) FILTER (WHERE s.sku NOT IN (SELECT sku FROM capturado))::int AS sin_contar,
                count(*)::int AS con_existencia,
                (SELECT count(*) FROM contado)::int AS con_diferencia,
                (current_date - ?::date) AS dias_desde_conteo
           FROM analytics.v_erp_stock_on_hand s
          WHERE s.warehouse_id = ? AND s.qty_stock_units > 0`,
        [params.warehouse_id, params.fecha, params.warehouse_id, params.fecha,
          params.fecha, params.warehouse_id],
      );
      const r = rows[0] || {};
      const conExistencia = Number(r.con_existencia || 0);
      return {
        ...r,
        pct_cubierto: conExistencia > 0
          ? Number((100 * Number(r.contados || 0) / conExistencia).toFixed(1))
          : null,   // NULL, no 0: "no se pudo medir" no es "cobertura cero"
      };
    });
  }

  /**
   * [IC.8] ⭐ EL KPI DE LA FASE — ¿sirvió?
   *
   * La tesis de IC.5 es que contar un tercio del catálogo cada mes hace que el trimestral de
   * Kepler encuentre menos descuadre. Esto lo mide, y la fase se vuelve **falsable**: si el
   * trimestre siguiente no baja, el parcial no está funcionando y hay que decirlo en vez de
   * seguir contando.
   *
   * ── Las tres cosas que este cálculo NO puede hacer mal ──────────────────────────────────
   *
   * 1. **Excluir cargas iniciales.** Son $30.8M de migraciones de ERP. Mezcladas, cualquier
   *    tendencia es ruido.
   * 2. **Normalizar por lo contado.** Un trimestre donde se contó la mitad tiene la mitad del
   *    descuadre sin haber mejorado nada. Se compara el **% sobre el valor contado**, no los
   *    pesos absolutos.
   * 3. **No comparar peras con manzanas.** Los almacenes entran y salen (Morelia no tiene
   *    conteos, PH tiene uno). Si un período tiene almacenes que el otro no, la comparación
   *    global miente — por eso se devuelve `comparable` y la lista de los que están en ambos.
   */
  async kpi(params: { warehouse_id?: string } = {}) {
    return this.tk.run(async (knex) => {
      const { rows } = await knex.raw(
        `WITH ev AS (
           SELECT v.warehouse_id, v.warehouse_code, v.fecha,
                  sum(CASE WHEN v.signo = 'sobrante' THEN v.importe ELSE 0 END) AS sobrante,
                  sum(CASE WHEN v.signo = 'faltante' THEN v.importe ELSE 0 END) AS faltante
             FROM analytics.v_erp_physical_count_variance v
            WHERE v.tipo_evento = 'conteo'          -- una carga inicial no es descuadre
              AND (?::uuid IS NULL OR v.warehouse_id = ?::uuid)
            GROUP BY 1, 2, 3
         ),
         contado AS (
           -- El denominador: lo que se contó en ese evento. Sin esto, un trimestre con menos
           -- conteo parece una mejora.
           SELECT w.id AS warehouse_id, m.c9::date AS fecha,
                  sum(l.c13::numeric) AS valor_contado
             FROM kepler_ods.kdm1 m
             JOIN kepler_ods.kdm2 l
               ON l.sucursal = m.sucursal AND l.c1 = m.c1 AND l.c2 = m.c2 AND l.c3 = m.c3
              AND l.c4 = m.c4 AND l.c5 = m.c5 AND l.c6 = m.c6
             JOIN commercial.warehouses w
               ON w.kepler_code = m.sucursal AND w.kepler_code <> '00' AND w.deleted_at IS NULL
            WHERE m.c2 = 'N' AND m.c3 = 'A' AND m.c4 = '45'
              AND (m.c1 = m.sucursal OR m.c1 LIKE m.sucursal || '-%')
            GROUP BY 1, 2
         )
         SELECT to_char(ev.fecha, 'YYYY-"T"Q')                    AS periodo,
                count(*)::int                                     AS eventos,
                count(DISTINCT ev.warehouse_code)::int            AS almacenes,
                array_agg(DISTINCT ev.warehouse_code ORDER BY ev.warehouse_code) AS codigos,
                round(sum(ev.sobrante), 2)                        AS sobrante,
                round(sum(ev.faltante), 2)                        AS faltante,
                round(sum(coalesce(c.valor_contado, 0)), 2)       AS valor_contado,
                CASE WHEN sum(coalesce(c.valor_contado, 0)) > 0
                     THEN round(100 * (sum(ev.sobrante) + sum(ev.faltante))
                                / sum(c.valor_contado), 2) END    AS pct_descuadre
           FROM ev LEFT JOIN contado c
             ON c.warehouse_id = ev.warehouse_id AND c.fecha = ev.fecha
          GROUP BY 1 ORDER BY 1`,
        [params.warehouse_id ?? null, params.warehouse_id ?? null],
      );

      // La comparación sólo vale entre períodos con los MISMOS almacenes.
      // ⛔ Un pct > 100 es IMPOSIBLE de leer como "descuadró más de lo que hay": significa
      // que el DENOMINADOR no cubre al numerador. Medido: 2025-T4 da 115.25%, porque en esos
      // conteos la captura venía partida en decenas de folios y el valor capturado que
      // alcanzamos a sumar no cubre todos los SKUs que después se ajustaron.
      // Se MARCA en vez de explicarse sin medirlo, y no se usa para la tendencia: una serie
      // que arranca en un número imposible haría ver una mejora que nadie produjo.
      const periodos = rows.map((r: Record<string, unknown>) => {
        const pct = r['pct_descuadre'] != null ? Number(r['pct_descuadre']) : null;
        return {
          ...r,
          pct_descuadre: pct,
          salvedad: pct != null && pct > 100 ? 'denominador_incompleto' : null,
        };
      });
      let tendencia: Record<string, unknown> | null = null;
      // Sólo períodos con denominador sano entran a la tendencia.
      const sanos = periodos.filter((p) => p.salvedad == null);
      if (sanos.length >= 2) {
        const [prev, ult] = [sanos[sanos.length - 2], sanos[sanos.length - 1]];
        const a = new Set(prev.codigos as string[]);
        const b = new Set(ult.codigos as string[]);
        const comunes = [...b].filter((x) => a.has(x));
        const mismos = comunes.length === a.size && comunes.length === b.size;
        tendencia = {
          de: prev.periodo, a: ult.periodo,
          pct_antes: prev.pct_descuadre, pct_despues: ult.pct_descuadre,
          // NULL, no 0: "no se puede comparar" no es "no cambió".
          delta_pp: (prev.pct_descuadre != null && ult.pct_descuadre != null && mismos)
            ? Number((ult.pct_descuadre - prev.pct_descuadre).toFixed(2)) : null,
          comparable: mismos,
          motivo: mismos ? null
            : `los períodos no tienen los mismos almacenes (${[...a].join(',')} vs ${[...b].join(',')})`,
          almacenes_comunes: comunes,
        };
      }
      return {
        periodos,
        tendencia,
        // Sin al menos dos trimestres con los mismos almacenes, esto todavía no puede
        // responder si la fase sirvió — y decirlo es parte de la respuesta.
        veredicto: tendencia?.comparable
          ? ((tendencia['delta_pp'] as number) < 0 ? 'mejora' : 'sin_mejora')
          : 'sin_base_de_comparacion',
        // Cuántos períodos quedaron fuera por denominador imposible. Si son muchos, el KPI
        // todavía no se puede usar y hay que arreglar la medida antes que el proceso.
        periodos_descartados: periodos.length - sanos.length,
      };
    });
  }

  /**
   * [IC.3b] Reincidencia: qué SKU descuadra una y otra vez, y **si el dinero vuelve**.
   *
   * Lee `analytics.v_sku_count_variance_history` (IC.3), que estaba en prod sin un solo
   * consumidor: su grano es (almacén, SKU), el universo son las CAPTURAS y no los ajustes,
   * y ya declara la tasa como NULL bajo 2 observaciones.
   *
   * ── El eje que hace útil la pantalla, medido antes de elegirlo ─────────────────────────
   *
   * "Descuadra siempre" no dice nada por sí solo. Lo que separa un error de captura de una
   * merma es si el descuadre **se compensa entre conteos**:
   *
   *   retencion = |pesos_neto| / pesos_abs
   *
   * Medido en prod sobre los 6,834 SKUs con 2+ conteos, la distribución es BIMODAL:
   *   · retencion < 0.2  →  1,171 SKUs mueven $6.9M en bruto y dejan $75k netos (1.1%)
   *   · retencion = 1.0  →  3,404 SKUs, el descuadre nunca vuelve
   *   · el valle (0.2-0.8) está plano, ~250-380 SKUs por décima
   *
   * El caso que lo ilustra: el SKU 17063 de La Piedad mueve **$3,318,784** en bruto y su neto
   * es **$558**. Ordenar por dinero bruto lo pone primero y no es mercancía perdida: es la
   * misma cantidad entrando y saliendo. La CAJETA ENVINADA (18022) mueve $147,580 y retiene
   * $137,780 — cien veces menos ruido y veinte veces más pérdida real.
   *
   * ⛔ Los SKUs con menos de 2 conteos NO se clasifican: con una observación no existe la
   * palabra "reincidente". Son 5,809 filas — los almacenes 01 y 06 ENTEROS, que sólo tienen
   * un conteo cada uno. No se filtran en silencio: van en `sin_base`, con su dinero y sus
   * almacenes, porque una pantalla que los esconda se lee como si 01 no tuviera problema
   * (ADR-056).
   */
  async reincidencia(params: {
    warehouse_id?: string;
    patron?: string;
    limit?: number;
  } = {}) {
    // Umbrales MEDIDOS (ver el bloque de arriba), no elegidos: son los bordes del valle de una
    // distribución bimodal. Si el histórico crece y la forma cambia, se vuelven a medir.
    const SE_COMPENSA = 0.2;
    const PERSISTE = 0.8;
    const UN_SOLO_EVENTO = 0.9;
    const MIN_CONTEOS = 2;
    const limit = Math.min(500, Math.max(1, Number(params.limit) || 100));
    const wh = params.warehouse_id;

    // ⛔ El CTE va MATERIALIZED a propósito: sin eso la vista se deriva una vez por cada uno de
    // los tres usos (items, resumen, sin_base) y la consulta pasa de ~0.65 s a varios segundos.
    const sqlHistoria = `
      WITH h AS MATERIALIZED (
        SELECT warehouse_id, warehouse_code, sku, veces_contado, veces_descuadro,
               veces_sobrante, veces_faltante, tasa_descuadre, tasa_motivo,
               pesos_abs, pesos_neto, ultimo_descuadre,
               CASE WHEN pesos_abs = 0 THEN 'sin_dinero'
                    WHEN abs(pesos_neto)/pesos_abs < ${SE_COMPENSA} THEN 'se_compensa'
                    WHEN abs(pesos_neto)/pesos_abs >= ${PERSISTE} AND pesos_neto < 0 THEN 'merma'
                    WHEN abs(pesos_neto)/pesos_abs >= ${PERSISTE} AND pesos_neto > 0 THEN 'sobra'
                    ELSE 'mixto' END AS patron
          FROM analytics.v_sku_count_variance_history
         ${wh ? 'WHERE warehouse_id = ?' : ''}
      ),
      juz AS (SELECT * FROM h WHERE veces_contado >= ${MIN_CONTEOS} AND veces_descuadro > 0)
      SELECT
        (SELECT json_agg(x) FROM (SELECT * FROM juz ${params.patron ? 'WHERE patron = ?' : ''}
           ORDER BY abs(pesos_neto) DESC, veces_descuadro DESC, sku LIMIT ?) x) AS items,
        (SELECT json_agg(r) FROM (SELECT patron, count(*)::int AS skus,
           sum(pesos_abs)::numeric AS pesos_abs, sum(pesos_neto)::numeric AS pesos_neto
           FROM juz GROUP BY patron ORDER BY 2 DESC) r) AS resumen,
        (SELECT row_to_json(s) FROM (SELECT count(*)::int AS skus,
           coalesce(sum(pesos_abs), 0)::numeric AS pesos_abs,
           coalesce(string_agg(DISTINCT warehouse_code, ', ' ORDER BY warehouse_code), '') AS almacenes
           FROM h WHERE veces_contado < ${MIN_CONTEOS}) s) AS sin_base`;
    const bindHistoria = [
      ...(wh ? [wh] : []), ...(params.patron ? [params.patron] : []), limit,
    ];

    // La CONCENTRACIÓN sale de la vista de eventos, no de IC.3 — que no la tiene.
    // ⛔ Va en su propia consulta y NO unida a la anterior: juntarlas en un solo plan hace que
    // el planificador combine dos derivaciones del ODS y la consulta pasa de ~1 s a **83 s**,
    // medido. Separadas y en paralelo, el total es el de la más lenta.
    const sqlConcentracion = `
      SELECT warehouse_id, sku, max(abs(neto_ev)) AS mayor_evento, count(*)::int AS eventos
        FROM (SELECT warehouse_id, sku, fecha,
                     sum(CASE WHEN signo = 'sobrante' THEN importe ELSE -importe END) AS neto_ev
                FROM analytics.v_erp_physical_count_variance
               WHERE tipo_evento = 'conteo' ${wh ? 'AND warehouse_id = ?' : ''}
               GROUP BY 1, 2, 3) e
       GROUP BY 1, 2`;

    const [hist, conc] = await Promise.all([
      this.tk.run(async (knex) => (await knex.raw(sqlHistoria, bindHistoria)).rows[0]),
      this.tk.run(async (knex) => (await knex.raw(sqlConcentracion, wh ? [wh] : [])).rows),
    ]);

    const porSku = new Map<string, { mayor_evento: string; eventos: number }>(
      (conc as { warehouse_id: string; sku: string; mayor_evento: string; eventos: number }[])
        .map((r) => [`${r.warehouse_id}|${r.sku}`, r]),
    );

    type Fila = Record<string, unknown> & { warehouse_id: string; sku: string; pesos_neto: string };
    const items = ((hist?.items as Fila[]) || []).map((r) => {
      const c = porSku.get(`${r.warehouse_id}|${r.sku}`);
      const neto = Math.abs(Number(r.pesos_neto));
      // >= 0.9 significa que UN evento explica casi todo: es un hecho puntual, no una sangría.
      // Puede pasar de 1 cuando hay eventos de signo contrario que se restan en el neto.
      const concentracion = c && neto > 0 ? Number(c.mayor_evento) / neto : null;
      return {
        ...r,
        retencion: Number(r['pesos_abs']) > 0
          ? Math.round((neto / Number(r['pesos_abs'])) * 1e4) / 1e4 : null,
        eventos_con_descuadre: c?.eventos ?? null,
        mayor_evento: c?.mayor_evento ?? null,
        concentracion: concentracion == null ? null : Math.round(concentracion * 1e3) / 1e3,
        // El segundo eje, y el que decide a quién se manda al anaquel. Medido: 3,098 de 4,666
        // SKUs (66%, $5.7M de $7.4M) tienen UN evento que explica el 90%+ de su neto — o sea
        // que "descuadra seguido" y "pierde seguido" son cosas distintas.
        forma: concentracion == null ? 'sin_medir'
          : concentracion >= UN_SOLO_EVENTO ? 'evento_aislado' : 'sostenido',
      };
    });

    return {
      items,
      resumen: hist?.resumen || [],
      min_conteos: MIN_CONTEOS,
      umbrales: { se_compensa: SE_COMPENSA, persiste: PERSISTE, un_solo_evento: UN_SOLO_EVENTO },
      sin_base: {
        ...(hist?.sin_base || { skus: 0, pesos_abs: 0, almacenes: '' }),
        motivo: `menos de ${MIN_CONTEOS} conteos: sin dos observaciones no hay reincidencia que medir`,
      },
    };
  }

  /** Almacenes y fechas con conteo, para poblar los filtros sin adivinar. */
  async events() {
    return this.tk.run(async (knex) =>
      knex('analytics.v_erp_physical_count_variance as v')
        .distinct('v.warehouse_id', 'v.warehouse_code', 'v.warehouse_name', 'v.fecha', 'v.tipo_evento')
        .orderBy([{ column: 'v.fecha', order: 'desc' }, { column: 'v.warehouse_code' }])
        .limit(200),
    );
  }
}
