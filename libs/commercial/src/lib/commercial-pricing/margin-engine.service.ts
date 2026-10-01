import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

/**
 * `[PR.V1]` — **El motor de margen, del lado del servidor.**
 *
 * Lee `analytics.v_price_action` (capa 3) y `analytics.price_signal_registry` (capa 1). No
 * calcula nada: la lógica vive en la base, donde el candado la vigila.
 *
 * ⛔ **No escribe precios.** Kepler es read-only (ADR-040) y la decisión fue que todo pasa por
 * humano. Por eso este módulo **no tiene `_GESTIONAR`** — igual que `commercial-standard-cost`.
 *
 * ⭐ El endpoint que más importa no es la cola: es `senales()`. Una pantalla que sólo muestra
 * lo que el motor **sí** puede ver deja creer que eso es todo lo que hay.
 */

/** Lo que la pantalla ordena por dinero. Ninguna de estas es una acción sobre Kepler. */
export type AccionPrecio =
  | 'corregir_escalera' | 'revisar_costo' | 'aterrizar_precio'
  | 'subir_precio' | 'liberar_capital' | 'precio_atipico' | 'sin_accion_defendible';

@Injectable()
export class MarginEngineService {
  private readonly log = new Logger(MarginEngineService.name);

  constructor(private readonly tk: TenantKnexService) {}

  /**
   * ⭐ **Answer-first.** Lo primero que alguien quiere saber al entrar no es cuántas filas hay:
   * es *qué se puede hacer hoy y cuánto vale*. Y con su **certeza** al lado, porque una acción
   * aritmética y una que depende de un efecto no medido no se priorizan igual.
   */
  async resumen(): Promise<unknown> {
    return this.tk.run(async (trx) => {
      const { rows: acciones } = await trx.raw(`
        SELECT accion, certeza,
               count(*)::int                                   AS celdas,
               count(*) FILTER (WHERE accionable)::int          AS libres,
               round(sum(monto_en_juego_mxn) FILTER (WHERE accionable)::numeric, 2) AS flujo_libre,
               round(sum(monto_en_juego_mxn)::numeric, 2)       AS flujo_total,
               round(sum(capital_inmovilizado_mxn)::numeric, 2) AS capital,
               round(sum(venta_30d)::numeric, 2)                AS venta_expuesta
          FROM analytics.v_price_action
         WHERE accion <> 'sin_accion_defendible'
         GROUP BY 1, 2
         ORDER BY 5 DESC NULLS LAST`);

      /**
       * ⭐ El default se devuelve APARTE y siempre, aunque esté vacío. Es la mayoría de las
       * celdas (74.4 % medido) y esconderlo haría ver un motor que siempre tiene algo que decir.
       */
      const { rows: [sin] } = await trx.raw(`
        SELECT count(*)::int celdas, round(sum(venta_30d)::numeric, 2) venta
          FROM analytics.v_price_action WHERE accion = 'sin_accion_defendible'`);

      const { rows: [tot] } = await trx.raw(`
        SELECT count(*)::int celdas,
               count(*) FILTER (WHERE NOT accionable)::int bloqueadas,
               max(calculado_al) AS calculado_al
          FROM analytics.v_price_action`);

      // Los bloqueos, desagregados: son la razón por la que algo accionable no se puede tocar.
      const { rows: bloqueos } = await trx.raw(`
        SELECT b AS bloqueo, count(*)::int celdas, round(sum(venta_30d)::numeric, 2) venta
          FROM analytics.v_price_action, unnest(bloqueos) AS b
         GROUP BY 1 ORDER BY 2 DESC`);

      return { acciones, sin_accion: sin, total: tot, bloqueos };
    });
  }

  /** La cola priorizada por dinero. Lo que no tiene cifra cae al final, con su motivo. */
  async cola(f: {
    sucursal?: string; accion?: string; soloLibres?: boolean; limit?: number;
  }): Promise<unknown[]> {
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
    return this.tk.run(async (trx) => {
      const q = trx('analytics.v_price_action')
        .select(
          'sucursal', 'sku', 'nombre', 'precio_actual', 'venta_30d',
          'accion', 'certeza', 'monto_en_juego_mxn', 'monto_motivo',
          'capital_inmovilizado_mxn', 'bloqueos', 'accionable',
          's1_senal', 's1_mxn', 's2_senal', 's2_mxn', 's3_senal', 's3_mxn',
          'margen_realizado_pct', 'meta_margen_pct', 'dif_vs_meta_pp',
          'd1_terminacion', 'd1_candidato_99', 'd1_alza_99_pct', 'd4_umbral_percepcion',
          'e3_estado_inventario', 'g2_clase_abc', 'd8_prima_caja_pct',
          'familias_con_evidencia', 'familias_totales', 'calculado_al',
        )
        .whereNot('accion', 'sin_accion_defendible');

      if (f.sucursal) q.where('sucursal', f.sucursal);
      if (f.accion) q.where('accion', f.accion);
      if (f.soloLibres) q.where('accionable', true);

      // ⛔ NULLS LAST explícito: sin él, las celdas sin cifra encabezarían la cola del dinero.
      return q.orderByRaw('abs(monto_en_juego_mxn) DESC NULLS LAST').limit(limit);
    });
  }

  /**
   * ⭐⭐ **El plan de margen de un SKU** — lo que el pedido original llamaba "al dar clic se
   * desglosa el análisis". No es un número con adornos: son las 13 familias de señales con su
   * cobertura, su veredicto y su motivo, y los aportes que sí se pudieron medir en pesos.
   */
  async detalle(sucursal: string, sku: string): Promise<unknown> {
    return this.tk.run(async (trx) => {
      const { rows: [accion] } = await trx.raw(
        `SELECT * FROM analytics.v_price_action WHERE sucursal = ? AND sku = ?`, [sucursal, sku]);
      if (!accion) return null;

      const { rows: [s] } = await trx.raw(
        `SELECT * FROM analytics.mv_price_signals WHERE sucursal = ? AND sku = ?`, [sucursal, sku]);

      /**
       * ⭐ Las familias se arman acá y no en la pantalla: la cobertura y el motivo de cada una
       * son parte del dato, no de la presentación. Si viajaran sueltos, una pantalla nueva
       * podría publicar el número sin ellos.
       */
      const fam = (n: number, nombre: string, senales: string[]) => ({
        n,
        nombre,
        senales,
        veredicto: s?.[`f${n}_veredicto`] ?? null,
        cobertura: s?.[`f${n}_cobertura`] ?? null,
        motivo: s?.[`f${n}_motivo`] ?? null,
      });

      const familias = [
        fam(1, 'Psicología del precio', ['D1 terminación', 'D2 dígito izquierdo', 'D3 umbral redondo', 'D4 umbral de percepción']),
        fam(2, 'Meta y unidad', ['G3 meta de margen']),
        fam(3, 'Costo', ['A1 costo de hoy', 'A2 costo de ficha', 'A3 antigüedad', 'A6 deriva']),
        fam(4, 'Cliente y descuento', ['C2 fuga', 'C3 concentración', 'C4 vendedores', 'C5 precio de referencia', 'C6 dispersión', 'A9 días regalados']),
        fam(5, 'Inventario', ['E1 cobertura', 'E3 sobrestock', 'G2 clase ABC']),
        fam(6, 'Demanda', ['B3 estacionalidad', 'B5 momentum', 'B6 rotación']),
        fam(7, 'Historial de precio', ['D5 frecuencia', 'D6 fatiga']),
        fam(8, 'Escalera de unidades', ['D8 coherencia']),
        fam(9, 'Merma', ['A10 roll-forward']),
        fam(10, 'Canasta', ['B10 arrastre']),
        fam(11, 'Promoción', ['G5 regla vigente']),
        fam(12, 'Faltantes del mostrador', ['E4 reportes']),
        fam(13, 'Margen realizado', ['A4 árbitro del costo']),
      ];

      return { accion, senales: s ?? null, familias };
    });
  }

  /**
   * ⭐⭐ **El EXPEDIENTE del SKU** — lo que se abre al dar clic.
   *
   * Un solo viaje. Cinco llamadas serían cinco estados de carga en la misma ventana, y el
   * usuario vería la pantalla armarse a pedazos.
   */
  async expediente(sucursal: string, sku: string): Promise<unknown> {
    return this.tk.run(async (trx) => {
      const [base, historia, eventos, respuesta, plazas, perdida] = await Promise.all([
        this.detalle(sucursal, sku),

        // 1 · La serie de costo, precio y volumen. Mensual: el par promedio vende 26.7 días AL AÑO.
        trx.raw(`
          SELECT to_char(mes, 'YYYY-MM') AS mes, costo_unitario, precio_unitario, margen_pct,
                 unidades_total, venta_total, dias_con_venta, cobertura_costo_pct, venta_sin_costo
            FROM analytics.v_sku_cost_sales_monthly
           WHERE sucursal = ? AND sku = ? ORDER BY mes`, [sucursal, sku]).then((r) => r.rows),

        /**
         * 2 · Los cambios de precio, ya limpios de centinelas, netos de ida y vuelta y de
         * recosteo. ⭐ Se lee la MATVISTA: filtrada por un par, la vista tardaba 3,166 ms
         * porque el predicado no baja y los CTE barren la bitácora entera.
         */
        trx.raw(`
          SELECT to_char(fecha, 'YYYY-MM-DD') AS fecha, unidad_base, precio_antes, precio_despues,
                 cambio_pct, es_alza, unidades_en_evento, spread_pct, veredicto_unidad
            FROM analytics.mv_sku_price_events
           WHERE sucursal = ? AND sku = ? ORDER BY fecha DESC LIMIT 40`,
        [sucursal, sku]).then((r) => r.rows),

        /**
         * 3 · ⭐⭐ Qué pasó las veces anteriores — **con su placebo en la misma fila**.
         *
         * ⛔ `lr_pre` NO es un adorno: es el control que decide si `lr_post` se puede leer.
         * Medido sobre todo el universo, la pre-tendencia media es **+0.26** contra un efecto
         * de −0.01, y **empeora cuanto mejores son los datos** (+0.36 con 15+ días por ventana).
         * Peor todavía: una BAJA de precio y un ALZA producen el mismo movimiento negativo
         * (−0.39 y −0.64) — ninguna curva de demanda hace eso. Es reversión a la media: el
         * precio se toca justo después de un pico, y el pico revierte solo.
         */
        trx.raw(`
          SELECT to_char(fecha, 'YYYY-MM-DD') AS fecha, unit_kind, precio_antes, precio_despues,
                 cambio_pct, es_alza, vol_pre, vol_post, dias_pre, dias_post,
                 lr_post, lr_pre, veredicto, motivo
            FROM analytics.mv_sku_price_response
           WHERE sucursal = ? AND sku = ? ORDER BY fecha DESC`,
        [sucursal, sku]).then((r) => r.rows),

        // 4 · El mismo SKU en las 9 plazas.
        trx.raw(`
          SELECT sucursal, precio_actual, a1_costo_hoy, a2_costo_ficha, margen_realizado_pct,
                 meta_margen_pct, accion, certeza, venta_30d, e3_estado_inventario, g2_clase_abc,
                 (sucursal = ?) AS es_esta
            FROM analytics.v_price_action WHERE sku = ? ORDER BY sucursal`,
        [sucursal, sku]).then((r) => r.rows),

        /**
         * 5 · La demanda perdida. ⛔ Cada fila trae su atraso porque Wincaja dejó de registrar
         * el día que la plaza migró a Kepler — hasta 272 días. Publicar el importe sin eso
         * insinuaría que es de ahora.
         */
        trx.raw(`
          SELECT to_char(mes, 'YYYY-MM') AS mes, sucursal, unidades_perdidas, importe_perdido,
                 reportes, clientes, dias_de_atraso, motivo_atraso
            FROM analytics.v_sku_lost_demand
           WHERE sku = ? AND (sucursal = ? OR ? = 'todas') ORDER BY mes DESC LIMIT 24`,
        [sku, sucursal, 'esta']).then((r) => r.rows),
      ]);

      if (!base) return null;
      return { ...(base as object), historia, eventos, respuesta, plazas, perdida };
    });
  }

  /**
   * ⭐⭐ **El simulador.** Todo aritmética; **no predice nada y no escribe nada.**
   *
   * El número que importa es el **umbral de equilibrio**: cuánto volumen habría que perder para
   * que el cambio deje al negocio peor. Es la respuesta a que no existe elasticidad usable
   * -región Anderson-Rubin de [−1.415, −0.045], factor 31× de ancho- sin inventar la curva.
   */
  async simular(sucursal: string, sku: string, precioNuevo: number): Promise<unknown> {
    if (!Number.isFinite(precioNuevo) || precioNuevo <= 0) {
      return { error: 'el precio tiene que ser un número mayor que cero' };
    }
    return this.tk.run(async (trx) => {
      const { rows: [s] } = await trx.raw(`
        SELECT precio_actual, a1_costo_hoy, a2_costo_ficha, m1_meta_margen,
               d4_umbral_percepcion, d1_terminacion, a4_margen_realizado_pct
          FROM analytics.mv_price_signals WHERE sucursal = ? AND sku = ?`, [sucursal, sku]);
      if (!s) return null;

      // ⭐ El costo de HOY si existe; si no, el de la ficha, y se DECLARA cuál se usó.
      const costo = s.a1_costo_hoy ?? s.a2_costo_ficha ?? null;
      const costoFuente = s.a1_costo_hoy ? 'costo_de_reposicion'
        : (s.a2_costo_ficha ? 'costo_de_la_ficha' : null);

      const { rows: [c] } = await trx.raw(`
        SELECT analytics.fn_umbral_equilibrio(?::numeric, ?::numeric, ?::numeric) AS umbral,
               analytics.fn_precio_aterriza(?::numeric, '99') AS aterriza_99,
               analytics.fn_precio_aterriza(?::numeric, '00') AS aterriza_00,
               analytics.fn_precio_aterriza(?::numeric, '90') AS aterriza_90,
               analytics.fn_precio_umbral_percepcion(?::numeric) AS umbral_percepcion`,
      [s.precio_actual, costo, precioNuevo, precioNuevo, precioNuevo, precioNuevo,
        s.precio_actual]);

      const actual = Number(s.precio_actual);
      const cambioPct = actual > 0
        ? Math.round(((precioNuevo - actual) / actual) * 10000) / 100 : null;
      const margenNuevo = costo && precioNuevo > 0
        ? Math.round(((precioNuevo - Number(costo)) / precioNuevo) * 10000) / 100 : null;

      return {
        precio_actual: s.precio_actual,
        precio_nuevo: precioNuevo,
        cambio_pct: cambioPct,
        costo, costo_fuente: costoFuente,
        margen_nuevo_pct: margenNuevo,
        margen_meta_pct: s.m1_meta_margen,
        margen_realizado_pct: s.a4_margen_realizado_pct,
        umbral_equilibrio_pct: c.umbral,
        umbral_percepcion_pct: c.umbral_percepcion,
        // ⭐ Si el alza NO supera el umbral de percepción, el cliente no la distingue.
        se_percibe: cambioPct !== null && c.umbral_percepcion !== null
          ? Math.abs(cambioPct) > Number(c.umbral_percepcion) : null,
        aterrizajes: { p99: c.aterriza_99, p00: c.aterriza_00, p90: c.aterriza_90 },
        /**
         * ⛔ Lo que el simulador NO sabe, dicho en el propio dato. Sin esto, un número solo
         * se lee como una predicción, y no lo es.
         */
        no_sabe: 'cuanto volumen se va a perder de verdad. No existe elasticidad usable por SKU '
          + '(error estandar 0.94) y la region agregada mide [-1.415, -0.045], un factor 31x de '
          + 'ancho. El umbral de equilibrio dice cuanto se PODRIA perder, no cuanto se va a perder.',
      };
    });
  }

  /**
   * ⭐⭐ El registro de señales — **lo que el motor NO puede ver, con nombre y motivo**.
   *
   * Es el endpoint que evita la mentira por omisión: una pantalla que sólo muestra las 29
   * cableadas deja creer que ésas son todas las variables que importan. Son 46, y **15 no
   * existen** — cada una con su razón escrita.
   */
  async senales(): Promise<unknown> {
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(`
        SELECT clave, familia, nombre, definicion, unidad, direccion, estado,
               cobertura_pct, cobertura_medida_al, fuente_columna, motivo_ausencia,
               peso_max, nucleo
          FROM analytics.price_signal_registry
         ORDER BY CASE estado WHEN 'cableada' THEN 1 WHEN 'disponible' THEN 2
                              WHEN 'refutada' THEN 3 ELSE 4 END,
                  cobertura_pct DESC, clave`);
      const por = (e: string) => rows.filter((r: { estado: string }) => r.estado === e).length;
      return {
        senales: rows,
        conteo: {
          total: rows.length,
          cableadas: por('cableada'),
          disponibles: por('disponible'),
          refutadas: por('refutada'),
          no_existen: por('no_existe'),
        },
      };
    });
  }
}
