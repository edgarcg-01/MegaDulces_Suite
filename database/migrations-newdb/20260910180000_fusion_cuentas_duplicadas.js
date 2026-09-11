'use strict';
/**
 * `[ID.36]` — Una persona, una cuenta: se fusionan las réplicas.
 *
 * Autorizado por el lead el 2026-09-10.
 *
 * ── Lo que había, medido ─────────────────────────────────────────────────────
 * **11 personas cargando 22 de las 128 cuentas.** El patrón es casi siempre el
 * mismo: la encargada o auxiliar tiene su cuenta con nombre, y además existe una
 * segunda cuenta cuyo username es su **código de caja** (`03`, `42gernta`,
 * `40vmc`…). Nada en el schema decía que esas doce filas eran seis personas.
 *
 * ── Por qué retirar la réplica no cuesta acceso ──────────────────────────────
 * Se midió la huella de las 22 cuentas contra **las 84 tablas con FK a
 * `identity.users`** antes de tocar nada. Las réplicas de POS tienen
 * exactamente dos filas cada una —`user_events` (su creación) y `user_roles`—
 * y **ninguna inició sesión jamás en la plataforma**: son códigos de caja del
 * POS con espejo en el padrón, no credenciales de la app. Retirarlas no le quita
 * el acceso a nadie.
 *
 * ⚠️ Y una de ellas es `01jzico`: la cuenta de POS de Ivette Cruz con rol
 * **`superadmin`**, o sea god-mode, que **nunca se usó**. Retirarla es lo más
 * valioso de esta migración y no tiene nada que ver con la prolijidad.
 *
 * ── Diana es el caso distinto, y el que manda al revés de lo que parecía ─────
 * `diana_cortes` y `diana_molina` son las dos `vendedor_ruta` VIVAS, las dos con
 * sesión iniciada a un día de distancia, las dos asignadas a **la misma ruta
 * `RVDAM01`**, y martes y miércoles **las dos a la vez**.
 *
 * La huella decide cuál sobrevive, y **no es la que yo suponía**: `diana_cortes`
 * es más vieja y tiene más asignaciones, pero su huella operativa es **CERO**.
 * `diana_molina` es la que trabaja: **4 pedidos, 4 visitas**, 1 captura diaria y
 * 3 tiendas actualizadas. Sobrevive `molina`. Elegir por antigüedad habría
 * movido la venta de lugar.
 *
 * Sus jornadas se consolidan: `cortes` tenía lun/mar/mié/sáb y `molina`
 * mar/mié. Se le pasan a `molina` los días que no tiene (lun y sáb) y se retiran
 * los duplicados. Resultado: **una persona, una cuenta, la semana completa**.
 *
 * ── Lo que NO se fusiona, y con motivo ───────────────────────────────────────
 * `brian_zavala` («Brian Cisneros Zavala», almacenista, sin sucursal) y `54bcz`
 * («Brallan Cisneros Zavala», cajero, sucursal 05). Apellidos iguales, **nombres
 * de pila distintos**, departamentos distintos y sucursales distintas. Es
 * exactamente el patrón por el que NO se fusionó Ivette vs **Ivonne** Cruz
 * Oceguera. Pueden ser dos personas; fusionar es irreversible en la práctica y
 * adivinar no es un método. Se declara para que lo confirme un humano.
 *
 * ── Cómo se retira ───────────────────────────────────────────────────────────
 * Soft-delete con el ciclo de vida escrito (`status='terminated'` +
 * `terminated_at` + `deleted_at`), igual que la cuenta `prueba` en `[ID.27]`.
 * `activo` lo deriva el trigger desde `status` — no se escribe a mano. Y el
 * vínculo queda en `identity.user_events`, que existe desde `[ID.12]` y estaba
 * subutilizada: una fila en la sobreviviente y otra en la retirada, con el
 * username del otro lado en `detalle`. Sin eso, la fusión sería indistinguible
 * de una baja cualquiera.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** (sobrevive, se retira, motivo). El orden importa: el 2º es el que se va. */
const PARES = [
  ['claudia_pimentel', '42gernta', 'nombre idéntico normalizado'],
  ['cynthia_lopez', '03', 'nombre idéntico normalizado'],
  ['dulce_alatorre', '42dmar', 'nombre idéntico normalizado'],
  ['ivette_cruz', '01jzico', 'nombre idéntico normalizado — la réplica cargaba god-mode (superadmin) sin usarse'],
  ['monica_mejia', '04', 'nombre idéntico normalizado'],
  ['tania_sanchez', '54tysl', 'nombre idéntico normalizado'],
  ['veronica_magana', '40vmc', 'nombre idéntico normalizado'],
  ['yazmin_sarai', '40yscc', 'variante de ortografía (Sarai/Sarahi), misma sucursal 03'],
  ['gustavo_melgoza', '42gama', 'variante de ortografía (Ascencio/Asencio) y segundo nombre, misma sucursal 02'],
  ['diana_molina', 'diana_cortes', 'dos vendedor_ruta vivas en la MISMA ruta; sobrevive la que tiene la huella operativa'],
];

/** No se fusiona. Queda escrito para que no se vuelva a proponer sin confirmar. */
const NO_FUSIONADO = {
  brian_zavala: '54bcz',
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const tenant = (
    await knex.raw(`SELECT id FROM identity.tenants WHERE slug = 'mega_dulces'`)
  ).rows[0]?.id;
  if (!tenant) throw new Error('No se encontró el tenant mega_dulces.');

  const idDe = async (username) => {
    const { rows } = await knex.raw(
      `SELECT id, status FROM identity.users WHERE tenant_id = ? AND username = ?`,
      [tenant, username],
    );
    return rows[0] || null;
  };

  // ── 1. Diana: las jornadas antes de retirar la cuenta ─────────────────────
  const molina = await idDe('diana_molina');
  const cortes = await idDe('diana_cortes');
  if (molina && cortes) {
    // Los días que `cortes` cubre y `molina` no: se mudan.
    const mudados = await knex.raw(
      `UPDATE trade.daily_assignments da
          SET user_id = ?, updated_at = now()
        WHERE da.user_id = ? AND da.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM trade.daily_assignments m
             WHERE m.user_id = ? AND m.day_of_week = da.day_of_week AND m.deleted_at IS NULL)`,
      [molina.id, cortes.id, molina.id],
    );
    // Los días duplicados (las dos en la misma ruta el mismo día): se retiran.
    const dup = await knex.raw(
      `UPDATE trade.daily_assignments SET deleted_at = now(), updated_at = now()
        WHERE user_id = ? AND deleted_at IS NULL`,
      [cortes.id],
    );
    console.log(`  Diana: ${mudados.rowCount} jornada(s) mudadas a diana_molina · ${dup.rowCount} duplicada(s) retiradas`);
  } else {
    console.log('  Diana: una de las dos cuentas ya no existe — nada que consolidar');
  }

  // ── 2. Retirar las réplicas y dejar el vínculo en la bitácora ─────────────
  let retiradas = 0;
  for (const [vive, muere, motivo] of PARES) {
    const a = await idDe(vive);
    const b = await idDe(muere);
    if (!a || !b) {
      console.log(`  ~ ${vive} ← ${muere}: falta una de las dos, se salta`);
      continue;
    }
    if (b.status === 'terminated') continue; // idempotencia

    await knex.raw(
      `UPDATE identity.users
          SET status = 'terminated',
              terminated_at = COALESCE(terminated_at, now()),
              deleted_at    = COALESCE(deleted_at, now()),
              updated_at    = now()
        WHERE id = ?`,
      [b.id],
    );
    // Las dos puntas del vínculo. Sin esto la fusión es indistinguible de una
    // baja cualquiera, y la pregunta "¿qué accesos tenía esta persona?" vuelve
    // a no tener respuesta.
    await knex.raw(
      `INSERT INTO identity.user_events (id, tenant_id, user_id, event, detalle, actor_username)
       VALUES (gen_random_uuid(), ?, ?, 'cuenta_fusionada', ?::jsonb, 'migracion [ID.36]'),
              (gen_random_uuid(), ?, ?, 'cuenta_retirada_por_fusion', ?::jsonb, 'migracion [ID.36]')`,
      [
        tenant, a.id, JSON.stringify({ absorbe_a: muere, motivo, item: 'ID.36' }),
        tenant, b.id, JSON.stringify({ fusionada_en: vive, motivo, item: 'ID.36' }),
      ],
    );
    retiradas++;
  }
  console.log(`  réplicas retiradas: ${retiradas} de ${PARES.length}`);

  // ── Compuertas ─────────────────────────────────────────────────────────────
  const norm = `regexp_replace(lower(translate(btrim(nombre), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')), '\\s+', ' ', 'g')`;
  const { rows } = await knex.raw(
    `WITH viva AS (
       SELECT ${norm} AS clave, count(*)::int n, string_agg(username, ', ' ORDER BY username) quienes
         FROM identity.users
        WHERE tenant_id = ? AND activo AND deleted_at IS NULL AND nombre IS NOT NULL
          AND array_length(regexp_split_to_array(btrim(nombre), '\\s+'), 1) >= 2
          AND nombre !~ '^Etiquetas'
        GROUP BY 1)
     SELECT
       (SELECT count(*)::int FROM viva WHERE n > 1) AS personas_con_dos_cuentas,
       (SELECT coalesce(string_agg(quienes, ' | '), '') FROM viva WHERE n > 1) AS cuales,
       (SELECT count(*)::int FROM identity.users
         WHERE tenant_id = ? AND username = '01jzico' AND activo) AS godmode_pos_activo,
       (SELECT count(*)::int FROM identity.users u
          JOIN identity.role_permissions rp ON rp.tenant_id = u.tenant_id AND rp.role_name = u.role_name
         WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL AND rp.is_platform_admin) AS godmode_activos,
       (SELECT count(*)::int FROM trade.daily_assignments da
          JOIN identity.users u ON u.id = da.user_id
         WHERE da.deleted_at IS NULL AND NOT u.activo) AS jornadas_de_inactivos,
       (SELECT count(DISTINCT da.day_of_week)::int FROM trade.daily_assignments da
          JOIN identity.users u ON u.id = da.user_id
         WHERE da.deleted_at IS NULL AND u.username = 'diana_molina') AS dias_de_diana`,
    [tenant, tenant, tenant],
  );
  const g = rows[0];

  const fallas = [];
  // Brian/Brallan queda a propósito: si aparece otro par, es que algo se escapó.
  if (g.personas_con_dos_cuentas > 1) {
    fallas.push(`quedan ${g.personas_con_dos_cuentas} personas con dos cuentas activas (${g.cuales})`);
  }
  if (g.godmode_pos_activo !== 0) fallas.push('la cuenta de POS con god-mode (01jzico) sigue activa');
  // Una jornada colgada de alguien inactivo es trabajo asignado a nadie.
  if (g.jornadas_de_inactivos !== 0) {
    fallas.push(`${g.jornadas_de_inactivos} jornada(s) vigentes cuelgan de cuentas inactivas`);
  }
  if (g.dias_de_diana < 4) {
    fallas.push(`diana_molina quedó con ${g.dias_de_diana} día(s) de ruta: la consolidación perdió jornadas`);
  }
  if (fallas.length) throw new Error(`Compuertas de [ID.36]: ${fallas.join(' · ')}`);

  console.log(
    `  ✓ ${g.personas_con_dos_cuentas} persona(s) con dos cuentas (queda el par declarado ` +
      `${Object.keys(NO_FUSIONADO)[0]}/${Object.values(NO_FUSIONADO)[0]}, sin confirmar) · ` +
      `god-mode activo: ${g.godmode_activos} cuenta(s) · diana_molina con ${g.dias_de_diana} días de ruta`,
  );
};

exports.down = async function down(knex) {
  // Reactivar las réplicas es una decisión de acceso, no de datos: se dice cómo
  // y no se hace solo. Las jornadas de Diana NO se desconsolidan.
  console.log(
    '  Sin reversa automática. Para reactivar una réplica: UPDATE identity.users ' +
      "SET status='active', terminated_at=NULL, deleted_at=NULL WHERE username = '<la réplica>'. " +
      'El vínculo de la fusión está en identity.user_events (cuenta_fusionada / cuenta_retirada_por_fusion).',
  );
};
