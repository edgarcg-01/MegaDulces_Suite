/**
 * `[VSO.6b]` Cierra las dos preguntas de Morelia que `[VSO.6]` dejó abiertas — con el dato, no con
 * una consulta a la plaza.
 *
 * ── La pregunta 1: ¿qué pasó con MANUEL HERRERA? ────────────────────────────────────────────
 * Era el vendedor vecinal más grande de Madero (`32:51`, **$5,878,773** de preventa) y su columna
 * se corta el 2026-09-07, el día antes del cutover, sin sucesor Kepler. Medido:
 *
 *   ago-2026  32:51 MANUEL HERRERA  $730,238        (~$23.5k/día)
 *   sep 01-07 32:51 MANUEL HERRERA  $137,215        (~$19.6k/día — sigue a su ritmo, no se apagó)
 *   sep 08-26 07:2V003 GUILLERMO HERNANDEZ $639,196 (~$33.6k/día)
 *
 * Y el total vecinal de la plaza **no se movió** en el corte: 836k (jun) · 1,089k (jul) ·
 * 1,183k (ago) · 1,273k (sep). O sea que no desapareció venta: **GUILLERMO HERNÁNDEZ tomó la
 * ruta**. Antes del corte, su código Wincaja `32:45` tenía $2,302 en total — no existía como
 * vendedor. Después arranca de cero a $33.6k/día.
 *
 * ⛔ Por eso MANUEL HERRERA **no se fusiona con nadie**: no es un cambio de código, es un cambio
 * de persona. Kepler tampoco lo tiene en su catálogo (`kduv` de la rama 07 lista 10 vendedores y
 * él no está). Fusionarlo con Guillermo habría metido la venta de dos humanos en una columna.
 * Lo que queda para un humano no es el dato, es RH: si se fue o lo movieron.
 *
 * ── La pregunta 2: ¿los dos JOSEPH son el mismo? ────────────────────────────────────────────
 * Siguen SIN fusionarse, y ahora hay un argumento mejor que "venden los mismos días": el catálogo
 * de Kepler **replica el mismo código en las nueve ramas** cuando la persona es la misma — Manuel
 * (`20004`), Gloria (`20005`), Yadira (`20006`) y Humberto (`2V005`) están en 07 **y** en 08. Con
 * JOSEPH no lo hizo: `2V001 JOSEPH AGUSTIN GUERERRO` existe sólo en la rama 07. Si la empresa lo
 * considerara vendedor de Abastos, ahí estaría. Y su rastro en Abastos (`30:94`) es de $44,726 en
 * 18 meses, esporádico. Queda declarado.
 *
 * ── Lo que SÍ se fusiona ────────────────────────────────────────────────────────────────────
 * 1. GUILLERMO: `32:45` "GUILLERMO" (Wincaja Madero, hasta 2026-07-07) + `07:2V003` "GUILLERMO
 *    HERNANDEZ" (Kepler, desde el corte). Mismo plaza, el nombre corto es prefijo del largo, y no
 *    hay otro Guillermo en ninguno de los dos ERPs.
 * 2. Los gemelos de catálogo de Morelia que todavía no venden por la rama 07 pero **tienen el
 *    MISMO NOMBRE** que su gemelo de la 08: `20004` Manuel, `20005` Gloria, `2V005` Humberto. Más
 *    `20006` YADIRA CAMPERO ORTIZ, que estrena identidad propia.
 *
 * ⚠️ La regla es **mismo NOMBRE**, no mismo código — y eso NO es una precaución teórica:
 *    · el código `3` es **BENJAMIN ALONZO ZARAGOZA** en la rama 05 y **JOSE ANTONIO ESPINOZA
 *      CASTELLA** en la 04. Dos humanos distintos.
 *    · el código `20001` es "SUC MORELIA MADERO PISO" en la 07 y "VENTA PISO MORELIA ABASTOS" en
 *      la 08. Dos plazas distintas.
 *    Una regla "código = persona" para Kepler los habría fundido a los cuatro.
 *
 * ⛔ NO se mapea `07:2V002` "HUMBERTO PLASENCIA BRAVO". Está en el catálogo junto a `07:2V005`
 *    "HUMBERTO PLACENCIA", con otra ortografía y **sin una sola venta**. Podrían ser el mismo
 *    humano con dos altas, o dos personas. Mapear un código que nunca vendió no arregla nada y
 *    afirma una identidad que no se puede comprobar (ADR-056 R4).
 *
 * ── El riesgo latente que esto DESTAPÓ, medido y declarado ──────────────────────────────────
 * El `vendor_code` de Kepler es `sucursal:codigo`, pero el catálogo `kduv` está **replicado en las
 * nueve ramas**: la misma persona lleva el mismo código en todas. O sea que un vendedor que venda
 * en dos plazas se parte en dos columnas, sin cutover de por medio. Medido hoy: **17 códigos
 * venden en más de una rama**, pero en el ALCANCE del reporte por vendedor (mayoreo/preventa/ruta)
 * casi no muerde — CINTHIA (`10001`, $4.21M) tiene mayoreo en UNA sola plaza y en las otras dos
 * sólo mostrador, que queda fuera. Es riesgo latente, no pérdida viva; por eso no se siembran
 * cuarenta filas especulativas. Cuando muerda, la regla es la de arriba: mismo nombre, no mismo
 * código.
 *
 * Idempotente (UPSERT por PK). Verifica al final que cada persona quede en UNA sola clave.
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';

const PERSONAS = [
  {
    key: 'guillermo-hernandez-mor', nombre: 'Guillermo Hernández',
    codigos: [['32', '45'], ['07', '2V003']],
    note: 'VSO.6b · plaza 07 (Morelia Madero), corte 2026-09-08. Wincaja 32:45 "GUILLERMO" ($2,302, '
      + 'hasta 2026-07-07) y Kepler 07:2V003 "GUILLERMO HERNANDEZ" (desde el corte, $639,196 en 19 '
      + 'días). Único Guillermo en los dos ERPs. ⚠️ TOMÓ LA RUTA DE MANUEL HERRERA (32:51), que NO '
      + 'se fusiona con él: son dos personas distintas, no un cambio de código.',
  },
  {
    key: 'manuel-garcia-zurita', nombre: 'Manuel García Zurita',
    codigos: [['07', '20004']],
    note: 'VSO.6b · gemelo de catálogo: kduv lista 20004 "MANUEL DI STEFANO GARCIA ZURIT" con el '
      + 'MISMO nombre en las ramas 07 y 08. Todavía no vende por la 07; se mapea antes de que lo '
      + 'haga para que no estrene una segunda columna. La evidencia es el NOMBRE idéntico, no el '
      + 'código (el código 3 es dos personas distintas según la rama).',
  },
  {
    key: 'gloria-calderon', nombre: 'Gloria Calderón',
    codigos: [['07', '20005']],
    note: 'VSO.6b · gemelo de catálogo: kduv lista 20005 "GLORIA  CALDERON" con el mismo nombre en '
      + 'las ramas 07 y 08. Preventivo, misma regla del nombre.',
  },
  {
    key: 'humberto-placencia', nombre: 'Humberto Placencia',
    codigos: [['07', '2V005']],
    note: 'VSO.6b · gemelo de catálogo: kduv lista 2V005 "HUMBERTO PLACENCIA" en 07 y 08. '
      + 'Preventivo. ⛔ NO incluye 07:2V002 "HUMBERTO PLASENCIA BRAVO", que está en el mismo '
      + 'catálogo con otra ortografía y CERO ventas: podrían ser el mismo humano con dos altas o '
      + 'dos personas, y no hay con qué decidirlo.',
  },
  {
    key: 'yadira-campero', nombre: 'Yadira Campero Ortiz',
    codigos: [['08', '20006'], ['07', '20006']],
    note: 'VSO.6b · identidad propia para YADIRA CAMPERO ORTIZ, que estrena venta en la rama 08 '
      + '($23,928 desde el 2026-09-21). El catálogo la replica con el mismo nombre en 07, así que '
      + 'las dos ramas quedan atadas antes de que la segunda empiece a vender.',
  },
];

exports.up = async function (knex) {
  for (const p of PERSONAS) {
    for (const [sucursal, vendedor] of p.codigos) {
      await knex.raw(
        `INSERT INTO analytics.vendor_identity
           (tenant_id, source_branch, vendedor, canonical_key, canonical_name, note, exclude)
         VALUES (?::uuid, ?, ?, ?, ?, ?, false)
         ON CONFLICT (tenant_id, source_branch, vendedor) DO UPDATE
           SET canonical_key = EXCLUDED.canonical_key,
               canonical_name = EXCLUDED.canonical_name,
               note = EXCLUDED.note,
               updated_at = CURRENT_TIMESTAMP`,
        [TENANT, sucursal, vendedor, p.key, p.nombre, p.note],
      );
    }
  }

  for (const p of PERSONAS) {
    const { rows } = await knex.raw(
      `SELECT DISTINCT canonical_key FROM analytics.vendor_identity
        WHERE tenant_id = ?::uuid AND (source_branch, vendedor) IN (${p.codigos.map(() => '(?, ?)').join(', ')})`,
      [TENANT, ...p.codigos.flat()],
    );
    if (rows.length !== 1 || rows[0].canonical_key !== p.key) {
      throw new Error(`ABORT: ${p.nombre} quedó en ${rows.length} clave(s) (${rows.map((r) => r.canonical_key).join(', ')}), esperaba sólo ${p.key}`);
    }
    console.log(`  ✔ ${p.nombre}: ${p.codigos.length} código(s) → ${p.key}`);
  }

  // Guarda explícita: MANUEL HERRERA no puede haber quedado atado a Guillermo. Es la confusión que
  // este archivo existe para evitar, y un `ON CONFLICT DO UPDATE` mal editado la introduciría sin ruido.
  const { rows: mh } = await knex.raw(
    `SELECT canonical_key FROM analytics.vendor_identity
      WHERE tenant_id = ?::uuid AND source_branch IN ('32','30') AND vendedor IN ('51','31')`, [TENANT]);
  if (mh.some((r) => r.canonical_key === 'guillermo-hernandez-mor')) {
    throw new Error('ABORT: MANUEL HERRERA quedó apuntando a guillermo-hernandez-mor. Son dos personas: Guillermo TOMÓ su ruta, no es su código nuevo.');
  }
  console.log('  ✔ MANUEL HERRERA sigue sin fusionar (Guillermo tomó su ruta; son dos personas)');
};

exports.down = async function (knex) {
  const nuevas = [['32', '45'], ['07', '2V003'], ['07', '20004'], ['07', '20005'],
    ['07', '2V005'], ['08', '20006'], ['07', '20006']];
  for (const [s, v] of nuevas) {
    await knex('analytics.vendor_identity').where({ tenant_id: TENANT, source_branch: s, vendedor: v }).del();
  }
};
