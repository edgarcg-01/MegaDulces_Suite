/**
 * `[IC.F24]` **Cada conteo guarda EN QUÉ UNIDAD se contó.**
 *
 * ── Qué estaba mal (medido en prod el 2026-11-27, sólo lectura) ─────────────────────────────────
 * `expected_qty` está en la unidad NATIVA del almacén —`v_erp_stock_on_hand.qty_stock_units`, que
 * `UNIDADES_DE_MEDIDA.md` documenta como «paquetes (crudo, a propósito)»— y **ninguna pantalla se
 * lo decía a quien cuenta**: el campo dice «Cantidad física», a secas. En `INV-2026-00010`,
 * **2,596 de 3,364 artículos (77 %)** tienen un factor de caja de 12 o más y 210 de 100 o más, así
 * que contar cajas donde el sistema espera paquetes equivoca la varianza por el factor —hasta
 * 1,000×— y el cierre escribe el ajuste con esa diferencia.
 *
 * ── De dónde sale la unidad (la vía que indicó Edgar, y que se verificó) ────────────────────────
 * «La unidad que el contador diga, pero considerando siempre la que tiene por defecto cada código
 * de barras». `catalog.product_barcodes` tiene una fila por código con `unit`, `factor`,
 * `is_primary` y un `source` que nombra el peldaño de la escalera de Kepler. Lo medido:
 *   · los **7,109** códigos `is_primary` son **TODOS** `kepler_base` y **TODOS** con `factor = 1`
 *     ⇒ el código que viene con el SKU **nombra la unidad nativa**, que es la del teórico;
 *   · sus unidades: PAQ 5,656 · PZA 1,294 · KG 128 · CJA 13 · otras 15;
 *   · de los 55 productos con dos primarios, **0 difieren en unidad** ⇒ no hay desempate al azar;
 *   · cobertura en el folio: **2,849 de 3,364** artículos (85 %) tienen primario, y **556** tienen
 *     más de una unidad — ésos son los que hoy se pueden contar mal sin que nadie lo note.
 * Los códigos NO primarios (`kepler_u2`, `kepler_u3`, `wincaja`) traen su factor **contra esa
 * base**, así que `cantidad × factor` normaliza sin salir de la escalera.
 *
 * ⚠️ **Lo que este factor NO es:** el `display_box_factor` del ERP. Se cruzaron y coinciden en
 * **21 de 511** (4.1 %). Por eso la conversión usa SÓLO las razones internas de
 * `product_barcodes` —que sí son consistentes entre sí— y nunca mezcla las dos fuentes.
 *
 * ── Qué agrega ──────────────────────────────────────────────────────────────────────────────────
 * Por cada ranura de conteo, la unidad que la persona declaró y el factor con que se normalizó.
 * `count_N` **sigue guardando el valor YA NORMALIZADO** a la unidad nativa, para que todo lo que
 * hoy compara contra `expected_qty` siga funcionando sin tocarse. Lo nuevo es el testigo: queda
 * escrito qué dijo la persona y con qué se convirtió (ADR-056: el dato y su procedencia).
 *
 * Todas las columnas son NULLABLE a propósito: un conteo viejo no declaró unidad y **no se le
 * inventa una**. NULL se lee «no declarado», que es distinto de «la nativa».
 */

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  // ⛔⛔ **`hasColumn` NO parte el nombre por el punto.** Esta migración nació pasando
  // `'commercial.inventory_count_items'` y knex lo busca como UN nombre de tabla: en
  // `information_schema.columns` eso da **0 filas** (medido en prod el 2026-11-27; buscando
  // bien da 37). O sea que la guarda devolvía siempre `false` y la migración **no era
  // idempotente** (regla 17): la primera corrida funciona de casualidad —las columnas no
  // existen— y la **segunda** muere con «column count_1_unit already exists».
  //
  // No rompió prod porque knex no re-corre lo aplicado; lo cobró quien armó una base de
  // pruebas clonando un esquema que ya las tenía. El nombre del archivo no cambia, así que
  // el ledger no se entera. La forma correcta es `withSchema`.
  const ESQUEMA = 'commercial';
  const TABLA = 'inventory_count_items';
  const esquema = () => knex.schema.withSchema(ESQUEMA);

  for (const slot of [1, 2, 3]) {
    const colUnidad = `count_${slot}_unit`;
    const colFactor = `count_${slot}_factor`;

    if (!(await esquema().hasColumn(TABLA, colUnidad))) {
      await esquema().alterTable(TABLA, (t) => {
        t.string(colUnidad, 16).nullable()
          .comment('[IC.F24] Unidad DECLARADA por quien contó (de catalog.product_barcodes.unit). NULL = no declarada.');
      });
    }
    if (!(await esquema().hasColumn(TABLA, colFactor))) {
      await esquema().alterTable(TABLA, (t) => {
        t.decimal(colFactor, 14, 4).nullable()
          .comment('[IC.F24] Unidades nativas por cada unidad declarada. 1 = se contó en la nativa.');
      });
    }
  }

  // El control: las seis columnas existen y están vacías (nadie declaró unidad todavía).
  const { rows } = await knex.raw(
    `SELECT count(*)::int AS columnas FROM information_schema.columns
      WHERE table_schema = 'commercial' AND table_name = 'inventory_count_items'
        AND column_name IN ('count_1_unit','count_1_factor','count_2_unit','count_2_factor','count_3_unit','count_3_factor')`,
  );
  const columnas = Number(rows?.[0]?.columnas ?? 0);
  if (columnas !== 6) {
    throw new Error(`[IC.F24] se esperaban 6 columnas nuevas y hay ${columnas}`);
  }

  const { rows: conteo } = await knex.raw(
    `SELECT count(*)::int AS items,
            count(count_1)::int AS con_conteo,
            count(count_1_unit)::int AS con_unidad
       FROM commercial.inventory_count_items`,
  );
  const r = conteo?.[0] ?? {};
  console.log(
    `[IC.F24] ${columnas} columnas listas · ${r.items} renglones · ${r.con_conteo} con conteo · ` +
      `${r.con_unidad} con unidad declarada (0 esperado: nadie declaró todavía)`,
  );
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const ESQUEMA = 'commercial';
  const TABLA = 'inventory_count_items';
  const esquema = () => knex.schema.withSchema(ESQUEMA);
  for (const slot of [1, 2, 3]) {
    for (const col of [`count_${slot}_unit`, `count_${slot}_factor`]) {
      if (await esquema().hasColumn(TABLA, col)) {
        await esquema().alterTable(TABLA, (t) => t.dropColumn(col));
      }
    }
  }
};
