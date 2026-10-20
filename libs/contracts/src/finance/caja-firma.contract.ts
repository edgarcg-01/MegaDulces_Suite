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

/**
 * ⭐⭐ `[CG.196]` **Cuánto vive un código de emparejamiento — un RESPALDO, no la puerta.**
 *
 * Pedido de Edgar (2026-10-20): *«el token de la firma caduca muy rápido, o si se bloquea el
 * teléfono se pierde; que dure más y no se venza hasta que se firme o se cancele»*.
 *
 * ── Quién manda de verdad sobre la vida del código ──────────────────────────────────────────
 *
 * **El emparejamiento vive en el socket de la PC** (`client.data.firma`), y `decidirTomar` exige
 * encontrar esa marca en la room. O sea que el código **ya** moría cuando la caja cerraba el
 * panel (`firma:cerrar`) o cuando la PC se desconectaba: *«hasta que se firme o se cancele»* es
 * lo que el diseño hace, sin reloj. Este número es sólo el tope de un panel **abandonado**.
 *
 * ⛔ **Eran 3 minutos y ésa era la mitad del problema.** La otra mitad era un defecto, no un
 * parámetro: al bloquearse el teléfono su socket caía, el servidor emitía `firma:cortada` a toda
 * la room y **la PC destruía el emparejamiento** — ver `[CG.196]` en `caja.gateway.ts`. Subir
 * este número sin arreglar aquello no habría cambiado nada.
 *
 * ── ⭐ Por qué subirlo NO afloja la puerta, medido contra el código ──────────────────────────
 *
 * El comentario de `TOPE_INTENTOS` justificaba los 3 minutos con la aritmética de la fuerza
 * bruta —31^6 = 887 millones en 180 segundos—. **Esa cuenta sobra, porque el reloj nunca fue la
 * defensa:** un invitado (el que entra con el pase del QR, sin sesión) **sólo puede reclamar el
 * código de SU propio pase** (`tomarFirma` compara contra `paseCodigo`). Adivinar un código ajeno
 * exige una **sesión iniciada con permiso de Caja General**, o sea un empleado del área — y ahí
 * el tope de 5 intentos por socket sigue siendo el detector, igual que antes.
 *
 * Dicho de otro modo: el reloj acotaba a quien ya estaba adentro, no a quien está afuera.
 *
 * ── Por qué 8 horas y no «infinito» ─────────────────────────────────────────────────────────
 *
 * Un turno. Cubre de sobra el caso real —un teléfono bloqueado que vuelve en minutos— y conserva
 * el único riesgo que el número protegía: un panel que alguien dejó abierto y se fue. Sin tope,
 * un QR impreso en una pantalla olvidada seguiría sirviendo mañana.
 *
 * ⚠️ Y acota también al **pase** del QR, que se firma con este mismo valor (`expiresIn`). Un pase
 * más corto que el código reintroduce el bug por otra puerta: el teléfono vuelve del bloqueo, el
 * emparejamiento sigue vivo y el pase ya no sirve. **Los dos tienen que medir lo mismo.**
 */
export const FIRMA_VIDA_MS = 8 * 60 * 60 * 1000;

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
