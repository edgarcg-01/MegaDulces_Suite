import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import {
  DOC_CODES_AJUSTE, UNIDAD_IMPORTE_SALIDA, clasificarMovimiento,
  type DestinoSalida, type ExcepcionMovimientoItem, type MovimientosExcepcionesResponse, type UnidadImporte,
} from '@megadulces/contracts';

/**
 * DM.1 — Diario de movimientos (mejora del reporte Kepler homónimo).
 *
 * Lee analytics.stock_movements (feed line-level de import-stock-movements.js).
 * Diseño: **agregación primero, folio a folio bajo demanda** (ver ERP_KEPLER_SCHEMA
 * §"Reporte Diario de movimientos" #7):
 *   - summary()   → KPIs por dirección + desglose por tipo de documento.
 *   - aggregate() → vista DEFAULT: totales agrupados (producto|tipo|día|almacén),
 *                   con entradas/salidas/neto/valorizado. Re-agrupable con group_by.
 *   - lines()     → DRILL: folios individuales de una rama (producto/tipo/fecha).
 *
 * analytics.* sin RLS → filtro tenant_id EXPLÍCITO. Todo dentro de tk.run().
 */

const GROUPS = ['product', 'doc_code', 'day', 'warehouse'] as const;
type GroupBy = (typeof GROUPS)[number];
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Docs informativos (k_binv=0, movement_kind='info' en el feed): solo visibles con filtro explícito
const INFO_DOC_CODES = ['ApEntOr1'];
// DM.11b — clasifica el DESTINO de un traspaso (dest_label/dest_code) como RUTA de reparto.
// Cubre "R.D. 28", "RD MORELIA", "R.V. …", "RV-PH-01", "RUTA 501". Sucursal = todo lo demás
// (TI### traspaso a sucursal, P.V. piso, TLMKT). Sin `?` a propósito → seguro inline en raw.
const ROUTE_RX = '^\\s*(R\\.[DV]|R[DV]|RUTA)';

export interface MovementsQuery {
  warehouse_id?: string;
  warehouse_ids?: string; // CSV multi-almacén
  from?: string;
  to?: string;
  doc_code?: string;      // filtra por tipo de documento (Sale1/Purchas1…)
  movement_kind?: string; // 'entrada' | 'salida'
  product_id?: string;
  search?: string;        // nombre/sku producto
  folio?: string;         // filtra un folio exacto (drill al documento)
  estado?: string;        // estado de traspaso: en_transito | sin_acuse | sin_recepcion_esperada | completado | diferencia
  transfer_wh_ids?: string; // CSV UUIDs — traspasos cuyo ORIGEN o DESTINO ∈ selección (propio o contraparte)
  dest_kinds?: string;    // CSV 'sucursal'|'ruta'|'cliente' — destino de traspasos; default 'sucursal'
  group_by?: string;
  page?: number;
  pageSize?: number;
}

type TransferDocStatus = 'en_transito' | 'sin_acuse' | 'sin_recepcion_esperada' | 'completado' | 'diferencia';
const TRANSFER_DOC_STATUSES: readonly string[] = ['en_transito', 'sin_acuse', 'sin_recepcion_esperada', 'completado', 'diferencia'];

/** DM.12 — filtros de la vista del detalle 515 (no afectan el pareo, solo qué se devuelve). */
/**
 * [MX.1.6] Baldes del detalle del mayor 515 (cadena de documentos). Ver `transfersLedgerDetail`.
 */
type LedgerBucket = 'exacto' | 'costo' | 'como_venta' | 'a_wincaja' | 'sin_documento' | 'sin_rastro';
const LEDGER_BUCKETS: readonly string[] = ['exacto', 'costo', 'como_venta', 'a_wincaja', 'sin_documento', 'sin_rastro'];
/**
 * [MX.1.6] Destinos que ANTES del corte de 2026-10 eran tiendas Wincaja (Morelia Abastos, Canindo, Morelia
 * Madero): sus recepciones no estaban en Kepler, así que su salida 515-002 no tiene cadena — se cuadra en el
 * lente Kepler → Wincaja (DM.13). Desde octubre son sucursales Kepler y su salida sí tiene cadena.
 */
const DEST_WINCAJA_PRE_CORTE: readonly string[] = ['TI004', 'TI006', 'TI009'];
const CORTE_WINCAJA = '2026-10';

export interface LedgerDetailFilters {
  bucket?: string;      // exacto | costo | como_venta | a_wincaja | sin_documento | sin_rastro
  kind?: string;        // entrada | salida
  sucursal?: string;    // 00..05
  destinos?: string[];  // filtrar por tienda destino (una o más), etiqueta canónica de destino()
  search?: string;      // folio / referencia (ILIKE contains)
  min_amount?: string | number;
}

/**
 * [DM.15] Un almacén RETIRADO no puede nombrarse como destino de un traspaso.
 *
 * Medido en prod el 2026-09-30: `analytics.transfer_dest_map` tenía
 * `TI009 "SUCURSAL MORELIA MADERO" -> MD-32 "Almacén Morelia Madero (32)"`, el almacén WINCAJA
 * de esa tienda — con `deleted_at` puesto y **cero recepciones de traspaso en toda su historia**.
 * Morelia Madero migró a Kepler y quien recibe es `07`; el mapa se quedó en el almacén viejo. En
 * pantalla, los envíos sin recepción salían con destino a una sucursal que ya no existe, y la
 * MISMA ruta física aparecía partida en dos filas de la matriz (`00->07` por pareo, `01->MD-32`
 * por mapa), así que sus totales no cuadraban ni contra sí mismos.
 *
 * El nombre no alcanzaba para verlo: con dos almacenes de la misma tienda en dos ERP, "MORELIA
 * MADERO" y "Almacén Morelia Madero (32)" concuerdan y el detector de `[DM.11e]` daba verde con
 * razón. La pregunta que faltaba no era cómo se llama, sino si sigue vivo.
 *
 * ⚠️ Se FILTRA, no se marca: preferimos que la pantalla diga "(sin destino)", que se investiga,
 * a que diga un nombre falso, que se cobra. Vive acá arriba y no inline en cada consulta porque
 * son CINCO los puntos que leen el mapa y una condición de integridad repetida a mano se
 * desincroniza — ya pasó con este mismo mapa.
 */
const DEST_WH_VIVO = (alias = 'w') => `${alias}.deleted_at IS NULL`;

/**
 * `[DM.20]` — **la llave del pareo salida↔recepción es el DESTINO DECLARADO, no la fecha.**
 *
 * Kepler liga la recepción con su embarque por un back-pointer explícito
 * (`parent_group=41` + `parent_serie` + `parent_folio`). Lo único que obliga a desempatar es que
 * los folios son **secuencias por sucursal**: el mismo `(serie, folio)` existe en varias plazas.
 * Hasta acá el desempate era *la fecha* — "la recepción nunca es anterior a la salida, tope 15 d".
 *
 * ⛔ **Esa premisa es falsa y se midió.** Las dos plazas fechan el MISMO movimiento por su cuenta,
 * así que la recepción puede quedar antes que el embarque. Sobre los 1,720 pares donde dos
 * testigos independientes coinciden (el destino declarado apunta al almacén que recibe **y** la
 * cantidad cuadra al 0.01), el desfase va de **−2 a +63 días**, mediana 0, y **24 son negativos**.
 * El caso que lo destapó: salida CEDIS `UD4102-0000748` del 2026-09-28 ↔ recepción 8ESQ
 * `UA5001-0000377` del 2026-09-26 — 301.34 piezas idénticas, destino declarado "8ESQ", y la
 * pantalla decía **"sin recepción registrada"** porque la recepción caía dos días antes.
 *
 * El desempate correcto es el que el propio documento declara: `dest_code` del embarque
 * (vía `analytics.transfer_dest_map`, almacén **vivo**) contra el almacén que recibe. Medido en
 * prod sobre 3,487 pares candidatos: el destino coincide en 1,909, y de los 1,724 con cantidad
 * exacta, **1,720 (99.77 %) también coinciden en destino** — dos testigos que no comparten origen.
 *
 * Efecto medido del cambio (prod, 2026-10-06):
 * - salida→recepción: 1,755 → 1,743 pareos; **+30 rescatados** ($851,389.80), **−42 soltados**;
 * - recepción→origen: 1,712 → **1,747**, sin perder ninguno;
 * - y la calidad SUBE en los dos sentidos: los pareos con cantidad exacta pasan de 1,694 a 1,720.
 *
 * ⭐ Los 42 que se sueltan son el otro error, el que nadie estaba mirando: embarques dirigidos a
 * una **RUTA** (`RD 501`…`RD028`) que la fecha emparejaba con la recepción de una SUCURSAL, con
 * desfases de cientos a miles de piezas y **ninguno** con cantidad exacta. La pantalla los daba
 * por recibidos y conciliados. Ahora dicen `sin_recepcion`, que es lo que son.
 *
 * ⚠️ Cuando el embarque NO tiene destino resuelto a un almacén vivo (va a ruta, a cliente, o el
 * mapa no lo cubre) **no hay testigo de destino** y se conserva la ventana ciega de antes: no se
 * ensancha una ventana que nadie puede corroborar. Por eso son dos ramas y no un `coalesce`.
 */
const PAIR_EARLY_DAYS = 15;   // la recepción puede fecharse ANTES del embarque (medido: hasta −2)
const PAIR_LATE_DAYS = 90;    // tránsito + rezago de captura (medido: hasta +63)
const PAIR_BLIND_DAYS = 15;   // sin testigo de destino: ventana de siempre, sin ensanchar

/**
 * [MX.2.2] Identidad de un documento: la misma que la marca «auditado» (DM.4) y el listado.
 * El folio solo NO identifica: Kepler lo reusa entre sucursales y tipos de documento.
 */
const DOC_IDENTITY = ['m.warehouse_id', 'm.doc_code', 'm.doc_serie', 'm.folio'];

/**
 * [MX.1.1] **Firma de productos de un documento**: Σ(cantidad redondeada × hash del SKU).
 *
 * Dos documentos con los mismos SKU y las mismas cantidades dan la misma firma, sin importar en
 * cuántos renglones vengan; mandar 10 de A y recibir 10 de B la cambia. Se calcula en el MISMO
 * barrido que ya suma las piezas, así que cuesta casi nada.
 *
 * ⚠️ Por qué no se compara renglón por renglón: se intentó (2026-10-28) y el Cuadre pasó de
 * 0.26 s a 1.9 s (30 d) y 7 s (90 d) aun con CTEs materializados — y medido en prod **no hay
 * ningún caso** hoy (los «4 documentos con productos cambiados» de la auditoría eran renglones
 * SIN `product_id` en ambos lados, que una comparación por `product_id` nunca empata; por SKU
 * cuadran). La firma es el candado barato contra el caso que hoy no ocurre.
 * Se compara por SKU (texto de Kepler), no por `product_id`, por esa misma razón.
 */
const SKU_SIG = (a: string) => `SUM(round(${a}.qty::numeric, 2) * hashtext(coalesce(${a}.sku, '')))`;

/**
 * [MX.1.3] Días sin recepción tras los cuales una salida A UN ALMACÉN deja de estar «en tránsito» y
 * pasa a «sin acuse» (decisión D5 de la fase MX). Medido el 2026-10-28 sobre 1,270 pares entre
 * almacenes con cantidad idéntica (embarques mar–sep 2026): mediana 0 días, p95 5, sólo 4 (0.3 %)
 * llegan después de 15, máximo 63. Antes eran 45 en el Cuadre y NUNCA en el Diario («en tránsito» no
 * envejecía: 234 salidas a almacén con más de 45 días se pintaban en gris).
 */
const SIN_ACUSE_DIAS = 15;

/** Una ruta de reparto es un almacén cuyo nombre empieza con «Ruta»: una camioneta no emite acuse. */
const esRuta = (nombre: string | null | undefined) => !!nombre && /^\s*ruta/i.test(nombre);

/**
 * [MX.1.3] Estado de una salida que NO tiene recepción, por destino y edad — una sola regla para el
 * Diario y los hallazgos del Cuadre. A cliente (sin almacén resuelto) o a ruta nadie emite acuse:
 * `sin_recepcion_esperada`, no un pendiente.
 */
/**
 * [MX.1.7] A qué clase de destino va una salida: sin almacén resuelto = cliente; almacén «Ruta …» = ruta;
 * si no, sucursal. La misma regla que separa los baldes de hallazgos ([DM.21]) y el estado sin recepción.
 */
const claseDestino = (destWhId: string | null | undefined, destWhName: string | null | undefined): DestinoSalida =>
  !destWhId ? 'cliente' : esRuta(destWhName) ? 'ruta' : 'sucursal';

const estadoSinRecepcion = (
  destWhId: string | null | undefined, destWhName: string | null | undefined, shipDate: unknown, ahora = Date.now(),
): 'en_transito' | 'sin_acuse' | 'sin_recepcion_esperada' => {
  if (claseDestino(destWhId, destWhName) !== 'sucursal') return 'sin_recepcion_esperada';
  const dias = Math.floor((ahora - new Date(String(shipDate)).getTime()) / 864e5);
  return dias > SIN_ACUSE_DIAS ? 'sin_acuse' : 'en_transito';
};

/**
 * Predicado de pareo, en SQL, para que los CUATRO puntos que parean traspasos digan lo mismo
 * (`document`, `annotateTransferStatus`, `transfersPhysical`, `transfersCheckPair`). Mismo motivo
 * que `DEST_WH_VIVO`: una regla de integridad repetida a mano se desincroniza — y acá ya había
 * cuatro copias de la ventana de 15 días.
 *
 * `s` = alias del embarque (necesita `doc_date` y `dest_wh_id` ya resuelto a almacén vivo),
 * `r` = alias de la recepción (necesita `doc_date` y `warehouse_id`).
 */
const TRANSFER_PAIR_MATCH = (s: string, r: string) => `(
       (${s}.dest_wh_id IS NOT NULL AND ${s}.dest_wh_id = ${r}.warehouse_id
        AND ${r}.doc_date BETWEEN ${s}.doc_date - ${PAIR_EARLY_DAYS} AND ${s}.doc_date + ${PAIR_LATE_DAYS})
    OR (${s}.dest_wh_id IS NULL
        AND ${r}.doc_date BETWEEN ${s}.doc_date AND ${s}.doc_date + ${PAIR_BLIND_DAYS}))`;

/** Mismo criterio en JS, para los pareos que se resuelven en memoria. Fechas en milisegundos. */
const pairMatchJs = (shipMs: number, rcvMs: number, destWhId: string | null, rcvWhId: string | null): boolean => {
  const d = (n: number) => n * 864e5;
  return destWhId && destWhId === rcvWhId
    ? rcvMs >= shipMs - d(PAIR_EARLY_DAYS) && rcvMs <= shipMs + d(PAIR_LATE_DAYS)
    : !destWhId && rcvMs >= shipMs && rcvMs <= shipMs + d(PAIR_BLIND_DAYS);
};

/**
 * `[DM.22]` — **el pareo tiene que MIRAR fuera del rango y REPORTAR dentro.**
 *
 * ⛔ El defecto que esto cierra: las dos CTEs de candidatos usaban **la misma ventana** que el
 * rango que pidió la persona, mientras `TRANSFER_PAIR_MATCH` declara que una recepción puede
 * fecharse hasta **90 días** después de su embarque (y hasta 15 antes). O sea que el pareo
 * afirmaba una tolerancia que su propia fuente de datos no le daba: todo lo que cayera del otro
 * lado del borde no estaba *sin pareja*, estaba **fuera de la foto**.
 *
 * ⚠️ Y no falla como se esperaría. No deja huecos: **fabrica hallazgos**, que es peor, porque un
 * hallazgo falso se ve exactamente igual que uno real y manda a alguien a buscar un documento
 * que sí existe. Medido contra prod el 2026-10-09:
 *
 * | ventana            | `sin_origen` publicados | de ésos FALSOS | `sin acuse` | FALSOS | monto falso |
 * |--------------------|------------------------:|---------------:|------------:|-------:|------------:|
 * | mes en curso       |                      38 |     **38 (100%)** |          99 |      0 |           — |
 * | default 30 días    |                      24 |        22 (92%) |         124 |      0 |           — |
 * | septiembre-2026    |                      21 |        19 (90%) |          75 | **40 (53%)** | $480,134.57 |
 * | agosto-2026        |                      15 |     **15 (100%)** |          46 | **19 (41%)** | $289,678.50 |
 *
 * ⭐ Los dos lados fallan por motivos DISTINTOS, y por eso las dos columnas de ceros no son
 * suerte: `sin_origen` se rompe en **toda** ventana (el embarque es anterior al rango, y siempre
 * hay embarques anteriores); `sin acuse` sólo se rompe cuando la ventana **termina en el pasado**
 * (una recepción posterior a hoy todavía no existe, así que con `to = hoy` no hay nada que
 * perder). O sea que el mes en curso miente en una punta y un mes cerrado miente en las dos —
 * y el selector de la pantalla ofrece justamente meses cerrados.
 *
 * ⛔ **Ensanchar el rango por default NO lo arregla**: mueve el borde, no lo quita. Con 90 días
 * el mismo embarque de hace 91 vuelve a aparecer como huérfano. Lo que corrige es separar
 * *candidato* de *reportado*, que es el patrón que este mismo archivo ya usa en `[DM.12]` para
 * las pólizas ("sólo reporta dentro del rango; los meses de padding sólo son candidatos").
 *
 * ⚠️ El `DISTINCT ON` se resuelve **antes** de recortar al rango, a propósito: filtrar primero
 * puede descartar al mejor candidato y dejar que el desempate elija a uno peor — el pareo saldría
 * distinto según la ventana que se mire, que es exactamente lo que esto viene a evitar.
 *
 * ⭐ Y de paso deja de haber TRES copias de este bloque. La tercera (`transfersCheckPair`) ya
 * había derivado: su `coalesce` del destino perdía `u.dest_code`, así que un destino sin etiqueta
 * salía en blanco sólo en el drill. Es el mismo motivo por el que existen `DEST_WH_VIVO` y
 * `TRANSFER_PAIR_MATCH`: una regla repetida a mano se desincroniza.
 *
 * Devuelve desde el `WITH` hasta `) t`; cada quien le pega su `WHERE`/`ORDER BY`/`LIMIT`.
 * Los parámetros van en {@link TRANSFER_PAIRING_PARAMS}, en ese orden.
 *
 * [MX.1.1] El veredicto `ok` exige la suma de piezas **y** la firma de productos ({@link SKU_SIG}).
 */
const TRANSFER_PAIRING_SQL = (shpDestSql: string) => `
        WITH shp AS (
          -- ⚠️ NADA de joins acá adentro. El agregado recorre ~40k renglones de traspaso y cada
          -- join que cuelgue de él se evalúa por RENGLÓN: el planner elige un nested loop contra
          -- commercial.warehouses (28 filas, estimadas en 1) y el agregado pasa de 0.3 s a 2.4 s.
          -- Los nombres y el destino se resuelven en shpd, sobre ~2k DOCUMENTOS. Medido 2026-10-06.
          -- [DM.22] ventana de CANDIDATOS: un embarque puede preceder a su recepcion por hasta
          -- PAIR_LATE_DAYS, o fecharse hasta PAIR_EARLY_DAYS despues de ella. Cuesta 14 ms.
          SELECT m.warehouse_id, m.folio, m.doc_serie, m.tenant_id,
                 MIN(m.doc_date) AS doc_date, SUM(m.qty) AS qty, SUM(m.amount) AS amount, COUNT(*)::int AS lineas,
                 max(m.dest_code) AS dest_code, max(m.dest_label) AS dest_label, ${SKU_SIG('m')} AS sku_sig,
                 COUNT(*) FILTER (WHERE m.amount IS NULL)::int AS lineas_sin_importe
          FROM analytics.stock_movements m
          WHERE m.tenant_id = ? AND m.doc_code = 'TrsfShip'
            AND m.doc_date BETWEEN ?::date - ${PAIR_LATE_DAYS} AND ?::date + ${PAIR_EARLY_DAYS}${shpDestSql}
          GROUP BY m.warehouse_id, m.folio, m.doc_serie, m.tenant_id
        ), shpd AS (
          -- [DM.20] a dónde va dirigido CADA embarque: es la LLAVE del pareo, no un adorno.
          -- [DM.15] sólo si el almacén sigue vivo; si no, cuenta como "sin destino resuelto".
          SELECT s.*, coalesce(w.name, w.code) AS wh_code, dw.id AS dest_wh_id
          FROM shp s
          LEFT JOIN commercial.warehouses w ON w.id = s.warehouse_id
          LEFT JOIN analytics.transfer_dest_map dmx ON dmx.tenant_id = s.tenant_id AND dmx.dest_code = s.dest_code
          LEFT JOIN commercial.warehouses dw ON dw.id = dmx.warehouse_id AND ${DEST_WH_VIVO('dw')}
        ), rcv AS (
          -- [DM.22] misma ventana de candidatos, espejada.
          SELECT m.warehouse_id, m.folio, m.parent_serie, m.parent_folio,
                 MIN(m.doc_date) AS doc_date, SUM(m.qty) AS qty, COUNT(*)::int AS lineas, ${SKU_SIG('m')} AS sku_sig
          FROM analytics.stock_movements m
          WHERE m.tenant_id = ? AND m.doc_code = 'TrsfRcv' AND m.parent_group = '41'
            AND m.doc_date BETWEEN ?::date - ${PAIR_EARLY_DAYS} AND ?::date + ${PAIR_LATE_DAYS}
          GROUP BY m.warehouse_id, m.folio, m.parent_serie, m.parent_folio
        ), paired_all AS (
          -- ⚠️ Un LEFT JOIN LATERAL con LIMIT 1 sobre una CTE la re-escanea ENTERA una vez por
          -- recepción: con ~600 recepciones × ~2,000 embarques eran 2.6 s de los 3.5 s totales, y
          -- una CTE no se puede indexar. El mismo "mejor candidato" sale de un hash join + un
          -- DISTINCT ON, que recorre cada lado UNA vez. Mismo orden de desempate, mismo resultado
          -- (verificado fila a fila contra la versión LATERAL). Medido el 2026-10-06.
          SELECT DISTINCT ON (r.warehouse_id, r.folio, r.parent_serie, r.parent_folio)
                 s.warehouse_id AS origin_wh_id, s.wh_code AS origin_wh, s.folio AS origin_folio,
                 s.doc_serie, s.doc_date AS ship_date, s.qty AS qty_sent, s.amount, s.lineas AS ship_lines,
                 r.warehouse_id AS dest_wh_id, coalesce(rw.name, rw.code) AS dest_wh, r.folio AS rcv_folio,
                 r.doc_date AS rcv_date, r.qty AS qty_received, r.lineas AS rcv_lines,
                 s.sku_sig AS ship_sig, r.sku_sig AS rcv_sig, s.lineas_sin_importe AS ship_lineas_sin_importe
          FROM rcv r
          LEFT JOIN commercial.warehouses rw ON rw.id = r.warehouse_id
          LEFT JOIN shpd s
            ON s.folio = r.parent_folio
           AND coalesce(s.doc_serie,'') = coalesce(r.parent_serie,'')
           AND s.warehouse_id <> r.warehouse_id
           AND ${TRANSFER_PAIR_MATCH('s', 'r')}
          ORDER BY r.warehouse_id, r.folio, r.parent_serie, r.parent_folio,
                   abs(coalesce(s.qty,0) - coalesce(r.qty,0)) ASC, abs(s.doc_date - r.doc_date) ASC
        ), paired AS (
          -- [DM.22] recién acá se recorta al rango, y basta con que CUALQUIER pata caiga dentro:
          -- un embarque del rango recibido después sigue siendo un documento del rango, y ocultarlo
          -- sería cambiar una mentira (decía "sin acuse") por un hueco.
          SELECT * FROM paired_all
           WHERE rcv_date BETWEEN ?::date AND ?::date OR ship_date BETWEEN ?::date AND ?::date
        ), unreceived AS (
          -- Acá el ancla es el EMBARQUE: se reporta el del rango, pero la recepción que lo salva
          -- puede estar fuera (y con el fin de rango en el pasado, lo esta el 41-53% de las veces).
          SELECT s.* FROM shpd s
          WHERE s.doc_date BETWEEN ?::date AND ?::date
            AND NOT EXISTS (
            SELECT 1 FROM rcv r
            WHERE r.parent_folio = s.folio AND coalesce(r.parent_serie,'') = coalesce(s.doc_serie,'')
              AND r.warehouse_id <> s.warehouse_id
              AND ${TRANSFER_PAIR_MATCH('s', 'r')})
        )
        SELECT * FROM (
          SELECT origin_wh_id, origin_wh, origin_folio, doc_serie, ship_date, qty_sent, amount, ship_lines,
                 dest_wh_id, dest_wh, rcv_folio, rcv_date, qty_received, rcv_lines,
                 CASE
                   WHEN origin_folio IS NULL THEN 'sin_origen'
                   WHEN abs(coalesce(qty_sent,0) - coalesce(qty_received,0)) < 0.01
                    AND ship_sig = rcv_sig THEN 'ok'   -- [MX.1.1] y los mismos productos
                   ELSE 'diferencia'
                 END AS status,
                 coalesce(qty_received,0) - coalesce(qty_sent,0) AS delta,
                 ship_lineas_sin_importe AS lineas_sin_importe   -- [MX.1.2] el importe sale del embarque
          FROM paired
          UNION ALL
          SELECT u.warehouse_id, u.wh_code, u.folio, u.doc_serie, u.doc_date, u.qty, u.amount, u.lineas,
                 dw.id, coalesce(dw.name, dw.code, u.dest_label, u.dest_code), NULL, NULL, NULL, NULL, 'sin_recepcion', -u.qty, u.lineas_sin_importe
          FROM unreceived u
          LEFT JOIN analytics.transfer_dest_map dm ON dm.tenant_id = ? AND dm.dest_code = u.dest_code
          LEFT JOIN commercial.warehouses dw ON dw.id = dm.warehouse_id AND ${DEST_WH_VIVO('dw')}
        ) t`;

/**
 * Los 13 parámetros de {@link TRANSFER_PAIRING_SQL}, en el orden en que aparecen sus marcadores:
 * `shp` (tenant, from, to) · `rcv` (tenant, from, to) · `paired` (from, to, from, to — son DOS
 * rangos, uno por pata) · `unreceived` (from, to) · el mapa de destino (tenant).
 *
 * ⚠️ Contar a ojo salió mal la primera vez: el `OR` de `paired` lleva cuatro, no dos, y un
 * desfase de uno no explota — corre y devuelve otra cosa. Lo atrapó el verificador que rinde este
 * mismo template a SQL y cuenta los marcadores contra la lista. Si se agrega un `?`, va acá.
 */
/** [MX.2.3] Una fila de {@link TRANSFER_PAIRING_SQL}. Los `numeric` de Postgres llegan como texto. */
interface FilaPareo {
  origin_wh_id: string | null; origin_wh: string | null; origin_folio: string | null; doc_serie: string | null;
  ship_date: Date | string | null; qty_sent: string | number | null; amount: string | number | null; ship_lines: number | null;
  dest_wh_id: string | null; dest_wh: string | null; rcv_folio: string | null; rcv_date: Date | string | null;
  qty_received: string | number | null; rcv_lines: number | null;
  status: 'ok' | 'diferencia' | 'sin_recepcion' | 'sin_origen'; delta: string | number | null; lineas_sin_importe: number | null;
}

const TRANSFER_PAIRING_PARAMS = (tenantId: string, from: string, to: string) =>
  [tenantId, from, to, tenantId, from, to, from, to, from, to, from, to, tenantId];

@Injectable()
export class CommercialMovementsService {
  private readonly logger = new Logger(CommercialMovementsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private group(v?: string): GroupBy {
    return (GROUPS as readonly string[]).includes(v || '') ? (v as GroupBy) : 'product';
  }

  private whIds(q: MovementsQuery): string[] {
    return (q.warehouse_ids || q.warehouse_id || '')
      .split(',').map((s) => s.trim()).filter((s) => UUID_RX.test(s));
  }

  private transferWhIds(q: MovementsQuery): string[] {
    return (q.transfer_wh_ids || '')
      .split(',').map((s) => s.trim()).filter((s) => UUID_RX.test(s));
  }

  /**
   * DM.11b — tipos de destino de traspaso a mostrar (default 'sucursal'). Un TrsfShip va a:
   *   sucursal → otra sucursal (dest_code 'TI###'; el traspaso interno "primordial")
   *   ruta     → ruta de reparto (R.D./R.V./RUTA)
   *   cliente  → tienda/cliente u otro (resto: ABARROTES…, TLMKT, códigos sueltos)
   */
  private destKinds(q: MovementsQuery): ('sucursal' | 'ruta' | 'cliente')[] {
    const ks = (q.dest_kinds || '').split(',').map((s) => s.trim().toLowerCase())
      .filter((s) => s === 'sucursal' || s === 'ruta' || s === 'cliente') as ('sucursal' | 'ruta' | 'cliente')[];
    // DM.11c — sin parámetro ⇒ MOSTRAR TODO (no ocultar movimientos por default). El scope
    // "solo sucursal" es opt-in explícito desde el front. Los 3 ⇒ destBucketSql='' ⇒ sin filtro.
    // Dedup con filter+indexOf (NO `[...new Set()]`): el bundle webpack de la API downlevelea
    // mal el spread de Set → devolvía `[Set]` en vez de los valores → destBucketSql='false' →
    // el filtro Destino no arrojaba nada (bug prod diagnosticado 2026-08). Ver [[feedback_...]].
    const uniq = ks.filter((v, i) => ks.indexOf(v) === i);
    return uniq.length ? uniq : ['sucursal', 'ruta', 'cliente'];
  }

  /** SQL por bucket de destino (sobre m.dest_code/m.dest_label). */
  private destBucketSql(kinds: ('sucursal' | 'ruta' | 'cliente')[], tenantId: string): string {
    if (kinds.length === 3) return ''; // todos = sin filtro
    const isRoute = `(coalesce(m.dest_label,'') ~* '${ROUTE_RX}' OR coalesce(m.dest_code,'') ~* '${ROUTE_RX}')`;
    // Sucursal = traspaso interno cuyo destino RESUELVE a un almacén (no ruta). Tres caminos,
    // cualquiera basta (tenantId viene de requireTenantId() → UUID, inline seguro):
    //   1) patrón histórico CEDIS 'TI###'.
    //   2) mapa CURADO transfer_dest_map (warehouse_id NO nulo).
    //   3) el dest_code coincide con el `code` de un almacén: prod usa el nº de sucursal
    //      ('01'..'05'), local usa 'MD-NN' → probamos dest_code y 'MD-'||dest_code.
    // Antes solo (1)+(2): los traspasos con dest_code = nº de sucursal ('04','05'…) NO
    // matcheaban y caían en el bucket "cliente" → al filtrar Sucursal DESAPARECÍAN (bug
    // reportado: "solo los veo si deselecciono el destino"). El nº de cliente ('45','103')
    // no resuelve a ningún almacén → sigue en "cliente", que es lo correcto.
    const resolvesWh = `EXISTS (
      SELECT 1 FROM commercial.warehouses sw
      WHERE sw.tenant_id = '${tenantId}'::uuid AND sw.deleted_at IS NULL AND sw.code NOT ILIKE 'RUTA%'
        AND upper(sw.code) IN (upper(coalesce(m.dest_code,'')), 'MD-' || upper(coalesce(m.dest_code,''))))`;
    const isSuc = `(NOT ${isRoute} AND (
      m.dest_code ILIKE 'TI%'
      OR EXISTS (SELECT 1 FROM analytics.transfer_dest_map dm
                 JOIN commercial.warehouses w ON w.id = dm.warehouse_id AND ${DEST_WH_VIVO()}
                 WHERE dm.tenant_id = '${tenantId}'::uuid AND dm.dest_code = m.dest_code)
      OR ${resolvesWh}))`;
    const conds: string[] = [];
    if (kinds.includes('sucursal')) conds.push(isSuc);
    if (kinds.includes('ruta')) conds.push(isRoute);
    if (kinds.includes('cliente')) conds.push(`(NOT ${isSuc} AND NOT ${isRoute})`);
    return conds.length ? `(${conds.join(' OR ')})` : `false`;
  }

  /** WHERE de destino: acota los TrsfShip por bucket; no toca el resto de docs. */
  private applyDestFilter(b: any, q: MovementsQuery, tenantId: string) {
    const sql = this.destBucketSql(this.destKinds(q), tenantId);
    if (sql) b.whereRaw(`(m.doc_code <> 'TrsfShip' OR ${sql})`);
  }

  /** Rango por default: últimos 30 días. */
  private range(q: MovementsQuery): { from: string; to: string } {
    const to = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : new Date().toISOString().slice(0, 10);
    const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)
      ? q.from
      : new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    return { from, to };
  }

  /** WHERE base reutilizable (tenant + rango + filtros). */
  private base(trx: any, tenantId: string, q: MovementsQuery) {
    const { from, to } = this.range(q);
    const b = trx('analytics.stock_movements as m')
      .where('m.tenant_id', tenantId)
      .andWhere('m.doc_date', '>=', from)
      .andWhere('m.doc_date', '<=', to);
    const whs = this.whIds(q);
    if (whs.length) b.whereIn('m.warehouse_id', whs);
    if (q.doc_code) b.where('m.doc_code', q.doc_code);
    if (q.movement_kind === 'entrada' || q.movement_kind === 'salida') b.where('m.movement_kind', q.movement_kind);
    if (q.product_id && UUID_RX.test(q.product_id)) b.where('m.product_id', q.product_id);
    if (q.folio) b.where('m.folio', q.folio);
    // Tipos INFORMATIVOS (k_binv=0, ej. Aplicación de orden de entrada XA20): espejan las
    // líneas de su doc padre → fuera de KPIs y listado, salvo filtro explícito por ese tipo
    if (!INFO_DOC_CODES.includes(q.doc_code || '')) b.whereNot('m.movement_kind', 'info');
    // estado y origen/destino solo aplican a traspasos → todo (summary/aggregate/lines) se acota a ellos
    if (TRANSFER_DOC_STATUSES.includes(q.estado || '') || this.transferWhIds(q).length) {
      b.whereIn('m.doc_code', ['TrsfShip', 'TrsfRcv']);
    }
    // Origen/Destino (traspasos): el doc involucra al almacén seleccionado como ORIGEN
    // (m.warehouse_id — TrsfShip que sale de él / TrsfRcv que recibe) o como DESTINO
    // (dest_code → transfer_dest_map). Sin la rama de DESTINO, los despachos a tiendas Wincaja
    // (dest TI004/TI006/TI009 → 30/50/32) NO aparecían al filtrar por ellas: su warehouse_id es
    // el CEDIS y su recepción no está en stock_movements → no había contraparte que parear.
    // Se aplica en base() (no solo en el drill) → summary/aggregate/lines quedan CONSISTENTES.
    const twhs = this.transferWhIds(q);
    if (twhs.length) {
      const ph = twhs.map(() => '?').join(',');
      b.andWhere(function (this: any) {
        this.whereIn('m.warehouse_id', twhs)
          .orWhereRaw(
            `EXISTS (SELECT 1 FROM analytics.transfer_dest_map dm
                       JOIN commercial.warehouses w ON w.id = dm.warehouse_id AND ${DEST_WH_VIVO()}
                      WHERE dm.tenant_id = ?::uuid AND dm.dest_code = m.dest_code AND dm.warehouse_id IN (${ph}))`,
            [tenantId, ...twhs],
          );
      });
    }
    // DM.11b — destino: por defecto oculta traspasos a rutas de reparto (no primordial)
    this.applyDestFilter(b, q, tenantId);
    if (q.search) {
      b.whereIn('m.product_id',
        trx('public.products').select('id').where('tenant_id', tenantId)
          .andWhere((w: any) => w.whereILike('nombre', `%${q.search}%`).orWhereILike('sku', `%${q.search}%`)));
    }
    return b;
  }

  private entradas = `SUM(CASE WHEN m.signed_qty > 0 THEN m.qty ELSE 0 END)`;
  private salidas = `SUM(CASE WHEN m.signed_qty < 0 THEN m.qty ELSE 0 END)`;

  /**
   * DM.14 — Buscador de folios: dado un folio devuelve TODOS los documentos que lo llevan
   * (folio×almacén×tipo×serie), porque en Kepler el folio NO es único entre doctypes/sucursales
   * (ej. '0002122' = Sale2 + TrsfShip + …). Cada fila es "abrible" con document(). Tolera ceros a
   * la izquierda: "2122" ⇒ '0002122'. Match por igualdad sobre candidatos (index-friendly, evita
   * el regexp full-scan). Dedup con filter+indexOf, NO `[...new Set()]` (el bundle de la API
   * downlevelea mal el spread de Set → ver [[feedback_webpack_set_spread_downlevel]]).
   */
  async folioSearch(folioRaw: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const folio = (folioRaw || '').trim();
    if (!folio) return { folio: '', count: 0, rows: [] as any[] };
    const stripped = folio.replace(/^0+/, '') || folio;
    const list = [folio, stripped, stripped.padStart(5, '0'), stripped.padStart(6, '0'), stripped.padStart(7, '0'), stripped.padStart(8, '0')];
    const cands = list.filter((v, i) => v && list.indexOf(v) === i);
    return this.tk.run(async (trx) => {
      const rows = await trx('analytics.stock_movements as m')
        .where('m.tenant_id', tenantId)
        .whereIn('m.folio', cands)
        .leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id')
        .groupBy('m.folio', 'm.warehouse_id', 'm.source_branch', 'm.doc_code', 'm.doc_serie', 'm.movement_label', 'm.movement_kind', 'w.code', 'w.name')
        .select(
          'm.folio', 'm.warehouse_id', 'm.source_branch', 'm.doc_code', 'm.doc_serie',
          'm.movement_label', 'm.movement_kind', 'w.code as warehouse_code', 'w.name as warehouse_name',
        )
        .select(
          trx.raw(`MIN(m.doc_date) AS doc_date`),
          trx.raw(`MAX(m.dest_code) AS dest_code`),
          trx.raw(`MAX(m.dest_label) AS dest_label`),
          trx.raw(`COUNT(*)::int AS lineas`),
          trx.raw(`SUM(m.qty) AS qty`),
          trx.raw(`SUM(m.amount) AS amount`),
        )
        .orderByRaw(`MIN(m.doc_date) DESC`)
        .limit(100);
      return { folio, count: rows.length, rows };
    });
  }

  /** KPIs de cabecera + desglose por tipo de documento. */
  async summary(q: MovementsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [tot] = await this.base(trx, tenantId, q).select(
        trx.raw(`${this.entradas} AS entradas`),
        trx.raw(`${this.salidas} AS salidas`),
        trx.raw(`SUM(m.signed_qty) AS neto`),
        trx.raw(`SUM(m.amount) AS valor`),
        trx.raw(`COUNT(*)::int AS lineas`),
        // [MX.1.2] renglones cuyo costo Kepler asentó en 0: el `valor` no los incluye y hay que decirlo
        trx.raw(`COUNT(*) FILTER (WHERE m.amount IS NULL)::int AS lineas_sin_importe`),
      );
      // [MX.2.2] Un documento es almacén+tipo+serie+folio, no el folio: el mismo folio lo usan
      // sucursales y tipos distintos. `COUNT(DISTINCT m.folio)` publicaba 3,772 documentos en
      // 30 d cuando eran 8,139 (medido en prod 2026-10-28). Se cuenta agrupando en un subquery:
      // `COUNT(DISTINCT (…4 columnas…))` da lo mismo pero cuesta 10× (48 ms contra 520 ms en 30 d).
      const [docs] = await trx.count<{ n: string | number }[]>('* as n').from(
        this.base(trx, tenantId, q).groupBy(...DOC_IDENTITY).select(trx.raw('1')).as('d'),
      );
      tot.documentos = Number(docs?.n ?? 0);
      const byType = await this.base(trx, tenantId, q)
        .select('m.doc_code', 'm.movement_label', 'm.movement_kind')
        .select(
          trx.raw(`SUM(m.qty) AS piezas`),
          trx.raw(`SUM(m.amount) AS valor`),
          trx.raw(`COUNT(*)::int AS lineas`),
        )
        .groupBy('m.doc_code', 'm.movement_label', 'm.movement_kind')
        .orderBy('lineas', 'desc');
      const { from, to } = this.range(q);
      return { range: { from, to }, totals: tot, by_type: byType };
    });
  }

  /** Vista DEFAULT agregada. group_by = product | doc_code | day | warehouse. */
  async aggregate(q: MovementsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const g = this.group(q.group_by);
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));

    return this.tk.run(async (trx) => {
      // [MX.2.2] Dos niveles: primero UN renglón por documento (DOC_IDENTITY) dentro de cada
      // grupo, después se suman. `COUNT(DISTINCT m.folio)` juntaba el mismo folio de sucursales y
      // tipos distintos (por día, 30 d: 6,785 contra 7,103 reales). Y sale más barato que contar
      // la identidad con DISTINCT: por día en 90 d, 273 ms contra 290 ms de antes (2026-10-28).
      const build = () => {
        const d = this.base(trx, tenantId, q).groupBy(...DOC_IDENTITY).select(
          trx.raw(`${this.entradas} AS entradas`),
          trx.raw(`${this.salidas} AS salidas`),
          trx.raw(`SUM(m.signed_qty) AS neto`),
          trx.raw(`SUM(m.amount) AS valor`),
          trx.raw(`COUNT(*)::int AS lineas`),
        );
        if (g === 'product') d.groupBy('m.product_id').select('m.product_id');
        else if (g === 'doc_code') d.groupBy('m.movement_label', 'm.movement_kind').select('m.doc_code', 'm.movement_label', 'm.movement_kind');
        else if (g === 'day') d.groupBy('m.doc_date').select('m.doc_date');
        else d.select('m.warehouse_id');

        const b = trx.from(d.as('d'));
        if (g === 'product') {
          b.leftJoin('public.products as p', function (this: any) {
            this.on('p.id', 'd.product_id').andOnVal('p.tenant_id', tenantId);
          }).groupBy('d.product_id', 'p.nombre', 'p.sku')
            .select('d.product_id as key', 'p.nombre as label', 'p.sku as sku');
        } else if (g === 'doc_code') {
          b.groupBy('d.doc_code', 'd.movement_label', 'd.movement_kind')
            .select('d.doc_code as key', 'd.movement_label as label', 'd.movement_kind');
        } else if (g === 'day') {
          b.groupBy('d.doc_date').select('d.doc_date as key', 'd.doc_date as label');
        } else {
          b.leftJoin('commercial.warehouses as w', 'w.id', 'd.warehouse_id')
            .groupBy('d.warehouse_id', 'w.name', 'w.code')
            .select('d.warehouse_id as key', 'w.name as label', 'w.code as code');
        }
        return b.select(
          trx.raw(`SUM(d.entradas) AS entradas`),
          trx.raw(`SUM(d.salidas) AS salidas`),
          trx.raw(`SUM(d.neto) AS neto`),
          trx.raw(`SUM(d.valor) AS valor`),
          trx.raw(`SUM(d.lineas)::int AS lineas`),
          trx.raw(`COUNT(*)::int AS documentos`),
        );
      };

      // Conteo sobre el subquery agrupado (NO materializar todas las filas dos veces).
      const countRows: any[] = await trx.count('* as count').from(build().as('g'));
      const total = Number(countRows[0]?.count ?? 0);
      // Vista 'day' ordena cronológicamente: con pageSize cap, page 1 = los días MÁS RECIENTES
      // (ordenar por valor truncaría días recientes de bajo monto en rangos > pageSize).
      const orderSql = g === 'day' ? 'd.doc_date DESC' : 'SUM(d.valor) DESC NULLS LAST';
      const rows = await build()
        .orderByRaw(orderSql)
        .limit(pageSize).offset((page - 1) * pageSize);

      return { group_by: g, page, pageSize, total, rows };
    });
  }

  /**
   * DRILL: folios de una rama, ENGLOBADOS — una fila por documento (folio×tipo×almacén),
   * no por línea. `lineas` dice cuántos productos trae; el detalle lo da document().
   * Para traspasos anota `transfer_status` (en_transito|completado|diferencia); con
   * `?estado=` filtra por ese estado (restringe a docs de traspaso y pagina en memoria).
   */
  async lines(q: MovementsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(q.pageSize) || 100));
    const estado = TRANSFER_DOC_STATUSES.includes(q.estado || '') ? (q.estado as TransferDocStatus) : null;
    return this.tk.run(async (trx) => {
      // base() ya acota a docs de traspaso cuando hay estado u origen/destino
      const grouped = () => this.base(trx, tenantId, q)
        .groupBy('m.warehouse_id', 'm.folio', 'm.doc_code', 'm.doc_serie', 'm.movement_label', 'm.movement_kind', 'm.source_branch');
      const fetch = (limit: number, offset: number) => grouped()
        .leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id')
        // DM.4 — marca humana "auditado" (identidad doc = warehouse+doc_code+serie+folio)
        .leftJoin('commercial.stock_movement_audits as a', function (this: any) {
          this.on('a.tenant_id', 'm.tenant_id').andOn('a.warehouse_id', 'm.warehouse_id')
            .andOn('a.doc_code', 'm.doc_code').andOn('a.folio', 'm.folio')
            .andOn(trx.raw(`a.doc_serie = coalesce(m.doc_serie,'')`));
        })
        .groupBy('w.code', 'w.name')
        .select(
          'm.warehouse_id', 'm.folio', 'm.doc_code', 'm.doc_serie', 'm.movement_label', 'm.movement_kind',
          'm.source_branch', 'w.code as warehouse_code', 'w.name as warehouse_name',
        )
        .select(
          trx.raw(`MIN(m.doc_date) AS doc_date`),
          trx.raw(`COUNT(*)::int AS lineas`),
          trx.raw(`SUM(m.signed_qty) AS signed_qty`),
          trx.raw(`SUM(m.qty) AS qty`),
          trx.raw(`SUM(m.amount) AS amount`),
          trx.raw(`MAX(m.parent_group) AS parent_group`),
          trx.raw(`MAX(m.parent_serie) AS parent_serie`),
          trx.raw(`MAX(m.parent_folio) AS parent_folio`),
          trx.raw(`COUNT(a.id) > 0 AS audited`),
          trx.raw(`MAX(a.audited_by) AS audited_by`),
          trx.raw(`MAX(a.created_at) AS audited_at`),
          // DM.11 — destino del traspaso (kdm1.c10 → kdud); dest por-doc, MAX es el valor único
          trx.raw(`MAX(m.dest_code) AS dest_code`),
          trx.raw(`MAX(m.dest_label) AS dest_label`),
          // [MX.1.1] firma de productos: annotateTransferStatus la compara con la de la contraparte
          trx.raw(`${SKU_SIG('m')} AS sku_sig`),
          // [MX.1.2] renglones sin importe (Kepler asentó costo 0): el `amount` del documento está incompleto
          trx.raw(`COUNT(*) FILTER (WHERE m.amount IS NULL)::int AS lineas_sin_importe`),
        )
        .orderByRaw('MIN(m.doc_date) DESC, m.folio DESC')
        .limit(limit).offset(offset);

      if (estado) {
        // 'estado' requiere el PAREO (transfer_status no es columna): computar sobre TODOS los
        // traspasos del rango (cap 2000) y paginar en memoria. El filtro origen/destino
        // (transfer_wh_ids) ya lo aplicó base() en SQL → aquí no se re-filtra por almacén.
        const all = await fetch(2000, 0);
        // [MX.1.3] el DESTINO va primero también acá ([DM.20]: es la llave del pareo). Antes este
        // camino pareaba sin destino (ventana ciega para todos) y anotaba el destino después, sólo
        // en la página: con el estado por destino de MX.1.3 todo caía en «a ruta o cliente».
        await this.annotateDest(trx, tenantId, all);
        await this.annotateTransferStatus(trx, tenantId, all);
        const filtered = all.filter((r: any) => r.transfer_status === estado);
        const rows = filtered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
        return { page, pageSize, total: filtered.length, rows };
      }

      const countRows: any[] = await trx.count('* as count').from(grouped().select('m.folio').as('g'));
      const count = countRows[0]?.count ?? 0;
      const rows = await fetch(pageSize, (page - 1) * pageSize);
      // [DM.20] el DESTINO va primero: el pareo lo usa como llave, no como adorno.
      await this.annotateDest(trx, tenantId, rows);
      await this.annotateTransferStatus(trx, tenantId, rows);
      return { page, pageSize, total: Number(count), rows };
    });
  }

  /**
   * DM.3 — anota `transfer_status` + `cp_warehouse_id` (almacén de la contraparte, para el
   * filtro origen/destino) en filas de traspaso (mismo ranking que transfersCheck:
   * candidato con cantidad más cercana, luego fecha). Ship sin recepción = estadoSinRecepcion() [MX.1.3];
   * recepción sin origen visible = diferencia (a revisar).
   */
  private async annotateTransferStatus(trx: any, tenantId: string, rows: any[]): Promise<void> {
    const ships = rows.filter((r) => r.doc_code === 'TrsfShip');
    const rcvs = rows.filter((r) => r.doc_code === 'TrsfRcv');
    /** [MX.1.1] mismas piezas Y mismos productos (firma {@link SKU_SIG}; numeric llega como string). */
    const mismoTraspaso = (cand: { q: unknown; sig: unknown }, doc: { qty: unknown; sku_sig: unknown }) =>
      Math.abs(Number(cand.q) - Number(doc.qty)) < 0.01 && cand.sig != null && String(cand.sig) === String(doc.sku_sig);
    const near = (cands: any[], qty: number, date: any) => {
      if (!cands.length) return null;
      const t = new Date(date).getTime();
      return [...cands].sort((a, b) =>
        Math.abs(Number(a.q) - qty) - Math.abs(Number(b.q) - qty) ||
        Math.abs(new Date(a.d).getTime() - t) - Math.abs(new Date(b.d).getTime() - t))[0];
    };
    if (ships.length) {
      const cands = await trx('analytics.stock_movements as m')
        .where('m.tenant_id', tenantId).andWhere('m.doc_code', 'TrsfRcv').andWhere('m.parent_group', '41')
        .whereIn('m.parent_folio', ships.map((s) => s.folio))
        /**
         * `[DM.23]` ⛔ **`m.folio` en el GROUP BY, o se suman recepciones de embarques distintos.**
         *
         * Una recepción es un DOCUMENTO: `(warehouse_id, folio)`. Agrupar sólo por
         * `(parent_folio, parent_serie, warehouse_id)` junta en un solo candidato todas las
         * recepciones que ese almacén haya hecho alguna vez contra ESE número de folio padre — y
         * los folios de Kepler son secuencias POR SUCURSAL, así que se reciclan.
         *
         * Medido en prod (2026-10-12), el caso que lo destapó: el embarque `0000038` de 8 Esquinas
         * mandó **750** a Padre Hidalgo y la recepción `0000401` recibió **750**. Pero Padre
         * Hidalgo también tenía la recepción `0000391` (6-oct, 131 unidades) contra otro embarque
         * que TAMBIÉN se llamaba `0000038`, de otra plaza. El grupo sumaba **881** y la lista
         * publicaba «diferencia» sobre un traspaso que cuadra al peso.
         *
         * ⚠️ Y la ventana no lo salvaba: `PAIR_EARLY_DAYS` admite la recepción hasta 15 días
         * ANTES del embarque, así que la del 6-oct entraba contra uno del 8-oct.
         *
         * ⭐ Son **45 grupos en 90 días** los que mezclan documentos así. Cada uno es una
         * «diferencia» probablemente falsa — y el detalle del documento, que sí parea uno a uno,
         * decía lo contrario en la misma pantalla.
         */
        .groupBy('m.parent_folio', 'm.parent_serie', 'm.warehouse_id', 'm.folio')
        .select('m.parent_folio as pf', 'm.warehouse_id as wh', 'm.folio as rf')
        .select(trx.raw(`coalesce(m.parent_serie,'') AS ps`), trx.raw(`SUM(m.qty) AS q`), trx.raw(`MIN(m.doc_date) AS d`),
          trx.raw(`${SKU_SIG('m')} AS sig`));
      for (const s of ships) {
        const sd = new Date(s.doc_date).getTime();
        // [DM.20] llave = el destino declarado (annotateDest ya corrió); sin él, ventana ciega.
        const mine = cands.filter((c: any) => c.pf === s.folio && c.ps === (s.doc_serie ?? '') && c.wh !== s.warehouse_id
          && pairMatchJs(sd, new Date(c.d).getTime(), s.dest_warehouse_id ?? null, c.wh));
        const best = near(mine, Number(s.qty), s.doc_date);
        // [MX.1.3] sin recepción: en tránsito sólo hasta SIN_ACUSE_DIAS, y sólo si va a un almacén
        s.transfer_status = !best ? estadoSinRecepcion(s.dest_warehouse_id, s.dest_warehouse_name, s.doc_date)
          : mismoTraspaso(best, s) ? 'completado' : 'diferencia';
        s.cp_warehouse_id = best ? best.wh : null;
      }
    }
    if (rcvs.length) {
      const cands = await trx('analytics.stock_movements as m')
        .where('m.tenant_id', tenantId).andWhere('m.doc_code', 'TrsfShip')
        .whereIn('m.folio', rcvs.map((r) => r.parent_folio).filter(Boolean))
        // [DM.20] a dónde iba dirigida CADA salida candidata — es la llave del pareo
        .leftJoin('analytics.transfer_dest_map as dm', function (this: any) {
          this.on('dm.tenant_id', 'm.tenant_id').andOn('dm.dest_code', 'm.dest_code');
        })
        .leftJoin('commercial.warehouses as dw', function (this: any) {
          this.on('dw.id', 'dm.warehouse_id').andOnNull('dw.deleted_at');
        })
        .groupBy('m.folio', 'm.doc_serie', 'm.warehouse_id')
        .select('m.folio as f', 'm.warehouse_id as wh')
        .select(trx.raw(`coalesce(m.doc_serie,'') AS s`), trx.raw(`SUM(m.qty) AS q`), trx.raw(`MIN(m.doc_date) AS d`),
          trx.raw(`MAX(dw.id::text) AS dest_wh`), trx.raw(`${SKU_SIG('m')} AS sig`));
      for (const r of rcvs) {
        if (r.parent_group !== '41' || !r.parent_folio) { r.transfer_status = 'diferencia'; continue; }
        const rd = new Date(r.doc_date).getTime();
        const mine = cands.filter((c: any) => c.f === r.parent_folio && c.s === (r.parent_serie ?? '') && c.wh !== r.warehouse_id
          && pairMatchJs(new Date(c.d).getTime(), rd, c.dest_wh ?? null, r.warehouse_id));
        const best = near(mine, Number(r.qty), r.doc_date);
        r.transfer_status = !best ? 'diferencia' : mismoTraspaso(best, r) ? 'completado' : 'diferencia';
        r.cp_warehouse_id = best ? best.wh : null;
      }
    }
  }

  /**
   * DM.11 — resuelve el DESTINO de los traspasos (TrsfShip): dest_label ya viene denormalizado;
   * acá se le agrega dest_warehouse_id + nombre curado vía analytics.transfer_dest_map (para
   * el filtro Origen/Destino y para nombrar "a quién va" cuando NO hay recepción). No mapeado
   * ⇒ solo dest_label (el nombre igual responde la pregunta).
   */
  private async annotateDest(trx: any, tenantId: string, rows: any[]): Promise<void> {
    // Dedup sin `[...new Set()]` (el bundle webpack de la API lo downlevelea mal → `[Set]`).
    const codesAll = rows.filter((r) => r.doc_code === 'TrsfShip' && r.dest_code).map((r) => r.dest_code);
    const codes = codesAll.filter((v, i) => codesAll.indexOf(v) === i);
    if (!codes.length) return;
    // [DM.15] el join EXIGE almacén vivo: si el mapa apunta a uno retirado, el destino queda
    // NULL y la fila se lee como "sin destino resuelto", no con el nombre de una sucursal que
    // no existe. La etiqueta del ERP (dest_label) sobrevive y sigue respondiendo la pregunta.
    const map = await trx('analytics.transfer_dest_map as dm')
      .where('dm.tenant_id', tenantId).whereIn('dm.dest_code', codes)
      .leftJoin('commercial.warehouses as w', function (this: any) {
        this.on('w.id', 'dm.warehouse_id').andOnNull('w.deleted_at');
      })
      .select('dm.dest_code', 'dm.dest_label as map_label',
        trx.raw(`CASE WHEN w.id IS NULL THEN NULL ELSE dm.warehouse_id END AS dest_warehouse_id`),
        trx.raw(`coalesce(w.name, w.code) AS dest_warehouse_name`));
    const byCode = new Map(map.map((m: any) => [m.dest_code, m]));
    for (const r of rows) {
      if (r.doc_code !== 'TrsfShip' || !r.dest_code) continue;
      const m: any = byCode.get(r.dest_code);
      r.dest_label = r.dest_label || m?.map_label || r.dest_code;
      r.dest_warehouse_id = m?.dest_warehouse_id ?? null;
      r.dest_warehouse_name = m?.dest_warehouse_name ?? null;
      // [MX.1.7] el importe de la salida está en la unidad de su destino (valor de traspaso / precio de venta / mezcla)
      r.unidad_importe = UNIDAD_IMPORTE_SALIDA[claseDestino(r.dest_warehouse_id, r.dest_warehouse_name)];
    }
  }

  /** DM.4 — marca/desmarca un documento como auditado. Identidad = wh+doc_code+serie+folio. */
  async setAudit(dto: { warehouse_id: string; doc_code: string; doc_serie?: string | null; folio: string; audited: boolean; note?: string | null }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const username = this.tenantCtx.get()?.username || null;
    if (!dto?.warehouse_id || !UUID_RX.test(dto.warehouse_id) || !dto.doc_code || !dto.folio) {
      throw new BadRequestException('warehouse_id, doc_code y folio son requeridos');
    }
    const serie = dto.doc_serie ?? '';
    return this.tk.run(async (trx) => {
      if (dto.audited === false) {
        const n = await trx('commercial.stock_movement_audits')
          .where({ tenant_id: tenantId, warehouse_id: dto.warehouse_id, doc_code: dto.doc_code, doc_serie: serie, folio: dto.folio })
          .delete();
        return { audited: false, removed: n };
      }
      await trx.raw(`
        INSERT INTO commercial.stock_movement_audits (tenant_id, warehouse_id, doc_code, doc_serie, folio, audited_by, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, warehouse_id, doc_code, doc_serie, folio)
        DO UPDATE SET audited_by = EXCLUDED.audited_by, note = EXCLUDED.note, updated_at = now()`,
        [tenantId, dto.warehouse_id, dto.doc_code, serie, dto.folio, username, dto.note ?? null]);
      return { audited: true, audited_by: username };
    });
  }

  /** DRILL 3: documento completo — TODAS las líneas de un folio (sin filtrar por producto). */
  async document(p: { folio: string; warehouse_id: string; doc_code?: string; doc_serie?: string }) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const q = trx('analytics.stock_movements as m')
        .where('m.tenant_id', tenantId)
        .andWhere('m.folio', p.folio)
        .leftJoin('public.products as p', function (this: any) {
          this.on('p.id', 'm.product_id').andOn('p.tenant_id', 'm.tenant_id');
        })
        .leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id');
      const delDocumento = <B extends { where(...a: unknown[]): unknown; whereRaw(...a: unknown[]): unknown }>(b: B): B => {
        if (p.warehouse_id && UUID_RX.test(p.warehouse_id)) b.where('m.warehouse_id', p.warehouse_id);
        if (p.doc_code) b.where('m.doc_code', p.doc_code);
        if (p.doc_serie != null && p.doc_serie !== '') b.whereRaw(`coalesce(m.doc_serie,'') = ?`, [p.doc_serie]);
        return b;
      };
      delDocumento(q);
      // [MX.1.1] firma de productos de ESTE documento, para compararla con la de su contraparte
      const [{ sku_sig: thisSig = null } = {}] = await delDocumento(
        trx('analytics.stock_movements as m').where('m.tenant_id', tenantId).andWhere('m.folio', p.folio),
      ).select(trx.raw(`${SKU_SIG('m')} AS sku_sig`));
      const lines = await q.select(
        'm.warehouse_id', 'm.doc_date', 'm.folio', 'm.doc_code', 'm.movement_label', 'm.movement_kind',
        'm.genero', 'm.naturaleza', 'm.doc_type', 'm.doc_serie', 'm.signed_qty', 'm.qty',
        'm.unit_cost', 'm.amount', 'm.parent_group', 'm.parent_serie', 'm.parent_folio', 'm.source_branch',
        'm.dest_code', 'm.dest_label',
        'w.code as warehouse_code', 'w.name as warehouse_name',
      )
        // SKU fuera de catálogo: sin product_name pero el sku denormalizado siempre está
        .select(trx.raw(`coalesce(p.nombre, '(sin catálogo)') AS product_name`), trx.raw(`coalesce(p.sku, m.sku) AS sku`))
        .orderByRaw(`coalesce(p.nombre, '(sin catálogo)')`);
      if (!lines.length) return { header: null, lines: [], totals: { qty: 0, amount: 0, lineas: 0 }, counterpart: null };
      const h = lines[0];
      // DM.4 — estado de auditoría humana del documento
      const auditRow = await trx('commercial.stock_movement_audits')
        .where({ tenant_id: tenantId, warehouse_id: h.warehouse_id, doc_code: h.doc_code, folio: h.folio })
        .andWhereRaw(`doc_serie = coalesce(?, '')`, [h.doc_serie])
        .first('audited_by', 'note', 'created_at');
      // DM.11 — destino del traspaso (solo TrsfShip); nombre curado vía transfer_dest_map
      let destWarehouseId: string | null = null, destWarehouseName: string | null = null, destLabel: string | null = h.dest_label ?? null;
      if (h.doc_code === 'TrsfShip' && h.dest_code) {
        const dm = await trx('analytics.transfer_dest_map as dm')
          .where('dm.tenant_id', tenantId).andWhere('dm.dest_code', h.dest_code)
          .leftJoin('commercial.warehouses as w', function (this: any) {  // [DM.15] vivo o nada
            this.on('w.id', 'dm.warehouse_id').andOnNull('w.deleted_at');
          })
          .first('dm.dest_label', trx.raw(`w.id AS dest_warehouse_id`),
            trx.raw(`coalesce(w.name, w.code) AS dest_warehouse_name`));
        destWarehouseId = dm?.dest_warehouse_id ?? null;
        destWarehouseName = dm?.dest_warehouse_name ?? null;
        destLabel = destLabel || dm?.dest_label || h.dest_code;
      }
      const header = {
        folio: h.folio, doc_code: h.doc_code, doc_serie: h.doc_serie, movement_label: h.movement_label, movement_kind: h.movement_kind,
        doc_date: h.doc_date, genero: h.genero, naturaleza: h.naturaleza, doc_type: h.doc_type,
        warehouse_id: h.warehouse_id, warehouse_code: h.warehouse_code, warehouse_name: h.warehouse_name, source_branch: h.source_branch,
        parent_group: h.parent_group, parent_folio: h.parent_folio,
        dest_code: h.dest_code ?? null, dest_label: destLabel, dest_warehouse_id: destWarehouseId, dest_warehouse_name: destWarehouseName,
        audited: !!auditRow, audited_by: auditRow?.audited_by ?? null, audited_at: auditRow?.created_at ?? null,
      };
      // docs informativos: signed=0 por diseño → el total útil es la cantidad AMPARADA (qty)
      const isInfo = h.movement_kind === 'info';
      const totals = {
        qty: lines.reduce((s: number, l: any) => s + Number((isInfo ? l.qty : l.signed_qty) || 0), 0),
        amount: lines.reduce((s: number, l: any) => s + Number(l.amount || 0), 0),
        lineas: lines.length,
      };
      // Contraparte de traspaso (salida↔recepción por tipo41+serie+folio, distinta sucursal).
      // Los folios son secuencias POR SUCURSAL → puede haber varios candidatos; se elige el
      // MEJOR por cantidad más cercana y luego fecha más cercana (mismo ranking que transfersCheck).
      let counterpart: any = null;
      const sentQty = lines.reduce((s: number, l: any) => s + Number(l.qty || 0), 0);
      const thisWh = h.warehouse_id ?? p.warehouse_id;
      /** `[DM.20]` ambos sentidos del pareo, con el destino declarado como llave. */
      const wrap = (cp: any[], evidence: 'destino_declarado' | 'fecha_y_cantidad') => {
        if (!cp.length) return null;
        const cpQty = Number(cp[0].qty || 0);
        // [MX.1.1] cuadra sólo con las mismas piezas Y los mismos productos (firma SKU_SIG)
        const mismos = cp[0].sku_sig != null && String(cp[0].sku_sig) === String(thisSig);
        return {
          docs: cp, qty: cpQty, delta: cpQty - sentQty, match_evidence: evidence,
          status: Math.abs(cpQty - sentQty) < 0.01 && mismos ? 'ok' : 'diferencia',
        };
      };
      const CP_COLS = (t: any) => [
        'm.folio', 'm.warehouse_id', 'w.code as warehouse_code', 'w.name as warehouse_name',
        t.raw(`MIN(m.doc_date) AS doc_date`), t.raw(`MAX(m.doc_code) AS doc_code`),
        t.raw(`MAX(m.doc_serie) AS doc_serie`), t.raw(`SUM(m.qty) AS qty`), t.raw(`COUNT(*)::int AS lineas`),
        t.raw(`${SKU_SIG('m')} AS sku_sig`),
      ];
      /** Viendo una SALIDA: su recepción es la que ocurre en el almacén al que va dirigida. */
      const findRcvForShip = async (destWhId: string | null) => {
        if (!h.folio) return null;
        const q = trx('analytics.stock_movements as m')
          .where('m.tenant_id', tenantId).andWhere('m.doc_code', 'TrsfRcv').andWhere('m.parent_group', '41')
          .andWhere('m.parent_folio', h.folio)
          .andWhereRaw(`coalesce(m.parent_serie,'') = coalesce(?, '')`, [h.doc_serie])
          .whereNot('m.warehouse_id', thisWh);
        if (destWhId) {
          q.andWhere('m.warehouse_id', destWhId)
            .andWhereRaw(`m.doc_date BETWEEN ?::date - ${PAIR_EARLY_DAYS} AND ?::date + ${PAIR_LATE_DAYS}`, [h.doc_date, h.doc_date]);
        } else {
          q.andWhereRaw(`m.doc_date BETWEEN ?::date AND ?::date + ${PAIR_BLIND_DAYS}`, [h.doc_date, h.doc_date]);
        }
        const cp = await q
          .leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id')
          .groupBy('m.folio', 'm.warehouse_id', 'w.code', 'w.name')
          .select(CP_COLS(trx))
          .orderByRaw(`abs(SUM(m.qty) - ?) ASC, abs(MIN(m.doc_date) - ?::date) ASC`, [sentQty, h.doc_date])
          .limit(1);
        return wrap(cp, destWhId ? 'destino_declarado' : 'fecha_y_cantidad');
      };
      /** Viendo una RECEPCIÓN: su origen es la salida que venía dirigida a ESTE almacén. */
      const findShipForRcv = async () => {
        if (!h.parent_folio) return null;
        const cp = await trx('analytics.stock_movements as m')
          .where('m.tenant_id', tenantId).andWhere('m.doc_code', 'TrsfShip')
          .andWhere('m.folio', h.parent_folio)
          .andWhereRaw(`coalesce(m.doc_serie,'') = coalesce(?, '')`, [h.parent_serie])
          .whereNot('m.warehouse_id', thisWh)
          .leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id')
          .leftJoin('analytics.transfer_dest_map as dm', function (this: any) {
            this.on('dm.tenant_id', 'm.tenant_id').andOn('dm.dest_code', 'm.dest_code');
          })
          .leftJoin('commercial.warehouses as dw', function (this: any) {
            this.on('dw.id', 'dm.warehouse_id').andOnNull('dw.deleted_at');
          })
          .groupBy('m.folio', 'm.warehouse_id', 'w.code', 'w.name')
          // el embarque tiene que venir dirigido acá; sin destino resuelto, la ventana ciega de antes
          .havingRaw(
            `(MAX(dw.id::text) = ? AND MIN(m.doc_date) BETWEEN ?::date - ${PAIR_LATE_DAYS} AND ?::date + ${PAIR_EARLY_DAYS})
             OR (MAX(dw.id::text) IS NULL AND MIN(m.doc_date) BETWEEN ?::date - ${PAIR_BLIND_DAYS} AND ?::date)`,
            [thisWh, h.doc_date, h.doc_date, h.doc_date, h.doc_date])
          .select(CP_COLS(trx))
          .select(trx.raw(`MAX(dw.id::text) AS dest_wh_id`))
          .orderByRaw(`abs(SUM(m.qty) - ?) ASC, abs(MIN(m.doc_date) - ?::date) ASC`, [sentQty, h.doc_date])
          .limit(1);
        return wrap(cp, cp[0]?.dest_wh_id ? 'destino_declarado' : 'fecha_y_cantidad');
      };
      /**
       * `[DM.17.1]` — **de qué plaza SALIÓ de verdad la mercancía.**
       *
       * El almacén del documento de salida dice "CEDIS" porque ahí se CAPTURÓ, no porque de ahí
       * haya salido: antes del corte, Morelia Abastos y Canindo subían sus traspasos al Kepler
       * del CEDIS. Medido: **225 de 535 documentos resueltos no son del CEDIS** ($5,144,762).
       *
       * El árbitro es `analytics.v_transfer_true_origin` — el ticket Wincaja del documento
       * (`kdm1.c24`), desambiguado por SKU + cantidad porque la caja `99` del folio la comparten
       * cinco ramas. ⛔ **No se lee el almacén del documento de enfrente**: ése copia lo que
       * declaró el que embarcó, así que es un espejo y no puede arbitrar (ADR-059 R5).
       */
      const origenReal = async (warehouseId: string | null, folio: string | null, serie: string | null) => {
        if (!warehouseId || !folio) return null;
        const [r] = await trx('analytics.v_transfer_true_origin as o')
          .join('commercial.warehouses as w', (j: any) => {
            j.on('w.kepler_code', 'o.sucursal_kepler').andOnNull('w.deleted_at');
          })
          .where('w.id', warehouseId)
          .andWhere('o.folio', folio)
          .andWhereRaw(`coalesce(o.doc_serie::text,'') = coalesce(?, '')`, [serie])
          .leftJoin('analytics.v_branch_erp_cutover as c', 'c.wincaja_source_branch', 'o.origen_rama_wincaja')
          .leftJoin('commercial.warehouses as wo', (j: any) => {
            j.on('wo.kepler_code', 'c.kepler_code').andOnNull('wo.deleted_at');
          })
          .select('o.origen_veredicto', 'o.origen_rama_wincaja', 'o.ticket_ref', 'o.ticket_tecleado')
          .select('wo.id as origen_warehouse_id', 'wo.name as origen_warehouse_name')
          .limit(1);
        return r || null;
      };

      if (h.doc_code === 'TrsfShip') {
        counterpart = { kind: 'recepcion', ...(await findRcvForShip(destWarehouseId) || { docs: [], qty: 0, delta: -sentQty, status: 'sin_recepcion', match_evidence: null }) };
        // DM.11 — a quién va dirigido (crítico cuando status='sin_recepcion')
        counterpart.dest_label = destLabel;
        counterpart.dest_warehouse_id = destWarehouseId;
        counterpart.dest_warehouse_name = destWarehouseName;
        // El documento que se está viendo ES la salida: su propio origen es el que se arbitra.
        counterpart.origen_real = await origenReal(h.warehouse_id ?? p.warehouse_id, h.folio, h.doc_serie);
      } else if (h.doc_code === 'TrsfRcv' && h.parent_group === '41') {
        counterpart = { kind: 'origen', ...(await findShipForRcv() || { docs: [], qty: 0, delta: sentQty, status: 'sin_origen', match_evidence: null }) };
        // Acá la salida es la CONTRAPARTE, así que se arbitra ella y no el documento de enfrente.
        const cpDoc = counterpart.docs?.[0];
        if (cpDoc) counterpart.origen_real = await origenReal(cpDoc.warehouse_id, cpDoc.folio, cpDoc.doc_serie);
      }
      return { header, lines, totals, counterpart };
    });
  }

  /**
   * DM.3 — Validación de traspasos: parea cada salida (TrsfShip, UD41) con su recepción
   * (TrsfRcv, UA50) vía el back-pointer de Kepler (parent = tipo 41 + SERIE + folio; la
   * serie desambigua folios repetidos entre sucursales). Estados:
   *   ok            → recepción existe y las piezas cuadran
   *   diferencia    → recepción existe pero las piezas NO cuadran (merma/sobrante en tránsito)
   *   sin_recepcion → salió y nadie lo ha recibido (en tránsito o perdido)
   *   sin_origen    → recepción sin salida visible (origen fuera de ventana o no registrado)
   */
  /**
   * DM.12/DM.3 — PAREO FÍSICO base (una sola ejecución del CTE) → deriva EN JS tanto el `check`
   * folio a folio como la `matrix` origen→destino. Antes transfersCheck y transfersMatrix corrían
   * el MISMO pareo LATERAL dos veces por carga del Cuadre; esto lo computa una vez (dedup).
   * Folios Kepler son secuencias POR SUCURSAL → un (serie, folio) puede existir en varias
   * sucursales; el LATERAL elige la salida de cantidad+fecha más cercana. La matriz excluye
   * 'sin_origen' (recepción sin salida visible) para conservar su semántica original (origen→destino).
   */
  async transfersPhysical(q: MovementsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const { from, to } = this.range(q);
    return this.tk.run(async (trx) => {
      // ── check: folio a folio (honra whs/twhs), prioriza problemas, top 500 ──
      const { all, checkAll } = await this.pareoCompleto(trx, tenantId, q);
      const cTotals = { ok: 0, diferencia: 0, sin_recepcion: 0, sin_origen: 0 };
      for (const r of checkAll) cTotals[r.status as keyof typeof cTotals]++;
      // [MX.2.1] Las sumas del conjunto COMPLETO, para quien no debe sumar desde `rows` (cortadas
      // en 500, problemas primero): el Excel sacaba de ahí «Recibidos OK», «Δ neto» y «Valor
      // enviado», y con más de 500 problemas al mes (todos los meses desde ago-2026) «Recibidos
      // OK» salía en 0. `capped`: el pareo trae a lo más 50,000 filas; si llegó, nada está completo.
      // [MX.1.2] `docs_importe_incompleto`: documentos cuyo `amount` no incluye renglones con costo 0 en Kepler
      // [MX.1.7] `amount_por_destino`: el importe de una salida a sucursal es valor de traspaso, a cliente precio de
      // venta y a ruta una mezcla — `amount` las suma; aquí se separan para que nadie las lea como una sola unidad.
      const cSums = { n: checkAll.length, qty_sent: 0, qty_received: 0, delta: 0, amount: 0, docs_importe_incompleto: 0, lineas_sin_importe: 0,
        amount_por_destino: { sucursal: 0, ruta: 0, cliente: 0 } as Record<DestinoSalida, number> };
      for (const r of checkAll) {
        cSums.qty_sent += Number(r.qty_sent) || 0;
        cSums.qty_received += Number(r.qty_received) || 0;
        cSums.delta += Number(r.delta) || 0;
        cSums.amount += Number(r.amount) || 0;
        // una fila pareada va a la sucursal que la recibió; una sin recepción, a su destino declarado
        if (r.status !== 'sin_origen') cSums.amount_por_destino[r.status === 'sin_recepcion' ? claseDestino(r.dest_wh_id, r.dest_wh) : 'sucursal'] += Number(r.amount) || 0;
        const sinImp = Number(r.lineas_sin_importe) || 0;
        if (sinImp > 0) { cSums.docs_importe_incompleto++; cSums.lineas_sin_importe += sinImp; }
      }
      const capped = all.length >= 50000;
      const prio: Record<string, number> = { diferencia: 0, sin_recepcion: 1, sin_origen: 2, ok: 4 };
      const dms = (r: any) => new Date(r.ship_date || r.rcv_date || 0).getTime();
      const checkRows = [...checkAll]
        .sort((a, b) => (prio[a.status] - prio[b.status]) || (dms(b) - dms(a)))
        .slice(0, 500);

      // ── matrix: agrega por par origen→destino (excluye sin_origen), top 300 por monto ──
      const mmap = new Map<string, any>();
      for (const r of all) {
        if (r.status === 'sin_origen') continue;
        const key = `${r.origin_wh_id || ''}|${r.dest_wh_id || ''}`;
        let m = mmap.get(key);
        if (!m) { m = { origin_wh_id: r.origin_wh_id, origin_wh: r.origin_wh, dest_wh_id: r.dest_wh_id, dest_wh: r.dest_wh, qty_sent: 0, qty_received: 0, amount: 0, n_ok: 0, n_diferencia: 0, n_sin_recepcion: 0 }; mmap.set(key, m); }
        m.qty_sent += Number(r.qty_sent) || 0; m.qty_received += Number(r.qty_received) || 0; m.amount += Number(r.amount) || 0;
        if (r.status === 'ok') m.n_ok++; else if (r.status === 'diferencia') m.n_diferencia++; else if (r.status === 'sin_recepcion') m.n_sin_recepcion++;
      }
      const mRows = Array.from(mmap.values())
        .map((m) => ({ ...m, delta_qty: m.qty_received - m.qty_sent }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 300);
      const mTotals = { qty_sent: 0, qty_received: 0, amount: 0, n_ok: 0, n_diferencia: 0, n_sin_recepcion: 0 };
      for (const m of mRows) { mTotals.qty_sent += m.qty_sent; mTotals.qty_received += m.qty_received; mTotals.amount += m.amount; mTotals.n_ok += m.n_ok; mTotals.n_diferencia += m.n_diferencia; mTotals.n_sin_recepcion += m.n_sin_recepcion; }

      /**
       * `[DM.21]` — resumen de HALLAZGOS para el panel del Cuadre.
       *
       * ⚠️ Se calcula sobre `checkAll`, **no sobre `checkRows`**: ésas están cortadas en 500 y
       * ordenadas problemas primero. Medido en septiembre: 1,466 problemas contra 500 filas
       * servidas — un panel que sumara desde las filas publicaría un tercio del dinero y se
       * vería igual de convincente. Por eso el importe viaja desde acá y `truncado` dice si la
       * LISTA del detalle está recortada (el conteo nunca lo está).
       *
       * ⛔ `sin_recepcion` MEZCLA TRES COSAS y sólo una es un hueco. Se separan acá, y los tres
       * baldes suman `cTotals.sin_recepcion` para que no parezca que algo se esconde:
       *   · **a un almacén** (`dest_wh_id` resuelto y no es ruta) → el hallazgo real;
       *   · **carga a ruta** → una camioneta no emite recepción: "sin acuse" es su estado normal;
       *   · **entrega a cliente** → tampoco emite acuse, y es la mayoría.
       *
       * ⚠️ El balde del cliente se descubrió simulando la salida del panel antes de publicarla:
       * contándolo junto con el resto, el hallazgo decía **$14.67M en 30 días** cuando el hueco de
       * verdad es una fracción. La trampa está en que `dest_wh` **no sirve para distinguirlos**:
       * la rama `unreceived` hace `coalesce(dw.name, dw.code, u.dest_label, u.dest_code)`, así que
       * para un cliente trae su NOMBRE y se ve igual de lleno que el de una sucursal. Lo que
       * separa es **`dest_wh_id`**, que sólo existe si el destino mapea a un almacén vivo.
       */
      const DIA = 864e5;
      const ahora = Date.now();
      const diasDe = (d: any) => (d ? Math.floor((ahora - new Date(d).getTime()) / DIA) : 0);
      const hallazgos = {
        truncado: (cTotals.diferencia + cTotals.sin_recepcion + cTotals.sin_origen) > checkRows.length,
        // [MX.1.3] `umbral_dias` viaja con el dato: la pantalla no repite el número a mano
        sin_acuse: { docs: 0, amount: 0, dias_max: 0, viejo_docs: 0, viejo_amount: 0, umbral_dias: SIN_ACUSE_DIAS, docs_importe_incompleto: 0 },
        // [MX.1.7] cada balde dice en qué unidad viene su `amount`
        sin_acuse_ruta: { docs: 0, amount: 0, docs_importe_incompleto: 0, unidad: UNIDAD_IMPORTE_SALIDA.ruta },
        sin_acuse_cliente: { docs: 0, amount: 0, docs_importe_incompleto: 0, unidad: UNIDAD_IMPORTE_SALIDA.cliente },
        sin_origen: { docs: cTotals.sin_origen },
        diferencia: { docs: cTotals.diferencia, piezas: 0 },
      };
      for (const r of checkAll) {
        const monto = Number(r.amount) || 0;
        const incompleto = (Number(r.lineas_sin_importe) || 0) > 0 ? 1 : 0;
        if (r.status === 'sin_recepcion') {
          if (!r.dest_wh_id) { hallazgos.sin_acuse_cliente.docs++; hallazgos.sin_acuse_cliente.amount += monto; hallazgos.sin_acuse_cliente.docs_importe_incompleto += incompleto; continue; }
          if (esRuta(r.dest_wh)) { hallazgos.sin_acuse_ruta.docs++; hallazgos.sin_acuse_ruta.amount += monto; hallazgos.sin_acuse_ruta.docs_importe_incompleto += incompleto; continue; }
          hallazgos.sin_acuse.docs++; hallazgos.sin_acuse.amount += monto; hallazgos.sin_acuse.docs_importe_incompleto += incompleto;
          const d = diasDe(r.ship_date);
          if (d > hallazgos.sin_acuse.dias_max) hallazgos.sin_acuse.dias_max = d;
          // [MX.1.3] SIN_ACUSE_DIAS (15), medido; antes 45 escondía 30 días de alarmas reales.
          if (d > SIN_ACUSE_DIAS) { hallazgos.sin_acuse.viejo_docs++; hallazgos.sin_acuse.viejo_amount += monto; }
        } else if (r.status === 'diferencia') {
          hallazgos.diferencia.piezas += Math.abs(Number(r.delta) || 0);
        }
      }

      return {
        range: { from, to },
        check: { range: { from, to }, totals: cTotals, sums: cSums, capped, hallazgos, rows: checkRows },
        matrix: { range: { from, to }, totals: mTotals, rows: mRows },
      };
    });
  }

  /**
   * [MX.2.3] El pareo COMPLETO (sin el corte de 500 filas), honrando almacén y origen/destino. Lo usan el
   * Cuadre (`transfersPhysical`) y la bandeja de excepciones (`exceptions`): un solo pareo, dos lecturas.
   */
  private async pareoCompleto(trx: Knex.Transaction, tenantId: string, q: MovementsQuery): Promise<{ all: FilaPareo[]; checkAll: FilaPareo[] }> {
    const { from, to } = this.range(q);
    const whs = this.whIds(q);
    const twhs = this.transferWhIds(q);
    const destSql = this.destBucketSql(this.destKinds(q), tenantId);
    const shpDestSql = destSql ? ` AND ${destSql}` : '';
    const all: FilaPareo[] = (await trx.raw(
      `${TRANSFER_PAIRING_SQL(shpDestSql)}
      LIMIT 50000`,
      TRANSFER_PAIRING_PARAMS(tenantId, from, to),
    )).rows;
    const inSet = (r: FilaPareo, set: string[]) => set.includes(r.origin_wh_id ?? '') || set.includes(r.dest_wh_id ?? '');
    let checkAll = all;
    if (whs.length) checkAll = checkAll.filter((r) => inSet(r, whs));
    if (twhs.length) checkAll = checkAll.filter((r) => inSet(r, twhs));
    return { all, checkAll };
  }

  /**
   * [MX.2.3] **BANDEJA DE EXCEPCIONES**: sólo lo que el motor no puede dar por bueno, clasificado con el
   * catálogo de `@megadulces/contracts` (`clasificarMovimiento`, MX.1.4). Hoy se audita a mano el Diario
   * entero: el 90.7 % de las marcas cayó en documentos que el motor ya cuadraba (MX.0.1).
   *
   * Traspasos: del pareo COMPLETO (no de las 500 filas del Cuadre). Por defecto mira todos los destinos —
   * a ruta y a cliente no hay acuse, así que sólo entran si traen una diferencia o el importe incompleto.
   * Ajustes de inventario: siempre (decisión D3). Totales sobre el conjunto completo; el importe, POR UNIDAD.
   * Orden: por importe (lo que más dinero mueve primero) y luego por antigüedad.
   */
  async exceptions(q: MovementsQuery): Promise<MovimientosExcepcionesResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const { from, to } = this.range(q);
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
    const qq: MovementsQuery = { ...q, dest_kinds: q.dest_kinds || 'sucursal,ruta,cliente' };
    const ahora = Date.now();
    const dias = (d: unknown) => (d ? Math.max(0, Math.floor((ahora - new Date(String(d)).getTime()) / 864e5)) : 0);
    const iso = (d: unknown) => (d ? new Date(String(d)).toISOString().slice(0, 10) : '');
    return this.tk.run(async (trx) => {
      const { all, checkAll } = await this.pareoCompleto(trx, tenantId, qq);
      const items: ExcepcionMovimientoItem[] = [];
      for (const r of checkAll) {
        const estado = r.status === 'ok' ? 'completado' as const
          : r.status === 'sin_recepcion' ? estadoSinRecepcion(r.dest_wh_id, r.dest_wh, r.ship_date)
          : r.status as 'diferencia' | 'sin_origen';
        const k = clasificarMovimiento({ doc_code: r.origin_folio ? 'TrsfShip' : 'TrsfRcv', transfer_status: estado, lineas_sin_importe: r.lineas_sin_importe });
        if (!k.a_bandeja) continue;
        const destino: DestinoSalida = r.status === 'sin_recepcion' ? claseDestino(r.dest_wh_id, r.dest_wh) : 'sucursal';
        items.push({
          tipo: 'traspaso', excepciones: k.excepciones, fecha: iso(r.ship_date || r.rcv_date),
          origen: { warehouse_id: r.origin_wh_id ?? null, nombre: r.origin_wh ?? null, folio: r.origin_folio ?? null, doc_code: r.origin_folio ? 'TrsfShip' : 'TrsfRcv' },
          destino: { warehouse_id: r.dest_wh_id ?? null, nombre: r.dest_wh ?? null, folio: r.rcv_folio ?? null },
          piezas_enviadas: r.qty_sent != null ? Number(r.qty_sent) : null,
          piezas_recibidas: r.qty_received != null ? Number(r.qty_received) : null,
          delta_piezas: r.delta != null ? Number(r.delta) : null,
          importe: r.amount != null ? Number(r.amount) : null,
          // una recepción sin origen no tiene embarque: el importe no está medido
          unidad_importe: r.status === 'sin_origen' ? null : UNIDAD_IMPORTE_SALIDA[destino],
          lineas_sin_importe: Number(r.lineas_sin_importe) || 0,
          dias: dias(r.ship_date || r.rcv_date),
        });
      }
      // Ajustes de inventario del rango (decisión D3: siempre a la bandeja).
      const whs = this.whIds(qq);
      const ajQ = trx('analytics.stock_movements as m')
        .leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id')
        .where('m.tenant_id', tenantId).whereIn('m.doc_code', DOC_CODES_AJUSTE as string[])
        .andWhere('m.doc_date', '>=', from).andWhere('m.doc_date', '<=', to);
      if (whs.length) ajQ.whereIn('m.warehouse_id', whs);
      const ajustes = await ajQ.groupBy(...DOC_IDENTITY, 'w.name', 'w.code')
        .select('m.warehouse_id', 'm.doc_code', 'm.folio', trx.raw('coalesce(w.name, w.code) AS nombre'),
          trx.raw('MIN(m.doc_date) AS fecha'), trx.raw('SUM(m.signed_qty) AS piezas'), trx.raw('SUM(m.amount) AS importe'),
          trx.raw('COUNT(*) FILTER (WHERE m.amount IS NULL)::int AS lineas_sin_importe'));
      for (const a of ajustes as { warehouse_id: string; doc_code: string; folio: string; nombre: string | null; fecha: unknown; piezas: unknown; importe: unknown; lineas_sin_importe: number }[]) {
        const k = clasificarMovimiento({ doc_code: a.doc_code, lineas_sin_importe: a.lineas_sin_importe });
        if (!k.a_bandeja) continue;
        items.push({
          tipo: 'ajuste', excepciones: k.excepciones, fecha: iso(a.fecha),
          origen: { warehouse_id: a.warehouse_id, nombre: a.nombre, folio: a.folio, doc_code: a.doc_code },
          destino: null, piezas_enviadas: null, piezas_recibidas: null,
          delta_piezas: a.piezas != null ? Number(a.piezas) : null,
          importe: a.importe != null ? Number(a.importe) : null,
          unidad_importe: null, // la unidad del importe de un ajuste no se ha medido (MX.1.7 midió salidas)
          lineas_sin_importe: Number(a.lineas_sin_importe) || 0,
          dias: dias(a.fecha),
        });
      }

      const porExc: MovimientosExcepcionesResponse['totals']['por_excepcion'] = {};
      const porUnidad: Record<UnidadImporte | 'sin_unidad', number> = { valor_traspaso: 0, precio_venta: 0, mixta: 0, sin_unidad: 0 };
      for (const it of items) {
        const imp = Math.abs(it.importe ?? 0);
        for (const e of it.excepciones) { const t = (porExc[e] ??= { n: 0, importe: 0 }); t.n++; t.importe += imp; }
        porUnidad[it.unidad_importe ?? 'sin_unidad'] += imp;
      }
      items.sort((a, b) => Math.abs(b.importe ?? 0) - Math.abs(a.importe ?? 0) || b.dias - a.dias);
      return {
        range: { from, to },
        totals: { items: items.length, por_excepcion: porExc, importe_por_unidad: porUnidad, universo: { traspasos: checkAll.length, ajustes: ajustes.length } },
        capped: all.length >= 50000,
        page, pageSize, total: items.length,
        rows: items.slice((page - 1) * pageSize, page * pageSize),
      };
    });
  }

  /** DM.3 — folio a folio (delegado a transfersPhysical; una sola ejecución del pareo). */
  async transfersCheck(q: MovementsQuery) {
    return (await this.transfersPhysical(q)).check;
  }

  /**
   * DM.12b — DRILL de la matriz: mismos folios que transfersCheck pero SCOPEADOS a UN par
   * origen→destino (sin el LIMIT 500 global que prioriza problemas → aquí el par sale completo).
   * Alimenta la ventana de comparación de "Flujo físico origen → destino". origin/dest null =
   * '(sin destino)' / 'sin origen' (rows con ese lado nulo).
   */
  async transfersCheckPair(q: MovementsQuery, originWhId?: string | null, destWhId?: string | null) {
    const tenantId = this.tenantCtx.requireTenantId();
    const { from, to } = this.range(q);
    const destSql = this.destBucketSql(this.destKinds(q), tenantId);
    const shpDestSql = destSql ? ` AND ${destSql}` : '';
    const origin = originWhId || null;
    const dest = destWhId || null;
    const originMatch = origin ? 't.origin_wh_id = ?' : 't.origin_wh_id IS NULL';
    const destMatch = dest ? 't.dest_wh_id = ?' : 't.dest_wh_id IS NULL';
    const pairParams = [...(origin ? [origin] : []), ...(dest ? [dest] : [])];
    return this.tk.run(async (trx) => {
      const rows = (await trx.raw(
        `${TRANSFER_PAIRING_SQL(shpDestSql)}
        WHERE ${originMatch} AND ${destMatch}
        ORDER BY CASE t.status WHEN 'diferencia' THEN 0 WHEN 'sin_recepcion' THEN 1 WHEN 'sin_origen' THEN 2 ELSE 4 END,
                 coalesce(t.ship_date, t.rcv_date) DESC
        LIMIT 2000`,
        [...TRANSFER_PAIRING_PARAMS(tenantId, from, to), ...pairParams],
      )).rows;
      const totals = { ok: 0, diferencia: 0, sin_recepcion: 0, sin_origen: 0 };
      for (const r of rows) totals[r.status as keyof typeof totals]++;
      const origin_wh = rows.find((r: any) => r.origin_wh)?.origin_wh || null;
      const dest_wh = rows.find((r: any) => r.dest_wh)?.dest_wh || null;
      return { range: { from, to }, origin_wh_id: origin, dest_wh_id: dest, origin_wh, dest_wh, totals, rows };
    });
  }

  /**
   * DM.12 — Conciliación CONTABLE de traspasos (mayor 515 "AJUSTE TRASPASO INTERNOS").
   *
   * Contracara monetaria del transfersCheck físico: lee la balanza analytics.ledger_monthly.
   *   515-001 = TRASPASO ENTRADA (una sucursal recibe → neto +)
   *   515-002 = TRASPASO SALIDA  (una sucursal envía  → neto −)
   * Es cuenta PUENTE: cada salida debe tener su entrada ⇒ el mayor debe netear ≈ $0 por mes.
   * Δ = entrada_neto + salida_neto (≠0 ⇒ traspasos sin cuadrar / en tránsito al corte).
   *
   * Vista de RED (por mes y por sucursal): ledger_monthly se llavea por `sucursal`+`anio_mes`,
   * no por warehouse_id → honra el rango de fechas pero ignora el filtro de almacén (UUID).
   */
  async transfersLedger(q: MovementsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const { from, to } = this.range(q);
    const fromYm = from.slice(0, 7);
    const toYm = to.slice(0, 7);
    // FILTER por prefijo de subcuenta; excluye la fila del mayor exacto ('515') → sin doble conteo.
    const ent = `SUM(neto) FILTER (WHERE cuenta LIKE '515-001%')`;
    const sal = `SUM(neto) FILTER (WHERE cuenta LIKE '515-002%')`;
    const entM = `SUM(movs) FILTER (WHERE cuenta LIKE '515-001%')`;
    const salM = `SUM(movs) FILTER (WHERE cuenta LIKE '515-002%')`;
    return this.tk.run(async (trx) => {
      const baseWhere = (b: any) => b
        .where('tenant_id', tenantId)
        .whereRaw(`cuenta LIKE '515-%'`)
        .andWhere('anio_mes', '>=', fromYm)
        .andWhere('anio_mes', '<=', toYm);

      const months = await baseWhere(trx('analytics.ledger_monthly'))
        .groupBy('anio_mes')
        .orderBy('anio_mes')
        .select('anio_mes')
        .select(
          trx.raw(`${ent} AS entrada`), trx.raw(`${sal} AS salida`),
          trx.raw(`${entM} AS movs_entrada`), trx.raw(`${salM} AS movs_salida`),
        );

      const bySucursal = await baseWhere(trx('analytics.ledger_monthly'))
        .groupBy('sucursal')
        .orderByRaw(`abs(coalesce(${ent},0) + coalesce(${sal},0)) DESC`)
        .select('sucursal')
        .select(trx.raw(`${ent} AS entrada`), trx.raw(`${sal} AS salida`));

      const rows = months.map((m: any) => ({
        anio_mes: m.anio_mes,
        entrada: Number(m.entrada) || 0,
        salida: Number(m.salida) || 0,
        delta: (Number(m.entrada) || 0) + (Number(m.salida) || 0),
        movs_entrada: Number(m.movs_entrada) || 0,
        movs_salida: Number(m.movs_salida) || 0,
      }));
      const sucursales = bySucursal.map((s: any) => ({
        sucursal: s.sucursal,
        entrada: Number(s.entrada) || 0,
        salida: Number(s.salida) || 0,
        delta: (Number(s.entrada) || 0) + (Number(s.salida) || 0),
      }));
      const totals = {
        entrada: rows.reduce((a: number, r: any) => a + r.entrada, 0),
        salida: rows.reduce((a: number, r: any) => a + r.salida, 0),
        delta: rows.reduce((a: number, r: any) => a + r.delta, 0),
      };
      return { range: { from: fromYm, to: toYm }, totals, rows, by_sucursal: sucursales };
    });
  }

  /**
   * DM.12 — MATRIZ origen → destino (FÍSICA, sobre analytics.stock_movements). Mismo pareo
   * LATERAL que transfersCheck (salida TrsfShip ⇄ recepción TrsfRcv por serie+folio), pero
   * AGREGADO por par (origen, destino): cuánto se envió vs cuánto se recibió + Δ + conteo por
   * estado. Complementa el cuadre CONTABLE (transfersLedger, mayor 515) poniéndole cara a las
   * sucursales entre las que no cuadra. Honra rango de fechas + destino; ignora filtro de almacén.
   */
  async transfersMatrix(q: MovementsQuery) {
    return (await this.transfersPhysical(q)).matrix;
  }

  /**
   * [MX.1.6] DETALLE por póliza del mayor 515, emparejado por la **CADENA DE DOCUMENTOS**, no por importe.
   *
   * ⛔ Antes (DM.12): un regex sobre la `referencia` libre adivinaba la sucursal y DESCARTABA lo que no
   * reconocía ($35.9 M de entradas desde jul-2026), y las pólizas se pareaban por importe ±2 % sin mirar
   * sucursal — un pareo que no superaba su placebo (96.1 % con las salidas de 6 meses después contra
   * 98.7 % real). Sus baldes «exacto/costo» no significaban nada.
   *
   * La póliza automática trae el documento que la generó: `(warehouse_id, tipo_pol, folio)`. `UA5001` =
   * recepción de traspaso; `UD4102` = embarque. Cadena (MX.0.3): entrada 515-001 `UA5001` (R, folio) →
   * `TrsfRcv` (R, folio) → `parent_folio`/serie → `TrsfShip` (S ≠ R) → póliza `UD4102` de S. Medido
   * jul–sep 2026: 987 de 992 entradas con cadena; placebo (`parent_folio + 1`) = 3.
   *
   * ⚠️ Cada `UD4102` es **116 (inventario) + exactamente UNA contrapartida**: 515-002, 401-003 u otra 401.
   * La contrapartida es la línea que NO es 116 — tomar también la 116 desempata al azar dentro del mismo
   * asiento (así salió el falso «287 en 116» de la primera medición). Si la contrapartida es 401, la salida
   * se contabilizó como VENTA (`AUD-DAT.23`): el puente 515 no puede netear $0.
   *
   * Baldes (sólo pólizas del rango; los meses de margen sólo aportan contrapartes):
   *   exacto        → cadena completa, contrapartida 515-002, |Δ| < $1.
   *   costo         → cadena completa, contrapartida 515-002, |Δ| ≥ $1 (misma transferencia, otra valuación).
   *   como_venta    → cadena completa, pero la salida se contabilizó en 401 (venta).
   *   a_wincaja     → salida a Morelia Abastos/Canindo/Madero ANTES del corte de 2026-10: eran tiendas Wincaja
   *                   sin recepción en Kepler; se cuadran en el lente Kepler → Wincaja (DM.13).
   *   sin_documento → póliza manual (sin `UA5001`/`UD4102`): no hay documento contra qué cuadrarla (`AUD-DAT.24`).
   *   sin_rastro    → tiene documento y no se encontró la cadena: LO ACCIONABLE.
   *
   * Los joins se hacen aquí, con mapas: en SQL, las estimaciones de los CTEs (1 fila donde hay cientos)
   * llevaban al planner a repetir el embarque × póliza por cada recepción (24 s en un trimestre).
   */
  async transfersLedgerDetail(q: MovementsQuery, f: LedgerDetailFilters = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    const { from, to } = this.range(q);
    const fromYm = from.slice(0, 7), toYm = to.slice(0, 7);
    const CAP = 1000;
    const addMonth = (ym: string, d: number) => {
      const [y, m] = ym.split('-').map(Number);
      const dt = new Date(y, m - 1 + d, 1);
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    };
    const mesIni = (ym: string) => `${ym}-01`;
    const mesFin = (ym: string) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
    const inRange = (ym: string) => ym >= fromYm && ym <= toYm;
    // Margen: la salida puede contabilizarse hasta 3 meses antes de su entrada; una entrada del mes
    // siguiente puede ser la pareja de una salida del rango.
    const polFrom = addMonth(fromYm, -3), polTo = addMonth(toYm, 1);
    // filtros de la vista (no afectan el pareo; solo qué se DEVUELVE)
    const fBucket = LEDGER_BUCKETS.includes(f.bucket || '') ? f.bucket : null;
    const fKind = f.kind === 'entrada' || f.kind === 'salida' ? f.kind : null;
    const fSuc = (f.sucursal || '').trim() || null;
    const fDestinos = Array.isArray(f.destinos) ? f.destinos.filter(Boolean) : [];
    const fDestSet = fDestinos.length ? new Set(fDestinos) : null;
    const fSearch = (f.search || '').trim().toLowerCase() || null;
    const fMin = Number(f.min_amount) > 0 ? Number(f.min_amount) : 0;

    type Pol = { anio_mes: string; sucursal: string; warehouse_id: string | null; cuenta: string; importe: number; referencia: string | null; tipo_pol: string | null; folio: string | null };
    type SDoc = { w: string; f: string; cls: '515-002' | '401-003' | '401-otra'; imp: number; sucursal: string; ref: string | null };
    type Pair = { s: SDoc; d: number };

    return this.tk.run(async (trx) => {
      const whName = new Map<string, string>(
        (await trx('commercial.warehouses').where('tenant_id', tenantId).select('id', 'code', 'name'))
          .map((w: { id: string; code: string | null; name: string | null }) => [w.id, w.name || w.code || '']),
      );
      const pol: Pol[] = (await trx('analytics.gl_poliza_lines')
        .where('tenant_id', tenantId).andWhere('source', 'kepler')
        .andWhere('anio_mes', '>=', polFrom).andWhere('anio_mes', '<=', polTo)
        .andWhereRaw('coalesce(importe, 0) <> 0')
        .andWhereRaw(`(cuenta LIKE '515-%' OR (tipo_pol = 'UD4102' AND cuenta LIKE '401-%'))`)
        .select('anio_mes', 'sucursal', 'warehouse_id', 'cuenta', 'importe', 'referencia', 'tipo_pol', 'folio'))
        .map((r: Pol) => ({ ...r, importe: Number(r.importe) || 0 }));

      const key = (w: string | null, fo: string | null) => `${w}|${fo}`;
      const esEnt = (p: Pol) => p.cuenta.startsWith('515-001');
      const esSal = (p: Pol) => p.cuenta.startsWith('515-002');
      // Documentos de entrada (UA5001) del rango + 1 mes, y contrapartidas de embarque (UD4102, sin la 116).
      const eDocs = new Map<string, { w: string; f: string; imp: number }>();
      const sDocs = new Map<string, SDoc[]>();
      for (const p of pol) {
        if (!p.warehouse_id || !p.folio) continue;
        if (esEnt(p) && p.tipo_pol === 'UA5001' && p.anio_mes >= fromYm) {
          const k = key(p.warehouse_id, p.folio);
          const d = eDocs.get(k) ?? { w: p.warehouse_id, f: p.folio, imp: 0 };
          d.imp += p.importe; eDocs.set(k, d);
        } else if (p.tipo_pol === 'UD4102' && (esSal(p) || p.cuenta.startsWith('401-'))) {
          const cls: SDoc['cls'] = esSal(p) ? '515-002' : p.cuenta.startsWith('401-003') ? '401-003' : '401-otra';
          const k = key(p.warehouse_id, p.folio);
          const lst = sDocs.get(k) ?? [];
          const d = lst.find((x) => x.cls === cls);
          if (d) d.imp += p.importe; else lst.push({ w: p.warehouse_id, f: p.folio, cls, imp: p.importe, sucursal: p.sucursal, ref: p.referencia });
          sDocs.set(k, lst);
        }
      }

      // Recepciones de esas entradas → su folio y serie padre.
      const eFolios = Array.from(new Set(Array.from(eDocs.values()).map((d) => d.f)));
      const rcv = new Map<string, { pf: string; ps: string }>();
      if (eFolios.length) {
        const rows = await trx('analytics.stock_movements')
          .where('tenant_id', tenantId).andWhere('doc_code', 'TrsfRcv').whereIn('folio', eFolios)
          .andWhere('doc_date', '>=', mesIni(addMonth(fromYm, -1))).andWhere('doc_date', '<=', mesFin(polTo))
          .groupBy('warehouse_id', 'folio')
          .select('warehouse_id', 'folio', trx.raw('max(parent_folio) AS pf'), trx.raw(`max(coalesce(parent_serie, '')) AS ps`));
        for (const r of rows as { warehouse_id: string; folio: string; pf: string | null; ps: string }[]) {
          if (r.pf && eDocs.has(key(r.warehouse_id, r.folio))) rcv.set(key(r.warehouse_id, r.folio), { pf: r.pf, ps: r.ps });
        }
      }
      // Embarques candidatos (folios padre) y los de las salidas del rango (para su destino).
      const salFolios = pol.filter((p) => esSal(p) && p.tipo_pol === 'UD4102' && inRange(p.anio_mes) && p.folio).map((p) => p.folio as string);
      const shFolios = Array.from(new Set([...Array.from(rcv.values()).map((r) => r.pf), ...salFolios]));
      const shipsByFolio = new Map<string, { w: string; s: string; dest: string | null }[]>();
      const shipDest = new Map<string, string | null>();
      if (shFolios.length) {
        const rows = await trx('analytics.stock_movements')
          .where('tenant_id', tenantId).andWhere('doc_code', 'TrsfShip').whereIn('folio', shFolios)
          .andWhere('doc_date', '>=', mesIni(addMonth(fromYm, -4))).andWhere('doc_date', '<=', mesFin(polTo))
          .groupBy('warehouse_id', 'folio', trx.raw(`coalesce(doc_serie, '')`))
          .select('warehouse_id', 'folio', trx.raw(`coalesce(doc_serie, '') AS s`), trx.raw('max(dest_code) AS dest'));
        for (const r of rows as { warehouse_id: string; folio: string; s: string; dest: string | null }[]) {
          const lst = shipsByFolio.get(r.folio) ?? [];
          lst.push({ w: r.warehouse_id, s: r.s, dest: r.dest });
          shipsByFolio.set(r.folio, lst);
          shipDest.set(key(r.warehouse_id, r.folio), r.dest);
        }
      }
      const destName = new Map<string, string>(
        (await trx('analytics.transfer_dest_map as dm').leftJoin('commercial.warehouses as w', 'w.id', 'dm.warehouse_id')
          .where('dm.tenant_id', tenantId).select('dm.dest_code', trx.raw('coalesce(w.name, dm.dest_label) AS nombre')))
          .map((r: { dest_code: string; nombre: string }) => [r.dest_code, r.nombre]),
      );

      // La cadena: por cada entrada, la contrapartida de embarque de importe más cercano (desempate fijo).
      const ORDEN_CLS: Record<SDoc['cls'], number> = { '515-002': 0, '401-003': 1, '401-otra': 2 };
      const parDeEntrada = new Map<string, Pair>();
      const entradaDeSalida = new Map<string, { e: { w: string; f: string; imp: number }; d: number }>();
      for (const [k, e] of eDocs) {
        const r = rcv.get(k); if (!r) continue;
        const cands: Pair[] = [];
        for (const sh of shipsByFolio.get(r.pf) ?? []) {
          if (sh.s !== r.ps || sh.w === e.w) continue;
          for (const s of sDocs.get(key(sh.w, r.pf)) ?? []) cands.push({ s, d: Math.abs(s.imp - e.imp) });
        }
        cands.sort((a, b) => a.d - b.d || a.s.w.localeCompare(b.s.w) || ORDEN_CLS[a.s.cls] - ORDEN_CLS[b.s.cls]);
        if (!cands.length) continue;
        parDeEntrada.set(k, cands[0]);
        if (cands[0].s.cls === '515-002') entradaDeSalida.set(key(cands[0].s.w, cands[0].s.f), { e, d: cands[0].d });
      }

      // Clasificación de cada renglón 515 del rango.
      type Entry = {
        anio_mes: string; kind: 'entrada' | 'salida'; cuenta: string; sucursal: string; importe: number; destino: string | null;
        referencia: string | null; tipo_pol: string | null; folio: string | null; bucket: LedgerBucket; delta: number | null;
        cp_ref: string | null; cp_importe: number | null; cp_sucursal: string | null; cp_destino: string | null; cp_cuenta: string | null;
      };
      const entradaPol = new Map<string, Pol>();
      for (const p of pol) if (esEnt(p) && p.tipo_pol === 'UA5001') entradaPol.set(key(p.warehouse_id, p.folio), p);
      const entries: Entry[] = [];
      for (const p of pol) {
        if (!inRange(p.anio_mes) || !(esEnt(p) || esSal(p))) continue;
        const kind: Entry['kind'] = esEnt(p) ? 'entrada' : 'salida';
        const base = { anio_mes: p.anio_mes, kind, cuenta: p.cuenta, sucursal: p.sucursal, importe: p.importe, referencia: p.referencia || null, tipo_pol: p.tipo_pol || null, folio: p.folio || null };
        const nada = { delta: null, cp_ref: null, cp_importe: null, cp_sucursal: null, cp_destino: null, cp_cuenta: null };
        const k = key(p.warehouse_id, p.folio);
        if (kind === 'entrada' && p.tipo_pol === 'UA5001') {
          const par = parDeEntrada.get(k);
          if (!par) { entries.push({ ...base, destino: null, bucket: 'sin_rastro', ...nada }); continue; }
          const bucket: LedgerBucket = par.s.cls !== '515-002' ? 'como_venta' : par.d < 1 ? 'exacto' : 'costo';
          entries.push({ ...base, destino: whName.get(par.s.w) || null, bucket, delta: (eDocs.get(k)?.imp ?? 0) - par.s.imp,
            cp_ref: par.s.ref, cp_importe: par.s.imp, cp_sucursal: par.s.sucursal, cp_destino: p.warehouse_id ? whName.get(p.warehouse_id) || null : null, cp_cuenta: par.s.cls });
        } else if (kind === 'salida' && p.tipo_pol === 'UD4102') {
          const dest = shipDest.get(k) ?? null;
          const destino = dest ? destName.get(dest) || dest : null;
          const m = entradaDeSalida.get(k);
          if (m) {
            const ep = entradaPol.get(key(m.e.w, m.e.f));
            entries.push({ ...base, destino, bucket: m.d < 1 ? 'exacto' : 'costo', delta: m.e.imp - (sDocs.get(k)?.find((x) => x.cls === '515-002')?.imp ?? 0),
              cp_ref: ep?.referencia || null, cp_importe: m.e.imp, cp_sucursal: ep?.sucursal || null, cp_destino: whName.get(m.e.w) || null, cp_cuenta: '515-001' });
          } else {
            const bucket: LedgerBucket = dest && DEST_WINCAJA_PRE_CORTE.includes(dest) && p.anio_mes < CORTE_WINCAJA ? 'a_wincaja' : 'sin_rastro';
            entries.push({ ...base, destino, bucket, ...nada });
          }
        } else {
          entries.push({ ...base, destino: null, bucket: 'sin_documento', ...nada });
        }
      }

      const sum = (xs: Entry[]) => xs.reduce((a, e) => a + e.importe, 0);
      const ent = entries.filter((e) => e.kind === 'entrada'), sal = entries.filter((e) => e.kind === 'salida');
      const de = (b: LedgerBucket, xs: Entry[]) => xs.filter((e) => e.bucket === b);
      const costPairs = de('costo', ent).map((e) => ({
        anio_mes: e.anio_mes, sucursal_entrada: e.sucursal, sucursal_salida: e.cp_sucursal, entrada_importe: e.importe,
        salida_importe: e.cp_importe, delta: e.delta ?? 0, entrada_ref: e.referencia, salida_ref: e.cp_ref,
      })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      const srAll = de('sin_rastro', entries);

      const filtered = entries.filter((e) =>
        (!fBucket || e.bucket === fBucket) &&
        (!fKind || e.kind === fKind) &&
        (!fSuc || String(e.sucursal) === fSuc) &&
        (!fDestSet || fDestSet.has(e.destino || '')) &&
        (fMin <= 0 || e.importe >= fMin) &&
        (!fSearch || `${e.referencia || ''} ${e.tipo_pol || ''} ${e.folio || ''} ${e.cp_ref || ''}`.toLowerCase().includes(fSearch)),
      ).sort((a, b) => b.importe - a.importe);
      const destinos = Array.from(new Set(entries.map((e) => e.destino).filter(Boolean) as string[])).sort();

      return {
        range: { from: fromYm, to: toYm }, metodo: 'cadena_documental' as const, destinos,
        totals: {
          entrada: sum(ent), salida: sum(sal), delta: sum(ent) - sum(sal),
          n_exact: de('exacto', entries).length,
          cost: { n: costPairs.length, diff_total: costPairs.reduce((a, p) => a + Math.abs(p.delta), 0) },
          sin_rastro: {
            n_entrada: de('sin_rastro', ent).length, amt_entrada: sum(de('sin_rastro', ent)),
            n_salida: de('sin_rastro', sal).length, amt_salida: sum(de('sin_rastro', sal)),
          },
          como_venta: { n: de('como_venta', ent).length, amt: sum(de('como_venta', ent)) },
          a_wincaja: { n: de('a_wincaja', sal).length, amt: sum(de('a_wincaja', sal)) },
          sin_documento: {
            n_entrada: de('sin_documento', ent).length, amt_entrada: sum(de('sin_documento', ent)),
            n_salida: de('sin_documento', sal).length, amt_salida: sum(de('sin_documento', sal)),
          },
        },
        // vista filtrable (una tabla clasificada) + compat PDF (rows=sin_rastro, cost_pairs)
        entries: filtered.slice(0, CAP), entries_total: filtered.length, entries_truncated: filtered.length > CAP,
        rows: srAll.slice(0, CAP), total: srAll.length, truncated: srAll.length > CAP,
        cost_pairs: costPairs.slice(0, CAP), cost_total: costPairs.length, cost_truncated: costPairs.length > CAP,
      };
    });
  }

  /**
   * DM.13 — Cuadre traspasos KEPLER → WINCAJA (tiendas solo-Wincaja 30/32/50, que NO están
   * en Kepler → sus recepciones no aparecen en el 515). Cuadre por TOTALES de control por
   * tienda×mes: Σ salida CEDIS (Kepler 515-002, mapeada por nombre de destino) vs Σ recepción
   * CEDIS (Wincaja tipo C / tercero 0 / obs 'A0 …', costo). NO folio-a-folio (no hay llave).
   *
   * Estructura Kepler (2026-08): las pólizas viven en 6 DBs de sucursal md_00..md_05
   * (00=CEDIS, 01=Padre Hidalgo, 02=Piedad, 03=8 Esquinas, 04=Yurécuaro, 05=Zamora) →
   * `gl_poliza_lines.sucursal` = branch de origen. El 98% del 515-002 se contabiliza en
   * suc=00 (CEDIS es el origen de todo traspaso saliente); el DESTINO solo está en el texto
   * libre `referencia`, con MUCHAS variantes por captura manual.
   *
   * Mapa nombre Kepler → tienda Wincaja (verificado vs data 2026-08):
   *   30 Morelia Abastos ← 'M.A' + 'ABASTOS' pelón (misma serie de folio T-79XX). OJO: excluir
   *       'ABASTOS LA PIEDAD'/'L.P'/'LP' → esa es La Piedad (suc 02, NO Wincaja) y va ANTES.
   *   32 Morelia Madero ← 'M.M' (con puntos, no 'MM') / 'MADERO'.
   *   50 Canindo ← 'CANINDO' / 'CAN …'.
   * Se descartan 'TRASPASO A CEDIS T99-…' (retorno inverso, no despacho a tienda).
   *
   * Caveats estructurales (NO son bug del cuadre — así abastece el negocio):
   *  · CANINDO se surte casi NADA por traspaso CEDIS (515-002 ~$1.9M/trim); su entrada real
   *    es COMPRA de zona ('COMPRA ZAM CANINDO' en 515-001 ~$23M/trim) → el Δ negativo grande
   *    es esperado, este cuadre solo mide el canal CEDIS.
   *  · MADERO recibe poco directo del CEDIS (Wincaja tercero='0' chico); se resurte vía
   *    Morelia Abastos (Wincaja tercero='30'). Por eso la recepción cuenta TODOS los terceros
   *    de traspaso (CEDIS + tienda hermana), no solo '0' — se decompone en wincaja_cedis/inter.
   *  · Caveat de red: contar el traspaso inter-tienda puede DOBLE-contar a nivel red (lo que
   *    CEDIS→Abastos y luego Abastos→Madero es el mismo bien). Por tienda vs su destino Kepler
   *    es correcto; el total de red es indicativo, no una identidad.
   * Cobertura Wincaja por tienda varía → `last_date` avisa meses parciales. Unidad Wincaja ≠
   * piezas Kepler → comparar $ (costo), no piezas.
   */
  async transfersWincajaCheck(q: MovementsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const { from, to } = this.range(q);
    const fromYm = from.slice(0, 7), toYm = to.slice(0, 7);
    const STORES = [
      { code: '30', name: 'Morelia Abastos' },
      { code: '32', name: 'Morelia Madero' },
      { code: '50', name: 'Canindo' },
    ];
    const classify = (ref: string | null): string | null => {
      const s = (ref || '').toUpperCase();
      if (/T99/.test(s) && /CEDIS/.test(s)) return null;                    // retorno a CEDIS (reverso)
      if (/CANINDO|\bCAN\b/.test(s)) return '50';
      if (/M\.?M\b|MORELIA MADERO|\bMADERO\b/.test(s)) return '32';
      if (/ABASTOS L\.?P|LA PIEDAD|\bL\.?P\b|\bLP\b/.test(s)) return null;  // La Piedad (suc 02), NO tienda Wincaja
      if (/M\.?A\b|MORELIA ABAST|\bABASTOS\b/.test(s)) return '30';         // M.A + 'ABASTOS' pelón (misma serie T-79XX)
      return null;
    };
    const months: string[] = [];
    for (let [y, m] = fromYm.split('-').map(Number); `${y}-${String(m).padStart(2, '0')}` <= toYm;) {
      months.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; }
    }
    return this.tk.run(async (trx) => {
      const sal: any[] = await trx('analytics.gl_poliza_lines')
        .where('tenant_id', tenantId).andWhere('source', 'kepler')
        .andWhereRaw(`cuenta LIKE '515-002%'`)
        .andWhere('anio_mes', '>=', fromYm).andWhere('anio_mes', '<=', toYm)
        .andWhereRaw('COALESCE(importe,0)<>0')
        .select('anio_mes', 'importe', 'referencia');
      // Canal COMPRA de zona (515-001 'COMPRA … CANINDO') — abastece Canindo casi por completo,
      // NO es traspaso CEDIS. Se muestra como contexto para explicar el Δ negativo, fuera del cuadre.
      const compra: any[] = await trx('analytics.gl_poliza_lines')
        .where('tenant_id', tenantId).andWhere('source', 'kepler')
        .andWhereRaw(`cuenta LIKE '515-001%'`)
        .andWhereRaw(`UPPER(referencia) LIKE '%CANINDO%'`)
        .andWhere('anio_mes', '>=', fromYm).andWhere('anio_mes', '<=', toYm)
        .andWhereRaw('COALESCE(importe,0)<>0')
        .groupBy('anio_mes').select('anio_mes').sum({ v: 'importe' });
      const compraMap = new Map<string, number>(compra.map((r) => [r.anio_mes, Number(r.v) || 0]));
      // Recepción por TRASPASO (tipo C). El `tercero` distingue el origen:
      //   '0' = CEDIS (almacén origen 00) · códigos de tienda SIN padding ('10','30','32','50'…)
      //   = traspaso inter-tienda (ej. Madero se resurte desde Abastos=30). Los terceros de
      //   3+ dígitos con padding ('285','013','335'…) son PROVEEDORES (compra directa) → NO
      //   son traspaso, se excluyen. Se decompone en cedis-directo vs inter-tienda para transparencia.
      const STORE_TERCEROS = ['0', '01', '02', '03', '04', '05', '10', '30', '32', '40', '42', '44', '50', '54'];
      const rec: any[] = await trx('wincaja.maestro_mov_almacen as m')
        .join('wincaja.detalles_mov_almacen as d', function (this: any) {
          this.on('d.tenant_id', 'm.tenant_id').andOn('d.source_branch', 'm.source_branch')
            .andOn('d.source_dataset', 'm.source_dataset').andOn('d.consecutivo', 'm.consecutivo');
        })
        .where('m.tenant_id', tenantId).whereIn('m.source_branch', STORES.map((s) => s.code))
        .andWhere('m.tipo', 'C').whereIn('m.tercero', STORE_TERCEROS)
        .andWhereRaw(`to_char(m.fecha,'YYYY-MM') >= ?`, [fromYm]).andWhereRaw(`to_char(m.fecha,'YYYY-MM') <= ?`, [toYm])
        .groupByRaw(`m.source_branch, to_char(m.fecha,'YYYY-MM')`)
        .select(trx.raw(`m.source_branch AS code`), trx.raw(`to_char(m.fecha,'YYYY-MM') AS ym`),
          trx.raw(`SUM(ABS(COALESCE(d.valor_costo,0))) AS costo`),
          trx.raw(`SUM(ABS(COALESCE(d.valor_costo,0))) FILTER (WHERE m.tercero='0') AS costo_cedis`),
          trx.raw(`SUM(ABS(COALESCE(d.valor_costo,0))) FILTER (WHERE m.tercero<>'0') AS costo_inter`),
          trx.raw(`COUNT(DISTINCT m.consecutivo) AS docs`));
      const cov: any[] = await trx('wincaja.maestro_mov_almacen')
        .where('tenant_id', tenantId).whereIn('source_branch', STORES.map((s) => s.code))
        .groupBy('source_branch').select('source_branch').max('fecha as last_date');

      // Kepler mapeado por (store, mes)
      const kMap = new Map<string, number>();
      let keplerUnmapped = 0;
      for (const r of sal) {
        const code = classify(r.referencia);
        if (!code) { keplerUnmapped += Number(r.importe) || 0; continue; }
        const k = `${code}|${r.anio_mes}`;
        kMap.set(k, (kMap.get(k) || 0) + (Number(r.importe) || 0));
      }
      const wMap = new Map<string, { costo: number; cedis: number; inter: number; docs: number }>();
      for (const r of rec) wMap.set(`${r.code}|${r.ym}`, {
        costo: Number(r.costo) || 0, cedis: Number(r.costo_cedis) || 0, inter: Number(r.costo_inter) || 0, docs: Number(r.docs) || 0,
      });
      const lastByCode = new Map(cov.map((c) => [c.source_branch, c.last_date]));

      const rows: any[] = [];
      // [MX.1.5] `delta_abs` = Σ|Δ| tienda×mes. El neto compensa tiendas y meses entre sí: medido en 2026,
      // Δ neto −$17.4 M contra $71.4 M de diferencias brutas ($54 M escondidos). El veredicto va sobre el bruto.
      const totals = { kepler: 0, wincaja: 0, delta: 0, delta_abs: 0 };
      for (const st of STORES) {
        for (const ym of months) {
          const kepler = kMap.get(`${st.code}|${ym}`) || 0;
          const w = wMap.get(`${st.code}|${ym}`) || { costo: 0, cedis: 0, inter: 0, docs: 0 };
          const compraZona = st.code === '50' ? (compraMap.get(ym) || 0) : 0;
          if (kepler === 0 && w.costo === 0 && compraZona === 0) continue;
          const delta = kepler - w.costo;
          rows.push({
            code: st.code, name: st.name, anio_mes: ym,
            kepler_envio: kepler, wincaja_recibido: w.costo,
            wincaja_cedis: w.cedis, wincaja_inter: w.inter, // desglose: directo CEDIS vs vía tienda hermana
            docs: w.docs, delta,
            kepler_compra_zona: compraZona, // solo Canindo: 515-001 COMPRA (canal real, no CEDIS)
          });
          totals.kepler += kepler; totals.wincaja += w.costo; totals.delta += delta; totals.delta_abs += Math.abs(delta);
        }
      }
      const stores = STORES.map((st) => ({ ...st, last_date: lastByCode.get(st.code) || null }));
      return { range: { from: fromYm, to: toYm }, stores, rows, totals, kepler_unmapped: keplerUnmapped };
    });
  }

  /**
   * DM.13b — DETALLE folio a folio de UNA tienda×mes, cruzando los DOS sistemas: lo que el
   * CEDIS despachó en Kepler (515-002, pólizas que mapean a esta tienda por referencia) ⇄ lo que
   * la tienda recibió en Wincaja (documentos de traspaso tipo C). NO hay llave común folio↔folio
   * (Kepler no conoce estas tiendas) → se muestran las dos listas lado a lado + sus totales + Δ,
   * para localizar manualmente qué despacho corresponde a qué recepción. Reusa el mismo mapeo de
   * destino y terceros que el cuadre por totales (transfersWincajaCheck).
   */
  async transfersWincajaDetail(q: MovementsQuery, code: string, anioMes: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const STORES: Record<string, string> = { '30': 'Morelia Abastos', '32': 'Morelia Madero', '50': 'Canindo' };
    const name = STORES[code];
    const CAP = 500;
    // Mismo clasificador de destino que transfersWincajaCheck (referencia libre → código de tienda).
    const classify = (ref: string | null): string | null => {
      const s = (ref || '').toUpperCase();
      if (/T99/.test(s) && /CEDIS/.test(s)) return null;
      if (/CANINDO|\bCAN\b/.test(s)) return '50';
      if (/M\.?M\b|MORELIA MADERO|\bMADERO\b/.test(s)) return '32';
      if (/ABASTOS L\.?P|LA PIEDAD|\bL\.?P\b|\bLP\b/.test(s)) return null;
      if (/M\.?A\b|MORELIA ABAST|\bABASTOS\b/.test(s)) return '30';
      return null;
    };
    const empty = {
      code, name: name || code, anio_mes: anioMes,
      kepler: { rows: [] as any[], total: 0, truncated: false },
      wincaja: { rows: [] as any[], total: 0, cedis: 0, inter: 0, truncated: false },
      delta: 0,
    };
    if (!name || !/^\d{4}-\d{2}$/.test(anioMes || '')) return empty;

    return this.tk.run(async (trx) => {
      // ── Kepler: despachos 515-002 del mes que mapean a esta tienda ──
      const salAll: any[] = await trx('analytics.gl_poliza_lines')
        .where('tenant_id', tenantId).andWhere('source', 'kepler')
        .andWhereRaw(`cuenta LIKE '515-002%'`)
        .andWhere('anio_mes', anioMes)
        .andWhereRaw('COALESCE(importe,0)<>0')
        .select('sucursal', 'importe', 'referencia', 'tipo_pol', 'folio');
      const kRowsAll = salAll
        .filter((r) => classify(r.referencia) === code)
        .map((r) => ({
          sucursal: r.sucursal, importe: Number(r.importe) || 0, referencia: r.referencia || null,
          folio: r.folio ? `${r.tipo_pol || ''}${r.folio}` : null,
        }))
        .sort((a, b) => b.importe - a.importe);
      const kTotal = kRowsAll.reduce((a, r) => a + r.importe, 0);

      // ── Wincaja: recepciones por traspaso (tipo C) del mes, folio a folio ──
      const STORE_TERCEROS = ['0', '01', '02', '03', '04', '05', '10', '30', '32', '40', '42', '44', '50', '54'];
      const wRowsAll: any[] = await trx('wincaja.maestro_mov_almacen as m')
        .join('wincaja.detalles_mov_almacen as d', function (this: any) {
          this.on('d.tenant_id', 'm.tenant_id').andOn('d.source_branch', 'm.source_branch')
            .andOn('d.source_dataset', 'm.source_dataset').andOn('d.consecutivo', 'm.consecutivo');
        })
        .where('m.tenant_id', tenantId).andWhere('m.source_branch', code)
        .andWhere('m.tipo', 'C').whereIn('m.tercero', STORE_TERCEROS)
        .andWhereRaw(`to_char(m.fecha,'YYYY-MM') = ?`, [anioMes])
        .groupByRaw(`m.consecutivo, m.fecha, m.tercero, m.observaciones`)
        .select(
          trx.raw(`m.consecutivo AS folio`), trx.raw(`m.fecha::date AS fecha`), trx.raw(`m.tercero AS tercero`),
          trx.raw(`m.observaciones AS obs`),
          trx.raw(`SUM(ABS(COALESCE(d.valor_costo,0))) AS costo`),
          trx.raw(`COUNT(*) AS lineas`),
        )
        .orderByRaw(`SUM(ABS(COALESCE(d.valor_costo,0))) DESC`);
      const wRows = wRowsAll.map((r) => ({
        folio: String(r.folio), fecha: r.fecha, tercero: String(r.tercero),
        origen: r.tercero === '0' ? 'CEDIS' : `tienda ${r.tercero}`,
        obs: (r.obs || '').trim() || null, costo: Number(r.costo) || 0, lineas: Number(r.lineas) || 0,
      }));
      const wTotal = wRows.reduce((a, r) => a + r.costo, 0);
      const cedis = wRows.filter((r) => r.tercero === '0').reduce((a, r) => a + r.costo, 0);

      return {
        code, name, anio_mes: anioMes,
        kepler: { rows: kRowsAll.slice(0, CAP), total: kTotal, truncated: kRowsAll.length > CAP },
        wincaja: { rows: wRows.slice(0, CAP), total: wTotal, cedis, inter: wTotal - cedis, truncated: wRows.length > CAP },
        delta: kTotal - wTotal,
      };
    });
  }

  /** DM.12 — junta los lentes del cuadre (contable + matriz física + folios + detalle) para el PDF. */
  async exportCuadreData(q: MovementsQuery) {
    const [ledger, physical, detail] = await Promise.all([
      this.transfersLedger(q), this.transfersPhysical(q), this.transfersLedgerDetail(q),
    ]);
    return { range: this.range(q), ledger, matrix: physical.matrix, check: physical.check, detail };
  }

  /** DM.6 — junta todo lo que necesita el export (docs englobados + totales + traspasos). */
  async exportData(q: MovementsQuery) {
    const PAGE = 500, MAX_PAGES = 10; // cap 5,000 docs por export
    const first = await this.lines({ ...q, page: 1, pageSize: PAGE });
    const docs = [...first.rows];
    const pages = Math.min(Math.ceil(first.total / PAGE), MAX_PAGES);
    for (let p = 2; p <= pages; p++) docs.push(...(await this.lines({ ...q, page: p, pageSize: PAGE })).rows);
    const s = await this.summary(q);
    const t = await this.transfersCheck(q);
    return {
      range: s.range,
      totals: {
        entradas: Number(s.totals?.entradas) || 0,
        salidas: Number(s.totals?.salidas) || 0,
        valor: Number(s.totals?.valor) || 0,
        documentos: Number(s.totals?.documentos) || 0,
        lineas_sin_importe: Number(s.totals?.lineas_sin_importe) || 0, // [MX.1.2]
      },
      docs,
      transfers: t.rows,
      // [MX.2.1] los KPIs de traspasos salen de acá, no de sumar `transfers` (cortadas en 500)
      transfer_totals: t.totals,
      transfer_sums: t.sums,
      transfers_capped: t.capped,
      truncated: first.total > docs.length,
    };
  }

  /**
   * Almacenes + tipos de documento presentes (para los selects del frontend).
   *
   * [DB-MEM.11] Los dos `DISTINCT` de acá barrían `analytics.stock_movements` ENTERA —
   * 3,702,198 filas / 1,980 MB — para devolver **10 almacenes y 19 tipos de documento**.
   * Medido en prod: 23,385 ms el de almacenes y 11,079 ms el de tipos, o sea que la barra de
   * filtros de la pantalla costaba ~34 s. Es el patrón "escaneo una tabla de hechos para llenar
   * un combo": lo caro no es el DISTINCT, es que la única forma de saber qué valores EXISTEN era
   * mirarlos todos.
   *
   * Los dos se dan vuelta para preguntar desde el lado chico:
   *
   *  - ALMACENES: en vez de barrer los movimientos y juntar los almacenes, se recorren los
   *    almacenes (28 filas) y se le pregunta al índice si cada uno tiene movimientos.
   *    Medido: 12,342 páginas (96 MB) → **91 páginas (1 MB)**, 528 ms → 0.247 ms.
   *    ⚠️ Antes de cambiarlo se verificó que NO hay `warehouse_id` huérfano (0 de 10): con
   *    huérfanos, el `LEFT JOIN` original los mostraba con code/name en NULL y el `EXISTS` los
   *    perdería. Si algún día aparece uno, este cambio deja de ser equivalente.
   *
   *  - TIPOS DE DOCUMENTO: salto de índice ("loose index scan") sobre
   *    `ix_stockmov_code (tenant_id, warehouse_id, doc_code)` — en vez de leer 3.7 M filas para
   *    quedarse con 19 valores, salta de un `doc_code` al siguiente.
   *    Medido: 130,991 páginas (1,023 MB) → **1,768 páginas (14 MB)**, 12,360 ms → 184 ms.
   *    ⚠️ Se verificó que `movement_label`/`movement_kind` dependen SÓLO de `doc_code`
   *    (0 códigos con más de una etiqueta); si dejara de cumplirse, el `LIMIT 1` del LATERAL
   *    elegiría una etiqueta arbitraria.
   *
   * ⚠️ El desempate por `doc_code` NO es cosmético. `ORDER BY movement_label` solo NO garantiza
   * orden entre empates, y hay dos: `Sale1` y `WIN_V`, ambos etiquetados "Venta". O sea que el
   * combo YA podía voltearlos entre corridas. Con el desempate el resultado queda idéntico, fila
   * por fila, al que producción devuelve hoy — y además deja de ser arbitrario.
   */
  async filters() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const warehouses = (
        await trx.raw(
          `SELECT w.id, w.code, w.name
             FROM commercial.warehouses w
            WHERE EXISTS (SELECT 1 FROM analytics.stock_movements m
                           WHERE m.tenant_id = ? AND m.warehouse_id = w.id)
            ORDER BY w.code ASC`,
          [tenantId],
        )
      ).rows;

      const doc_types = (
        await trx.raw(
          `WITH RECURSIVE wh AS (
             SELECT w.id FROM commercial.warehouses w
              WHERE EXISTS (SELECT 1 FROM analytics.stock_movements m
                             WHERE m.tenant_id = ? AND m.warehouse_id = w.id)
           ), saltos AS (
             SELECT wh.id AS warehouse_id,
                    (SELECT min(m.doc_code) FROM analytics.stock_movements m
                      WHERE m.tenant_id = ? AND m.warehouse_id = wh.id) AS doc_code
               FROM wh
             UNION ALL
             SELECT s.warehouse_id,
                    (SELECT min(m.doc_code) FROM analytics.stock_movements m
                      WHERE m.tenant_id = ? AND m.warehouse_id = s.warehouse_id
                        AND m.doc_code > s.doc_code)
               FROM saltos s WHERE s.doc_code IS NOT NULL
           )
           SELECT DISTINCT d.doc_code, d.movement_label, d.movement_kind
             FROM (SELECT DISTINCT warehouse_id, doc_code FROM saltos WHERE doc_code IS NOT NULL) s
             CROSS JOIN LATERAL (
               SELECT m.doc_code, m.movement_label, m.movement_kind
                 FROM analytics.stock_movements m
                WHERE m.tenant_id = ? AND m.warehouse_id = s.warehouse_id
                  AND m.doc_code = s.doc_code
                LIMIT 1) d
            ORDER BY d.movement_label ASC, d.doc_code ASC`,
          [tenantId, tenantId, tenantId, tenantId],
        )
      ).rows;

      return { warehouses, doc_types };
    });
  }
}
