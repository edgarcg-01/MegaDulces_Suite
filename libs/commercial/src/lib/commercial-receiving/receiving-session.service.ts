import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { TenantKnexService, TenantContextService, ScopeService } from '@megadulces/platform-core';
import type { Knex } from 'knex';
import type {
  ErpPendingMenu,
  ErpPendingBranch,
  ErpOrderMatch,
  AndenValeEnCurso,
  AndenLineaOffline,
  AndenPaqueteOffline,
  AndenLlegada,
  AndenLlegadas,
} from '@megadulces/contracts';
import { DIAS_PENDIENTES_ANDEN } from '@megadulces/contracts';
import { CommercialInventoryService } from '../commercial-inventory/commercial-inventory.service';
import { classifyReceivingOrigin } from './receiving-origin';
import { ReceivingClaimsService } from './receiving-claims.service';
import { UX_SESIONES_CLIENT_UUID, conLlave, esChoqueDe } from './receiving-idempotency';
import {
  type LoteCrudo,
  type RenglonValeCrudo,
  aLote,
  armarLlegada,
  renglonesDeKepler,
  renglonesDeVale,
  unidadesPorSku,
} from './receiving-arrivals';
import {
  TRANSFER_REF_PREFIX,
  TRANSFER_WINDOW_DAYS,
  TransferKey,
  classifyShipmentOrigin,
  diasEntre,
  parseTransferRef,
  transferRef,
  transferVisible,
} from './receiving-transfer';

/**
 * Fase WMS-REC (Pieza 1 — Modo recepción por escaneo / Vale vivo, ADR-044).
 *
 * El operador abre una sesión (Vale) desde una orden de entrada del ERP o manual,
 * escanea caja/pieza contra lo esperado, y el sistema le dice qué falta validar +
 * faltantes/sobrantes. Captura CANTIDADES (identidad física); la caducidad/lote la
 * audita la Pieza 2 (enlazada por source_ref = folio del Vale).
 *
 * **Al CERRAR el vale ("luz verde") la mercancía entra a inventario** en el lote
 * `NA` (sin fecha). La caducidad se captura después, en la bandeja de Caducidades:
 * poner la fecha RECLASIFICA ese `NA` a un lote fechado sin cambiar el total, así
 * que el invariante `SUM(stock_lots) = stock.quantity` nunca se rompe.
 *
 * El orden importa y es deliberado: el inventario refleja lo que está físicamente
 * en la bodega **desde que se aprueba la recepción**, no desde que alguien encuentra
 * tiempo para capturar fechas. La ventana sin caducidad no se esconde: se mide con
 * `undeclared_qty` y es justo la cola de trabajo del bodeguero.
 * (Cambio de ADR-044 — antes el alta ocurría al capturar el lote.)
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DiscrepancyKind = 'pending' | 'ok' | 'faltante' | 'sobrante' | 'producto_incorrecto' | 'dañado';

export interface OpenSessionDto {
  /** Opcional cuando source_kind='erp_receipt': se deriva de la orden. */
  warehouse_id?: string;
  /** Rehacer un folio ya recibido (el vale anterior quedó mal). Salta el guard. */
  force?: boolean;
  supplier_code?: string;
  source_kind?: 'manual' | 'erp_receipt' | 'erp_transfer';
  /**
   * Para source_kind='erp_receipt': (sucursal, folio) de analytics.erp_goods_receipts.
   * Para source_kind='erp_transfer' (`[WMS-REC.17]`): (sucursal QUE EMBARCA, serie, folio)
   * del embarque `U-D-41`.
   */
  erp_sucursal?: string;
  erp_serie?: number;
  erp_folio?: string;
  notes?: string;
  /**
   * `[WMS-REC.19]` Id que el equipo le pone a ESTA apertura antes de mandarla. Si la respuesta se
   * pierde y reintenta, recibe el vale que ya abrió en vez de chocar con `folio_ya_recibido` (su
   * propio vale) o, con `force`, abrir un segundo vale del mismo camión. Opcional.
   */
  client_uuid?: string;
}

/**
 * `[WMS-REC.17]` Un embarque `U-D-41` hacia una sucursal, con su destino ya resuelto.
 * La fila cruda de `transferCandidates()`.
 */
/** Una fila de `inProgress()`: el vale abierto con lo que el menú necesita para reconocerlo. */
interface FilaValeEnCurso {
  id: string;
  folio: string;
  source_kind: AndenValeEnCurso['source_kind'];
  source_ref: string | null;
  supplier_code: string | null;
  warehouse_id: string;
  warehouse_code: string | null;
  warehouse_name: string | null;
  created_at: Date | string;
  abierto_por: string | null;
  renglones: number | string;
  por_fechar: number | string;
}

/** `[WMS-REC.22]` Una orden de entrada de la ventana, para Llegadas al andén. */
interface FilaCompraLlegada {
  sucursal: string;
  folio: string;
  receipt_date: string;
  proveedor_nombre: string | null;
  monto: string | number | null;
  warehouse_id: string | null;
  warehouse_code: string | null;
  warehouse_name: string | null;
}

/** `[WMS-REC.22]` Un vale de la ventana, para Llegadas al andén. */
interface FilaValeLlegada {
  id: string;
  folio: string;
  source_kind: string;
  source_ref: string | null;
  status: 'open' | 'validating' | 'closed';
  created_at: Date | string;
  closed_at: Date | string | null;
  warehouse_id: string | null;
  warehouse_code: string | null;
  warehouse_name: string | null;
  /** Día de México en que se abrió (`YYYY-MM-DD`). */
  dia: string;
  abierto_por: string | null;
}

interface FilaEmbarque {
  origen: string;
  serie: number;
  folio: string;
  fecha: string;
  destino_code: string;
  destino_nombre: string | null;
  monto: string | number | null;
  comentarios: string | null;
  warehouse_id: string | null;
  warehouse_code: string | null;
  warehouse_name: string | null;
  origen_warehouse_id: string | null;
  origen_nombre: string | null;
  recibido_kepler: string | null;
  abierto: boolean;
  hoy: string;
}

/**
 * `[WMS-REC.20]` El documento de Kepler del que sale un vale: una orden de entrada (`XA2001`, por
 * sucursal y folio) o un embarque de traspaso (`U-D-41`, por origen, serie y folio).
 */
export type DocErp =
  | { tipo: 'compra'; sucursal: string; folio: string }
  | { tipo: 'traspaso'; sucursal: string; serie: number; folio: string };

/** La llave de un documento: la MISMA forma que `source_ref` del vale que se abre desde él. */
export function claveDoc(d: DocErp): string {
  return d.tipo === 'compra'
    ? `${d.sucursal}/${d.folio}`
    : transferRef({ origen: d.sucursal, serie: d.serie, folio: d.folio });
}

/** De un vale del menú a su documento. En un embarque, `sucursal` es la que EMBARCA. */
export function docDeVale(v: Pick<ErpOrderMatch, 'fuente' | 'sucursal' | 'serie' | 'folio'>): DocErp {
  return v.fuente === 'embarque'
    ? { tipo: 'traspaso', sucursal: v.sucursal, serie: Number(v.serie), folio: v.folio }
    : { tipo: 'compra', sucursal: v.sucursal, folio: v.folio };
}

export interface ScanDto {
  barcode?: string;
  product_id?: string;
  qty?: number; // default 1
}

/**
 * **El dia de hoy, en hora de MEXICO.**
 *
 * `CURRENT_DATE` pelado NO sirve: la sesion de la base corre en `Etc/UTC`
 * (medido en prod), asi que a las 7 de la noche de Mexico ya devuelve el dia
 * siguiente. Con la regla "solo los vales de hoy", eso le cambiaria el dia al
 * bodeguero a media tarde: le esconderia los vales del turno y le mostraria los
 * de manana. Es el mismo `AT TIME ZONE` que ya usa `commercial-analytics`.
 *
 * ⚠️ **Regla de negocio, decidida por Edgar el 2026-09-24: SOLO el dia de hoy,
 * los pasados no.** Se aplica literal y NO se amplia sola cuando el resultado es
 * cero — ampliar en silencio seria decidir por el, y el dato dice que el cero va
 * a pasar seguido. Medido ese dia: hoy 0 vales, ayer 1, mientras un dia habil
 * normal trae entre 22 y 55. `receipt_date` es la fecha del DOCUMENTO de Kepler,
 * no la del camion: se adelanta (4 vales de THE KLASS por $333,434 fechados al
 * dia siguiente), se atrasa y a veces trae un dedazo (uno al 29/12). Cuando el
 * dia sale vacio, la pantalla lo dice y ofrece el folio a mano, que es la salida
 * que quedo a proposito.
 */
const HOY_MX = "r.receipt_date = (now() AT TIME ZONE 'America/Mexico_City')::date";

/**
 * `[WMS-REC.18]` **Hoy y los ultimos `DIAS_PENDIENTES_ANDEN` dias, nunca el futuro.**
 *
 * La regla de solo-hoy de arriba se amplio el 2026-10-07 a pedido de quien recibe: "si ayer
 * llegaron 8 y solo hizo 6, al dia siguiente siguen esos 2". Lo de hoy sigue apartado y primero
 * (eso lo hace la pantalla); lo atrasado no desaparece. Lo fechado a futuro sigue fuera, que es el
 * motivo de fondo de la regla de Edgar. ⚠️ Cambia una decision suya: avisarle (ver el PR).
 *
 * Costo: la fecha es `kdm1.c9::date` sin indice de fecha para `X-A-20`, asi que la igualdad ya
 * recorria todas las ordenes de entrada; el rango no cambia el plan. No medido en prod.
 */
const VENTANA_MX =
  `r.receipt_date BETWEEN (now() AT TIME ZONE 'America/Mexico_City')::date - ${DIAS_PENDIENTES_ANDEN} ` +
  `AND (now() AT TIME ZONE 'America/Mexico_City')::date`;

/**
 * La fila CRUDA que devuelve el select del menu, con los alias tal como los renombra la
 * consulta (`w.id as warehouse_id`, `COUNT(*)::int as pendientes`...).
 *
 * Vive ACA y no en `libs/contracts` a proposito: es un detalle de implementacion de esta
 * consulta, no lo que sale por HTTP (eso es `ErpPendingBranch`, ya mapeado). Publicarla
 * convertiria cualquier retoque del `select` en un cambio de paquete compartido.
 *
 * ⚠️ Tipar la fila NO verifica que el SQL traiga estas columnas: knex entrega las filas sin
 * tipo y TypeScript no lee la consulta. Lo que ataja es el typo al LEERLA y que el objeto
 * mapeado se compare contra `ErpPendingBranch`. Si el `select` renombrara `warehouse_id`,
 * `sin_almacen` saldria `true` en todas las filas y el Anden quedaria inusable sin un solo
 * error: eso lo tiene que cubrir una asercion, no el tipo.
 */
interface FilaMenuAnden {
  sucursal: string;
  warehouse_id: string | null;
  warehouse_code: string | null;
  warehouse_name: string | null;
  pendientes: number | string;
  /** `[WMS-REC.18]` De `pendientes`, las de dias anteriores. */
  anteriores: number | string;
  ultimo: string | null;
}

@Injectable()
export class ReceivingSessionService {
  private readonly logger = new Logger(ReceivingSessionService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly inventory: CommercialInventoryService,
    private readonly claims: ReceivingClaimsService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * Resuelve un código escaneado a UN producto SIN el anti-patrón "barcode OR sku + .first()"
   * (que en prod liga el producto equivocado: 279 barcodes dup + 57 colisiones sku↔barcode).
   * Prioridad: (1) barcode normalizado por unidad `catalog.product_barcodes` → sku (desambigua),
   * (2) sku exacto, (3) legacy products.barcode. Si el código sigue AMBIGUO (>1 producto), LANZA
   * en vez de tomar el primero. Ver feedback_everything_derivable_from_ods + auditoría 2026-08-25.
   */
  private async resolveProductByCode(trx: any, code: string): Promise<{ id: string; sku: string | null; nombre: string | null }> {
    const c = String(code || '').trim();
    if (!c) throw new BadRequestException('Se requiere barcode o sku');

    // (1) barcode normalizado por unidad → sku(s). La tabla puede no existir aún (no-regresivo).
    let bcSkus: string[] = [];
    const hasPB = (await trx.raw(`SELECT to_regclass('catalog.product_barcodes') IS NOT NULL AS ok`)).rows?.[0]?.ok;
    if (hasPB) {
      const rows = await trx('catalog.product_barcodes').where('barcode', c).whereNull('deleted_at').distinct('sku');
      bcSkus = rows.map((r: any) => String(r.sku));
    }

    // Candidatos = producto(s) por sku-del-barcode ∪ sku==code ∪ barcode==code.
    const cands = await trx('public.products')
      .whereNull('deleted_at')
      .andWhere((b: any) => {
        if (bcSkus.length) b.whereIn('sku', bcSkus);
        b.orWhere('sku', c).orWhere('barcode', c);
      })
      .distinct('id', 'sku', 'nombre');

    if (!cands.length) throw new NotFoundException(`Sin producto para '${c}'`);
    const distinct = Array.from(new Map(cands.map((r: any) => [r.id, r])).values());
    if (distinct.length > 1) {
      // El barcode normalizado manda: si apunta a UN solo producto, gana sobre la colisión sku.
      if (bcSkus.length === 1) {
        const only = distinct.filter((r: any) => r.sku === bcSkus[0]);
        if (only.length === 1) return only[0] as { id: string; sku: string | null; nombre: string | null };
      }
      throw new ConflictException(`Código '${c}' ambiguo: coincide con ${distinct.length} productos. Escaneá el código de barras específico o usá product_id.`);
    }
    return distinct[0] as { id: string; sku: string | null; nombre: string | null };
  }

  /** Recalcula la discrepancia de una línea desde expected vs received (no pisa overrides manuales). */
  static discrepancyFor(expected: number, received: number, manualOverride?: DiscrepancyKind): DiscrepancyKind {
    if (manualOverride === 'producto_incorrecto' || manualOverride === 'dañado') return manualOverride;
    if (received === 0 && expected > 0) return 'pending';
    if (received < expected) return 'faltante';
    if (received > expected) return 'sobrante';
    return 'ok'; // received === expected (y >0), o ambos 0
  }

  async open(dto: OpenSessionDto) {
    const sourceKind = dto.source_kind || 'manual';
    if (!['manual', 'erp_receipt', 'erp_transfer'].includes(sourceKind))
      throw new BadRequestException('source_kind inválido');
    if (sourceKind === 'erp_receipt' && (!dto.erp_sucursal || !dto.erp_folio))
      throw new BadRequestException('erp_receipt requiere sucursal + folio de la orden');
    if (sourceKind === 'erp_transfer' && (!dto.erp_sucursal || !dto.erp_folio || !Number.isInteger(Number(dto.erp_serie))))
      throw new BadRequestException('erp_transfer requiere sucursal, serie y folio del embarque');
    // Desde un documento del ERP el almacén se DERIVA (crosswalk → espejo): el
    // operador no elige nada, solo teclea el folio. En modo manual sigue siendo
    // obligatorio porque no hay de dónde sacarlo.
    if (sourceKind === 'manual' && !UUID.test(dto.warehouse_id || ''))
      throw new BadRequestException('warehouse_id inválido');
    if (dto.warehouse_id && !UUID.test(dto.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');
    const clientUuid: string | null = conLlave(dto.client_uuid) ? dto.client_uuid : null;

    try {
      return await this.abrir(dto, sourceKind, clientUuid);
    } catch (e) {
      // `[WMS-REC.19]` Dos envíos de la MISMA apertura a la vez: el segundo choca con el índice
      // único y se le contesta con el vale del primero. Cualquier otro error sigue su camino.
      if (clientUuid && esChoqueDe(e, UX_SESIONES_CLIENT_UUID)) {
        const ya = await this.tk.run((trx) => this.sesionPorLlave(trx, clientUuid));
        if (ya) return ya;
      }
      throw e;
    }
  }

  /** `[WMS-REC.19]` El vale que ya abrió esta llave, con su detalle. `null` si no existe. */
  private async sesionPorLlave(trx: Knex.Transaction, clientUuid: string) {
    const ya = await trx('commercial.receiving_sessions').where({ client_uuid: clientUuid }).first('id');
    return ya ? this.detailTx(trx, ya.id) : null;
  }

  private abrir(dto: OpenSessionDto, sourceKind: NonNullable<OpenSessionDto['source_kind']>, clientUuid: string | null) {
    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;

      // `[WMS-REC.19]` Reintento de una apertura que ya entró: se devuelve ESE vale. Va antes del
      // guardia de "folio ya recibido", que si no le contestaría al equipo con su propio vale.
      if (clientUuid) {
        const ya = await this.sesionPorLlave(trx, clientUuid);
        if (ya) return ya;
      }

      // Para órdenes del ERP: resuelve la cabecera (folio completo + proveedor) desde el espejo.
      let erpHeader: any = null;
      if (sourceKind === 'erp_receipt') {
        erpHeader = await this.findErpHeader(trx, dto.erp_sucursal!, dto.erp_folio!);
        if (!erpHeader) throw new NotFoundException('No encontré una orden de entrada con ese folio en esa sucursal');
      }

      // `[WMS-REC.17]` Traspaso: el vale se abre desde el EMBARQUE de quien manda.
      let embarque: FilaEmbarque | null = null;
      if (sourceKind === 'erp_transfer') {
        const [e] = await this.embarques(trx, {
          key: { origen: String(dto.erp_sucursal).trim(), serie: Number(dto.erp_serie), folio: String(dto.erp_folio).trim() },
        });
        if (!e) throw new NotFoundException('No encontré ese embarque en Kepler (o no va dirigido a una sucursal)');
        if (!e.warehouse_id && !dto.warehouse_id)
          // Se dice A QUIÉN va según Kepler: es lo que hace falta para configurarlo.
          throw new BadRequestException(
            `El embarque va a ${e.destino_nombre || e.destino_code} (${e.destino_code}) y ese código no tiene ` +
              'almacén configurado. Hay que ligarlo como destino de traspaso en Almacén › Movimientos.',
          );
        embarque = e;
      }

      // Lo que identifica al documento del ERP. Un documento se recibe UNA vez (guard de abajo).
      const sourceRef: string | null = erpHeader
        ? `${erpHeader.sucursal}/${erpHeader.folio}`
        : embarque
          ? transferRef(embarque)
          : null;
      const docLabel = embarque
        ? `El embarque ${embarque.origen}-${embarque.serie}-${embarque.folio}`
        : `El folio ${sourceRef}`;

      // Almacén: lo que mande el cliente, y si no, el que dice la orden del ERP.
      // GUARD: un folio del ERP se recibe UNA vez.
      //
      // El vale no escribe stock, pero la captura de lotes (Pieza 2) sí: si el mismo
      // folio se abre dos veces y ambos se capturan, entra el DOBLE de mercancía y no
      // se detecta hasta un conteo físico. No había nada que lo impidiera —ni unique
      // ni validación— y buscar por folio bajó tanto la fricción de abrir un vale que
      // el error pasó de improbable a fácil.
      //
      // Es un aviso, no un candado de schema: se puede forzar con `force: true` para
      // el caso legítimo (el vale anterior se canceló y hay que rehacerlo).
      if (sourceRef && !dto.force) {
        const previo = await trx('commercial.receiving_sessions')
          .where({ source_ref: sourceRef })
          .whereNot('status', 'cancelled')
          .orderBy('created_at', 'desc')
          .first('id', 'folio', 'status', 'created_at');
        if (previo)
          // Payload estructurado, no sólo texto: la pantalla necesita saber CUÁL es el
          // vale previo para abrirlo, y si está cerrado ya no se puede cancelar —
          // decirle al usuario "cancelá el anterior" ahí lo dejaba sin salida.
          throw new ConflictException({
            statusCode: 409,
            error: 'folio_ya_recibido',
            message:
              `${docLabel} ya se recibió en el vale ${previo.folio} (${previo.status}). ` +
              (previo.status === 'closed'
                ? 'Revisalo antes de volver a recibirlo; si de verdad llegó otra vez, recibilo de nuevo a propósito.'
                : 'Revisalo antes de volver a recibirlo; si de verdad hay que rehacerlo, cancelá el anterior.'),
            previous: {
              id: previo.id,
              folio: previo.folio,
              status: previo.status,
              created_at: previo.created_at,
              /** Una sesión cerrada ya escribió inventario: no se cancela, se rehace con `force`. */
              can_cancel: previo.status !== 'closed',
            },
          });
      }

      const warehouseId =
        dto.warehouse_id ||
        (erpHeader ? await this.resolveWarehouse(trx, erpHeader) : embarque ? embarque.warehouse_id : null);
      if (!warehouseId)
        throw new BadRequestException(
          'No pude determinar el almacén de destino: configurá el mapa sucursal→almacén ("Almacenes×sucursal")',
        );

      const year = new Date().getFullYear();
      const seqRes = await trx.raw(
        `INSERT INTO commercial.receiving_session_sequences (tenant_id, year, last_seq)
           VALUES (public.current_tenant_id(), ?, 1)
         ON CONFLICT (tenant_id, year)
           DO UPDATE SET last_seq = commercial.receiving_session_sequences.last_seq + 1
         RETURNING last_seq`,
        [year],
      );
      const folio = `VE-${year}-${String(seqRes.rows[0].last_seq).padStart(5, '0')}`;

      // El proveedor se AUTOLLENA desde la orden del ERP (código o razón social). En un
      // traspaso es el código `TI###` con que Kepler nombra a la sucursal que EMBARCA, sólo
      // si el mapa lo resuelve sin ambigüedad; si no, queda vacío. El origen del vale no
      // depende de este código: se lee de la referencia del embarque, que es un hecho.
      const supplierCode = erpHeader
        ? (erpHeader.proveedor_code || erpHeader.proveedor_nombre || null)
        : embarque
          ? await this.codigoTraspasoDe(trx, embarque.origen_warehouse_id)
          : (dto.supplier_code || null);

      const [session] = await trx('commercial.receiving_sessions')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          folio,
          warehouse_id: warehouseId,
          supplier_code: supplierCode,
          source_kind: sourceKind,
          source_ref: sourceRef,
          status: 'open',
          notes: dto.notes || null,
          created_by: userId,
          // Sólo con llave: así el código no depende de que la migración ya esté aplicada
          // para los equipos que todavía no la mandan.
          ...(clientUuid ? { client_uuid: clientUuid } : {}),
        })
        .returning('*');

      // Precarga de lo que el vale espera: de la orden de entrada o, en un traspaso
      // (`[WMS-REC.17]`), de lo que la sucursal de origen subió al camión.
      // `[WMS-REC.20]` La arma `lineasEsperadas`, la MISMA función que el paquete sin red: así una
      // captura hecha sin red cae, al sincronizar, en el renglón de su producto.
      const doc: DocErp | null = erpHeader
        ? { tipo: 'compra', sucursal: erpHeader.sucursal, folio: erpHeader.folio }
        : embarque
          ? { tipo: 'traspaso', sucursal: embarque.origen, serie: embarque.serie, folio: embarque.folio }
          : null;
      if (doc) {
        const lineas = (await this.lineasEsperadas(trx, [doc])).get(claveDoc(doc)) ?? [];
        if (lineas.length)
          await trx('commercial.receiving_lines').insert(
            lineas.map((el) => ({
              tenant_id: trx.raw('public.current_tenant_id()'),
              session_id: session.id,
              product_id: el.product_id,
              expected_sku: el.expected_sku,
              expected_name: el.expected_name,
              expected_qty: el.expected_qty,
              received_qty: 0,
              discrepancy_kind: 'pending',
            })),
          );
      }
      return this.detailTx(trx, session.id);
    });
  }

  /**
   * `[WMS-REC.20]` **Lo que esperan uno o varios vales, en una pasada.**
   *
   * La usan `open()` (un documento) y `offlinePack()` (todos los de una sucursal). Que sea UNA
   * función es la garantía de que el renglón que el equipo trabajó sin red y el que el servidor
   * crea al abrir son el mismo: mismo producto por SKU, misma cantidad, los `SER` (flete,
   * maniobra) fuera — no son mercancía, no se reciben ni se ubican.
   *
   * El orden es el de Kepler (`linea` en la orden de entrada, `nro_linea` en el embarque). La
   * unidad se deriva por SKU dentro del documento, como en el detalle: si trae dos, `ambigua`.
   */
  private async lineasEsperadas(trx: Knex.Transaction, docs: DocErp[]): Promise<Map<string, AndenLineaOffline[]>> {
    const tenantId = this.tenantCtx.get()?.tenantId || null;
    const compras = docs.filter((d): d is Extract<DocErp, { tipo: 'compra' }> => d.tipo === 'compra');
    const traspasos = docs.filter((d): d is Extract<DocErp, { tipo: 'traspaso' }> => d.tipo === 'traspaso');
    const filas: Array<{ clave: string; sku: string | null; nombre: string | null; cantidad: unknown; unidad: string | null }> = [];

    if (compras.length) {
      const rs = await trx('analytics.erp_goods_receipt_lines')
        .where({ tenant_id: tenantId })
        .whereIn(['sucursal', 'folio'], compras.map((d) => [d.sucursal, d.folio]))
        .whereRaw(`COALESCE(TRIM(unidad),'') <> 'SER'`)
        .orderBy('sucursal')
        .orderBy('folio')
        .orderByRaw('length(linea), linea')
        .select('sucursal', 'folio', 'sku', 'nombre', 'cantidad', 'unidad');
      for (const r of rs)
        filas.push({ clave: claveDoc({ tipo: 'compra', sucursal: r.sucursal, folio: r.folio }), sku: r.sku, nombre: r.nombre, cantidad: r.cantidad, unidad: r.unidad });
    }
    if (traspasos.length) {
      const rs = await trx('analytics.erp_shipment_lines')
        .where({ tenant_id: tenantId })
        .whereIn(['sucursal', 'serie', 'folio'], traspasos.map((d) => [d.sucursal, d.serie, d.folio]))
        .whereRaw(`COALESCE(TRIM(unidad),'') <> 'SER'`)
        .orderBy('sucursal')
        .orderBy('serie')
        .orderBy('folio')
        .orderBy('nro_linea')
        .select('sucursal', 'serie', 'folio', 'sku', 'descripcion', 'cantidad', 'unidad');
      for (const r of rs)
        filas.push({
          clave: claveDoc({ tipo: 'traspaso', sucursal: r.sucursal, serie: Number(r.serie), folio: r.folio }),
          sku: r.sku, nombre: r.descripcion, cantidad: r.cantidad, unidad: r.unidad,
        });
    }

    const productos = await this.productosPorSku(trx, filas.map((f) => String(f.sku || '')));
    const unidades = new Map<string, Set<string>>();
    for (const f of filas) {
      const u = String(f.unidad || '').trim();
      if (!u) continue;
      const k = `${f.clave}|${f.sku}`;
      const set = unidades.get(k) ?? new Set<string>();
      set.add(u);
      unidades.set(k, set);
    }

    const out = new Map<string, AndenLineaOffline[]>(docs.map((d) => [claveDoc(d), []]));
    for (const f of filas) {
      const p = f.sku ? productos.get(String(f.sku)) : undefined;
      const us = unidades.get(`${f.clave}|${f.sku}`);
      out.get(f.clave)?.push({
        expected_sku: f.sku || null,
        expected_name: f.nombre || null,
        expected_qty: Number(f.cantidad) || 0,
        expected_unit: !us ? null : us.size > 1 ? 'ambigua' : [...us][0],
        product_id: p?.id ?? null,
        sku: p?.sku ?? null,
        product_name: p?.nombre ?? null,
      });
    }
    return out;
  }

  /**
   * `[WMS-REC.20]` El producto del catálogo de cada SKU de Kepler, en UNA consulta.
   *
   * Antes `open()` hacía un `.first()` por renglón y sin orden: con un SKU repetido en el catálogo
   * se quedaba con cualquiera. Ahora prefiere el vivo y desempata por id — y elige igual para abrir
   * y para el paquete sin red. Si eligieran distinto, la captura hecha sin red chocaría al
   * sincronizar con "El renglón corresponde a otro producto".
   */
  private async productosPorSku(trx: Knex.Transaction, skus: string[]): Promise<Map<string, { id: string; sku: string; nombre: string | null }>> {
    const unicos = [...new Set(skus.filter(Boolean))];
    if (!unicos.length) return new Map();
    const rows: Array<{ id: string; sku: string; nombre: string | null }> = await trx('public.products')
      .whereIn('sku', unicos)
      .distinctOn('sku')
      .orderBy('sku')
      .orderByRaw('(deleted_at IS NOT NULL), id')
      .select('id', 'sku', 'nombre');
    return new Map(rows.map((r) => [String(r.sku), r]));
  }

  /**
   * `[WMS-REC.20]` **El paquete para trabajar sin red**: los vales del menú de una sucursal (los
   * mismos que `pendingErpOrders`, con su alcance) y lo que espera cada uno. El equipo lo baja
   * mientras tiene red; sin ella abre el vale desde aquí y lo sincroniza al volver.
   *
   * Cuesta una consulta de renglones por TIPO de documento, no una por vale. No medido en prod.
   */
  async offlinePack(sucursal: string): Promise<AndenPaqueteOffline> {
    const vales = await this.pendingErpOrders(sucursal, 200);
    return this.tk.run(async (trx) => {
      const docs = vales.map(docDeVale);
      const lineas = await this.lineasEsperadas(trx, docs);
      return {
        sucursal: String(sucursal).trim(),
        generado_en: new Date().toISOString(),
        vales: vales.map((v, i) => ({ ...v, lineas: lineas.get(claveDoc(docs[i])) ?? [] })),
      };
    });
  }

  /**
   * `[WMS-REC.22]` **Llegadas al andén**: qué camiones llegaron, qué traían y si se les capturó la
   * caducidad. Los documentos de Kepler de la ventana del Andén (órdenes de entrada y traspasos),
   * cada uno con su vale si lo tiene, más los vales manuales abiertos en la ventana.
   *
   * Lo que este monitor agrega sobre «Por fechar» es el camión **sin abrir**: Kepler ya le dio
   * entrada y nadie abrió el vale, así que su mercancía está en el inventario sin caducidad y no
   * aparece en ninguna bandeja.
   *
   * Cuesta seis consultas sin importar cuántos camiones haya: órdenes, embarques, vales, renglones,
   * lotes y lo que espera cada documento. Lo que espera cada documento lo arma `lineasEsperadas`, la
   * misma función de abrir el vale y del paquete sin red. La vista de órdenes de entrada es la más
   * cara (medio segundo, medido en el menú). No medido en prod.
   */
  async arrivals(): Promise<AndenLlegadas> {
    const tenantId = this.tenantCtx.get()?.tenantId || null;
    const alcance = await this.scope.current();
    const dim = alcance.dims.warehouse;
    const visible = (code: string | null) =>
      dim.mode === 'all' || (!!code && this.scope.canRead(alcance, 'warehouse', code));

    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT to_char(d, 'YYYY-MM-DD') AS hoy, to_char(d - ?::int, 'YYYY-MM-DD') AS desde
           FROM (SELECT (now() AT TIME ZONE 'America/Mexico_City')::date AS d) x`,
        [DIAS_PENDIENTES_ANDEN],
      );
      const hoy = String(rows[0].hoy);
      const desde = String(rows[0].desde);
      const generado_en = new Date().toISOString();
      if (dim.mode === 'none') return { hoy, desde, generado_en, llegadas: [] };

      // 1) Las órdenes de entrada de la ventana, con el almacén al que entran (misma cascada que
      //    el menú: el mapa de la sucursal, si no el que trae el espejo).
      const compras = (await trx('analytics.erp_goods_receipts as r')
        .leftJoin('commercial.erp_sucursal_warehouse as m', function (this: Knex.JoinClause) {
          this.on('m.tenant_id', '=', 'r.tenant_id').andOn('m.sucursal', '=', 'r.sucursal');
        })
        .leftJoin('commercial.warehouses as w', function (this: Knex.JoinClause) {
          this.on('w.tenant_id', '=', 'r.tenant_id').andOn('w.id', '=', trx.raw('COALESCE(m.warehouse_id, r.warehouse_id)'));
        })
        .where({ 'r.tenant_id': tenantId })
        .whereNull('r.dup_of_folio')
        .whereRaw(VENTANA_MX)
        .select(
          'r.sucursal', 'r.folio', 'r.proveedor_nombre', 'r.monto',
          // Como TEXTO: un `date` de pg llega como medianoche UTC = el día anterior (LC.16).
          trx.raw(`to_char(r.receipt_date, 'YYYY-MM-DD') AS receipt_date`),
          'w.id as warehouse_id', 'w.code as warehouse_code', 'w.name as warehouse_name',
        )) as FilaCompraLlegada[];

      // 2) Los traspasos de la ventana: salidos y por salir, recibidos o no.
      const traspasos = await this.embarques(trx, { ventana: true });

      const docCompra = (c: FilaCompraLlegada): DocErp => ({ tipo: 'compra', sucursal: c.sucursal, folio: c.folio });
      const docTraspaso = (e: FilaEmbarque): DocErp => ({ tipo: 'traspaso', sucursal: e.origen, serie: Number(e.serie), folio: e.folio });
      const docs = [...compras.map(docCompra), ...traspasos.map(docTraspaso)];
      const refs = docs.map(claveDoc);

      // 3) Los vales de esos documentos, y los manuales abiertos en la ventana.
      const vales = (await trx('commercial.receiving_sessions as s')
        .leftJoin('identity.users as u', 'u.id', 's.created_by')
        .leftJoin('commercial.warehouses as w', function (this: Knex.JoinClause) {
          this.on('w.tenant_id', '=', 's.tenant_id').andOn('w.id', '=', 's.warehouse_id');
        })
        .where('s.tenant_id', tenantId)
        .whereNot('s.status', 'cancelled')
        .where((q) => {
          if (refs.length) q.whereIn('s.source_ref', refs);
          q.orWhere((m) =>
            m.where('s.source_kind', 'manual')
              .whereRaw(`(s.created_at AT TIME ZONE 'America/Mexico_City')::date >= ?::date`, [desde]),
          );
        })
        .orderBy('s.created_at', 'desc')
        .select(
          's.id', 's.folio', 's.source_kind', 's.source_ref', 's.status', 's.created_at', 's.closed_at',
          's.warehouse_id', 'w.code as warehouse_code', 'w.name as warehouse_name',
          trx.raw(`to_char((s.created_at AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS dia`),
          trx.raw(`COALESCE(NULLIF(btrim(u.nombre), ''), u.username) AS abierto_por`),
        )) as FilaValeLlegada[];

      // Un documento tiene a lo más un vale vivo; si hubiera dos, manda el más reciente.
      const valeDe = new Map<string, FilaValeLlegada>();
      for (const v of vales)
        if (v.source_kind !== 'manual' && v.source_ref && !valeDe.has(v.source_ref)) valeDe.set(v.source_ref, v);

      // 4) Los renglones y los lotes de esos vales, en dos consultas.
      const ids = vales.map((v) => v.id);
      const renglones = ids.length
        ? ((await trx('commercial.receiving_lines as l')
            .leftJoin('public.products as p', 'p.id', 'l.product_id')
            .whereIn('l.session_id', ids)
            .orderBy('l.created_at')
            .orderBy('l.id')
            .select(
              'l.id', 'l.session_id', 'l.expected_qty',
              trx.raw('COALESCE(p.sku, l.expected_sku) AS sku'),
              trx.raw('COALESCE(p.nombre, l.expected_name) AS nombre'),
              // La misma regla que «Incompletos» en el menú: lo que el vale todavía espera.
              trx.raw(`(l.discrepancy_kind = 'pending' AND l.expected_qty > 0) AS pendiente`),
            )) as Array<RenglonValeCrudo & { session_id: string }>)
        : [];
      const lotes = ids.length
        ? ((await trx('commercial.receiving_lot_captures as c')
            .join('commercial.receiving_lines as l', 'l.id', 'c.receiving_line_id')
            .whereIn('l.session_id', ids)
            .orderBy('c.created_at')
            .select(
              'c.receiving_line_id', 'c.quantity', 'c.confirmed_lot', 'c.verdict', 'c.status',
              trx.raw(`to_char(c.confirmed_expiry, 'YYYY-MM-DD') AS confirmed_expiry`),
            )) as Array<LoteCrudo & { receiving_line_id: string }>)
        : [];
      const lotesDe = new Map<string, ReturnType<typeof aLote>[]>();
      for (const c of lotes) {
        const lista = lotesDe.get(c.receiving_line_id) ?? [];
        lista.push(aLote(c));
        lotesDe.set(c.receiving_line_id, lista);
      }
      const renglonesDe = new Map<string, RenglonValeCrudo[]>();
      for (const r of renglones) {
        const lista = renglonesDe.get(r.session_id) ?? [];
        lista.push(r);
        renglonesDe.set(r.session_id, lista);
      }

      // 5) Lo que manda Kepler en cada documento: los renglones de los que no tienen vale y la
      //    unidad de los que sí.
      const esperadas = docs.length ? await this.lineasEsperadas(trx, docs) : new Map<string, AndenLineaOffline[]>();

      const valeDto = (v: FilaValeLlegada) => ({
        id: v.id,
        folio: v.folio,
        status: v.status,
        abierto_en: new Date(v.created_at).toISOString(),
        abierto_por: v.abierto_por,
        cerrado_en: v.closed_at ? new Date(v.closed_at).toISOString() : null,
      });
      const renglonesDelDoc = (clave: string, v: FilaValeLlegada | undefined) => {
        const kepler = esperadas.get(clave) ?? [];
        return v ? renglonesDeVale(renglonesDe.get(v.id) ?? [], lotesDe, unidadesPorSku(kepler)) : renglonesDeKepler(kepler);
      };

      const llegadas: AndenLlegada[] = [];
      for (const c of compras) {
        if (!visible(c.warehouse_code)) continue;
        const clave = claveDoc(docCompra(c));
        const v = valeDe.get(clave);
        llegadas.push(armarLlegada({
          clave, tipo: 'compra', dia: c.receipt_date,
          warehouse_id: c.warehouse_id, warehouse_code: c.warehouse_code, warehouse_name: c.warehouse_name,
          documento: clave, proveedor: c.proveedor_nombre,
          origen_code: null, origen_nombre: null, salio: null, recibido_kepler: null,
          importe: c.monto == null ? null : Number(c.monto),
          vale: v ? valeDto(v) : null,
          renglones: renglonesDelDoc(clave, v),
        }));
      }
      for (const e of traspasos) {
        if (!visible(e.warehouse_code)) continue;
        const clave = claveDoc(docTraspaso(e));
        const v = valeDe.get(clave);
        llegadas.push(armarLlegada({
          clave, tipo: 'traspaso',
          // Cuenta el día que llegó: el de Kepler si ya lo recibió, el del vale si se abrió antes.
          dia: e.recibido_kepler ?? v?.dia ?? e.fecha,
          warehouse_id: e.warehouse_id, warehouse_code: e.warehouse_code, warehouse_name: e.warehouse_name,
          documento: `Embarque ${e.origen}-${e.serie}-${e.folio}`, proveedor: null,
          origen_code: e.origen, origen_nombre: e.origen_nombre, salio: e.fecha, recibido_kepler: e.recibido_kepler,
          importe: e.monto == null ? null : Number(e.monto),
          vale: v ? valeDto(v) : null,
          renglones: renglonesDelDoc(clave, v),
        }));
      }
      for (const v of vales) {
        if (v.source_kind !== 'manual' || !visible(v.warehouse_code)) continue;
        llegadas.push(armarLlegada({
          clave: `VE:${v.id}`, tipo: 'manual', dia: v.dia,
          warehouse_id: v.warehouse_id, warehouse_code: v.warehouse_code, warehouse_name: v.warehouse_name,
          documento: null, proveedor: null, origen_code: null, origen_nombre: null, salio: null, recibido_kepler: null,
          importe: null,
          vale: valeDto(v),
          renglones: renglonesDeVale(renglonesDe.get(v.id) ?? [], lotesDe, new Map()),
        }));
      }
      return { hoy, desde, generado_en, llegadas };
    });
  }

  /**
   * Resuelve la cabecera de una orden de entrada del ERP por (sucursal, folio). Acepta
   * el folio COMPLETO o solo los últimos dígitos (búsqueda por sufijo, la más reciente).
   */
  /**
   * Almacén destino de una orden del ERP: primero el crosswalk configurado, si no
   * el que ya trae el espejo.
   *
   * Valida que el almacén EXISTA para este tenant antes de devolverlo: el espejo
   * `analytics.*` no tiene RLS y su `warehouse_id` puede haber quedado apuntando a
   * un almacén borrado o de otro tenant. Sin esta comprobación el insert reventaba
   * con un 500 por violación de FK en vez de un mensaje que se entienda.
   */
  private async resolveWarehouse(trx: any, erpHeader: any): Promise<string | null> {
    const exists = async (id: string | null | undefined) => {
      if (!id || !UUID.test(id)) return null;
      const w = await trx('commercial.warehouses').where({ id }).first('id');
      return w?.id || null;
    };
    const map = await trx('commercial.erp_sucursal_warehouse')
      .where('sucursal', erpHeader.sucursal)
      .first('warehouse_id');
    return (await exists(map?.warehouse_id)) || (await exists(erpHeader.warehouse_id));
  }

  private async findErpHeader(trx: any, sucursal: string, folioInput: string) {
    const tenantId = this.tenantCtx.get()?.tenantId || null;
    const f = String(folioInput || '').trim();
    if (!f) return null;
    let row = await trx('analytics.erp_goods_receipts')
      .where({ tenant_id: tenantId, sucursal }).where('folio', f)
      .first('sucursal', 'folio', 'proveedor_code', 'proveedor_nombre', 'monto', 'receipt_date', 'warehouse_id');
    if (!row) {
      row = await trx('analytics.erp_goods_receipts')
        .where({ tenant_id: tenantId, sucursal })
        .whereRaw('RIGHT(folio, ?) = ?', [f.length, f])
        .orderBy('receipt_date', 'desc')
        .first('sucursal', 'folio', 'proveedor_code', 'proveedor_nombre', 'monto', 'receipt_date', 'warehouse_id');
    }
    return row || null;
  }

  /**
   * Busca una orden de entrada del ERP (para el diálogo "Nueva sesión"): devuelve el
   * folio completo, el proveedor (autollenado) y cuántas líneas trae. Por últimos dígitos.
   */
  /**
   * Busca órdenes de entrada del ERP **solo por folio**, en todas las sucursales.
   *
   * El folio de Kepler es por sucursal, así que el mismo número existe en varias
   * (verificado en prod: `0000001` vive en 7). Por eso devuelve una LISTA para que
   * el operador elija, en vez de adivinar una. Excluye los vales marcados como
   * duplicado (`dup_of_folio`), que son réplicas del feed y no entradas reales.
   *
   * Todo lo que necesita el vale sale de acá: no hace falta preguntar sucursal ni
   * almacén — se derivan de la orden elegida.
   */
  /**
   * **El menu del Anden: a que sucursal entra la mercancia.**
   *
   * Reemplaza al "tecleá el folio" como primer paso. El bodeguero ya no tiene que
   * leer el papel para empezar: ve las plazas que le tocan y cuanto falta por
   * recibir en cada una.
   *
   * **Pendiente = el vale existe en el espejo de Kepler y NADIE lo abrio todavia**
   * (no hay `receiving_sessions.source_ref = sucursal/folio`). Se deriva, no se
   * guarda: una bandera "ya recibido" se desincroniza en cuanto alguien cancela
   * una sesion.
   *
   * **El alcance se filtra por el ALMACEN, no por la sucursal**, y la diferencia
   * es real: la sucursal `30` entra al almacen `08`, la `50` al `06` y la `32` a
   * `MD-32`. Filtrar por el codigo de sucursal le escondería al bodeguero de
   * Morelia justo los vales que le llegan por la sucursal 30.
   *
   * **El almacen se resuelve igual que en `open()`**: crosswalk y, si no hay
   * fila, el `warehouse_id` que el propio espejo trae. Tiene que ser la MISMA
   * cascada o el menu ofreceria vales que despues rebotan con 400. Medido en
   * prod: `erp_sucursal_warehouse` no tiene fila para las sucursales `06` ni
   * `07`, y aun asi las dos resuelven almacen por el respaldo — por eso se
   * copia la cascada entera y no solo el crosswalk.
   *
   * Si alguna vez NO resuelve, la fila sale marcada (`sin_almacen`) en vez de
   * esconderse: `open()` la rechazaria con un 400, y es mejor decirlo antes del
   * toque que dejar al operario sin entender por que su vale no aparece.
   */
  /**
   * La fila cruda del ERP -> el vale que la pantalla consume.
   *
   * Existe porque `erp-search` y `erp-pending` DEBEN devolver la misma forma (el Anden usa
   * el mismo componente y el mismo camino de apertura para las dos). Estaba inline en la
   * busqueda, asi que `erp-pending` devolvia la fila cruda: sin `tipo`, sin `origin` y con
   * `monto` como string —Postgres entrega `numeric` asi—. El tipo del front lo declaraba
   * obligatorio igual, de modo que un traspaso llegado por el menu se habria leido como
   * compra. Hoy nadie lo pinta desde ese camino, pero la forma ya mentia.
   */
  private aErpOrderMatch(r: Record<string, unknown>): ErpOrderMatch {
    // Una sola definición de "de dónde viene" (receiving-origin.ts), acá y en
    // el detalle del vale, para que al ABRIR el vale la pantalla siga sabiendo
    // si era traspaso o compra — justo cuando el operario lo necesita para
    // saber a quién reclamar.
    const origin = classifyReceivingOrigin(r['proveedor_code'] as string | null, r['proveedor_nombre'] as string | null);
    return {
      ...(r as unknown as ErpOrderMatch),
      monto: Number(r['monto']) || 0,
      origin,
      // `tipo` se conserva por compatibilidad con lo que ya lo consume.
      tipo: origin.kind === 'transfer' ? 'traspaso' : 'compra',
      fuente: 'orden_entrada',
    };
  }

  /**
   * `[WMS-REC.17]` **Los embarques de traspaso (`U-D-41`) hacia una sucursal.**
   *
   * Una sola consulta para los cuatro usos (menú, vales de una sucursal, búsqueda por folio y
   * abrir el vale), para que el destino, el origen y el "ya llegó a Kepler" se resuelvan igual
   * en todos — si dos caminos lo resolvieran distinto, el menú ofrecería vales que después
   * rebotan al abrirlos (la misma lección que la cascada de almacén de `open()`).
   *
   *  · **Destino:** `c10` (`TI###`) → `analytics.transfer_dest_map`, el mapa curado que ya usa
   *    Almacén › Movimientos, y sólo hacia un almacén VIVO (`[DM.15]`: un almacén retirado no
   *    puede ser destino). Sin mapa, `warehouse_id` queda NULL y se DECLARA, no se adivina.
   *  · **Origen:** la sucursal donde vive el documento — es un hecho, no se deduce de un código.
   *  · **¿Ya llegó a Kepler?** la recepción `U-A-50` de la sucursal destino que apunta a este
   *    embarque (`c37`=41, `c38`=serie, `c39`=folio). Es informativo: que Kepler lo haya
   *    recibido NO quiere decir que alguien le capturó la caducidad, que es lo que hace el Andén.
   *
   * Lee `kepler_ods` en vivo (derive-no-copy, sin importer). Los filtros usan las mismas
   * expresiones que los índices que ya existen: `ix_kdm1_venta_fecha` para la ventana,
   * `ix_kdm1_venta_doc` para un embarque exacto y `ix_kdm1_abono_doc` para la recepción.
   */
  private async embarques(
    trx: Knex.Transaction,
    f: { key?: TransferKey; folio?: string; ventana?: boolean; conRenglones?: boolean },
  ): Promise<Array<FilaEmbarque & { line_count?: number }>> {
    const tenantId = this.tenantCtx.get()?.tenantId || null;
    const filtros: string[] = [];
    const binds: Knex.RawBinding[] = [];
    if (f.key) {
      filtros.push('AND btrim(h.sucursal) = ? AND (h.c5)::int = ?::int AND btrim(h.c6::text) = ?');
      binds.push(f.key.origen, f.key.serie, f.key.folio);
    }
    if (f.folio) {
      // Mismo criterio que la busqueda de ordenes de entrada: folio completo o sus ultimos digitos.
      filtros.push(`AND (btrim(h.c6::text) = ? OR RIGHT(btrim(h.c6::text), ?::int) = ?)
         AND (h.c9::date) >= (SELECT d FROM hoy) - 45`);
      binds.push(f.folio, f.folio.length, f.folio);
    }
    if (f.ventana) {
      filtros.push('AND (h.c9::date) BETWEEN (SELECT d FROM hoy) - ?::int AND (SELECT d FROM hoy) + ?::int');
      binds.push(TRANSFER_WINDOW_DAYS, TRANSFER_WINDOW_DAYS);
    }
    binds.push(tenantId); // abierto
    const renglones = f.conRenglones
      ? `(SELECT COUNT(*) FROM analytics.erp_shipment_lines l
           WHERE l.tenant_id = ?::uuid AND l.sucursal = e.origen AND l.serie = e.serie
             AND l.folio = e.folio AND COALESCE(TRIM(l.unidad), '') <> 'SER')::int AS line_count,`
      : '';
    if (f.conRenglones) binds.push(tenantId);
    binds.push(tenantId, tenantId, tenantId, tenantId, tenantId); // dm, wd, mo, wom, woc

    const { rows } = await trx.raw(
      `WITH hoy AS (SELECT (now() AT TIME ZONE 'America/Mexico_City')::date AS d),
       emb AS (
         SELECT btrim(h.sucursal) AS origen, (h.c5)::int AS serie, btrim(h.c6::text) AS folio,
                (h.c9::date) AS fecha, btrim(h.c10) AS destino_code,
                NULLIF(btrim(h.c32), '') AS destino_nombre,
                round(COALESCE(NULLIF(regexp_replace(h.c16::text, '[^0-9.-]', '', 'g'), '')::numeric, 0), 2) AS monto,
                NULLIF(btrim(h.c24), '') AS comentarios
           FROM kepler_ods.kdm1 h
          WHERE h.c2 = 'U' AND h.c3 = 'D' AND (h.c4)::int = 41
            AND btrim(h.c1) = btrim(h.sucursal)
            AND btrim(COALESCE(h.c43, '')) <> 'C'
            AND btrim(h.c10) ~ '^TI[0-9]'
            ${filtros.join('\n            ')}
       )
       SELECT e.origen, e.serie, e.folio, to_char(e.fecha, 'YYYY-MM-DD') AS fecha,
              e.destino_code, e.destino_nombre, e.monto, e.comentarios,
              wd.id AS warehouse_id, wd.code AS warehouse_code, wd.name AS warehouse_name,
              COALESCE(wom.id, woc.id) AS origen_warehouse_id,
              COALESCE(wom.name, woc.name) AS origen_nombre,
              to_char(rk.fecha, 'YYYY-MM-DD') AS recibido_kepler,
              EXISTS (
                SELECT 1 FROM commercial.receiving_sessions s
                 WHERE s.tenant_id = ?::uuid AND s.status <> 'cancelled'
                   AND s.source_ref = '${TRANSFER_REF_PREFIX}/' || e.origen || '/' || e.serie || '/' || e.folio
              ) AS abierto,
              ${renglones}
              to_char((SELECT d FROM hoy), 'YYYY-MM-DD') AS hoy
         FROM emb e
         LEFT JOIN analytics.transfer_dest_map dm
           ON dm.tenant_id = ?::uuid AND dm.dest_code = e.destino_code
         LEFT JOIN commercial.warehouses wd
           ON wd.tenant_id = ?::uuid AND wd.id = dm.warehouse_id AND wd.deleted_at IS NULL
         LEFT JOIN commercial.erp_sucursal_warehouse mo
           ON mo.tenant_id = ?::uuid AND mo.sucursal = e.origen
         LEFT JOIN commercial.warehouses wom
           ON wom.tenant_id = ?::uuid AND wom.id = mo.warehouse_id AND wom.deleted_at IS NULL
         LEFT JOIN commercial.warehouses woc
           ON woc.tenant_id = ?::uuid AND woc.code = e.origen AND woc.deleted_at IS NULL
         LEFT JOIN LATERAL (
           SELECT (x.c9::date) AS fecha
             FROM kepler_ods.kdm1 x
            WHERE x.c2 = 'U' AND x.c3 = 'A'
              AND btrim(x.sucursal) = COALESCE(NULLIF(btrim(wd.kepler_code), ''), wd.code)
              AND btrim(x.c1) = COALESCE(NULLIF(btrim(wd.kepler_code), ''), wd.code)
              AND (x.c4)::int = 50
              AND x.c37 = 41 AND x.c38 = e.serie AND btrim(x.c39::text) = e.folio
              AND btrim(COALESCE(x.c43, '')) <> 'C'
              AND (x.c9::date) >= e.fecha - 1
            ORDER BY x.c9
            LIMIT 1
         ) rk ON wd.id IS NOT NULL
        ORDER BY e.fecha DESC, e.origen, e.folio DESC
        LIMIT 1000`,
      binds,
    );
    return rows;
  }

  /**
   * El codigo `TI###` con que Kepler nombra a un almacen como DESTINO de traspasos. Se usa al
   * reves (para el que embarca) y solo si el mapa lo resuelve a UN codigo: con dos, no se elige.
   */
  private async codigoTraspasoDe(trx: Knex.Transaction, warehouseId: string | null): Promise<string | null> {
    if (!warehouseId) return null;
    const tenantId = this.tenantCtx.get()?.tenantId || null;
    const filas = await trx('analytics.transfer_dest_map')
      .where({ tenant_id: tenantId, warehouse_id: warehouseId })
      .select('dest_code');
    return filas.length === 1 ? String(filas[0].dest_code) : null;
  }

  /** Un embarque, en la misma forma que una orden de entrada: el Andén usa un solo camino. */
  private embarqueAErpOrderMatch(e: FilaEmbarque & { line_count?: number }): ErpOrderMatch {
    return {
      sucursal: e.origen,
      folio: e.folio,
      serie: e.serie,
      receipt_date: e.fecha,
      proveedor_code: null,
      proveedor_nombre: e.origen_nombre,
      concepto: e.comentarios,
      monto: Number(e.monto) || 0,
      warehouse_id: e.warehouse_id,
      warehouse_code: e.warehouse_code,
      warehouse_name: e.warehouse_name,
      line_count: Number(e.line_count) || 0,
      service_count: 0,
      origin: classifyShipmentOrigin(e.origen, e.origen_nombre),
      tipo: 'traspaso',
      fuente: 'embarque',
      recibido_kepler: e.recibido_kepler,
      dias_en_camino: diasEntre(e.fecha, e.hoy),
      destino_code: e.destino_code,
      destino_nombre: e.destino_nombre,
    };
  }

  /** Los embarques que el menu ofrece: no abiertos, dentro de la regla de dia del traspaso. */
  private async embarquesPendientes(trx: Knex.Transaction): Promise<FilaEmbarque[]> {
    const todos = await this.embarques(trx, { ventana: true });
    return todos.filter(
      (e) => !e.abierto && transferVisible({ fecha: e.fecha, hoy: e.hoy, recibidoKepler: e.recibido_kepler }),
    );
  }

  async pendingErpBranches(): Promise<ErpPendingMenu> {
    const tenantId = this.tenantCtx.get()?.tenantId || null;
    const alcance = await this.scope.current();
    const dim = alcance.dims.warehouse;
    // El MODO viaja con la respuesta: la pantalla avisa "estas viendo todas
    // porque tu usuario no tiene una asignada" y eso tiene que ser un hecho
    // leido del alcance, no una suposicion por la cantidad de filas (un usuario
    // legitimamente asignado a tres plazas veria el mismo aviso, y seria falso).
    if (dim.mode === 'none') return { alcance: dim.mode, sucursales: [] };

    return this.tk.run(async (trx) => {
      const q = trx('analytics.erp_goods_receipts as r')
        .where({ 'r.tenant_id': tenantId })
        .whereNull('r.dup_of_folio')
        .whereRaw(VENTANA_MX)
        .whereNotExists(function (this: Knex.QueryBuilder) {
          // `[WMS-REC.17]` Un vale CANCELADO ya no tapa al documento: `open()` deja reabrirlo
          // sin `force`, y el menu lo escondia para siempre — el bodeguero no tenia como volver.
          this.select(trx.raw('1'))
            .from('commercial.receiving_sessions as s')
            .whereRaw("s.source_ref = r.sucursal || '/' || r.folio")
            .andWhere('s.tenant_id', tenantId)
            .andWhereNot('s.status', 'cancelled');
        })
        .leftJoin('commercial.erp_sucursal_warehouse as m', function () {
          this.on('m.tenant_id', '=', 'r.tenant_id').andOn('m.sucursal', '=', 'r.sucursal');
        })
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'r.tenant_id').andOn('w.id', '=', trx.raw('COALESCE(m.warehouse_id, r.warehouse_id)'));
        })
        .groupBy('r.sucursal', 'w.id', 'w.code', 'w.name')
        .orderBy('w.code')
        .select(
          'r.sucursal',
          'w.id as warehouse_id',
          'w.code as warehouse_code',
          'w.name as warehouse_name',
          trx.raw('COUNT(*)::int as pendientes'),
          // `[WMS-REC.18]` Las atrasadas se cuentan aparte: la insignia dice cuantas son de antes.
          trx.raw(`COUNT(*) FILTER (WHERE NOT (${HOY_MX}))::int as anteriores`),
          // `[WMS-REC.17]` Como TEXTO `YYYY-MM-DD`: pg entrega un `date` como `Date` a medianoche
          // UTC, que en hora de Mexico es el dia ANTERIOR (LC.16). Y se compara contra la fecha
          // de los traspasos, que ya viene como texto.
          trx.raw(`to_char(MAX(r.receipt_date)::date, 'YYYY-MM-DD') as ultimo`),
        );

      // `all` no enumera; `listed`/`own` traen CODIGOS de almacen.
      if (dim.mode !== 'all' && dim.values.length) q.whereIn('w.code', dim.values);
      if (dim.mode !== 'all' && !dim.values.length) return { alcance: dim.mode, sucursales: [] };
      const filas = await q;
      const sucursales: ErpPendingBranch[] = filas.map((f: FilaMenuAnden): ErpPendingBranch => ({
        ...f,
        pendientes: Number(f.pendientes) || 0,
        compras: Number(f.pendientes) || 0,
        anteriores: Number(f.anteriores) || 0,
        traspasos: 0,
        // Sin mapa no se puede abrir el vale: la pantalla lo dice antes del toque.
        sin_almacen: !f.warehouse_id,
      }));

      // `[WMS-REC.17]` Los traspasos que vienen a cada almacen. Se suman a TODA fila de ese
      // almacen, porque `pendingErpOrders()` los lista desde cualquiera de ellas: la insignia
      // tiene que contar lo mismo que se ve al tocarla.
      const enAlcance = (code: string | null) => dim.mode === 'all' || (!!code && dim.values.includes(code));
      const porAlmacen = new Map<string, FilaEmbarque[]>();
      const sinDestino = new Map<string, FilaEmbarque[]>();
      for (const e of await this.embarquesPendientes(trx)) {
        if (e.warehouse_id) {
          if (!enAlcance(e.warehouse_code)) continue;
          porAlmacen.set(e.warehouse_id, [...(porAlmacen.get(e.warehouse_id) || []), e]);
        } else if (dim.mode === 'all') {
          // Un destino que el mapa no resuelve se DECLARA (solo a quien ve todo): esconderlo
          // es justo la falla que se esta arreglando, una mercancia que llega y nadie ve.
          sinDestino.set(e.destino_code, [...(sinDestino.get(e.destino_code) || []), e]);
        }
      }
      const ultimo = (es: FilaEmbarque[]) => es.map((e) => e.fecha).sort().slice(-1)[0] ?? null;
      for (const [whId, es] of porAlmacen) {
        const propias = sucursales.filter((b) => b.warehouse_id === whId);
        for (const b of propias) {
          b.traspasos = es.length;
          b.pendientes += es.length;
          const u = ultimo(es);
          if (u && (!b.ultimo || String(b.ultimo) < u)) b.ultimo = u;
        }
        if (!propias.length) {
          const e0 = es[0];
          sucursales.push({
            // El codigo del almacen es una sucursal que `pendingErpOrders()` resuelve de vuelta
            // a ESTE almacen (mapa sucursal->almacen, si no por codigo).
            sucursal: String(e0.warehouse_code),
            warehouse_id: whId,
            warehouse_code: e0.warehouse_code,
            warehouse_name: e0.warehouse_name,
            pendientes: es.length,
            compras: 0,
            anteriores: 0,
            traspasos: es.length,
            ultimo: ultimo(es),
            sin_almacen: false,
          });
        }
      }
      for (const [code, es] of sinDestino) {
        sucursales.push({
          sucursal: code,
          warehouse_id: null,
          warehouse_code: null,
          warehouse_name: es[0].destino_nombre || code,
          pendientes: es.length,
          compras: 0,
          anteriores: 0,
          traspasos: es.length,
          ultimo: ultimo(es),
          sin_almacen: true,
        });
      }
      sucursales.sort((a, b) => String(a.warehouse_code ?? 'zz').localeCompare(String(b.warehouse_code ?? 'zz')));
      return { alcance: dim.mode, sucursales };
    });
  }

  /**
   * Los vales pendientes de UNA sucursal, en la misma forma que devuelve la
   * busqueda por folio — asi la pantalla reusa el mismo tipo y el mismo camino
   * de apertura.
   */
  async pendingErpOrders(sucursal: string, limit = 100): Promise<ErpOrderMatch[]> {
    const suc = String(sucursal || '').trim();
    if (!suc) throw new BadRequestException('sucursal requerida');
    const tenantId = this.tenantCtx.get()?.tenantId || null;

    return this.tk.run(async (trx) => {
      // El alcance se valida contra el ALMACEN al que entra esa sucursal, no
      // contra el codigo de sucursal (30 -> 08, 50 -> 06, 32 -> MD-32).
      const destino = await trx('commercial.erp_sucursal_warehouse as m')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'm.tenant_id').andOn('w.id', '=', 'm.warehouse_id');
        })
        .where({ 'm.tenant_id': tenantId, 'm.sucursal': suc })
        .first('w.code as code', 'w.id as id');
      const alcance = await this.scope.current();
      if (destino?.code && !this.scope.canRead(alcance, 'warehouse', destino.code))
        throw new ForbiddenException('Esa sucursal no está en tu alcance');

      const filas = await trx('analytics.erp_goods_receipts as r')
        .where({ 'r.tenant_id': tenantId, 'r.sucursal': suc })
        .whereNull('r.dup_of_folio')
        .whereRaw(VENTANA_MX)
        .whereNotExists(function (this: Knex.QueryBuilder) {
          this.select(trx.raw('1'))
            .from('commercial.receiving_sessions as s')
            .whereRaw("s.source_ref = r.sucursal || '/' || r.folio")
            .andWhere('s.tenant_id', tenantId)
            .andWhereNot('s.status', 'cancelled');
        })
        .leftJoin('commercial.erp_sucursal_warehouse as m', function () {
          this.on('m.tenant_id', '=', 'r.tenant_id').andOn('m.sucursal', '=', 'r.sucursal');
        })
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'r.tenant_id').andOn('w.id', '=', trx.raw('COALESCE(m.warehouse_id, r.warehouse_id)'));
        })
        .orderBy('r.receipt_date', 'desc')
        .orderBy('r.folio', 'desc')
        .limit(Math.min(200, Math.max(1, Number(limit) || 100)))
        .select(
          'r.sucursal', 'r.folio',
          // `[WMS-REC.18]` Como TEXTO: la pantalla separa hoy de lo atrasado comparando contra la
          // fecha de Mexico, y un `date` de pg llega como medianoche UTC = el dia anterior (LC.16).
          trx.raw(`to_char(r.receipt_date, 'YYYY-MM-DD') AS receipt_date`),
          'r.proveedor_code', 'r.proveedor_nombre', 'r.proveedor_rfc',
          'r.oc_folio', 'r.vale_folio', 'r.concepto', 'r.monto',
          'w.id as warehouse_id', 'w.code as warehouse_code', 'w.name as warehouse_name',
          trx.raw(`(SELECT COUNT(*) FROM analytics.erp_goods_receipt_lines l
                     WHERE l.tenant_id = r.tenant_id AND l.sucursal = r.sucursal
                       AND l.folio = r.folio AND COALESCE(TRIM(l.unidad),'') <> 'SER')::int AS line_count`),
          trx.raw(`(SELECT COUNT(*) FROM analytics.erp_goods_receipt_lines l
                     WHERE l.tenant_id = r.tenant_id AND l.sucursal = r.sucursal
                       AND l.folio = r.folio AND TRIM(l.unidad) = 'SER')::int AS service_count`),
        );

      // `[WMS-REC.17]` Los traspasos que vienen al almacen de esta sucursal. El almacen se
      // resuelve con la misma cascada que el menu (mapa, si no por codigo).
      const destinoWh =
        destino?.id ||
        (await trx('commercial.warehouses').where({ tenant_id: tenantId, code: suc }).whereNull('deleted_at').first('id'))?.id ||
        null;
      const traspasos = destinoWh
        ? (await this.embarques(trx, { ventana: true, conRenglones: true })).filter(
            (e) =>
              e.warehouse_id === destinoWh &&
              this.scope.canRead(alcance, 'warehouse', String(e.warehouse_code)) &&
              !e.abierto &&
              transferVisible({ fecha: e.fecha, hoy: e.hoy, recibidoKepler: e.recibido_kepler }),
          )
        : [];

      // Misma forma que `erp-search`: la pantalla usa el mismo componente para las dos.
      return [...traspasos.map((e) => this.embarqueAErpOrderMatch(e)), ...filas.map((r) => this.aErpOrderMatch(r))];
    });
  }

  async searchErpOrders(folio: string, limit = 20) {
    const f = String(folio || '').trim();
    if (!/^\d{1,}$/.test(f)) throw new BadRequestException('Escribí el folio (solo dígitos)');
    const tenantId = this.tenantCtx.get()?.tenantId || null;

    return this.tk.run(async (trx) => {
      // `analytics.*` no tiene RLS → el tenant va explícito (GOTCHAS §1).
      const rows = await trx('analytics.erp_goods_receipts as r')
        .where({ 'r.tenant_id': tenantId })
        .whereNull('r.dup_of_folio')
        .where((b: any) => b.where('r.folio', f).orWhereRaw('RIGHT(r.folio, ?) = ?', [f.length, f]))
        .leftJoin('commercial.erp_sucursal_warehouse as m', function () {
          this.on('m.tenant_id', '=', 'r.tenant_id').andOn('m.sucursal', '=', 'r.sucursal');
        })
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'r.tenant_id').andOn('w.id', '=', trx.raw('COALESCE(m.warehouse_id, r.warehouse_id)'));
        })
        .orderBy('r.receipt_date', 'desc')
        .limit(Math.min(50, Math.max(1, Number(limit) || 20)))
        .select(
          'r.sucursal', 'r.folio', 'r.receipt_date',
          'r.proveedor_code', 'r.proveedor_nombre', 'r.proveedor_rfc',
          'r.oc_folio', 'r.vale_folio', 'r.concepto', 'r.monto',
          'w.id as warehouse_id', 'w.code as warehouse_code', 'w.name as warehouse_name',
          // Renglones de MERCANCÍA (los `SER` son fletes/maniobras, no se reciben).
          trx.raw(`(SELECT COUNT(*) FROM analytics.erp_goods_receipt_lines l
                     WHERE l.tenant_id = r.tenant_id AND l.sucursal = r.sucursal
                       AND l.folio = r.folio AND COALESCE(TRIM(l.unidad),'') <> 'SER')::int AS line_count`),
          trx.raw(`(SELECT COUNT(*) FROM analytics.erp_goods_receipt_lines l
                     WHERE l.tenant_id = r.tenant_id AND l.sucursal = r.sucursal
                       AND l.folio = r.folio AND TRIM(l.unidad) = 'SER')::int AS service_count`),
        );

      // `[WMS-REC.17]` El papel que trae el chofer de un traspaso es el EMBARQUE de quien
      // manda: buscar su folio tiene que encontrarlo.
      const embarques = await this.embarques(trx, { folio: f, conRenglones: true });
      return [...embarques.map((e) => this.embarqueAErpOrderMatch(e)), ...rows.map((r) => this.aErpOrderMatch(r))];
    });
  }

  async lookupErpOrder(sucursal: string, folio: string) {
    const suc = String(sucursal || '').trim();
    const f = String(folio || '').trim();
    if (!suc) throw new BadRequestException('Indica la sucursal del ERP');
    if (!/^\d{2,}$/.test(f)) throw new BadRequestException('Indica al menos los últimos dígitos del folio');
    return this.tk.run(async (trx) => {
      const row = await this.findErpHeader(trx, suc, f);
      if (!row) throw new NotFoundException('No encontré una orden de entrada con ese folio en esa sucursal');
      const tenantId = this.tenantCtx.get()?.tenantId || null;
      const lc = await trx('analytics.erp_goods_receipt_lines')
        .where({ tenant_id: tenantId, sucursal: row.sucursal, folio: row.folio })
        .count('* as c').first();
      // Traspaso interno = código de "proveedor" con prefijo TI (sucursal propia,
      // Kepler 01-06 + Wincaja). Todo lo demás (prefijo C…) = compra a proveedor externo.
      const tipo = /^TI/i.test(row.proveedor_code || '') ? 'traspaso' : 'compra';
      // Almacén destino sugerido desde el crosswalk sucursal→almacén (si está configurado).
      const wh = await trx('commercial.erp_sucursal_warehouse as m')
        .join('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'm.tenant_id').andOn('w.id', '=', 'm.warehouse_id');
        })
        .where('m.sucursal', row.sucursal)
        .first('w.id', 'w.code', 'w.name');
      return {
        sucursal: row.sucursal,
        folio: row.folio,
        proveedor_code: row.proveedor_code,
        proveedor_nombre: row.proveedor_nombre,
        monto: Number(row.monto) || 0,
        receipt_date: row.receipt_date,
        line_count: Number(lc?.c || 0),
        tipo,
        warehouse_id: wh?.id || null,
        warehouse_code: wh?.code || null,
        warehouse_name: wh?.name || null,
      };
    });
  }

  /** Mapa configurado sucursal ERP → almacén destino. */
  async getSucursalMap() {
    return this.tk.run(async (trx) =>
      trx('commercial.erp_sucursal_warehouse as m')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'm.tenant_id').andOn('w.id', '=', 'm.warehouse_id');
        })
        .select('m.sucursal', 'm.warehouse_id', 'w.code as warehouse_code', 'w.name as warehouse_name')
        .orderBy('m.sucursal'),
    );
  }

  /** Configura (upsert) el almacén destino de una sucursal ERP. */
  async setSucursalMap(sucursal: string, warehouseId: string) {
    const suc = String(sucursal || '').trim();
    if (!suc) throw new BadRequestException('sucursal requerida');
    if (!UUID.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');
    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;
      const wh = await trx('commercial.warehouses').where({ id: warehouseId }).first('id');
      if (!wh) throw new NotFoundException('Almacén no encontrado');
      await trx.raw(
        `INSERT INTO commercial.erp_sucursal_warehouse (tenant_id, sucursal, warehouse_id, updated_by)
           VALUES (public.current_tenant_id(), ?, ?, ?)
         ON CONFLICT (tenant_id, sucursal)
           DO UPDATE SET warehouse_id = EXCLUDED.warehouse_id, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [suc, warehouseId, userId],
      );
      return { sucursal: suc, warehouse_id: warehouseId };
    });
  }

  /** Escanea un código: resuelve producto y suma a su línea (o crea línea SOBRANTE). */
  async scan(sessionId: string, dto: ScanDto) {
    if (!UUID.test(sessionId)) throw new BadRequestException('session_id inválido');
    const qty = Number(dto.qty) > 0 ? Number(dto.qty) : 1;
    return this.tk.run(async (trx) => {
      const session = await trx('commercial.receiving_sessions').where({ id: sessionId }).first();
      if (!session) throw new NotFoundException('Sesión no encontrada');
      if (session.status !== 'open') throw new ConflictException(`La sesión está ${session.status}`);

      // Resolver producto por barcode o sku (public.products), o por product_id directo.
      let productId = dto.product_id || null;
      let prod: any = null;
      if (productId) {
        if (!UUID.test(productId)) throw new BadRequestException('product_id inválido');
        prod = await trx('public.products').where({ id: productId }).first('id', 'sku', 'nombre');
      } else {
        const code = String(dto.barcode || '').trim();
        if (!code) throw new BadRequestException('Se requiere barcode o product_id');
        prod = await this.resolveProductByCode(trx, code);
        productId = prod.id;
      }

      // Buscar línea existente del producto en la sesión.
      let line = await trx('commercial.receiving_lines')
        .where({ session_id: sessionId, product_id: productId })
        .forUpdate()
        .first();

      // Adopción por SKU. El renglón del vale llega del espejo del ERP con product_id
      // NULL cuando su SKU no casó con el catálogo al abrir la sesión — hoy la mayoría
      // de los renglones están así. Sin este paso, escanear algo que SÍ viene en el
      // vale no encontraba línea y se registraba como SOBRANTE: el operador ve
      // rechazada mercancía legítima y el conteo del vale queda mal.
      if (!line && prod?.sku) {
        line = await trx('commercial.receiving_lines')
          .where({ session_id: sessionId })
          .whereNull('product_id')
          .whereRaw('UPPER(TRIM(expected_sku)) = UPPER(TRIM(?))', [String(prod.sku)])
          .orderBy('expected_qty', 'desc')
          .forUpdate()
          .first();
      }

      if (line) {
        const received = Number(line.received_qty) + qty;
        await trx('commercial.receiving_lines').where({ id: line.id }).update({
          // Si la línea se adoptó por SKU queda ligada al catálogo desde ahora: sin
          // esto la mercancía no entraría a inventario al cerrar el vale.
          product_id: productId,
          received_qty: received,
          barcode_scanned: dto.barcode || line.barcode_scanned || null,
          discrepancy_kind: ReceivingSessionService.discrepancyFor(Number(line.expected_qty), received, line.discrepancy_kind),
          updated_at: trx.fn.now(),
        });
      } else {
        // No esperado → línea SOBRANTE.
        await trx('commercial.receiving_lines').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          session_id: sessionId,
          product_id: productId,
          expected_sku: prod?.sku || null,
          expected_name: prod?.nombre || null,
          expected_qty: 0,
          received_qty: qty,
          barcode_scanned: dto.barcode || null,
          discrepancy_kind: 'sobrante',
        });
      }
      return this.detailTx(trx, sessionId);
    });
  }

  /** Ajuste manual de una línea (cantidad recibida, discrepancia tipificada, notas). */
  async setLine(sessionId: string, lineId: string, patch: { received_qty?: number; discrepancy_kind?: DiscrepancyKind; notes?: string }) {
    if (!UUID.test(sessionId) || !UUID.test(lineId)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const session = await trx('commercial.receiving_sessions').where({ id: sessionId }).first();
      if (!session) throw new NotFoundException('Sesión no encontrada');
      if (session.status !== 'open') throw new ConflictException(`La sesión está ${session.status}`);
      const line = await trx('commercial.receiving_lines').where({ id: lineId, session_id: sessionId }).forUpdate().first();
      if (!line) throw new NotFoundException('Línea no encontrada');

      const received = patch.received_qty != null ? Number(patch.received_qty) : Number(line.received_qty);
      if (received < 0) throw new BadRequestException('received_qty no puede ser negativo');
      const manual = patch.discrepancy_kind && ['producto_incorrecto', 'dañado'].includes(patch.discrepancy_kind)
        ? patch.discrepancy_kind : undefined;
      await trx('commercial.receiving_lines').where({ id: lineId }).update({
        received_qty: received,
        discrepancy_kind: manual || ReceivingSessionService.discrepancyFor(Number(line.expected_qty), received),
        notes: patch.notes != null ? patch.notes : line.notes,
        updated_at: trx.fn.now(),
      });
      return this.detailTx(trx, sessionId);
    });
  }

  /** Agrega una línea ESPERADA manualmente (sesiones manuales). */
  async addLine(sessionId: string, dto: { product_id?: string; barcode?: string; expected_qty?: number }) {
    if (!UUID.test(sessionId)) throw new BadRequestException('session_id inválido');
    return this.tk.run(async (trx) => {
      const session = await trx('commercial.receiving_sessions').where({ id: sessionId }).first();
      if (!session) throw new NotFoundException('Sesión no encontrada');
      if (session.status !== 'open') throw new ConflictException(`La sesión está ${session.status}`);

      let prod: any = null;
      if (dto.product_id) {
        if (!UUID.test(dto.product_id)) throw new BadRequestException('product_id inválido');
        prod = await trx('public.products').where({ id: dto.product_id }).first('id', 'sku', 'nombre');
      } else if (dto.barcode) {
        prod = await this.resolveProductByCode(trx, String(dto.barcode).trim());
      }
      if (!prod) throw new NotFoundException('Sin producto para la línea');

      const existing = await trx('commercial.receiving_lines').where({ session_id: sessionId, product_id: prod.id }).first();
      if (existing) throw new ConflictException('El producto ya está en la sesión');

      const expected = Number(dto.expected_qty) > 0 ? Number(dto.expected_qty) : 0;
      await trx('commercial.receiving_lines').insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        session_id: sessionId,
        product_id: prod.id,
        expected_sku: prod.sku || null,
        expected_name: prod.nombre || null,
        expected_qty: expected,
        received_qty: 0,
        discrepancy_kind: 'pending',
      });
      return this.detailTx(trx, sessionId);
    });
  }

  /** Cierra la sesión: finaliza discrepancias (pending con expected>0 → faltante). */
  async close(sessionId: string) {
    if (!UUID.test(sessionId)) throw new BadRequestException('session_id inválido');
    return this.tk.run(async (trx) => {
      const session = await trx('commercial.receiving_sessions').where({ id: sessionId }).first();
      if (!session) throw new NotFoundException('Sesión no encontrada');
      if (session.status !== 'open') throw new ConflictException(`La sesión está ${session.status}`);

      // ADR-044 — guard de cierre: un vale NO se cierra con mercancía retenida por un
      // rojo sin resolver. Cerrarlo declararía como recibido algo que nunca entró al
      // inventario (el rojo no escribe stock hasta que un supervisor autoriza).
      const held = await trx('commercial.receiving_lot_captures as c')
        .join('commercial.receiving_lines as l', function () {
          this.on('l.tenant_id', '=', 'c.tenant_id').andOn('l.id', '=', 'c.receiving_line_id');
        })
        .where('l.session_id', sessionId)
        .where('c.status', 'pending_authorization')
        .count({ n: '*' })
        .first();
      const heldCount = Number((held as any)?.n || 0);
      if (heldCount > 0)
        throw new ConflictException(
          `El vale tiene ${heldCount} captura(s) de lote pendientes de autorización: autorizá o rechazá antes de cerrar`,
        );

      const userId = this.tenantCtx.get()?.userId || null;

      // ── LUZ VERDE: la mercancía confirmada entra a inventario ──────────────
      //
      // Un movimiento 'in' por renglón recibido, en el lote 'NA' (sin fecha). El
      // trigger trg_rebalance_stock_lots mantiene el invariante solo; la fecha se
      // agrega después en Caducidades reclasificando NA → lote fechado.
      //
      // Idempotente sin columna nueva: si ya existen movimientos de esta sesión en
      // el ledger, el stock ya se dio de alta y no se repite. Así un reintento del
      // cierre (timeout, doble clic) no duplica existencia.
      const yaDadoDeAlta = await trx('commercial.stock_movements')
        .where({ reference_type: 'receiving_session', reference_id: sessionId })
        .first('id');

      if (!yaDadoDeAlta) {
        // Se descuenta lo que una captura de lote ya haya dado de alta ANTES del
        // cierre (la pantalla del auditor permite capturar con el vale abierto). Sin
        // esto, capturar primero y cerrar después contaría la mercancía dos veces.
        const recibidos = await trx('commercial.receiving_lines as l')
          .where('l.session_id', sessionId)
          .whereNotNull('l.product_id')
          .where('l.received_qty', '>', 0)
          .select(
            'l.product_id',
            'l.received_qty',
            trx.raw(`COALESCE((
              SELECT SUM(c.quantity)
                FROM commercial.receiving_lot_captures c
                JOIN commercial.stock_movements m ON m.id = c.stock_movement_id
               WHERE c.receiving_line_id = l.id
                 AND m.movement_type = 'in'
            ), 0)::numeric AS ya_dado_de_alta`),
          );

        for (const l of recibidos) {
          const falta = Number(l.received_qty) - Number(l.ya_dado_de_alta || 0);
          if (falta <= 0) continue;
          await this.inventory.recordMovementInTx(trx, {
            warehouse_id: session.warehouse_id,
            product_id: l.product_id,
            movement_type: 'in',
            quantity: falta,
            reference_type: 'receiving_session',
            reference_id: sessionId,
            notes: `Recepción ${session.folio}${session.source_ref ? ` · ERP ${session.source_ref}` : ''}`,
          });
        }
        this.logger.log(
          `Vale ${session.folio}: ${recibidos.length} renglón(es) dados de alta en ${session.warehouse_id}`,
        );

        // Lo que se recibió pero no tiene producto del catálogo queda FUERA del alta.
        // Se avisa fuerte: es mercancía física que el inventario no va a conocer.
        const huerfanos = await trx('commercial.receiving_lines')
          .where({ session_id: sessionId })
          .whereNull('product_id')
          .where('received_qty', '>', 0)
          .count({ n: '*' })
          .first();
        const nHuerfanos = Number((huerfanos as any)?.n || 0);
        if (nHuerfanos > 0)
          this.logger.warn(
            `Vale ${session.folio}: ${nHuerfanos} renglón(es) recibidos SIN producto en el catálogo — ` +
              'esa mercancía NO entró a inventario. Hay que darla de alta en el catálogo y recibirla aparte.',
          );
      }

      await trx('commercial.receiving_lines')
        .where({ session_id: sessionId, discrepancy_kind: 'pending' })
        .where('expected_qty', '>', 0)
        .update({ discrepancy_kind: 'faltante', updated_at: trx.fn.now() });
      // pending con expected=0 y received=0 → ok (línea vacía)
      await trx('commercial.receiving_lines')
        .where({ session_id: sessionId, discrepancy_kind: 'pending' })
        .update({ discrepancy_kind: 'ok', updated_at: trx.fn.now() });

      // ── WMS-REC.8 — el reclamo del faltante (ADR-053) ─────────────────────
      //
      // Acá, y no antes: recién en las dos sentencias de arriba el `pending` se volvió
      // `faltante`, así que este es el momento en que el faltante queda FIRME. Y acá, y
      // no en la Puerta 1: el cotejo corre contra el chofer y el andén ocupado es el
      // recurso caro — el reclamo no le agrega un solo toque al camión esperando.
      //
      // Va en la MISMA trx que el cierre a propósito: un vale que cierra sin dejar el
      // reclamo es exactamente el bug que este item viene a arreglar (el faltante se
      // detectaba, se mostraba, y se evaporaba). Si no se puede escribir, no se cierra.
      //
      // El faltante NO se recalcula: se lee de `discrepancy_kind`, que es la autoridad.
      const reclamos = await this.claims.raiseForSessionInTx(trx, session);

      await trx('commercial.receiving_sessions').where({ id: sessionId }).update({
        status: 'closed', closed_at: trx.fn.now(), closed_by: userId, updated_at: trx.fn.now(),
      });
      const detalle = await this.detailTx(trx, sessionId);
      // El andén decía "El proveedor lo va a ver en su scorecard" sin que existiera
      // registro alguno. Ahora el cierre devuelve QUÉ se levantó y a quién, así que la
      // pantalla puede decir la verdad en vez de una promesa.
      return { ...detalle, claims: reclamos };
    });
  }

  /**
   * BANDEJA DE CADUCIDADES — la mercancía que ya pasó la luz verde y no tiene fecha.
   *
   * Un renglón entra a la bandeja cuando la recepción se aprobó (`closed`) pero
   * `SUM(capturas de lote) < received_qty`: eso es existencia real en la bodega SIN
   * trazabilidad de caducidad, y es exactamente la cola de trabajo del bodeguero.
   *
   * Se ordena por antigüedad: lo que lleva más días esperando primero, porque el
   * riesgo crece con el tiempo (mercancía en anaquel de la que nadie sabe cuándo vence).
   *
   * Todo derivado: ni tabla ni columna nuevas.
   */
  async pendingExpiry(query: { warehouse_id?: string; limit?: number } = {}) {
    if (query.warehouse_id && !UUID.test(query.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 200));

    return this.tk.run(async (trx) => {
      let q = trx('commercial.receiving_lines as l')
        .join('commercial.receiving_sessions as s', function () {
          this.on('s.tenant_id', '=', 'l.tenant_id').andOn('s.id', '=', 'l.session_id');
        })
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 's.tenant_id').andOn('w.id', '=', 's.warehouse_id');
        })
        .leftJoin('public.products as p', 'p.id', 'l.product_id')
        // El vale guarda el código del proveedor, no su nombre. La bandeja se lee
        // por llegada ("llegó lo de Bimbo"), así que el nombre viaja con el renglón.
        .leftJoin('catalog.suppliers as sup', function () {
          this.on('sup.tenant_id', '=', 's.tenant_id').andOn('sup.code', '=', 's.supplier_code');
        })
        .where('s.status', 'closed')
        .whereNotNull('l.product_id')
        .where('l.received_qty', '>', 0);
      if (query.warehouse_id) q = q.where('s.warehouse_id', query.warehouse_id);

      const rows = await q
        .select(
          'l.id as line_id',
          'l.product_id',
          'p.sku',
          'p.nombre as product_name',
          'l.received_qty',
          // El lector de códigos emite el código de barras, no el SKU: sin esto la
          // bandeja no puede resolver lo que se escanea contra lo que está esperando fecha.
          'p.barcode',
          // La cantidad se cuenta en la unidad del vale (CAJA/PAQ/PZA), así que el
          // campo tiene que decir en qué se está contando en vez de dar por hecho piezas.
          // `[WMS-REC.17]` El vale de traspaso lee la unidad de su EMBARQUE; su referencia
          // empieza con `UD41`, que no es una sucursal, asi que la rama de la orden de entrada
          // nunca lo confundiria con otra (daria vacio, no un dato ajeno).
          trx.raw(`CASE WHEN s.source_kind = 'erp_transfer' THEN
                     (SELECT CASE WHEN COUNT(DISTINCT TRIM(el.unidad)) > 1 THEN 'ambigua'
                                  ELSE MIN(TRIM(el.unidad)) END
                        FROM analytics.erp_shipment_lines el
                       WHERE el.tenant_id = l.tenant_id
                         AND el.sucursal = split_part(s.source_ref, '/', 2)
                         AND el.serie    = NULLIF(split_part(s.source_ref, '/', 3), '')::int
                         AND el.folio    = split_part(s.source_ref, '/', 4)
                         AND el.sku      = l.expected_sku)
                   ELSE
                     (SELECT CASE WHEN COUNT(DISTINCT TRIM(el.unidad)) > 1 THEN 'ambigua'
                                  ELSE MIN(TRIM(el.unidad)) END
                        FROM analytics.erp_goods_receipt_lines el
                       WHERE el.tenant_id = l.tenant_id
                         AND el.sucursal  = split_part(s.source_ref, '/', 1)
                         AND el.folio     = split_part(s.source_ref, '/', 2)
                         AND el.sku       = l.expected_sku)
                   END AS expected_unit`),
          's.id as session_id',
          's.folio as vale_folio',
          's.source_ref',
          's.supplier_code',
          'sup.name as supplier_name',
          's.warehouse_id',
          'w.code as warehouse_code',
          'w.name as warehouse_name',
          's.closed_at',
          // Declarado = SÓLO lo aceptado, que es lo que de verdad quedó con lote
          // fechado en existencia. Contar también lo retenido haría que la bandeja
          // dijera "ya está fechado" sobre mercancía que ningún lote registra.
          trx.raw(`COALESCE((
            SELECT SUM(c.quantity) FROM commercial.receiving_lot_captures c
             WHERE c.receiving_line_id = l.id AND c.status = 'accepted'
          ), 0)::numeric AS declared_qty`),
          // Retenido = capturado con fecha pero 🔴, esperando que un supervisor
          // autorice. No se le vuelve a pedir fecha al bodeguero (ya la puso) pero
          // tampoco se declara resuelto: se muestra para que alguien lo persiga.
          trx.raw(`COALESCE((
            SELECT SUM(c.quantity) FROM commercial.receiving_lot_captures c
             WHERE c.receiving_line_id = l.id AND c.status = 'pending_authorization'
          ), 0)::numeric AS held_qty`),
          trx.raw(`GREATEST(0, (CURRENT_DATE - s.closed_at::date))::int AS dias_esperando`),
        )
        .orderBy('s.closed_at', 'asc')
        .limit(limit);

      // El filtro "le falta fecha" se aplica sobre el derivado (no se puede en WHERE
      // sin repetir la subconsulta) y se calcula el faltante real por renglón.
      const pendientes = rows
        .map((r: any) => {
          const recibido = Number(r.received_qty) || 0;
          const declarado = Number(r.declared_qty) || 0;
          const retenido = Number(r.held_qty) || 0;
          return {
            ...r,
            received_qty: recibido,
            declared_qty: declarado,
            held_qty: retenido,
            pending_qty: Math.max(0, recibido - declarado - retenido),
          };
        })
        // Un renglón sale de la bandeja cuando ya no le falta fecha a nadie, pero
        // sigue apareciendo si tiene retenidos: eso es trabajo abierto de otra persona.
        .filter((r: any) => r.pending_qty > 0 || r.held_qty > 0);

      if (!pendientes.length) return pendientes;

      // Avance por llegada, sobre TODOS los renglones del vale — no sólo los que
      // siguen pendientes. Sin esto el avance se leería "0 de 300" en un vale que
      // ya va a la mitad, porque los renglones terminados salen del listado (y el
      // `limit` puede además cortar renglones del mismo vale).
      // `Array.from`, NO `[...new Set()]`: el build del API downlevela el spread a
      // `[].concat(set)` y eso deja un array de UN elemento que es el Set entero.
      // Postgres lo recibe como '{}' y revienta con 22P02. Ver docs/GOTCHAS.md.
      const sessionIds = Array.from(new Set(pendientes.map((r: any) => r.session_id)));
      const totales = await trx('commercial.receiving_lines as l')
        .whereIn('l.session_id', sessionIds)
        .whereNotNull('l.product_id')
        .where('l.received_qty', '>', 0)
        .groupBy('l.session_id')
        .select(
          'l.session_id',
          trx.raw(`COUNT(*)::int AS session_line_count`),
          trx.raw(`COALESCE(SUM(l.received_qty), 0)::numeric AS session_received_qty`),
          trx.raw(`COALESCE(SUM((
            SELECT COALESCE(SUM(c.quantity), 0) FROM commercial.receiving_lot_captures c
             WHERE c.receiving_line_id = l.id AND c.status = 'accepted'
          )), 0)::numeric AS session_declared_qty`),
          trx.raw(`COALESCE(SUM((
            SELECT COALESCE(SUM(c.quantity), 0) FROM commercial.receiving_lot_captures c
             WHERE c.receiving_line_id = l.id AND c.status = 'pending_authorization'
          )), 0)::numeric AS session_held_qty`),
        );

      const porSesion = new Map<string, any>(totales.map((t: any) => [t.session_id, t]));
      return pendientes.map((r: any) => {
        const t = porSesion.get(r.session_id);
        return {
          ...r,
          session_line_count: Number(t?.session_line_count) || 0,
          session_received_qty: Number(t?.session_received_qty) || 0,
          session_declared_qty: Number(t?.session_declared_qty) || 0,
          session_held_qty: Number(t?.session_held_qty) || 0,
        };
      });
    });
  }

  async cancel(sessionId: string) {
    if (!UUID.test(sessionId)) throw new BadRequestException('session_id inválido');
    return this.tk.run(async (trx) => {
      const session = await trx('commercial.receiving_sessions').where({ id: sessionId }).first();
      if (!session) throw new NotFoundException('Sesión no encontrada');
      if (session.status === 'closed') throw new ConflictException('No se puede cancelar una sesión cerrada');
      await trx('commercial.receiving_sessions').where({ id: sessionId }).update({
        status: 'cancelled', updated_at: trx.fn.now(),
      });
      return this.detailTx(trx, sessionId);
    });
  }

  async list(query: { status?: string; warehouse_id?: string; limit?: number }) {
    if (query.warehouse_id && !UUID.test(query.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 100));
    return this.tk.run(async (trx) => {
      let q = trx('commercial.receiving_sessions as s')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 's.tenant_id').andOn('w.id', '=', 's.warehouse_id');
        });
      if (query.status) q = q.where('s.status', query.status);
      if (query.warehouse_id) q = q.where('s.warehouse_id', query.warehouse_id);
      return q
        .select(
          's.id', 's.folio', 's.warehouse_id', 'w.code as warehouse_code', 'w.name as warehouse_name',
          's.supplier_code', 's.source_kind', 's.source_ref', 's.status',
          's.created_at', 's.closed_at',
          trx.raw(`(SELECT COUNT(*) FROM commercial.receiving_lines l WHERE l.session_id = s.id) AS line_count`),
          trx.raw(`(SELECT COUNT(*) FROM commercial.receiving_lines l WHERE l.session_id = s.id AND l.discrepancy_kind IN ('faltante','sobrante','producto_incorrecto','dañado')) AS discrepancy_count`),
        )
        .orderBy('s.created_at', 'desc')
        .limit(limit);
    });
  }

  async detail(sessionId: string) {
    if (!UUID.test(sessionId)) throw new BadRequestException('session_id inválido');
    return this.tk.run((trx) => this.detailTx(trx, sessionId));
  }

  /**
   * `[WMS-REC.17]` **Los vales que alguien abrió y no ha cerrado** — para cambiar de camión.
   *
   * Un vale abierto sale del menú de pendientes (ya tiene sesión), así que sin esta lista
   * dejar uno a medias era perderlo: sólo lo recuperaba el borrador del MISMO equipo, y
   * sólo el último. Acotado al alcance de almacén, como el menú.
   *
   * No lee las vistas del ERP a propósito: con el folio de Kepler y el origen alcanza para
   * reconocer el camión, y la vista de órdenes de entrada cuesta medio segundo por consulta.
   */
  async inProgress(limit = 30): Promise<AndenValeEnCurso[]> {
    const alcance = await this.scope.current();
    const dim = alcance.dims.warehouse;
    if (dim.mode === 'none') return [];
    if (dim.mode !== 'all' && !dim.values.length) return [];

    return this.tk.run(async (trx) => {
      const q = trx('commercial.receiving_sessions as s')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 's.tenant_id').andOn('w.id', '=', 's.warehouse_id');
        })
        .leftJoin('identity.users as u', 'u.id', 's.created_by')
        .whereIn('s.status', ['open', 'validating'])
        .orderBy('s.created_at', 'desc')
        .limit(Math.min(100, Math.max(1, Number(limit) || 30)))
        .select(
          's.id', 's.folio', 's.source_kind', 's.source_ref', 's.supplier_code', 's.warehouse_id',
          'w.code as warehouse_code', 'w.name as warehouse_name', 's.created_at',
          trx.raw(`COALESCE(NULLIF(btrim(u.nombre), ''), u.username) AS abierto_por`),
          trx.raw(`(SELECT COUNT(*) FROM commercial.receiving_lines l WHERE l.session_id = s.id)::int AS renglones`),
          trx.raw(`(SELECT COUNT(*) FROM commercial.receiving_lines l
                     WHERE l.session_id = s.id AND l.discrepancy_kind = 'pending'
                       AND l.expected_qty > 0)::int AS por_fechar`),
        );
      if (dim.mode !== 'all') q.whereIn('w.code', dim.values);
      const filas = (await q) as FilaValeEnCurso[];

      // Nombre de la sucursal que embarcó, para los vales de traspaso.
      const origenes = Array.from(
        new Set(filas.map((f) => parseTransferRef(f.source_ref)?.origen).filter(Boolean)),
      ) as string[];
      const nombres = new Map<string, string>();
      if (origenes.length) {
        const ws = await trx('commercial.warehouses').whereIn('code', origenes).whereNull('deleted_at').select('code', 'name');
        for (const w of ws as Array<{ code: string; name: string }>) nombres.set(String(w.code), String(w.name));
      }

      return filas.map((f): AndenValeEnCurso => {
        const t = parseTransferRef(f.source_ref);
        return {
          id: f.id,
          folio: f.folio,
          source_kind: f.source_kind,
          documento: t ? `Embarque ${t.origen}-${t.serie}-${t.folio}` : f.source_ref || null,
          warehouse_id: f.warehouse_id,
          warehouse_code: f.warehouse_code ?? null,
          warehouse_name: f.warehouse_name ?? null,
          origin: t
            ? classifyShipmentOrigin(t.origen, nombres.get(t.origen) ?? null)
            : classifyReceivingOrigin(f.supplier_code, null),
          renglones: Number(f.renglones) || 0,
          por_fechar: Number(f.por_fechar) || 0,
          abierto_por: f.abierto_por ?? null,
          created_at: f.created_at instanceof Date ? f.created_at.toISOString() : String(f.created_at),
        };
      });
    });
  }

  /**
   * Arma el detalle DENTRO de la transacción dada. Se usa desde open/scan/close/…
   * para no abrir una transacción anidada (otra conexión del pool NO vería los
   * cambios aún sin commitear → NotFoundException + rollback). Ver bug 2026-08-19.
   */
  private async detailTx(trx: any, sessionId: string) {
    {
      const session = await trx('commercial.receiving_sessions as s')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 's.tenant_id').andOn('w.id', '=', 's.warehouse_id');
        })
        .where('s.id', sessionId)
        .select('s.*', 'w.code as warehouse_code', 'w.name as warehouse_name')
        .first();
      if (!session) throw new NotFoundException('Sesión no encontrada');

      // `[WMS-REC.17]` Un vale de traspaso lee su documento del EMBARQUE de quien mandó.
      const traspaso = parseTransferRef(session.source_ref);
      const unidadDelEmbarque = traspaso
        ? trx.raw(
            `(SELECT CASE WHEN COUNT(DISTINCT TRIM(el.unidad)) > 1 THEN 'ambigua'
                          ELSE MIN(TRIM(el.unidad)) END
                FROM analytics.erp_shipment_lines el
               WHERE el.tenant_id = l.tenant_id
                 AND el.sucursal = ? AND el.serie = ?::int AND el.folio = ?
                 AND el.sku = l.expected_sku) AS expected_unit`,
            [traspaso.origen, traspaso.serie, traspaso.folio],
          )
        : null;

      // Cuadre de caducidad por renglón (ADR-044): `declared_qty` = Σ de las capturas
      // de lote ligadas al renglón, y `held_qty` = las que están retenidas por un rojo
      // sin autorizar (no entraron a stock). Se DERIVA, no se denormaliza.
      const lines = await trx('commercial.receiving_lines as l')
        .leftJoin('public.products as p', 'p.id', 'l.product_id')
        .where('l.session_id', sessionId)
        .select(
          'l.id', 'l.product_id', 'p.sku', 'p.nombre as product_name',
          'l.expected_sku', 'l.expected_name', 'l.expected_qty', 'l.received_qty',
          'l.barcode_scanned', 'l.discrepancy_kind', 'l.notes',
          trx.raw(`COALESCE((
            SELECT SUM(c.quantity) FROM commercial.receiving_lot_captures c
             WHERE c.receiving_line_id = l.id AND c.status <> 'rejected'
          ), 0)::numeric AS declared_qty`),
          trx.raw(`COALESCE((
            SELECT SUM(c.quantity) FROM commercial.receiving_lot_captures c
             WHERE c.receiving_line_id = l.id AND c.status = 'pending_authorization'
          ), 0)::numeric AS held_qty`),
          trx.raw(`(
            SELECT COUNT(*) FROM commercial.receiving_lot_captures c
             WHERE c.receiving_line_id = l.id AND c.status = 'pending_authorization'
          )::int AS holds`),
          // Unidad TAL CUAL la manda el vale del ERP (PAQ/PZA/KG/CJA/BTO/CUB…).
          // Se DERIVA del espejo en vez de copiarla a una columna: el vale ya guarda
          // `source_ref = sucursal/folio` y el renglón su `expected_sku`, y se verificó
          // en prod que un mismo SKU dentro de un vale nunca trae dos unidades
          // distintas (0 casos ambiguos de 89,167), así que el join es determinista.
          // El centinela de ambigüedad es la palabra 'ambigua', NO un signo de
          // interrogación: knex trata ese signo como binding aunque esté entre
          // comillas SQL — y también dentro de un comentario `--` del propio raw
          // (GOTCHAS §5). Ambas variantes tiraban "Expected 2 bindings, saw 3".
          unidadDelEmbarque ?? trx.raw(
            `(SELECT CASE
                       -- Si ese SKU trae MÁS DE UNA unidad dentro del mismo vale, el join
                       -- deja de ser determinista. Hoy no pasa (0 casos de 89,167 pares
                       -- en prod), pero es una propiedad del DATO, no del modelo: llega el
                       -- día que un vale traiga 2 cajas + 5 piezas del mismo producto.
                       -- Antes que elegir una en silencio, se declara ambigua y se ve.
                       WHEN COUNT(DISTINCT TRIM(el.unidad)) > 1 THEN 'ambigua'
                       ELSE MIN(TRIM(el.unidad))
                     END
                FROM analytics.erp_goods_receipt_lines el
               WHERE el.tenant_id = l.tenant_id
                 AND el.sucursal = split_part(?, '/', 1)
                 AND el.folio    = split_part(?, '/', 2)
                 AND el.sku      = l.expected_sku) AS expected_unit`,
            [session.source_ref || '', session.source_ref || ''],
          ),
        )
        .orderByRaw(`CASE l.discrepancy_kind WHEN 'pending' THEN 0 WHEN 'faltante' THEN 1 WHEN 'sobrante' THEN 2 ELSE 3 END`)
        .orderBy('l.created_at');

      const progress = {
        lines: lines.length,
        pending: lines.filter((l) => l.discrepancy_kind === 'pending').length,
        ok: lines.filter((l) => l.discrepancy_kind === 'ok').length,
        discrepancies: lines.filter((l) => ['faltante', 'sobrante', 'producto_incorrecto', 'dañado'].includes(l.discrepancy_kind)).length,
        expected_units: lines.reduce((a, l) => a + Number(l.expected_qty), 0),
        received_units: lines.reduce((a, l) => a + Number(l.received_qty), 0),
        // ADR-044 — el indicador que antes no existía: cuánto de lo recibido tiene
        // lote+caducidad declarados, y cuánto entró sin trazabilidad.
        declared_units: lines.reduce((a, l) => a + Number(l.declared_qty), 0),
        undeclared_units: lines.reduce(
          (a, l) => a + Math.max(0, Number(l.received_qty) - Number(l.declared_qty)),
          0,
        ),
        held_units: lines.reduce((a, l) => a + Number(l.held_qty), 0),
        holds: lines.reduce((a, l) => a + Number(l.holds), 0),
        // Renglones recibidos cuyo SKU no existe en el catálogo: al dar luz verde
        // esa mercancía NO entra a inventario. En prod es raro (23 de 89,257
        // renglones históricos) pero pasa, y callarlo deja existencia física que el
        // sistema no conoce. Se cuenta para poder decirlo.
        sin_catalogo: lines.filter((l) => !l.product_id && Number(l.received_qty) > 0).length,
      };
      // Ficha del vale del ERP — DERIVADA, no copiada (ERP_KEPLER §5.1): con el
      // `source_ref` alcanza para traer proveedor/RFC/OC/concepto/monto al vuelo.
      let erp: Record<string, unknown> | null = null;
      if (session.source_kind === 'erp_receipt' && session.source_ref) {
        const [suc, fol] = String(session.source_ref).split('/');
        const tenantId = this.tenantCtx.get()?.tenantId || null;
        const h = await trx('analytics.erp_goods_receipts')
          .where({ tenant_id: tenantId, sucursal: suc, folio: fol })
          .first(
            'sucursal', 'folio', 'doc_prefix', 'receipt_date', 'proveedor_code',
            'proveedor_nombre', 'proveedor_rfc', 'oc_folio', 'vale_folio',
            'concepto', 'monto',
          );
        if (h) {
          // Servicios del vale (flete/maniobra): se muestran, pero NO se reciben.
          const services = await trx('analytics.erp_goods_receipt_lines')
            .where({ tenant_id: tenantId, sucursal: suc, folio: fol })
            .whereRaw(`TRIM(unidad) = 'SER'`)
            .select('nombre', 'cantidad', 'importe');
          erp = {
            ...h,
            monto: Number(h.monto) || 0,
            tipo: /^TI/i.test(h.proveedor_code || '') ? 'traspaso' : 'compra',
            services,
          };
        }
      }

      // `[WMS-REC.17]` Ficha del EMBARQUE, derivada igual que la de la orden de entrada.
      if (traspaso) {
        const [e] = await this.embarques(trx, { key: traspaso });
        if (e) {
          erp = {
            sucursal: e.origen,
            folio: e.folio,
            serie: e.serie,
            doc_prefix: 'UD41',
            receipt_date: e.fecha,
            proveedor_code: session.supplier_code || null,
            proveedor_nombre: e.origen_nombre,
            concepto: e.comentarios,
            monto: Number(e.monto) || 0,
            tipo: 'traspaso',
            fuente: 'embarque',
            destino_code: e.destino_code,
            destino_nombre: e.destino_nombre,
            recibido_kepler: e.recibido_kepler,
            services: [],
          };
        }
      }

      // De dónde viene la mercancía. En el andén son dos cosas distintas aunque
      // lleguen por la misma puerta: un faltante de PROVEEDOR se le reclama a él
      // y le pega en su scorecard; uno de TRASPASO se le reclama a la sucursal
      // que embarcó, y es de la casa. En un vale de traspaso el origen es la
      // sucursal del embarque (un hecho), no un código `TI###`.
      const nombreErp = erp?.['proveedor_nombre'];
      const proveedorNombre = typeof nombreErp === 'string' ? nombreErp : null;
      const origin = traspaso
        ? classifyShipmentOrigin(traspaso.origen, proveedorNombre)
        : classifyReceivingOrigin(session.supplier_code, proveedorNombre);

      return { ...session, lines, progress, erp, origin };
    }
  }
}
