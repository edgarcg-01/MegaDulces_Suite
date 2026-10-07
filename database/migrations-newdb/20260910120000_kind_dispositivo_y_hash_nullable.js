'use strict';
/**
 * `[ID.31]` — Etapa 3a: el sujeto se DECLARA, y la invitación se vuelve
 * representable.
 *
 * ══ Corrección al plan, y es de diseño ══════════════════════════════════════
 * El plan pedía una columna nueva `subject_type` con cinco valores
 * (`employee | external_person | counterparty | device | service`). **No se
 * agrega**, y el motivo es el pecado que esta misma etapa viene a arreglar:
 * `identity.users.kind` YA es el clasificador del sujeto, con CHECK
 * `interno | cliente | proveedor | externo | servicio`. Agregar `subject_type`
 * al lado sería una **segunda columna para la misma pregunta** — la clase de
 * duplicación que después nadie sabe cuál gana.
 *
 * Los cinco valores del plan ya tienen su lugar en `kind`, menos UNO:
 *   employee        → interno
 *   external_person → externo      (existe, 0 usuarios)
 *   counterparty    → cliente / proveedor
 *   service         → servicio
 *   device          → **NO EXISTE** ← el único hueco real
 *
 * Así que `kind` no necesita reemplazo: necesita el valor que le falta.
 *
 * ══ Y el hueco es grande: 123 cuentas caben en `interno` ════════════════════
 * Medido en prod (2026-09-10): `interno` mete en la misma bolsa **109 personas
 * y 14 credenciales que no son de nadie**. Y la derivación que el plan creía
 * vigente —«es un dispositivo si `token_ttl_days` no es null»— hoy es **vacía**:
 * `token_ttl_days` está en NULL en el **100%** de las 127 cuentas. O sea que no
 * es que la señal fuera indirecta: **hoy no hay ninguna forma de distinguir un
 * dispositivo de una persona.**
 *
 * ══ Los 14 se derivan de evidencia, uno por uno ═════════════════════════════
 * NO se clasifica por el prefijo del username, que es lo que invitaría a error.
 * La prueba es que **el `nombre` no es de una persona**:
 *   · 8 `etiquetas.NN` — su `nombre` es una TIENDA («Etiquetas - 8ESQ»);
 *   · 6 códigos de ruta — su `nombre` **es** el username (`RVPH03`), o sea el
 *     código de la ruta, no un humano.
 *
 * ⚠️ Y lo que se dejó AFUERA a propósito, porque el heurístico fácil se
 * equivocaba: las **28 cuentas con username numérico** (`03`, `42gernta`,
 * `10c01`…) parecen códigos de caja, pero **26 de 28 tienen nombre de persona
 * real** — son cajeras cuyo usuario es su código de caja. Llamarlas
 * «dispositivo» sería exactamente el error que este trabajo corrige. Y las 2
 * que el heurístico no resuelve (`10aux` «Isabella», `10c03` «FATIMA», nombre
 * de una sola palabra) **se dejan como `interno`**: una persona con el nombre
 * incompleto no es una máquina. Lo que no se puede decidir con evidencia se
 * declara, no se adivina.
 *
 * ══ `password_hash` pasa a NULLABLE, y eso es lo que desbloquea la invitación ═
 * `status = 'invited'` está en el CHECK desde `[ID.8]` y era **inrepresentable**:
 * un usuario sin contraseña no cabía en la tabla, porque la columna era
 * NOT NULL. Por eso no hay flujo de invitación — no era una omisión de producto,
 * era el schema.
 *
 * El CHECK nuevo dice exactamente cuándo puede faltar: `servicio` (que no tiene
 * acceso interactivo) e `invited` (que todavía no la puso). Cualquier otra fila
 * sin hash es un defecto y la base lo rechaza.
 *
 * ⚠️ ORDEN OBLIGADO, y se verificó ejecutándolo: `bcrypt.compare(x, null)`
 * **LANZA** (`Illegal arguments: string, object`), así que sin blindar el login
 * primero una cuenta invitada daría **500 en vez de 401**. Los dos caminos de
 * login (`/auth/login` y `/auth-mt/login`) ya llevan el guard en el commit que
 * acompaña a esta migración. Sin eso, esta migración abre un 500.
 *
 * Idempotente. Aditiva: no toca ninguna fila que ya esté bien.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  // ── 1. `kind` admite `dispositivo` ─────────────────────────────────────────
  // Se recrea el CHECK: Postgres no tiene "ALTER CONSTRAINT" para esto.
  await knex.raw(`ALTER TABLE identity.users DROP CONSTRAINT IF EXISTS users_kind_valido`);
  await knex.raw(
    `ALTER TABLE identity.users ADD CONSTRAINT users_kind_valido
       CHECK (kind IN ('interno', 'dispositivo', 'cliente', 'proveedor', 'externo', 'servicio'))`,
  );
  const COMENTARIO_KIND = [
    'Qué CLASE de sujeto es esta credencial.',
    'interno = persona empleada ·',
    'dispositivo = credencial de un PUESTO o kiosco, sin persona detrás',
    '(su nombre es un lugar o un código, no un humano) ·',
    'cliente/proveedor = contraparte ·',
    'externo = persona no empleada ·',
    'servicio = cuenta de máquina, sin acceso interactivo ([ID.17]).',
    '[ID.31]: se agregó dispositivo porque interno metía 109 personas y 14',
    'credenciales de puesto en la misma bolsa, y token_ttl_days —la señal que',
    'se suponía que lo distinguía— está en NULL en el 100% de las filas.',
  ].join(' ');
  // `COMMENT ON` es una sentencia utilitaria: Postgres NO le acepta binds, así
  // que va interpolada. El texto se arma arriba en un array sin un solo
  // apóstrofe justamente para que interpolar sea seguro.
  await knex.raw(`COMMENT ON COLUMN identity.users.kind IS '${COMENTARIO_KIND}'`);

  // ── 2. Los 14 dispositivos, por evidencia y no por prefijo ────────────────
  const kiosco = await knex.raw(
    `UPDATE identity.users SET kind = 'dispositivo', updated_at = now()
      WHERE deleted_at IS NULL AND kind = 'interno'
        AND nombre ~ '^Etiquetas'`,
  );
  console.log(`  kioscos de etiquetas → dispositivo: ${kiosco.rowCount}`);

  // El `nombre` ES el username: es el código de la ruta, no una persona.
  const ruta = await knex.raw(
    `UPDATE identity.users SET kind = 'dispositivo', updated_at = now()
      WHERE deleted_at IS NULL AND kind = 'interno'
        AND nombre IS NOT NULL
        AND upper(btrim(nombre)) = upper(username)`,
  );
  console.log(`  credenciales de ruta → dispositivo: ${ruta.rowCount}`);

  // ── 3. `password_hash` nullable + el CHECK que dice cuándo puede faltar ────
  await knex.raw(`ALTER TABLE identity.users ALTER COLUMN password_hash DROP NOT NULL`);
  await knex.raw(`ALTER TABLE identity.users DROP CONSTRAINT IF EXISTS users_hash_solo_falta_si_corresponde`);
  await knex.raw(
    `ALTER TABLE identity.users ADD CONSTRAINT users_hash_solo_falta_si_corresponde
       CHECK (password_hash IS NOT NULL OR kind = 'servicio' OR status = 'invited')`,
  );
  await knex.raw(
    `COMMENT ON CONSTRAINT users_hash_solo_falta_si_corresponde ON identity.users IS
      '[ID.31] Dejó de ser NOT NULL para que status=invited sea representable: hasta acá un usuario sin contraseña no cabía en la tabla, y por eso no había flujo de invitación. El CHECK acota dónde puede faltar. ⚠️ El login BLINDA el caso antes de bcrypt.compare, que LANZA con hash nulo.'`,
  );

  // ── Compuertas ─────────────────────────────────────────────────────────────
  const { rows } = await knex.raw(
    `SELECT
       (SELECT count(*)::int FROM identity.users
         WHERE deleted_at IS NULL AND kind = 'dispositivo') AS dispositivos,
       -- Ninguna cuenta clasificada como dispositivo puede tener nombre de
       -- PERSONA (2+ palabras que no son su propio username): sería una persona
       -- degradada a máquina, que es el error caro de esta migración.
       (SELECT count(*)::int FROM identity.users
         WHERE deleted_at IS NULL AND kind = 'dispositivo'
           AND nombre IS NOT NULL AND nombre !~ '^Etiquetas'
           AND upper(btrim(nombre)) <> upper(username)
           AND array_length(regexp_split_to_array(btrim(nombre), '\\s+'), 1) >= 2) AS personas_mal_clasificadas,
       -- Y al revés: nadie con nombre de tienda o de código puede seguir
       -- contando como persona.
       (SELECT count(*)::int FROM identity.users
         WHERE deleted_at IS NULL AND kind = 'interno'
           AND (nombre ~ '^Etiquetas' OR upper(btrim(nombre)) = upper(username))) AS dispositivos_sin_marcar,
       (SELECT count(*)::int FROM identity.users
         WHERE password_hash IS NULL AND kind <> 'servicio' AND status <> 'invited') AS sin_hash_indebido,
       (SELECT count(*)::int FROM information_schema.columns
         WHERE table_schema = 'identity' AND table_name = 'users'
           AND column_name = 'password_hash' AND is_nullable = 'YES') AS hash_nullable`,
  );
  const g = rows[0];

  const fallas = [];
  if (g.personas_mal_clasificadas !== 0) {
    fallas.push(`${g.personas_mal_clasificadas} persona(s) quedaron marcadas como dispositivo`);
  }
  if (g.dispositivos_sin_marcar !== 0) {
    fallas.push(`${g.dispositivos_sin_marcar} credencial(es) de puesto siguen como interno`);
  }
  if (g.sin_hash_indebido !== 0) fallas.push(`${g.sin_hash_indebido} fila(s) sin hash fuera de servicio/invited`);
  if (g.hash_nullable !== 1) fallas.push('password_hash no quedó nullable');
  if (fallas.length) throw new Error(`Compuertas de [ID.31]: ${fallas.join(' · ')}`);

  console.log(
    `  ✓ ${g.dispositivos} dispositivos declarados · 0 personas mal clasificadas · ` +
      `password_hash nullable con CHECK · status='invited' ya es representable`,
  );
};

exports.down = async function down(knex) {
  // Volver `password_hash` a NOT NULL sólo es posible si nadie está invitado.
  await knex.raw(`ALTER TABLE identity.users DROP CONSTRAINT IF EXISTS users_hash_solo_falta_si_corresponde`);
  const { rows } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.users WHERE password_hash IS NULL`,
  );
  if (rows[0].n > 0) {
    throw new Error(
      `No se puede revertir: hay ${rows[0].n} cuenta(s) sin hash. ` +
        'Ponerles contraseña o borrarlas antes de volver la columna a NOT NULL.',
    );
  }
  await knex.raw(`ALTER TABLE identity.users ALTER COLUMN password_hash SET NOT NULL`);
  await knex.raw(`UPDATE identity.users SET kind = 'interno' WHERE kind = 'dispositivo'`);
  await knex.raw(`ALTER TABLE identity.users DROP CONSTRAINT IF EXISTS users_kind_valido`);
  await knex.raw(
    `ALTER TABLE identity.users ADD CONSTRAINT users_kind_valido
       CHECK (kind IN ('interno', 'cliente', 'proveedor', 'externo', 'servicio'))`,
  );
  console.log('  Revertido: los dispositivos vuelven a ser indistinguibles de las personas.');
};
