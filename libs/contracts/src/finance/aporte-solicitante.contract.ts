/**
 * `[GX.14]` — **La compuerta**: qué tiene que aportar quien gastó antes de que su
 * solicitud llegue a revisión.
 *
 * Son dos cosas, y las dos nacen de una medición sobre prod (2026-09-23):
 *   1. **Cómo se pagó** — 5,410 de 10,082 solicitudes (54%, $20.3 M) llegan sin
 *      `forma_pago`. Ver `forma-pago.contract.ts`.
 *   2. **La foto del comprobante, tomada en vivo** — `finance.expense_proofs` tenía
 *      **9 filas** contra esas 10,082 solicitudes (0.09%).
 *
 * ## Por qué la regla vive acá y no en el servicio
 * La misma respuesta la necesitan dos lados: el botón «Mandar a revisión» (que se
 * enciende o no) y el `400` del backend (que lo impide de verdad). Escribirla dos veces
 * garantiza que se separen — es el defecto que ADR-056 midió ocho veces. Acá se escribe
 * una vez y los dos la leen.
 *
 * El backend **igual valida**: que el botón esté apagado no es un control, es una
 * cortesía. El control es el `400`.
 *
 * ## ⚠️ Qué significa «en vivo», exactamente
 * `live: true` lo pone el cliente cuando la foto salió de la cámara abierta en la
 * pantalla, no de un archivo. Es una **declaración del cliente, no una prueba**: quien
 * quiera falsificarla puede. Lo que esta regla logra es que (a) la interfaz no ofrezca
 * otro camino, y (b) el archivo llegue con su sello, así que quien revisa ve de dónde
 * salió y una foto sin sello se distingue de una con sello.
 *
 * Volverlo demostrable del lado del servidor exige otra cosa (que los bytes entren por
 * un canal de cámara con sesión, o correlacionar EXIF contra la hora de captura). No
 * está hecho y **se declara** acá en vez de aparentar que el flag prueba algo.
 */

import { esFormaPagoValida, exigeDetalle } from './forma-pago.contract';

/** Un archivo adjunto, visto sólo como lo que esta regla necesita saber de él. */
export interface EvidenciaAdjunta {
  /** Rol del archivo (`comprobante_1`, `solicitud_kepler`, …). */
  role?: string | null;
  /** `true` si salió de la cámara de la pantalla. Ver la advertencia del encabezado. */
  live?: boolean | null;
}

/** Lo que hay cargado hasta ahora, para preguntarle a la regla qué falta. */
export interface EstadoAporte {
  forma_pago?: string | null;
  forma_pago_detalle?: string | null;
  /** Todos los adjuntos, con su rol. La regla se queda con los `comprobante*`. */
  archivos?: readonly EvidenciaAdjunta[] | null;
  /**
   * ¿Este gasto debe llevar foto? Sale de la clasificación: un `no_comprobable`
   * cierra sin foto (con motivo). Lo decide `requiereEvidencia()` en el servicio.
   */
  exige_evidencia: boolean;
}

/** Cada cosa que falta, con el texto que se le muestra a la persona. */
export type FaltanteId = 'forma_pago' | 'forma_pago_detalle' | 'evidencia' | 'evidencia_en_vivo';

export interface Faltante {
  id: FaltanteId;
  /** Frase corta para el botón o el checklist. */
  label: string;
  /** Frase larga para el `400` del backend. */
  motivo: string;
}

/** ¿El adjunto es la evidencia del gasto (el ticket o la factura)? */
function esComprobante(f: EvidenciaAdjunta): boolean {
  return String(f?.role ?? '').startsWith('comprobante');
}

/**
 * Qué falta para poder mandar la solicitud a revisión. Lista vacía = se puede mandar.
 *
 * El orden importa: es el que se le muestra a la persona, y es el orden en que se
 * resuelven (no tiene sentido pedirle el detalle de una forma de pago que todavía no
 * eligió).
 */
export function faltaParaMandar(estado: EstadoAporte): Faltante[] {
  const faltan: Faltante[] = [];
  const archivos = estado.archivos ?? [];

  if (!esFormaPagoValida(estado.forma_pago)) {
    faltan.push({
      id: 'forma_pago',
      label: 'Cómo se pagó',
      motivo: 'falta declarar cómo se pagó el gasto (efectivo, tarjeta, transferencia, cheque, vales u otro)',
    });
  } else if (exigeDetalle(estado.forma_pago) && !String(estado.forma_pago_detalle ?? '').trim()) {
    faltan.push({
      id: 'forma_pago_detalle',
      label: 'El dato del pago',
      motivo: 'la forma de pago elegida exige su dato (caja, últimos 4 dígitos, referencia o número de cheque)',
    });
  }

  if (estado.exige_evidencia) {
    const comprobantes = archivos.filter(esComprobante);
    if (comprobantes.length === 0) {
      faltan.push({
        id: 'evidencia',
        label: 'La foto del comprobante',
        motivo: 'falta la foto del comprobante (el ticket o la factura)',
      });
    } else if (!comprobantes.some((f) => f.live === true)) {
      // Hay comprobante, pero ninguno con el sello de cámara. Es un faltante DISTINTO de
      // «no hay foto»: el mensaje tiene que decir por qué no sirve la que subió, o la
      // persona vuelve a subir la misma.
      faltan.push({
        id: 'evidencia_en_vivo',
        label: 'Tomarla con la cámara',
        motivo: 'el comprobante tiene que tomarse con la cámara en el momento; un archivo guardado no cuenta',
      });
    }
  }

  return faltan;
}

/** ¿Se puede mandar a revisión? */
export function puedeMandar(estado: EstadoAporte): boolean {
  return faltaParaMandar(estado).length === 0;
}
