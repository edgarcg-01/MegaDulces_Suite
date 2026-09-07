/**
 * `[ID.23]` corrección — la plaza del CEDIS era OFICINAS, y las dos de Morelia no tenían ninguna.
 *
 * Autorizado por Edgar 2026-09-07, después de que la mig 20260907210000 renombrara el almacén `00`
 * de "Cedis Oficinas" a `CEDIS BPIRAPUATO`.
 *
 * ── Qué es esta columna, medido antes de tocarla ───────────────────────────────────────────
 * `commercial.warehouses.zone_id` NO filtra nada por sí sola: es el **default que propone el alta**
 * de usuarios. El único consumidor es `UsersService.derivarZona()`
 * (`libs/trade/src/lib/users/users.service.ts:135-142`), y cuando no encuentra zona devuelve
 * `undefined`, que ahí significa explícitamente *"no toques lo que ya tiene"*. O sea:
 * **ningún usuario existente cambia de alcance con esta migración.** Verificado además que
 * **0 usuarios** tienen `warehouse_id` = el almacén `00`, `MD-30` o `MD-32`, así que la derivación
 * de estos tres nunca se ha disparado; lo que se corrige es a dónde apuntará la próxima vez.
 *
 * ── 1. El CEDIS pasa a NULL, no a otra zona ───────────────────────────────────────────────
 * El almacén `00` apuntaba a la zona **OFICINAS**, que es correcta como lugar donde trabaja
 * gente — sus 22 usuarios son corporativos (compras, contabilidad, finanzas, prevención,
 * superadmin) — pero es una plaza de **La Piedad**, y el CEDIS es el bodegón de **Irapuato, Gto.**
 * Si mañana alguien da de alta al almacenista del CEDIS, el formulario le propondría OFICINAS.
 *
 * No existe zona de Irapuato, y **crearle una con cero usuarios sería inventar estructura**. Se
 * deja en NULL, que es exactamente el precedente que la mig 20260829130000 fijó para
 * `04 Yurécuaro` (*"no hay ninguna zona que le corresponda y elegirle una sería inventarla"*) —
 * y que se resolvió solo cuando alguien creó la zona YURECUARO desde `/comercial/almacenes`, que
 * es donde vive el dato operativo. Mismo camino acá.
 *
 * ⚠️ Efecto colateral aceptado: OFICINAS queda sin almacén que la apunte, así que el reporte de
 * `[ID.23]` la va a listar entre las *"zonas sin sucursal (territorio de ruta, no plaza)"*.
 * El rótulo del reporte no le queda bien —OFICINAS es un lugar, no un territorio de ruta— pero el
 * hecho que afirma es cierto: ninguna sucursal está en esa plaza. Se prefiere eso a que el alta
 * proponga La Piedad para quien trabaja en Irapuato.
 *
 * ── 2. Morelia: el seed de `[ID.23]` se saltó las dos ⭐ ───────────────────────────────────
 * Su mapa `PLAZA` sólo tenía códigos de DOS DÍGITOS ('00'..'06'), y las dos de Morelia son
 * `MD-30` / `MD-32`. Así que quedaron en NULL — mientras las zonas `MORELIA ABASTOS` (10 usuarios)
 * y `MORELIA MADERO` (4 usuarios) existen y **no tienen ningún almacén apuntándolas**. Es el hueco
 * exacto que `[ID.23]` existe para cerrar, y encima el header de esa migración YA lo decía:
 * *"Las dos de Morelia son los almacenes sin código Kepler (MD-30 / MD-32)"*. Lo dijo y no lo hizo.
 *
 * El pareo no se adivina: los nombres coinciden 1 a 1 (`Almacén Morelia Abastos (30)` →
 * `MORELIA ABASTOS`, `Almacén Morelia Madero (32)` → `MORELIA MADERO`), es lo que declara el
 * header de la mig anterior, y son las dos únicas zonas huérfanas que NO son `*VECINAL`
 * (las vecinales sí son tipo de ruta, no plaza, y se quedan huérfanas a propósito).
 *
 * Idempotente: sólo escribe donde el valor difiere del objetivo. Si alguien ya lo configuró a
 * mano desde `/comercial/almacenes` con otra zona, esta migración **no** lo pisa — salvo el `00`,
 * que es justamente el que se viene a corregir.
 *
 * @param { import("knex").Knex } knex
 */
const ASIGNAR = [
  ['MD-30', 'MORELIA ABASTOS'],
  ['MD-32', 'MORELIA MADERO'],
];

exports.up = async function up(knex) {
  const tenants = await knex('tenants').select('id');

  for (const { id: tenantId } of tenants) {
    // ── 1. El CEDIS deja de estar en la plaza OFICINAS.
    const cedis = await knex.raw(
      `UPDATE commercial.warehouses w
          SET zone_id = NULL, updated_at = now()
        WHERE w.tenant_id = ? AND w.code = '00' AND w.deleted_at IS NULL
          AND w.zone_id = (SELECT z.id FROM trade.zones z
                            WHERE z.tenant_id = w.tenant_id AND z.name = 'OFICINAS'
                              AND z.deleted_at IS NULL)`,
      [tenantId],
    );
    if (cedis.rowCount) console.log("  00 CEDIS BPIRAPUATO: zona OFICINAS -> NULL (Irapuato no tiene zona)");

    // ── 2. Las dos de Morelia toman su plaza.
    for (const [code, zona] of ASIGNAR) {
      const r = await knex.raw(
        `UPDATE commercial.warehouses w
            SET zone_id = z.id, updated_at = now()
           FROM trade.zones z
          WHERE w.tenant_id = ? AND w.code = ? AND w.deleted_at IS NULL
            AND z.tenant_id = w.tenant_id AND z.name = ? AND z.deleted_at IS NULL
            AND w.zone_id IS NULL`,
        [tenantId, code, zona],
      );
      if (r.rowCount) console.log(`  ${code} -> zona ${zona}`);
    }

    // ── Reporte + auto-verificación.
    const est = (await knex.raw(`
      SELECT w.code, w.name, z.name AS zona
        FROM commercial.warehouses w
        LEFT JOIN trade.zones z ON z.tenant_id = w.tenant_id AND z.id = w.zone_id
       WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND w.display_order IS NOT NULL
       ORDER BY w.display_order`, [tenantId])).rows;
    if (!est.length) continue;
    for (const r of est) console.log(`    ${String(r.code).padEnd(6)} ${String(r.name).padEnd(30)} ${r.zona || '(sin plaza)'}`);

    const c00 = est.find((r) => r.code === '00');
    if (c00 && c00.zona) throw new Error(`el CEDIS sigue con plaza: ${c00.zona}`);
    for (const [code, zona] of ASIGNAR) {
      const f = est.find((r) => r.code === code);
      if (f && f.zona !== zona) throw new Error(`${code} quedó en ${f.zona || 'NULL'}, se esperaba ${zona}`);
    }

    // El invariante de `[ID.23]`: tienen que seguir existiendo zonas que NO son plaza, porque de
    // eso depende que la zona del usuario siga siendo un eje editable y no un derivado.
    const huerfanas = (await knex.raw(`
      SELECT z.name FROM trade.zones z
       WHERE z.tenant_id = ? AND z.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM commercial.warehouses w
                          WHERE w.tenant_id = z.tenant_id AND w.zone_id = z.id AND w.deleted_at IS NULL)
       ORDER BY z.orden`, [tenantId])).rows.map((r) => r.name);
    console.log(`    zonas sin sucursal: ${huerfanas.join(' · ') || '(ninguna)'}`);
    if (!huerfanas.length) throw new Error('no quedó ninguna zona sin sucursal: la zona dejaría de ser un eje propio');
  }
};

exports.down = async function down(knex) {
  // Se revierte SÓLO lo de Morelia. El `00` no vuelve a OFICINAS: era el dato incorrecto.
  for (const [code, zona] of ASIGNAR) {
    await knex.raw(
      `UPDATE commercial.warehouses w SET zone_id = NULL, updated_at = now()
         FROM trade.zones z
        WHERE w.code = ? AND z.tenant_id = w.tenant_id AND z.name = ? AND w.zone_id = z.id`,
      [code, zona],
    );
  }
};
