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
  /**
   * `[MCP.7.1]` Kepler ya aplicó devolución + nota de crédito que cubre TODO el ticket del pedido:
   * la venta se deshizo. Una nota parcial NO cierra el pedido (decisión de Francisco, 2026-10-10).
   */
  devuelto_nc?: boolean;
  /**
   * `[MCP.3]` Surtido pedido por pedido desde la bandeja de preventa (`commercial.presale_picks`):
   * `surtiendo` = alguien tocó «Empezar a surtir»; `terminado` = lo cerró y quedó listo para la caja.
   */
  pick?: 'surtiendo' | 'terminado' | null;
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
  if (h.status === 'fulfilled') return 'entregado';
  if (h.devuelto_nc) return 'devuelto';
  if (h.entregado_en_guia) return 'entregado';
  if (h.en_guia_impresa) return 'en_ruta';
  if (h.ligado) return 'cobrado';
  if (!h.customer_erp_code) return 'esperando_alta';
  if (h.wave_stage === 'listo_embarque' || h.pick === 'terminado') return 'en_caja';
  if (h.wave_stage || h.pick === 'surtiendo') return 'en_surtido';
  return 'por_surtir';
}

/** Etapas en que el pedido ya no espera nada de la sucursal: no llevan semáforo. */
const CERRADAS: ReadonlySet<PresaleStage> = new Set<PresaleStage>(['entregado', 'devuelto', 'cancelado']);

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

/** Tolerancia de centavos al comparar lo acreditado contra el ticket (redondeo de Kepler). */
const TOLERANCIA_NC = 0.05;

/**
 * `[MCP.7.1]` ¿Las notas de crédito ligadas cubren el ticket? `saldado` sólo si cubren TODO (con
 * tolerancia de centavos); `parcial` si cubren una parte; `null` si no hay nota.
 */
export function estadoNotaCredito(acreditado: number, totalTicket: number): 'saldado' | 'parcial' | null {
  if (!(acreditado > 0)) return null;
  return acreditado >= totalTicket - TOLERANCIA_NC ? 'saldado' : 'parcial';
}

// ───────────────────────────────────────────── [MCP.3.13] pedido agrupado ──

/**
 * `[MCP.3.13]` La clave de Kepler con que se cobra un pedido en SU sucursal. Las claves son POR
 * sucursal: si el cliente tiene una ligada para la sucursal del pedido (`customer_branch_keys`), se
 * usa ésa y cuenta como de esa sucursal (el bloqueo `cliente_de_otra_sucursal` no aplica). Si no, la
 * de su sucursal de origen, con su sucursal (y el bloqueo sigue donde corresponde).
 */
export function claveDelPedido(
  h: { customer_code: string | null; customer_branch: string | null; branch_key_code: string | null },
  branch: string | null,
): { code: string | null; branch: string | null; de_sucursal: boolean } {
  if (branch && claveCliente(h.branch_key_code)) {
    return { code: String(h.branch_key_code).trim(), branch, de_sucursal: true };
  }
  return { code: h.customer_code, branch: h.customer_branch, de_sucursal: false };
}

/** `[MCP.3.13]` Clave de cliente tecleada: sin espacios, mayúsculas, la forma que usa Kepler. `null` = no sirve. */
export function normalizarClaveKepler(raw: unknown): string | null {
  const s = String(raw ?? '').trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9-]{0,19}$/.test(s) ? s : null;
}

export interface HechosClaveSucursal {
  branch: string;
  branch_has_documents: boolean;
  customer: { erp_customer_code: string | null; erp_source_branch: string | null } | null;
  /** El cliente tiene un pedido de preventa confirmado de esa sucursal, dentro del alcance. */
  customer_has_order_in_branch: boolean;
  /** Clave ya normalizada (`normalizarClaveKepler`). */
  code: string | null;
  /** La fila del catálogo de clientes de esa sucursal con esa clave, si existe. */
  en_catalogo: { cliente_code: string; nombre: string | null } | null;
  /** La sucursal publica su catálogo de clientes en el ODS (alguna fila). */
  sucursal_con_catalogo: boolean;
  /** Hay tickets de Kepler en esa sucursal a nombre de esa clave. */
  en_tickets: boolean;
  /** Nombre de OTRO cliente de la Suite que ya tiene esa clave en esa sucursal. */
  otro_cliente: string | null;
}

export type DecisionClaveSucursal =
  | { ok: false; status: 400 | 404 | 409; message: string }
  | { ok: true; code: string; verified_by: 'catalogo' | 'tickets' | null; kepler_name: string | null; warning: string | null };

/**
 * `[MCP.3.13]` ¿Se liga esta clave de Kepler al cliente para esa sucursal? Una clave equivocada cobraría
 * los tickets de OTRA persona, así que se exige que exista en el Kepler de esa sucursal: en su catálogo
 * de clientes o, si todavía no llegó ahí, en sus tickets. Sólo si la sucursal NO publica catálogo se
 * acepta sin verificar, y se DECLARA (ADR-056).
 */
export function decidirClaveSucursal(h: HechosClaveSucursal): DecisionClaveSucursal {
  const no = (status: 400 | 404 | 409, message: string): DecisionClaveSucursal => ({ ok: false, status, message });
  if (!/^[0-9]{2}$/.test(h.branch)) return no(400, 'Sucursal inválida: va la clave de Kepler de dos dígitos (ej. 04).');
  if (!h.code) return no(400, 'Clave de Kepler inválida: sólo letras, números y guion.');
  if (!h.customer) return no(404, 'Cliente no encontrado.');
  if (!claveCliente(h.customer.erp_customer_code)) {
    return no(409, 'El cliente no tiene clave de Kepler en su sucursal: dalo de alta primero (Clientes nuevos).');
  }
  if (h.customer.erp_source_branch && h.customer.erp_source_branch.trim() === h.branch) {
    return no(409, `La ${h.branch} es la sucursal de origen del cliente: ahí su clave es ${claveCliente(h.customer.erp_customer_code)}.`);
  }
  if (!h.customer_has_order_in_branch) {
    return no(404, `El cliente no tiene pedidos de preventa abiertos de la sucursal ${h.branch} que te toquen.`);
  }
  if (!h.branch_has_documents) {
    return no(409, `La sucursal ${h.branch} no publica tickets de Kepler: aunque se ligue la clave, no habría documento con qué cobrar.`);
  }
  if (h.otro_cliente) return no(409, `La clave ${h.code} de la sucursal ${h.branch} ya es de ${h.otro_cliente}.`);
  if (h.en_catalogo) {
    return { ok: true, code: h.en_catalogo.cliente_code.trim(), verified_by: 'catalogo', kepler_name: h.en_catalogo.nombre, warning: null };
  }
  if (h.en_tickets) return { ok: true, code: h.code, verified_by: 'tickets', kepler_name: null, warning: null };
  if (!h.sucursal_con_catalogo) {
    return {
      ok: true, code: h.code, verified_by: null, kepler_name: null,
      warning: `No se pudo verificar: la sucursal ${h.branch} no publica su catálogo de clientes y la clave no tiene tickets. Revisa que sea la correcta antes de cobrar.`,
    };
  }
  return no(400, `La clave ${h.code} no existe en el Kepler de la sucursal ${h.branch} (si la acabas de dar de alta, puede tardar unos minutos en llegar).`);
}

/** `[MCP.3.13]` Una parte de un pedido agrupado, como la ve quien pesca. */
export interface ParteDeGrupo {
  id: string;
  code: string;
  group_id: string;
  group_code: string | null;
  /** Está en el alcance de quien pesca. */
  visible: boolean;
  /** Ya va cargada: en una guía de quien pesca (`true`), de otra persona (`false`), o en ninguna (`null`). */
  cargada_por_mi: boolean | null;
  cargada_por: string | null;
}

/**
 * `[MCP.3.13]` Las partes de un pedido agrupado se cargan JUNTAS o ninguna: el grupo lo recoge una sola
 * persona (pasa a cada sucursal) y entrega todo el cobro en una caja. Decidido: si elige una parte, se
 * cargan también las demás que ve y no lleva todavía (en vez de rechazar); se rechaza sólo si una parte
 * ya la lleva otra persona o no la alcanza. `partes` = las partes ABIERTAS de los grupos de lo elegido.
 */
export function completarGrupos(
  elegidos: readonly string[],
  partes: readonly ParteDeGrupo[],
): { ids: string[]; agregados: string[]; error: string | null } {
  const sel = new Set(elegidos);
  const grupos = new Set(partes.filter((p) => sel.has(p.id)).map((p) => p.group_id));
  const agregados: string[] = [];
  for (const p of partes) {
    if (!grupos.has(p.group_id) || sel.has(p.id) || p.cargada_por_mi === true) continue;
    const pedido = p.group_code ?? 'agrupado';
    if (p.cargada_por_mi === false) {
      return { ids: [...elegidos], agregados: [], error: `La parte ${p.code} del pedido ${pedido} ya la lleva ${p.cargada_por || 'otra persona'}: un pedido agrupado lo recoge una sola persona.` };
    }
    if (!p.visible) {
      // [MCP.3.13] Si lo que no alcanza es el PRINCIPAL, se dice así (antes salía el mismo folio dos veces).
      const pieza = p.code === p.group_code ? 'su pedido principal' : `la parte ${p.code}`;
      return { ids: [...elegidos], agregados: [], error: `El pedido ${pedido} se surte también en otra sucursal (${pieza}) que no te toca: lo lleva quien reparte desde la sucursal del pedido principal.` };
    }
    agregados.push(p.id);
  }
  return { ids: [...elegidos, ...agregados], agregados, error: null };
}

/**
 * `[MCP.3.13]` En qué caja se liquida una guía: la de su sucursal, salvo una GUÍA DE RECOLECCIÓN — todos
 * sus pedidos son partes (no el principal) de grupos cuyo principal es de otra sucursal, la misma para
 * todos. Entonces la de ese principal: todo el cobro del grupo se entrega en una caja (decisión de David).
 */
export function sucursalDeLiquidacion(guia: {
  branch: string;
  orders: ReadonlyArray<{ order_id: string; group_id?: string | null; group_main_branch?: string | null }>;
}): string {
  if (!guia.orders.length) return guia.branch;
  const principales = new Set<string>();
  for (const o of guia.orders) {
    if (!o.group_id || o.group_id === o.order_id || !o.group_main_branch) return guia.branch;
    principales.add(o.group_main_branch);
  }
  const [unica] = [...principales];
  return principales.size === 1 && unica !== guia.branch ? unica : guia.branch;
}

/**
 * `[MCP.3.13]` Las guías de una liquidación van a UNA caja: todas con la misma sucursal de liquidación, y
 * ésa del alcance de quien liquida (`null` = sin recorte). Cualquier otra mezcla se sigue bloqueando.
 */
export function bloqueoSucursalesLiquidacion(
  guias: ReadonlyArray<{ folio: string; branch: string; liquidation_branch: string }>,
  cajaBranches: readonly string[] | null,
): string | null {
  const destinos = new Set(guias.map((g) => g.liquidation_branch));
  if (destinos.size > 1) {
    return 'Las guías son de distintas sucursales. Sólo se juntan con las de esta caja las guías de recolección (todas partes de un pedido agrupado de esta sucursal).';
  }
  const [destino] = [...destinos];
  if (destino && cajaBranches !== null && !cajaBranches.includes(destino)) {
    const ajenas = guias.filter((g) => g.branch !== destino).map((g) => g.folio);
    return `${ajenas.length ? 'La guía ' + ajenas.join(', ') : 'Esta guía'} se liquida en la caja de la sucursal ${destino}: ahí se entrega todo el cobro del pedido agrupado.`;
  }
  return null;
}

/** `[MCP.3.13]` Lo entregado de una sucursal dentro de una liquidación (sin nombre: lo pone el servicio). */
export interface LiquidacionSucursal {
  branch: string;
  documents_total: number;
  documents_without_total: number;
  delivered: number;
  declared_cash: number;
  declared_transfer: number;
}

/**
 * `[MCP.3.13]` Lo entregado por sucursal (la de la guía = el Kepler donde se cobró), con la sucursal de la
 * caja primero. Mismo criterio que `resumenLiquidacion`: sólo lo entregado; sin total se declara aparte.
 */
export function porSucursalLiquidacion(
  guias: ReadonlyArray<{ branch: string; orders: readonly RenglonLiquidacion[] }>,
  caja: string,
): LiquidacionSucursal[] {
  const por = new Map<string, RenglonLiquidacion[]>();
  for (const g of guias) por.set(g.branch, [...(por.get(g.branch) ?? []), ...g.orders]);
  return [...por.entries()]
    .sort(([a], [b]) => (a === caja ? -1 : b === caja ? 1 : a.localeCompare(b)))
    .map(([branch, renglones]) => {
      const r = resumenLiquidacion(renglones);
      return {
        branch,
        documents_total: r.documents_total,
        documents_without_total: r.documentos_sin_total,
        delivered: r.entregados,
        declared_cash: r.declared_cash,
        declared_transfer: r.declared_transfer,
      };
    });
}
