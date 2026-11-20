import type { CartKind, CartReleaseReason, LocationStatus } from '@megadulces/contracts';

/**
 * `[GP.11.3]` Las reglas de la carreta (FASE_GP paso 4, D7, D22), sin base de por medio: qué pasa al escanear
 * una carreta para un pedido y quién puede soltarla. El servicio sólo junta los hechos y aplica esto; la base
 * vuelve a exigir lo esencial (una carreta abierta por pedido, sólo carretas activas del almacén).
 */

export interface CarretaHechos {
  code: string;
  tipo: CartKind;
  estado: LocationStatus;
  motivo_estado: string | null;
  /** La ocupación abierta, si la hay. */
  ocupacion: { order_id: string; pedido: string; occupied_by: string; occupied_by_name: string; occupied_at: string } | null;
}

/** El pedido como lo ve el surtido: quién lo está surtiendo y si ya terminó. */
export interface PedidoHechos {
  order_id: string;
  pedido: string;
  /** `null` = nadie lo ha empezado. */
  surtidor_id: string | null;
  surtidor_nombre: string | null;
  terminado: boolean;
}

export type Decision =
  | { ok: true; accion: 'ocupar' | 'ya_estaba' }
  | { ok: false; status: 403 | 404 | 409; motivo: string };

export type DecisionLiberar = { ok: true } | { ok: false; status: 403 | 404 | 409; motivo: string };

const no = (status: 403 | 404 | 409, motivo: string): { ok: false; status: 403 | 404 | 409; motivo: string } => ({ ok: false, status, motivo });

/**
 * Al escanear una carreta para un pedido. La carreta se toma **al empezar a surtir** y la toma **quien lo
 * surte**; un pedido puede llevar varias («agregar otra carreta»), una carreta lleva un solo pedido (D7).
 */
export function decidirOcupar(
  carreta: CarretaHechos | null,
  pedido: PedidoHechos | null,
  yo: string,
  hora: (iso: string) => string,
  carretaLeida: string,
  almacen: string,
): Decision {
  if (!carreta) return no(404, `${carretaLeida} no está dada de alta en ${almacen}. Se da de alta en Ubicaciones › Carretas.`);
  const nombre = `${carreta.tipo === 'carrito' ? 'El carrito' : 'La carreta'} ${carreta.code}`;
  if (carreta.estado !== 'activa') {
    const o = carreta.tipo === 'carrito' ? 'o' : 'a';
    return no(409, `${nombre} está ${carreta.estado === 'baja' ? `dad${o} de baja` : `bloquead${o}`}${carreta.motivo_estado ? ` (${carreta.motivo_estado})` : ''}: usa otra.`);
  }
  if (!pedido) return no(404, 'No encontré ese pedido en el surtido de tu sucursal.');
  if (carreta.ocupacion && carreta.ocupacion.order_id === pedido.order_id) return { ok: true, accion: 'ya_estaba' };
  if (carreta.ocupacion) {
    return no(409, `${nombre} ya trae el pedido ${carreta.ocupacion.pedido}, de ${carreta.ocupacion.occupied_by_name} desde las ${hora(carreta.ocupacion.occupied_at)}. Usa otra.`);
  }
  if (pedido.terminado) return no(409, `El pedido ${pedido.pedido} ya se terminó de surtir: la carreta se toma al empezar.`);
  if (!pedido.surtidor_id) return no(409, `Primero empieza a surtir el pedido ${pedido.pedido}; luego escanea la carreta.`);
  if (pedido.surtidor_id !== yo) return no(403, `El pedido ${pedido.pedido} lo está surtiendo ${pedido.surtidor_nombre ?? 'otra persona'}.`);
  return { ok: true, accion: 'ocupar' };
}

/**
 * Soltar una carreta antes del embarque. `deshecho`: quien la escaneó, mientras el pedido siga en surtido
 * (se equivocó de carreta). `manual`: el coordinador, provisional hasta que E4 la libere al cargar (D22).
 */
export function decidirLiberar(
  ocupacion: { occupied_by: string; pedido: string } | null,
  motivo: CartReleaseReason | string,
  yo: string,
  puedeCoordinar: boolean,
  pedidoTerminado: boolean,
): DecisionLiberar {
  if (motivo !== 'manual' && motivo !== 'deshecho') {
    return no(409, motivo === 'cargado' ? 'La carreta se libera sola al cargar el camión (embarque); aquí sólo «deshacer» o «liberar».' : `Motivo desconocido: ${motivo}.`);
  }
  if (!ocupacion) return no(409, 'Esa carreta ya está libre.');
  if (motivo === 'deshecho') {
    if (ocupacion.occupied_by !== yo) return no(403, 'Sólo quien escaneó la carreta puede deshacerlo; si no, pídeselo al coordinador.');
    if (pedidoTerminado) return no(409, `El pedido ${ocupacion.pedido} ya se surtió: la carreta va con él al checado. Si hay que soltarla, es del coordinador.`);
    return { ok: true };
  }
  if (!puedeCoordinar) return no(403, 'Liberar una carreta con pedido es del coordinador de surtido.');
  return { ok: true };
}
