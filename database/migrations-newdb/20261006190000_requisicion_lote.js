/**
 * `[RQ.8]` LAS REQUISICIONES DE UN MISMO «ARMAR» DEJAN DE SER ISLAS.
 *
 * Qué se midió contra prod (2026-10-06), sobre 82 generaciones reales reconstruidas a mano:
 *
 *     promedio 8.2 requisiciones por «Armar» · mediana 6 · PEOR 117
 *     22 lotes produjeron 10 o mas · 5 produjeron 20 o mas
 *     68 de 82 (83 %) los infla la SUCURSAL: 1 proveedor, 8.1 almacenes, hasta 21 documentos
 *     3 los infla el PROVEEDOR: 55.7 proveedores de promedio, y ahi esta el de 117
 *
 * ⚠️ Esos 82 lotes NO existian como dato: hubo que inferirlos con una ventana de 90 segundos
 * sobre `created_at`, que es justo lo que el comprador no puede hacer. Un grep de
 * `lote|batch|group|parent|origin|pedido|run` sobre las columnas de la tabla daba **cero**.
 *
 * ⛔ NO se fusionan las requisiciones, y no es pereza: `createRequisition` ya exige **un solo
 * proveedor** por requisición de compra y prohíbe mezclar compra con traspaso. Esa regla es
 * correcta — una requisición es el documento que se le manda a UN proveedor. Lo que faltaba no
 * era fusionar: era **atar**.
 *
 * Tres columnas, y cada una contesta una pregunta que hoy no tiene respuesta:
 *
 *   · `batch_id` / `batch_folio` — ¿qué otras salieron del mismo clic? La bandeja agrupa por acá
 *     y se aprueba el lote completo. El folio individual NO se toca: es lo que se le manda al
 *     proveedor.
 *   · `origin_requisition_id` — la BAJADA apunta a la COMPRA que la originó. Medido: **197
 *     traspasos por $7,121,283** dicen `"Bajada de compra consolidada 00 → 03"` en `notes`, como
 *     TEXTO LIBRE, sin forma de ir ni de ida ni de vuelta. Con esta FK las dos direcciones se
 *     derivan de un solo dato: la compra lista sus bajadas, y la bajada nombra su compra.
 *
 * ⛔ NO se agrega una columna de "sucursales para las que es la compra". Sería una segunda
 * materialización de algo que la FK ya deja derivar (GOTCHAS §32): las sucursales destino de una
 * compra consolidada son, exactamente, los destinos de sus bajadas.
 *
 * El folio del lote usa el secuenciador que YA existe (`commercial.purchase_doc_sequences`, que
 * ya emite `OC` y `OE`) con `doc_kind='RQL'`. Una tabla de secuencias nueva para el mismo trabajo
 * sería la tercera.
 *
 * Aditiva e idempotente: tres columnas nullable + dos índices sobre una tabla de 670 filas. No
 * toca RLS, ni datos, ni el folio individual. Lo viejo queda con `batch_id` NULL y la bandeja lo
 * muestra como lote de uno — declarado, no inventado hacia atrás.
 */
exports.up = async function up(knex) {
  const tabla = 'purchase_requisitions';
  const tiene = async (col) => knex.schema.withSchema('commercial').hasColumn(tabla, col);
  const [batchId, batchFolio, origen] = await Promise.all([
    tiene('batch_id'), tiene('batch_folio'), tiene('origin_requisition_id'),
  ]);
  if (!batchId || !batchFolio || !origen) {
    await knex.schema.withSchema('commercial').alterTable(tabla, (t) => {
      if (!batchId) t.uuid('batch_id').nullable();
      if (!batchFolio) t.string('batch_folio', 32).nullable();
      if (!origen) t.uuid('origin_requisition_id').nullable();
    });
  }
  // El índice es por (tenant, batch) porque TODA lectura del lote llega con el tenant puesto
  // (RLS forzado); uno sobre `batch_id` solo haría que el planner filtre después.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_purchase_requisitions_batch
      ON commercial.purchase_requisitions (tenant_id, batch_id)
      WHERE batch_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_purchase_requisitions_origen
      ON commercial.purchase_requisitions (tenant_id, origin_requisition_id)
      WHERE origin_requisition_id IS NOT NULL;
    COMMENT ON COLUMN commercial.purchase_requisitions.batch_id IS
      '[RQ.8] Las requisiciones que salieron del mismo "Armar". NULL = anterior a la columna; la bandeja las muestra como lote de uno, no las inventa hacia atras.';
    COMMENT ON COLUMN commercial.purchase_requisitions.batch_folio IS
      '[RQ.8] RQ-LOTE-AAAA-NNNNN, del secuenciador que ya emite OC y OE (doc_kind=RQL). Es para HABLAR del lote; el folio individual sigue siendo el que se le manda al proveedor.';
    COMMENT ON COLUMN commercial.purchase_requisitions.origin_requisition_id IS
      '[RQ.8] La BAJADA apunta a la COMPRA que la origino. Reemplaza el texto libre de notes ("Bajada de compra consolidada 00 -> 03"): 197 traspasos por $7.12M no se podian rastrear en ninguna direccion. Las sucursales destino de una compra consolidada se DERIVAN de aca, no se copian.';
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS commercial.ix_purchase_requisitions_batch;
    DROP INDEX IF EXISTS commercial.ix_purchase_requisitions_origen;`);
  const tabla = 'purchase_requisitions';
  const tiene = async (col) => knex.schema.withSchema('commercial').hasColumn(tabla, col);
  const [batchId, batchFolio, origen] = await Promise.all([
    tiene('batch_id'), tiene('batch_folio'), tiene('origin_requisition_id'),
  ]);
  if (batchId || batchFolio || origen) {
    await knex.schema.withSchema('commercial').alterTable(tabla, (t) => {
      if (batchId) t.dropColumn('batch_id');
      if (batchFolio) t.dropColumn('batch_folio');
      if (origen) t.dropColumn('origin_requisition_id');
    });
  }
};
