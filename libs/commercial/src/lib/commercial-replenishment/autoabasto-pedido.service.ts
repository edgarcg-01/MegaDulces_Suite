import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService, TenantContextService, MX_TZ, toMxDateKey, branchKeySql } from '@megadulces/platform-core';
import {
  armarRenglon,
  surteDe,
  ORIGEN_NO_VALIDO_MSG,
  type AutoabastoEnvioKepler,
  type OrigenNoValido,
  estatusVigenteSql,
  WAREHOUSE_ORDER_ABIERTOS_SQL,
  coberturaAutoabasto,
  COBERTURA_AUTOABASTO,
  COBERTURA_AUTOABASTO_DEFAULT,
  necesitaMotivo,
  normalizarPosiciones,
  MOTIVOS_AJUSTE,
  POSICIONES_PEDIDO_DEFAULT,
  type PosicionPedido,
  type AutoabastoPosicionesRequest,
  type MotivoAjuste,
  type AjusteLinea,
  type EscaleraUnidades,
  type AutoabastoPedidoGrupo,
  type VieneBase,
  type RenglonArmado,
  filtrarRenglones,
  ordenarRenglones,
  resumirRenglones,
  type FiltroMesa,
  type OrdenMesa,
  type AutoabastoMesaRenglon,
  type DiagnosticoRenglon,
  type AutoabastoRenglonesResponse,
  type AutoabastoPedidoResponse,
  type AutoabastoAjusteRequest,
  type AutoabastoAjusteResponse,
  type AutoabastoRestablecerRequest,
  type AutoabastoAceptarGrupoRequest,
  type AutoabastoAbrirRequest,
  motivoNoEnviable,
  yaSeMandoACompras,
  type AutoabastoEnviarRequest,
  type AutoabastoEnviarResponse,
  type SurteRenglon,
  type AutoabastoVieneRenglon,
  type AutoabastoVieneRenglonesResponse,
  type AutoabastoVieneDoc,
  type AutoabastoVieneDocsResponse,
  type SucursalPendientesAlmacen,
  // `[AB.PM.3]` El pedido a mano.
  alcanceDelRenglon,
  fallaDeOrigen,
  type AutoabastoManoOrigenesResponse,
  partirCaptura,
  propuestaDelRenglon,
  unidadDeCaptura,
  unidadesDeCaptura,
  RECHAZO_KEPLER_MSG,
  type DestinoCaptura,
  type AutoabastoManoMedidas,
  type AutoabastoManoProducto,
  type AutoabastoManoBuscarResponse,
  type AutoabastoManoRenglon,
  type AutoabastoManoResponse,
  type AutoabastoManoGuardarRequest,
  type AutoabastoManoQuitarRequest,
  type AutoabastoManoEnviarRequest,
  type AutoabastoManoEnviarResponse,
} from '@megadulces/contracts';
import { CommercialReplenishmentService, venta30dBaseSql, type CreateRequisitionDto } from './commercial-replenishment.service';
import { cajasDeBase, rechazoDelTraspaso } from './ficha-kepler';
import { consultaBuscadorCatalogo, ORDEN_BUSCADOR_CATALOGO } from '../shared/catalogo-buscador';
import {
  VENTANA_YA_PEDIDO_DIAS, VENTANA_NEGADO_DIAS, VENTANA_EN_CAMINO_DIAS, VENTANA_VIENE_DIAS,
  PEDIDOS_SUCURSAL_SQL, EMBARCADO_SIN_RECIBIR_SQL, sumarYaPedido, leerEscaleras,
  type FilaPedidos, type FilaEnCamino,
} from './ya-pedido-sucursal';
// `[AB.34]` Se re-exporta: sus pruebas y otros consumidores lo importaban de aquí.
export { factorBaseDe } from './ya-pedido-sucursal';

/**
 * `[AB.23]` Los DOCUMENTOS que le van a llegar: pedidos de traspaso abiertos (versión vigente, como
 * `PEDIDOS_SUCURSAL_SQL`) y embarques sin recibir, de `VENTANA_VIENE_DIAS`. Es lo que la sucursal
 * lee arriba para no pedir dos veces; el detalle por producto va en cada renglón.
 */
export const VIENE_DOCS_SQL = `
WITH dest AS (
  SELECT dest_code FROM analytics.v_erp_branch_catalog WHERE tenant_id = :t AND suc_code = :suc
),
ped AS (
  SELECT DISTINCT ON (k.sucursal, k.c5, k.c6)
         'pedido'::text AS tipo, btrim(k.sucursal) AS origen, (k.c5)::int AS serie, btrim(k.c6::text) AS folio,
         ${estatusVigenteSql('k')} AS estado, (k.c9)::date AS f,
         NULLIF(regexp_replace(k.c16::text, '[^0-9.-]', '', 'g'), '')::numeric AS monto,
         k.sucursal AS s_raw, k.c2, k.c3, k.c4, k.c5, k.c6
    FROM kepler_ods.kdm1 k
   WHERE k.c2 = 'U' AND k.c3 = 'D' AND (k.c4)::int = 40 AND btrim(k.c1) = btrim(k.sucursal)
     AND k.c9 >= current_date - ${VENTANA_VIENE_DIAS} AND upper(btrim(k.c27::text)) = 'SUCURSAL'
     AND btrim(k.c10::text) IN (SELECT dest_code FROM dest)
   ORDER BY k.sucursal, k.c5, k.c6, k.c9 DESC
),
emb AS (
  SELECT 'embarque'::text AS tipo, btrim(h.sucursal) AS origen, (h.c5)::int AS serie, btrim(h.c6::text) AS folio,
         'EMBARCADO'::text AS estado, (h.c9)::date AS f,
         NULLIF(regexp_replace(h.c16::text, '[^0-9.-]', '', 'g'), '')::numeric AS monto,
         h.sucursal AS s_raw, h.c2, h.c3, h.c4, h.c5, h.c6
    FROM kepler_ods.kdm1 h
   WHERE h.c2 = 'U' AND h.c3 = 'D' AND (h.c4)::int = 41 AND btrim(h.c1) = btrim(h.sucursal)
     AND btrim(COALESCE(h.c43, '')) <> 'C'
     AND (h.c9)::date >= current_date - ${VENTANA_VIENE_DIAS}
     AND btrim(h.c10::text) IN (SELECT dest_code FROM dest)
     -- [AB.45] x.c4 = 50 y btrim(x.c39) tal cual: así coinciden con el predicado y la expresión de
     -- ix_kdm1_recepcion_traspaso. Con (x.c4)::int y c39::text el índice no se usaba y el anti-join
     -- leía ~492 renglones por embarque (157 a 44 ms en Padre Hidalgo; mismas filas en 9 de 9).
     AND NOT EXISTS (
       SELECT 1 FROM kepler_ods.kdm1 x
        WHERE x.c2 = 'U' AND x.c3 = 'A' AND x.c4 = 50
          AND btrim(x.sucursal) = :suc AND btrim(x.c1) = :suc
          AND x.c37 = 41 AND x.c38 = h.c5 AND btrim(x.c39) = btrim(h.c6::text)
          AND btrim(COALESCE(x.c43, '')) <> 'C' AND (x.c9)::date >= (h.c9)::date - 1)
),
docs AS (
  -- [PQ.136] CREADO entra: desde ADR-127 la Suite escribe el pedido y nace así. [PQ.137] El
  -- estado es el VIGENTE, así que un cancelado de Kepler sale CANCELADO y no cae acá (antes se
  -- pintaba con su c11 viejo: 82 de 111 documentos de Morelia Madero estaban cancelados).
  SELECT * FROM ped WHERE estado IN ${WAREHOUSE_ORDER_ABIERTOS_SQL}
  UNION ALL SELECT * FROM emb
)
SELECT d.tipo, d.origen, d.serie, d.folio, d.estado, to_char(d.f, 'YYYY-MM-DD') AS fecha,
       (current_date - d.f)::int AS dias, d.monto,
       (SELECT count(*) FROM kepler_ods.kdm2 x
         WHERE x.sucursal = d.s_raw AND x.c2 = d.c2 AND x.c3 = d.c3 AND x.c4 = d.c4 AND x.c5 = d.c5 AND x.c6 = d.c6
           AND btrim(x.c1) = btrim(x.sucursal) AND NULLIF(btrim(x.c8::text), '') IS NOT NULL)::int AS renglones
  FROM docs d
 ORDER BY d.f DESC, d.origen, d.folio DESC`;

/**
 * `[AB.41]` Los productos de UN documento de Kepler de «Lo que te va a llegar» (pedido `U-D-40` o
 * embarque `U-D-41`): la versión vigente del documento y su renglón ancla, como `VIENE_DOCS_SQL`.
 * El candado de alcance es el destino: si el documento no va al cliente de traspaso de ESTA
 * sucursal, no devuelve nada (pedir el folio de otra sucursal da vacío, no sus renglones).
 * Medido en prod el 2026-10-26: 1 ms (índice `ix_kdm1_venta_doc` + `kdm2_pkey`).
 */
const VIENE_RENGLONES_SQL = `
WITH dest AS (
  SELECT dest_code FROM analytics.v_erp_branch_catalog WHERE tenant_id = :t AND suc_code = :suc
),
h AS (
  SELECT DISTINCT ON (k.sucursal, k.c5, k.c6) k.sucursal, k.c2, k.c3, k.c4, k.c5, k.c6
    FROM kepler_ods.kdm1 k
   WHERE k.c2 = 'U' AND k.c3 = 'D' AND (k.c4)::int = :doctype AND btrim(k.c1) = btrim(k.sucursal)
     AND btrim(k.sucursal) = :origen AND (k.c5)::int = :serie AND btrim(k.c6::text) = :folio
     AND k.c9 >= current_date - ${VENTANA_VIENE_DIAS}
     AND btrim(k.c10::text) IN (SELECT dest_code FROM dest)
   ORDER BY k.sucursal, k.c5, k.c6, k.c9 DESC
)
SELECT btrim(x.c8::text) AS sku, max(p.nombre) AS nombre,
       NULLIF(upper(btrim(x.c55::text)), '') AS unidad, sum(NULLIF(btrim(x.c51::text), '')::numeric) AS cantidad,
       NULLIF(upper(btrim(x.c11::text)), '') AS unidad_base, sum(NULLIF(btrim(x.c9::text), '')::numeric) AS cantidad_base
  FROM h
  JOIN kepler_ods.kdm2 x
    ON x.sucursal = h.sucursal AND x.c2 = h.c2 AND x.c3 = h.c3 AND x.c4 = h.c4 AND x.c5 = h.c5 AND x.c6 = h.c6
   AND btrim(x.c1) = btrim(x.sucursal)
  LEFT JOIN catalog.products p ON p.tenant_id = :t AND p.sku = btrim(x.c8::text)
 WHERE NULLIF(btrim(x.c8::text), '') IS NOT NULL
 GROUP BY 1, 3, 5
 ORDER BY 1`;

/**
 * `[AB.41]` Los productos de UNA requisición de la Suite (lo planeado por Compras o lo que mandó la
 * sucursal). Candado de alcance: la requisición tiene que ser de ESTE almacén. Cantidades en cajas
 * de la mesa, como en `REQ_SUCURSAL_SQL`.
 */
const REQ_RENGLONES_SQL = `
SELECT p.sku, p.nombre, sum(l.final_qty) AS cantidad
  FROM commercial.purchase_requisitions r
  JOIN commercial.purchase_requisition_lines l ON l.requisition_id = r.id AND l.tenant_id = r.tenant_id
  JOIN catalog.products p ON p.id = l.product_id AND p.tenant_id = r.tenant_id
 WHERE r.tenant_id = :t AND r.id = :id AND r.warehouse_id = :wh AND COALESCE(l.final_qty, 0) > 0
 GROUP BY p.sku, p.nombre
 ORDER BY p.sku`;

/**
 * `[AB.24]` Lo que Compras planeó mandarle a ESTA sucursal desde `/compras/pedido` (requisición de
 * traspaso, `source_type='branch'`) que todavía no llegó a Kepler. Medido 2026-10-22: de 788, ninguna
 * llegó (el envío está apagado: `KEPLER_PUSH_URL sin configurar`). Sólo lo reciente: 306 aprobadas
 * tienen más de 7 días y son planes que nadie ejecutó.
 */
const PLANEADO_COMPRAS_SQL = `
SELECT r.id, r.folio, r.estado, coalesce(wo.kepler_code, wo.code) AS origen, to_char(r.created_at::date, 'YYYY-MM-DD') AS fecha,
       (current_date - r.created_at::date)::int AS dias, r.total_cost AS monto, l.product_id, l.final_qty
  FROM commercial.purchase_requisitions r
  JOIN commercial.purchase_requisition_lines l ON l.requisition_id = r.id AND l.tenant_id = r.tenant_id
  LEFT JOIN commercial.warehouses wo ON wo.id = r.source_warehouse_id AND wo.tenant_id = r.tenant_id
 WHERE r.tenant_id = :t AND r.warehouse_id = :wh AND r.source_type = 'branch'
   AND r.estado IN ('pending_approval', 'approved') AND r.kepler_folio IS NULL
   AND r.created_at >= now() - interval '${VENTANA_YA_PEDIDO_DIAS} days'
   AND COALESCE(l.final_qty, 0) > 0`;

/**
 * `[AB.29]` Lo planeado por Compras SIN lo que pidió la propia sucursal: una requisición de traspaso
 * que la sucursal mandó también es `source_type='branch'`, y sin este filtro saldría dos veces (como
 * «Compras lo planeó» y como «Lo pediste a Compras»). Sin la columna (migración sin aplicar) no hay
 * requisiciones de sucursal que excluir.
 */
const planeadoComprasSql = (marca: boolean): string => PLANEADO_COMPRAS_SQL + (marca ? ' AND NOT r.requested_by_branch' : '');

/**
 * `[AB.29]` Lo que ESTA sucursal mandó a Compras («Enviar a Compras»), renglón por renglón:
 *  · VIVA (cuenta como «Lo pediste a Compras», no se vuelve a sugerir): por aprobar, o aprobada de
 *    `VENTANA_YA_PEDIDO_DIAS` o menos (pasado eso debería estar en Kepler y contarse como «ya pedido»);
 *  · RECHAZADA de esa misma ventana: sólo se muestra, con su motivo, para que la sucursal sepa por qué.
 * Nunca se resta (D14). Las cantidades están en cajas de la mesa.
 */
const REQ_SUCURSAL_SQL = `
SELECT r.id, r.folio, r.estado, r.source_type, coalesce(wo.kepler_code, wo.code) AS origen, s.name AS proveedor,
       to_char(r.created_at::date, 'YYYY-MM-DD') AS fecha, (current_date - r.created_at::date)::int AS dias,
       r.total_cost AS monto, r.rejection_reason AS motivo,
       (r.estado = 'pending_approval'
        OR (r.estado = 'approved' AND COALESCE(r.approved_at, r.created_at) >= now() - interval '${VENTANA_YA_PEDIDO_DIAS} days')) AS viva,
       l.product_id, l.final_qty
  FROM commercial.purchase_requisitions r
  JOIN commercial.purchase_requisition_lines l ON l.requisition_id = r.id AND l.tenant_id = r.tenant_id
  LEFT JOIN commercial.warehouses wo ON wo.id = r.source_warehouse_id AND wo.tenant_id = r.tenant_id
  LEFT JOIN catalog.suppliers s ON s.id = r.supplier_id AND s.tenant_id = r.tenant_id
 WHERE r.tenant_id = :t AND r.warehouse_id = :wh AND r.requested_by_branch
   AND (r.estado = 'pending_approval'
        OR (r.estado = 'approved' AND COALESCE(r.approved_at, r.created_at) >= now() - interval '${VENTANA_YA_PEDIDO_DIAS} days')
        OR (r.estado = 'cancelled' AND r.rejected_at >= now() - interval '${VENTANA_YA_PEDIDO_DIAS} days'))`;

/** `[AB.29]` ¿Ya está la marca «pedida por sucursal»? (la migración viaja aparte del código). */
const MARCA_SUCURSAL_SQL = `SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'commercial' AND table_name = 'purchase_requisitions' AND column_name = 'requested_by_branch'`;

/** `[AB.29]` Quién recibe las requisiciones de sucursal: la responsabilidad repartida por persona. */
const LE_LLEGA_A_SQL = `
SELECT u.nombre FROM identity.user_responsibilities ur
  JOIN identity.users u ON u.id = ur.user_id AND u.tenant_id = ur.tenant_id AND u.deleted_at IS NULL AND u.activo
 WHERE ur.tenant_id = :t AND ur.responsibility_key = 'compras.requisiciones_sucursal' AND ur.accion = 'suma'
   AND ur.deleted_at IS NULL AND (ur.valid_to IS NULL OR ur.valid_to >= current_date)
 ORDER BY u.nombre`;

const ESTADO_REQ: Record<string, string> = { pending_approval: 'POR APROBAR', approved: 'APROBADA', cancelled: 'RECHAZADA' };

/** ¿Hay cliente de traspaso para esta sucursal? Sin él, lo pedido NO se mide (≠ «cero»). */
const TIENE_DESTINO_SQL = `SELECT 1 FROM analytics.v_erp_branch_catalog WHERE tenant_id = :t AND suc_code = :suc LIMIT 1`;


/** `[AB.29]` Un renglón de una requisición que mandó la sucursal (ver `REQ_SUCURSAL_SQL`). */
interface FilaReqSucursal { id: string; folio: string; estado: string; source_type: string; origen: string | null; proveedor: string | null; fecha: string; dias: number; monto: string | number | null; motivo: string | null; viva: boolean; product_id: string; final_qty: string | number }
interface FilaPlan { id: string; folio: string | null; estado: string; origen: string | null; fecha: string; dias: number; monto: string | number | null; product_id: string; final_qty: string | number }
interface FilaDoc { tipo: 'pedido' | 'embarque'; origen: string; serie: number; folio: string; estado: string; fecha: string; dias: number; monto: string | number | null; renglones: number }

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `[AB.PM.1]` Lo que contesta el sugerido cuando el producto ya está en el pedido a mano (R1). */
const PEDIDO_A_MANO_MSG = 'Este producto lo pediste a mano: se cambia o se quita en «Pedir algo a mano», no en el sugerido.';
/** `[AB.PM.3]` Por qué el envío del sugerido deja fuera un producto pedido a mano (R1). */
const PEDIDO_A_MANO_ENVIO_MSG = 'Lo pediste a mano: sale con tu pedido a mano';
/** `[AB.PM.3]` El renglón cambió mientras el pedido viajaba a Kepler: salió lo de antes, lo nuevo se queda. */
const PEDIDO_A_MANO_CAMBIO_AL_ENVIAR_MSG = 'Cambió mientras se mandaba: salió con lo que tenía antes, y lo nuevo se queda en tu pedido a mano';

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numONull = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * `[AB.16]` Fase AB — **«Mi pedido»** de una sucursal.
 *
 * NO calcula el reabasto: toma los renglones de la mesa (`criticalStock` con la base 'demanda',
 * los mismos que valida AB.15 contra /compras/pedido) y les agrega lo que la mesa no sabe —lo ya
 * pedido a la matriz, lo atorado, lo negado— y la cantidad a capturar en Kepler, redondeada con
 * la regla de §15.2 (`redondearPedido`, en `libs/contracts`).
 *
 * Sólo LEE. La Suite no escribe en Kepler: el almacenista captura el pedido allá con lo que ve acá.
 */
@Injectable()
export class AutoabastoPedidoService {
  private readonly logger = new Logger(AutoabastoPedidoService.name);

  constructor(
    private readonly motor: CommercialReplenishmentService,
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * `[AB.27]` Lo que «Mi pedido» y la mesa leen de UN almacén, armado una sola vez y de una sola
   * forma: los renglones del motor, lo que ya viene, lo planeado por Compras y lo ajustado, pasados
   * por `armarRenglon` (AB.26). Las dos pantallas salen de aquí: si una cambiara la cuenta, cambiarían
   * las dos.
   */
  private async armarAlmacen(almacen: Almacen, area: string): Promise<AlmacenArmado> {
    const tenantId = this.tenantCtx.requireTenantId();
    const binds = { t: tenantId, suc: almacen.code };
    // `[AB.36]` Tres lecturas que no dependen una de otra, EN PARALELO (cada una en su transacción).
    // En serie, la mesa tardaba la suma: medido en prod el 2026-10-24, Padre Hidalgo 1.2–1.5 s con el
    // motor ya optimizado. Las cuentas no cambian: cada consulta es la misma, sólo deja de esperar a
    // la anterior. Son 3 conexiones por petición (el pool es de 10).
    //  1. el motor (`ligero`: sin el reparto de la red ni la etiquetera, que esta pantalla no lee) y,
    //     en cuanto llega, la escalera de SUS productos;
    //  2. lo de la Suite (borrador, ajustes, destino, planes) y los pedidos abiertos en Kepler;
    //  3. los embarques sin recibir y los documentos que vienen.
    // Las de Kepler corren aunque la sucursal no tenga cliente de traspaso (su `dest` sale vacío y
    // no devuelven nada); abajo se descartan igual si no está medida, como antes.
    const kepler = <T>(trx: Knex.Transaction, sql: string): Promise<T[]> =>
      trx.raw(sql, binds).then((r: { rows?: T[] }) => r.rows ?? []);
    const [{ filas, skus, escaleras, lineasProducto }, propio, llega] = await Promise.all([
      this.motor.criticalStock({ warehouse_id: almacen.id, target_basis: 'demanda', export: true, ligero: true }, area)
        .then(async (mesa) => {
          const skus = [...new Set(mesa.rows.map((f) => String(f['sku'])))];
          // `[AB.NI.1]` La escalera y la línea se leen JUNTAS: las dos son atributos del producto y
          // las dos las necesita el mismo renglón. Si la vista de líneas no existe todavía en esta
          // base, `lineasDe` devuelve un mapa vacío y el renglón sale con `linea: null` — la pantalla
          // lo agrupa en «(sin línea)» y lo dice, en vez de tirar el pedido entero.
          const [escaleras, lineasProducto] = await Promise.all([
            this.escalerasDe(skus),
            this.lineasDe(tenantId, almacen.code, skus),
          ]);
          return { filas: mesa.rows, skus, escaleras, lineasProducto };
        }),
      this.tk.run(async (trx: Knex.Transaction) => {
        // `[AB.18]` El borrador guardado y lo que la persona ya ajustó. Sólo LEE: abrir el pedido no
        // escribe nada (el borrador nace con el primer ajuste). Si la migración del borrador todavía
        // no llegó a esta base, el pedido se sirve igual y lo declara (`guardado_disponible`); se pregunta con
        // `to_regclass` porque un SELECT fallido abortaría la transacción entera.
        const guardable = await this.borradorDisponible(trx);
        const borrador = guardable ? await this.borradorDe(trx, tenantId, almacen.id) : null;
        // `[AB.19]` Hasta dónde pide: lo guardado en el borrador; sin borrador, el default.
        let posiciones: PosicionPedido[] = [...POSICIONES_PEDIDO_DEFAULT];
        if (borrador) {
          const b = await trx('commercial.autoabasto_pedidos').where({ tenant_id: tenantId, id: borrador }).first('posiciones');
          posiciones = normalizarPosiciones(b?.posiciones);
        }
        const ajustes = new Map<string, AjusteLinea & { cantidad_base: number }>();
        // `[AB.PM.3]` Lo pedido a mano NO es un ajuste del sugerido: vive aparte y saca al producto de
        // la cuenta del sugerido (R1, un producto vive una vez en el borrador).
        const aMano = new Set<string>();
        if (borrador) {
          const ls: FilaLinea[] = await trx('commercial.autoabasto_pedido_lineas')
            .where({ tenant_id: tenantId, pedido_id: borrador })
            .select('product_id', 'cantidad', 'unidad', 'cantidad_base', 'motivo', 'ajustado_por_username', 'ajustado_at', 'captura');
          for (const l of ls) {
            if (l.captura === 'mano') { aMano.add(l.product_id); continue; }
            ajustes.set(l.product_id, {
              cantidad: num(l.cantidad), unidad: l.unidad, motivo: (l.motivo as MotivoAjuste | null) ?? null,
              ajustado_por: l.ajustado_por_username, ajustado_at: new Date(l.ajustado_at).toISOString(),
              cantidad_base: num(l.cantidad_base),
            });
          }
        }
        const destino = await trx.raw(TIENE_DESTINO_SQL, binds);
        const medidos = (destino.rows ?? []).length > 0;
        // `[AB.24]` Lo planeado por Compras no depende de Kepler: se lee siempre.
        const marca = (await trx.raw(MARCA_SUCURSAL_SQL)).rows.length > 0;
        const planes = ((await trx.raw(planeadoComprasSql(marca), { t: tenantId, wh: almacen.id })).rows ?? []) as FilaPlan[];
        // `[AB.29]` Lo que la propia sucursal mandó a Compras.
        const deSucursal = marca
          ? ((await trx.raw(REQ_SUCURSAL_SQL, { t: tenantId, wh: almacen.id })).rows ?? []) as FilaReqSucursal[]
          : [];
        // `[AB.23]` Por (producto, unidad): se convierte a base más abajo, con la escalera.
        const pedidos = await kepler<FilaPedidos>(trx, PEDIDOS_SUCURSAL_SQL);
        return { medidos, planes, deSucursal, pedidos, borrador, ajustes, aMano, guardable, posiciones };
      }),
      this.tk.run(async (trx: Knex.Transaction) => ({
        enCamino: await kepler<FilaEnCamino>(trx, EMBARCADO_SIN_RECIBIR_SQL),
        docs: await kepler<FilaDoc>(trx, VIENE_DOCS_SQL),
      })),
    ]);
    const { medidos, planes, deSucursal, borrador, ajustes, aMano, guardable, posiciones } = propio;
    // Sin cliente de traspaso, lo pedido NO se mide (≠ «cero»): se descarta, como antes.
    const pedidos = medidos ? propio.pedidos : [];
    const enCamino = medidos ? llega.enCamino : [];
    const docs = medidos ? llega.docs : [];

    // `[AB.23]` → `[AB.34]` Lo que viene, por producto y en BASE: la MISMA cuenta que usa /compras/pedido
    // (`ya-pedido-sucursal.ts`). Una unidad que la escalera no conoce no se suma: se cuenta.
    const { viene, sinUnidad } = sumarYaPedido(pedidos, enCamino, escaleras, new Set(skus));
    // `[AB.24]` Lo planeado por Compras, por producto (cajas) y por documento.
    // `[AB.29]` Lo que la sucursal pidió (sólo lo VIVO cuenta para el estado) y sus documentos.
    const pedidoSucursal = new Map<string, number>();
    for (const q of deSucursal) {
      if (q.viva) pedidoSucursal.set(q.product_id, (pedidoSucursal.get(q.product_id) ?? 0) + num(q.final_qty));
    }
    const reqDocs = porDocumento(deSucursal);
    const planPorProducto = new Map<string, number>();
    for (const p of planes) {
      planPorProducto.set(p.product_id, (planPorProducto.get(p.product_id) ?? 0) + num(p.final_qty));
    }
    const planDocs = porDocumento(planes);
    // `[AB.PM.3]` R1: lo pedido a mano no se cuenta otra vez en el sugerido (ni en «Mi pedido» ni en la mesa).
    const renglones: RenglonInterno[] = filas.filter((f) => !aMano.has(String(f['product_id']))).map((f) => {
      const sku = String(f['sku']);
      // El factor del almacén: las cantidades "_nat" vienen en unidad base, las de la mesa en cajas.
      const cf = Math.max(1, num(f['caja_factor']));
      const productId = String(f['product_id']);
      // `[AB.26]` La cuenta del renglón vive en `libs/contracts` (`armarRenglon`). Acá sólo se le pasa
      // lo que el servidor leyó; ninguna resta se escribe aquí.
      // `[AB.NI.1]` La línea se pega DESPUÉS de la cuenta: no interviene en ninguna resta, sólo
      // agrupa. Así `armarRenglon` sigue siendo la misma función pura que ya estaba probada.
      const armado = armarRenglon({
        product_id: productId,
        sku,
        nombre: String(f['nombre'] ?? ''),
        venta_30d: numONull(f['venta_30d']),
        existencia: num(f['on_hand']),
        objetivo: numONull(f['target_qty']),
        falta: num(f['suggested_qty']),
        falta_base: num(f['suggested_qty_nat']),
        caja_factor: cf,
        costo_base: numONull(f['unit_cost']),
        rung_veredicto: f['rung_veredicto'] == null ? null : String(f['rung_veredicto']),
        posicion: String(f['bucket'] ?? ''),
        viene: viene.get(sku) ?? null,
        planeado_compras: planPorProducto.get(productId) ?? 0,
        pedido_sucursal: pedidoSucursal.get(productId) ?? 0,
        escalera: escaleras.get(sku) ?? null,
        ajuste: ajustes.get(productId) ?? null,
        surte: surteDe(f['replenish_via'], f['source_warehouse_code'], f['supplier_id'], f['supplier_name']),
        // `[AB.40]` El tope de 45 días se mide en unidad base, con lo que el motor ya trae.
        venta_30d_base: numONull(f['venta_30d_nat']),
        existencia_base: numONull(f['on_hand_nat']),
        // `[AB.40c]` Un solo costo: el de la caja que viaja a Compras (`enviar` manda este mismo).
        caja_cost: numONull(f['caja_cost']),
      });
      return { fila: f, cf, ...armado, linea: { ...armado.linea, linea: lineasProducto.get(sku) ?? null } };
    });
    return { renglones, docs, planDocs, reqDocs, sinUnidad, medidos, borrador, guardable, posiciones, aMano };
  }

  async pedido(almacen: Almacen, area: string, puedeAjustar = false): Promise<AutoabastoPedidoResponse> {
    const { renglones, docs, planDocs, reqDocs, sinUnidad, medidos, borrador, guardable, posiciones } = await this.armarAlmacen(almacen, area);
    const grupos = new Map<string, AutoabastoPedidoGrupo>();
    for (const { fila: f, cf, linea, efectivo_base: efectivoBase, efectivo_cantidad: efectivoCant } of renglones) {
      const aPedir = linea.a_pedir;

      const { tipo, clave, nombre } = linea.surte;
      const llave = `${tipo}:${clave ?? ''}`;
      let g = grupos.get(llave);
      if (!g) {
        g = {
          tipo,
          clave,
          nombre,
          lineas: [],
          renglones_a_pedir: 0,
          total_cajas: 0,
          renglones_sin_caja: 0,
          total_valor: null,
          sin_valuar: 0,
          minimo_cajas: tipo === 'proveedor' ? numONull(f['supplier_min_boxes']) : null,
          minimo_valor: tipo === 'proveedor' ? numONull(f['supplier_min_amount']) : null,
        };
        grupos.set(llave, g);
      }
      // `[AB.39]` La pantalla única también explica la posición (mínimo, reorden, máximo, entrega).
      g.lineas.push({ ...linea, diagnostico: diagnosticoDe(f) });
      // `[AB.29]` Lo que la sucursal ya mandó a Compras se ve, pero no suma como «a pedir».
      if (efectivoCant > 0 && !yaSeMandoACompras(linea)) {
        g.renglones_a_pedir++;
        // Cajas sólo de lo que tiene caja: lo pedido en cajas, o en la menor con un factor de caja
        // real en el almacén. Lo demás (piezas sin caja, kilos) se cuenta aparte, no se suma.
        if (aPedir.regla === 'cajas' || (aPedir.regla === 'nada' && cf > 1 && aPedir.factor === cf)) g.total_cajas += efectivoBase / cf;
        else if (aPedir.regla === 'menor' && cf > 1) g.total_cajas += efectivoBase / cf;
        else g.renglones_sin_caja++;
        if (linea.valor != null) g.total_valor = (g.total_valor ?? 0) + linea.valor;
        else g.sin_valuar++;
      }
    }

    const orden: Record<AutoabastoPedidoGrupo['tipo'], number> = { matriz: 0, proveedor: 1, sin_ruta: 2 };
    const lista = [...grupos.values()]
      .map((g) => ({
        ...g,
        total_cajas: r1(g.total_cajas),
        total_valor: g.total_valor == null ? null : r2(g.total_valor),
        // Primero lo que hay que pedir, por valor; lo cubierto por lo ya pedido queda abajo.
        lineas: g.lineas.sort((a, b) =>
          (b.a_pedir.cantidad > 0 ? 1 : 0) - (a.a_pedir.cantidad > 0 ? 1 : 0)
          || (b.valor ?? 0) - (a.valor ?? 0)
          || a.sku.localeCompare(b.sku)),
      }))
      .sort((a, b) => orden[a.tipo] - orden[b.tipo] || (b.total_valor ?? 0) - (a.total_valor ?? 0));

    const ahora = new Date();
    return {
      almacen,
      fecha_mx: toMxDateKey(ahora),
      hora_mx: new Intl.DateTimeFormat('es-MX', { timeZone: MX_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(ahora),
      cobertura_dias: coberturaAutoabasto(almacen.code),
      ventana_ya_pedido_dias: VENTANA_YA_PEDIDO_DIAS,
      ventana_negado_dias: VENTANA_NEGADO_DIAS,
      ventana_en_camino_dias: VENTANA_EN_CAMINO_DIAS,
      viene: medidos || planDocs.size || reqDocs.size ? {
        documentos: documentosViene(docs, planDocs, reqDocs),
        renglones_sin_unidad: sinUnidad,
      } : null,
      grupos: lista,
      pedidos_medidos: medidos,
      pedido_id: borrador,
      puede_ajustar: puedeAjustar,
      guardado_disponible: guardable,
      posiciones,
    };
  }

  /**
   * `[AB.44]` Sólo los documentos de «Lo que te va a llegar», para «Pendientes de la sucursal».
   *
   * Las mismas cuatro lecturas que `armarAlmacen` hace para `viene` (destino, planes de Compras,
   * requisiciones de la sucursal, documentos de Kepler) y el mismo mapeo (`documentosViene`), SIN el
   * motor: la mesa de Padre Hidalgo tarda 1.2–1.5 s (AB.36) y esta pantalla no lee ni un renglón.
   */
  async viene(almacen: Almacen): Promise<AutoabastoVieneDocsResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const binds = { t: tenantId, suc: almacen.code };
    return this.tk.run(async (trx: Knex.Transaction) => {
      const medidos = ((await trx.raw(TIENE_DESTINO_SQL, binds)).rows ?? []).length > 0;
      const marca = (await trx.raw(MARCA_SUCURSAL_SQL)).rows.length > 0;
      const planes = ((await trx.raw(planeadoComprasSql(marca), { t: tenantId, wh: almacen.id })).rows ?? []) as FilaPlan[];
      const deSucursal = marca
        ? ((await trx.raw(REQ_SUCURSAL_SQL, { t: tenantId, wh: almacen.id })).rows ?? []) as FilaReqSucursal[]
        : [];
      // Sin cliente de traspaso, lo de Kepler NO se mide (≠ «cero»), igual que en `armarAlmacen`.
      const docs = medidos ? ((await trx.raw(VIENE_DOCS_SQL, binds)).rows ?? []) as FilaDoc[] : [];
      return {
        almacen,
        documentos: documentosViene(docs, porDocumento(planes), porDocumento(deSucursal)),
        pedidos_medidos: medidos,
        ventana_en_camino_dias: VENTANA_EN_CAMINO_DIAS,
      };
    });
  }

  /**
   * `[AB.44]` Los almacenes de la persona con su llave canónica de sucursal (`branchKeySql`), que es con
   * la que filtra Entradas. Recibe la lista YA recortada al alcance (`motor.almacenes`): no la amplía.
   */
  async conLlaveDeSucursal(almacenes: Almacen[]): Promise<SucursalPendientesAlmacen[]> {
    if (!almacenes.length) return [];
    const tenantId = this.tenantCtx.requireTenantId();
    const llaves = await this.tk.run(async (trx: Knex.Transaction) => {
      const { rows } = await trx.raw(
        `SELECT w.id::text AS id, NULLIF(btrim(${branchKeySql('w')}), '') AS llave
           FROM commercial.warehouses w
          WHERE w.tenant_id = ? AND w.id = ANY(?::uuid[])`,
        [tenantId, almacenes.map((a) => a.id)],
      );
      return new Map((rows as Array<{ id: string; llave: string | null }>).map((r) => [r.id, r.llave]));
    });
    return almacenes.map((a) => ({ id: a.id, name: a.name, sucursal: llaves.get(a.id) ?? null }));
  }

  /**
   * `[AB.29]` «Enviar a Compras»: la sucursal manda lo que le falta por pedir y le llega a quien tiene
   * la responsabilidad `compras.requisiciones_sucursal` (hoy, la jefa de Compras), que la aprueba o la
   * rechaza con motivo en `/compras/requisiciones` (D15).
   *
   * ⛔ La pantalla manda QUÉ productos, nada más. La cantidad (el ajuste guardado o lo sugerido
   * redondeado), a quién se le pide (el canal) y el costo los pone el servidor con su propia cuenta
   * (`armarAlmacen`): un navegador no decide de dónde sale la mercancía ni cuánto vale.
   *
   * Sale una requisición por origen (su matriz o cada proveedor), en `pending_approval`, con base
   * `demanda`. Cantidades en CAJAS de la mesa — la misma caja que `display_bf` del plan (100 % de los
   * productos con venta, medido 2026-10-24) — y costo `caja_cost` del plan, el mismo que usan las
   * requisiciones de Compras y que revisa la aprobación (`[RQ.3]`). Lo que no se puede mandar se
   * devuelve en `omitidos` con su porqué (`motivoNoEnviable`), no se calla.
   */
  /**
   * `[AB.41]` Los productos de UN documento de «Lo que te va a llegar». Se piden al abrir el documento,
   * no con el pedido: 63 documentos de Padre Hidalgo con sus renglones harían más pesada la pantalla
   * entera para algo que se consulta de uno en uno.
   */
  async vieneRenglones(
    almacen: Almacen,
    doc: { tipo: 'pedido' | 'embarque'; origen: string; serie: number; folio: string } | { tipo: 'plan' | 'requisicion'; id: string },
  ): Promise<AutoabastoVieneRenglonesResponse> {
    const t = this.tenantCtx.requireTenantId();
    const suite = doc.tipo === 'plan' || doc.tipo === 'requisicion' ? doc : null;
    const kepler = doc.tipo === 'pedido' || doc.tipo === 'embarque' ? doc : null;
    const filas = await this.tk.run(async (trx: Knex.Transaction) => {
      if (suite || !kepler) {
        const r = await trx.raw(REQ_RENGLONES_SQL, { t, id: suite?.id ?? null, wh: almacen.id });
        return ((r.rows ?? []) as Array<{ sku: string; nombre: string | null; cantidad: string | number }>).map((f): AutoabastoVieneRenglon => ({
          sku: f.sku, nombre: f.nombre, cantidad: numONull(f.cantidad), unidad: 'cajas', cantidad_base: null, unidad_base: null,
        }));
      }
      const r = await trx.raw(VIENE_RENGLONES_SQL, {
        t, suc: almacen.code, doctype: kepler.tipo === 'pedido' ? 40 : 41, origen: kepler.origen, serie: kepler.serie, folio: kepler.folio,
      });
      return ((r.rows ?? []) as Array<Record<string, string | number | null>>).map((f): AutoabastoVieneRenglon => {
        const cantidad = numONull(f['cantidad']);
        return {
          sku: String(f['sku']), nombre: f['nombre'] == null ? null : String(f['nombre']),
          // Sin presentación capturada (3 % de los pedidos) se declara `null` y se lee la base.
          cantidad: cantidad != null && cantidad > 0 && f['unidad'] ? cantidad : null,
          unidad: cantidad != null && cantidad > 0 && f['unidad'] ? String(f['unidad']) : null,
          cantidad_base: numONull(f['cantidad_base']), unidad_base: f['unidad_base'] == null ? null : String(f['unidad_base']),
        };
      });
    });
    return { renglones: filas };
  }

  /**
   * `[PQ.139]` · D2 (Edgar, 2026-11-22) — **De qué almacén se pide.**
   *
   * El default no se teclea: sin `origen_code`, manda el que propone el motor, que es el almacén
   * principal de esa sucursal. Esto sólo corre cuando alguien eligió OTRO, y entonces el servidor
   * decide si ese otro sirve. La pantalla puede ofrecer la lista que quiera: la lista blanca vive
   * acá, porque un cliente no es un lugar donde poner un permiso.
   *
   * ⛔ Cada condición existe por lo que rompería, y el orden es el de lectura para quien eligió mal:
   *   · borrado o inexistente → no hay nada que pedir;
   *   · `active = false` → nadie opera ahí;
   *   · `kind = 'truck'` → un camión de ruta tiene existencia y hasta tope de reabasto, así que
   *     aparece en las listas del módulo; **no surte a una tienda**;
   *   · sin `kepler_code` → no hay servidor al que escribirle. Es el mismo freno que `pushToKepler`
   *     aplica después, adelantado a donde la persona todavía puede corregirlo (allá el pedido ya
   *     estaría escrito y sólo quedaría el motivo en `kepler_error`);
   *   · el mismo almacén → pedirse a sí mismo.
   *
   * ⚠️ Lo que **no** se valida, a propósito: si el origen tiene existencia. ADR-127 §4 lo midió —el
   * CEDIS surtió 1,123 SKU distintos en 30 días y sólo el 24.3 % tiene existencia hoy, porque es
   * cruce y no bodega—: una compuerta por existencia bloquearía tres cuartas partes de lo que de
   * verdad surte. La existencia se **muestra**, no frena.
   */
  private async origenElegido(tenantId: string, almacen: Almacen, code: string | null | undefined)
    : Promise<OrigenMano | null> {
    const pedido = String(code ?? '').trim();
    if (!pedido) return null;
    const w = await this.tk.run(async (trx: Knex.Transaction) => trx('commercial.warehouses')
      .where({ tenant_id: tenantId, code: pedido }).whereNull('deleted_at')
      .first('id', 'code', 'name', 'active', 'kind', 'kepler_code')) as
      { id: string; code: string; name: string; active: boolean | null; kind: string | null; kepler_code: string | null } | undefined;

    // `[AB.PM.4]` La regla vive en `fallaDeOrigen`: la misma que arma la lista de orígenes de la pantalla.
    const falla: OrigenNoValido | null = fallaDeOrigen(w, almacen.id);
    if (falla) {
      throw new BadRequestException(`No se puede pedir a «${pedido}»: ${ORIGEN_NO_VALIDO_MSG[falla]}.`);
    }
    // `[AB.PM.3]` Con su sucursal de Kepler: su ficha es la que el traspaso tiene que respetar (R8 d).
    return { id: w!.id, code: w!.code, name: w!.name, kepler_code: String(w!.kepler_code).trim() };
  }

  async enviar(almacen: Almacen, area: string, req: AutoabastoEnviarRequest): Promise<AutoabastoEnviarResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const ids = [...new Set((Array.isArray(req?.product_ids) ? req.product_ids : [])
      .filter((x): x is string => typeof x === 'string' && UUID_RX.test(x)))];
    if (!ids.length) throw new BadRequestException('Elige al menos un producto para mandar a Compras.');
    if (ids.length > 2000) throw new BadRequestException('Son demasiados productos para un solo envío (máximo 2,000).');
    const nota = String(req?.nota ?? '').trim().slice(0, 500);

    // `[PQ.139]` · D2 — de qué almacén se pide. Se valida ANTES de armar nada: si el origen no
    // sirve, no tiene sentido recalcular la mesa entera para después rechazar.
    const elegido = await this.origenElegido(tenantId, almacen, req?.origen_code);
    /**
     * El origen elegido manda sobre los renglones que van a OTRA SUCURSAL, y sólo sobre ésos: a un
     * proveedor se le pide donde se le pide. Fundir todos los de sucursal en uno es lo que Kepler
     * pide —un `U-D-40` sale de UNA sucursal— y lo que `insertRequisition` ya exige.
     */
    const surteEfectivo = (s: SurteRenglon): SurteRenglon => (elegido && s.tipo === 'matriz'
      ? { tipo: 'matriz', clave: elegido.code, nombre: elegido.name }
      : s);

    const { renglones, aMano } = await this.armarAlmacen(almacen, area);
    const porId = new Map(renglones.map((r) => [r.linea.product_id, r]));
    const omitidos: AutoabastoEnviarResponse['omitidos'] = [];
    const grupos = new Map<string, RenglonInterno[]>();
    for (const id of ids) {
      // `[AB.PM.3]` R1: lo pedido a mano sale con el pedido a mano, nunca dos veces.
      if (aMano.has(id)) { omitidos.push({ product_id: id, motivo: PEDIDO_A_MANO_ENVIO_MSG }); continue; }
      const r = porId.get(id);
      if (!r) { omitidos.push({ product_id: id, motivo: 'No le falta a esta sucursal' }); continue; }
      const porque = motivoNoEnviable(r.linea);
      if (porque) { omitidos.push({ product_id: id, motivo: porque }); continue; }
      const s = surteEfectivo(r.linea.surte);
      const llave = `${s.tipo}:${s.clave ?? ''}`;
      const g = grupos.get(llave);
      if (g) g.push(r); else grupos.set(llave, [r]);
    }
    if (!grupos.size) {
      throw new BadRequestException(`Ninguno de los productos se puede mandar a Compras: ${omitidos[0]?.motivo ?? 'no le faltan'}.`);
    }

    const matrices = [...grupos.values()].map((g) => surteEfectivo(g[0].linea.surte)).filter((s) => s.tipo === 'matriz').map((s) => String(s.clave));
    const { origenes, costos, leLlegaA } = await this.tk.run(async (trx: Knex.Transaction) => {
      const ws: Array<{ id: string; code: string }> = matrices.length
        ? await trx('commercial.warehouses').where({ tenant_id: tenantId }).whereIn('code', matrices).whereNull('deleted_at').select('id', 'code')
        : [];
      const cs: Array<{ product_id: string; caja_cost: string | number | null }> = await trx('analytics.replenishment_plan')
        .where({ tenant_id: tenantId, warehouse_id: almacen.id }).whereIn('product_id', ids).select('product_id', 'caja_cost');
      const quien: Array<{ nombre: string }> = (await trx.raw(LE_LLEGA_A_SQL, { t: tenantId })).rows ?? [];
      return {
        origenes: new Map(ws.map((w) => [w.code, w.id])),
        costos: new Map(cs.map((c) => [c.product_id, num(c.caja_cost)])),
        leLlegaA: quien.map((q) => q.nombre),
      };
    });

    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const dtos: CreateRequisitionDto[] = [];
    const surtes: SurteRenglon[] = [];
    for (const g of grupos.values()) {
      const s = surteEfectivo(g[0].linea.surte);
      const origenId = s.tipo === 'matriz' ? origenes.get(String(s.clave)) ?? null : null;
      if (s.tipo === 'matriz' && !origenId) {
        for (const r of g) omitidos.push({ product_id: r.linea.product_id, motivo: `No se encontró su matriz (${s.clave}) entre los almacenes` });
        continue;
      }
      const deMatriz = s.tipo === 'matriz';
      dtos.push({
        warehouse_id: almacen.id,
        source_type: deMatriz ? 'branch' : 'supplier',
        source_warehouse_id: origenId,
        supplier_id: deMatriz ? null : s.clave,
        target_basis: 'demanda',
        notes: `Pedida por la sucursal ${almacen.name} desde Autoabasto.${nota ? ` Nota: ${nota}` : ''}`,
        lines: g.map((r) => ({
          product_id: r.linea.product_id,
          supplier_id: deMatriz ? null : s.clave,
          source_type: deMatriz ? 'branch' : 'supplier',
          source_warehouse_id: origenId,
          on_hand: num(r.fila['on_hand']),
          in_transit: num(r.fila['in_transit']),
          min_stock: num(r.fila['min_stock']),
          reorder_point: num(r.fila['reorder_point']),
          max_stock: num(r.fila['max_stock']),
          suggested_qty: r3(r.linea.a_pedir.cantidad_base / r.cf),
          final_qty: r3(r.efectivo_base / r.cf),
          unit_cost: costos.get(r.linea.product_id) ?? 0,
        })),
      });
      surtes.push(s);
    }
    if (!dtos.length) throw new BadRequestException(`Ninguno de los productos se puede mandar a Compras: ${omitidos[0]?.motivo ?? ''}.`);

    const { creadas, ya_pedidos } = await this.motor.crearRequisicionesDeSucursal(almacen.id, dtos);
    for (const id of ya_pedidos) omitidos.push({ product_id: id, motivo: 'Ya lo pediste a Compras' });

    // `[PQ.138]` · ADR-127 — **El pedido a otra SUCURSAL no espera a Compras: sale al ERP acá
    // mismo.** La compra a proveedor sigue su camino de siempre (bandeja, aprobación, y su
    // `X-A-30` al aprobarla): compromete dinero con un tercero. El traspaso mueve mercancía propia
    // y hoy lo decide el almacenista capturándolo él mismo en Kepler.
    //
    // ⛔ Va DESPUÉS de que la requisición esté commiteada y FUERA de toda transacción: el ERP no
    // participa de nuestro rollback. Y no lanza — si el ERP no contesta, el pedido queda guardado
    // con su motivo y el reintento automático lo recoge.
    const aSucursal = creadas.filter((c) => surtes[c.indice]?.tipo === 'matriz').map((c) => c.id);
    const kepler = aSucursal.length
      ? await this.motor.soltarPedidoDeSucursal(aSucursal)
      : new Map<string, AutoabastoEnvioKepler>();

    const requisiciones = creadas.map((c) => {
      const k = kepler.get(c.id);
      return {
        id: c.id, folio: c.folio, surte: surtes[c.indice], renglones: c.renglones, total_cajas: r1(c.total_units),
        ...(k ? { kepler: k } : {}),
      };
    });

    // La huella del envío. `enviar` ya estaba en el CHECK de `evento` desde `[AB.18]`, esperando a
    // que alguien la escribiera: hasta hoy nadie lo hacía, porque este camino nunca corrió en prod
    // (medido 2026-11-22: cero requisiciones con `requested_by_branch`).
    //
    // ⚠️ **El borrador NO se cierra acá**, aunque `autoabasto_pedidos` tenga el estado `enviado`
    // para eso. El pedido se manda **parcial y varias veces al día** (`[DT8]`, medido: mediana de 7
    // renglones contra un sugerido de 1,244), así que cerrarlo en el primer envío borraría los
    // ajustes de todo lo que la persona todavía no mandó. El borrador es el escritorio del
    // almacén, no el documento.
    await this.tk.run(async (trx: Knex.Transaction) => {
      const pedidoId = await this.borradorDe(trx, tenantId, almacen.id);
      await this.huella(trx, {
        tenant_id: tenantId, warehouse_id: almacen.id, pedido_id: pedidoId, evento: 'enviar',
        datos: JSON.stringify({
          productos: ids.length,
          omitidos: omitidos.length,
          requisiciones: requisiciones.map((r) => ({
            folio: r.folio,
            surte: `${r.surte.tipo}:${r.surte.clave ?? ''}`,
            renglones: r.renglones,
            kepler: r.kepler?.estado ?? null,
            kepler_folio: r.kepler && 'folio' in r.kepler ? r.kepler.folio : null,
            kepler_motivo: r.kepler && 'motivo' in r.kepler ? r.kepler.motivo : null,
          })),
        }),
      });
    }).catch((e: unknown) => {
      // La huella no decide si el pedido salió: si falla, se dice y se sigue.
      this.logger.warn(`[PQ.138] Pedido de ${almacen.code} enviado pero sin huella: ${(e as Error)?.message}`);
    });

    return { requisiciones, omitidos, le_llega_a: leLlegaA };
  }

  /**
   * `[AB.27]` La mesa de UN almacén sobre la cuenta única: cada renglón es el de «Mi pedido» más lo
   * que sólo la mesa muestra (mínimo, reorden, máximo, entrega). El resumen es del almacén entero y se
   * suma con la misma regla que los grupos de «Mi pedido»; el filtro sólo recorta la lista.
   *
   * ⚠️ Cuesta lo mismo que «Mi pedido» (3.7 s medidos el 2026-10-12 en AB.16, sin re-medir): arma el
   * almacén entero en cada llamada y pagina después. Bajarlo es un commit aparte (regla: optimizar no
   * va junto con cambiar la cuenta).
   */
  async renglones(
    almacen: Almacen, area: string,
    q: FiltroMesa & { sort_by?: OrdenMesa; sort_dir?: 'asc' | 'desc'; page?: number; pageSize?: number; todos?: boolean },
  ): Promise<AutoabastoRenglonesResponse> {
    const { renglones, medidos } = await this.armarAlmacen(almacen, area);
    const todos: AutoabastoMesaRenglon[] = renglones.map(({ fila: f, linea }) => ({ ...linea, diagnostico: diagnosticoDe(f) }));
    const lista = ordenarRenglones(filtrarRenglones(todos, q), q.sort_by ?? 'lectura', q.sort_dir ?? 'desc');
    // `todos` = el papel: el almacén completo con el filtro, sin paginar (ya se armó entero de todos modos).
    const pageSize = q.todos ? Math.max(1, lista.length) : Math.min(500, Math.max(1, Math.floor(Number(q.pageSize) || 50)));
    const page = q.todos ? 1 : Math.max(1, Math.floor(Number(q.page) || 1));
    const ahora = new Date();
    return {
      almacen,
      fecha_mx: toMxDateKey(ahora),
      hora_mx: new Intl.DateTimeFormat('es-MX', { timeZone: MX_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(ahora),
      cobertura_dias: coberturaAutoabasto(almacen.code),
      pedidos_medidos: medidos,
      total: lista.length,
      page,
      pageSize,
      resumen: resumirRenglones(todos),
      renglones: lista.slice((page - 1) * pageSize, page * pageSize),
    };
  }

  /**
   * `[AB.19]` Hasta dónde pide el almacenista (agotado, bajo mínimo, bajo reorden, otros). Se
   * guarda en el borrador y deja huella con lo que había antes: elegir sólo lo agotado es una
   * decisión que el aprendizaje tiene que ver, no un filtro de pantalla.
   */
  async guardarPosiciones(warehouseId: string, req: AutoabastoPosicionesRequest): Promise<{ posiciones: PosicionPedido[] }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const posiciones = normalizarPosiciones(req.posiciones);
    return this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeBorrador(trx);
      const pedidoId = await this.borradorOCrea(trx, tenantId, warehouseId);
      const previo = await trx('commercial.autoabasto_pedidos').where({ tenant_id: tenantId, id: pedidoId }).first('posiciones');
      await trx('commercial.autoabasto_pedidos')
        .where({ tenant_id: tenantId, id: pedidoId })
        .update({ posiciones: trx.raw('?::text[]', [posiciones]), updated_at: trx.fn.now() });
      await this.huella(trx, {
        tenant_id: tenantId, warehouse_id: warehouseId, pedido_id: pedidoId, evento: 'posiciones',
        datos: JSON.stringify({ antes: normalizarPosiciones(previo?.posiciones), despues: posiciones }),
      });
      return { posiciones };
    });
  }

  /** Escalera de unidades de Kepler, sólo de los productos de la mesa (`[AB.36]` `leerEscaleras`). */
  private escalerasDe(skus: string[]): Promise<Map<string, EscaleraUnidades>> {
    if (!skus.length) return Promise.resolve(new Map());
    return this.tk.run((trx: Knex.Transaction) => leerEscaleras(trx, skus));
  }

  /**
   * `[AB.NI.1]` La **línea** (el fabricante) de cada SKU, de `analytics.v_erp_product_lines` (PQ.144).
   * Es el segundo nivel con que se arma el pedido: unidad → línea → alfabético.
   *
   * ⛔ **Derive-no-copy**: la vista sale del ODS, no hay tabla ni importer. Y es **tolerante**: si la
   * vista todavía no existe en esta base (migración sin aplicar), devuelve un mapa vacío en vez de
   * reventar — el pedido se sirve igual y los renglones caen en «(sin línea)». Un pedido que no se
   * puede abrir es peor que un pedido sin agrupar.
   *
   * Medido el 2026-11-23 en `RQ-2026-03239`: 102 líneas para 294 renglones, la más grande de 12.
   */
  private async lineasDe(tenantId: string, sucCode: string, skus: string[]): Promise<Map<string, string>> {
    const fuera = new Map<string, string>();
    if (!skus.length) return fuera;
    try {
      const filas: Array<{ sku: string; linea: string | null }> = await this.tk.run((trx: Knex.Transaction) =>
        trx('analytics.v_erp_product_lines')
          .where({ tenant_id: tenantId, suc_code: sucCode })
          .whereIn('sku', skus)
          .select('sku', 'linea'),
      );
      for (const f of filas) {
        const v = typeof f.linea === 'string' ? f.linea.trim() : '';
        if (v) fuera.set(String(f.sku), v);
      }
    } catch (e: unknown) {
      // Se DECLARA en el log y se sigue: sin línea el pedido se agrupa en «(sin línea)», no se cae.
      this.logger.warn(`[AB.NI.1] no se pudo leer la línea del producto: ${String((e as { message?: string })?.message ?? e).slice(0, 200)}`);
    }
    return fuera;
  }

  // ── [AB.18] Ajustes del almacenista y su huella ─────────────────────────────────────────────

  /**
   * ¿Se puede guardar el borrador en esta base? Hacen falta DOS cosas: que la tabla exista
   * (`[AB.18]` se migra antes que el código) y que la conexión pueda escribir. La segunda se
   * agregó al probar contra prod con un usuario de sólo lectura (2026-10-13): la tabla existía, la
   * pantalla creía que podía guardar y cada casilla terminaba en un 500 que parecía una falla.
   */
  private async borradorDisponible(trx: Knex.Transaction): Promise<boolean> {
    const r = await trx.raw(
      `SELECT to_regclass('commercial.autoabasto_pedidos') IS NOT NULL
              AND current_setting('transaction_read_only') = 'off' AS ok`);
    return Boolean(r.rows?.[0]?.ok);
  }

  /** Antes de escribir: sin tablas o en una base de sólo lectura, un mensaje que se entiende en vez de un 500. */
  private async exigeBorrador(trx: Knex.Transaction): Promise<void> {
    if (!(await this.borradorDisponible(trx))) {
      throw new ServiceUnavailableException(
        'Esta base no permite guardar el pedido: le falta su migración o la conexión es de sólo lectura.');
    }
  }

  /** El borrador vivo del almacén, o `null`. Un solo borrador por almacén (índice único parcial). */
  private async borradorDe(trx: Knex.Transaction, tenantId: string, warehouseId: string): Promise<string | null> {
    const r = await trx('commercial.autoabasto_pedidos')
      .where({ tenant_id: tenantId, warehouse_id: warehouseId, estado: 'borrador' })
      .first('id');
    return r ? String(r.id) : null;
  }

  /** El borrador vivo, creándolo si no existe. Dos clics simultáneos no crean dos: ON CONFLICT. */
  private async borradorOCrea(trx: Knex.Transaction, tenantId: string, warehouseId: string): Promise<string> {
    const actual = await this.borradorDe(trx, tenantId, warehouseId);
    if (actual) return actual;
    const ctx = this.tenantCtx.get();
    await trx.raw(
      // `[AB.39]` Las posiciones van EXPLÍCITAS: el default de la columna en la base trae también
      // «bajo reorden», y el borrador nacería distinto de lo que la persona veía marcado al ajustar.
      `INSERT INTO commercial.autoabasto_pedidos (tenant_id, warehouse_id, motor, abierto_por, abierto_por_username, posiciones)
       VALUES (?, ?, ?::jsonb, ?, ?, ?::text[])
       ON CONFLICT (tenant_id, warehouse_id) WHERE estado = 'borrador' DO NOTHING`,
      [tenantId, warehouseId, JSON.stringify({ base: 'demanda', cobertura_por_almacen: COBERTURA_AUTOABASTO, cobertura_default: COBERTURA_AUTOABASTO_DEFAULT,
        ventana_ya_pedido_dias: VENTANA_YA_PEDIDO_DIAS, ventana_negado_dias: VENTANA_NEGADO_DIAS }),
      ctx?.userId ?? null, ctx?.username ?? null, [...POSICIONES_PEDIDO_DEFAULT]]);
    const creado = await this.borradorDe(trx, tenantId, warehouseId);
    if (!creado) throw new Error('No se pudo abrir el borrador del pedido.');
    return creado;
  }

  private async huella(trx: Knex.Transaction, fila: Record<string, unknown>): Promise<void> {
    const ctx = this.tenantCtx.get();
    await trx('commercial.autoabasto_huella').insert({
      ...fila,
      user_id: ctx?.userId ?? null,
      username: ctx?.username ?? null,
    });
  }

  /**
   * Guarda lo que la persona dejó en un renglón. La foto (sugerido, unidad, factor, contexto) viene
   * de la pantalla: es lo que la persona VIO, que es justo lo que la huella necesita, y evita
   * recalcular el pedido entero en cada clic. Se validan los números y el motivo (±20%).
   */
  async ajustar(warehouseId: string, req: AutoabastoAjusteRequest): Promise<AutoabastoAjusteResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const cantidad = Number(req.cantidad), sugerido = Number(req.sugerido), factor = Number(req.factor);
    if (!Number.isFinite(cantidad) || cantidad < 0 || !Number.isInteger(cantidad)) {
      throw new BadRequestException('La cantidad tiene que ser un entero de 0 en adelante.');
    }
    if (!Number.isFinite(sugerido) || sugerido < 0) throw new BadRequestException('Falta el sugerido que se vio.');
    if (!Number.isFinite(factor) || factor <= 0) throw new BadRequestException('El renglón no trae factor de unidad: no se puede ajustar.');
    if (!['matriz', 'proveedor', 'sin_ruta'].includes(req.origen_tipo)) throw new BadRequestException('Origen inválido.');
    const motivo = req.motivo ?? null;
    if (motivo != null && !(MOTIVOS_AJUSTE as readonly string[]).includes(motivo)) throw new BadRequestException('Motivo fuera de la lista.');
    if (necesitaMotivo(sugerido, cantidad) && !motivo) {
      throw new BadRequestException('El ajuste se aleja más de 20% de lo sugerido: elige un motivo.');
    }
    const ms = req.ms_en_renglon == null ? null : Math.max(0, Math.round(Number(req.ms_en_renglon) || 0));
    const ctx = this.tenantCtx.get();

    return this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeBorrador(trx);
      const pedidoId = await this.borradorOCrea(trx, tenantId, warehouseId);
      const previo = await trx('commercial.autoabasto_pedido_lineas')
        .where({ tenant_id: tenantId, pedido_id: pedidoId, product_id: req.product_id }).first('cantidad');
      const antes = previo ? num(previo.cantidad) : sugerido;
      const ahora = new Date();
      // `[AB.PM.1]` El renglón nuevo nace `captura = 'motor'` por el DEFAULT de la columna. Y si el
      // producto ya está en el borrador PEDIDO A MANO, el ajuste del sugerido NO lo pisa (el `WHERE`
      // del `DO UPDATE`): un producto vive una sola vez en el borrador (R1), y lo de a mano se cambia
      // en el pedido a mano. Sin fila devuelta = no se escribió nada, y se dice.
      const escrito = await trx.raw(
        `INSERT INTO commercial.autoabasto_pedido_lineas
           (tenant_id, pedido_id, product_id, sku, origen_tipo, origen_clave, sugerido, sugerido_unidad, sugerido_base,
            cantidad, unidad, cantidad_base, motivo, contexto, ajustado_por, ajustado_por_username, ajustado_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?,?)
         ON CONFLICT (tenant_id, pedido_id, product_id) DO UPDATE SET
           sugerido = EXCLUDED.sugerido, sugerido_unidad = EXCLUDED.sugerido_unidad, sugerido_base = EXCLUDED.sugerido_base,
           cantidad = EXCLUDED.cantidad, unidad = EXCLUDED.unidad, cantidad_base = EXCLUDED.cantidad_base,
           motivo = EXCLUDED.motivo, contexto = EXCLUDED.contexto, ajustado_por = EXCLUDED.ajustado_por,
           ajustado_por_username = EXCLUDED.ajustado_por_username, ajustado_at = EXCLUDED.ajustado_at, updated_at = now()
         WHERE commercial.autoabasto_pedido_lineas.captura = 'motor'
         RETURNING id`,
        [tenantId, pedidoId, req.product_id, req.sku ?? null, req.origen_tipo, req.origen_clave ?? null,
          sugerido, req.unidad ?? null, sugerido * factor, cantidad, req.unidad ?? null, cantidad * factor,
          motivo, JSON.stringify(req.contexto ?? {}), ctx?.userId ?? null, ctx?.username ?? null, ahora]);
      if (!(escrito.rows ?? []).length) throw new BadRequestException(PEDIDO_A_MANO_MSG);
      await this.huella(trx, {
        tenant_id: tenantId, warehouse_id: warehouseId, pedido_id: pedidoId, product_id: req.product_id,
        evento: 'ajustar', sugerido, antes, despues: cantidad, unidad: req.unidad ?? null, motivo, ms_en_renglon: ms,
        datos: JSON.stringify({ origen_tipo: req.origen_tipo, origen_clave: req.origen_clave ?? null, factor }),
      });
      return {
        pedido_id: pedidoId,
        product_id: req.product_id,
        ajuste: { cantidad, unidad: req.unidad ?? null, motivo, ajustado_por: ctx?.username ?? null, ajustado_at: ahora.toISOString() },
      };
    });
  }

  /** Vuelve el renglón al sugerido: borra el ajuste y deja la huella. */
  async restablecer(warehouseId: string, req: AutoabastoRestablecerRequest): Promise<AutoabastoAjusteResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeBorrador(trx);
      const pedidoId = await this.borradorDe(trx, tenantId, warehouseId);
      if (!pedidoId) throw new BadRequestException('No hay ajustes que restablecer.');
      // `[AB.PM.1]` Restablecer vuelve al SUGERIDO: sólo alcanza un renglón del motor. Borrar y leer lo
      // borrado es UNA sentencia, así que nada se cuela entre leer y borrar. Si no borró nada y el
      // producto está pedido a mano, se dice: un renglón a mano no tiene sugerido al que volver.
      const [previo] = await trx('commercial.autoabasto_pedido_lineas')
        .where({ tenant_id: tenantId, pedido_id: pedidoId, product_id: req.product_id, captura: 'motor' })
        .delete(['cantidad', 'sugerido', 'unidad']);
      if (!previo) {
        const aMano = await trx('commercial.autoabasto_pedido_lineas')
          .where({ tenant_id: tenantId, pedido_id: pedidoId, product_id: req.product_id, captura: 'mano' }).first('id');
        if (aMano) throw new BadRequestException(PEDIDO_A_MANO_MSG);
      }
      if (previo) {
        await this.huella(trx, {
          tenant_id: tenantId, warehouse_id: warehouseId, pedido_id: pedidoId, product_id: req.product_id,
          evento: 'restablecer', sugerido: previo.sugerido, antes: previo.cantidad, despues: previo.sugerido,
          unidad: previo.unidad, ms_en_renglon: req.ms_en_renglon == null ? null : Math.max(0, Math.round(Number(req.ms_en_renglon) || 0)),
        });
      }
      return { pedido_id: pedidoId, product_id: req.product_id, ajuste: null };
    });
  }

  /** La persona revisó un grupo y lo acepta como está. Sólo huella: no cambia cantidades. */
  async aceptarGrupo(warehouseId: string, req: AutoabastoAceptarGrupoRequest): Promise<{ ok: true }> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!['matriz', 'proveedor', 'sin_ruta'].includes(req.origen_tipo)) throw new BadRequestException('Origen inválido.');
    await this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeBorrador(trx);
      const pedidoId = await this.borradorOCrea(trx, tenantId, warehouseId);
      await this.huella(trx, {
        tenant_id: tenantId, warehouse_id: warehouseId, pedido_id: pedidoId, evento: 'aceptar_grupo',
        datos: JSON.stringify({ origen_tipo: req.origen_tipo, origen_clave: req.origen_clave ?? null, renglones: Math.max(0, Number(req.renglones) || 0) }),
      });
    });
    return { ok: true };
  }

  /** La persona abrió su pedido. Huella de cuándo y cuánto tenía enfrente; no crea borrador. */
  async abrir(warehouseId: string, req: AutoabastoAbrirRequest): Promise<{ ok: true }> {
    const tenantId = this.tenantCtx.requireTenantId();
    await this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeBorrador(trx);
      const pedidoId = await this.borradorDe(trx, tenantId, warehouseId);
      await this.huella(trx, {
        tenant_id: tenantId, warehouse_id: warehouseId, pedido_id: pedidoId, evento: 'abrir',
        datos: JSON.stringify({ renglones: Math.max(0, Number(req.renglones) || 0) }),
      });
    });
    return { ok: true };
  }

  // ── [AB.PM.3] El pedido a mano ──────────────────────────────────────────────────────────────
  //
  // Lo que la sucursal pide aunque el motor no lo sugiera, a la sucursal que ella elige (anexo PM del
  // 2026-11-26). Vive en el MISMO borrador que los ajustes del sugerido, marcado `captura = 'mano'`
  // (`[AB.PM.1]`), y sale por el MISMO escritor (`crearRequisicionesDeSucursal` + `soltarPedidoDeSucursal`,
  // ADR-127). Nada de esto calcula otra cuenta: el alcance es `alcanceDelRenglon`, la propuesta
  // `propuestaDelRenglon`, la partición `partirCaptura` y lo que Kepler rechazaría `rechazoDelTraspaso`.

  /**
   * Los números de los productos para pedirlos a mano, de las MISMAS fuentes que la mesa:
   *  · existencia y venta de 30 días: `analytics.replenishment_plan` (`stock_pz` es la existencia de la
   *    mesa con base 'demanda'; la venta, `venta30dBaseSql`, es el ritmo del tope de 45 días);
   *  · lo que ya viene: `sumarYaPedido` sobre los pedidos abiertos y lo embarcado sin recibir (R2);
   *  · la escalera (`leerEscaleras`) y el factor de caja del almacén que pide (`mv_warehouse_box_factor`,
   *    el mismo que `pushToKepler` le pasa al sink);
   *  · de cada origen: su existencia (su plan) y la ficha de su Kepler (`v_kepler_unit_ladder`).
   * ⚠️ `v_kepler_unit_ladder` se lee sola, por `sucursal` y `sku = ANY`: unida a otra consulta tardaba
   * de más (medido el 2026-11-26).
   */
  protected async medidasMano(
    trx: Knex.Transaction, tenantId: string, almacen: Almacen,
    productos: ReadonlyArray<{ id: string; sku: string }>, origenes: ReadonlyArray<OrigenMano>,
  ): Promise<{ porProducto: Map<string, MedidasProducto>; vieneMedido: boolean }> {
    const porProducto = new Map<string, MedidasProducto>();
    const binds = { t: tenantId, suc: almacen.code };
    const vieneMedido = ((await trx.raw(TIENE_DESTINO_SQL, binds)).rows ?? []).length > 0;
    if (!productos.length) return { porProducto, vieneMedido };
    const ids = [...new Set(productos.map((p) => p.id))];
    const skus = [...new Set(productos.map((p) => p.sku))];
    const plan = ((await trx.raw(
      `SELECT rpl.warehouse_id, rpl.product_id, rpl.stock_pz, ${venta30dBaseSql('rpl')} AS venta_30d, rpl.rung_veredicto, rpl.caja_cost
         FROM analytics.replenishment_plan rpl
        WHERE rpl.tenant_id = ? AND rpl.warehouse_id = ANY(?::uuid[]) AND rpl.product_id = ANY(?::uuid[])`,
      [tenantId, [almacen.id, ...origenes.map((o) => o.id)], ids])).rows ?? []) as Array<{
        warehouse_id: string; product_id: string; stock_pz: unknown; venta_30d: unknown; rung_veredicto: unknown; caja_cost: unknown }>;
    const bfSrc = (await trx.raw("SELECT to_regclass('analytics.mv_warehouse_box_factor') AS a")).rows?.[0]?.a
      ? 'analytics.mv_warehouse_box_factor' : 'analytics.v_warehouse_box_factor';
    const bfs = (await trx(bfSrc).where({ tenant_id: tenantId, warehouse_id: almacen.id }).whereIn('product_id', ids)
      .select('product_id', 'box_factor')) as Array<{ product_id: string; box_factor: unknown }>;
    const escaleras = await leerEscaleras(trx, skus);
    const sucursales = [...new Set(origenes.map((o) => o.kepler_code).filter(Boolean))];
    const fichas = (sucursales.length
      ? (await trx.raw(
        `SELECT btrim(sucursal) AS sucursal, btrim(sku) AS sku, u1_label, factor_caja
           FROM analytics.v_kepler_unit_ladder WHERE sucursal = ANY(?::text[]) AND sku = ANY(?::text[])`,
        [sucursales, skus])).rows ?? []
      : []) as Array<{ sucursal: string; sku: string; u1_label: string | null; factor_caja: unknown }>;
    let viene = new Map<string, VieneBase>();
    if (vieneMedido) {
      const pedidos = ((await trx.raw(PEDIDOS_SUCURSAL_SQL, binds)).rows ?? []) as FilaPedidos[];
      const enCamino = ((await trx.raw(EMBARCADO_SIN_RECIBIR_SQL, binds)).rows ?? []) as FilaEnCamino[];
      viene = sumarYaPedido(pedidos, enCamino, escaleras, new Set(skus)).viene;
    }

    const planDe = new Map(plan.map((p) => [`${p.warehouse_id}|${p.product_id}`, p]));
    const bfDe = new Map(bfs.map((b) => [b.product_id, numONull(b.box_factor)]));
    const fichaDe = new Map<string, { unidad_base: string | null; factor: number | null }>();
    for (const f of fichas) {
      const k = `${f.sucursal}|${f.sku}`;
      if (!fichaDe.has(k)) fichaDe.set(k, { unidad_base: String(f.u1_label ?? '').trim().toUpperCase() || null, factor: numONull(f.factor_caja) });
    }
    for (const p of productos) {
      const propio = planDe.get(`${almacen.id}|${p.id}`);
      const v = viene.get(p.sku);
      const origen: MedidasProducto['origen'] = new Map();
      for (const o of origenes) {
        const op = planDe.get(`${o.id}|${p.id}`);
        origen.set(o.id, { existencia: op ? numONull(op.stock_pz) : null, ficha: fichaDe.get(`${o.kepler_code}|${p.sku}`) ?? null });
      }
      porProducto.set(p.id, {
        sku: p.sku,
        escalera: escaleras.get(p.sku) ?? null,
        // Como la mesa (`COALESCE(rpl.stock_pz, 0)`): en el plan sin existencia es cero; fuera del plan, no medido.
        existencia: propio ? num(propio.stock_pz) : null,
        venta30: propio ? numONull(propio.venta_30d) : null,
        noConfiable: propio ? propio.rung_veredicto != null : false,
        // Lo que viene se resta como en la mesa: lo pedido abierto de 7 días y lo embarcado sin recibir.
        viene: vieneMedido ? (v ? v.ya + v.camino : 0) : null,
        bf: bfDe.get(p.id) ?? null,
        cajaCost: propio ? numONull(propio.caja_cost) : null,
        origen,
      });
    }
    return { porProducto, vieneMedido };
  }

  /**
   * `[AB.PM.4]` `GET pedido/mano/origenes` — a quién se le puede pedir: todos los almacenes que pasan
   * `fallaDeOrigen` (la regla de `origenElegido`), por nombre. La pantalla no ofrece lo que el servidor
   * rechazaría después.
   */
  async origenesMano(almacen: Almacen): Promise<AutoabastoManoOrigenesResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const ws = (await this.tk.run((trx: Knex.Transaction) => trx('commercial.warehouses')
      .where({ tenant_id: tenantId }).whereNull('deleted_at')
      .select('id', 'code', 'name', 'active', 'kind', 'kepler_code'))) as Array<{
        id: string; code: string; name: string; active: boolean | null; kind: string | null; kepler_code: string | null }>;
    return {
      origenes: ws.filter((w) => !fallaDeOrigen(w, almacen.id))
        .map((w) => ({ code: w.code, name: w.name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es')),
    };
  }

  /** La sucursal de Kepler del almacén que pide. Sin ella el traspaso no tiene destino (`pushToKepler` lo frena). */
  private async sucursalKepler(trx: Knex.Transaction, tenantId: string, almacen: Almacen): Promise<string> {
    const w = await trx('commercial.warehouses').where({ tenant_id: tenantId, id: almacen.id }).first('kepler_code');
    const k = String(w?.kepler_code ?? '').trim();
    if (!k) throw new BadRequestException(`El almacén ${almacen.code} no tiene sucursal de Kepler: no se le puede escribir un pedido.`);
    return k;
  }

  /**
   * `GET pedido/mano/buscar` — el buscador de Cotizaciones (`consultaBuscadorCatalogo`: palabras en
   * cualquier orden, código de barras, lo más vendido sin teclear) sobre el catálogo de la sucursal que
   * pide, SIN precios (en un traspaso no deciden: la consulta de afuera sólo toma código, nombre e id),
   * con los números de cada producto. Lo que ya va en el sugerido no se pregunta aquí: la mesa ya lo
   * tiene en la pantalla (`/pedido`).
   *
   * Con los artículos de precio simbólico, como Cotizaciones (`[COT.27]`): también se traspasan. Medido el
   * 2026-11-26: de los 1,193 SKU que Morelia Madero pidió a Morelia Abastos en 30 días, la vista de
   * etiquetas sola encuentra 1,187; con ellos, los 1,193 (el 09049, «2 BLS MONTES = GRATIS 1 VITROLERO»).
   */
  async buscarMano(almacen: Almacen, q: string | null | undefined, origenCode?: string | null, limit = 20): Promise<AutoabastoManoBuscarResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const term = String(q ?? '').trim().slice(0, 80);
    const n = Math.min(Math.max(Math.trunc(Number(limit) || 20), 1), 30);
    const origen = String(origenCode ?? '').trim() ? await this.origenElegido(tenantId, almacen, origenCode) : null;
    return this.tk.run(async (trx: Knex.Transaction) => {
      const suc = await this.sucursalKepler(trx, tenantId, almacen);
      const inner = consultaBuscadorCatalogo(trx, suc, term, n, { incluirPrecioSimbolico: true });
      const encontrados = ((await trx.raw(
        `SELECT v.sku, v.name, p.id AS product_id
           FROM :inner v
           JOIN catalog.products p ON p.tenant_id = :t AND p.sku = v.sku AND p.deleted_at IS NULL
          ORDER BY ${ORDEN_BUSCADOR_CATALOGO}`,
        { inner, term, pre: `${term}%`, t: tenantId })).rows ?? []) as Array<{ sku: string; name: string | null; product_id: string }>;
      const { porProducto, vieneMedido } = await this.medidasMano(
        trx, tenantId, almacen, encontrados.map((e) => ({ id: e.product_id, sku: e.sku })), origen ? [origen] : []);
      const productos = encontrados.map((e): AutoabastoManoProducto => {
        const m = porProducto.get(e.product_id);
        const propuesta = propuestaDelRenglon({ ...entradaAlcance(m, almacen.code), escalera: m?.escalera ?? null });
        return {
          product_id: e.product_id, sku: e.sku, nombre: e.name ?? '',
          ...medidasDe(m, origen?.id ?? null, almacen.code),
          propuesta: propuesta ? { cantidad: propuesta.cantidad, unidad: String(propuesta.unidad), cantidad_base: propuesta.cantidad_base } : null,
          kepler: origen ? rechazoDelTraspaso({ sku: e.sku, piezasPorCaja: m?.bf, ficha: m?.origen.get(origen.id)?.ficha }) : null,
        };
      });
      return { origen: origen ? { code: origen.code, name: origen.name } : null, productos, viene_medido: vieneMedido };
    });
  }

  /** Los renglones a mano del borrador (todos, o sólo los de `productIds`), con el producto. */
  private filasMano(trx: Knex.Transaction, tenantId: string, pedidoId: string, productIds?: string[]): Promise<FilaMano[]> {
    const q = trx('commercial.autoabasto_pedido_lineas as l')
      .leftJoin('catalog.products as p', (j) => j.on('p.tenant_id', 'l.tenant_id').andOn('p.id', 'l.product_id'))
      .where({ 'l.tenant_id': tenantId, 'l.pedido_id': pedidoId, 'l.captura': 'mano' })
      .select('l.product_id', trx.raw('COALESCE(p.sku, l.sku) AS sku'), 'p.nombre', 'l.origen_tipo', 'l.origen_clave',
        'l.cantidad', 'l.unidad', 'l.cantidad_base', 'l.ajustado_por_username', 'l.ajustado_at')
      .orderBy('l.ajustado_at', 'desc');
    if (productIds) q.whereIn('l.product_id', productIds);
    return q as unknown as Promise<FilaMano[]>;
  }

  /** Lee lo pedido a mano y lo arma con sus números de hoy: lo comparten la lista y el envío. */
  private async leerMano(trx: Knex.Transaction, tenantId: string, almacen: Almacen, pedidoId: string | null) {
    const filas = pedidoId ? await this.filasMano(trx, tenantId, pedidoId) : [];
    const codes = [...new Set(filas.filter((f) => f.origen_tipo === 'matriz' && f.origen_clave).map((f) => String(f.origen_clave).trim()))];
    const ws = (codes.length
      ? await trx('commercial.warehouses').where({ tenant_id: tenantId }).whereIn('code', codes).whereNull('deleted_at')
        .select('id', 'code', 'name', 'kepler_code')
      : []) as Array<{ id: string; code: string; name: string; kepler_code: string | null }>;
    const origenes = new Map<string, OrigenMano>(ws.map((w) => [w.code, { id: w.id, code: w.code, name: w.name, kepler_code: String(w.kepler_code ?? '').trim() }]));
    const { porProducto, vieneMedido } = await this.medidasMano(
      trx, tenantId, almacen, filas.filter((f) => f.sku).map((f) => ({ id: f.product_id, sku: String(f.sku) })), [...origenes.values()]);
    const renglones = filas.map((f) => renglonMano(f, porProducto.get(f.product_id), origenes, almacen.code));
    return { renglones, porProducto, vieneMedido, filas };
  }

  /** `GET pedido/mano` — lo pedido a mano, con su alcance y lo que Kepler rechazaría, partido como se va a mandar. */
  async pedidoAMano(almacen: Almacen): Promise<AutoabastoManoResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx: Knex.Transaction) => {
      const hayTabla = (await trx.raw(`SELECT to_regclass('commercial.autoabasto_pedidos') IS NOT NULL AS ok`)).rows?.[0]?.ok;
      const pedidoId = hayTabla ? await this.borradorDe(trx, tenantId, almacen.id) : null;
      const { renglones, vieneMedido } = await this.leerMano(trx, tenantId, almacen, pedidoId);
      const { grupos } = partirCaptura(renglones.map((r) => ({ product_id: r.product_id, destino: r.destino, cantidad_base: r.cantidad_base })), almacen.code);
      return { pedido_id: pedidoId, renglones, grupos, viene_medido: vieneMedido };
    });
  }

  /**
   * `PUT pedido/mano` — guarda (o cambia) un renglón a mano. La pantalla manda QUÉ, A QUIÉN, CUÁNTO y
   * EN QUÉ UNIDAD; el factor lo pone la escalera (R8 a) y el origen lo valida `origenElegido` (R6).
   * Si el producto tenía un ajuste del sugerido, lo REEMPLAZA (R1: un producto vive una vez).
   * Lo que Kepler rechazaría NO impide guardarlo: el renglón lo dice y no entra al envío (R8 d).
   */
  async guardarMano(almacen: Almacen, req: AutoabastoManoGuardarRequest): Promise<{ pedido_id: string; renglon: AutoabastoManoRenglon }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const cantidad = Number(req?.cantidad);
    if (!Number.isInteger(cantidad) || cantidad < 1) throw new BadRequestException('La cantidad tiene que ser un número entero de 1 en adelante.');
    const unidadPedida = String(req?.unidad ?? '').trim();
    if (!unidadPedida) throw new BadRequestException('Falta la unidad en que lo pides.');
    // R6 / R7: a una sucursal que sirve de origen, o a Compras.
    const origen = String(req?.origen_code ?? '').trim() ? await this.origenElegido(tenantId, almacen, req.origen_code) : null;
    const ms = req?.ms_en_renglon == null ? null : Math.max(0, Math.round(Number(req.ms_en_renglon) || 0));
    const ctx = this.tenantCtx.get();

    return this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeBorrador(trx);
      const p = await trx('catalog.products').where({ tenant_id: tenantId, id: req.product_id }).whereNull('deleted_at').first('id', 'sku');
      const sku = String(p?.sku ?? '').trim();
      if (!p || !sku) throw new BadRequestException('Ese producto no está en el catálogo.');
      const { porProducto, vieneMedido } = await this.medidasMano(trx, tenantId, almacen, [{ id: p.id, sku }], origen ? [origen] : []);
      const m = porProducto.get(p.id);
      const u = unidadDeCaptura(m?.escalera ?? null, unidadPedida);
      if (!u) {
        const hay = unidadesDeCaptura(m?.escalera ?? null).map((x) => x.unidad);
        throw new BadRequestException(hay.length
          ? `${sku} no se puede pedir en «${unidadPedida.toUpperCase()}»: se pide en ${hay.join(', ')}.`
          : `Kepler no trae la escalera de unidades de ${sku}: no se puede pedir a mano.`);
      }
      const base = cantidad * u.factor;
      const pedidoId = await this.borradorOCrea(trx, tenantId, almacen.id);
      const previo = await trx('commercial.autoabasto_pedido_lineas')
        .where({ tenant_id: tenantId, pedido_id: pedidoId, product_id: p.id }).first('captura', 'cantidad', 'unidad', 'origen_clave');
      const entrada = entradaAlcance(m, almacen.code);
      const kepler = origen ? rechazoDelTraspaso({ sku, cantidadBase: base, piezasPorCaja: m?.bf, ficha: m?.origen.get(origen.id)?.ficha }) : null;
      // La foto de lo que la persona tenía enfrente, calculada AQUÍ (no la manda la pantalla): es lo que el piloto mide.
      const contexto = {
        existencia: m?.existencia ?? null, viene: m?.viene ?? null, viene_medido: vieneMedido, venta_30d: m?.venta30 ?? null,
        existencia_origen: origen ? m?.origen.get(origen.id)?.existencia ?? null : null,
        alcance_hoy: alcanceDelRenglon({ ...entrada, pedidoBase: 0 }).hoy,
        alcance_con_pedido: alcanceDelRenglon({ ...entrada, pedidoBase: base }).con_pedido,
        factor: u.factor, kepler, reemplaza: previo?.captura === 'motor' ? 'sugerido' : null,
      };
      await trx.raw(
        `INSERT INTO commercial.autoabasto_pedido_lineas
           (tenant_id, pedido_id, product_id, sku, origen_tipo, origen_clave, sugerido, sugerido_unidad, sugerido_base,
            cantidad, unidad, cantidad_base, motivo, contexto, ajustado_por, ajustado_por_username, ajustado_at, captura)
         VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 0, ?, ?, ?, NULL, ?::jsonb, ?, ?, ?, 'mano')
         ON CONFLICT (tenant_id, pedido_id, product_id) DO UPDATE SET
           origen_tipo = EXCLUDED.origen_tipo, origen_clave = EXCLUDED.origen_clave,
           sugerido = 0, sugerido_unidad = NULL, sugerido_base = 0,
           cantidad = EXCLUDED.cantidad, unidad = EXCLUDED.unidad, cantidad_base = EXCLUDED.cantidad_base,
           motivo = NULL, contexto = EXCLUDED.contexto, captura = 'mano',
           ajustado_por = EXCLUDED.ajustado_por, ajustado_por_username = EXCLUDED.ajustado_por_username,
           ajustado_at = EXCLUDED.ajustado_at, updated_at = now()`,
        [tenantId, pedidoId, p.id, sku, origen ? 'matriz' : 'sin_ruta', origen?.code ?? null,
          cantidad, u.unidad, base, JSON.stringify(contexto), ctx?.userId ?? null, ctx?.username ?? null, new Date()]);
      await this.huella(trx, {
        tenant_id: tenantId, warehouse_id: almacen.id, pedido_id: pedidoId, product_id: p.id, evento: 'capturar',
        antes: previo ? num(previo.cantidad) : null, despues: cantidad, unidad: u.unidad, ms_en_renglon: ms,
        datos: JSON.stringify({
          origen: origen?.code ?? 'compras', factor: u.factor, cantidad_base: base, kepler,
          reemplaza: contexto.reemplaza, antes_unidad: previo?.unidad ?? null, antes_origen: previo?.origen_clave ?? null,
        }),
      });
      const [fila] = await this.filasMano(trx, tenantId, pedidoId, [p.id]);
      return { pedido_id: pedidoId, renglon: renglonMano(fila, m, new Map(origen ? [[origen.code, origen]] : []), almacen.code) };
    });
  }

  /** `POST pedido/mano/quitar` — saca un renglón del pedido a mano (y el producto vuelve a la cuenta del sugerido). */
  async quitarMano(almacen: Almacen, req: AutoabastoManoQuitarRequest): Promise<{ pedido_id: string; product_id: string }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const ms = req?.ms_en_renglon == null ? null : Math.max(0, Math.round(Number(req.ms_en_renglon) || 0));
    return this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeBorrador(trx);
      const pedidoId = await this.borradorDe(trx, tenantId, almacen.id);
      // Sólo lo de a mano: un ajuste del sugerido se restablece, no se «quita».
      const [previo] = pedidoId
        ? await trx('commercial.autoabasto_pedido_lineas')
          .where({ tenant_id: tenantId, pedido_id: pedidoId, product_id: req.product_id, captura: 'mano' })
          .delete(['cantidad', 'unidad', 'origen_clave'])
        : [];
      if (!pedidoId || !previo) throw new BadRequestException('Ese producto no está en tu pedido a mano.');
      await this.huella(trx, {
        tenant_id: tenantId, warehouse_id: almacen.id, pedido_id: pedidoId, product_id: req.product_id, evento: 'quitar',
        antes: num(previo.cantidad), despues: 0, unidad: previo.unidad, ms_en_renglon: ms,
        datos: JSON.stringify({ origen: previo.origen_clave ?? 'compras' }),
      });
      return { pedido_id: pedidoId, product_id: req.product_id };
    });
  }

  /**
   * `POST pedido/mano/enviar` — **un pedido por sucursal origen** (R5), por el escritor que ya existe:
   * `crearRequisicionesDeSucursal` (una transacción, candado por almacén, no repite lo vivo) y
   * `soltarPedidoDeSucursal` (nace autorizado en el Kepler del origen; si no sale, queda guardado con su
   * motivo y lo recoge el reintento — ADR-127).
   *
   * Se queda en el borrador, con su motivo: lo que va a Compras (R7, espera `[AB.NI.11]`), lo que Kepler
   * rechazaría (R8 d: un solo renglón así tumbaría el documento entero) y lo que ya va en un pedido vivo.
   * Lo que sí salió deja el borrador: ya es un pedido y se ve en «Lo que te va a llegar».
   */
  async enviarMano(almacen: Almacen, req: AutoabastoManoEnviarRequest): Promise<AutoabastoManoEnviarResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const nota = String(req?.nota ?? '').trim().slice(0, 500);
    const soloCode = String(req?.origen_code ?? '').trim() || null;
    const { pedidoId, renglones, porProducto, filas } = await this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeBorrador(trx);
      const id = await this.borradorDe(trx, tenantId, almacen.id);
      return { pedidoId: id, ...(await this.leerMano(trx, tenantId, almacen, id)) };
    });
    if (!pedidoId || !renglones.length) throw new BadRequestException('Tu pedido a mano está vacío.');

    const porId = new Map(renglones.map((r) => [r.product_id, r]));
    const { grupos, descartados } = partirCaptura(
      renglones.map((r) => ({ product_id: r.product_id, destino: r.destino, cantidad_base: r.cantidad_base })), almacen.code);
    const pendientes: AutoabastoManoEnviarResponse['pendientes'] = [...descartados];
    const dtos: CreateRequisitionDto[] = [];
    const surtes: SurteRenglon[] = [];
    for (const g of grupos) {
      if (g.destino.tipo === 'compras') {
        for (const r of g.renglones) pendientes.push({ product_id: r.product_id, motivo: g.motivo ?? 'Va a Compras.' });
        continue;
      }
      if (soloCode && g.destino.code !== soloCode) continue;
      // R6 otra vez: la sucursal pudo dejar de servir de origen entre capturar y mandar.
      let origen: OrigenMano | null = null;
      try {
        origen = await this.origenElegido(tenantId, almacen, g.destino.code);
      } catch (e: unknown) {
        for (const r of g.renglones) pendientes.push({ product_id: r.product_id, motivo: String((e as Error)?.message ?? e) });
        continue;
      }
      if (!origen) continue;
      const lineas: CreateRequisitionDto['lines'] = [];
      for (const r of g.renglones) {
        const k = porId.get(r.product_id)?.kepler;
        if (k) { pendientes.push({ product_id: r.product_id, motivo: RECHAZO_KEPLER_MSG[k] }); continue; }
        const m = porProducto.get(r.product_id);
        const bf = Number(m?.bf);   // > 0: `rechazoDelTraspaso` ya lo exigió
        lineas.push({
          product_id: r.product_id, supplier_id: null, source_type: 'branch', source_warehouse_id: origen.id,
          on_hand: m?.existencia != null ? cajasDeBase(m.existencia, bf) : 0,
          in_transit: m?.viene != null ? cajasDeBase(m.viene, bf) : 0,
          min_stock: 0, reorder_point: 0, max_stock: 0,
          // El motor no lo sugirió (o la persona lo reemplazó): lo sugerido de este renglón es cero.
          suggested_qty: 0,
          final_qty: cajasDeBase(r.cantidad_base, bf),
          unit_cost: m?.cajaCost ?? 0,
        });
      }
      if (!lineas.length) continue;
      dtos.push({
        warehouse_id: almacen.id, source_type: 'branch', source_warehouse_id: origen.id, supplier_id: null, target_basis: 'demanda',
        notes: `Pedida a mano por la sucursal ${almacen.name} desde Autoabasto.${nota ? ` Nota: ${nota}` : ''}`,
        lines: lineas,
      });
      surtes.push({ tipo: 'matriz', clave: origen.code, nombre: origen.name });
    }
    if (!dtos.length) {
      throw new BadRequestException(pendientes.length
        ? `Nada se puede mandar todavía: ${pendientes[0].motivo}`
        : 'No hay nada que mandar a esa sucursal.');
    }

    const { creadas, ya_pedidos } = await this.motor.crearRequisicionesDeSucursal(almacen.id, dtos);
    const ya = new Set(ya_pedidos);
    for (const id of ya_pedidos) pendientes.push({ product_id: id, motivo: `Ya lo pediste: va en un pedido de los últimos ${VENTANA_YA_PEDIDO_DIAS} días.` });
    // ⛔ Al ERP DESPUÉS de commitear la requisición y fuera de toda transacción, como `enviar` (ADR-127).
    const kepler = creadas.length ? await this.motor.soltarPedidoDeSucursal(creadas.map((c) => c.id)) : new Map<string, AutoabastoEnvioKepler>();
    const salieron = creadas.flatMap((c) => dtos[c.indice].lines.map((l) => l.product_id).filter((id) => !ya.has(id)));
    const requisiciones = creadas.map((c) => {
      const k = kepler.get(c.id);
      return { id: c.id, folio: c.folio, surte: surtes[c.indice], renglones: c.renglones, total_cajas: r1(c.total_units), ...(k ? { kepler: k } : {}) };
    });

    // Lo que salió deja el borrador. Si esto fallara, la requisición ya existe y un segundo envío lo
    // frena `crearRequisicionesDeSucursal` («ya lo pediste»): se dice en el log, no se duplica.
    // ⛔ Sólo se borra el renglón que sigue COMO SE LEYÓ: entre leerlo y borrarlo pasan los escritos a
    // Kepler (segundos). Si otra pestaña u otra persona lo cambió en ese hueco, lo nuevo no salió: se queda
    // en el borrador y se dice (revisión del PR, 2026-11-27).
    const leidas = new Map(filas.map((f) => [f.product_id, f]));
    await this.tk.run(async (trx: Knex.Transaction) => {
      let cambiaron = 0;
      if (salieron.length) {
        const borrados = (await trx('commercial.autoabasto_pedido_lineas')
          .where({ tenant_id: tenantId, pedido_id: pedidoId, captura: 'mano' })
          .where((q) => {
            for (const id of salieron) {
              const f = leidas.get(id);
              if (!f) continue;
              q.orWhere((w) => w.where('product_id', id).where('origen_tipo', f.origen_tipo)
                .whereRaw('origen_clave IS NOT DISTINCT FROM ?', [f.origen_clave])
                .whereRaw('cantidad_base = ?::numeric', [String(f.cantidad_base)]));
            }
          })
          .returning('product_id').del()) as Array<{ product_id: string }>;
        const fuera = new Set(borrados.map((b) => b.product_id));
        const noBorrados = salieron.filter((id) => !fuera.has(id));
        if (noBorrados.length) {
          const siguen = (await trx('commercial.autoabasto_pedido_lineas')
            .where({ tenant_id: tenantId, pedido_id: pedidoId, captura: 'mano' }).whereIn('product_id', noBorrados)
            .select('product_id')) as Array<{ product_id: string }>;
          for (const s of siguen) pendientes.push({ product_id: s.product_id, motivo: PEDIDO_A_MANO_CAMBIO_AL_ENVIAR_MSG });
          cambiaron = siguen.length;
        }
      }
      await this.huella(trx, {
        tenant_id: tenantId, warehouse_id: almacen.id, pedido_id: pedidoId, evento: 'enviar',
        datos: JSON.stringify({
          captura: 'mano', productos: salieron.length, cambiaron, pendientes: pendientes.length,
          requisiciones: requisiciones.map((r) => ({
            folio: r.folio, surte: `${r.surte.tipo}:${r.surte.clave ?? ''}`, renglones: r.renglones,
            kepler: r.kepler?.estado ?? null,
            kepler_folio: r.kepler && 'folio' in r.kepler ? r.kepler.folio : null,
            kepler_motivo: r.kepler && 'motivo' in r.kepler ? r.kepler.motivo : null,
          })),
        }),
      });
    }).catch((e: unknown) => {
      this.logger.warn(`[AB.PM.3] Pedido a mano de ${almacen.code} enviado, pero no se limpió el borrador: ${(e as Error)?.message}`);
    });

    return { requisiciones, pendientes };
  }
}

/** `[AB.PM.3]` La entrada del alcance de un producto (la cuenta de días de Pedido), sin lo pedido. */
function entradaAlcance(m: MedidasProducto | undefined, almacenCode: string) {
  return {
    venta30Base: m?.venta30 ?? null,
    existenciaBase: m?.existencia ?? 0,
    vieneBase: m?.viene ?? 0,
    noConfiable: m?.noConfiable ?? false,
    almacenCode,
  };
}

/** `[AB.PM.3]` Los números de un producto como viajan: unidades de captura, existencias, lo que viene y el alcance de hoy. */
function medidasDe(m: MedidasProducto | undefined, origenId: string | null, almacenCode: string): AutoabastoManoMedidas {
  return {
    unidad_base: m?.escalera?.unit_base ?? null,
    unidades: unidadesDeCaptura(m?.escalera ?? null),
    existencia: m?.existencia ?? null,
    existencia_origen: origenId ? m?.origen.get(origenId)?.existencia ?? null : null,
    viene: m?.viene ?? null,
    venta_30d: m?.venta30 ?? null,
    alcance: alcanceDelRenglon({ ...entradaAlcance(m, almacenCode), pedidoBase: 0 }),
  };
}

/** `[AB.PM.3]` Un renglón a mano con sus números de hoy, su alcance con lo pedido y lo que Kepler rechazaría. */
function renglonMano(f: FilaMano, m: MedidasProducto | undefined, origenes: ReadonlyMap<string, OrigenMano>, almacenCode: string): AutoabastoManoRenglon {
  const code = String(f.origen_clave ?? '').trim();
  const destino: DestinoCaptura = f.origen_tipo === 'matriz' && code ? { tipo: 'sucursal', code } : { tipo: 'compras' };
  const origen = destino.tipo === 'sucursal' ? origenes.get(code) ?? null : null;
  const base = num(f.cantidad_base);
  const sku = f.sku == null ? null : String(f.sku);
  return {
    product_id: f.product_id, sku, nombre: f.nombre ?? null, destino, origen_nombre: origen?.name ?? null,
    cantidad: num(f.cantidad), unidad: f.unidad ?? null, cantidad_base: base,
    ...medidasDe(m, origen?.id ?? null, almacenCode),
    alcance_con_pedido: alcanceDelRenglon({ ...entradaAlcance(m, almacenCode), pedidoBase: base }),
    // A Compras no se escribe un traspaso: no hay ficha de origen que revisar.
    kepler: destino.tipo === 'sucursal'
      ? rechazoDelTraspaso({ sku: sku ?? '', cantidadBase: base, piezasPorCaja: m?.bf, ficha: origen ? m?.origen.get(origen.id)?.ficha : null })
      : null,
    capturado_por: f.ajustado_por_username ?? null,
    capturado_at: new Date(f.ajustado_at).toISOString(),
  };
}

interface FilaLinea {
  product_id: string; cantidad: string | number; unidad: string | null; cantidad_base: string | number;
  motivo: string | null; ajustado_por_username: string | null; ajustado_at: string | Date;
  /** `[AB.PM.1]` Cómo nació el renglón: ajuste del sugerido (`motor`) o pedido a mano (`mano`). */
  captura?: string | null;
}

type Almacen = { id: string; code: string; name: string };

/** `[PQ.139]` Un almacén que sirve de origen (ya validado por `origenElegido`), con su sucursal de Kepler. */
type OrigenMano = { id: string; code: string; name: string; kepler_code: string };

/**
 * `[AB.PM.3]` Lo que el pedido a mano sabe de un producto, leído de las MISMAS fuentes que la mesa. En
 * unidad base; `null` = no medido.
 */
interface MedidasProducto {
  sku: string;
  escalera: EscaleraUnidades | null;
  existencia: number | null;
  venta30: number | null;
  /** La unidad de este almacén está contradicha (`rung_veredicto`, igual que `armarRenglon`). */
  noConfiable: boolean;
  viene: number | null;
  /** Factor de caja del almacén que pide (`mv_warehouse_box_factor`, el de `pushToKepler`). */
  bf: number | null;
  /** Costo de la caja del plan: el que viaja a la requisición, como en `enviar`. */
  cajaCost: number | null;
  /** Por almacén origen (id): su existencia y la ficha de su Kepler. */
  origen: Map<string, { existencia: number | null; ficha: { unidad_base: string | null; factor: number | null } | null }>;
}

/** `[AB.PM.3]` Un renglón a mano tal como está en el borrador. */
interface FilaMano {
  product_id: string; sku: string | null; nombre: string | null;
  origen_tipo: string; origen_clave: string | null;
  cantidad: string | number; unidad: string | null; cantidad_base: string | number;
  ajustado_por_username: string | null; ajustado_at: string | Date;
}

/** `[AB.27]` Un renglón ya armado, con la fila del motor de la que salió y el factor de caja del almacén. */
interface RenglonInterno extends RenglonArmado {
  fila: Record<string, unknown>;
  cf: number;
}

/** `[AB.27]` Lo que `armarAlmacen` deja listo para «Mi pedido» y para la mesa. */
interface AlmacenArmado {
  renglones: RenglonInterno[];
  docs: FilaDoc[];
  planDocs: Map<string, FilaPlan & { renglones: number }>;
  /** `[AB.29]` Las requisiciones que mandó la sucursal (vivas y rechazadas recientes), por id. */
  reqDocs: Map<string, FilaReqSucursal & { renglones: number }>;
  sinUnidad: number;
  medidos: boolean;
  borrador: string | null;
  guardable: boolean;
  posiciones: PosicionPedido[];
  /** `[AB.PM.3]` Los productos pedidos a mano en el borrador: fuera de la cuenta del sugerido (R1). */
  aMano: Set<string>;
}

/** Agrupa renglones de requisición por documento, contando renglones. */
function porDocumento<T extends { id: string }>(filas: T[]): Map<string, T & { renglones: number }> {
  const docs = new Map<string, T & { renglones: number }>();
  for (const f of filas) {
    const d = docs.get(f.id);
    if (d) d.renglones++; else docs.set(f.id, { ...f, renglones: 1 });
  }
  return docs;
}

/**
 * `[AB.44]` Los documentos de «Lo que te va a llegar», en UN solo lugar: los sirven `pedido()` (la mesa)
 * y `viene()` (Pendientes de la sucursal). Si cada uno mapeara por su cuenta, dirían cosas distintas
 * del mismo embarque.
 */
function documentosViene(
  docs: FilaDoc[],
  planDocs: Map<string, FilaPlan & { renglones: number }>,
  reqDocs: Map<string, FilaReqSucursal & { renglones: number }>,
): AutoabastoVieneDoc[] {
  return [
    ...docs.map((d) => ({
      tipo: d.tipo, origen: d.origen, serie: Number(d.serie), folio: d.folio, estado: d.estado, fecha: d.fecha,
      dias: Number(d.dias), renglones: Number(d.renglones), monto: numONull(d.monto),
      se_resta: d.tipo === 'embarque' ? Number(d.dias) <= VENTANA_EN_CAMINO_DIAS : Number(d.dias) <= VENTANA_YA_PEDIDO_DIAS,
    })),
    ...[...planDocs.values()].map((p) => ({
      tipo: 'plan' as const, origen: p.origen ?? '', serie: 0, folio: p.folio ?? '', estado: 'PLANEADO', fecha: p.fecha,
      dias: Number(p.dias), renglones: p.renglones, monto: numONull(p.monto), se_resta: false, id: p.id,
    })),
    // `[AB.29]` Lo que la sucursal mandó a Compras: por aprobar, aprobado o rechazado (con motivo).
    ...[...reqDocs.values()].map((q) => ({
      tipo: 'requisicion' as const,
      origen: q.source_type === 'branch' ? (q.origen ?? '') : '',
      proveedor: q.source_type === 'branch' ? null : (q.proveedor ?? 'Proveedor'),
      serie: 0, folio: q.folio, estado: ESTADO_REQ[q.estado] ?? q.estado.toUpperCase(), fecha: q.fecha,
      dias: Number(q.dias), renglones: q.renglones, monto: numONull(q.monto), se_resta: false,
      motivo: q.estado === 'cancelled' ? (q.motivo ?? null) : null, id: q.id,
    })),
  ];
}

/** Una fecha del motor como AAAA-MM-DD (el driver puede devolver `Date` o texto). `null` = sin fecha. */
function fechaDe(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : toMxDateKey(v);
  return String(v).slice(0, 10);
}

/**
 * `[AB.39]` Lo que explica la posición del renglón: mínimo, reorden, máximo y entrega, tal como los
 * trae el motor. Una sola función para la mesa (`/renglones`) y para la pantalla única (`/pedido`).
 */
function diagnosticoDe(f: Record<string, unknown>): DiagnosticoRenglon {
  return {
    min_stock: num(f['min_stock']),
    reorder_point: num(f['reorder_point']),
    max_stock: num(f['max_stock']),
    oc_en_camino: num(f['in_transit']),
    venta_diaria: numONull(f['avg_daily_units']),
    next_due_date: fechaDe(f['next_due_date']),
    lead_time_days: numONull(f['lead_time_days']),
    cadence_days: numONull(f['cadence_days']),
    abc_class: f['abc_class'] == null ? null : String(f['abc_class']),
    rung_veredicto: f['rung_veredicto'] == null ? null : String(f['rung_veredicto']),
    sales_rank: numONull(f['sales_rank']),
  };
}
