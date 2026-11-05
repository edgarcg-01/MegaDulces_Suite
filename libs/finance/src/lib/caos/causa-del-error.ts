/**
 * ⛔ `[CGA-A.37]` **La CAUSA primero, el SQL después.** El latido guardaba
 * `e.message.slice(0, 300)`, y el mensaje de knex es `<la sentencia completa> - <la causa>`: con
 * 1,667 tramos en un INSERT, los 300 caracteres se agotaban en la lista de `$n` y la causa —un
 * índice único que rechazaba los cobros partidos— no llegó nunca a la pantalla. El carril estuvo en
 * `error` desde que existe y nadie podía leer por qué.
 */
export function causaDelError(e: unknown, max = 300): string {
  if (!(e instanceof Error)) return 'fallo sin mensaje';
  const pg = e as Error & { code?: string; constraint?: string; detail?: string };
  const msg = e.message;
  const corte = msg.lastIndexOf(' - ');
  const causa = corte >= 0 ? msg.slice(corte + 3) : msg;
  const partes = [pg.code, pg.constraint, causa, pg.detail].filter((x): x is string => !!x);
  return partes.join(' · ').slice(0, max);
}
