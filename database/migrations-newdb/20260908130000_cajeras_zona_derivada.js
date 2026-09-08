'use strict';
/**
 * `[IDG.9.10]` — Las cajeras de Yurécuaro tenían la zona vacía y un `zone = all`
 * de curita.
 *
 * ── Lo que se midió ──────────────────────────────────────────────────────────
 * El rol `cajero` son **25 personas**, todas de departamento `cajas` y puesto
 * `cajera`, con **3 permisos**: `STORE_ARQUEO_VER`, `STORE_ARQUEO_CAPTURAR` y
 * `FINANCE_EXPENSES_CAPTURAR`. Su ficha está sorprendentemente sana: **las 25
 * tienen `warehouse_code`** (01, 02, 03, 04, 05), y 22 de 25 tienen además una
 * zona que **coincide exactamente** con la que su sucursal implica.
 *
 * La anomalía era precisa: **las 3 de sucursal `04` son las únicas sin
 * `zona_id`, y son exactamente las 3 que tenían un override `zone = all`**
 * (`44c02`, `44jaec`, `44mdbt`). O sea: a alguien le faltó la zona, el default
 * del rol (`zone = own`) resolvía a «sin valor» = no ve nada, y el parche fue
 * abrirles todas las zonas. La curita, no la herida.
 *
 * ── Por qué la zona es derivable, verificado ─────────────────────────────────
 * `sucursal → zona` **ES una función**: las 8 sucursales con zona apuntan a
 * exactamente 1 cada una (`01/02/03`→LA PIEDAD RD · `04`→YURECUARO ·
 * `05`→ZAMORA · `06`→CANINDO · `30`→MORELIA ABASTOS · `32`→MORELIA MADERO). Es
 * el sentido en que `[ID.23]` la declaró derivable —al revés NO es función, y
 * por eso la columna vive en la sucursal—. Para la sucursal `04` la zona es
 * `YURECUARO`, sin ambigüedad.
 *
 * Medido: en TODO el padrón activo, los únicos con sucursal y sin zona son esas
 * 3. No hay caso general que arreglar aparte.
 *
 * ── Riesgo ───────────────────────────────────────────────────────────────────
 * Quitar el `zone = all` no quita nada: **nadie consume la dimensión `zone`** del
 * `ScopeService` (verificado en `apps/` y `libs/`). Lo que sí arregla es el otro
 * uso de `zona_id`, que no es alcance: el JWT lo lleva denormalizado como `zona`
 * y varias pantallas (daily-assignments, captures, seguimiento) lo leen para
 * hacer match contra el catálogo. Sin él, esas tres cajeras salían como «sin
 * zona asignada».
 *
 * Su `warehouse` queda intacto: el rol trae `warehouse = own` y las 25 tienen
 * `warehouse_code`, así que su arqueo —que SÍ consume esa dimensión— ya resolvía
 * a su propia sucursal.
 *
 * ── Lo que NO toca ───────────────────────────────────────────────────────────
 * Los otros 2 overrides `zone = all` son de telemarketing (`maria_garcia`,
 * `monse_frausto`): no tienen `warehouse_code`, así que la zona no se les puede
 * derivar. Quedan en `all` con el motivo escrito, como los 7 de sucursal.
 *
 * Y **NO se corrigen las 2 contradicciones** que aparecieron al medir:
 * `etiquetas.lpa` (suc `02`) y `rodrigo_ortiz` (suc `01`), ambos `piso_tienda`,
 * tienen `zona = OFICINAS` en la ficha cuando su sucursal implica LA PIEDAD RD.
 * `OFICINAS` huele a cajón por defecto (22 usuarios, y es una zona sin ninguna
 * sucursal asociada), pero pisar un dato existente a favor de una inferencia es
 * justo lo que no se hace: se reporta.
 *
 * Idempotente y derivada en tiempo de corrida.
 *
 * @param { import("knex").Knex } knex
 */

const NOTA_ZONA_NO_DERIVABLE =
  '[IDG.9.10] Sigue en all: sin warehouse_code no se puede derivar la zona. ' +
  'Inerte hoy (nadie consume la dimension zone), pero es un cheque en blanco.';

exports.up = async function up(knex) {
  // ── 1. La zona sale de la sucursal ────────────────────────────────────────
  const { rows: derivables } = await knex.raw(`
    SELECT u.tenant_id, u.id, u.username, u.role_name, u.warehouse_code, zw.id AS zona_id, zw.name AS zona
      FROM identity.users u
      JOIN commercial.warehouses w
        ON w.tenant_id = u.tenant_id AND w.deleted_at IS NULL
       AND (CASE WHEN w.code ~ '^[0-9]{2}$' THEN w.code ELSE w.wincaja_source_branch END) = u.warehouse_code
      JOIN trade.zones zw ON zw.tenant_id = w.tenant_id AND zw.id = w.zone_id
     WHERE u.activo AND u.deleted_at IS NULL AND u.zona_id IS NULL
     ORDER BY u.username`);

  if (!derivables.length) {
    console.log('  Nadie tiene sucursal sin zona — nada que derivar.');
  }
  for (const d of derivables) {
    await knex.raw(`UPDATE identity.users SET zona_id = ?, updated_at = now() WHERE id = ?`, [
      d.zona_id,
      d.id,
    ]);
    console.log(
      `  ✓ ${d.username.padEnd(12)} (${d.role_name}) suc ${d.warehouse_code} → zona ${d.zona}`,
    );
  }

  // ── 2. Con la zona puesta, el override `zone = all` deja de hacer falta ───
  // El default del rol es `zone = own`, que ahora sí resuelve.
  if (derivables.length) {
    const del = await knex.raw(
      `DELETE FROM identity.user_scopes
        WHERE dimension = 'zone' AND mode = 'all' AND user_id = ANY(?)`,
      [derivables.map((d) => d.id)],
    );
    console.log(
      `  ✓ ${del.rowCount} override(s) \`zone = all\` retirado(s): el default del rol (own) ya resuelve.`,
    );
  }

  // ── 3. Los `zone = all` que quedan, con el motivo escrito ─────────────────
  const resto = await knex.raw(
    `UPDATE identity.user_scopes SET nota = ?, updated_at = now()
      WHERE dimension = 'zone' AND mode = 'all' AND COALESCE(nota, '') NOT LIKE '[IDG.9.10]%'`,
    [NOTA_ZONA_NO_DERIVABLE],
  );
  if (resto.rowCount) console.log(`  ~ ${resto.rowCount} override(s) \`zone = all\` sin derivar, con motivo declarado.`);

  // ── 4. Reporte: las contradicciones que NO se tocan ───────────────────────
  const { rows: contra } = await knex.raw(`
    SELECT u.username, u.role_name, u.warehouse_code AS suc,
           z.name AS zona_en_ficha, zw.name AS zona_de_la_sucursal
      FROM identity.users u
      JOIN trade.zones z ON z.tenant_id = u.tenant_id AND z.id = u.zona_id
      JOIN commercial.warehouses w
        ON w.tenant_id = u.tenant_id AND w.deleted_at IS NULL
       AND (CASE WHEN w.code ~ '^[0-9]{2}$' THEN w.code ELSE w.wincaja_source_branch END) = u.warehouse_code
      JOIN trade.zones zw ON zw.tenant_id = w.tenant_id AND zw.id = w.zone_id
     WHERE u.activo AND u.deleted_at IS NULL AND u.zona_id <> zw.id
     ORDER BY u.username`);
  for (const x of contra) {
    console.log(
      `  ! ${x.username} (${x.role_name}): ficha dice "${x.zona_en_ficha}" y la sucursal ${x.suc} ` +
        `implica "${x.zona_de_la_sucursal}". Sin tocar — pisar un dato existente por una inferencia no se hace.`,
    );
  }

  // ── Gates ─────────────────────────────────────────────────────────────────
  const { rows: g1 } = await knex.raw(`
    SELECT count(*)::int AS n FROM identity.users u
      JOIN commercial.warehouses w
        ON w.tenant_id = u.tenant_id AND w.deleted_at IS NULL
       AND (CASE WHEN w.code ~ '^[0-9]{2}$' THEN w.code ELSE w.wincaja_source_branch END) = u.warehouse_code
      JOIN trade.zones zw ON zw.tenant_id = w.tenant_id AND zw.id = w.zone_id
     WHERE u.activo AND u.deleted_at IS NULL AND u.zona_id IS NULL`);
  if (g1[0].n > 0) throw new Error(`Quedan ${g1[0].n} usuario(s) con sucursal y sin zona derivable.`);

  const { rows: g2 } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.user_scopes
      WHERE dimension = 'zone' AND mode = 'all' AND COALESCE(nota, '') NOT LIKE '[IDG.9.10]%'`,
  );
  if (g2[0].n > 0) throw new Error(`Quedan ${g2[0].n} override(s) \`zone = all\` sin motivo declarado.`);
  console.log('  ✓ gates: nadie con sucursal y sin zona, y todo `zone = all` con motivo escrito.');
};

exports.down = async function down() {
  console.log(
    '  down() no revierte: la zona derivada de la sucursal es un HECHO verificado ' +
      '(sucursal → zona es funcion), y vaciarla devolveria a esas cajeras a "sin zona asignada".',
  );
};
