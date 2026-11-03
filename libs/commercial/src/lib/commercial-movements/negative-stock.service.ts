import type { Knex } from 'knex';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService, ScopeService, branchKeySql, todayMx } from '@megadulces/platform-core';
import {
  CAUSAS_ACTIVAS, DOCS_AGRUPADOS_POR_CAJA, analizarKardex, clasificarNegativo, describirNegativo, ordenarNegativos,
  reaperturaNegativo, recortarKardex, validarResolucionNegativo,
  type CausaNegativo, type EstadoNegativo, type ExistenciaNegativaItem, type ExistenciaNegativaResponse,
  type KardexNegativoResponse, type MotivoNegativo, type MovimientoKardex, type ResolucionNegativo,
} from '@megadulces/contracts';

/**
 * `[MX.2.8]` — **Existencia en negativo: la sección de Prevención en `/almacen/incidencias`.**
 *
 * Lee dos vistas de `[MX.0.5]` EN PARALELO (dos conexiones) y las cruza aquí: juntas en una sola
 * consulta el planeador cae en ciclos anidados sobre `kdm2` (medido: de 450 ms a > 60 s según qué se
 * agregue; la tabla de tiempos está en la migración `20261103112931`). ⛔ No unificarlas en un JOIN.
 *
 *   analytics.v_kepler_negative_stock      ~150 ms en el servidor (kdil, 3,030 filas el 2026-11-03)
 *   analytics.v_kepler_unapplied_receipts  ~220 ms en el servidor (vales sin orden de entrada)
 *
 * Alcance (D10, Edgar 2026-11-03): Prevención ve la red; el encargado de tienda (`warehouse: own`)
 * sólo su sucursal. Se recorta en SQL con la llave canónica de sucursal (`branchKeySql`), no en la
 * pantalla. `none` = no ve nada (fail-closed).
 *
 * Costo: el de Kepler de ESA sucursal (`mv_kepler_unit_cost`, el mismo primitivo que la pantalla de
 * Existencia). Sin costo = `null`, nunca 0: el valor se declara incompleto (`sin_costo`).
 */

interface FilaNegativo {
  warehouse_id: string;
  kepler_code: string;
  sucursal: string;
  sku: string;
  product_id: string | null;
  producto: string | null;
  existencia: number;
  ult_entrada: string | null;
  ult_salida: string | null;
  costo_unitario: number | null;
  resolution_reason: MotivoNegativo | null;
  note: string | null;
  resolved_by_name: string | null;
  resolved_day: string | null;
  qty_at_resolution: number | null;
}

interface FilaVale {
  warehouse_id: string;
  sku: string;
  piezas: number;
  desde: string | null;
  folios: string | null;
}

export interface NegativeStockQuery {
  warehouse_ids?: string[];
  estado?: EstadoNegativo;
  /** Vacío = las causas activas (D9: el rezago se pide aparte). */
  causas?: CausaNegativo[];
  search?: string;
  page?: number;
  pageSize?: number;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAUSAS: readonly CausaNegativo[] = ['entrada_sin_aplicar', 'salio_sin_existencia', 'rezago'];

@Injectable()
export class NegativeStockService {
  private readonly logger = new Logger(NegativeStockService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  /** Códigos de sucursal visibles, o `null` = todas. Fuera de `tk.run` (ScopeService usa su conexión). */
  private async sucursalesVisibles(): Promise<string[] | null> {
    const d = (await this.scope.current()).dims.warehouse;
    return d.mode === 'all' ? null : d.values;
  }

  async list(q: NegativeStockQuery): Promise<ExistenciaNegativaResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const t0 = Date.now();
    const codes = await this.sucursalesVisibles();
    const wh = (q.warehouse_ids ?? []).filter((x) => UUID_RX.test(x));
    const hoy = todayMx();

    // Posicionales con cast: `= ANY(?::text[])` recibe el arreglo como UN parámetro (patrón de
    // commercial-analytics). Con nombrados, `:codes::text[]` se leería como identificador `:codes:`.
    // Sólo el ALCANCE va en SQL (seguridad); el filtro de sucursal elegido se aplica abajo, para que
    // `por_sucursal` cuente todo lo que la persona puede ver y no sólo lo que eligió.
    const filtro = (alias: string): { sql: string; binds: Knex.RawBinding[] } => {
      const partes: string[] = [`${alias}.tenant_id = ?`];
      const binds: Knex.RawBinding[] = [tenantId];
      if (codes) { partes.push(`(${branchKeySql('w')}) = ANY(?::text[])`); binds.push(codes); }
      return { sql: partes.join(' AND '), binds };
    };
    const fn = filtro('n');
    const fv = filtro('v');

    const [negativos, vales] = await Promise.all([
      this.tk.run(tenantId, async (trx) => {
        const ax = await trx.raw(`SELECT to_regclass('analytics.mv_kepler_unit_cost') AS kc`);
        const FUENTE_KC = ax.rows?.[0]?.kc ? 'analytics.mv_kepler_unit_cost' : 'analytics.v_kepler_unit_cost';
        const { rows } = await trx.raw(`
          SELECT n.warehouse_id, n.kepler_code, w.name AS sucursal, n.sku, n.product_id, p.nombre AS producto,
                 n.existencia::float8 AS existencia,
                 to_char(n.ult_entrada, 'YYYY-MM-DD') AS ult_entrada,
                 to_char(n.ult_salida, 'YYYY-MM-DD')  AS ult_salida,
                 kc.costo_unitario::float8 AS costo_unitario,
                 r.resolution_reason, r.note, r.resolved_by_name,
                 to_char(r.resolved_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS resolved_day,
                 r.qty_at_resolution::float8 AS qty_at_resolution
            FROM analytics.v_kepler_negative_stock n
            JOIN commercial.warehouses w ON w.tenant_id = n.tenant_id AND w.id = n.warehouse_id
            LEFT JOIN catalog.products p ON p.tenant_id = n.tenant_id AND p.id = n.product_id
            LEFT JOIN ${FUENTE_KC} kc
                   ON kc.tenant_id = n.tenant_id AND kc.warehouse_id = n.warehouse_id AND kc.product_id = n.product_id
            LEFT JOIN commercial.negative_stock_reviews r
                   ON r.tenant_id = n.tenant_id AND r.warehouse_id = n.warehouse_id AND r.sku = n.sku
                  AND r.deleted_at IS NULL
           WHERE ${fn.sql}`, fn.binds);
        return rows as FilaNegativo[];
      }),
      this.tk.run(tenantId, async (trx) => {
        const { rows } = await trx.raw(`
          SELECT v.warehouse_id, v.sku, v.piezas::float8 AS piezas,
                 to_char(v.desde, 'YYYY-MM-DD') AS desde, v.folios
            FROM analytics.v_kepler_unapplied_receipts v
            JOIN commercial.warehouses w ON w.tenant_id = v.tenant_id AND w.id = v.warehouse_id
           WHERE ${fv.sql}`, fv.binds);
        return rows as FilaVale[];
      }),
    ]);

    const valePor = new Map(vales.map((v) => [`${v.warehouse_id}|${v.sku}`, v]));
    const items: ExistenciaNegativaItem[] = negativos.map((n) => {
      const v = valePor.get(`${n.warehouse_id}|${n.sku}`) ?? null;
      const k = {
        existencia: n.existencia, ult_entrada: n.ult_entrada, ult_salida: n.ult_salida,
        vale_piezas: v?.piezas ?? null, vale_desde: v?.desde ?? null,
        vale_folios: v?.folios ? v.folios.split(',') : [],
      };
      const c = clasificarNegativo(k, hoy);
      const resolucion: ResolucionNegativo | null = n.resolution_reason
        ? {
            motivo: n.resolution_reason, nota: n.note, por: n.resolved_by_name,
            fecha: n.resolved_day as string, existencia_vista: Number(n.qty_at_resolution),
          }
        : null;
      const costo = n.costo_unitario != null && n.costo_unitario > 0 ? n.costo_unitario : null;
      return {
        warehouse_id: n.warehouse_id, kepler_code: n.kepler_code, sucursal: n.sucursal,
        sku: n.sku, product_id: n.product_id, producto: n.producto,
        existencia: n.existencia, costo_unitario: costo,
        valor: costo == null ? null : Math.round(-n.existencia * costo * 100) / 100,
        ult_entrada: n.ult_entrada, ult_salida: n.ult_salida,
        causa: c.causa, donde: describirNegativo(k, c),
        vale: v ? { piezas: v.piezas, desde: v.desde, folios: k.vale_folios } : null,
        quedaria: c.quedaria,
        resolucion,
        reabierta: resolucion ? reaperturaNegativo(resolucion, k) : null,
      };
    });

    const resuelta = (i: ExistenciaNegativaItem) => !!i.resolucion && !i.reabierta;

    const porSuc = new Map<string, { warehouse_id: string; sucursal: string; n: number; valor: number }>();
    for (const i of items) {
      if (resuelta(i) || !CAUSAS_ACTIVAS.includes(i.causa)) continue;
      const b = porSuc.get(i.warehouse_id) ?? { warehouse_id: i.warehouse_id, sucursal: i.sucursal, n: 0, valor: 0 };
      b.n++; b.valor += i.valor ?? 0;
      porSuc.set(i.warehouse_id, b);
    }
    const porSucursal = [...porSuc.values()]
      .map((b) => ({ ...b, valor: Math.round(b.valor * 100) / 100 }))
      .sort((a, b) => b.valor - a.valor || a.sucursal.localeCompare(b.sucursal));

    const enSeleccion = wh.length ? items.filter((i) => wh.includes(i.warehouse_id)) : items;
    const porCausa = Object.fromEntries(CAUSAS.map((c) => [c, { n: 0, valor: 0, sin_costo: 0 }])) as ExistenciaNegativaResponse['totals']['por_causa'];
    let resueltas = 0;
    for (const i of enSeleccion) {
      if (resuelta(i)) { resueltas++; continue; }
      const b = porCausa[i.causa];
      b.n++;
      if (i.valor == null) b.sin_costo++; else b.valor += i.valor;
    }
    for (const c of CAUSAS) porCausa[c].valor = Math.round(porCausa[c].valor * 100) / 100;

    const estado: EstadoNegativo = q.estado === 'resueltas' ? 'resueltas' : 'pendientes';
    const causas = (q.causas ?? []).filter((c) => CAUSAS.includes(c));
    const filtroCausas = causas.length ? causas : CAUSAS_ACTIVAS;
    const s = (q.search ?? '').trim().toLowerCase();
    const filtradas = ordenarNegativos(enSeleccion.filter((i) =>
      (estado === 'resueltas' ? resuelta(i) : !resuelta(i))
      && (estado === 'resueltas' || filtroCausas.includes(i.causa))
      && (!s || i.sku.toLowerCase().includes(s) || (i.producto ?? '').toLowerCase().includes(s))));

    const pageSize = Math.min(Math.max(Number(q.pageSize) || 50, 1), 200);
    const page = Math.max(Number(q.page) || 1, 1);
    this.logger.log(`existencia negativa: ${items.length} en alcance, ${vales.length} vales, ${Date.now() - t0} ms`);
    return {
      alcance: codes ? 'propias' : 'todas',
      totals: {
        universo: enSeleccion.length, pendientes: enSeleccion.length - resueltas, resueltas,
        por_causa: porCausa, por_sucursal: porSucursal,
      },
      page, pageSize, total: filtradas.length,
      rows: filtradas.slice((page - 1) * pageSize, page * pageSize),
    };
  }

  /**
   * Resolver: guarda motivo, nota, quién y la existencia que vio. Sólo se puede resolver lo que HOY
   * está en negativo en Kepler y dentro del alcance de quien resuelve; la existencia vista se lee del
   * dato, no del payload (la pantalla podría traer una foto vieja).
   */
  async resolve(dto: { warehouse_id: string; sku: string; motivo: string; nota?: string | null }): Promise<ResolucionNegativo> {
    const tenantId = this.tenantCtx.requireTenantId();
    const ctx = this.tenantCtx.get();
    const error = validarResolucionNegativo(dto.motivo, dto.nota);
    if (error) throw new BadRequestException(error);
    if (!UUID_RX.test(dto.warehouse_id ?? '') || !(dto.sku ?? '').trim()) throw new BadRequestException('Falta la sucursal o el producto.');
    const sku = dto.sku.trim();
    const nota = dto.nota?.trim() || null;
    const actual = await this.existenciaActual(tenantId, dto.warehouse_id, sku);
    return this.tk.run(tenantId, async (trx) => {
      const { rows } = await trx.raw(`
        INSERT INTO commercial.negative_stock_reviews
               (tenant_id, warehouse_id, sku, qty_at_resolution, resolution_reason, note,
                resolved_by, resolved_by_name, resolved_at, created_by, updated_by)
        VALUES (:t, :wh, :sku, :qty, :motivo, :nota, :uid, :uname, now(), :uid, :uid)
        ON CONFLICT (tenant_id, warehouse_id, sku) WHERE deleted_at IS NULL
        DO UPDATE SET qty_at_resolution = EXCLUDED.qty_at_resolution, resolution_reason = EXCLUDED.resolution_reason,
                      note = EXCLUDED.note, resolved_by = EXCLUDED.resolved_by, resolved_by_name = EXCLUDED.resolved_by_name,
                      resolved_at = now(), updated_at = now(), updated_by = EXCLUDED.updated_by
        RETURNING resolution_reason, note, resolved_by_name, qty_at_resolution::float8 AS qty,
                  to_char(resolved_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS dia`,
      {
        t: tenantId, wh: dto.warehouse_id, sku, qty: actual, motivo: dto.motivo, nota,
        uid: ctx?.userId && UUID_RX.test(ctx.userId) ? ctx.userId : null, uname: ctx?.username ?? null,
      });
      const r = rows[0];
      return { motivo: r.resolution_reason, nota: r.note, por: r.resolved_by_name, fecha: r.dia, existencia_vista: Number(r.qty) };
    });
  }

  /** Reabrir: la resolución viva pasa a historia (`deleted_at`). Si sigue en negativo, vuelve a pendientes. */
  async reopen(dto: { warehouse_id: string; sku: string }): Promise<{ reabierta: boolean }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const ctx = this.tenantCtx.get();
    if (!UUID_RX.test(dto.warehouse_id ?? '') || !(dto.sku ?? '').trim()) throw new BadRequestException('Falta la sucursal o el producto.');
    await this.assertEnAlcance(tenantId, dto.warehouse_id);
    return this.tk.run(tenantId, async (trx) => {
      const n = await trx('commercial.negative_stock_reviews')
        .where({ tenant_id: tenantId, warehouse_id: dto.warehouse_id, sku: dto.sku.trim() })
        .whereNull('deleted_at')
        .update({
          deleted_at: trx.fn.now(), updated_at: trx.fn.now(),
          deleted_by: ctx?.userId && UUID_RX.test(ctx.userId) ? ctx.userId : null,
        });
      return { reabierta: n > 0 };
    });
  }

  /**
   * `[MX.2.9]` El kardex de un producto en una sucursal, con saldo corrido, día de cruce y pistas
   * (`analizarKardex`, MX.1.9). Lee `kdm2` en vivo: es UN producto, no un dataset, así que no lleva vista.
   *
   * ⚠️ Cuatro ramas UNION ALL a propósito: `kdm2` no tiene un índice por SKU para todos los géneros, sólo
   * parciales (U-D, U-A, X-A). En una sola consulta el planeador recorre la sucursal entera por la llave
   * primaria (Morelia Abastos/96868: 6.7 M renglones, 3.3 s). Cada rama con su filtro cae en su índice
   * parcial: 11–205 ms en el servidor (medido 2026-11-03); N y X-D (~157 k renglones) van por la llave.
   * Paridad: el kardex suma lo mismo que Kepler en 286 de 300 negativos activos; los 14 que no, todos
   * en CEDIS y La Piedad Abastos — se declara (`cuadra: false`) y no se calculan cruce ni pistas.
   */
  async kardex(q: { warehouse_id?: string; sku?: string }): Promise<KardexNegativoResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const sku = (q.sku ?? '').trim();
    if (!UUID_RX.test(q.warehouse_id ?? '') || !sku || sku.length > 40) throw new BadRequestException('Falta la sucursal o el producto.');
    await this.assertEnAlcance(tenantId, q.warehouse_id as string);
    const t0 = Date.now();
    return this.tk.run(tenantId, async (trx) => {
      const w = await trx('commercial.warehouses').where({ tenant_id: tenantId, id: q.warehouse_id }).first('kepler_code', 'name');
      if (!w?.kepler_code) throw new BadRequestException('Esa sucursal no tiene código de Kepler.');
      const suc: string = w.kepler_code;
      const [ex, prod] = await Promise.all([
        trx.raw(`SELECT coalesce(sum(c4 + c8 - c9), 0)::float8 AS e FROM kepler_ods.kdil
                  WHERE sucursal = ? AND c1 = ? AND btrim(c3) = ?`, [suc, suc, sku]),
        trx('catalog.products').where({ tenant_id: tenantId }).whereRaw('sku::text = ?', [sku]).whereNull('deleted_at').first('nombre'),
      ]);
      const existencia = Number(ex.rows[0]?.e ?? 0);
      const rama = (filtro: string) => `
        SELECT c2, c3, c4, c5, c6, c9, c13, c32, c55, c58 FROM kepler_ods.kdm2
         WHERE ${filtro} AND btrim(c8) = ? AND sucursal = ? AND c1 = ?`;
      const { rows } = await trx.raw(`
        WITH doc AS (
          -- kdmm repite el catálogo: un nombre por tipo y subtipo, el menor
          SELECT DISTINCT ON (c1, c2, c3::int, c4::int) c1 AS gen, c2 AS nat, c3::int AS tipo, c4::int AS sub, btrim(c5) AS nombre
            FROM kepler_ods.kdmm
           WHERE sucursal = ? AND c8 = 'S'
           ORDER BY c1, c2, c3::int, c4::int, btrim(c5)
        ), lin AS (
          ${rama(`c2 = 'U' AND c3 = 'D'`)}
          UNION ALL ${rama(`c2 = 'U' AND c3 = 'A'`)}
          UNION ALL ${rama(`c2 = 'X' AND c3 = 'A'`)}
          UNION ALL ${rama(`c2 IN ('N', 'X') AND NOT (c2 = 'X' AND c3 = 'A')`)}
        ), mov AS (
          SELECT m.c32::date AS dia, m.c2 AS gen, m.c3 AS nat, m.c4::int AS tipo, m.c5::int AS sub, btrim(m.c6) AS folio,
                 d.nombre, nullif(btrim(m.c55), '') AS unidad, nullif(btrim(m.c58), '')::numeric AS factor,
                 CASE WHEN m.c3 = 'A' THEN m.c9 ELSE -m.c9 END::numeric AS q, m.c13::numeric AS importe
            FROM lin m
            JOIN doc d ON d.gen = m.c2 AND d.nat = m.c3 AND d.tipo = m.c4::int AND d.sub = m.c5::int
        ), agr AS (
          SELECT dia, gen || '-' || nat || '-' || tipo AS doc, sub, min(nombre) AS nombre,
                 CASE WHEN gen || '-' || nat || '-' || tipo = ANY (?::text[]) THEN NULL ELSE folio END AS folio,
                 count(DISTINCT folio)::int AS documentos, sum(q) AS piezas, sum(importe) AS importe, unidad, factor
            FROM mov
           GROUP BY 1, 2, 3, 5, unidad, factor
        )
        SELECT to_char(dia, 'YYYY-MM-DD') AS dia, doc, sub, nombre, folio, documentos,
               piezas::float8 AS piezas, importe::float8 AS importe, unidad, factor::float8 AS factor
          FROM agr
         -- las entradas del día antes que sus salidas: el cruce nunca se fecha antes de tiempo
         ORDER BY dia, (piezas < 0), doc, sub, folio NULLS FIRST, unidad`,
      [suc, sku, suc, suc, sku, suc, suc, sku, suc, suc, sku, suc, suc, [...DOCS_AGRUPADOS_POR_CAJA]]);

      const movs = rows as MovimientoKardex[];
      const a = analizarKardex(movs, existencia);
      const r = recortarKardex(a);
      this.logger.log(`kardex ${suc}/${sku}: ${movs.length} renglones, cuadra=${a.cuadra}, ${a.pistas.length} pistas, ${Date.now() - t0} ms`);
      return {
        ...a,
        warehouse_id: q.warehouse_id as string, sucursal: w.name, sku, producto: prod?.nombre ?? null,
        existencia_kepler: existencia, desde: movs[0]?.dia ?? null,
        renglones: r.renglones, saldo_inicial: r.saldo_inicial, renglones_omitidos: r.omitidos,
      };
    });
  }

  /** La existencia de HOY en Kepler; rechaza lo que no está en negativo o está fuera del alcance. */
  private async existenciaActual(tenantId: string, warehouseId: string, sku: string): Promise<number> {
    await this.assertEnAlcance(tenantId, warehouseId);
    return this.tk.run(tenantId, async (trx) => {
      const r = await trx('analytics.v_kepler_negative_stock')
        .where({ tenant_id: tenantId, warehouse_id: warehouseId, sku })
        .first(trx.raw('existencia::float8 AS existencia'));
      if (!r) throw new BadRequestException(`El producto ${sku} ya no está en negativo en Kepler en esa sucursal.`);
      return Number(r.existencia);
    });
  }

  private async assertEnAlcance(tenantId: string, warehouseId: string): Promise<void> {
    const codes = await this.sucursalesVisibles();
    if (!codes) return;
    const ok = await this.tk.run(tenantId, (trx) => trx('commercial.warehouses as w')
      .where({ 'w.tenant_id': tenantId, 'w.id': warehouseId })
      .whereRaw(`(${branchKeySql('w')}) = ANY(?)`, [codes])
      .first(trx.raw('1 AS x')));
    if (!ok) throw new BadRequestException('Esa sucursal no está en tu alcance.');
  }
}
