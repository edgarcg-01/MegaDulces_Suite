/**
 * `[VSO.6]` Las identidades de vendedor que el cutover de ERP parte en dos.
 *
 * ── El problema ─────────────────────────────────────────────────────────────────────────────
 * Cuando una plaza cambia de POS, su vendedor cambia de CÓDIGO: en Wincaja es `sucursal:numero`
 * (`30:74`) y en Kepler `sucursal:codigo` (`08:20003`). `analytics.vendor_identity` existe para que
 * la misma persona colapse a UNA columna a través del corte — pero nadie la actualizó cuando Madero
 * (`32`→`07`, 2026-09-08) y Morelia Abastos (`30`→`08`, 2026-09-19) migraron hace días.
 *
 * Resultado medido en prod el 2026-09-28: **cinco personas con dos columnas cada una**, y la más
 * cara es un vendedor de **$47.9M** cuya columna simplemente se corta el 18-sep y reaparece con
 * otro nombre al día siguiente.
 *
 * ── ⚠️ Cómo se encontraron, que es la parte que importa ──────────────────────────────────────
 * El primer detector agrupaba por NOMBRE IGUAL y encontró **tres**. Está mal por construcción: lo
 * que cambia al cruzar de ERP es justamente el nombre. Los que se le escapaban:
 *
 *   `30:33` MANUEL GARCIA ZURITA   ←→  `08:20004` MANUEL DI STEFANO GARCIA ZURIT
 *   `30:80` GLORIA                 ←→  `08:20005` GLORIA  CALDERON
 *   `30:25` Humberto Plasencia     ←→  `08:2V005` HUMBERTO PLACENCIA   (Plasencia/Placencia)
 *
 * El detector que sí los ve compara **tokens de apellido** (≥5 letras, sin las palabras de plaza)
 * entre las identidades que TERMINAN del lado Wincaja y las que ARRANCAN del lado Kepler, en el
 * mismo almacén. Devuelve exactamente 6 pares, todos en `07` y `08` — los dos cortes recientes.
 *
 * ⛔ Y ese detector también tiene un punto ciego, declarado: **no puede ver un par cuando el lado
 * Kepler se llama como la RUTA y no como la persona.** Candy Salgado es ese caso (`10:41` "CANDY
 * SALGADO" contra `01:1V001` "RUTA VECINAL PH 01") y sólo se sabe porque una fila curada anterior
 * ya había bautizado esa ruta con su nombre. Un par así sólo lo encuentra un humano.
 *
 * ── La evidencia de cada fusión, fila por fila ──────────────────────────────────────────────
 * Todas comparten plaza y se relevan en el corte. Lo que las distingue es la fuerza del nombre, y
 * va escrita en la columna `note` de cada fila para que sea auditable y no haya que reconstruirla.
 *
 * ── Lo que NO se fusiona, a propósito ───────────────────────────────────────────────────────
 * `30:94` "JOSEPH" (plaza 08, $17,523 de por vida) queda con su identidad propia. Hay DOS Joseph en
 * Wincaja —`32:94` en Madero y `30:94` en Abastos— y **venden los mismos días**, así que no se puede
 * afirmar que sean el mismo humano; el código `94` coincide porque los códigos son por sucursal, no
 * porque sea la misma persona. Se DECLARA en vez de adivinarse.
 *
 * Tampoco se toca a `32:51` MANUEL HERRERA ($2.05M), que termina en el corte de Madero **sin
 * sucesor Kepler**: o se fue, o su identidad nueva tiene otro nombre. No hay con qué decidirlo.
 *
 * ⛔ Y NO se marcan `exclude` los siete "vendedores" que no son personas (`SUCURSAL … PISO`,
 * `E-COMMERCE`, `Otros Ingresos`… $742,420 en canales con vendedor). `exclude` los TIRA del pivote,
 * y esa plata es venta real: restársela a un reporte para que se vea más limpio es exactamente lo
 * contrario de lo que esta fase vino a arreglar. Quedan visibles, con el rótulo que el ERP les da.
 *
 * ── Seguridad del índice de rutas ───────────────────────────────────────────────────────────
 * Dos de las filas nuevas tienen código vecinal (`07:2V001`, `08:2V005`), y `buildRouteIdent()`
 * indexa esos códigos de forma GLOBAL (sin plaza) porque los `1V00N` se rocían entre sucursales.
 * Verificado antes de escribir: `2V001` existe SÓLO en la plaza 07 y `2V005` SÓLO en la 08, así que
 * el índice global no le puede pegar venta ajena a nadie.
 *
 * Idempotente (UPSERT por PK). Verifica al final que cada persona quede en UNA sola clave.
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';

/** Cada grupo = una persona. `codigos` son (source_branch, vendedor) de las DOS eras. */
const PERSONAS = [
  {
    key: 'alberto-ayala-mor', nombre: 'Alberto Ayala González',
    codigos: [['30', '74'], ['30', '75'], ['08', '20003']],
    note: 'VSO.6 · plaza 08 (Morelia Abastos), corte 2026-09-19. Wincaja 30:74 "ALBERTO AYALA RUTA '
      + 'PAZCUARO TACAMBARO" + 30:75 "...ACAMBARO-CIUDAD HIDALGO" (dos RUTAS del mismo humano, ya '
      + 'fusionadas) terminan el 18-sep; Kepler 08:20003 "ALBERTO AYALA GONZALEZ" arranca el 19. '
      + 'Tokens de apellido: ALBERTO+AYALA. Evidencia FUERTE.',
  },
  {
    key: 'manuel-garcia-zurita', nombre: 'Manuel García Zurita',
    codigos: [['30', '33'], ['08', '20004']],
    note: 'VSO.6 · plaza 08, corte 2026-09-19. "MANUEL GARCIA ZURITA" -> "MANUEL DI STEFANO GARCIA '
      + 'ZURIT" (el nombre de pila compuesto sólo aparece en Kepler). Tokens: MANUEL+GARCIA+ZURITA. '
      + 'Evidencia FUERTE.',
  },
  {
    key: 'gloria-calderon', nombre: 'Gloria Calderón',
    codigos: [['30', '80'], ['08', '20005']],
    note: 'VSO.6 · plaza 08, corte 2026-09-19. "GLORIA" -> "GLORIA  CALDERON". Sólo comparten el '
      + 'nombre de PILA, así que la evidencia es MEDIA; lo que la sostiene es que se verificó que no '
      + 'hay otra Gloria en ningún ERP ni en ninguna plaza: es 1 contra 1.',
  },
  {
    key: 'humberto-placencia', nombre: 'Humberto Placencia',
    codigos: [['30', '25'], ['08', '2V005']],
    note: 'VSO.6 · plaza 08, corte 2026-09-19. "Humberto Plasencia" -> "HUMBERTO PLACENCIA" '
      + '(variante ortográfica del apellido). Único Humberto en los dos ERPs. Evidencia FUERTE. '
      + 'OJO: el lado Kepler tiene código vecinal 2V005, así que esta fila también alimenta el '
      + 'índice de rutas — verificado que 2V005 sólo existe en la plaza 08.',
  },
  {
    key: 'joseph-madero', nombre: 'Joseph Agustín Guerrero',
    codigos: [['32', '94'], ['07', '2V001']],
    note: 'VSO.6 · plaza 07 (Morelia Madero), corte 2026-09-08. La evidencia más limpia de todas: '
      + '32:94 "JOSEPH" vende hasta el 2026-09-07 y 07:2V001 "JOSEPH AGUSTIN GUERERRO" arranca el '
      + '09-08, el día exacto del corte, en la misma plaza y sin ningún otro Joseph en Madero. '
      + 'OJO: 07:2V001 alimenta el índice de rutas — verificado que 2V001 sólo existe en la plaza 07. '
      + '⚠️ NO incluye a 30:94 "JOSEPH" (plaza 08): venden los MISMOS días, así que no se puede '
      + 'afirmar que sea el mismo humano. Queda con identidad propia, declarado.',
  },
  {
    key: 'ph-vecinal-candy', nombre: 'Candy Salgado',
    codigos: [['10', '41'], ['01', '1V001']],
    note: 'VSO.6 · plaza 01 (Padre Hidalgo), corte 2026-06-27. Wincaja 10:41 "CANDY SALGADO" hasta '
      + 'jun-2026; Kepler 01:1V001 se llama "RUTA VECINAL PH 01" y una fila curada anterior ya lo '
      + 'había bautizado "Candy Salgado". Por eso ningún matcher por nombre podía encontrar este '
      + 'par: del lado Kepler la identidad es la RUTA. Se unifica en la clave anclada a la ruta, '
      + 'que es la convención que ya seguían ph-vecinal-candy y ph-vecinal-rafael.',
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

  // Verificación: cada persona tiene que quedar en UNA sola clave. Si no, la migración no hizo lo
  // que dice y es mejor que falle acá que que alguien lo descubra en una columna partida.
  for (const p of PERSONAS) {
    const { rows } = await knex.raw(
      `SELECT DISTINCT canonical_key FROM analytics.vendor_identity
        WHERE tenant_id = ?::uuid AND (source_branch, vendedor) IN (${p.codigos.map(() => '(?, ?)').join(', ')})`,
      [TENANT, ...p.codigos.flat()],
    );
    if (rows.length !== 1 || rows[0].canonical_key !== p.key) {
      throw new Error(`ABORT: ${p.nombre} quedó en ${rows.length} clave(s) (${rows.map((r) => r.canonical_key).join(', ')}), esperaba sólo ${p.key}`);
    }
    console.log(`  ✔ ${p.nombre}: ${p.codigos.length} códigos → ${p.key}`);
  }
};

exports.down = async function (knex) {
  // Vuelve al estado previo: se borran las filas nuevas y se restauran las dos que ya existían.
  const nuevas = [['30', '33'], ['08', '20004'], ['30', '80'], ['08', '20005'],
    ['30', '25'], ['08', '2V005'], ['32', '94'], ['07', '2V001'], ['08', '20003']];
  for (const [s, v] of nuevas) {
    await knex('analytics.vendor_identity').where({ tenant_id: TENANT, source_branch: s, vendedor: v }).del();
  }
  await knex('analytics.vendor_identity')
    .where({ tenant_id: TENANT, source_branch: '10', vendedor: '41' })
    .update({ canonical_key: 'candy-salgado', canonical_name: 'Candy Salgado' });
};
