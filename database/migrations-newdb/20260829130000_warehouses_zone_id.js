/**
 * `[ID.23]` — Cada sucursal declara su zona, para que el alta pregunte UNA sola vez.
 *
 * Hoy el formulario de usuarios pide **zona** y **sucursal** por separado, y eso
 * obliga a quien da de alta a saber cuál va con cuál. Con esta columna la zona se
 * DERIVA de la sucursal y el alta hace una pregunta en vez de dos.
 *
 * Lo que la data dice, y que conviene tener escrito porque contradice la
 * intuición de "es lo mismo con dos nombres":
 *
 *   - 8 zonas vs 7 sucursales. No hay biyección.
 *   - `LA PIEDAD RD` tiene gente en las sucursales 01, 02 y 03 a la vez: la zona
 *     NO está contenida en una sucursal, es la plaza que comparten las tres.
 *   - `MORELIA ABASTOS`, `MORELIA MADERO`, `ZAMORA VECINAL` y `LA PIEDAD VECINAL`
 *     no tienen sucursal de 2 dígitos que les corresponda. Las dos de Morelia son
 *     los almacenes sin código Kepler (MD-30 / MD-32, ver `scope.service`); las
 *     dos `VECINAL` no son un lugar sino un TIPO DE RUTA sobre la misma plaza.
 *   - De 143 usuarios: 75 tienen zona, 37 sucursal, y sólo 8 las dos.
 *
 * O sea: sucursal → zona es una función (una sucursal está en una plaza), pero al
 * revés no. Por eso la columna vive acá, en la sucursal, y no al revés; y por eso
 * la zona del usuario sigue existiendo como columna propia: para el vendedor de
 * ruta vecinal la zona es su territorio, no la tienda donde está parado. El
 * formulario la muestra **derivada y editable** — una pregunta en el caso normal,
 * dos sólo cuando la persona de verdad divergen.
 *
 * El seed de abajo NO adivina: pone las 6 que el nombre y la data respaldan y
 * deja `04 Yurécuaro` en NULL, porque no hay ninguna zona que le corresponda y
 * elegirle una sería inventarla. Se termina de configurar desde
 * /comercial/almacenes, que es donde vive el dato (regla: el dato operativo se
 * administra en la UI, el script sólo hace la carga inicial).
 */

/** Sucursal → nombre de zona. `null` = no hay zona que le corresponda. */
const PLAZA = {
  '00': 'OFICINAS',        // Cedis Oficinas — la zona OFICINAS es exactamente esto.
  '01': 'LA PIEDAD RD',    // Padre Hidalgo. Usuarios de LA PIEDAD RD asignados acá.
  '02': 'LA PIEDAD RD',    // La Piedad Abastos.
  '03': 'LA PIEDAD RD',    // 8ESQ (Pino Suárez 259). Mismos usuarios de la plaza.
  '04': null,              // Yurécuaro: no existe zona propia. Queda para definir.
  '05': 'ZAMORA',          // Zamora Centro.
  '06': 'CANINDO',         // Canindo (Morelia).
};

exports.up = async (knex) => {
  const tiene = await knex.schema.withSchema('commercial').hasColumn('warehouses', 'zone_id');
  if (!tiene) {
    await knex.schema.withSchema('commercial').alterTable('warehouses', (t) => {
      t.uuid('zone_id').nullable();
    });
    await knex.raw(`
      ALTER TABLE commercial.warehouses
        ADD CONSTRAINT warehouses_zone_fk
        FOREIGN KEY (tenant_id, zone_id) REFERENCES trade.zones(tenant_id, id)
        ON DELETE SET NULL`);
    await knex.raw(`
      COMMENT ON COLUMN commercial.warehouses.zone_id IS
        '[ID.23] Zona (plaza) donde esta la sucursal. Varias sucursales pueden compartir zona. Es el DEFAULT que el alta de usuarios propone; la zona del usuario puede diferir (ruta vecinal).'`);
  }

  // ── Seed de la plaza de cada sucursal ─────────────────────────────────────
  const tenants = await knex('tenants').select('id');
  for (const { id: tenantId } of tenants) {
    const zonas = await knex('trade.zones')
      .where({ tenant_id: tenantId })
      .whereNull('deleted_at')
      .select('id', 'name');
    const porNombre = new Map(zonas.map((z) => [String(z.name).toUpperCase().trim(), z.id]));

    for (const [code, zonaNombre] of Object.entries(PLAZA)) {
      if (!zonaNombre) continue;
      const zoneId = porNombre.get(zonaNombre);
      if (!zoneId) continue; // Otro tenant sin estas zonas: no es un error.
      await knex('commercial.warehouses')
        .where({ tenant_id: tenantId, code })
        .whereNull('deleted_at')
        .whereNull('zone_id') // Idempotente y respeta lo que ya se configuró a mano.
        .update({ zone_id: zoneId });
    }

    // Reporte: qué sucursales quedaron sin plaza y qué zonas no tienen sucursal.
    const sinZona = await knex('commercial.warehouses')
      .where({ tenant_id: tenantId })
      .whereNull('deleted_at')
      .whereNull('zone_id')
      .whereRaw(`code ~ '^[0-9]{2}$'`)
      .pluck('code');
    if (sinZona.length) {
      console.log(`  [ID.23] sucursales sin zona (definir en /comercial/almacenes): ${sinZona.join(', ')}`);
    }
    const zonasHuerfanas = await knex.raw(
      `SELECT z.name FROM trade.zones z
        WHERE z.tenant_id = ? AND z.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM commercial.warehouses w
                           WHERE w.tenant_id = z.tenant_id AND w.zone_id = z.id AND w.deleted_at IS NULL)
        ORDER BY z.orden`,
      [tenantId],
    );
    if (zonasHuerfanas.rows.length) {
      console.log(
        `  [ID.23] zonas sin sucursal (son territorio de ruta, no plaza): ${zonasHuerfanas.rows.map((r) => r.name).join(' · ')}`,
      );
    }
  }
};

exports.down = async (knex) => {
  const tiene = await knex.schema.withSchema('commercial').hasColumn('warehouses', 'zone_id');
  if (!tiene) return;
  await knex.raw(`ALTER TABLE commercial.warehouses DROP CONSTRAINT IF EXISTS warehouses_zone_fk`);
  await knex.schema.withSchema('commercial').alterTable('warehouses', (t) => {
    t.dropColumn('zone_id');
  });
};
