import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService, TenantContextService, todayMx } from '@megadulces/platform-core';
import {
  banderasDeCierre,
  diasDelRango,
  estadoCelda,
  ExistenciaHistorico,
  ExistenciaHistoricoDetalle,
  HistoricoAlmacen,
  HistoricoCelda,
  HistoricoDetalleProducto,
  HistoricoDia,
  HISTORICO_CEDIS,
  HISTORICO_FUENTE_VIEJA,
  rangoHistorico,
  totalDelDia,
} from '@megadulces/contracts';

/**
 * Lo que pide la pantalla. `almacenes` = códigos, en CSV o repetido en la URL (`?almacenes=01&almacenes=02`
 * llega como arreglo); vacío = todos los almacenes vivos que se han fotografiado.
 */
export interface ExistenciaHistoricoQuery {
  desde?: string;
  hasta?: string;
  almacenes?: string | string[];
}

/** Un almacén × día de la cobertura, con lo que la foto ya trae. */
interface FilaCobertura {
  fecha: string;
  warehouse_id: string;
  pares: number;
  unidades_total: string | null;
  stock_source: string | null;
  standard_value_known: string | null;
  standard_missing_pairs: number | null;
  standard_doubtful_pairs: number | null;
}

/** Un almacén × día valuado con la historia del estándar (días anteriores a EX.H0). */
interface FilaReconstruida {
  valor: number | null;
  productos: number;
  sin_valuar: number;
  costo_posterior: number;
}

/**
 * `[EX.H4]` El CEDIS en los días en que su foto estaba congelada y ya operaba en Kepler: esas
 * cantidades salen del kardex, no de la foto.
 */
interface KardexCedis {
  warehouse_id: string;
  /** La sucursal de Kepler del CEDIS (`kepler_code`). */
  sucursal: string;
  /** Su corte de Wincaja a Kepler: el kardex que importa empieza ahí. */
  desde: string;
  /** Los días a reconstruir. */
  fechas: string[];
}

/** El CEDIS y su corte a Kepler, si opera en Kepler. */
interface CedisKepler {
  warehouse_id: string;
  sucursal: string;
  desde: string;
}

const SUCURSAL_RX = /^\d{2}$/;

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FECHA_RX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `[EX.H1]` «Consulta históricos» de Existencia — cuánto valía el inventario de cada sucursal al
 * cierre de cada día, a costo estándar de Kepler sin impuesto (D1 de Francisco, 2026-11-06). La
 * forma y las reglas puras viven en `libs/contracts/src/http/existencia-historico.contract.ts`.
 *
 * ── Dos caminos para el valor de un día, y la pantalla sabe cuál se usó ──────────────
 *  · Desde `[EX.H0]` la foto guarda su estándar del día: se lee `standard_value_known` de la
 *    cobertura tal cual (`costo_reconstruido = false`).
 *  · Antes, se RECONSTRUYE: existencia de la foto × el estándar vigente ese día según
 *    `analytics.product_cost_history`, en el peldaño que casa con el costo del ERP a < 2×. Es la
 *    consulta validada el 2026-11-04 (`C:/DEV/_reportes/consulta_valor_existencia_por_dia.sql`):
 *    −2.2 % contra el reporte del 15-oct en 01–08; y este servicio la reproduce al 0.0000 % en 378
 *    almacén×día (medido 2026-11-06). Antes del 2026-10-17 no hay historia y se usa el PRIMER
 *    estándar conocido (`productos_costo_posterior` lo cuenta). ⚠️ El testigo de unidad es el costo
 *    del ERP de HOY: un día reconstruido puede moverse un poco con el tiempo (hasta 2.2 % en un
 *    almacén×día entre el 4 y el 6 de noviembre). Por eso el memo de reconstrucciones dura UN día.
 *
 * ── `[EX.H4]` El CEDIS congelado: la existencia sale del kardex ──────────────────────
 *  Antes de EX.H0 la foto del CEDIS repetía un saldo congelado (no cambió ni un producto del 24-sep al
 *  6-nov salvo dos refrescos sueltos). Desde su corte a Kepler (`analytics.v_branch_erp_cutover`,
 *  2026-09-30) la cantidad de cada día se RECONSTRUYE: existencia de HOY en `kdil` (la misma suma que
 *  lee `v_erp_stock_on_hand`) menos los movimientos de `kdij` posteriores a ese día, sin documentos
 *  cancelados (`kdm1.c43 = 'C'`). Entra el producto si se movió entre el corte y ese día (lo que la
 *  vista habría incluido) y los negativos se recortan a 0 (como la vista). Medido el 2026-11-07:
 *  `kdil` = Σ `kdij` desde el 22-sep sin cancelados en 1,401 de 1,429 productos (98 %); la
 *  reconstrucción de hoy da 313 productos / 343,130 unidades contra 312 / 343,122 de la vista.
 *  Antes del corte el CEDIS operaba en Wincaja y su existencia no casa con la apertura de Kepler (46 de
 *  93 productos iguales, unidades distintas): esos días siguen `no_confiable`.
 *
 * ── ⛔ Literales y sin nested loop, en la reconstrucción ──────────────────────────────
 *  1. Con el tenant y las fechas como parámetros (un CTE de parámetros cruzado con el predicado de
 *     RLS) la consulta murió por `statement_timeout` (60 s); con literales, 2.7 s (2026-11-04). Se
 *     interpolan, validados contra su forma (uuid, fecha) antes de tocar el SQL.
 *  2. Las estadísticas de `stock_snapshots.fecha_corte` van ~4 fotos atrás (el autoanalyze cruza su
 *     umbral cada ~100 mil filas). Para la foto más NUEVA el planificador estima 1 fila, elige un nested
 *     loop contra la historia del estándar y pasa de 60 s — justo el caso de todos los días: «sólo falta
 *     anoche». Medido en la revisión de EX.H1: 1 día × 9 almacenes > 60 s; con `enable_nestloop = off`,
 *     2.4–2.8 s. Se apaga SÓLO para esa sentencia (mismo recurso que `analytics-refresh.service.ts`).
 *
 * ── Memo ─────────────────────────────────────────────────────────────────────────────
 *  · Reconstrucciones: por almacén × día × huella de su foto (pares + unidades), y se vacían al
 *    cambiar el día en México — un día re-tomado o un testigo que se movió no se sirven viejos.
 *  · Respuestas: 5 min, como mucho 50, y una sola ejecución a la vez por la misma consulta (dos
 *    pestañas no ocupan dos conexiones haciendo lo mismo).
 */
@Injectable()
export class ExistenciaHistoricoService {
  private readonly logger = new Logger(ExistenciaHistoricoService.name);
  private reconstruidos = new Map<string, FilaReconstruida>();
  private diaDelMemo = '';
  private readonly memo = new Map<string, { at: number; v: ExistenciaHistorico }>();
  private readonly enCurso = new Map<string, Promise<ExistenciaHistorico>>();
  private static readonly MEMO_MS = 5 * 60_000;
  private static readonly MEMO_MAX = 50;

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async historico(q: ExistenciaHistoricoQuery): Promise<ExistenciaHistorico> {
    const tenantId = this.tenantCtx.requireTenantId();
    const hoy = todayMx();
    if (this.diaDelMemo !== hoy) {
      this.reconstruidos = new Map();
      this.memo.clear();
      this.diaDelMemo = hoy;
    }
    const crudo = Array.isArray(q.almacenes) ? q.almacenes.join(',') : typeof q.almacenes === 'string' ? q.almacenes : '';
    const codigos = [...new Set(crudo.split(',').map((c) => c.trim()).filter(Boolean))].sort();
    const rango = rangoHistorico({ desde: q.desde, hasta: q.hasta }, hoy);
    const clave = `${tenantId}|${rango.desde}|${rango.hasta}|${codigos.join(',')}|${q.desde ?? ''}|${q.hasta ?? ''}`;

    const hit = this.memo.get(clave);
    if (hit && Date.now() - hit.at < ExistenciaHistoricoService.MEMO_MS) return hit.v;
    const enCurso = this.enCurso.get(clave);
    if (enCurso) return enCurso;

    const p = this.armar(tenantId, hoy, codigos, rango, q)
      .then((v) => { this.guardar(clave, v); return v; })
      .finally(() => this.enCurso.delete(clave));
    this.enCurso.set(clave, p);
    return p;
  }

  private guardar(clave: string, v: ExistenciaHistorico): void {
    const ahora = Date.now();
    for (const [k, e] of this.memo) if (ahora - e.at >= ExistenciaHistoricoService.MEMO_MS) this.memo.delete(k);
    while (this.memo.size >= ExistenciaHistoricoService.MEMO_MAX) {
      const primera = this.memo.keys().next().value;
      if (primera === undefined) break;
      this.memo.delete(primera);
    }
    this.memo.set(clave, { at: ahora, v });
  }

  private armar(
    tenantId: string,
    hoy: string,
    codigos: string[],
    rango: { desde: string; hasta: string; ajustado: boolean; motivo: string | null },
    q: ExistenciaHistoricoQuery,
  ): Promise<ExistenciaHistorico> {
    const { desde, hasta } = rango;
    return this.tk.run(tenantId, async (trx) => {
      await trx.raw('SET LOCAL jit = off');

      const meta = (await trx.raw(
        `SELECT (SELECT min(valid_from)::text FROM analytics.product_cost_history WHERE tenant_id = ?) AS historia,
                (SELECT min(fecha_corte)::text FROM analytics.stock_snapshot_coverage WHERE tenant_id = ?) AS foto_desde,
                (SELECT max(fecha_corte)::text FROM analytics.stock_snapshot_coverage WHERE tenant_id = ?) AS ultima,
                (SELECT last_finish FROM analytics.cron_runs WHERE tenant_id = ? AND job_key = 'stock_snapshot') AS hecha_en,
                (SELECT status FROM analytics.cron_runs WHERE tenant_id = ? AND job_key = 'stock_snapshot') AS estado,
                (SELECT COALESCE(error, note) FROM analytics.cron_runs WHERE tenant_id = ? AND job_key = 'stock_snapshot') AS nota`,
        [tenantId, tenantId, tenantId, tenantId, tenantId, tenantId],
      )).rows[0] ?? {};
      const fotoDesde: string | null = meta.foto_desde ?? null;
      const cedis = await this.leerCedisKepler(trx, tenantId);

      // Las columnas NO dependen de la cobertura del rango: un almacén que no tuvo foto en todo el
      // rango tiene que salir con sus días «sin foto» y dejar el total incompleto, no desaparecer.
      //  · Con códigos: los almacenes vivos pedidos, se hayan fotografiado o no.
      //  · Sin códigos: los almacenes vivos que se han fotografiado ALGUNA vez. MD-32 (borrado el
      //    2026-09-11) queda fuera: era el Morelia Madero de Wincaja y sumarlo junto al 07 contaría
      //    Madero dos veces. Las rutas nunca se fotografían.
      const almQ = trx('commercial.warehouses as w')
        .where('w.tenant_id', tenantId)
        .whereNull('w.deleted_at')
        .select('w.id', 'w.code', 'w.name', trx.raw('COALESCE(w.short_label, w.code) AS label'))
        .orderByRaw('w.display_order NULLS LAST, w.code');
      if (codigos.length) {
        almQ.whereIn('w.code', codigos);
      } else {
        almQ.whereExists(
          trx('analytics.stock_snapshot_coverage as c')
            .select(trx.raw('1'))
            .whereRaw('c.tenant_id = w.tenant_id AND c.warehouse_id = w.id'),
        );
      }
      const almRows: Array<{ id: string; code: string; name: string; label: string }> = await almQ;
      const almacenes: HistoricoAlmacen[] = almRows.map((a) => ({ code: a.code, name: a.name, label: a.label }));
      const idPorCodigo = new Map(almRows.map((a) => [a.code, a.id] as const));
      const desconocidos = codigos.filter((c) => !idPorCodigo.has(c));

      const cobertura = almRows.length
        ? await this.leerCobertura(trx, tenantId, desde, hasta, almRows.map((a) => a.id))
        : [];
      const porDia = new Map<string, Map<string, FilaCobertura>>();
      for (const c of cobertura) {
        if (!porDia.has(c.fecha)) porDia.set(c.fecha, new Map());
        porDia.get(c.fecha)!.set(c.warehouse_id, c);
      }

      // Lo que hay que reconstruir: cobertura sin el estándar guardado (días anteriores a EX.H0).
      const faltan = cobertura.filter((c) => c.standard_value_known == null && c.pares > 0
        && !this.reconstruidos.has(this.claveReconstruida(tenantId, c)));
      if (faltan.length) await this.reconstruir(trx, tenantId, faltan, cedis);

      const dias: HistoricoDia[] = diasDelRango(desde, hasta).map((fecha) => {
        const deDia = porDia.get(fecha);
        const celdas: HistoricoCelda[] = almacenes.map((a) => {
          const c = deDia?.get(idPorCodigo.get(a.code)!);
          const { estado, motivo, existencia_reconstruida } = estadoCelda({
            cubierto: !!c, warehouse_code: a.code, stock_source: c?.stock_source ?? null,
            fecha, hoy, foto_desde: fotoDesde, kardex_desde: cedis?.desde ?? null,
          });
          if (!c) {
            return {
              warehouse_code: a.code, estado, motivo, valor_estandar: null, productos_con_existencia: null,
              productos_sin_valuar: null, costo_reconstruido: false, existencia_reconstruida, productos_costo_posterior: null,
            };
          }
          // Un almacén fotografiado con todo en cero vale 0 de verdad (medido), no «sin dato».
          // (No aplica al CEDIS reconstruido: su foto congelada no dice nada de ese día.)
          if (c.pares === 0 && !existencia_reconstruida) {
            return {
              warehouse_code: a.code, estado, motivo, valor_estandar: 0, productos_con_existencia: 0,
              productos_sin_valuar: 0, costo_reconstruido: c.standard_value_known == null,
              existencia_reconstruida, productos_costo_posterior: 0,
            };
          }
          if (c.standard_value_known != null) {
            return {
              warehouse_code: a.code, estado, motivo,
              valor_estandar: Number(c.standard_value_known),
              productos_con_existencia: c.pares,
              productos_sin_valuar: Number(c.standard_missing_pairs ?? 0) + Number(c.standard_doubtful_pairs ?? 0),
              costo_reconstruido: false,
              existencia_reconstruida,
              productos_costo_posterior: 0,
            };
          }
          const r = this.reconstruidos.get(this.claveReconstruida(tenantId, c));
          return {
            warehouse_code: a.code, estado, motivo,
            // Sin reconstrucción posible (no debería pasar): se declara sin valor, nunca 0.
            valor_estandar: r?.valor ?? null,
            // Del kardex: los productos que la reconstrucción encontró con existencia, no los de la foto.
            productos_con_existencia: existencia_reconstruida ? (r ? r.productos : null) : c.pares,
            productos_sin_valuar: r ? r.sin_valuar : null,
            costo_reconstruido: true,
            existencia_reconstruida,
            productos_costo_posterior: r ? r.costo_posterior : null,
          };
        });
        return { fecha, ...banderasDeCierre(fecha), celdas, total: totalDelDia(celdas) };
      });

      const motivos = [rango.motivo, desconocidos.length ? `sin almacén con el código ${desconocidos.join(', ')}` : null]
        .filter((m): m is string => !!m);
      const out: ExistenciaHistorico = {
        desde, hasta,
        rango: {
          pedido_desde: q.desde ?? null,
          pedido_hasta: q.hasta ?? null,
          ajustado: motivos.length > 0,
          motivo: motivos.length ? motivos.join(' · ') : null,
        },
        almacenes, dias,
        metodo: {
          costo: 'estandar_kepler_sin_impuesto',
          historia_estandar_desde: meta.historia ?? null,
          foto_desde: fotoDesde,
          cedis_kardex_desde: cedis?.desde ?? null,
        },
        ultima_foto: {
          fecha: meta.ultima ?? null,
          hecha_en: meta.hecha_en ? new Date(meta.hecha_en).toISOString() : null,
          estado: meta.estado ?? null,
          nota: meta.nota ?? null,
        },
      };
      return out;
    });
  }

  /** La huella de la foto entra en la clave: un día re-tomado no sirve su valor viejo. */
  private claveReconstruida(tenantId: string, c: FilaCobertura): string {
    return `${tenantId}|${c.fecha}|${c.warehouse_id}|${c.pares}|${c.unidades_total ?? ''}`;
  }

  /**
   * `[EX.H4]` El CEDIS y su corte de Wincaja a Kepler, si ya opera en Kepler (`kepler_code` puesto y
   * corte registrado). `null` = no hay kardex en el que apoyarse: sus días congelados siguen
   * `no_confiable`.
   */
  private async leerCedisKepler(trx: Knex.Transaction, tenantId: string): Promise<CedisKepler | null> {
    const { rows } = await trx.raw(
      `SELECT w.id AS warehouse_id, w.kepler_code AS sucursal, min(c.cutover_date)::date::text AS desde
         FROM commercial.warehouses w
         JOIN analytics.v_branch_erp_cutover c ON c.tenant_id = w.tenant_id AND c.kepler_code = w.kepler_code
        WHERE w.tenant_id = ? AND w.code = ? AND w.deleted_at IS NULL AND w.kepler_code IS NOT NULL
        GROUP BY w.id, w.kepler_code`,
      [tenantId, HISTORICO_CEDIS],
    );
    const r = rows[0];
    if (!r?.desde || !FECHA_RX.test(r.desde) || !SUCURSAL_RX.test(String(r.sucursal)) || !UUID_RX.test(r.warehouse_id)) {
      return null;
    }
    return { warehouse_id: r.warehouse_id, sucursal: String(r.sucursal), desde: r.desde };
  }

  /** `[EX.H4]` Los días de `faltan` cuya existencia del CEDIS sale del kardex. */
  private kardexDe(faltan: FilaCobertura[], cedis: CedisKepler | null): KardexCedis | null {
    if (!cedis) return null;
    const fechas = faltan
      .filter((f) => f.warehouse_id === cedis.warehouse_id
        && (f.stock_source ?? HISTORICO_FUENTE_VIEJA) === HISTORICO_FUENTE_VIEJA
        && f.fecha >= cedis.desde)
      .map((f) => f.fecha);
    return fechas.length ? { ...cedis, fechas: [...new Set(fechas)].sort() } : null;
  }

  /**
   * La cobertura del rango. Si la base todavía no tiene las columnas de EX.H0, salen NULL y todo el
   * rango se reconstruye — el código y el DDL viajan por caminos distintos.
   */
  private async leerCobertura(
    trx: Knex.Transaction, tenantId: string, desde: string, hasta: string, ids: string[],
  ): Promise<FilaCobertura[]> {
    const { rows: col } = await trx.raw(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'analytics' AND table_name = 'stock_snapshot_coverage'
          AND column_name IN ('stock_source', 'standard_value_known', 'standard_missing_pairs', 'standard_doubtful_pairs')`,
    );
    const exH0 = Number(col[0]?.n) === 4;
    const nuevas = exH0
      ? 'c.stock_source, c.standard_value_known, c.standard_missing_pairs, c.standard_doubtful_pairs'
      : `'commercial.stock'::text AS stock_source, NULL::numeric AS standard_value_known,
         NULL::int AS standard_missing_pairs, NULL::int AS standard_doubtful_pairs`;
    const { rows } = await trx.raw(
      `SELECT c.fecha_corte::text AS fecha, c.warehouse_id, c.pares, c.unidades_total::text AS unidades_total, ${nuevas}
         FROM analytics.stock_snapshot_coverage c
        WHERE c.tenant_id = ? AND c.fecha_corte BETWEEN ? AND ? AND c.warehouse_id = ANY(?::uuid[])`,
      [tenantId, desde, hasta, ids],
    );
    return rows.map((r: FilaCobertura) => ({ ...r, pares: Number(r.pares) }));
  }

  /**
   * `[EX.H1]` El desglose de UNA celda: los productos de un almacén en un día, con su existencia,
   * su costo estándar y su valor, y los que no suman con su motivo. Es lo que se abre al tocar una
   * cifra de la tabla — una cifra que no se puede recorrer no se puede revisar (Q.3/Q.4).
   * La suma de `productos[].valor` es la MISMA que la celda: sale del mismo dato (la foto con su
   * estándar guardado) o de la MISMA consulta de reconstrucción (`sqlValuada`).
   */
  async detalle(q: { fecha?: string; almacen?: string }): Promise<ExistenciaHistoricoDetalle> {
    const tenantId = this.tenantCtx.requireTenantId();
    const hoy = todayMx();
    const fecha = String(q.fecha ?? '').trim();
    const codigo = String(q.almacen ?? '').trim();
    if (!FECHA_RX.test(fecha) || rangoHistorico({ desde: fecha, hasta: fecha }, hoy).ajustado) {
      throw new BadRequestException('fecha inválida: se espera AAAA-MM-DD, no posterior a hoy');
    }
    if (!codigo) throw new BadRequestException('falta el almacén');

    return this.tk.run(tenantId, async (trx) => {
      await trx.raw('SET LOCAL jit = off');
      const alm: { id: string; code: string; name: string; label: string } | undefined =
        await trx('commercial.warehouses as w')
          .where({ 'w.tenant_id': tenantId, 'w.code': codigo })
          .whereNull('w.deleted_at')
          .first('w.id', 'w.code', 'w.name', trx.raw('COALESCE(w.short_label, w.code) AS label'));
      if (!alm) throw new NotFoundException('Sin almacén con ese código.');

      const fotoDesde: string | null = (await trx.raw(
        `SELECT min(fecha_corte)::text AS f FROM analytics.stock_snapshot_coverage WHERE tenant_id = ?`, [tenantId],
      )).rows[0]?.f ?? null;
      const [c] = await this.leerCobertura(trx, tenantId, fecha, fecha, [alm.id]);
      const cedis = await this.leerCedisKepler(trx, tenantId);
      const { estado, motivo, existencia_reconstruida } = estadoCelda({
        cubierto: !!c, warehouse_code: alm.code, stock_source: c?.stock_source ?? null,
        fecha, hoy, foto_desde: fotoDesde, kardex_desde: cedis?.desde ?? null,
      });
      const base = {
        fecha, almacen: { code: alm.code, name: alm.name, label: alm.label }, estado, motivo, existencia_reconstruida,
      };
      if (!c) {
        return { ...base, costo_reconstruido: false, productos: [], valor_estandar: null, productos_sin_valuar: 0 };
      }

      type Crudo = {
        product_id: string; sku: string | null; nombre: string | null; unidades: string; unidad: string | null;
        costo: string | null; dudosa: boolean; posterior: boolean;
      };
      let crudos: Crudo[];
      const reconstruido = c.standard_value_known == null;
      if (!reconstruido) {
        // Desde EX.H0: lo que la foto guardó, tal cual.
        crudos = (await trx.raw(
          `SELECT s.product_id, pr.sku, pr.nombre, s.unidades::text AS unidades, NULL::text AS unidad,
                  s.standard_unit_cost::text AS costo,
                  (s.standard_cost_rule = 'doubtful_unit') AS dudosa, false AS posterior
             FROM analytics.stock_snapshots s
             LEFT JOIN catalog.products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
            WHERE s.tenant_id = ? AND s.fecha_corte = ? AND s.warehouse_id = ?`,
          [tenantId, fecha, alm.id],
        )).rows;
      } else {
        // El mismo camino que la tabla: si la celda sale del kardex, el desglose también.
        const kardex = existencia_reconstruida ? this.kardexDe([c], cedis) : null;
        const sql = this.sqlValuada(tenantId, fecha, fecha, [alm.id], kardex);
        await trx.raw('SET LOCAL enable_nestloop = off');
        crudos = (await trx.raw(`${sql}
          SELECT v.product_id, v.sku, v.nombre, v.unidades::text AS unidades, v.unidad,
                 v.costo_estandar::text AS costo, v.unidad_dudosa AS dudosa,
                 COALESCE(v.costo_posterior, false) AS posterior
            FROM valuada v`)).rows;
        await trx.raw('SET LOCAL enable_nestloop = on');
      }

      const productos: HistoricoDetalleProducto[] = crudos.map((r): HistoricoDetalleProducto => {
        const unidades = Number(r.unidades);
        const costo = r.costo == null ? null : Number(r.costo);
        return {
          product_id: r.product_id,
          sku: r.sku ?? '',
          nombre: r.nombre ?? '',
          unidades,
          unidad: r.unidad ?? null,
          costo_estandar: costo,
          valor: costo == null ? null : Math.round(unidades * costo * 100) / 100,
          sin_valor: costo != null ? null : r.dudosa ? 'unidad_dudosa' : 'sin_estandar',
          costo_posterior: costo != null && !!r.posterior,
        };
      }).sort((a, b) => (b.valor ?? -Infinity) - (a.valor ?? -Infinity) || a.sku.localeCompare(b.sku));

      const valuados = productos.filter((p) => p.valor != null);
      const suma = valuados.reduce((s, p) => s + (p.valor as number), 0);
      return {
        ...base,
        costo_reconstruido: reconstruido,
        productos,
        // Sin productos con existencia el almacén vale 0 de verdad; con productos y ninguno
        // valuado, no se sabe cuánto vale: null, nunca 0.
        valor_estandar: productos.length === 0 ? 0 : valuados.length ? Math.round(suma * 100) / 100 : null,
        productos_sin_valuar: productos.length - valuados.length,
      };
    });
  }

  /**
   * El estándar vigente cada día, para los días anteriores a EX.H0. Es la consulta validada del
   * 2026-11-04, por almacén × día. ⛔ Con literales y sin nested loop (ver el encabezado de la clase).
   */
  private async reconstruir(
    trx: Knex.Transaction, tenantId: string, faltan: FilaCobertura[], cedis: CedisKepler | null,
  ): Promise<void> {
    const fechas = faltan.map((f) => f.fecha).sort();
    const ids = [...new Set(faltan.map((f) => f.warehouse_id))];
    const d0 = fechas[0];
    const d1 = fechas[fechas.length - 1];
    const t0 = Date.now();
    const kardex = this.kardexDe(faltan, cedis);
    const sql = this.sqlValuada(tenantId, d0, d1, ids, kardex);
    await trx.raw('SET LOCAL enable_nestloop = off');
    const { rows } = await trx.raw(`${sql}
      SELECT fecha_corte::text AS fecha, warehouse_id,
             sum(unidades * costo_estandar)                            AS valor,
             count(*)::int                                             AS productos,
             count(*) FILTER (WHERE costo_estandar IS NULL)::int       AS sin_valuar,
             count(*) FILTER (WHERE costo_posterior)::int              AS costo_posterior
        FROM valuada
       GROUP BY 1, 2`);
    await trx.raw('SET LOCAL enable_nestloop = on');
    const huella = new Map(faltan.map((f) => [`${f.fecha}|${f.warehouse_id}`, f] as const));
    for (const r of rows) {
      const c = huella.get(`${r.fecha}|${r.warehouse_id}`);
      if (!c) continue; // un almacén×día del lapso que ya tenía su estándar guardado
      this.reconstruidos.set(this.claveReconstruida(tenantId, c), {
        valor: r.valor == null ? null : Math.round(Number(r.valor) * 100) / 100,
        productos: Number(r.productos),
        sin_valuar: Number(r.sin_valuar),
        costo_posterior: Number(r.costo_posterior),
      });
    }
    // Un día del kardex sin ningún producto con existencia no trae renglón: vale 0 (medido), no «sin valor».
    // Pero sólo si el kardex devolvió algo en este lote: si ningún día del CEDIS trajo renglón, lo más
    // probable es que la lectura falló (kdil vacío), no que el CEDIS se vació — se deja «sin valor» y
    // se reintenta en la siguiente consulta (ADR-056: lo no medido no se dibuja como cero).
    const kardexRespondio = !!kardex && rows.some((r: { warehouse_id: string }) => r.warehouse_id === kardex.warehouse_id);
    if (kardex && !kardexRespondio) {
      this.logger.warn(`historico: el kardex del CEDIS no devolvió ningún renglón para ${kardex.fechas.length} días; quedan sin valor`);
    }
    if (kardex && kardexRespondio) {
      for (const f of faltan) {
        if (f.warehouse_id !== kardex.warehouse_id || !kardex.fechas.includes(f.fecha)) continue;
        const clave = this.claveReconstruida(tenantId, f);
        if (!this.reconstruidos.has(clave)) {
          this.reconstruidos.set(clave, { valor: 0, productos: 0, sin_valuar: 0, costo_posterior: 0 });
        }
      }
    }
    this.logger.log(`historico: ${faltan.length} almacén×día reconstruidos (${d0}…${d1}`
      + `${kardex ? `; CEDIS del kardex: ${kardex.fechas.length} días` : ''}) en ${Date.now() - t0} ms`);
  }

  /**
   * La cadena de CTEs que termina en `valuada` (una fila por producto × almacén × día con su estándar
   * vigente), compartida por la tabla (agregada) y el desglose (por producto): una sola consulta de
   * reconstrucción, para que la suma del desglose no pueda diferir de la celda.
   * ⛔ Literales validados contra su forma antes de tocar el SQL (ver el encabezado de la clase).
   */
  private sqlValuada(tenantId: string, d0: string, d1: string, ids: string[], kardex: KardexCedis | null = null): string {
    if (!UUID_RX.test(tenantId) || !FECHA_RX.test(d0) || !FECHA_RX.test(d1) || !ids.length || !ids.every((i) => UUID_RX.test(i))) {
      throw new Error('historico: tenant, fecha o almacén con forma inválida');
    }
    if (kardex && (!UUID_RX.test(kardex.warehouse_id) || !SUCURSAL_RX.test(kardex.sucursal) || !FECHA_RX.test(kardex.desde)
      || !kardex.fechas.length || !kardex.fechas.every((f) => FECHA_RX.test(f)))) {
      throw new Error('historico: kardex del CEDIS con forma inválida');
    }
    const T = `'${tenantId}'`;
    const lista = ids.map((i) => `'${i}'`).join(',');
    const K = kardex ? `'${kardex.sucursal}'` : '';
    const diasK = kardex ? kardex.fechas.map((f) => `DATE '${f}'`).join(',') : '';
    // `[EX.H4]` La existencia del CEDIS en sus días congelados, del kardex (ver el encabezado de la clase):
    // la de HOY en kdil menos lo que se movió DESPUÉS de cada día, sin documentos cancelados.
    const ctesKardex = kardex ? `
      kx_mov AS (
        SELECT btrim(j.c3) AS sku, j.c10::date AS f,
               sum(CASE j.c30 WHEN 'E' THEN j.c11 WHEN 'S' THEN -j.c11 ELSE 0 END) AS q
          FROM kepler_ods.kdij j
          LEFT JOIN kepler_ods.kdm1 m
                 ON m.sucursal = j.sucursal AND m.c1 = j.c1 AND m.c2 = j.c4 AND m.c3 = j.c5
                AND btrim(m.c4::text) = btrim(j.c6::text) AND btrim(m.c5::text) = btrim(j.c7::text) AND m.c6 = j.c8
         WHERE j.sucursal = ${K} AND j.c1 = ${K} AND j.c2 = 1
           AND j.c10 >= DATE '${kardex.desde}'
           AND btrim(coalesce(m.c43::text, '')) <> 'C'
         GROUP BY 1, 2
      ),
      kx_hoy AS (
        SELECT btrim(k.c3) AS sku, sum(k.c4 + k.c8 - k.c9) AS q
          FROM kepler_ods.kdil k
         WHERE k.sucursal = ${K} AND k.c1 = ${K} AND btrim(k.c3) <> ALL (ARRAY['00001', '00002', '00022'])
         GROUP BY 1
      ),
      kx_prim AS (SELECT sku, min(f) AS p FROM kx_mov GROUP BY 1),
      kx_dias AS (SELECT unnest(ARRAY[${diasK}]::date[]) AS d),
      kx_despues AS (
        SELECT d.d, m.sku, sum(m.q) AS q FROM kx_dias d JOIN kx_mov m ON m.f > d.d GROUP BY 1, 2
      ),
      kardex AS (
        SELECT d.d AS fecha_corte, w.id AS warehouse_id, pr.id AS product_id, w.kepler_code AS sucursal,
               pr.sku, pr.nombre, round((h.q - COALESCE(x.q, 0))::numeric, 4) AS unidades
          FROM kx_dias d
          JOIN kx_prim p ON p.p <= d.d
          JOIN kx_hoy h  ON h.sku = p.sku
          LEFT JOIN kx_despues x ON x.d = d.d AND x.sku = h.sku
          JOIN commercial.warehouses w ON w.tenant_id = ${T} AND w.id = '${kardex.warehouse_id}'
          JOIN catalog.products pr     ON pr.tenant_id = w.tenant_id AND pr.sku = h.sku AND pr.deleted_at IS NULL
         WHERE round((h.q - COALESCE(x.q, 0))::numeric, 4) > 0
      ),` : '';
    return `
      WITH ${ctesKardex}
      foto AS (
        SELECT s.fecha_corte, s.warehouse_id, s.product_id, w.kepler_code AS sucursal, pr.sku, pr.nombre, s.unidades
          FROM analytics.stock_snapshots s
          JOIN commercial.warehouses w ON w.tenant_id = s.tenant_id AND w.id = s.warehouse_id
          JOIN catalog.products pr     ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
         WHERE s.tenant_id = ${T}
           AND s.fecha_corte BETWEEN DATE '${d0}' AND DATE '${d1}'
           AND s.warehouse_id IN (${lista})
           ${kardex ? `AND NOT (s.warehouse_id = '${kardex.warehouse_id}' AND s.fecha_corte IN (${diasK}))` : ''}
        ${kardex ? `UNION ALL
        SELECT fecha_corte, warehouse_id, product_id, sucursal, sku, nombre, unidades FROM kardex` : ''}
      ),
      -- Testigo de la unidad: el costo del ERP por sucursal × SKU, en la unidad de la existencia.
      testigo AS (
        SELECT warehouse_code AS sucursal, sku, costo_erp
          FROM analytics.v_erp_unit_cost
         WHERE tenant_id = ${T} AND erp = 'kepler' AND costo_erp > 0
      ),
      -- El peldaño del estándar más cercano al testigo (escala log: 2× arriba = 2× abajo).
      -- ⛔ El desempate es FIJO (la fila más reciente, luego el nombre de la unidad): 155 sucursal×SKU
      -- tienen dos unidades al MISMO costo (CJA = PAQ, KG = PAQ…) y sin desempate el planificador
      -- elegía una u otra — un día pasado cambiaba de valor (hasta 1.85 %) sólo por cambiar de plan.
      peldano AS (
        SELECT DISTINCT ON (h.sucursal, h.sku)
               h.sucursal, h.sku, h.unidad, abs(ln(h.costo_sin_impuesto / t.costo_erp)) AS distancia
          FROM analytics.product_cost_history h
          JOIN testigo t ON t.sucursal = h.sucursal AND t.sku = h.sku
         WHERE h.tenant_id = ${T} AND h.costo_sin_impuesto > 0
         ORDER BY h.sucursal, h.sku, abs(ln(h.costo_sin_impuesto / t.costo_erp)), h.valid_from DESC, h.unidad
      ),
      unidad_base AS (
        SELECT DISTINCT sucursal, sku, unidad_base FROM analytics.v_kepler_standard_cost
      ),
      unidad AS (
        SELECT COALESCE(p.sucursal, b.sucursal) AS sucursal,
               COALESCE(p.sku, b.sku)           AS sku,
               CASE WHEN p.sku IS NULL       THEN b.unidad_base   -- sin testigo: lo que declara Kepler
                    WHEN p.distancia < ln(2) THEN p.unidad        -- casa con el ERP
                    ELSE NULL END            AS unidad,           -- dudosa: no se valúa
               (p.sku IS NOT NULL AND p.distancia >= ln(2)) AS dudosa
          FROM peldano p
          FULL JOIN unidad_base b ON b.sucursal = p.sucursal AND b.sku = p.sku
      ),
      -- La historia del estándar en ese peldaño, con su vigencia [valid_from, valid_to).
      estandar AS (
        SELECT h.sucursal, h.sku, h.costo_sin_impuesto, h.valid_from,
               LEAD(h.valid_from) OVER w AS valid_to,
               ROW_NUMBER()       OVER w AS n
          FROM analytics.product_cost_history h
          JOIN unidad u ON u.sucursal = h.sucursal AND u.sku = h.sku AND u.unidad = h.unidad
         WHERE h.tenant_id = ${T}
        WINDOW w AS (PARTITION BY h.sucursal, h.sku ORDER BY h.valid_from)
      ),
      valuada AS (
        SELECT f.fecha_corte, f.warehouse_id, f.product_id, f.sku, f.nombre, f.unidades, u.unidad,
               e.costo_sin_impuesto AS costo_estandar,
               (e.valid_from > f.fecha_corte) AS costo_posterior,
               COALESCE(u.dudosa, false)      AS unidad_dudosa
          FROM foto f
          LEFT JOIN unidad u ON u.sucursal = f.sucursal AND u.sku = f.sku
          LEFT JOIN estandar e
                 ON e.sucursal = f.sucursal AND e.sku = f.sku
                AND (f.fecha_corte >= e.valid_from OR e.n = 1)   -- antes de la historia: el primero
                AND (e.valid_to IS NULL OR f.fecha_corte < e.valid_to)
      )`;
  }
}
