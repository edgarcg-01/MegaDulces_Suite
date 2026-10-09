import { Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import type {
  CapturaKeplerEstado,
  CapturaKeplerPedido,
  CapturaKeplerRenglon,
  CapturaKeplerResponse,
} from '@megadulces/contracts';
import { ScopeService, TenantKnexService } from '@megadulces/platform-core';

/** Estatus de Kepler a partir de los cuales Facturación ya hizo su parte. */
const YA_AVANZADO = new Set(['SURTIDO', 'CHECADO', 'EMBARCADO']);
/** Ventana de surtidos que se revisan. Se DECLARA en la respuesta (`dias`), no se esconde. */
export const DIAS_CAPTURA = 30;
const TOL = 0.001;
/** En la unidad base (pesos) Kepler recalcula con su propio factor: medio por ciento de holgura. */
const TOL_RELATIVA = 0.005;

/** Lo mínimo de un renglón surtido para compararlo con Kepler. */
export interface FilaCaptura {
  sku: string | null;
  producto: string | null;
  qty_requested: string | number;
  qty_unit: string | null;
  qty_presentacion: string | number | null;
  unidad_presentacion: string | null;
  qty_allocated: string | number | null;
}

/** Lo que Kepler trae HOY de un producto en el pedido (sumado: puede venir en varios renglones). */
export interface KeplerProducto {
  /** Cuántos renglones de Kepler traen esa clave. */
  n: number;
  /** Suma de `c9`, unidad base. */
  base: number;
  /** Suma de `c56`, en la presentación. Sólo sirve si `unidades` trae UNA. */
  pres: number;
  /** Presentaciones (`c55`) en que viene. */
  unidades: string[];
  descripcion: string | null;
}

interface FilaSuite extends FilaCaptura {
  wave_code: string;
  sucursal: string;
  finished_at: Date;
  order_id: string;
  kepler_sucursal: string;
  kepler_serie: number;
  kepler_folio: string;
  destino_nombre: string | null;
  origen: string | null;
  order_code: string | null;
  surtidor: string | null;
}

const redondea = (n: number): number => Math.round(n * 1000) / 1000;
const esEntero = (n: number): boolean => Math.abs(n - Math.round(n)) <= TOL;

/**
 * Un renglón surtido contra lo que Kepler trae hoy, en la unidad en que Facturación lo teclea.
 *
 * Se compara en la **presentación** de Kepler (3 BTO) cuando se puede: lo surtido da una cantidad
 * entera de ella y Kepler trae esa clave en esa sola presentación. Si no, en la **base** con
 * holgura relativa, porque en pesos (KG/BTO) Kepler recalcula `c9` con su propio factor y una
 * tolerancia fija dejaría el pedido "sin cuadrar" para siempre.
 *
 * `kepler` = null → no se pudo leer Kepler (no se compara, no se inventa).
 */
export function renglonCaptura(f: FilaCaptura, kepler: KeplerProducto | null | undefined, leido: boolean): CapturaKeplerRenglon {
  const pedidoBase = Number(f.qty_requested) || 0;
  const surtidoBase = f.qty_allocated == null ? 0 : Number(f.qty_allocated) || 0;
  const pres = f.qty_presentacion == null ? 0 : Number(f.qty_presentacion);
  const factor = pres > 0 && f.unidad_presentacion ? pedidoBase / pres : 0;
  const k = kepler ?? null;
  const keplerEnPres = !k || (k.unidades.length === 1 && k.unidades[0] === f.unidad_presentacion);
  const usaPres = factor > 0 && esEntero(surtidoBase / factor) && keplerEnPres;

  const unidad = usaPres ? f.unidad_presentacion : f.qty_unit;
  const pedido = usaPres ? pres : pedidoBase;
  const surtido = usaPres ? redondea(surtidoBase / factor) : surtidoBase;
  // Kepler ya no trae la clave = la quitaron (0). Sin lectura de Kepler = no se sabe (null).
  const keplerCant = !leido ? null : !k ? 0 : usaPres ? k.pres : k.base;
  const tol = usaPres ? TOL : Math.max(TOL, TOL_RELATIVA * Math.max(surtidoBase, keplerCant ?? 0));

  return {
    sku: f.sku,
    producto: f.producto,
    unidad,
    pedido,
    surtido,
    falta: Math.max(0, redondea(pedido - surtido)),
    kepler: keplerCant == null ? null : redondea(keplerCant),
    cuadra: keplerCant == null ? null : Math.abs(keplerCant - surtido) <= tol,
    renglones_kepler: k?.n ?? 0,
    extra: false,
  };
}

/** El estado del pedido frente a Kepler. */
export function estadoCaptura(estatus: string | null, noCuadra: boolean): CapturaKeplerEstado {
  if (YA_AVANZADO.has(estatus ?? '')) return noCuadra ? 'con_diferencias' : 'capturado';
  if (estatus === 'AUTORIZADO') return noCuadra ? 'por_capturar' : 'por_avanzar';
  return 'kepler_otro';
}

/**
 * Un pedido completo: sus renglones surtidos contra lo que Kepler trae hoy. Kepler se lee SIEMPRE,
 * también en AUTORIZADO: el pedido se puede editar en Kepler mientras se surte (ADR-086), y decir
 * "sólo pásalo a SURTIDO" sin mirar sería una instrucción falsa si alguien agregó o subió algo.
 *
 * Los renglones que Kepler trae y la Suite no surtió (agregados después) también se listan: hay que
 * quitarlos. Los que se agregan EN el checado o el embarque ya vienen filtrados en la consulta
 * (`c28`): son trabajo de esas etapas, no un error de Facturación.
 */
export function evaluarPedido(
  filas: FilaCaptura[],
  kepler: Map<string, KeplerProducto> | null,
  estatus: string | null,
): { estado: CapturaKeplerEstado; pendientes: CapturaKeplerRenglon[] } {
  const leido = kepler !== null;
  const pendientes: CapturaKeplerRenglon[] = [];
  let noCuadra = false;
  for (const f of filas) {
    const r = renglonCaptura(f, kepler?.get(f.sku ?? ''), leido);
    if (r.cuadra === false) {
      noCuadra = true;
      pendientes.push(r);
    } else if (r.cuadra === null && r.falta > TOL) {
      pendientes.push(r);
    }
  }
  if (kepler) {
    const surtidos = new Set(filas.map((f) => f.sku ?? ''));
    for (const [sku, k] of kepler) {
      if (surtidos.has(sku) || Math.abs(k.base) <= TOL) continue;
      noCuadra = true;
      const enPres = k.unidades.length === 1 && !!k.unidades[0];
      pendientes.push({
        sku,
        producto: k.descripcion,
        unidad: enPres ? k.unidades[0] : null,
        pedido: 0,
        surtido: 0,
        falta: 0,
        kepler: redondea(enPres ? k.pres : k.base),
        cuadra: false,
        renglones_kepler: k.n,
        extra: true,
      });
    }
  }
  return { estado: estadoCaptura(estatus, noCuadra), pendientes };
}

/**
 * `[GP.3d]` **La entrega del surtido a Facturación** (`FASE_GP` §8.5).
 *
 * El surtido se hace en la Suite, pero el pedido sigue viviendo en Kepler (ADR-086: la Suite no
 * escribe en Kepler). Lo cierra **Facturación**: deja cada renglón como se surtió y pasa el pedido
 * a **SURTIDO**, que lo pone en la mesa de checado (decisión de Francisco, 2026-10-08). Medido en
 * prod (30 días, 40,792 renglones embarcados): Kepler marca surtido menor a lo pedido en sólo
 * **0.17%** de los renglones y surtido en cero **nunca**: lo que falta se resuelve **corrigiendo el
 * pedido**, no capturando un surtido menor.
 *
 * Esta bandeja dice qué tocar y **detecta sola** cuándo ya se hizo, leyendo Kepler (`kepler_ods`,
 * minutos de atraso) contra lo repartido a cada pedido al cerrar el surtido (`wave_allocations`).
 * Sólo lectura: no guarda nada.
 */
@Injectable()
export class PickingCapturaService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly scope: ScopeService,
  ) {}

  async porCapturar(): Promise<CapturaKeplerResponse> {
    const visibles = this.scope.intersect(await this.scope.current('almacen'), 'warehouse', null);
    const lista = visibles === null ? null : [...visibles];

    return this.tk.run(async (trx) => {
      const { rows: frescura } = await trx.raw(
        `SELECT dato_al FROM analytics.v_feed_freshness WHERE feed = 'kdm1' LIMIT 1`,
      );
      const keplerAl = frescura[0]?.dato_al ? new Date(frescura[0].dato_al).toISOString() : null;
      if (lista && !lista.length) return this.vacio(keplerAl, [], true);
      const hoy = await this.hoyMx(trx);

      const { rows: sinCongelado } = await trx.raw(
        `SELECT count(DISTINCT wo.order_id)::int AS n
           FROM commercial.picking_waves pw
           JOIN commercial.warehouses w ON w.id = pw.warehouse_id
           JOIN commercial.wave_orders wo ON wo.wave_id = pw.id AND wo.source = 'kepler'
          WHERE pw.status = 'surtida' AND pw.finished_at >= now() - (? || ' days')::interval
            AND (?::text[] IS NULL OR btrim(w.code) = ANY(?::text[]))
            AND NOT EXISTS (SELECT 1 FROM commercial.wave_order_lines wol
                             WHERE wol.wave_id = pw.id AND wol.order_id = wo.order_id)`,
        [DIAS_CAPTURA, lista, lista],
      );
      const filas = await this.filasSuite(trx, { lista });
      const sinCong = Number(sinCongelado[0]?.n) || 0;
      if (!filas.length) return { ...this.vacio(keplerAl, lista ?? [], false), sin_congelado: sinCong };

      const salida: CapturaKeplerPedido[] = [];
      let capturadosAntes = 0;
      for (const [orderId, e] of await this.evaluarFilas(trx, filas)) {
        const f0 = e.filas[0];
        // Los ya capturados de días anteriores no se listan: sólo se cuentan. "Hoy" es el día en
        // que TERMINÓ EL SURTIDO: Kepler no guarda cuándo se capturó, así que no se promete eso.
        if (e.estado === 'capturado' && this.diaMx(f0.finished_at) !== hoy) {
          capturadosAntes += 1;
          continue;
        }
        salida.push({
          order_id: orderId,
          sucursal: f0.sucursal,
          code: f0.order_code ?? `UD40${String(f0.kepler_serie).padStart(2, '0')}-${f0.kepler_folio}`,
          serie: Number(f0.kepler_serie),
          folio: f0.kepler_folio,
          origen: e.origen ?? f0.origen,
          destino: f0.destino_nombre,
          wave_code: f0.wave_code,
          surtido_at: new Date(f0.finished_at).toISOString(),
          surtidores: [...new Set(e.filas.map((x) => x.surtidor).filter((x): x is string => !!x))],
          estado: e.estado,
          estatus_kepler: e.estatus,
          renglones: e.filas.length,
          pendientes: e.pendientes,
        });
      }

      return {
        generado_en: new Date().toISOString(),
        kepler_al: keplerAl,
        dias: DIAS_CAPTURA,
        sucursales: lista ?? [...new Set(filas.map((x) => x.sucursal))].sort(),
        sin_alcance: false,
        pedidos: salida,
        capturados_antes: capturadosAntes,
        sin_congelado: sinCong,
      };
    });
  }

  /**
   * `[GP.4]` Dónde está cada pedido frente a Kepler, para pedidos dados. Lo usa el checado: sólo se
   * checa lo que Kepler ya trae en SURTIDO **y cuadra** con lo surtido (Facturación ya lo cerró).
   * Corre dentro de la transacción de quien llama.
   */
  async estadosDe(
    trx: Knex.Transaction,
    orderIds: string[],
  ): Promise<Map<string, { estado: CapturaKeplerEstado; estatus: string | null }>> {
    const out = new Map<string, { estado: CapturaKeplerEstado; estatus: string | null }>();
    if (!orderIds.length) return out;
    const filas = await this.filasSuite(trx, { orderIds });
    for (const [id, e] of await this.evaluarFilas(trx, filas)) out.set(id, { estado: e.estado, estatus: e.estatus });
    return out;
  }

  /**
   * Lo que se surtió, por pedido y producto. Lo pedido viene CONGELADO al arrancar (GP.3) y lo
   * surtido es lo repartido a ESE pedido al cerrar la ola (una tanda reparte entre varios). Un
   * pedido de Kepler entra a una sola ola (`validarKepler`), así que no se mezclan olas.
   */
  private async filasSuite(
    trx: Knex.Transaction,
    filtro: { lista: string[] | null } | { orderIds: string[] },
  ): Promise<FilaSuite[]> {
    const porPedido = 'orderIds' in filtro;
    const { rows } = await trx.raw(
      `SELECT pw.code AS wave_code, btrim(w.code) AS sucursal, pw.finished_at,
              wo.order_id, wo.kepler_sucursal, wo.kepler_serie, wo.kepler_folio, wo.destino_nombre,
              pw.origen, wol.order_code,
              p.sku, p.nombre AS producto,
              wol.qty_requested, wol.qty_unit, wol.qty_presentacion, wol.unidad_presentacion,
              wa.qty_allocated,
              COALESCE(NULLIF(btrim(u.nombre), ''), u.username) AS surtidor
         FROM commercial.picking_waves pw
         JOIN commercial.warehouses w ON w.id = pw.warehouse_id
         JOIN commercial.wave_orders wo ON wo.wave_id = pw.id AND wo.source = 'kepler'
         JOIN commercial.wave_order_lines wol ON wol.wave_id = pw.id AND wol.order_id = wo.order_id
         LEFT JOIN catalog.products p ON p.id = wol.product_id
         LEFT JOIN commercial.wave_allocations wa
                ON wa.wave_id = pw.id AND wa.order_id = wo.order_id AND wa.product_id = wol.product_id
         LEFT JOIN commercial.wave_lines wl ON wl.wave_id = pw.id AND wl.product_id = wol.product_id
         LEFT JOIN identity.users u ON u.id = wl.picked_by
        WHERE pw.status = 'surtida'
          AND (CASE WHEN ?::boolean THEN wo.order_id = ANY(?::uuid[])
                    ELSE pw.finished_at >= now() - (? || ' days')::interval
                         AND (?::text[] IS NULL OR btrim(w.code) = ANY(?::text[])) END)
        ORDER BY pw.finished_at, wo.kepler_folio, p.sku`,
      porPedido
        ? [true, filtro.orderIds, DIAS_CAPTURA, null, null]
        : [false, [], DIAS_CAPTURA, filtro.lista, filtro.lista],
    );
    return rows as FilaSuite[];
  }

  /** Lee Kepler (cabecera vigente y renglones) para los pedidos de `filas` y evalúa cada uno. */
  private async evaluarFilas(
    trx: Knex.Transaction,
    filas: FilaSuite[],
  ): Promise<Map<string, { filas: FilaSuite[]; estado: CapturaKeplerEstado; estatus: string | null; origen: string | null; pendientes: CapturaKeplerRenglon[] }>> {
    const pedidos = new Map<string, FilaSuite[]>();
    for (const x of filas) {
      const arr = pedidos.get(x.order_id) ?? [];
      arr.push(x);
      pedidos.set(x.order_id, arr);
    }
    const llaveDe = (x: FilaSuite): string => `${x.kepler_sucursal}/${Number(x.kepler_serie)}/${x.kepler_folio}`;
    const llaves = JSON.stringify(
      [...pedidos.values()].map((fs) => ({ sucursal: fs[0].kepler_sucursal, serie: Number(fs[0].kepler_serie), folio: fs[0].kepler_folio })),
    );

    // Cabecera VIGENTE y renglones de Kepler. Escritas para usar `ix_kdm1_venta_doc` y
    // `ix_kdm2_venta_doc` (btrim(sucursal), c4::int, c5::int, btrim(c6)). Medido en prod con los
    // 2,510 pedidos U-D-40 de 30 días (el peor caso): 42 ms y 404 ms.
    const { rows: cabs } = await trx.raw(
      `SELECT k.sucursal, k.serie, k.folio, hh.estatus, hh.origen
         FROM jsonb_to_recordset(?::jsonb) AS k(sucursal text, serie int, folio text)
         LEFT JOIN LATERAL (
           SELECT upper(NULLIF(btrim(h.c11::text), '')) AS estatus,
                  upper(NULLIF(btrim(h.c27::text), '')) AS origen
             FROM kepler_ods.kdm1 h
            WHERE h.c2 = 'U' AND h.c3 = 'D' AND btrim(h.sucursal) = k.sucursal AND (h.c4)::integer = 40
              AND (h.c5)::integer = k.serie AND btrim(h.c6) = k.folio AND btrim(h.c1) = btrim(h.sucursal)
            ORDER BY h.c9 DESC
            LIMIT 1
         ) hh ON true`,
      [llaves],
    );
    const cabDe = new Map<string, { estatus: string | null; origen: string | null }>();
    for (const c of cabs as Array<{ sucursal: string; serie: number; folio: string; estatus: string | null; origen: string | null }>) {
      cabDe.set(`${c.sucursal}/${Number(c.serie)}/${c.folio}`, { estatus: c.estatus, origen: c.origen });
    }

    const { rows: lk } = await trx.raw(
      `SELECT k.sucursal, k.serie, k.folio, btrim(l.c8::text) AS sku, count(*)::int AS n,
              sum(coalesce(NULLIF(btrim(l.c9::text), '')::numeric, 0)) AS base,
              sum(coalesce(NULLIF(btrim(l.c56::text), '')::numeric, 0)) AS pres,
              array_remove(array_agg(DISTINCT upper(NULLIF(btrim(l.c55::text), ''))), NULL) AS unidades,
              min(NULLIF(btrim(l.c10::text), '')) AS descripcion
         FROM jsonb_to_recordset(?::jsonb) AS k(sucursal text, serie int, folio text)
         JOIN kepler_ods.kdm2 l
           ON l.c2 = 'U' AND l.c3 = 'D' AND btrim(l.sucursal) = k.sucursal AND (l.c4)::integer = 40
          AND (l.c5)::integer = k.serie AND btrim(l.c6) = k.folio AND btrim(l.c1) = btrim(l.sucursal)
        -- Lo agregado EN el checado o el embarque (c28 = etapa de alta) es trabajo de esas etapas.
        WHERE coalesce(upper(NULLIF(btrim(l.c28::text), '')), '') NOT IN ('CHECADO', 'EMBARCADO')
        GROUP BY 1, 2, 3, 4`,
      [llaves],
    );
    const keplerDe = new Map<string, Map<string, KeplerProducto>>();
    for (const r of lk as Array<{ sucursal: string; serie: number; folio: string; sku: string; n: number; base: string; pres: string; unidades: string[] | null; descripcion: string | null }>) {
      const key = `${r.sucursal}/${Number(r.serie)}/${r.folio}`;
      const m = keplerDe.get(key) ?? new Map<string, KeplerProducto>();
      m.set(r.sku, { n: Number(r.n), base: Number(r.base) || 0, pres: Number(r.pres) || 0, unidades: r.unidades ?? [], descripcion: r.descripcion });
      keplerDe.set(key, m);
    }

    const out = new Map<string, { filas: FilaSuite[]; estado: CapturaKeplerEstado; estatus: string | null; origen: string | null; pendientes: CapturaKeplerRenglon[] }>();
    for (const [orderId, fs] of pedidos) {
      const key = llaveDe(fs[0]);
      const cab = cabDe.get(key);
      const estatus = cab?.estatus ?? null;
      // Sin cabecera = Kepler no lo trae: no hay renglones que comparar (no se lee como "todo en cero").
      const kepler = estatus ? (keplerDe.get(key) ?? new Map<string, KeplerProducto>()) : null;
      const { estado, pendientes } = evaluarPedido(fs, kepler, estatus);
      out.set(orderId, { filas: fs, estado, estatus, origen: cab?.origen ?? null, pendientes });
    }
    return out;
  }

  private vacio(keplerAl: string | null, sucursales: string[], sinAlcance: boolean): CapturaKeplerResponse {
    return {
      generado_en: new Date().toISOString(),
      kepler_al: keplerAl,
      dias: DIAS_CAPTURA,
      sucursales,
      sin_alcance: sinAlcance,
      pedidos: [],
      capturados_antes: 0,
      sin_congelado: 0,
    };
  }

  private async hoyMx(trx: Knex.Transaction): Promise<string> {
    const { rows } = await trx.raw(`SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS d`);
    return rows[0].d as string;
  }

  /** El día en México de un instante. */
  private diaMx(d: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
  }
}
