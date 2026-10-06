'use strict';
/**
 * `[VEC.1]` — `trade.catalogs.route_kind`: qué TIPO de ruta es cada ruta de venta.
 *
 * ── Por qué una columna y no una derivación ─────────────────────────────────────────────
 * Es la pregunta que abre el flujo vecinal ("que a la sucursal le llegue **sólo** el pedido
 * vecinal"), y hoy **no se puede expresar**: nada en el pedido ni en la ruta dice de qué tipo es.
 *
 * ⛔ **No se puede derivar, y está medido.** Las dos reglas obvias fallan:
 *
 *   1. *"el código `NVnnn` con V = vecinal"* → de **12** códigos con `V` sólo **7** son vecinal.
 *      `2V004` es **TELEMARKETING MORELIA**. Usar la letra mete telemarketing en la ola.
 *   2. *"el nombre dice VECINAL"* → los que lo dicen son de La Piedad y Zamora. **Morelia hace
 *      vecinal y su nombre NO lo dice** (`2V001` JOSEPH, `2V003` GUILLERMO, `2V005` HUMBERTO).
 *      Filtrar por nombre **pierde Morelia entera** — el defecto de
 *      [[feedback_filter_validated_on_one_branch_deletes_another]].
 *
 * Y `kepler_ods.kduv` **no tiene columna de tipo**: `c4`–`c14` vienen vacías o en cero en los 9
 * códigos probados (V, D, M y piso). **Kepler no declara el tipo de ruta en ningún lado**, así que
 * se declara acá. No es preferencia: es la única opción que queda.
 *
 * ── El reparto sale de REGLAS, no de una lista de UUIDs ─────────────────────────────────
 * Una lista de ids pegada a mano no se puede auditar ni re-correr. Las reglas abajo se validaron
 * en seco contra prod (2026-10-06) y dan **8 vecinal · 16 camión · 4 mayoreo · 1 sin declarar**.
 * Cada una con su testigo:
 *
 *   · **vecinal (8)** — `kduv.c3` dice "RUTA VECINAL …" para `1V001`–`1V004` y `3V001`; y los tres
 *     de Morelia (`2V001`/`2V003`/`2V005`) por `analytics.vendor_identity`, que es un padrón
 *     CURADO con la evidencia escrita fila por fila: la de `2V001` dice *"07:2V001 alimenta el
 *     índice de rutas"* y la de `2V005` lo llama literalmente *"código vecinal 2V005"*.
 *     ⚠️ Los tres de Morelia van por lista explícita **a propósito**: su única señal derivable
 *     sería la letra `V`, que ya probamos que miente (`2V004` = telemarketing).
 *   · **camión (16)** — nombre `RUTA <n>` o `<n>` pelado. Kepler los codifica `1D001`–`1D006`
 *     ("D" = distribución) y el rollup los clasifica `ruta_venta`.
 *   · **mayoreo (4)** — nombre con "mayoreo", más `10001`/`10002`, cuyas notas en
 *     `vendor_identity` dicen textualmente **"Mayoreo Kepler"**.
 *   · **sin declarar (1)** — `20005 GLORIA ORTEGA CALDERON`. El rollup la pone en **mostrador** y
 *     `vendor_identity` no la asocia a ninguna ruta. **NULL con dueño: Edgar.**
 *
 * ⭐ **NULL significa "nadie lo declaró", nunca un default.** Caer a `camion` por omisión haría
 * que una ruta nueva entre al flujo equivocado **en silencio** — y el síntoma sería mercancía
 * armada en la ola que no era. Lo que no se sabe se declara (ADR-056).
 *
 * ⚠️ **`\s` NO funciona en los literales de regex de esta base.** Medido por tres caminos
 * (literal en el SQL, binding `$1`, y `length()`): con `\s` el patrón matchea `'502'` y **no**
 * `'RUTA 21'` — o sea que lo lee como una `s` literal. Con un espacio literal o `[[:space:]]`
 * matchea los 16. Es una observación reproducible; el mecanismo exacto no se investigó.
 * Si tocás estas reglas, **no uses `\s`**.
 *
 * ⚠️ `public.catalogs` es una vista de columnas explícitas: **NO** expone `route_kind`. El código
 * que la necesite lee `trade.catalogs` (misma nota que `20260928210000_vk_erp_links`).
 *
 * Idempotente (`hasColumn` + `IF NOT EXISTS` + el seed sólo escribe donde está en NULL).
 *
 * @param { import("knex").Knex } knex
 */

/** Taxonomía cerrada. Los 5 valores salen del catálogo de Kepler, no de una lluvia de ideas:
 *  `1Vnnn` vecinal · `1Dnnn` camión · `10Mnn` telemarketing · mayoreo · `1000n` piso de sucursal. */
const KINDS = ['vecinal', 'camion', 'telemarketing', 'mayoreo', 'piso'];

/** Las reglas, en un solo lugar: las usa el seed y las re-verifica la compuerta. */
const CLASIFICADOR = `
  CASE
    -- Kepler lo dice con todas las letras.
    WHEN EXISTS (SELECT 1 FROM kepler_ods.kduv k
                  WHERE k.sucursal = '00' AND btrim(k.c2) = tc.erp_vendor_code
                    AND btrim(k.c3) ILIKE '%VECINAL%')                       THEN 'vecinal'
    -- Morelia: Kepler los nombra con el nombre de la persona. Testigo = vendor_identity.
    WHEN tc.erp_vendor_code IN ('2V001','2V003','2V005')                     THEN 'vecinal'
    WHEN tc.value ILIKE '%mayoreo%'                                          THEN 'mayoreo'
    -- 10001/10002 NO tienen erp_vendor_code (sólo 9 de 29 rutas lo tienen) -> por prefijo.
    WHEN btrim(tc.value) ~ '^1000[12] '                                      THEN 'mayoreo'
    -- Espacio LITERAL, no \\s (ver encabezado).
    WHEN btrim(tc.value) ~* '^(ruta)? *[0-9]+$'                              THEN 'camion'
    ELSE NULL
  END`;

exports.up = async function up(knex) {
  if (!(await knex.schema.withSchema('trade').hasColumn('catalogs', 'route_kind'))) {
    await knex.raw(`ALTER TABLE trade.catalogs ADD COLUMN route_kind varchar(20)`);
  }

  await knex.raw(`ALTER TABLE trade.catalogs DROP CONSTRAINT IF EXISTS catalogs_route_kind_ck`);
  await knex.raw(`
    ALTER TABLE trade.catalogs ADD CONSTRAINT catalogs_route_kind_ck
      CHECK (route_kind IS NULL OR route_kind IN (${KINDS.map((k) => `'${k}'`).join(',')}))`);

  // Sólo las rutas lo llevan: una zona o un nivel con `route_kind` sería ruido que después
  // alguien lee como dato. `trade.catalogs` guarda varios catálogos en la misma tabla.
  await knex.raw(`ALTER TABLE trade.catalogs DROP CONSTRAINT IF EXISTS catalogs_route_kind_solo_rutas_ck`);
  await knex.raw(`
    ALTER TABLE trade.catalogs ADD CONSTRAINT catalogs_route_kind_solo_rutas_ck
      CHECK (route_kind IS NULL OR catalog_id = 'rutas')`);

  await knex.raw(`COMMENT ON COLUMN trade.catalogs.route_kind IS
    'VEC.1 — sólo rutas: tipo de ruta (vecinal|camion|telemarketing|mayoreo|piso). NULL = NADIE LO DECLARÓ, nunca un default: una ruta nueva no entra a ningún flujo hasta que alguien diga qué es. Kepler no publica el tipo en ningún campo (kduv.c4-c14 vacías), por eso se declara acá.'`);

  // ── Seed: sólo donde está en NULL. Re-correrla no pisa una decisión humana posterior ──
  const seed = await knex.raw(
    `UPDATE trade.catalogs tc
        SET route_kind = (${CLASIFICADOR}), updated_at = now()
      WHERE tc.catalog_id = 'rutas' AND tc.deleted_at IS NULL
        AND tc.route_kind IS NULL
        AND (${CLASIFICADOR}) IS NOT NULL
      RETURNING tc.value, tc.route_kind`,
  );
  const porTipo = seed.rows.reduce((a, r) => ({ ...a, [r.route_kind]: (a[r.route_kind] || 0) + 1 }), {});
  console.log(`  [VEC.1] sembradas ${seed.rows.length}: ${JSON.stringify(porTipo)}`);

  // ── COMPUERTAS ───────────────────────────────────────────────────────────────────────
  const { rows: estado } = await knex.raw(`
    SELECT coalesce(route_kind, '(sin declarar)') AS kind, count(*)::int AS n
      FROM trade.catalogs WHERE catalog_id = 'rutas' AND deleted_at IS NULL
     GROUP BY 1 ORDER BY 2 DESC`);
  for (const e of estado) console.log(`  [VEC.1]   ${e.kind}: ${e.n}`);

  const total = estado.reduce((a, e) => a + e.n, 0);
  const vecinal = estado.find((e) => e.kind === 'vecinal')?.n || 0;
  const sinDeclarar = estado.find((e) => e.kind === '(sin declarar)')?.n || 0;

  // [1] Piso: una comparación entre conjuntos vacíos se pone verde sola (lección [ID.28]).
  if (total < 20) {
    throw new Error(`[VEC.1] sólo ${total} rutas en el catálogo: el seed no tiene con qué medirse.`);
  }
  // [2] Sin rutas vecinales, TODA la fase siguiente queda sin sujeto y nadie se entera hasta
  //     que la ola salga vacía. Es el caso que de verdad hay que atrapar.
  if (vecinal === 0) {
    throw new Error(
      '[VEC.1] cero rutas vecinales. Las reglas dejaron de alcanzar: revisar que ' +
        '`kepler_ods.kduv` siga poblada y que los códigos 2V001/2V003/2V005 sigan en el catálogo.',
    );
  }
  // [3] Lo no declarado se ACOTA. Si mañana entran 10 rutas nuevas sin clasificar, el flujo
  //     vecinal las ignora en silencio — esto obliga a mirarlas.
  if (sinDeclarar > 3) {
    const { rows: cuales } = await knex.raw(
      `SELECT value FROM trade.catalogs
        WHERE catalog_id='rutas' AND deleted_at IS NULL AND route_kind IS NULL ORDER BY value`,
    );
    throw new Error(
      `[VEC.1] ${sinDeclarar} rutas sin declarar (medido: 1 al escribir esto, 20005 GLORIA). ` +
        `Clasificarlas o ampliar las reglas: ${cuales.map((c) => c.value).join(', ')}`,
    );
  }
  // [4] El CHECK existe de verdad: se le tira un valor inválido y tiene que rebotar.
  //     Un gate sin prueba negativa es una intención (ADR-056).
  //
  // ⚠️ VA DENTRO DE UN SAVEPOINT, y no es adorno: knex corre la migración en UNA transacción,
  // así que el UPDATE que falla la deja abortada (25P02) y **un try/catch NO la rescata** —
  // todo lo que viniera después fallaría con "current transaction is aborted". El savepoint es
  // la única forma de provocar un error a propósito y seguir vivo. (Misma trampa que
  // `commercial-vendor-routes.service.ts` documenta para su resolución de ruta.)
  await knex.raw('SAVEPOINT vec1_prueba_negativa');
  let rebotó = false;
  try {
    await knex.raw(
      `UPDATE trade.catalogs SET route_kind = 'no_existe_este_tipo'
        WHERE id = (SELECT id FROM trade.catalogs
                     WHERE catalog_id='rutas' AND deleted_at IS NULL LIMIT 1)`,
    );
  } catch (e) {
    rebotó = /catalogs_route_kind_ck|check constraint|violates check/i.test(e.message);
  }
  await knex.raw('ROLLBACK TO SAVEPOINT vec1_prueba_negativa');
  await knex.raw('RELEASE SAVEPOINT vec1_prueba_negativa');
  if (!rebotó) {
    throw new Error('[VEC.1] el CHECK de route_kind NO rechazó un valor inválido: es decorativo.');
  }
  console.log('  [VEC.1] prueba negativa OK: el CHECK rechaza un tipo inventado.');
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE trade.catalogs DROP CONSTRAINT IF EXISTS catalogs_route_kind_ck`);
  await knex.raw(`ALTER TABLE trade.catalogs DROP CONSTRAINT IF EXISTS catalogs_route_kind_solo_rutas_ck`);
  await knex.raw(`ALTER TABLE trade.catalogs DROP COLUMN IF EXISTS route_kind`);
};
