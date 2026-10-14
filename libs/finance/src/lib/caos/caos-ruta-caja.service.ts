import { Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { atribuirDeposito, esVecinal, type GranoDeposito } from './caos-deposito-grano';

/**
 * `[CG.58.7]` — **La ruta y su dinero: depósito en CAOS → entrada a Caja General.**
 *
 * Edgar, 2026-10-14: *"en 'ventas por ruta' agreguemos su liga de la entrada a caja general que
 * está asociada con su depósito en un banco o caja llamada CAOS"*.
 *
 * ── Qué cadena publica esto ──────────────────────────────────────────────────────────────────
 *
 *     venta de la ruta → el repartidor deposita en CAOS → alguien captura esa entrada en Caja
 *                        General (`finance.cash_ledger`, tipo `ingreso`, `origen_tipo='caos'`)
 *
 * El último tramo es **estructural, no heurístico**: cuando la entrada se captura desde el
 * depósito, Caja General guarda `origen_ref = '<device>|<external_id>'`, que es exactamente la
 * llave natural del movimiento de CAOS. No hay que casar por monto ni por fecha — el vínculo ya
 * está escrito. ⛔ Y NO se puede casar por monto: medido en prod, los montos **no coinciden**
 * (depósito #1590 `$13,800` ↔ entrada `$14,370`), porque el depósito es efectivo contado en
 * múltiplos de 10 y la entrada es el cobro con sus centavos. Un cruce por importe habría
 * fabricado parejas falsas donde ya existe la verdadera.
 *
 * El PRIMER tramo sí es texto: de qué ruta es el depósito lo declara el `ref` que tecleó quien
 * depositó, y eso lo lee `atribuirDeposito` — ver ahí por qué el grano es `ruta_dia | ruta |
 * plaza | sin_declarar` y por qué cazar por monto+fecha fracasó (551 respuestas conocidas: a
 * tolerancia $200 acierta 195, se equivoca 28 y no encuentra 297).
 *
 * ── Lo que se DECLARA, y por qué no se dibuja (ADR-056) ──────────────────────────────────────
 *
 * Medido en prod el 2026-10-14 sobre los **749 depósitos ($18,360,140)** de may→oct:
 *
 *   · **18 están capturados en Caja General ($280,600)** = 2.4% de los depósitos. El resto no es
 *     un error de este reporte: es que el módulo de Caja General arrancó hace días. La fila dice
 *     `pendientes`, nunca cero.
 *   · La **vecinal** sale aparte (`esVecinal`): es otro circuito y se arquea en su caja — ya tiene
 *     su propio panel en esta pantalla. Mezclarla le cobraría a un camión la venta de otro.
 *   · El grano **`plaza`** (`rd can`, `rd mor`) cierra al 95.2% a nivel plaza y **no se baja a una
 *     ruta concreta**: elegir una sería inventar.
 *
 * ⚠️ **La sucursal se DERIVA, no se cablea.** El número de ruta se resuelve contra el universo
 * real del reporte de ventas (`analytics.sales_by_route_monthly`). Si un número cae en dos
 * almacenes —hoy pasa: la 321 y la 322 viven en `07` y en `MD-32`— la fila lo dice en vez de
 * elegir uno. Y si cae en ninguno, también: un depósito a una ruta que la venta no conoce es un
 * hallazgo, no una fila vacía.
 */

export type { GranoDeposito };

/** Un depósito de la caja fuerte, con lo que su texto declara y su entrada a Caja General. */
export interface CaosRutaDeposito {
  /**
   * A que fila pertenece. ⭐ La manda el SERVIDOR a proposito: si la pantalla la re-dedujera,
   * habria dos implementaciones de la misma precedencia y el dia que una cambie el detalle de
   * una fila mostraria los depositos de otra, sin error y sin que nada se ponga rojo.
   */
  clave: string;
  device: string;
  external_id: number;
  occurred_at: string;
  monto_caos: number;
  ref: string | null;
  grano: GranoDeposito;
  /** `true` cuando el texto declara vecinal: es OTRA ausencia que «no declara nada». */
  vecinal: boolean;
  ruta: string | null;
  plaza: string | null;
  /** Día de la venta que el texto declara. Sólo existe en `ruta_dia`; null se DECLARA. */
  fecha_venta: string | null;
  motivo: string;
  /** La ENTRADA a Caja General. `null` = todavía no se capturó (no es un cero). */
  cg_folio: string | null;
  cg_fecha: string | null;
  cg_monto: number | null;
  cg_estado: string | null;
  cg_sucursal: string | null;
  /** Cuántas entradas apuntan a este depósito. >1 es un hallazgo: el mismo dinero dos veces. */
  cg_entradas: number;
  /** entrada − depósito. Null sin entrada. No es un error: son dos unidades del mismo hecho. */
  delta: number | null;
}

/** Una fila del resumen: a quién se le atribuye el dinero, al grano que el texto aguanta. */
export interface CaosRutaFila {
  /** `ruta:28` · `plaza:canindo` · `vecinal` · `sin_declarar`. Estable para el `track` de la UI. */
  clave: string;
  etiqueta: string;
  grano: GranoDeposito;
  vecinal: boolean;
  ruta: string | null;
  plaza: string | null;
  /** La sucursal, si el universo de ventas la resuelve SIN ambigüedad. */
  warehouse_code: string | null;
  warehouse_name: string | null;
  /** Todas las sucursales donde esa ruta vende. Vacío = la venta no conoce esa ruta. */
  sucursales: string[];
  /** Por qué `warehouse_code` quedó en null. Null cuando se resolvió. */
  motivo_sucursal: string | null;
  depositos: number;
  monto_caos: number;
  en_caja_general: number;
  monto_caja_general: number;
  pendientes: number;
  monto_pendiente: number;
}

export interface CaosPorRuta {
  from: string;
  to: string;
  filas: CaosRutaFila[];
  depositos: CaosRutaDeposito[];
  resumen: {
    depositos: number;
    monto: number;
    en_caja_general: number;
    monto_caja_general: number;
    pendientes: number;
    monto_pendiente: number;
    vecinal: number;
    monto_vecinal: number;
    plaza: number;
    monto_plaza: number;
    sin_declarar: number;
    monto_sin_declarar: number;
  };
  /** Última sincronización del espejo de CAOS. Null = no medida, NO «al día». */
  datos_al: string | null;
  generated_at: string;
}

type FilaCruda = {
  device: string;
  external_id: string | number;
  occurred_at: string | Date;
  total: string | number;
  ref: string | null;
  cg_folio: string | null;
  cg_fecha: string | null;
  cg_monto: string | null;
  cg_estado: string | null;
  cg_sucursal: string | null;
  cg_entradas: string | number | null;
};

type FilaRuta = { warehouse_code: string; warehouse_name: string; route_no: string };

const n2 = (v: unknown): number => Math.round((Number(v) || 0) * 100) / 100;

/**
 * ⭐ La precedencia de atribucion, en UN solo lugar.
 *
 * La vecinal manda sobre todo (es otro circuito), despues la ruta, despues la plaza. El valor
 * que devuelve viaja en cada deposito hasta la pantalla, asi que la UI NO la vuelve a deducir:
 * dos implementaciones de la misma regla divergen tarde o temprano, y cuando lo hagan el
 * detalle de una fila mostraria los depositos de otra sin que nada falle.
 */
export function claveDeDeposito(d: { vecinal: boolean; ruta: string | null; plaza: string | null }): string {
  if (d.vecinal) return 'vecinal';
  if (d.ruta) return `ruta:${d.ruta}`;
  if (d.plaza) return `plaza:${d.plaza}`;
  return 'sin_declarar';
}

@Injectable()
export class CaosRutaCajaService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async porRuta(fromArg?: string, toArg?: string): Promise<CaosPorRuta> {
    const tenantId = this.tenantCtx.requireTenantId();
    const hoy = new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 10);
    const to = (toArg || hoy).slice(0, 10);
    const from = (fromArg || new Date(new Date(to).getTime() - 44 * 86400000).toISOString().slice(0, 10)).slice(0, 10);

    return this.tk.run(async (trx) => {
      /**
       * El LATERAL agrega del lado de Caja General a propósito: con un LEFT JOIN plano, dos
       * entradas apuntando al mismo depósito lo DUPLICARÍAN en el total, que es justo el error
       * que este reporte existe para encontrar. Así el depósito sigue siendo una fila y el `>1`
       * se publica como hallazgo.
       */
      const crudas: FilaCruda[] = (await trx.raw(
        `SELECT m.device,
                m.external_id,
                m.occurred_at,
                m.total,
                m.ref,
                cg.folio      AS cg_folio,
                to_char(cg.fecha, 'YYYY-MM-DD') AS cg_fecha,
                cg.monto      AS cg_monto,
                cg.estado     AS cg_estado,
                cg.sucursal   AS cg_sucursal,
                cg.n          AS cg_entradas
           FROM analytics.caos_cash_movements m
           LEFT JOIN LATERAL (
                SELECT min(c.folio)    AS folio,
                       min(c.fecha)    AS fecha,
                       sum(c.monto)    AS monto,
                       min(c.estado)   AS estado,
                       min(c.sucursal) AS sucursal,
                       count(*)::int   AS n
                  FROM finance.cash_ledger c
                 WHERE c.tenant_id   = m.tenant_id
                   AND c.deleted_at IS NULL
                   AND c.origen_tipo = 'caos'
                   AND c.origen_ref  = m.device || '|' || m.external_id::text
           ) cg ON true
          WHERE m.tenant_id = ?
            AND m.type_id   = 0
            AND m.occurred_at >= ?::date
            AND m.occurred_at <  (?::date + 1)
          ORDER BY m.occurred_at DESC, m.external_id DESC`,
        [tenantId, from, to],
      )).rows;

      // El universo REAL de rutas: de dónde sale la sucursal, en vez de una tabla de equivalencias.
      const rutas: FilaRuta[] = (await trx.raw(
        `SELECT DISTINCT w.code AS warehouse_code, w.name AS warehouse_name, s.route_no
           FROM analytics.sales_by_route_monthly s
           JOIN commercial.warehouses w ON w.id = s.warehouse_id
          WHERE s.tenant_id = ?
            AND s.route_no ~ '^[0-9]+$'
          ORDER BY 3, 1`,
        [tenantId],
      )).rows;

      const frescura: { datos_al: string | null } | undefined = (await trx.raw(
        `SELECT max(synced_at)::text AS datos_al FROM analytics.caos_cash_movements WHERE tenant_id = ?`,
        [tenantId],
      )).rows[0];

      // ruta → sucursales donde esa ruta vende (puede ser 0, 1 o varias: las tres se declaran)
      const porRuta = new Map<string, FilaRuta[]>();
      for (const r of rutas) {
        const k = String(Number(r.route_no));
        if (!porRuta.has(k)) porRuta.set(k, []);
        (porRuta.get(k) as FilaRuta[]).push(r);
      }
      // plaza → sucursales cuyo nombre la nombra (derivado del catálogo, no cableado)
      const plazaSucursales = (plaza: string): FilaRuta[] =>
        rutas.filter((r) => r.warehouse_name.toLowerCase().includes(plaza.toLowerCase()));

      const depositos: CaosRutaDeposito[] = crudas.map((c) => {
        const ref = c.ref;
        const occ = typeof c.occurred_at === 'string' ? c.occurred_at : new Date(c.occurred_at).toISOString();
        const a = atribuirDeposito(ref, occ.slice(0, 10));
        const cgMonto = c.cg_monto == null ? null : n2(c.cg_monto);
        const monto = n2(c.total);
        const vecinal = esVecinal(ref);
        return {
          clave: claveDeDeposito({ vecinal, ruta: a.ruta, plaza: a.plaza }),
          device: c.device,
          external_id: Number(c.external_id),
          occurred_at: occ,
          monto_caos: monto,
          ref,
          grano: a.grano,
          vecinal,
          ruta: a.ruta,
          plaza: a.plaza,
          fecha_venta: a.fecha,
          motivo: a.motivo,
          cg_folio: c.cg_folio,
          cg_fecha: c.cg_fecha,
          cg_monto: cgMonto,
          cg_estado: c.cg_estado,
          cg_sucursal: c.cg_sucursal,
          cg_entradas: Number(c.cg_entradas) || 0,
          delta: cgMonto == null ? null : n2(cgMonto - monto),
        };
      });

      const filas = new Map<string, CaosRutaFila>();
      const nueva = (clave: string, base: Partial<CaosRutaFila>): CaosRutaFila => ({
        clave,
        etiqueta: clave,
        grano: 'sin_declarar',
        vecinal: false,
        ruta: null,
        plaza: null,
        warehouse_code: null,
        warehouse_name: null,
        sucursales: [],
        motivo_sucursal: null,
        depositos: 0,
        monto_caos: 0,
        en_caja_general: 0,
        monto_caja_general: 0,
        pendientes: 0,
        monto_pendiente: 0,
        ...base,
      });

      for (const d of depositos) {
        const clave = d.clave;
        let base: Partial<CaosRutaFila>;

        if (d.vecinal) {
          base = { etiqueta: 'Ruta vecinal — otro circuito', grano: 'sin_declarar', vecinal: true,
            motivo_sucursal: 'la vecinal se arquea en su caja: tiene su propio panel en esta pantalla' };
        } else if (d.ruta) {
          const cand = porRuta.get(d.ruta) ?? [];
          const uno = cand.length === 1 ? cand[0] : null;
          base = {
            etiqueta: `Ruta ${d.ruta}`,
            grano: d.grano,
            ruta: d.ruta,
            warehouse_code: uno ? uno.warehouse_code : null,
            warehouse_name: uno ? uno.warehouse_name : null,
            sucursales: cand.map((x) => x.warehouse_code),
            motivo_sucursal: uno ? null
              : cand.length === 0
                ? 'el reporte de ventas no conoce esa ruta'
                : `la ruta vende en ${cand.length} almacenes (${cand.map((x) => x.warehouse_code).join(', ')})`,
          };
        } else if (d.plaza) {
          const cand = plazaSucursales(d.plaza);
          const codes = Array.from(new Set(cand.map((x) => x.warehouse_code)));
          base = {
            etiqueta: `${d.plaza[0].toUpperCase()}${d.plaza.slice(1)} — sin ruta`,
            grano: 'plaza',
            plaza: d.plaza,
            warehouse_code: codes.length === 1 ? codes[0] : null,
            warehouse_name: codes.length === 1 ? cand[0].warehouse_name : null,
            sucursales: codes,
            motivo_sucursal: 'el texto nombra la plaza y no la ruta: bajar a una ruta sería inventar',
          };
        } else {
          base = { etiqueta: 'Sin declarar — el texto no dice de quién es', grano: 'sin_declarar',
            motivo_sucursal: 'el depósito no declara ruta ni plaza' };
        }

        if (!filas.has(clave)) filas.set(clave, nueva(clave, base));
        const f = filas.get(clave) as CaosRutaFila;
        f.depositos += 1;
        f.monto_caos = n2(f.monto_caos + d.monto_caos);
        if (d.cg_folio) {
          f.en_caja_general += 1;
          f.monto_caja_general = n2(f.monto_caja_general + (d.cg_monto ?? 0));
        } else {
          f.pendientes += 1;
          f.monto_pendiente = n2(f.monto_pendiente + d.monto_caos);
        }
      }

      const orden = (f: CaosRutaFila): number =>
        f.ruta ? 0 : f.plaza ? 1 : f.vecinal ? 2 : 3;
      const lista = Array.from(filas.values()).sort((a, b) =>
        orden(a) - orden(b)
        || (a.ruta && b.ruta ? Number(a.ruta) - Number(b.ruta) : 0)
        || b.monto_caos - a.monto_caos);

      const sum = (p: (d: CaosRutaDeposito) => boolean) =>
        depositos.filter(p).reduce((acc, d) => ({ n: acc.n + 1, m: n2(acc.m + d.monto_caos) }), { n: 0, m: 0 });
      const todo = sum(() => true);
      const conCg = depositos.filter((d) => d.cg_folio);
      const vec = sum((d) => d.vecinal);
      const plz = sum((d) => !d.vecinal && d.grano === 'plaza');
      const mudo = sum((d) => !d.vecinal && d.grano === 'sin_declarar');
      const pend = sum((d) => !d.cg_folio);

      return {
        from,
        to,
        filas: lista,
        depositos,
        resumen: {
          depositos: todo.n,
          monto: todo.m,
          en_caja_general: conCg.length,
          monto_caja_general: n2(conCg.reduce((a, d) => a + (d.cg_monto ?? 0), 0)),
          pendientes: pend.n,
          monto_pendiente: pend.m,
          vecinal: vec.n,
          monto_vecinal: vec.m,
          plaza: plz.n,
          monto_plaza: plz.m,
          sin_declarar: mudo.n,
          monto_sin_declarar: mudo.m,
        },
        datos_al: frescura?.datos_al ?? null,
        generated_at: new Date().toISOString(),
      };
    });
  }
}
