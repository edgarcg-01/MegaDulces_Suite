import type { Knex } from 'knex';

/**
 * `[GX.108]` — **La solicitud de Kepler le llega a quien la pidió también por su NOMBRE, no sólo por su
 * usuario.**
 *
 * ## El defecto (medido en prod el 2026-11-10, sólo lectura)
 * «Mis gastos» le asigna a cada persona las solicitudes de Kepler cuya caja «Solicita» (`kdm1.c48`)
 * es su USUARIO de la Suite (`[GX.41]`). En la práctica esa caja trae nombres, apodos o áreas: de
 * 1,664 solicitudes sin vale desde el arranque, **1,600 no le llegaban a nadie**. Por nombre exacto y
 * único se ligan **474 a 7 personas, ninguna a dos**.
 *
 * ## ⛔ Privacidad: el nombre se usa sólo si NO puede ser de otra persona
 *  · si otro usuario tiene TODAS sus palabras («JUAN PEREZ» frente a «JUAN PEREZ LOPEZ», que en
 *    Kepler escribe «JUAN PEREZ»), es ambiguo y no se usa: el candado es más estricto que la
 *    igualdad (revisión independiente, 2026-11-10);
 *  · una sola palabra («RRHH», «FINANZAS», «ADMIN») es un área o un alias: no se usa;
 *  · un nombre parecido (en prod, 239 solicitudes contienen las palabras de un usuario) sería
 *    adivinar: no se liga. Ésos, las áreas y los apodos (~1,100) necesitan que alguien decida.
 *  · Lo que esto NO puede ver: un empleado SIN cuenta en la Suite que se llame igual que un usuario.
 *
 * La llave es de SÓLO LETRAS: mayúsculas, sin acentos (con `translate`: el rol de lectura de prod no
 * alcanza `unaccent`), y cualquier otra cosa (punto, coma, espacio duro) como un espacio.
 */

/** Las letras con acento que se igualan a su forma sin acento (ya en mayúsculas). */
const CON_ACENTO = 'ÁÉÍÓÚÜÑ';
const SIN_ACENTO = 'AEIOUUN';

/** SQL: la llave de nombre de una columna de texto (sólo letras A-Z, palabras separadas por un espacio). */
export function sqlNombreNormalizado(columna: string): string {
  const letras = `translate(upper(coalesce(${columna}, '')), '${CON_ACENTO}', '${SIN_ACENTO}')`;
  return `btrim(regexp_replace(${letras}, '[^A-Z]+', ' ', 'g'))`;
}

/** SQL: la caja «Solicita» de la solicitud (`r`) como llave de nombre. */
export const SQL_SOLICITA_COMO_NOMBRE = sqlNombreNormalizado('r.solicitante');

/**
 * SQL: la llave de nombre de ESTA persona, sólo si nadie más la puede reclamar. Parámetros, en orden:
 * tenant, username, tenant, username. Sin fila = no se liga por nombre.
 */
export const SQL_MI_NOMBRE_LIGABLE =
  `SELECT n.nom FROM (SELECT ${sqlNombreNormalizado('nombre')} AS nom FROM identity.users
                      WHERE tenant_id = ? AND username = ?) n
    WHERE n.nom <> ''
      AND NOT EXISTS (SELECT 1 FROM identity.users u2
                       WHERE u2.tenant_id = ? AND u2.username <> ?
                         AND string_to_array(${sqlNombreNormalizado('u2.nombre')}, ' ') @> string_to_array(n.nom, ' '))`;

/** Un nombre sirve para ligar si tiene al menos dos palabras: una sola es un área o un alias. */
export function nombreLigable(nombreNormalizado: string | null | undefined): boolean {
  return String(nombreNormalizado ?? '').split(' ').filter(Boolean).length >= 2;
}

/**
 * Las solicitudes de ESTA persona: «Solicita» es su usuario, O su nombre (sólo si se pasó: el
 * servicio lo pasa nada más cuando es ligable). ⛔ El O va DENTRO de su grupo: suelto se comería el
 * filtro de tenant y todo lo demás. Lo prueba `solicita-por-nombre.spec.ts` compilando el SQL.
 */
export function solicitaDe(qb: Knex.QueryBuilder, usuarioNormalizado: string, nombre: string | null): Knex.QueryBuilder {
  return qb.where((w) => {
    w.whereRaw("upper(regexp_replace(btrim(r.solicitante),'\\s+',' ','g')) = ?", [usuarioNormalizado]);
    if (nombre) w.orWhereRaw(`${SQL_SOLICITA_COMO_NOMBRE} = ?`, [nombre]);
  });
}
