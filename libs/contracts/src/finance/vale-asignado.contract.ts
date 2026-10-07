/**
 * `[GX.41]` **El vale que Kepler le asigna a una persona por su nombre de usuario.**
 *
 * Pedido textual: *«lo que vas a leer en ese campo es un username, el cual debera coincidir
 * con alguno de nuestros usuarios en suite (…) cuando coincidan lo que haras es que va a
 * aparecer ese vale en la seccion de "Mis Gastos" en el perfil del usuario que vinculaste»*.
 *
 * ## Qué campo es
 * La caja **«Solicita»** de la pantalla de Kepler = `kdm1.c48`, que la vista
 * `analytics.expense_requests` ya publica como **`solicitante`**. El resto del vale
 * (destinatario, importe, concepto, fecha) sale del **mismo** documento de Kepler.
 *
 * ## ⛔ Por qué la comparación no puede ser `=` a secas
 * La vista **normaliza** `c48` al publicarlo: `upper(regexp_replace(btrim(c48),'\s+',' '))`.
 * O sea que un `demo_captura` tecleado en Kepler llega como `DEMO_CAPTURA`. Comparar contra
 * `users.username` tal cual **nunca casaría** — y el defecto no se ve: la sección sale vacía
 * y parece que no le asignaron nada.
 *
 * ## ⛔ Y no puede ser «contiene»
 * `JUAN` no puede casar con `JUANA`, ni `02` con `1024`. Es **igualdad exacta después de
 * normalizar**, nunca prefijo ni substring: un vale mal asignado le muestra a alguien el
 * gasto de otro, que es justo lo que el usuario pidió que no pasara en GX.34.
 *
 * ## ⚠️ El riesgo que se declara en vez de taparse
 * Hoy la caja «Solicita» trae **áreas**, no usuarios (`10 PADRE HIDALGO RD`, `8 ESQUINAS`).
 * Medido el 2026-09-28 en prod: de **9,968** solicitudes con ese campo lleno, **0 casan** con
 * un usuario nuestro — la práctica de escribir el username ahí es **nueva**. El día que
 * convivan las dos cosas, un usuario que se llame igual que un área se llevaría los vales de
 * esa área. Por eso el vale asignado viaja **diciendo de dónde salió el vínculo**
 * (`vinculado_por: 'solicita'`), para que se pueda ver y corregir, y por eso hay un largo
 * mínimo: un campo con un carácter suelto no vincula nada.
 */

/** Largo mínimo del valor para que se considere un vínculo. Hay usuarios de 2 (`02`, `03`). */
export const LARGO_MINIMO_USUARIO = 2;

/**
 * Deja el valor en la forma en que la vista lo publica: sin espacios al borde, con los
 * espacios internos colapsados, en mayúsculas. Se aplica a **los dos lados** de la
 * comparación — si sólo se normaliza uno, la igualdad depende de cómo lo tecleó alguien.
 */
export function normalizarUsuarioKepler(v: string | null | undefined): string {
  return String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * ¿Este valor de la caja «Solicita» es esta persona?
 *
 * Devuelve `false` para vacío, para lo más corto que `LARGO_MINIMO_USUARIO` y para cualquier
 * coincidencia parcial. **Nunca** lanza: un campo con basura es un no-vínculo, no un error.
 */
export function esMiVale(solicita: string | null | undefined, username: string | null | undefined): boolean {
  const a = normalizarUsuarioKepler(solicita);
  const b = normalizarUsuarioKepler(username);
  if (a.length < LARGO_MINIMO_USUARIO || b.length < LARGO_MINIMO_USUARIO) return false;
  return a === b;
}

/** De dónde salió el vínculo. Hoy hay uno solo; viaja igual, para que la pantalla lo pueda decir. */
export type OrigenVinculo = 'solicita';

/**
 * Un vale de Kepler asignado a alguien **que todavía no tiene expediente nuestro**.
 *
 * ⚠️ No es un `ExpenseProof`: no tiene `id` ni `status` ni archivos, porque **no existe** de
 * este lado. Es el documento de Kepler, derivado en vivo. Se vuelve expediente recién cuando
 * la persona le sube la evidencia — y ahí entra por el camino normal (`create`).
 */
export interface ValeAsignado {
  sucursal: string;
  folio: string;
  fecha: string | null;
  importe: number;
  /** La caja «Solicita» tal como vino, **sin normalizar**: es lo que la persona tiene que ver. */
  solicita: string | null;
  /** El destinatario del mismo vale de Kepler (`c32`). */
  destinatario: string | null;
  concepto: string | null;
  estado: string | null;
  /** `true` = Kepler ya generó el gasto. Un vale así ya no espera evidencia para ejercerse. */
  aplicada: boolean | null;
  vinculado_por: OrigenVinculo;
}
