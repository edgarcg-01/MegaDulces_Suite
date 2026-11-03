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
 *
 * ── `[CG.58.8]` (2026-11-03): la liga son DOS caminos, y el panel leía uno ───────────────────
 *
 * Desde el 9-oct Caja General liga el depósito con el **cobro de la ruta** (`U-A-5` de Kepler,
 * `origen_tipo='cobro'`, con su `ruta`) por `finance.caos_cash_links`, no por `origen_ref`. El
 * reporte sólo leía `origen_ref` y por eso decía «sin capturar» de depósitos ya ligados. Medido
 * en prod ese día sobre los 882 depósitos may→nov: **30 por `origen_ref`** (que además tienen su
 * renglón en `caos_cash_links`: es la MISMA entrada, no dos explicaciones) y **111 sólo por
 * `caos_cash_links`** — el panel publicaba 30 de 141.
 *
 * Y la liga trae la ruta de forma estructural: `rd canindo 12/10` es plaza por su texto, pero sus
 * entradas son los cobros de las rutas 502, 503 y 504. Cuando el texto no dice la ruta y TODAS
 * las entradas ligadas son de una sola, la ruta sale de la liga. Cuando el texto dice una y la
 * liga otra, gana el texto y se publica la contradicción (#1703/#1704, rutas 22↔26 del 22-oct).
 *
 * Lo anterior al primer ingreso capturado en Caja General (`cg_desde`) **no es pendiente**: no
 * existe entrada a la cual ligarlo. Se cuenta aparte (`previos`), en vez de inflar «sin capturar».
 */

export type { GranoDeposito };

/** Una entrada de Caja General ligada a un depósito, por cualquiera de los dos caminos. */
export interface CaosRutaLiga {
  folio: string;
  fecha: string;
  /** Lo que esta entrada toma del depósito (`monto_enlazado`); por `origen_ref`, su monto. */
  monto: number;
  /** La ruta del cobro, si Caja General la registró. */
  ruta: string | null;
  sucursal: string | null;
  estado: string | null;
}

/** `ligado` = tiene entrada · `pendiente` = no, y Caja General ya existía · `previo` = anterior a Caja General. */
export type EstadoLiga = 'ligado' | 'pendiente' | 'previo';

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
  /**
   * Cuántas entradas lo explican. >1 es NORMAL por `caos_cash_links` (un depósito junta los
   * cobros de varias rutas); el hallazgo de «el mismo dinero dos veces» es `cg_repetida`.
   */
  cg_entradas: number;
  /** Más de una entrada `origen_tipo='caos'` apunta a este depósito: capturado dos veces. */
  cg_repetida: boolean;
  /** `[CG.58.8]` Todas las entradas que lo explican, por los dos caminos, sin duplicar. */
  ligas: CaosRutaLiga[];
  /** Las rutas distintas de esas entradas. */
  rutas_ligadas: string[];
  /** De dónde salió `ruta`: lo que tecleó quien depositó, o la liga de Caja General. */
  ruta_por: 'texto' | 'liga' | null;
  /** El texto dice una ruta y ninguna entrada ligada es de esa ruta. */
  ruta_contradice: boolean;
  estado_liga: EstadoLiga;
  /** Σ entradas − depósito. Null sin entrada. No es un error: son dos unidades del mismo hecho. */
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
  /** `[CG.58.8]` Anteriores al primer ingreso de Caja General: no hay entrada que ligar. */
  previos: number;
  monto_previo: number;
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
    previos: number;
    monto_previo: number;
    /** Depósitos que el texto no ubicaba en una ruta y la liga sí. */
    ruta_por_liga: number;
    /** Depósitos cuyo texto y liga dicen rutas distintas. */
    contradicen: number;
    vecinal: number;
    monto_vecinal: number;
    plaza: number;
    monto_plaza: number;
    sin_declarar: number;
    monto_sin_declarar: number;
  };
  /** Última sincronización del espejo de CAOS. Null = no medida, NO «al día». */
  data_as_of: string | null;
  /** Fecha del primer ingreso de Caja General. Null = no ha capturado ninguno. */
  cg_desde: string | null;
  generated_at: string;
}

type FilaCruda = {
  device: string;
  external_id: string | number;
  occurred_at: string | Date;
  total: string | number;
  ref: string | null;
  previo: boolean;
  cg_repetidas: string | number | null;
  ligas: Array<{ folio: string; fecha: string; monto: string | number; ruta: string | null; sucursal: string | null; estado: string | null }> | null;
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

/**
 * `[CG.58.8]` La ruta de un depósito: la del texto, y si el texto no la dice, la de la liga —
 * sólo si TODAS las entradas ligadas son de una misma ruta. Varias rutas no se reparten acá: el
 * depósito se queda en su plaza y cada ruta lo encuentra por `rutas_ligadas`.
 */
export function rutaDeDeposito(rutaTexto: string | null, rutasLigadas: string[]): {
  ruta: string | null; ruta_por: 'texto' | 'liga' | null; ruta_contradice: boolean;
} {
  if (rutaTexto) {
    return { ruta: rutaTexto, ruta_por: 'texto',
      ruta_contradice: rutasLigadas.length > 0 && !rutasLigadas.includes(rutaTexto) };
  }
  if (rutasLigadas.length === 1) return { ruta: rutasLigadas[0], ruta_por: 'liga', ruta_contradice: false };
  return { ruta: null, ruta_por: null, ruta_contradice: false };
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
       * entradas apuntando al mismo depósito lo DUPLICARÍAN en el total. Así el depósito sigue
       * siendo una fila y sus entradas viajan como lista.
       *
       * `[CG.58.8]` `liga` junta los DOS caminos sin contar dos veces la misma entrada: la de
       * `origen_ref` sólo entra si no tiene ya su renglón en `caos_cash_links` con ESTE depósito
       * (medido: las 30 que hay lo tienen). MATERIALIZED porque el LATERAL la lee por depósito.
       */
      const crudas: FilaCruda[] = (await trx.raw(
        `WITH cg AS (
           SELECT min(fecha) AS desde
             FROM finance.cash_ledger
            WHERE tenant_id = ? AND deleted_at IS NULL AND tipo = 'ingreso'
         ),
         liga AS MATERIALIZED (
           SELECT k.caos_device AS dev, k.caos_external_id::text AS eid, c.id,
                  sum(k.monto_enlazado) AS monto
             FROM finance.caos_cash_links k
             JOIN finance.cash_ledger c ON c.id = k.cash_ledger_id AND c.deleted_at IS NULL
            WHERE k.tenant_id = ? AND k.deleted_at IS NULL
            GROUP BY 1, 2, 3
           UNION ALL
           SELECT split_part(c.origen_ref, '|', 1), split_part(c.origen_ref, '|', 2), c.id, c.monto
             FROM finance.cash_ledger c
            WHERE c.tenant_id = ? AND c.deleted_at IS NULL AND c.origen_tipo = 'caos'
              AND NOT EXISTS (
                    SELECT 1 FROM finance.caos_cash_links k
                     WHERE k.cash_ledger_id = c.id AND k.deleted_at IS NULL
                       AND k.caos_device || '|' || k.caos_external_id::text = c.origen_ref)
         )
         SELECT m.device,
                m.external_id,
                m.occurred_at,
                m.total,
                m.ref,
                (m.occurred_at AT TIME ZONE 'America/Mexico_City')::date
                  < coalesce(cg.desde, 'infinity'::date) AS previo,
                (SELECT count(*) FROM finance.cash_ledger c2
                  WHERE c2.tenant_id = m.tenant_id AND c2.deleted_at IS NULL
                    AND c2.origen_tipo = 'caos'
                    AND c2.origen_ref = m.device || '|' || m.external_id::text) AS cg_repetidas,
                x.ligas
           FROM analytics.caos_cash_movements m
          CROSS JOIN cg
           LEFT JOIN LATERAL (
                SELECT json_agg(json_build_object(
                         'folio', c.folio, 'fecha', to_char(c.fecha, 'YYYY-MM-DD'), 'monto', l.monto,
                         'ruta', c.ruta, 'sucursal', c.sucursal, 'estado', c.estado)
                         ORDER BY c.fecha, c.folio) AS ligas
                  FROM liga l
                  JOIN finance.cash_ledger c ON c.id = l.id
                 WHERE l.dev = m.device AND l.eid = m.external_id::text
           ) x ON true
          WHERE m.tenant_id = ?
            AND m.type_id   = 0
            AND m.occurred_at >= ?::date
            AND m.occurred_at <  (?::date + 1)
          ORDER BY m.occurred_at DESC, m.external_id DESC`,
        [tenantId, tenantId, tenantId, tenantId, from, to],
      )).rows;

      const cgDesde: string | null = (await trx.raw(
        `SELECT to_char(min(fecha), 'YYYY-MM-DD') AS d FROM finance.cash_ledger
          WHERE tenant_id = ? AND deleted_at IS NULL AND tipo = 'ingreso'`,
        [tenantId],
      )).rows[0]?.d ?? null;

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

      const frescura: { data_as_of: string | null } | undefined = (await trx.raw(
        `SELECT max(synced_at)::text AS data_as_of FROM analytics.caos_cash_movements WHERE tenant_id = ?`,
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
        const ligas: CaosRutaLiga[] = (c.ligas ?? []).map((l) => ({
          folio: l.folio, fecha: l.fecha, monto: n2(l.monto),
          ruta: l.ruta ? String(Number(l.ruta)) : null, sucursal: l.sucursal, estado: l.estado,
        }));
        const rutasLigadas = Array.from(new Set(ligas.map((l) => l.ruta).filter((r): r is string => !!r)));
        const r = rutaDeDeposito(a.ruta, rutasLigadas);
        const cgMonto = ligas.length ? n2(ligas.reduce((s, l) => s + l.monto, 0)) : null;
        const monto = n2(c.total);
        const vecinal = esVecinal(ref);
        const primera = ligas[0] ?? null;
        return {
          clave: claveDeDeposito({ vecinal, ruta: r.ruta, plaza: a.plaza }),
          device: c.device,
          external_id: Number(c.external_id),
          occurred_at: occ,
          monto_caos: monto,
          ref,
          grano: a.grano,
          vecinal,
          ruta: r.ruta,
          plaza: a.plaza,
          fecha_venta: a.fecha,
          motivo: a.motivo,
          cg_folio: primera?.folio ?? null,
          cg_fecha: primera?.fecha ?? null,
          cg_monto: cgMonto,
          cg_estado: primera?.estado ?? null,
          cg_sucursal: primera?.sucursal ?? null,
          cg_entradas: ligas.length,
          cg_repetida: Number(c.cg_repetidas) > 1,
          ligas,
          rutas_ligadas: rutasLigadas,
          ruta_por: r.ruta_por,
          ruta_contradice: r.ruta_contradice,
          estado_liga: ligas.length ? 'ligado' : c.previo ? 'previo' : 'pendiente',
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
        previos: 0,
        monto_previo: 0,
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
            // La ruta que puso la liga vale como ruta, aunque el texto sólo dijera la plaza.
            grano: d.ruta_por === 'liga' ? 'ruta' : d.grano,
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
        if (d.estado_liga === 'ligado') {
          f.en_caja_general += 1;
          f.monto_caja_general = n2(f.monto_caja_general + (d.cg_monto ?? 0));
        } else if (d.estado_liga === 'previo') {
          f.previos += 1;
          f.monto_previo = n2(f.monto_previo + d.monto_caos);
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
      const conCg = depositos.filter((d) => d.estado_liga === 'ligado');
      const vec = sum((d) => d.vecinal);
      // Plaza y sin declarar cuentan lo que QUEDÓ sin ruta: si la liga la resolvió, ya no lo es.
      const plz = sum((d) => !d.vecinal && !d.ruta && d.grano === 'plaza');
      const mudo = sum((d) => !d.vecinal && !d.ruta && d.grano !== 'plaza');
      const pend = sum((d) => d.estado_liga === 'pendiente');
      const prev = sum((d) => d.estado_liga === 'previo');

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
          previos: prev.n,
          monto_previo: prev.m,
          ruta_por_liga: depositos.filter((d) => d.ruta_por === 'liga').length,
          contradicen: depositos.filter((d) => d.ruta_contradice).length,
          vecinal: vec.n,
          monto_vecinal: vec.m,
          plaza: plz.n,
          monto_plaza: plz.m,
          sin_declarar: mudo.n,
          monto_sin_declarar: mudo.m,
        },
        data_as_of: frescura?.data_as_of ?? null,
        cg_desde: cgDesde,
        generated_at: new Date().toISOString(),
      };
    });
  }
}
