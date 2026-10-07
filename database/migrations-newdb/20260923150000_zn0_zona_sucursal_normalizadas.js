'use strict';
/**
 * `[ZN.0]` — **Zona, sucursal y ruta dejan de vivir en la misma columna.**
 *
 * ── El defecto, medido en prod el 2026-09-23 ────────────────────────────────
 * `trade.zones` tiene 9 filas y mezcla CUATRO niveles distintos, y toda persona
 * (`identity.users.zona_id`) apunta ahí sin importar a qué se dedique:
 *
 *   zona real .......... LA PIEDAD RD · ZAMORA          (y falta MORELIA)
 *   sucursal ........... YURECUARO · CANINDO · MORELIA MADERO · MORELIA ABASTOS
 *   canal .............. LA PIEDAD VECINAL · ZAMORA VECINAL
 *   actividad .......... OFICINAS
 *
 * Consecuencias que se pueden contar:
 *   · **26 personas de sucursales DISTINTAS** (PH 10, 8ESQ 10, LPA 6) comparten
 *     la etiqueta `LA PIEDAD RD`, que es la zona de **ruta**. En qué sucursal
 *     trabajan sólo lo dice `warehouse_code`, que es otro campo.
 *   · El tablero de dirección agrupa por esta tabla, así que muestra **6 zonas
 *     donde hay 3**: Zamora partida en `ZAMORA` + `CANINDO`, Morelia en
 *     `MORELIA MADERO` + `MORELIA ABASTOS`.
 *   · La misma ruta parecía tener dos dueños (`501…505`: el catálogo decía
 *     ZAMORA, el registro operativo CANINDO). **No era una contradicción**: uno
 *     daba la ZONA y el otro la SUCURSAL madre. No existía el nivel que los
 *     separa.
 *
 * ── Las 3 zonas no se inventan acá: ya están en dos fuentes vivas ───────────
 *   · `kepler_ods.kduk` (catálogo de zonas del ERP, replicado en las 9
 *     sucursales): **ZONA LA PIEDAD · ZONA MORELIA · ZONA ZAMORA**, con dos
 *     numeraciones para los mismos tres nombres (`01/02/03` y
 *     `10000/20000/30000`) — 13,836 clientes clasificados.
 *   · `commercial.warehouses.purchase_zone`: La Piedad (01,02,03,04) · Zamora
 *     (05,06) · Morelia (07,08) · Corporativo (00).
 * Las dos coinciden. Esta migración las DECLARA en el catálogo propio.
 *
 * ── Qué hace, y qué NO hace ─────────────────────────────────────────────────
 * HACE (aditivo, sin cambiar el comportamiento de ninguna pantalla):
 *   1. `trade.zones.kind` — de qué nivel es cada fila (`zona` | `sucursal` |
 *      `canal` | `oficina`). Hoy no lo lee nadie: es la declaración sobre la que
 *      se apoyan los pasos siguientes.
 *   2. `trade.zones.code` — llave ESTABLE. Hoy la llave es el nombre, y
 *      renombrar rompe (ya pasó: `rename_zone_nacional_to_oficinas`, y el JWT
 *      viaja con el nombre, no con el id).
 *   3. Crea la zona **MORELIA**, que es la única de las tres que no existe.
 *   4. `analytics.v_branch_zone` — el resolvedor único sucursal → zona.
 *
 * NO HACE (a propósito, porque mueve números en pantalla y necesita su propio
 * paso con medición del antes/después):
 *   · No re-apunta `commercial.warehouses.zone_id` (eso cambia el tablero de
 *     dirección de 6 agrupaciones a 3).
 *   · No mueve ninguna persona de zona.
 *   · No borra ni renombra ninguna fila.
 *
 * ⚠️ La clasificación de las 9 filas es SEMÁNTICA, no derivable: `ZAMORA` puede
 * leerse como la zona o como la sucursal «Zamora Centro». Se resuelve con el
 * criterio del negocio, confirmado por el lead el 2026-09-23: *«esas no son
 * tiendas, son sucursales; zonas son: La Piedad, Zamora y Morelia»*. Por eso va
 * escrita, fila por fila y con su motivo, en vez de adivinada por un LIKE.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'trade.zones';
const VISTA = 'analytics.v_branch_zone';

/** Las 3 zonas del negocio. `erp_codes` son las de `kepler_ods.kduk` (dos numeraciones). */
const ZONAS = [
  { code: 'LP', nombre_actual: 'LA PIEDAD RD', erp: ['01', '10000'] },
  { code: 'ZAM', nombre_actual: 'ZAMORA', erp: ['03', '30000'] },
  // La única que no existe como fila: hoy sólo están sus dos sucursales.
  { code: 'MOR', nombre_actual: null, nombre_nuevo: 'MORELIA', erp: ['02', '20000'] },
];

/**
 * Clasificación de las filas actuales. El motivo va en la fila porque dentro de
 * seis meses nadie va a recordar por qué `CANINDO` es sucursal y `ZAMORA` zona.
 */
const CLASIFICACION = [
  ['LA PIEDAD RD', 'zona', 'LP', 'La zona La Piedad. El sufijo RD es de cuando zona y canal eran lo mismo.'],
  ['ZAMORA', 'zona', 'ZAM', 'La zona Zamora (no la sucursal, que es Zamora Centro / DAMASO).'],
  ['YURECUARO', 'sucursal', null, 'Es la sucursal 04. Su zona es La Piedad (purchase_zone).'],
  ['CANINDO', 'sucursal', null, 'Es la sucursal 06. Su zona es Zamora. De aquí cargan las rutas 501-505.'],
  ['MORELIA MADERO', 'sucursal', null, 'Es la sucursal 07 (MM). Su zona es Morelia.'],
  ['MORELIA ABASTOS', 'sucursal', null, 'Es la sucursal 08 (MA). Su zona es Morelia.'],
  ['LA PIEDAD VECINAL', 'canal', null, 'Canal vecinal de la zona La Piedad, no una zona aparte.'],
  ['ZAMORA VECINAL', 'canal', null, 'Canal vecinal de la zona Zamora, no una zona aparte.'],
  ['OFICINAS', 'oficina', null, 'No es un lugar de venta: es la actividad. Su destino es SEDE, no zona.'],
];

exports.up = async function up(knex) {
  // `identity.users` y `trade.zones` se leen en el camino caliente; un ALTER que
  // espera encola detrás de sí a todo el que venga después (GOTCHAS §38).
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  // ── 1. Columnas declarativas ───────────────────────────────────────────────
  if (!(await knex.schema.withSchema('trade').hasColumn('zones', 'kind'))) {
    await knex.raw(`ALTER TABLE ${TABLA} ADD COLUMN kind varchar(16)`);
  }
  if (!(await knex.schema.withSchema('trade').hasColumn('zones', 'code'))) {
    await knex.raw(`ALTER TABLE ${TABLA} ADD COLUMN code varchar(16)`);
  }
  if (!(await knex.schema.withSchema('trade').hasColumn('zones', 'kind_motivo'))) {
    await knex.raw(`ALTER TABLE ${TABLA} ADD COLUMN kind_motivo text`);
  }

  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'trade.zones'::regclass AND conname = 'zones_kind_valido'
      ) THEN
        ALTER TABLE trade.zones
          ADD CONSTRAINT zones_kind_valido
          CHECK (kind IS NULL OR kind IN ('zona','sucursal','canal','oficina'));
      END IF;
    END $$;
  `);

  // El código es la llave estable, y tiene que ser única DENTRO del tenant.
  // Parcial: las filas sin código (las que no son zona) no compiten entre sí.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS zones_tenant_code_unique
      ON trade.zones (tenant_id, code) WHERE code IS NOT NULL AND deleted_at IS NULL
  `);

  // ── 2. Clasificar lo que ya existe ─────────────────────────────────────────
  for (const [nombre, kind, code, motivo] of CLASIFICACION) {
    await knex(TABLA)
      .whereRaw('upper(btrim(name)) = ?', [nombre])
      .update({ kind, code, kind_motivo: motivo });
  }

  // ── 3. La zona que falta ───────────────────────────────────────────────────
  // MORELIA no existe como zona: hoy sólo están sus dos sucursales. Sin ella, la
  // tercera parte del negocio no tiene dónde colgar. Se crea por tenant, y sólo
  // si no está (idempotente).
  const tenants = await knex('trade.zones').distinct('tenant_id').pluck('tenant_id');
  for (const tenantId of tenants) {
    const ya = await knex(TABLA)
      .where({ tenant_id: tenantId })
      .whereRaw(`(code = 'MOR' OR upper(btrim(name)) = 'MORELIA')`)
      .first();
    if (!ya) {
      const maxOrden = await knex(TABLA).where({ tenant_id: tenantId }).max('orden as m').first();
      await knex(TABLA).insert({
        tenant_id: tenantId,
        name: 'MORELIA',
        code: 'MOR',
        kind: 'zona',
        kind_motivo:
          'Tercera zona del negocio. No existía: sólo estaban sus sucursales (MM 07, MA 08). ' +
          'Confirmada en kepler_ods.kduk (ZONA MORELIA / CLIENTES ZONA MORELIA) y en warehouses.purchase_zone.',
        orden: Number(maxOrden?.m ?? 0) + 1,
      });
      console.log(`  ✓ [ZN.0] zona MORELIA creada para el tenant ${tenantId}`);
    }
  }

  await knex.raw(`
    COMMENT ON COLUMN ${TABLA}.kind IS
      '[ZN.0] De qué NIVEL es esta fila: zona (las 3 del negocio: La Piedad, Zamora, Morelia) | '
      'sucursal (está acá por historia, su lugar es commercial.warehouses) | canal (vecinal) | '
      'oficina (no es un lugar de venta). La tabla mezclaba los cuatro y toda persona apuntaba acá.'
  `);
  await knex.raw(`
    COMMENT ON COLUMN ${TABLA}.code IS
      '[ZN.0] Llave ESTABLE de la zona (LP/ZAM/MOR). Antes la llave era el nombre, y renombrar '
      'rompía: el JWT viaja con el NOMBRE de la zona, no con el id.'
  `);

  // ── 4. El resolvedor único: sucursal → zona ────────────────────────────────
  /*
   * VISTA, no tabla (regla principal del proyecto: derivar, no copiar).
   *
   * La pertenencia sale de `purchase_zone`, que es dato PROPIO: Kepler clasifica
   * al CLIENTE por zona (`kdud.c14` → `kduk`), no a la sucursal. Se declara de
   * dónde salió cada fila en vez de fingir que lo dice el ERP.
   *
   * `security_invoker`: la vista respeta los permisos y el RLS de quien consulta,
   * no los del dueño.
   */
  await knex.raw(`
    CREATE OR REPLACE VIEW ${VISTA} WITH (security_invoker = true) AS
    SELECT
      w.tenant_id,
      w.code                                   AS branch_code,
      w.short_label                            AS branch_short,
      w.name                                   AS branch_name,
      w.purchase_zone                          AS zona_origen,
      CASE upper(btrim(coalesce(w.purchase_zone, '')))
        WHEN 'LA PIEDAD' THEN 'LP'
        WHEN 'ZAMORA'    THEN 'ZAM'
        WHEN 'MORELIA'   THEN 'MOR'
        ELSE NULL
      END                                      AS zona_code,
      z.id                                     AS zona_id,
      z.name                                   AS zona_nombre,
      -- El CEDIS no pertenece a ninguna zona de venta: es corporativo. Se DECLARA
      -- en vez de forzarlo a una plaza para que no quede en NULL silencioso.
      (upper(btrim(coalesce(w.purchase_zone, ''))) = 'CORPORATIVO') AS es_corporativo
    FROM commercial.warehouses w
    LEFT JOIN trade.zones z
           ON z.tenant_id = w.tenant_id
          AND z.deleted_at IS NULL
          AND z.kind = 'zona'
          AND z.code = CASE upper(btrim(coalesce(w.purchase_zone, '')))
                         WHEN 'LA PIEDAD' THEN 'LP'
                         WHEN 'ZAMORA'    THEN 'ZAM'
                         WHEN 'MORELIA'   THEN 'MOR'
                         ELSE NULL
                       END
    WHERE w.deleted_at IS NULL
      AND w.code ~ '^[0-9]{2}$'
  `);

  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
  await knex.raw(`
    COMMENT ON VIEW ${VISTA} IS
      '[ZN.0] Resolvedor único sucursal -> zona. La pertenencia sale de warehouses.purchase_zone '
      '(dato propio: Kepler clasifica al CLIENTE por zona, no a la sucursal) y coincide con '
      'kepler_ods.kduk. zona_id NULL = no se pudo resolver, se DECLARA (ADR-056), no se inventa.'
  `);

  // ── 5. Gate ────────────────────────────────────────────────────────────────
  // Tres zonas, ni más ni menos, y ninguna sucursal de la red sin zona salvo el
  // CEDIS. Un catálogo que no cuadra acá es el defecto que esta migración existe
  // para cerrar, así que se rompe la corrida en vez de dejarlo pasar.
  const { rows: zonas } = await knex.raw(
    `SELECT count(*)::int n FROM ${TABLA} WHERE kind = 'zona' AND deleted_at IS NULL`,
  );
  if (zonas[0].n !== 3 * tenants.length) {
    throw new Error(
      `Se esperaban 3 zonas por tenant (${3 * tenants.length}); hay ${zonas[0].n}. ` +
        `Revisá la clasificación antes de seguir.`,
    );
  }

  const { rows: huerfanas } = await knex.raw(
    `SELECT branch_code FROM ${VISTA} WHERE zona_id IS NULL AND NOT es_corporativo`,
  );
  if (huerfanas.length) {
    throw new Error(
      `Sucursales sin zona resuelta: ${huerfanas.map((h) => h.branch_code).join(', ')}. ` +
        `Falta purchase_zone o el mapeo de su texto.`,
    );
  }

  const { rows: resumen } = await knex.raw(
    `SELECT zona_code, count(*)::int n, string_agg(branch_short, ' ' ORDER BY branch_code) sucursales
       FROM ${VISTA} WHERE NOT es_corporativo GROUP BY 1 ORDER BY 1`,
  );
  for (const r of resumen) {
    console.log(`  ✓ [ZN.0] ${r.zona_code}: ${r.n} sucursales — ${r.sucursales}`);
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
  // Las columnas se conservan: son aditivas y nadie las lee todavía. Borrarlas
  // exige autorización explícita (regla del proyecto), y el rollback no la tiene.
  await knex(TABLA).update({ kind: null, code: null, kind_motivo: null });
};
