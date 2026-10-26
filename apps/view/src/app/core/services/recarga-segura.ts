/**
 * ⭐ `[CG.205]` **Lo que no se puede perder bloquea la recarga automática.**
 *
 * `[SW.2]` aplica la versión nueva del service worker cuando la pestaña se OCULTA (cambiar de
 * pestaña, bloquear la pantalla) y recarga. Con 11 despliegues en 4 días (medido el 2026-10-23),
 * una caja que cambiaba de pestaña mientras esperaba la firma del teléfono se recargaba y perdía el
 * pedido — y la persona firmaba otra vez.
 *
 * Quien tenga trabajo en vuelo que una recarga tiraría, lo declara acá mientras dure; `[SW.2]`
 * pregunta antes de recargar. La versión nueva no se pierde: queda pendiente para la siguiente vez
 * que se oculte la pestaña sin nada en vuelo.
 *
 * ⚠️ No es un `beforeunload`: eso es para cuando la PERSONA sale. Esto es para que la APP no la
 * saque sola.
 */
const motivos = new Set<string>();

/** Declara un motivo. Devuelve la función que lo suelta; llamarla dos veces no hace daño. */
export function bloquearRecargaAutomatica(motivo: string): () => void {
  const clave = `${motivo}#${Math.random().toString(36).slice(2)}`;
  motivos.add(clave);
  return () => { motivos.delete(clave); };
}

export function recargaAutomaticaBloqueada(): boolean {
  return motivos.size > 0;
}
