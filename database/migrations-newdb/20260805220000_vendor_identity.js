/**
 * RS.11 — Identidad de vendedor (crosswalk curado Wincaja → persona canónica).
 *
 * PROBLEMA: Wincaja es POS por-tienda y el "vendedor" es texto libre capturado en cada
 * sucursal → la MISMA persona se fragmenta: código distinto por plaza (identidad real =
 * `sucursal:código`), nombre con typos/casing/ruta pegada ("YARETH" vs "Cinthia Yareth
 * del Valle Rueda", "ALBERTO AYALA RUTA PAZCUARO…" vs "…ACAMBARO…"). Kepler SÍ tiene el
 * nombre limpio (registros en kdud: OS001=Sergio, 00019=Cinthia) pero con OTRA numeración
 * y sin tabla maestra extraíble → el enlace se CURA aquí, no se adivina.
 *
 * MODELO: cada (source_branch, vendedor) → canonical_key (identidad unificada: varias filas
 * pueden compartirla = MERGE) + canonical_name (nombre limpio para mostrar). Lo consume
 * sell-out (por vendedor y canal Mayoreo) al vuelo; sin fila = pass-through (código+nombre
 * tal cual). analytics.* sin RLS → filtro tenant_id EXPLÍCITO en el servicio.
 *
 * Siembra SOLO lo seguro (match exacto de nombre Kepler + merge misma-sucursal Alberto
 * Morelia). Los cruces entre sucursales (Manuel Herrera 30/32, Joseph 30/32, Alberto
 * Canindo 50:74, los dos Daniel) quedan FUERA hasta confirmación humana → no se mezclan.
 *
 * @param { import("knex").Knex } knex
 */
const MEGA = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  const has = await knex.schema.withSchema('analytics').hasTable('vendor_identity');
  if (!has) {
    await knex.schema.withSchema('analytics').createTable('vendor_identity', (t) => {
      t.uuid('tenant_id').notNullable();
      t.text('source_branch').notNullable();       // sucursal Wincaja (10/30/50/…)
      t.text('vendedor').notNullable();             // código Wincaja dentro de la sucursal
      t.text('canonical_key').notNullable();        // identidad unificada (slug); compartida = merge
      t.text('canonical_name').notNullable();       // nombre limpio (Kepler) para mostrar
      t.text('note');
      t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
      t.primary(['tenant_id', 'source_branch', 'vendedor']);
      t.index(['tenant_id', 'canonical_key'], 'ix_vendor_identity_canon');
    });
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.vendor_identity TO app_runtime`);
  }

  // Siembra segura (mayoreo). key = slug estable; filas con MISMA key = merge.
  const seed = [
    // Padre Hidalgo (10)
    { br: '10', cod: '75', key: 'sergio-mendoza',        name: 'Sergio Francisco Mendoza Pérez' },
    { br: '10', cod: '72', key: 'cinthia-delvalle',      name: 'Cinthia Yareth del Valle Rueda', note: 'Wincaja "YARETH"' },
    { br: '10', cod: '41', key: 'candy-salgado',         name: 'Candy Salgado' },
    // Morelia (30)
    { br: '30', cod: '33', key: 'manuel-garcia-zurita',  name: 'Manuel García Zurita' },
    { br: '30', cod: '74', key: 'alberto-ayala-mor',     name: 'Alberto Ayala González', note: 'ruta Pázcuaro-Tacámbaro' },
    { br: '30', cod: '75', key: 'alberto-ayala-mor',     name: 'Alberto Ayala González', note: 'MERGE: ruta Acámbaro-Cd Hidalgo (misma persona, misma plaza)' },
    { br: '30', cod: '25', key: 'humberto-plasencia',    name: 'Humberto Plasencia' },
    { br: '30', cod: '30', key: 'aaron-mor',             name: 'Aaron' },
    { br: '30', cod: '80', key: 'gloria-mor',            name: 'Gloria' },
    { br: '30', cod: '45', key: 'adrian-corona',         name: 'Adrián Corona' },
    { br: '30', cod: '94', key: 'joseph-mor',            name: 'Joseph' },
    // Canindo / Zamora (50)
    { br: '50', cod: '23', key: 'daniel-franco',         name: 'Daniel Franco Martínez' },
    { br: '50', cod: '33', key: 'jose-ramon-rodriguez',  name: 'José Ramón Rodríguez Varela' },
  ];
  for (const s of seed) {
    await knex.raw(
      `INSERT INTO analytics.vendor_identity (tenant_id, source_branch, vendedor, canonical_key, canonical_name, note)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, source_branch, vendedor)
       DO UPDATE SET canonical_key = EXCLUDED.canonical_key, canonical_name = EXCLUDED.canonical_name,
                     note = EXCLUDED.note, updated_at = now()`,
      [MEGA, s.br, s.cod, s.key, s.name, s.note ?? null],
    );
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('vendor_identity');
};
