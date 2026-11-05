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
  const partes = [pg.code, pg.constraint, soloLaCausa(e, Infinity), pg.detail].filter((x): x is string => !!x);
  return partes.join(' · ').slice(0, max);
}

/**
 * ⛔ `[LE.0.9]` Lo mismo, para una PERSONA: sólo el mensaje de Postgres, sin la sentencia ni el código.
 * El lote de la caja guardaba `e.message.slice(0, 200)` y el aviso de HG-5 (2026-11-03) decía
 * «insert into "finance"."cash_ledger" ("autofill", "beneficiario", …» catorce veces: la causa —el
 * superadmin no cuenta en la caja (D23)— quedaba después del carácter 200.
 */
export function soloLaCausa(e: unknown, max = 200): string {
  if (!(e instanceof Error)) return 'fallo sin mensaje';
  const corte = e.message.lastIndexOf(' - ');
  return (corte >= 0 ? e.message.slice(corte + 3) : e.message).slice(0, max);
}
