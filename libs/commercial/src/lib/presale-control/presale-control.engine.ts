import type {
  PresaleDue,
  PresaleLineCompare,
  PresaleLinkBlock,
  PresaleStage,
} from '@megadulces/contracts';
import { PRESALE_MAX_REINTENTOS, PRESALE_STAGES } from '@megadulces/contracts';

/**
 * `[MCP.1]` / `[MCP.4]` Motor puro de la Mesa de Control de Preventa (Fase MCP, ADR-089).
 *
 * Sin base de datos: el servicio trae los hechos y aquí se decide etapa, semáforo, si se puede
 * buscar documento de Kepler y cómo se compara el pedido contra lo cobrado. Así cada regla tiene
 * su prueba (y su prueba negativa) sin levantar nada.
 */

/**
 * `[MCP]` Cuántas veces puede SALIR OTRA VEZ un pedido que no se entregó, con el mismo documento,
 * antes de mandarse a devolución y nota de crédito en Kepler. Decisión de Francisco (2026-10-08):
 * "sólo 2 entregas más, se empieza a maltratar la mercancía". Lo usa MCP.7; vive aquí para que
 * la regla tenga un solo dueño.
 */
export const MAX_REINTENTOS_ENTREGA = PRESALE_MAX_REINTENTOS;

/** Los estados de `commercial.orders` que entran a la mesa. Los borradores no son pedido todavía. */
export const STATUS_EN_MESA = ['confirmed', 'fulfilled', 'cancelled'] as const;

export interface HechosEtapa {
  status: string;
  /** Etapa de la ola VIVA más reciente (`commercial.wave_orders.stage`), o `null` si no tiene. */
  wave_stage: string | null;
  /** Hay un documento de Kepler ligado y vivo. */
  ligado: boolean;
  /** Clave del cliente en Kepler (`customers.erp_customer_code`). */
  customer_erp_code: string | null;
  /** `[MCP.5]` Va cargado en una guía de carga ya IMPRESA (el repartidor la firmó y salió). */
  en_guia_impresa?: boolean;
  /**
   * `[MCP.6]` Se registró la entrega de conformidad en el renglón de la guía. Cuenta como entregado
   * aunque `orders.status` siga en `confirmed`: marcarlo `fulfilled` lo facturaría otra vez (FE.5).
   */
  entregado_en_guia?: boolean;
}

/**
 * La etapa se DERIVA de los hechos; no existe una columna "etapa" que pueda envejecer.
 *
 * ⚠️ El orden de las preguntas importa: lo cerrado manda sobre todo lo demás; ir en una guía
 * impresa manda sobre la liga (ya salió con el repartidor), y la liga manda sobre la ola (un pedido
 * cobrado en Kepler ya salió del almacén aunque la ola no se haya cerrado).
 */
export function etapaDe(h: HechosEtapa): PresaleStage {
  if (h.status === 'cancelled') return 'cancelado';
  if (h.status === 'fulfilled' || h.entregado_en_guia) return 'entregado';
  if (h.en_guia_impresa) return 'en_ruta';
  if (h.ligado) return 'cobrado';
  if (!h.customer_erp_code) return 'esperando_alta';
  if (h.wave_stage === 'listo_embarque') return 'en_caja';
  if (h.wave_stage) return 'en_surtido';
  return 'por_surtir';
}

/** Etapas en que el pedido ya no espera nada de la sucursal: no llevan semáforo. */
const CERRADAS: ReadonlySet<PresaleStage> = new Set<PresaleStage>(['entregado', 'cancelado']);

/** Días entre dos fechas `YYYY-MM-DD` (b − a), sin pasar por la zona horaria del servidor. */
export function diasEntre(a: string, b: string): number {
  const ms = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) -
    Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  return Math.round(ms / 86_400_000);
}

/**
 * Semáforo contra la fecha de entrega prometida, con "hoy" en hora de México.
 * `cobrado` SÍ lleva semáforo: cobrado no es entregado, y un cobrado vencido es justo el pedido
 * que el cliente ya pagó y no ha recibido.
 */
export function semaforo(
  fechaEntrega: string,
  hoy: string,
  etapa: PresaleStage,
): { due: PresaleDue; days_late: number | null } {
  if (CERRADAS.has(etapa)) return { due: null, days_late: null };
  const atraso = diasEntre(fechaEntrega, hoy);
  if (atraso > 0) return { due: 'vencido', days_late: atraso };
  if (atraso === 0) return { due: 'hoy', days_late: 0 };
  return { due: 'a_tiempo', days_late: atraso };
}

/** Normaliza una clave de cliente de Kepler para compararla: sin espacios ni ceros a la izquierda. */
export function claveCliente(code: string | null | undefined): string | null {
  if (code == null) return null;
  const c = String(code).trim().replace(/^0+/, '');
  return c === '' ? null : c;
}

/**
 * ¿Se pueden buscar documentos de Kepler para este pedido? `null` = sí.
 *
 * ⚠️ Las claves de cliente de Kepler son POR SUCURSAL (medido 2026-10-08: el cliente `10465` de la
 * 01 no es el `10465` de la 04). Buscar en la sucursal del pedido con la clave de un cliente de
 * otra sucursal traería los tickets de OTRA persona. Por eso se exige que coincidan.
 */
export function bloqueoDeLiga(h: {
  customer_erp_code: string | null;
  customer_erp_branch: string | null;
  branch: string | null;
  branch_has_documents: boolean;
}): PresaleLinkBlock | null {
  if (!claveCliente(h.customer_erp_code)) return 'cliente_sin_clave';
  if (!h.branch || !h.branch_has_documents) return 'sucursal_sin_documentos';
  if (h.customer_erp_branch && h.customer_erp_branch.trim() !== h.branch) return 'cliente_de_otra_sucursal';
  return null;
}

export interface RenglonPedido {
  product_id: string | null;
  sku: string | null;
  description: string | null;
  /** Unidad base. */
  quantity: number;
  /** SIN impuesto. */
  unit_price: number;
}

export interface RenglonDocumento {
  product_id: string | null;
  sku: string | null;
  description: string | null;
  /** `kdm2.c9`, unidad base. */
  cantidad: number;
  unidad: string | null;
  /** SIN impuesto. */
  precio_unitario: number;
}

const TOL_CANTIDAD = 0.0005;
const TOL_PRECIO = 0.005;

/**
 * Compara el pedido contra el documento cobrado, renglón por renglón.
 *
 * Se parea por `product_id` y, si falta, por SKU. Si un producto aparece en varios renglones del
 * mismo lado, se suman las cantidades y el precio queda como precio PROMEDIO ponderado.
 *
 * ⚠️ Se comparan cantidad y precio unitario SIN impuesto, nunca importes: el total del renglón del
 * pedido trae IVA/IEPS y el importe del renglón del ticket no (medido en PD-2026-00053).
 */
export function compararRenglones(pedido: RenglonPedido[], documento: RenglonDocumento[]): PresaleLineCompare[] {
  type Acum = {
    product_id: string | null; sku: string | null; description: string | null;
    oq: number; ov: number; enPedido: boolean;
    cq: number; cv: number; unidad: string | null; enDoc: boolean;
  };
  const porLlave = new Map<string, Acum>();
  const llave = (pid: string | null, sku: string | null) => (pid ? `p:${pid}` : sku ? `s:${sku.trim()}` : null);
  const tomar = (pid: string | null, sku: string | null, desc: string | null) => {
    const k = llave(pid, sku) ?? `x:${porLlave.size}`;
    let a = porLlave.get(k);
    if (!a) {
      a = { product_id: pid, sku, description: desc, oq: 0, ov: 0, enPedido: false, cq: 0, cv: 0, unidad: null, enDoc: false };
      porLlave.set(k, a);
    }
    return a;
  };

  for (const r of pedido) {
    const a = tomar(r.product_id, r.sku, r.description);
    a.oq += r.quantity;
    a.ov += r.quantity * r.unit_price;
    a.enPedido = true;
  }
  for (const r of documento) {
    // Un renglón del documento sin product_id pero con SKU se busca también por el SKU del pedido.
    let a: Acum | undefined;
    if (!r.product_id && r.sku) {
      a = [...porLlave.values()].find((x) => x.sku?.trim() === r.sku?.trim());
    }
    a = a ?? tomar(r.product_id, r.sku, r.description);
    a.cq += r.cantidad;
    a.cv += r.cantidad * r.precio_unitario;
    a.unidad = a.unidad ?? r.unidad;
    a.description = a.description ?? r.description;
    a.enDoc = true;
  }

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  return [...porLlave.values()].map((a) => {
    const op = a.enPedido && a.oq ? a.ov / a.oq : null;
    const cp = a.enDoc && a.cq ? a.cv / a.cq : null;
    let match: PresaleLineCompare['match'];
    if (!a.enDoc) match = 'solo_pedido';
    else if (!a.enPedido) match = 'solo_documento';
    else {
      const difQ = Math.abs(a.oq - a.cq) > TOL_CANTIDAD;
      const difP = op != null && cp != null && Math.abs(op - cp) > TOL_PRECIO;
      match = difQ && difP ? 'cantidad_y_precio' : difQ ? 'cantidad' : difP ? 'precio' : 'igual';
    }
    return {
      product_id: a.product_id,
      sku: a.sku,
      description: a.description,
      ordered_qty: a.enPedido ? r4(a.oq) : null,
      ordered_price: op == null ? null : r2(op),
      charged_qty: a.enDoc ? r4(a.cq) : null,
      charged_unit: a.unidad,
      charged_price: cp == null ? null : r2(cp),
      match,
    };
  });
}

/** Conteo por etapa con TODAS las etapas presentes (en cero las que no tienen filas). */
export function contarPorEtapa(etapas: PresaleStage[]): Record<PresaleStage, number> {
  const out = Object.fromEntries(PRESALE_STAGES.map((s) => [s, 0])) as Record<PresaleStage, number>;
  for (const e of etapas) out[e] += 1;
  return out;
}

/**
 * Parte un folio digital de Kepler (`04UD1003-0002097`) en sus llaves: sucursal, prefijo del
 * documento y folio. `null` si no tiene esa forma.
 *
 * ⚠️ Existe por rendimiento, medido en prod 2026-10-08: filtrar las vistas de tickets por
 * `folio_digital` (una concatenación) recorre todo el histórico de la sucursal (82 ms la
 * cabecera, 436 ms los renglones); por las tres partes usa el índice (10 ms y 9 ms).
 */
export function partesFolio(folioDigital: string): { sucursal: string; doc_prefix: string; folio: string } | null {
  const m = /^([0-9]{2})(UD[0-9]{4})-([0-9]{4,10})$/.exec(String(folioDigital ?? '').trim());
  return m ? { sucursal: m[1], doc_prefix: m[2], folio: m[3] } : null;
}

/**
 * `[MCP.7]` ¿Ya no sale otra vez? El pedido sale la primera vez y puede salir `MAX_REINTENTOS_ENTREGA`
 * veces más (I2). Con `fallidos` = intentos que volvieron sin entregarse (`regreso` + `no_entregado`),
 * al agotar los reintentos va a devolución y nota de crédito en Kepler (D10).
 */
export function requiereDevolucion(fallidos: number): boolean {
  return Number(fallidos) > MAX_REINTENTOS_ENTREGA;
}

/** Un renglón de guía tal como lo ve la liquidación. */
export interface RenglonLiquidacion {
  status: 'cargado' | 'entregado' | 'no_entregado' | 'regreso';
  document_total: number | null;
  cash_amount: number | null;
  transfer_amount: number | null;
  /** Cómo se entregó: los "con diferencia" traen su nota por pedido. */
  delivery_outcome?: 'completo' | 'con_diferencia' | null;
}

export interface ResumenLiquidacion {
  entregados: number;
  no_entregados: number;
  /** Siguen en camino: con alguno de éstos la guía NO se puede liquidar. */
  pendientes: number;
  /** Σ documentos de Kepler entregados que el ODS conoce. */
  documents_total: number;
  /** Entregados cuyo documento no trae total en el ODS: se declaran, no se suman como 0. */
  documentos_sin_total: number;
  declared_cash: number;
  declared_transfer: number;
  /** Documentos entregados − lo declarado (efectivo + transferencia), sólo donde el documento trae total. */
  por_cobrar: number;
  /**
   * La parte de `por_cobrar` que nadie explicó: pedidos entregados "completo" cuyo cobro no cuadra
   * con su documento. Si no es 0, la liquidación exige nota.
   */
  sin_explicar: number;
}

const c2 = (n: number) => Math.round(n * 100) / 100;

/**
 * `[MCP.7]` Lo que se espera en la liquidación (D9/D11): sólo lo ENTREGADO cuenta; lo que volvió
 * no se cobra. El efectivo y la transferencia se suman por separado, como los declaró quien entregó.
 */
export function resumenLiquidacion(renglones: readonly RenglonLiquidacion[]): ResumenLiquidacion {
  const r: ResumenLiquidacion = {
    entregados: 0, no_entregados: 0, pendientes: 0, documents_total: 0,
    documentos_sin_total: 0, declared_cash: 0, declared_transfer: 0, por_cobrar: 0, sin_explicar: 0,
  };
  for (const x of renglones) {
    if (x.status === 'cargado') { r.pendientes++; continue; }
    if (x.status !== 'entregado') { r.no_entregados++; continue; }
    r.entregados++;
    if (x.document_total == null) r.documentos_sin_total++;
    else r.documents_total += Number(x.document_total);
    const cobrado = Number(x.cash_amount ?? 0) + Number(x.transfer_amount ?? 0);
    r.declared_cash += Number(x.cash_amount ?? 0);
    r.declared_transfer += Number(x.transfer_amount ?? 0);
    if (x.document_total != null) {
      r.por_cobrar += Number(x.document_total) - cobrado;
      if (x.delivery_outcome !== 'con_diferencia') r.sin_explicar += Number(x.document_total) - cobrado;
    }
  }
  r.documents_total = c2(r.documents_total);
  r.declared_cash = c2(r.declared_cash);
  r.declared_transfer = c2(r.declared_transfer);
  r.por_cobrar = c2(r.por_cobrar);
  r.sin_explicar = c2(r.sin_explicar);
  return r;
}
