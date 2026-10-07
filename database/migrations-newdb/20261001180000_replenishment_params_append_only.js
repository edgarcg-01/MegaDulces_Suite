'use strict';
/**
 * `[RA-DYN.P4.1]` — **EL APPEND-ONLY NO ESTABA EN EFECTO. Lo encontró la medición, no la lectura.**
 *
 * La migración `20261001170000` declara en su comentario y en su cabecera que
 * `commercial.replenishment_params` es append-only, y para sostenerlo hace:
 *
 *     GRANT SELECT, INSERT ON commercial.replenishment_params TO app_runtime
 *
 * Otorgar sólo dos privilegios **no niega los otros dos**. Medido en prod justo después de
 * aplicarla (2026-10-01):
 *
 *     relacl → {postgres=arwdDxtm/postgres, app_runtime=arwd/postgres, dev_ro=r/postgres}
 *     has_table_privilege('app_runtime', …, 'UPDATE') → true
 *     has_table_privilege('app_runtime', …, 'DELETE') → true
 *
 * La causa es el schema, no la migración: `commercial` tiene DEFAULT PRIVILEGES que le dan
 * `arwd` a `app_runtime` sobre **toda tabla nueva** creada por `postgres`:
 *
 *     pg_default_acl → commercial | postgres | r | {app_runtime=arwd/postgres, dev_ro=r/postgres}
 *
 * O sea el `GRANT` llegó a una mesa donde los cuatro privilegios ya estaban servidos: fue un no-op
 * y la garantía quedó escrita pero falsa. **En este schema una tabla no se vuelve append-only
 * otorgando de menos — hay que REVOCAR.**
 *
 * ⚠️ Y la forma en que casi se escapa importa más que el bug. La primera verificación preguntó por
 * `information_schema.role_table_grants`, que **sólo muestra los grants donde uno es otorgante,
 * beneficiario o miembro**: como `dev_ro` no es ninguna de las tres, devolvió **lista vacía** — y
 * la aserción "NO tiene UPDATE ni DELETE" se puso **verde por ausencia de datos**, que es
 * exactamente la falsa verde que ADR-056 persigue. La pregunta correcta es
 * `has_table_privilege(...)`, que la contesta el motor y no depende de la visibilidad de quien
 * pregunta. El smoke se corrigió para usarla.
 *
 * No se tocan las DEFAULT PRIVILEGES del schema: sirven para las decenas de tablas de
 * `commercial.*` que sí son de lectura-escritura. El caso raro es ésta, y se declara acá.
 */

const FULL = 'commercial.replenishment_params';

exports.up = async function up(knex) {
  const existe = (await knex.raw(`SELECT to_regclass('${FULL}') AS t`)).rows[0]?.t;
  if (!existe) {
    console.log(`  [RA-DYN.P4.1] ${FULL} no existe todavía — nada que revocar`);
    return;
  }

  await knex.raw(`REVOKE UPDATE, DELETE ON ${FULL} FROM app_runtime`);
  console.log('  [RA-DYN.P4.1] REVOKE UPDATE, DELETE a app_runtime');

  /*
   * La comprobación va DENTRO de la migración, no en un test aparte, porque es el único momento
   * en que se puede afirmar que el REVOKE surtió efecto contra el ACL real. Si otra default
   * privilege lo vuelve a otorgar mañana, esto falla acá y no en silencio seis semanas después.
   */
  const efectivo = await knex.raw(
    `SELECT has_table_privilege('app_runtime', '${FULL}', 'SELECT') AS s,
            has_table_privilege('app_runtime', '${FULL}', 'INSERT') AS i,
            has_table_privilege('app_runtime', '${FULL}', 'UPDATE') AS u,
            has_table_privilege('app_runtime', '${FULL}', 'DELETE') AS d`,
  );
  const { s, i, u, d } = efectivo.rows[0];
  if (!s || !i || u || d) {
    throw new Error(
      `[RA-DYN.P4.1] el append-only NO quedó en efecto: SELECT=${s} INSERT=${i} UPDATE=${u} DELETE=${d}`,
    );
  }
  console.log('  [RA-DYN.P4.1] verificado: SELECT+INSERT sí · UPDATE+DELETE no');

  await knex.raw(`
    COMMENT ON TABLE ${FULL} IS
    '[RA-DYN.P4] Vector de parametros del motor de pedido, versionado. APPEND-ONLY DE VERDAD: '
    'solo valid_from (sin valid_to) y app_runtime tiene SELECT+INSERT pero NO UPDATE ni DELETE -- '
    'la fila que una sugerencia ya referencio no se edita. OJO: el schema commercial tiene DEFAULT '
    'PRIVILEGES que dan arwd a app_runtime en toda tabla nueva, asi que el append-only se sostiene '
    'con un REVOKE explicito (mig 20261001180000), NO con un GRANT selectivo -- otorgar de menos no '
    'niega nada. Verificar con has_table_privilege, NO con information_schema.role_table_grants, '
    'que solo muestra los grants donde uno es otorgante o beneficiario y devuelve lista vacia (una '
    'falsa verde) al preguntar por un rol ajeno. '
    'La lectura es una vez por corrida (ORDER BY valid_from DESC LIMIT 1 contra now(), NUNCA contra '
    'CURRENT_DATE) y sus valores entran al SQL set-based como binds nombrados, nunca interpolados. '
    'Reemplaza las env REORDER_LEAD_DEFAULT / REORDER_CYCLE_DAYS / RA_SERVICE_A,B,C / '
    'RA_SAFETY_FLOOR_DAYS / RA_CEDIS_SERVICE. El seed transcribe los defaults vigentes al '
    '2026-10-01: NO mueve ningun numero. CHECK rp_service_rango acota a (0.5, 1) porque invNorm '
    'devuelve 0 en p>=1, o sea un nivel de servicio de 1.0 daria COLCHON CERO en silencio.'
  `);
};

exports.down = async function down(knex) {
  const existe = (await knex.raw(`SELECT to_regclass('${FULL}') AS t`)).rows[0]?.t;
  if (existe) {
    await knex.raw(`GRANT UPDATE, DELETE ON ${FULL} TO app_runtime`);
    console.log('  [RA-DYN.P4.1] revertido: UPDATE y DELETE devueltos a app_runtime');
  }
};
