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
