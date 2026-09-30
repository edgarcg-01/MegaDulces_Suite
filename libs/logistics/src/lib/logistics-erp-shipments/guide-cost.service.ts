import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

/**
 * `[CGU.4]` — **Qué cuesta cada guía de embarque, y de qué pólizas sale ese costo.**
 *
 * Tres niveles, que es el recorrido que pidió el usuario: *"seleccionar la guía, que muestre
 * todos los diferentes tipos de gasto, darle clic y desglosar el gasto"*.
 *
 *   1. `listCosts`        las guías del período con su costo y cuánta dilución tiene
 *   2. `guideBreakdown`   esa guía, concepto por concepto
 *   3. `conceptLines`     ⭐ los RENGLONES DE PÓLIZA reales del bucket, SIN prorratear
 *
 * ── ⛔ Lo que este servicio no puede dejar de decir ───────────────────────────────────
 *
 * **El gasto no existe por guía.** Llega a canal + día, y hay entre 3.7 y 10.9 guías por
 * canal-día. Todo lo que devuelve el nivel 1 y 2 es **atribuido**, y cada fila lleva
 * `origen`, `paradas_guia`, `paradas_bucket` y `n_guias_bucket` para que el humano vea con
 * cuánta dilución se calculó. El nivel 3 es el único que devuelve dinero sin repartir: son
 * las pólizas tal cual, y por eso es el que cierra la pregunta *"¿de dónde sale esto?"*.
 *
 * ⚠️ **Una guía sin gasto devuelve `costo: null`, NUNCA 0.** "No se registró gasto para ese
 * canal ese día" no es "ese viaje fue gratis". Un `COALESCE(costo, 0)` puesto para que no se
 * vea feo produce **ROI infinito** en la pantalla, que es exactamente el modo de falla que
 * esta fase existe para evitar.
 *
 * ⛔ **No se publica margen.** Medido: el embarque `U-D-41` no trae costo de renglón
 * (`kdm2.c62` al **0.76 %**, contra 99.99 % en el ticket de mostrador), y el único costo
 * disponible (`mv_erp_unit_cost`) está en unidad de paquete — el ratio COGS/venta da 1.02 en
 * `PAQ` pero **4.84 en `PZA`** y **3.95 en `KG`**. Publicar margen con eso sería inventar una
 * pérdida del 92 %. Se declara, no se dibuja (ADR-051/057).
 */

const M = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

/** Ventana por defecto: 30 días. La pantalla siempre manda la suya. */
function rango(q: { from?: string; to?: string }) {
  const to = q.to || new Date().toISOString().slice(0, 10);
  const from = q.from
    || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  return { from, to };
}

@Injectable()
export class GuideCostService {
  private readonly logger = new Logger(GuideCostService.name);

  constructor(private readonly tk: TenantKnexService) {}

  /**
   * Nivel 1 — las guías del período con su costo atribuido.
   *
   * ⚠️ `LEFT JOIN` a propósito: una guía que no encontró gasto tiene que APARECER con
   * `costo: null`, no desaparecer de la lista. Si se cayera del resultado, el promedio de la
   * pantalla se calcularía sobre una muestra sesgada (sólo los días que tuvieron gasto) y
   * nadie lo sabría.
   */
  async listCosts(q: { from?: string; to?: string; canal?: string; sucursal?: string; concepto?: string; limit?: string }) {
    const { from, to } = rango(q);
    const limit = Math.min(500, Math.max(1, parseInt(q.limit || '200', 10) || 200));

    return this.tk.run(M, async (trx) => {
      // ⛔ `knex.raw()` NO entiende los placeholders nativos `$1` de Postgres, sólo su propio
      // `?` posicional. Usar `$N` acá rompe TODA query parametrizada con "Expected N bindings,
      // saw M" — es el bug que tumbó la Fase CV entera (CV.7) y sólo aparece contra una base
      // real, nunca en el build. Por eso el tenant se repite en el array: se liga dos veces.
      const filtros: string[] = [];
      const params: any[] = [M, M, from, to];
      if (q.canal) { filtros.push('AND a.canal = ?'); params.push(q.canal); }
      if (q.sucursal) { filtros.push('AND a.sucursal = ?'); params.push(q.sucursal); }
      // Filtrar por TIPO DE GASTO: deja las guias que cargan ese concepto. El costo de la fila
      // sigue siendo el TOTAL de la guia, no el del concepto -- filtrar no es recalcular, y una
      // columna que cambia de significado segun el filtro es una trampa.
      if (q.concepto) {
        filtros.push(`AND EXISTS (SELECT 1 FROM analytics.mv_logistics_guide_cost k
                        WHERE k.tenant_id = a.tenant_id AND k.dia = a.dia
                          AND k.sucursal = a.sucursal AND k.guia = a.guia
                          AND k.concepto = ?)`);
        params.push(q.concepto);
      }
      params.push(limit);

      const { rows } = await trx.raw(
        `SELECT a.dia, a.sucursal, a.guia, a.canal, a.paradas, a.mercancia,
                c.costo, c.conceptos, c.origen_peor, c.pct_admin,
                a.transporte_clave, a.unidades
           FROM analytics.v_logistics_activity_daily a
           LEFT JOIN (
             SELECT dia, sucursal, guia, canal,
                    round(sum(atribuido)::numeric, 2)                      AS costo,
                    count(DISTINCT concepto)::int                          AS conceptos,
                    -- El peor origen manda: si una sola parte del costo es atribuida, el total
                    -- no se puede presentar como directo.
                    CASE WHEN bool_or(origen = 'atribuido') THEN 'atribuido' ELSE 'directo' END
                                                                           AS origen_peor,
                    round((100.0 * sum(atribuido) FILTER (WHERE fuente = 'otros_admin')
                           / NULLIF(sum(atribuido), 0))::numeric, 1)       AS pct_admin
               FROM analytics.mv_logistics_guide_cost
              WHERE tenant_id = ?::uuid AND origen <> 'sin_actividad'
              GROUP BY 1, 2, 3, 4
           ) c ON c.dia = a.dia AND c.sucursal = a.sucursal
              AND c.guia = a.guia AND c.canal = a.canal
          WHERE a.tenant_id = ?::uuid
            AND a.dia >= ?::date AND a.dia <= ?::date
            AND a.canal IN ('cliente', 'carga_ruta', 'traspaso')
            ${filtros.join(' ')}
          ORDER BY a.dia DESC, c.costo DESC NULLS LAST
          LIMIT ?`,
        params,
      );

      const guias = rows.map((r: any) => ({
        ...r,
        paradas: Number(r.paradas),
        mercancia: r.mercancia === null ? null : Number(r.mercancia),
        // NULL, nunca 0: "no se registro gasto" no es "fue gratis".
        costo: r.costo === null ? null : Number(r.costo),
        costo_por_parada: r.costo === null ? null
          : Number((Number(r.costo) / Number(r.paradas)).toFixed(2)),
        costo_estado: r.costo === null ? 'no_medido' : 'atribuido',
        costo_motivo: r.costo === null
          ? 'no hay gasto logistico asentado para ese canal en esa ventana' : null,
      }));

      // ⛔ LOS TOTALES SE CALCULAN EN EL SERVIDOR SOBRE TODO EL RANGO, no en el cliente sobre la
      // pagina. Medido: en 30 dias hay **847 guias** y el endpoint devuelve 300, asi que un KPI
      // sumado en el front mostraba **$349,691 cuando el real es $1,251,514** -- subdeclaraba el
      // 72 % y se leia como un dato, no como un truncamiento. Un total que depende del tamano de
      // pagina no es un total.
      const [tot] = (await trx.raw(
        `SELECT count(*)::int                                   AS guias_total,
                count(c.costo)::int                             AS guias_con_costo,
                round(sum(c.costo)::numeric, 2)                 AS costo_total,
                sum(a.paradas)::int                             AS paradas_total,
                round(sum(a.mercancia)::numeric, 2)             AS mercancia_total
           FROM analytics.v_logistics_activity_daily a
           LEFT JOIN (
             SELECT dia, sucursal, guia, canal, sum(atribuido) AS costo
               FROM analytics.mv_logistics_guide_cost
              WHERE tenant_id = ?::uuid AND origen <> 'sin_actividad'
              GROUP BY 1,2,3,4
           ) c ON c.dia=a.dia AND c.sucursal=a.sucursal AND c.guia=a.guia AND c.canal=a.canal
          WHERE a.tenant_id = ?::uuid AND a.dia >= ?::date AND a.dia <= ?::date
            AND a.canal IN ('cliente','carga_ruta','traspaso')
            ${q.canal ? 'AND a.canal = ?' : ''}
            ${q.sucursal ? 'AND a.sucursal = ?' : ''}`,
        [M, M, from, to, ...(q.canal ? [q.canal] : []), ...(q.sucursal ? [q.sucursal] : [])],
      )).rows;

      const costoTotal = Number(tot.costo_total || 0);
      const mercTotal = Number(tot.mercancia_total || 0);
      return {
        guias,
        // Los KPIs de la cabecera: del SERVIDOR, sobre el rango completo.
        totales: {
          guias: Number(tot.guias_total), guias_con_costo: Number(tot.guias_con_costo),
          paradas: Number(tot.paradas_total),
          costo: costoTotal, mercancia: mercTotal,
          costo_por_parada: tot.paradas_total
            ? Number((costoTotal / Number(tot.paradas_total)).toFixed(2)) : null,
          mostradas: guias.length,
          truncado: guias.length < Number(tot.guias_total),
        },
        // Lo que se puede decir del retorno SIN inventar un margen (ver `margen_declarado`).
        retorno: {
          erosion_pct: mercTotal ? Number((100 * costoTotal / mercTotal).toFixed(2)) : null,
          pesos_movidos_por_peso_gastado: costoTotal
            ? Number((mercTotal / costoTotal).toFixed(1)) : null,
          nota: 'Erosion logistica = costo atribuido / mercancia movida. NO es margen: la '
              + 'mercancia del traspaso y la carga a ruta es valor de transferencia, no venta.',
        },
        cobertura: {
          measured: Number(tot.guias_total) > 0,
          pct: Number(tot.guias_total)
            ? Number((100 * Number(tot.guias_con_costo) / Number(tot.guias_total)).toFixed(1)) : null,
          note: `${tot.guias_con_costo} de ${tot.guias_total} guias tienen gasto atribuible`,
        },
        margen_declarado: this.motivoSinMargen(),
      };
    });
  }

  /**
   * El catálogo de tipos de gasto del período — alimenta el filtro de la pantalla.
   *
   * ⚠️ Sale de los datos, no de una lista fija: si Contabilidad da de alta un concepto nuevo,
   * aparece solo. Una lista quemada en el front lo dejaría invisible y nadie se enteraría.
   */
  async conceptos(q: { from?: string; to?: string; canal?: string }) {
    const { from, to } = rango(q);
    return this.tk.run(M, async (trx) => {
      const { rows } = await trx.raw(
        `SELECT concepto,
                string_agg(DISTINCT cuenta_mayor, '+' ORDER BY cuenta_mayor) AS cuentas,
                string_agg(DISTINCT ventana, '+')  AS ventanas,
                count(DISTINCT sucursal || guia)::int AS guias,
                round(sum(atribuido)::numeric, 2)  AS total
           FROM analytics.mv_logistics_guide_cost
          WHERE tenant_id = ?::uuid AND dia >= ?::date AND dia <= ?::date
            AND origen <> 'sin_actividad'
            ${q.canal ? 'AND canal = ?' : ''}
          GROUP BY 1
          ORDER BY sum(atribuido) DESC`,
        [M, from, to, ...(q.canal ? [q.canal] : [])],
      );
      return rows.map((r: any) => ({ ...r, total: Number(r.total), guias: Number(r.guias) }));
    });
  }

  /** Nivel 2 — esa guía, concepto por concepto. */
  async guideBreakdown(sucursal: string, guia: string, q: { from?: string; to?: string }) {
    const { from, to } = rango(q);
    return this.tk.run(M, async (trx) => {
      // ⛔ Se agrupa por CONCEPTO, no por (concepto, cuenta, fuente, ventana). El mismo tipo de
      // gasto llega por DOS vias -- su propio departamento y el prorrateo administrativo -- y
      // ademas puede vivir en varias cuentas contables. Agrupando fino, la guia `01/0001584`
      // devolvia **44 renglones para 36 conceptos**: la lista se leia repetida y sumarla a ojo no
      // daba. Las dos vias se conservan como columnas (`de_departamento` / `de_prorrateo`), que es
      // la informacion que el usuario necesita, sin partir el renglon en dos.
      const { rows } = await trx.raw(
        `SELECT concepto,
                string_agg(DISTINCT cuenta_mayor, '+' ORDER BY cuenta_mayor) AS cuentas,
                string_agg(DISTINCT ventana, '+')                            AS ventanas,
                round(sum(atribuido)::numeric, 2)                            AS atribuido,
                round(sum(atribuido) FILTER (WHERE fuente = 'departamento')::numeric, 2)
                                                                             AS de_departamento,
                round(sum(atribuido) FILTER (WHERE fuente = 'otros_admin')::numeric, 2)
                                                                             AS de_prorrateo,
                CASE WHEN bool_or(origen = 'atribuido') THEN 'atribuido' ELSE 'directo' END
                                                                             AS origen,
                max(paradas_guia)::int   AS paradas_guia,
                max(paradas_bucket)::int AS paradas_bucket,
                max(n_guias_bucket)::int AS n_guias_bucket,
                count(*)::int            AS renglones,
                min(dia)                 AS dia
           FROM analytics.mv_logistics_guide_cost
          WHERE tenant_id = ?::uuid AND sucursal = ? AND guia = ?
            AND dia >= ?::date AND dia <= ?::date
          GROUP BY 1
          ORDER BY sum(atribuido) DESC`,
        [M, sucursal, guia, from, to],
      );
      const total = rows.reduce((s: number, r: any) => s + Number(r.atribuido), 0);
      return {
        sucursal, guia,
        total: Number(total.toFixed(2)),
        conceptos: rows.map((r: any) => ({
          ...r,
          atribuido: Number(r.atribuido),
          de_departamento: Number(r.de_departamento || 0),
          de_prorrateo: Number(r.de_prorrateo || 0),
          // La participacion se publica para que el share sea AUDITABLE: sin el denominador,
          // "atribuido" es un numero que hay que creer.
          share: r.paradas_bucket
            ? Number((Number(r.paradas_guia) / Number(r.paradas_bucket)).toFixed(4)) : null,
          pct_del_total: total ? Number((100 * Number(r.atribuido) / total).toFixed(1)) : null,
        })),
        margen_declarado: this.motivoSinMargen(),
      };
    });
  }

  /**
   * Nivel 3 — ⭐ los RENGLONES DE PÓLIZA reales del bucket. **Sin prorratear.**
   *
   * Esto es lo que cierra la pregunta "¿de dónde sale este costo?": son las pólizas tal cual
   * las asentó Contabilidad, con su documento, su beneficiario y su comentario. El importe que
   * se ve acá es el del bucket COMPLETO (lo que gastó el canal ese día o ese mes), no la parte
   * que le tocó a esta guía — y la respuesta lo dice con `share` para que se pueda multiplicar.
   */
  async conceptLines(
    sucursal: string, guia: string, concepto: string, q: { from?: string; to?: string },
  ) {
    const { from, to } = rango(q);
    return this.tk.run(M, async (trx) => {
      // 1) De qué bucket vino: canal, ventana y su participación.
      const { rows: ctx } = await trx.raw(
        `SELECT canal, ventana, fuente, min(dia) AS dia,
                max(paradas_guia) AS paradas_guia, max(paradas_bucket) AS paradas_bucket,
                round(sum(atribuido)::numeric, 2) AS atribuido
           FROM analytics.mv_logistics_guide_cost
          WHERE tenant_id = ?::uuid AND sucursal = ? AND guia = ? AND concepto = ?
            AND dia >= ?::date AND dia <= ?::date
          GROUP BY 1, 2, 3`,
        [M, sucursal, guia, concepto, from, to],
      );
      if (!ctx.length) return { sucursal, guia, concepto, bucket: null, lineas: [] };

      const b = ctx[0];
      // 2) Los renglones de póliza de ese bucket. La ventana manda: un concepto mensual trae
      //    las pólizas del MES, uno diario las de ese día.
      const { rows: lineas } = await trx.raw(
        `SELECT e.fecha, e.doc_tipo, e.doc_folio, e.linea, e.sucursal,
                e.cuenta, e.cuenta_nombre, e.beneficiario, e.comentario,
                e.dpto_nombre, round(e.importe::numeric, 2) AS importe
           FROM analytics.expense_entries e
          WHERE e.tenant_id = ?::uuid
            AND left(e.cuenta, 3) IN ('602','604','606','611')
            AND COALESCE(NULLIF(btrim(e.concepto_nombre), ''), '(sin concepto)') = ?
            -- El placeholder de knex es POSICIONAL: un valor que aparece dos veces en el SQL
            -- se liga dos veces en el array. Con los de Postgres se escribiria una sola vez,
            -- y por eso es tan facil traducir mal de un dialecto al otro.
            AND (? = 'mes'   OR e.fecha = ?::date)
            AND (? = 'diario' OR date_trunc('month', e.fecha) = date_trunc('month', ?::date))
          ORDER BY e.importe DESC
          LIMIT 500`,
        [M, concepto, b.ventana, b.dia, b.ventana, b.dia],
      );

      const totalBucket = lineas.reduce((s: number, r: any) => s + Number(r.importe), 0);
      return {
        sucursal, guia, concepto,
        bucket: {
          canal: b.canal, ventana: b.ventana, fuente: b.fuente, dia: b.dia,
          total_bucket: Number(totalBucket.toFixed(2)),
          atribuido_a_esta_guia: Number(b.atribuido),
          share: b.paradas_bucket
            ? Number((Number(b.paradas_guia) / Number(b.paradas_bucket)).toFixed(4)) : null,
          paradas_guia: Number(b.paradas_guia), paradas_bucket: Number(b.paradas_bucket),
          nota: 'El importe de cada renglon es el de la POLIZA COMPLETA, no la parte de esta '
              + 'guia. La parte de esta guia es importe x share.',
        },
        lineas: lineas.map((r: any) => ({ ...r, importe: Number(r.importe) })),
      };
    });
  }

  /** El mismo motivo en los tres niveles: si cambia, cambia en un solo lugar. */
  private motivoSinMargen() {
    return {
      disponible: false,
      motivo: 'No hay COGS para el canal que factura. Dos fuentes, las dos medidas: (1) el '
        + 'embarque U-D-41 no trae costo de renglon -- kdm2.c62 poblado al 0.76%, contra 99.99% '
        + 'en el ticket de mostrador; (2) el arbitro oficial del proyecto '
        + '(analytics.mv_erp_margin_daily) cubre la FACTURA del embarque (doctype 8) con apenas '
        + '2.48% de la venta costeada -- 91 lineas de 7,097 en agosto-2026 -- contra 99.99% del '
        + 'ticket POS. Un margen sobre el 2.48% seria una muestra minima y sesgada.',
      requiere: 'que Kepler capture el costo en el renglon del embarque, o el resolvedor de '
        + 'unidades ADR-057 para poder usar el costo de ficha sin mezclar pieza y caja',
      en_su_lugar: 'Se publica la EROSION LOGISTICA (costo atribuido / mercancia movida), que si '
        + 'sale de dos cifras medidas.',
    };
  }
}
