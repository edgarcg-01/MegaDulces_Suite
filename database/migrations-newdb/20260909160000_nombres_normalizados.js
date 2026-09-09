'use strict';
/**
 * `[ID.27]` — El nombre deja de traer espacio de sobra.
 *
 * ── Por qué una migración para dos filas ─────────────────────────────────────
 * Porque el `nombre` es hoy la **única llave** con la que se cruza una
 * credencial contra una persona: `analytics.vendor_identity` liga por nombre,
 * **sin `user_id`** (es el puente que le falta al dinero, `[IDG.9.4]`). Un
 * espacio al final parte a alguien en dos identidades en cualquier join por
 * nombre, y no hay error que lo denuncie — sólo un número que sale a la mitad.
 *
 * ── Y las dos filas no son cualquiera ────────────────────────────────────────
 * Medido en prod: de 125 cuentas activas, exactamente 2 traen espacio de borde
 * —`diana_cortes` y `veronica_magana`— y **las dos son casos de persona con dos
 * cuentas**, o sea justamente las filas que el backfill de `hr.employees`
 * (Etapa 3) tiene que aparear. La suciedad estaba parada arriba del apareo.
 *
 * La prevención va en el DTO (`@Transform` en `user-write.dto.ts`, los 3
 * caminos de escritura comparten ese DTO). Acá se limpia lo que ya está.
 *
 * ⚠️ NO se agrega un CHECK `nombre = btrim(nombre)`. Sería un trinquete, y el
 * orden que este proyecto ya aprendió es al revés: primero el camino de
 * escritura, después la limpieza, y el CHECK al final — cuando esté medido que
 * nadie lo viola desde ningún escritor, incluidos los ~90 importers que entran
 * como superusuario y no pasan por el DTO.
 *
 * Idempotente: sólo toca lo que difiere de su forma normalizada.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  const { rows: antes } = await knex.raw(
    `SELECT username, nombre FROM identity.users
      WHERE nombre IS NOT NULL
        AND nombre <> regexp_replace(btrim(nombre), '\\s+', ' ', 'g')
      ORDER BY username`,
  );
  for (const r of antes) console.log(`  · ${r.username}: "${r.nombre}"`);

  const upd = await knex.raw(
    `UPDATE identity.users
        SET nombre = regexp_replace(btrim(nombre), '\\s+', ' ', 'g'),
            updated_at = now()
      WHERE nombre IS NOT NULL
        AND nombre <> regexp_replace(btrim(nombre), '\\s+', ' ', 'g')`,
  );
  console.log(`  nombres normalizados: ${upd.rowCount}`);

  // ── Compuerta ──────────────────────────────────────────────────────────────
  // Afirma el estado, no el rowCount: en la 2ª corrida el rowCount es 0 y el
  // estado sigue siendo el bueno.
  const { rows } = await knex.raw(
    `SELECT count(*)::int AS sucios FROM identity.users
      WHERE nombre IS NOT NULL
        AND nombre <> regexp_replace(btrim(nombre), '\\s+', ' ', 'g')`,
  );
  if (rows[0].sucios !== 0) {
    throw new Error(`Quedan ${rows[0].sucios} nombre(s) con espacios sin normalizar.`);
  }
  console.log('  ✓ 0 nombres con espacios de borde o dobles en todo el padrón');
};

exports.down = async function down() {
  // No hay vuelta atrás con sentido: el espacio de sobra era el defecto.
  console.log('  Sin reversa: restaurar un espacio al final no es un estado deseable.');
};
