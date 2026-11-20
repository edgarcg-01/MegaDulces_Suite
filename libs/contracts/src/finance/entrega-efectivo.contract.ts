/**
 * `[PGP.157]` **El anticipo en efectivo autorizado que Caja General tiene por entregar, y de qué caja sale.**
 *
 * Francisco (2026-11-19), con el anticipo de DELICIATE: *«una vez autorizado el anticipo con caja general, que se
 * genere en caja general, en la sucursal que se le va a dar el dinero»*.
 *
 * ⛔ **Cada base cuadra sola** (Francisco, 2026-11-19, corrigiendo lo dicho antes ese mismo día): el anticipo de una
 * compra de Morelia sale de la Caja General de la base de Morelia (08), se captura en el Kepler de la 08 y se aplica
 * a la factura de la 08. Si saliera de la 00, el cuadre de la 08 no podría aplicar un pago de otra base (medido:
 * Kepler aplica abono y factura en la misma base, 115 de 115 en 12 meses; la 08 ya lo hace así: su `X-D-60`
 * 0000001 salió de su 0011 y se aplicó a 5 facturas de la 08). Por eso **la caja no se elige: es la de la base del
 * anticipo**, que es la de su OC (`[PGP.127]` D11).
 *
 * ⛔ **No se copia nada.** «Por entregar» se DERIVA al leer: el pago del Calendario (método y autorización) y el
 * pareo con Kepler que ya hace el seguimiento de anticipos (`parearSolicitudes`). Quitar la autorización lo saca.
 */
import { warehouseName } from '../http/warehouse-order.contract';
import type { CandidatoAnticipoKepler, EtapaSolicitudAnticipo, RefOcKepler } from './anticipos.contract';

/** La sucursal de Kepler de Oficinas. */
export const SUCURSAL_OFICINAS = '00';

/**
 * `[PGP.157]` Los estados de un día del Calendario que lo dan por AUTORIZADO completo (el día se libera de un
 * golpe). Un pago también está autorizado si se autorizó él solo (`authorized_at`, `[PGP.113]`).
 */
export const ESTADOS_DIA_AUTORIZADO: ReadonlyArray<string> = Object.freeze(['released', 'executing', 'closed']);

/**
 * El nombre de la base. La `00` es **Oficinas**: el catálogo todavía la llama CEDIS, pero así la llama Kepler.
 * Un código que no se conoce se devuelve tal cual (nunca se adivina).
 */
export function nombreDeBase(codigo: string | null | undefined): string {
  const c = String(codigo ?? '').trim();
  if (c === SUCURSAL_OFICINAS) return 'Oficinas';
  return warehouseName(c);
}

/** Lo que se guarda en `cash_register_text` de un anticipo en efectivo: «Caja General · Morelia Abastos». */
export function cajaDeSalidaTexto(sucursal: string): string {
  return `Caja General · ${nombreDeBase(sucursal)}`;
}

/**
 * ¿El `X-D-60` pareado es el de ESTA entrega? Sólo si no es anterior a la autorización del pago (o, sin ella, al día
 * del pago). El seguimiento parea desde 5 días antes del pedido; un `X-D-60` de antes de autorizar es otro dinero
 * (revisión independiente, 2026-11-19: escondía una entrega que no había pasado). Sin fecha de corte, cuenta.
 */
export function xd60DeLaEntrega(kepler: { fecha: string } | null | undefined, desde: string | null | undefined): boolean {
  if (!kepler) return false;
  const corte = String(desde ?? '').slice(0, 10);
  return !corte || String(kepler.fecha).slice(0, 10) >= corte;
}

/** `[PGP.157]` Lo que UN pago del Calendario le dice a Caja General sobre un anticipo. */
export interface PagoDeEntrega {
  pago_metodo: string | null;
  pago_estado: string | null;
  /** El pago, o su día completo, ya lo autorizó Dirección. */
  pago_autorizado: boolean;
}

/**
 * ¿Caja General tiene este pago de anticipo por entregar? Sí, si es en efectivo, está autorizado, sigue pendiente y
 * Kepler todavía no tiene SU `X-D-60` (`xd60DeLaEntrega`). Con el `X-D-60` capturado, el pago ya es un documento de la
 * cola de Captura como cualquier otro de su base.
 */
export function porEntregar(s: PagoDeEntrega & { etapa: EtapaSolicitudAnticipo; con_xd60: boolean }): boolean {
  return s.pago_metodo === 'efectivo' && s.pago_autorizado && s.pago_estado === 'pending' && s.etapa !== 'cancelado' && !s.con_xd60;
}

/** `[PGP.157]` Un renglón de «Anticipos en efectivo por entregar» en Captura (`GET commercial/supplier-obligations/anticipos/por-entregar`). */
export interface AnticipoPorEntregarRow {
  obligation_id: string;
  allocation_id: string;
  /** El folio del pago (`AAMMDD-01-NN`), el que imprime la instrucción. Null si se autorizó el día sin folio. */
  pago_folio: string | null;
  /** El día del Calendario (`YYYY-MM-DD`). */
  programado_dia: string | null;
  proveedor: string;
  proveedor_nombre: string;
  /** La base del anticipo (la de su OC): de su Caja General sale el efectivo, ahí se captura el `X-D-60` y se aplica. */
  sucursal: string | null;
  /** Lo que se entrega en ESTE pago (un anticipo partido en dos pagos son dos renglones). */
  monto: number;
  /** El importe del anticipo completo (con él se parea el `X-D-60`). */
  monto_anticipo: number;
  motivo: string | null;
  ocs: RefOcKepler[];
  autorizado_por: string | null;
  /** `YYYY-MM-DDTHH:MI`, hora de México. */
  autorizado_el: string | null;
  /**
   * Un `X-D-60` del mismo proveedor, base e importe ANTERIOR a la autorización: no se cuenta como esta entrega, pero
   * se dice («revisa que no se haya entregado ya»). Null si no hay.
   */
  kepler_previo: CandidatoAnticipoKepler | null;
}
