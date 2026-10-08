/**
 * `[CG.68]` **El contrato de la firma del movimiento de caja**, compartido por las dos puntas.
 *
 * ⚠️ Vive acá y no en `libs/finance` por una razón de frontera, no de gusto: `libs/finance` es
 * backend (NestJS, Knex) y `apps/view` **no puede importarlo** — la restricción de Nx lo frena, y
 * con razón. Sin este archivo, la comparación de abajo se habría escrito dos veces: una en el
 * servidor y otra en la pantalla. Dos copias de una regla de integridad es la forma más barata de
 * que una de las dos quede vieja (ADR-056).
 */

/**
 * Lo MÍNIMO que el teléfono necesita para saber qué está firmando.
 *
 * ⚠️ Es deliberadamente corto. El teléfono del mostrador se le pasa a otras personas: es una
 * superficie para firmar, no una segunda pantalla de caja. Mandarle el movimiento entero sería
 * publicar el detalle del efectivo en un aparato que cambia de manos.
 */
export interface ContextoFirma {
  readonly tipo: string;
  readonly monto: number;
  readonly beneficiario: string | null;
  readonly documento: string | null;
}

/** La firma que vuelve del teléfono. */
export interface FirmaRecibida {
  readonly codigo: string;
  readonly png: string;
  readonly nombre: string | null;
  /**
   * ⭐ El monto que se le **mostró** a quien firmó. La pantalla lo compara con el de ahora: si el
   * cajero cambió el importe después, la firma dejó de corresponder — y sin este campo nadie se
   * enteraría, porque la pantalla seguiría diciendo «firmado» sobre otra cifra.
   */
  readonly monto_firmado: number;
  readonly por: string | null;
}

/** Cuánto vive un código de emparejamiento, sin reclamar y ya reclamado. */
export const FIRMA_VIDA_MS = 3 * 60 * 1000;

/**
 * ⭐ ¿La firma que volvió sigue correspondiendo a lo que hay en pantalla?
 *
 * Compara el monto que se le mostró a quien firmó contra el que está ahora. **Falla cerrado**:
 * ante un número que no es número, la firma no cuenta — nunca al revés.
 */
export function firmaSigueValiendo(montoFirmado: number, montoAhora: number): boolean {
  const a = Number(montoFirmado);
  const b = Number(montoAhora);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  // Al centavo: el monto sale de un conteo de piezas, no de una medición.
  return Math.abs(a - b) < 0.005;
}
