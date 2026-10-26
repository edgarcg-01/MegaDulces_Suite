import {
  firmaSigueValiendo,
  type EstadoFirmaSolicitud,
  type FalloFirmaSolicitud,
} from '@megadulces/contracts';

/**
 * ⭐⭐ `[CG.200]` **La máquina de estados del pedido de firma por teléfono.** Pura: sin base, sin
 * reloj propio, sin sockets. El servicio lee la fila (con candado), pregunta acá, y escribe lo que
 * esto decide.
 *
 *     abierta ──tomar──▶ tomada ──firmar──▶ firmada ──usar──▶ usada
 *        │                  │                  │
 *        └──────────────── cancelar ───────────┘──▶ cancelada
 *
 *     y `vencida`, que no se guarda: es `abierta`/`tomada` con `expira_at` en el pasado.
 *
 * ── Las reglas, y el incidente que cada una evita ────────────────────────────────────────────
 *
 *   · **Re-tomar desde el MISMO teléfono no es un segundo uso.** Bloquear la pantalla, recargar
 *     o perder el wifi es el caso NORMAL (`[CG.196]`), y antes costaba firmar otra vez.
 *   · **Otro teléfono no entra.** Quien fotografía el QR no ve el contexto del efectivo.
 *   · **Firmar dos veces devuelve lo mismo** (idempotente). El doble toque, o un reintento cuyo
 *     acuse se perdió en el aire, no duplica ni pisa: la primera firma manda.
 *   · **Una firma firmada no vence.** El reloj acota un pedido abandonado; una firma ya hecha es
 *     evidencia y se puede guardar con su movimiento aunque pase la hora.
 *   · **Se usa una vez, y sólo con el mismo monto** (`firmaSigueValiendo`, al centavo).
 */

/** Lo que la decisión necesita de la fila. */
export interface FilaFirma {
  readonly estado: Exclude<EstadoFirmaSolicitud, 'vencida'>;
  readonly expira_at: Date | string;
  readonly telefono_id: string | null;
  readonly monto: number | string;
  readonly tipo: string;
}

export type Decision<T extends string> =
  | { readonly ok: true; readonly accion: T }
  | { readonly ok: false; readonly fallo: FalloFirmaSolicitud };

const no = (fallo: FalloFirmaSolicitud): { ok: false; fallo: FalloFirmaSolicitud } => ({ ok: false, fallo });

/** El estado que se le dice a quien pregunta: el guardado, salvo que el reloj ya lo venció. */
export function estadoVigente(fila: FilaFirma, ahora: Date): EstadoFirmaSolicitud {
  if ((fila.estado === 'abierta' || fila.estado === 'tomada') && new Date(fila.expira_at) <= ahora) {
    return 'vencida';
  }
  return fila.estado;
}

/** Un id de teléfono usable: lo genera el teléfono, así que se acota antes de creerle. */
export function telefonoValido(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

/**
 * El teléfono abre el QR. `tomar` marca el pedido como suyo; `ver` es el mismo teléfono que
 * vuelve (no se toca nada); `ver_firmada` es el mismo teléfono después de firmar — se le dice que
 * ya quedó, en vez de pedirle otra firma.
 */
export function decidirTomar(
  fila: FilaFirma | null,
  telefonoId: string,
  ahora: Date,
): Decision<'tomar' | 'ver' | 'ver_firmada'> {
  if (!fila) return no('no_existe');
  const e = estadoVigente(fila, ahora);
  if (e === 'cancelada') return no('cancelada');
  if (e === 'vencida') return no('vencida');
  if (e === 'usada') return no('ya_usada');
  if (e === 'abierta') return { ok: true, accion: 'tomar' };
  // tomada o firmada: sólo el mismo teléfono.
  if (fila.telefono_id !== telefonoId) return no('otro_telefono');
  return { ok: true, accion: e === 'firmada' ? 'ver_firmada' : 'ver' };
}

/**
 * El teléfono manda el trazo. ⚠️ La validez del PNG la decide `revisarFirma` (necesita el tipo):
 * acá llega ya resuelta en `pngValido`.
 *
 * `guardar` = primera firma · `repetida` = ya estaba firmada por este teléfono: se contesta OK y
 * NO se pisa (el acuse del primer envío pudo perderse; la persona no tiene por qué saberlo).
 */
export function decidirFirmar(
  fila: FilaFirma | null,
  telefonoId: string,
  pngValido: boolean,
  ahora: Date,
): Decision<'guardar' | 'repetida'> {
  if (!fila) return no('no_existe');
  const e = estadoVigente(fila, ahora);
  if (e === 'firmada' || e === 'usada') {
    return fila.telefono_id === telefonoId ? { ok: true, accion: 'repetida' } : no('otro_telefono');
  }
  if (e === 'cancelada') return no('cancelada');
  if (e === 'vencida') return no('vencida');
  // abierta (el teléfono firmó sin haber pasado por `tomar`, p. ej. reintento tras reinicio) o tomada.
  if (e === 'tomada' && fila.telefono_id !== telefonoId) return no('otro_telefono');
  if (!pngValido) return no('no_es_firma');
  return { ok: true, accion: 'guardar' };
}

/** La PC guarda el movimiento con esta firma. Una vez, y sólo si el monto es el que se firmó. */
export function decidirUsar(fila: FilaFirma | null, tipo: string, montoAhora: number): Decision<'usar'> {
  if (!fila) return no('no_existe');
  if (fila.estado === 'usada') return no('ya_usada');
  if (fila.estado === 'cancelada') return no('cancelada');
  if (fila.estado !== 'firmada') return no('no_firmada');
  if (fila.tipo !== tipo || !firmaSigueValiendo(Number(fila.monto), montoAhora)) return no('monto_distinto');
  return { ok: true, accion: 'usar' };
}

/** La PC cancela. Lo usado ya es parte de un movimiento y no se cancela; lo cancelado, ya está. */
export function decidirCancelar(fila: FilaFirma | null): Decision<'cancelar' | 'ya_cancelada'> {
  if (!fila) return no('no_existe');
  if (fila.estado === 'usada') return no('ya_usada');
  if (fila.estado === 'cancelada') return { ok: true, accion: 'ya_cancelada' };
  return { ok: true, accion: 'cancelar' };
}

/** El código HTTP de cada fallo. Uno por causa, para que el cliente no tenga que adivinar. */
export function statusDeFallo(f: FalloFirmaSolicitud): number {
  switch (f) {
    case 'no_existe': return 404;
    case 'vencida': case 'cancelada': case 'ya_usada': return 410;
    case 'otro_telefono': return 409;
    case 'no_es_firma': case 'no_firmada': case 'monto_distinto': return 422;
  }
}
