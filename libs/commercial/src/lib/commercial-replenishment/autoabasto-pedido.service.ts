import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService, TenantContextService, MX_TZ, toMxDateKey } from '@megadulces/platform-core';
import {
  armarRenglon,
  surteDe,
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
} from '@megadulces/contracts';
import { CommercialReplenishmentService, type CreateRequisitionDto } from './commercial-replenishment.service';
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
const VIENE_DOCS_SQL = `
WITH dest AS (
  SELECT dest_code FROM analytics.v_erp_branch_catalog WHERE tenant_id = :t AND suc_code = :suc
),
ped AS (
  SELECT DISTINCT ON (k.sucursal, k.c5, k.c6)
         'pedido'::text AS tipo, btrim(k.sucursal) AS origen, (k.c5)::int AS serie, btrim(k.c6::text) AS folio,
         upper(btrim(k.c11::text)) AS estado, (k.c9)::date AS f,
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
     AND NOT EXISTS (
       SELECT 1 FROM kepler_ods.kdm1 x
        WHERE x.c2 = 'U' AND x.c3 = 'A' AND (x.c4)::int = 50
          AND btrim(x.sucursal) = :suc AND btrim(x.c1) = :suc
          AND x.c37 = 41 AND x.c38 = h.c5 AND btrim(x.c39::text) = btrim(h.c6::text)
          AND btrim(COALESCE(x.c43, '')) <> 'C' AND (x.c9)::date >= (h.c9)::date - 1)
),
docs AS (
  SELECT * FROM ped WHERE estado IN ('AUTORIZADO', 'SURTIDO', 'CHECADO')
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
    const [{ filas, skus, escaleras }, propio, llega] = await Promise.all([
      this.motor.criticalStock({ warehouse_id: almacen.id, target_basis: 'demanda', export: true, ligero: true }, area)
        .then(async (mesa) => {
          const skus = [...new Set(mesa.rows.map((f) => String(f['sku'])))];
          return { filas: mesa.rows, skus, escaleras: await this.escalerasDe(skus) };
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
        if (borrador) {
          const ls: FilaLinea[] = await trx('commercial.autoabasto_pedido_lineas')
            .where({ tenant_id: tenantId, pedido_id: borrador })
            .select('product_id', 'cantidad', 'unidad', 'cantidad_base', 'motivo', 'ajustado_por_username', 'ajustado_at');
          for (const l of ls) {
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
        return { medidos, planes, deSucursal, pedidos, borrador, ajustes, guardable, posiciones };
      }),
      this.tk.run(async (trx: Knex.Transaction) => ({
        enCamino: await kepler<FilaEnCamino>(trx, EMBARCADO_SIN_RECIBIR_SQL),
        docs: await kepler<FilaDoc>(trx, VIENE_DOCS_SQL),
      })),
    ]);
    const { medidos, planes, deSucursal, borrador, ajustes, guardable, posiciones } = propio;
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
    const reqDocs = new Map<string, FilaReqSucursal & { renglones: number }>();
    for (const q of deSucursal) {
      if (q.viva) pedidoSucursal.set(q.product_id, (pedidoSucursal.get(q.product_id) ?? 0) + num(q.final_qty));
      const d = reqDocs.get(q.id);
      if (d) d.renglones++; else reqDocs.set(q.id, { ...q, renglones: 1 });
    }
    const planPorProducto = new Map<string, number>();
    const planDocs = new Map<string, FilaPlan & { renglones: number }>();
    for (const p of planes) {
      planPorProducto.set(p.product_id, (planPorProducto.get(p.product_id) ?? 0) + num(p.final_qty));
      const d = planDocs.get(p.id);
      if (d) d.renglones++; else planDocs.set(p.id, { ...p, renglones: 1 });
    }
    const renglones: RenglonInterno[] = filas.map((f) => {
      const sku = String(f['sku']);
      // El factor del almacén: las cantidades "_nat" vienen en unidad base, las de la mesa en cajas.
      const cf = Math.max(1, num(f['caja_factor']));
      const productId = String(f['product_id']);
      // `[AB.26]` La cuenta del renglón vive en `libs/contracts` (`armarRenglon`). Acá sólo se le pasa
      // lo que el servidor leyó; ninguna resta se escribe aquí.
      return { fila: f, cf, ...armarRenglon({
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
      }) };
    });
    return { renglones, docs, planDocs, reqDocs, sinUnidad, medidos, borrador, guardable, posiciones };
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
        documentos: [
          ...docs.map((d) => ({
            tipo: d.tipo, origen: d.origen, serie: Number(d.serie), folio: d.folio, estado: d.estado, fecha: d.fecha,
            dias: Number(d.dias), renglones: Number(d.renglones), monto: numONull(d.monto),
            se_resta: d.tipo === 'embarque' ? Number(d.dias) <= VENTANA_EN_CAMINO_DIAS : Number(d.dias) <= VENTANA_YA_PEDIDO_DIAS,
          })),
          ...[...planDocs.values()].map((p) => ({
            tipo: 'plan' as const, origen: p.origen ?? '', serie: 0, folio: p.folio ?? '', estado: 'PLANEADO', fecha: p.fecha,
            dias: Number(p.dias), renglones: p.renglones, monto: numONull(p.monto), se_resta: false,
          })),
          // `[AB.29]` Lo que la sucursal mandó a Compras: por aprobar, aprobado o rechazado (con motivo).
          ...[...reqDocs.values()].map((q) => ({
            tipo: 'requisicion' as const,
            origen: q.source_type === 'branch' ? (q.origen ?? '') : '',
            proveedor: q.source_type === 'branch' ? null : (q.proveedor ?? 'Proveedor'),
            serie: 0, folio: q.folio, estado: ESTADO_REQ[q.estado] ?? q.estado.toUpperCase(), fecha: q.fecha,
            dias: Number(q.dias), renglones: q.renglones, monto: numONull(q.monto), se_resta: false,
            motivo: q.estado === 'cancelled' ? (q.motivo ?? null) : null,
          })),
        ],
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
  async enviar(almacen: Almacen, area: string, req: AutoabastoEnviarRequest): Promise<AutoabastoEnviarResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const ids = [...new Set((Array.isArray(req?.product_ids) ? req.product_ids : [])
      .filter((x): x is string => typeof x === 'string' && UUID_RX.test(x)))];
    if (!ids.length) throw new BadRequestException('Elige al menos un producto para mandar a Compras.');
    if (ids.length > 2000) throw new BadRequestException('Son demasiados productos para un solo envío (máximo 2,000).');
    const nota = String(req?.nota ?? '').trim().slice(0, 500);

    const { renglones } = await this.armarAlmacen(almacen, area);
    const porId = new Map(renglones.map((r) => [r.linea.product_id, r]));
    const omitidos: AutoabastoEnviarResponse['omitidos'] = [];
    const grupos = new Map<string, RenglonInterno[]>();
    for (const id of ids) {
      const r = porId.get(id);
      if (!r) { omitidos.push({ product_id: id, motivo: 'No le falta a esta sucursal' }); continue; }
      const porque = motivoNoEnviable(r.linea);
      if (porque) { omitidos.push({ product_id: id, motivo: porque }); continue; }
      const llave = `${r.linea.surte.tipo}:${r.linea.surte.clave ?? ''}`;
      const g = grupos.get(llave);
      if (g) g.push(r); else grupos.set(llave, [r]);
    }
    if (!grupos.size) {
      throw new BadRequestException(`Ninguno de los productos se puede mandar a Compras: ${omitidos[0]?.motivo ?? 'no le faltan'}.`);
    }

    const matrices = [...grupos.values()].map((g) => g[0].linea.surte).filter((s) => s.tipo === 'matriz').map((s) => String(s.clave));
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
      const s = g[0].linea.surte;
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
    return {
      requisiciones: creadas.map((c) => ({
        id: c.id, folio: c.folio, surte: surtes[c.indice], renglones: c.renglones, total_cajas: r1(c.total_units),
      })),
      omitidos,
      le_llega_a: leLlegaA,
    };
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
      await trx.raw(
        `INSERT INTO commercial.autoabasto_pedido_lineas
           (tenant_id, pedido_id, product_id, sku, origen_tipo, origen_clave, sugerido, sugerido_unidad, sugerido_base,
            cantidad, unidad, cantidad_base, motivo, contexto, ajustado_por, ajustado_por_username, ajustado_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?,?)
         ON CONFLICT (tenant_id, pedido_id, product_id) DO UPDATE SET
           sugerido = EXCLUDED.sugerido, sugerido_unidad = EXCLUDED.sugerido_unidad, sugerido_base = EXCLUDED.sugerido_base,
           cantidad = EXCLUDED.cantidad, unidad = EXCLUDED.unidad, cantidad_base = EXCLUDED.cantidad_base,
           motivo = EXCLUDED.motivo, contexto = EXCLUDED.contexto, ajustado_por = EXCLUDED.ajustado_por,
           ajustado_por_username = EXCLUDED.ajustado_por_username, ajustado_at = EXCLUDED.ajustado_at, updated_at = now()`,
        [tenantId, pedidoId, req.product_id, req.sku ?? null, req.origen_tipo, req.origen_clave ?? null,
          sugerido, req.unidad ?? null, sugerido * factor, cantidad, req.unidad ?? null, cantidad * factor,
          motivo, JSON.stringify(req.contexto ?? {}), ctx?.userId ?? null, ctx?.username ?? null, ahora]);
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
      const previo = await trx('commercial.autoabasto_pedido_lineas')
        .where({ tenant_id: tenantId, pedido_id: pedidoId, product_id: req.product_id })
        .first('cantidad', 'sugerido', 'unidad');
      if (previo) {
        await trx('commercial.autoabasto_pedido_lineas')
          .where({ tenant_id: tenantId, pedido_id: pedidoId, product_id: req.product_id }).delete();
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
}

interface FilaLinea {
  product_id: string; cantidad: string | number; unidad: string | null; cantidad_base: string | number;
  motivo: string | null; ajustado_por_username: string | null; ajustado_at: string | Date;
}

type Almacen = { id: string; code: string; name: string };

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
