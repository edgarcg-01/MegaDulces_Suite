import {
  ETAPAS_PEDIDO,
  WAREHOUSE_ORDER_CANCELADO,
  type EtapaPedido,
  type EtapaPedidoResultado,
} from '@megadulces/contracts';

/**
 * `[GP.10.2]` La etapa de ALMACÉN de un pedido, de Kepler (`U-D-40`) o de preventa (`PD-`), sale de
 * esta función y de ninguna otra en la consola maestra. Pura: el servicio trae los hechos.
 *
 * Por qué una sola: la consola junta dos mundos que hoy derivan su etapa por separado —Kepler por su
 * estatus `c11`, preventa por `etapaDe` (Mesa de Control) y por el `state` de la bandeja de surtido—
 * y dos derivaciones del mismo hecho terminan diciendo cosas distintas (ADR-056).
 *
 * ⚠️ Las dos de preventa NO se retiran todavía: D9 deja el proceso de preventa como está en esta
 * etapa. Se cruzan contra ésta en `etapa-pedido.spec.ts` (si una se mueve, la prueba truena) y su
 * retiro queda como deuda con nombre: GP.10.2-deuda.
 */

/** Lo que el servicio sabe de un pedido. Todo lo que no se sabe va `null`, nunca un valor inventado. */
export interface HechosPedido {
  origen: 'kepler' | 'preventa';
  /**
   * Kepler: estatus VIGENTE (`ESTATUS_VIGENTE_SQL`, CANCELADO incluido). `null` = el ODS no trae la
   * cabecera. En preventa va `null`: el `PD-` no vive en Kepler.
   */
  kepler: string | null;
  /** La ola VIVA del pedido en la Suite: estado de la ola y etapa del pedido dentro de ella. */
  ola: { status: string; stage: string | null } | null;
  /** Checado en la Suite (`commercial.order_checks.status`, sin los cancelados). */
  checado: 'en_checado' | 'checado' | null;
  /** Preventa: `commercial.orders.status`. */
  pedido_status?: string | null;
  /** Preventa: surtido pedido por pedido (`commercial.presale_picks`) y su revisión en caja (ADR-110). */
  pick?: { iniciado: boolean; terminado: boolean; revisado: boolean } | null;
  /** Preventa: ya salió del almacén (cobrado en Kepler, en una guía impresa o entregado). */
  salio?: boolean;
}

/** Estatus de Kepler → etapa. Lo que Kepler traiga nuevo no se inventa: queda sin mapear (`null`). */
const DE_KEPLER: Readonly<Record<string, EtapaPedido>> = {
  CREADO: 'creado',
  AUTORIZADO: 'autorizado',
  SURTIDO: 'surtido',
  CHECADO: 'checado',
  EMBARCADO: 'embarcado',
};

/** Los hitos que registran Kepler Y el piso: sólo en ellos tiene sentido decir que uno va adelante. */
const HITOS_COMUNES: ReadonlySet<EtapaPedido> = new Set<EtapaPedido>(['surtido', 'checado', 'embarcado']);

const orden = (e: EtapaPedido | null): number => (e ? (ETAPAS_PEDIDO as readonly string[]).indexOf(e) : -1);

/** Lo que dice el piso (la Suite), o `null` si el pedido nunca pasó por ella. */
export function etapaDelPiso(h: HechosPedido): EtapaPedido | null {
  if (h.salio) return 'embarcado';
  if (h.checado === 'checado' || h.pick?.revisado) return 'checado';
  if (h.checado === 'en_checado') return 'checando';
  if (h.pick?.terminado) return 'surtido';
  if (h.ola) {
    if (h.ola.stage === 'listo_embarque' || h.ola.status === 'surtida' || h.ola.status === 'cerrada') return 'surtido';
    if (h.ola.status === 'en_surtido') return 'surtiendo';
    return 'en_cola';
  }
  if (h.pick?.iniciado) return 'surtiendo';
  return null;
}

export function etapaDePedido(h: HechosPedido): EtapaPedidoResultado {
  if (h.origen === 'preventa') {
    // Lo cerrado manda sobre la huella del piso, igual que en `etapaDe`: un pedido entregado con un
    // surtido que quedó a medias está entregado (lo encontró el cruce del spec).
    if (h.pedido_status === 'cancelled') return { etapa: 'cancelado', fuente: 'piso', desfase: null };
    if (h.pedido_status === 'fulfilled') return { etapa: 'embarcado', fuente: 'piso', desfase: null };
    // Un `PD-` confirmado ya es trabajo del almacén: es su «autorizado».
    return { etapa: etapaDelPiso(h) ?? 'autorizado', fuente: 'piso', desfase: null };
  }

  if (h.kepler === WAREHOUSE_ORDER_CANCELADO) return { etapa: 'cancelado', fuente: 'kepler', desfase: null };
  const deKepler = h.kepler ? (DE_KEPLER[h.kepler] ?? null) : null;
  // Sin cabecera (o con un estatus que no conocemos) no se dibuja «creado»: se declara (ADR-056).
  if (!deKepler) return { etapa: 'sin_dato', fuente: null, desfase: null };

  const piso = etapaDelPiso(h);
  const ik = orden(deKepler);
  const ip = orden(piso);
  const etapa = ip > ik && piso ? piso : deKepler;
  const fuente = ip > ik ? 'piso' : 'kepler';

  let desfase: EtapaPedidoResultado['desfase'] = null;
  if (piso && ip > ik && HITOS_COMUNES.has(piso)) desfase = 'piso_adelante';
  else if (piso && ik > ip && HITOS_COMUNES.has(deKepler)) desfase = 'kepler_adelante';
  return { etapa, fuente, desfase };
}
