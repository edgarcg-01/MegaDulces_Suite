'use strict';
/**
 * ⭐⭐ `[CGA-A.31]` — **Los 15 movimientos capturados a mano: 11 vinculados, 4 declarados.**
 *
 * ── Lo que pidió Edgar (2026-10-20) ─────────────────────────────────────────────────────────
 *
 * *«Hubo movimientos que no salían en producción, se registraron manual y necesitamos que todo
 * esté vinculado. Los objetivos son vincularlo con Kepler, luego en todo caso con CAOS. Ningún
 * movimiento debe estar desvinculado de Kepler.»*
 *
 * ── Lo medido, sólo lectura contra prod (`system_identifier` 7688376744939610156) ────────────
 *
 * **15 movimientos vivos con `origen_tipo IS NULL`, $380,449.10**, capturados por
 * `carmen_rodriguez` del 12 al 19-oct. Sus glosas dicen por qué: *«movimiento no reflejado»*,
 * *«NO SE REFLEJA EL MOVIMIENTO»*, *«NO FUNCINA CAOS»*, *«ES ANTICIPO»*.
 *
 *     vinculados a un gasto de Kepler ....   6   $230,517.10
 *     vinculados a un cobro de ruta ......   5   $106,602.00
 *     declarados, no vinculables .........   4    $43,330.00
 *                                          ──────────────────
 *                                           15   $380,449.10
 *
 * ── ⛔⛔ EL ERROR QUE ESTA MIGRACIÓN NO COMETE, Y QUE YO SÍ COMETÍ PRIMERO ───────────────────
 *
 * Mi primera pasada declaró **8 movimientos «inexistentes en Kepler»**. Era falso: busqué en
 * `analytics.mv_caja_movimientos` y `finance.v_caja_movimientos_pendientes` tiene **DOS ramas**
 * unidas por `UNION ALL`. La segunda es `analytics.route_collections`, donde vive el cobro de
 * ruta, y su almacén es **compuesto** (`01-001`, `06-003`), no un código de sucursal de dos
 * dígitos. Buscar en una rama y concluir sobre las dos daba cinco falsos negativos por
 * $106,602.00.
 *
 * ⭐ Lo delató que **Carmen ya había declarado el documento** de tres de ellos en
 * `declared_doc_ref` (`01-001|U-A-5|0000012|0011` y hermanos). La persona que capturó sabía más
 * que mi consulta. **Antes de declarar que un dato no existe, hay que agotar TODAS las ramas de
 * la vista que lo publica** — y mirar lo que la gente ya escribió.
 *
 * ── Control placebo: por qué estos vínculos se sostienen y los de CAOS no ────────────────────
 *
 *     Kepler, importe EXACTO (±10 días, universo de 568 gastos)
 *       importes reales ......  5/6 con candidato ÚNICO
 *       importes inventados ..  0/6 con candidato          ← discrimina perfecto
 *
 *     CAOS, importe ±$99 (±7 días)
 *       importes reales ......  3/8 con candidato
 *       importes inventados ..  5/8 con candidato          ← ⛔ el placebo GANA
 *
 * ⛔ **Por eso no se escribe ni un enlace en `finance.caos_cash_links`.** Con importe exacto
 * CAOS no casa con ninguno; con ±$99 casa con casi cualquier cosa. La tolerancia de
 * `[CGA-A.24]` (la máquina toma billetes, la morralla queda en el cajón) **sirve para VERIFICAR
 * un vínculo que ya existe, no para BUSCARLO**: aquélla comprobaba un `origen_ref` que Carmen
 * había puesto; usarla al revés es adivinar.
 *
 * ── ⭐ Los centavos: Carmen redondea al peso, y es consistente ───────────────────────────────
 *
 *     CG-2026-00006   mov $6,303.00    doc $6,302.78    −$0.22
 *     CI-2026-00016   mov $29,340.00   doc $29,339.77   −$0.23
 *     CI-2026-00018   mov $24,451.00   doc $24,450.80   −$0.20
 *     CI-2026-00044   mov $13,896.00   doc $13,895.87   −$0.13
 *
 * Cuatro movimientos, cuatro diferencias **todas menores a un peso y todas del mismo signo**: el
 * movimiento siempre es el documento redondeado hacia arriba. No es un descuadre, es una forma
 * de capturar. ⛔ **Y NO se corrige acá**: tocar el importe de un movimiento `en_corte` sería
 * reabrir un arqueo firmado. Queda declarado en cada uno.
 *
 * ── Los 6 gastos, y con qué se confirmó cada uno ─────────────────────────────────────────────
 *
 *   CG-2026-00006  →  03|X-D-26|0000161|0011   folio de la glosa + `GUILLERMO LOPEZ GUTIERREZ` + fecha
 *   CG-2026-00028  →  02|X-D-26|0000234|0011   importe exacto + `CUERITOS LUPITA`
 *       ⛔⛔ **ACÁ LA PROSA MIENTE.** La glosa dice `X-D-26 0023047`; ese documento EXISTE y es
 *       de **$1,250.00**. Creerle habría amarrado $10,490 a un documento de $1,250. Es la causa
 *       raíz §10.2 de este plan, atrapada en vivo.
 *   CG-2026-00093  →  07|X-D-26|0000097|0011   importe exacto, candidato único
 *   CG-2026-00094  →  07|X-D-26|0000098|0011   importe exacto, candidato único
 *   CG-2026-00102  →  00|X-D-60|0000188|0011   importe exacto + `6323` en los dos nombres
 *   CG-2026-00104  →  00|X-D-60|0000189|0011   importe exacto, candidato único
 *       ⚠️ El beneficiario NO confirma: el movimiento dice `TARJETA CREDITO BANORTEQ` y el
 *       documento `T. CREDITO BANORTE 5163`. Se vincula por único con placebo en cero.
 *
 * ── Los 5 cobros de ruta ─────────────────────────────────────────────────────────────────────
 *
 *   CI-2026-00016  →  06-001|U-A-5|0000006|0011   ruta_501 · la glosa «VENTA 08/10» = fv 08-oct
 *   CI-2026-00018  →  06-003|U-A-5|0000006|0011   ruta_503 · ídem
 *   CI-2026-00042  →  01-001|U-A-5|0000012|0011   ⭐ importe EXACTO y `RD 21 VICTORINO` ↔ ruta_21
 *   CI-2026-00043  →  01-006|U-A-5|0000012|0011   ⭐ importe EXACTO y `RUTA 28` ↔ ruta_28
 *   CI-2026-00044  →  01-004|U-A-5|0000012|0011   ruta_26 · −$0.13
 *
 * Los tres últimos ya los había declarado Carmen en `declared_doc_ref`; acá pasan a ser un
 * vínculo de verdad. ⭐⭐ **Y eso importa más de lo que parece: los cinco seguían apareciendo en
 * `v_caja_movimientos_pendientes`**, o sea que la cola los volvía a ofrecer para captura y el
 * autollenado podía duplicarlos — que es exactamente lo que ya pasó en `[CGA-A.24]`.
 *
 * ── Los 4 que NO se vinculan, y por qué no es un descuido ────────────────────────────────────
 *
 *   CI-2026-00017  $16,482.00 — **DOS candidatos idénticos**: `06-002` (ruta_502) y `06-004`
 *       (ruta_504), los dos de $16,482.23 y los dos del 08-oct. El importe no distingue y la
 *       glosa no nombra ruta. Elegir sería una moneda al aire entre dos rutas reales.
 *   CI-2026-00019  $16,583.00 — sin candidato en NINGUNA de las dos ramas, ±$1, ±12 días.
 *   CG-2026-00100  $160.00 — **6 candidatos vivos** de $160.00 exactos (y 12 contando los ya
 *       vinculados): carga de combustible que se repite. El importe es real y no identifica.
 *   CI-2026-00063  $10,105.00 — el documento `06|X-D-26|0000161|0011` coincide en importe,
 *       beneficiario (`NOMINA`) y fecha, **pero tiene `signo = -1`**: es la nómina que SE PAGÓ,
 *       y este movimiento es un **ingreso** (efectivo de nómina que volvió). La vista deriva
 *       `origen_tipo = signo > 0 ? cobro : pago_proveedor`, así que los dos valores mentirían.
 *       ⭐ Se guarda en `declared_doc_ref` —que existe para esto— y la decisión de cómo se
 *       modela un reintegro de nómina queda planteada, no resuelta a escondidas.
 *
 * ── Lo que esta migración NO hace ────────────────────────────────────────────────────────────
 *
 * ⛔ **No toca importes, ni estados, ni cortes.** Los 15 están `en_corte`: su arqueo ya se firmó.
 * El vínculo es **aditivo y no mueve un peso** — mismo criterio que `[CGA-A.24]`.
 *
 * ⛔ **No borra lo que escribió Carmen.** 9 de los 15 ya traen `sin_documento_motivo` de su puño
 * («NO APARECE EN EL SUITE», «SE MARCA COMO ANTICIPO»). Esas notas quedan y se les AÑADE la
 * resolución, porque una vez vinculado el movimiento sí tiene documento y el campo quedaría
 * contradiciéndose solo. Borrarlas sería tapar el rastro de quien sí hizo su trabajo.
 *
 * ⛔ **No inventa morralla** (Edgar, 2026-10-19: *«no debemos inventar información»*).
 *
 * ── Guardas ─────────────────────────────────────────────────────────────────────────────────
 *
 * El `up` **aborta entero** si cualquiera de estas deja de ser cierta: que cada movimiento
 * exista, esté vivo y siga sin vincular; que su documento exista con el importe medido al
 * centavo (en `mv_caja_movimientos` para los gastos, en `route_collections` para los cobros, que
 * es la fuente REAL de cada rama); y que ninguna `origen_ref` esté tomada por otro movimiento
 * vivo (`ux_cash_ledger_origen_vivo`). Cierra comprobando que no quede ninguno sin vínculo ni
 * declaración.
 *
 * Idempotente: todo va con `WHERE ... IS NULL`.
 *
 * ⚠️ **Sólo hace UPDATE: no crea ningún objeto de esquema, así que la compuerta del despliegue
 *    la clasifica NO_MEDIDO y FRENA al equipo hasta que alguien la aplique a mano. Hay que
 *    aplicarla ANTES de mergear**, con `apply-one-migration-prod.js`.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';

/**
 * Los 6 gastos. `docImporte` es el del DOCUMENTO (la guarda lo exige al centavo); `delta` es la
 * diferencia contra el movimiento, declarada donde la hay.
 */
const GASTOS = [
  { folio: 'CG-2026-00006', ref: '03|X-D-26|0000161|0011', docImporte: '6302.78',
    nota: 'vinculado por el folio que nombra la glosa + beneficiario GUILLERMO LOPEZ GUTIERREZ + fecha. El documento es $6,302.78 y el movimiento $6,303.00: diferencia de -$0.22 por redondeo al peso, NO se toco el importe (el corte ya esta firmado).' },
  { folio: 'CG-2026-00028', ref: '02|X-D-26|0000234|0011', docImporte: '10490.00',
    nota: 'la glosa nombra X-D-26 0023047, que EXISTE y es de $1,250.00: la prosa miente. El vinculo sale del importe exacto mas el beneficiario CUERITOS LUPITA, que coinciden los dos.' },
  { folio: 'CG-2026-00093', ref: '07|X-D-26|0000097|0011', docImporte: '252.60', nota: null },
  { folio: 'CG-2026-00094', ref: '07|X-D-26|0000098|0011', docImporte: '4544.63', nota: null },
  { folio: 'CG-2026-00102', ref: '00|X-D-60|0000188|0011', docImporte: '200419.65', nota: null },
  { folio: 'CG-2026-00104', ref: '00|X-D-60|0000189|0011', docImporte: '8507.22',
    nota: 'candidato unico por importe exacto (control placebo 0/6), pero el beneficiario NO confirma: el movimiento dice TARJETA CREDITO BANORTEQ y el documento T. CREDITO BANORTE 5163.' },
];

/** Los 5 cobros de ruta. Se verifican contra `analytics.route_collections`, su fuente real. */
const COBROS = [
  { folio: 'CI-2026-00016', almacen: '06-001', cobroFolio: '0000006', docImporte: '29339.77', ruta: 'ruta_501',
    nota: 'cobro de ruta_501 del 08-oct; la glosa VENTA 08/10 nombra esa fecha. Documento $29,339.77 contra movimiento $29,340.00: -$0.23 por redondeo al peso.' },
  { folio: 'CI-2026-00018', almacen: '06-003', cobroFolio: '0000006', docImporte: '24450.80', ruta: 'ruta_503',
    nota: 'cobro de ruta_503 del 08-oct; la glosa VENTA 08/10 nombra esa fecha. Documento $24,450.80 contra movimiento $24,451.00: -$0.20 por redondeo al peso.' },
  { folio: 'CI-2026-00042', almacen: '01-001', cobroFolio: '0000012', docImporte: '21507.00', ruta: 'ruta_21',
    nota: 'cobro de ruta_21 del 15-oct, importe EXACTO; el beneficiario RD 21 VICTORINO confirma la ruta. Carmen ya lo habia declarado en declared_doc_ref: acá pasa a ser vinculo, que es lo que lo saca de la cola de pendientes.' },
  { folio: 'CI-2026-00043', almacen: '01-006', cobroFolio: '0000012', docImporte: '17408.00', ruta: 'ruta_28',
    nota: 'cobro de ruta_28 del 15-oct, importe EXACTO; el beneficiario RUTA 28 confirma la ruta. Carmen ya lo habia declarado en declared_doc_ref.' },
  { folio: 'CI-2026-00044', almacen: '01-004', cobroFolio: '0000012', docImporte: '13895.87', ruta: 'ruta_26',
    nota: 'cobro de ruta_26 del 15-oct. Documento $13,895.87 contra movimiento $13,896.00: -$0.13 por redondeo al peso. Carmen ya lo habia declarado en declared_doc_ref.' },
];

/** Los 4 que no se vinculan. El motivo es el hecho MEDIDO. */
const DECLARADOS = [
  { folio: 'CI-2026-00017', motivo: 'CGA-A.31 (2026-10-20): DOS candidatos identicos en route_collections, 06-002 (ruta_502) y 06-004 (ruta_504), los dos de $16,482.23 y los dos del 08-oct. El importe no distingue y la glosa no nombra ruta: elegir seria una moneda al aire entre dos rutas reales.' },
  { folio: 'CI-2026-00019', motivo: 'CGA-A.31 (2026-10-20): sin candidato en NINGUNA de las dos ramas de v_caja_movimientos_pendientes (mv_caja_movimientos y route_collections), con $1 de tolerancia y +/-12 dias. El ingreso no tiene documento en el ERP.' },
  { folio: 'CG-2026-00100', motivo: 'CGA-A.31 (2026-10-20): 6 candidatos vivos de $160.00 exactos (12 contando los ya vinculados), casi todos ESTACION DE SERVICIO TAVISA. Es una carga de combustible que se repite: el importe es real y NO identifica un documento.' },
];

/** El que se declara con su documento pero NO se vincula: el signo de Kepler contradice al tipo. */
const DECLARADO_CON_DOC = {
  folio: 'CI-2026-00063',
  ref: '06|X-D-26|0000161|0011',
  motivo: 'CGA-A.31 (2026-10-20): el documento 06|X-D-26|0000161|0011 coincide en importe ($10,105.00), beneficiario (NOMINA) y fecha (19-oct), pero tiene signo -1 (es la nomina que SE PAGO) y este movimiento es un INGRESO: efectivo de nomina que volvio a la caja. No se escribe origen_tipo porque cobro y pago_proveedor afirmarian cosas falsas. Falta decidir como se modela un reintegro de nomina.',
};

/** Añade la resolución SIN borrar lo que escribió la persona que capturó. */
const SQL_NOTA = `
  UPDATE finance.cash_ledger
     SET sin_documento_motivo = CASE
           WHEN sin_documento_motivo IS NULL OR sin_documento_motivo = '' THEN ?
           WHEN position('CGA-A.31' in sin_documento_motivo) > 0 THEN sin_documento_motivo
           ELSE sin_documento_motivo || ' | ' || ?
         END,
         updated_at = now()
   WHERE tenant_id = ? AND folio = ?`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const abortar = (m) => {
    throw new Error(`[CGA-A.31] ${m} -- migracion abortada, no se toco ninguna fila.`);
  };

  const TODOS = [...GASTOS, ...COBROS];

  // Guarda 1: los 11 existen, estan vivos y siguen sin vincular.
  for (const v of TODOS) {
    const { rows } = await knex.raw(
      `SELECT origen_tipo, origen_ref, estado, deleted_at
         FROM finance.cash_ledger WHERE tenant_id = ? AND folio = ?`, [TENANT, v.folio]);
    if (rows.length !== 1) abortar(`${v.folio}: esperaba 1 fila y hay ${rows.length}`);
    const m = rows[0];
    if (m.deleted_at) abortar(`${v.folio}: esta borrado`);
    if (m.estado === 'cancelado') abortar(`${v.folio}: esta cancelado`);
    const refEsperada = v.ref || `${v.almacen}|U-A-5|${v.cobroFolio}|0011`;
    if (m.origen_tipo !== null && m.origen_ref !== refEsperada) {
      abortar(`${v.folio}: ya esta vinculado a otra cosa (${m.origen_tipo} / ${m.origen_ref})`);
    }
  }

  // ⚠️ Se fija el tenant: las vistas de analytics filtran por `current_tenant_id()` y sin esto
  //    devuelven CERO filas SIN ningun error -- la trampa de RLS de este repo.
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);

  // Guarda 2a: cada GASTO existe en mv_caja_movimientos con el importe medido.
  for (const v of GASTOS) {
    const p = v.ref.split('|');
    const { rows } = await knex.raw(
      `SELECT importe FROM analytics.mv_caja_movimientos
        WHERE tenant_id = ? AND sucursal = ? AND doc_tipo = ? AND folio = ? AND clave_banco = ?`,
      [TENANT, p[0], p[1], p[2], p[3]]);
    if (rows.length !== 1) abortar(`${v.ref}: esperaba 1 documento en Kepler y hay ${rows.length}`);
    if (Math.abs(Number(rows[0].importe) - Number(v.docImporte)) > 0.001) {
      abortar(`${v.ref}: el documento mide ${rows[0].importe} y se midio ${v.docImporte}`);
    }
  }

  // Guarda 2b: cada COBRO existe en route_collections, en UN solo grupo y con UNA sola ruta.
  for (const v of COBROS) {
    const { rows } = await knex.raw(
      `SELECT sum(importe) AS imp, string_agg(DISTINCT truck, ',') AS trucks
         FROM analytics.route_collections
        WHERE tenant_id = ? AND almacen = ? AND cobro_folio = ? AND cuenta = '0011'
        GROUP BY fecha`, [TENANT, v.almacen, v.cobroFolio]);
    if (rows.length !== 1) abortar(`${v.almacen}/${v.cobroFolio}: esperaba 1 grupo y hay ${rows.length}`);
    if (Math.abs(Number(rows[0].imp) - Number(v.docImporte)) > 0.001) {
      abortar(`${v.almacen}/${v.cobroFolio}: el cobro mide ${rows[0].imp} y se midio ${v.docImporte}`);
    }
    if (rows[0].trucks !== v.ruta) {
      abortar(`${v.almacen}/${v.cobroFolio}: esperaba la ruta ${v.ruta} y trae ${rows[0].trucks}`);
    }
  }

  // Guarda 3: ninguna ref esta tomada por otro movimiento vivo (ux_cash_ledger_origen_vivo).
  for (const v of TODOS) {
    const ref = v.ref || `${v.almacen}|U-A-5|${v.cobroFolio}|0011`;
    const { rows } = await knex.raw(
      `SELECT folio FROM finance.cash_ledger
        WHERE tenant_id = ? AND origen_ref = ? AND deleted_at IS NULL AND estado <> 'cancelado'
          AND folio <> ?`, [TENANT, ref, v.folio]);
    if (rows.length) abortar(`${ref}: ya la usa ${rows[0].folio}`);
  }

  // Escritura 1: los 6 gastos.
  for (const v of GASTOS) {
    await knex.raw(
      `UPDATE finance.cash_ledger SET origen_tipo = 'pago_proveedor', origen_ref = ?, updated_at = now()
        WHERE tenant_id = ? AND folio = ? AND origen_tipo IS NULL`, [v.ref, TENANT, v.folio]);
    if (v.nota) {
      const t = `CGA-A.31 (2026-10-20): ${v.nota}`;
      await knex.raw(SQL_NOTA, [t, t, TENANT, v.folio]);
    }
  }

  // Escritura 2: los 5 cobros de ruta.
  for (const v of COBROS) {
    const ref = `${v.almacen}|U-A-5|${v.cobroFolio}|0011`;
    await knex.raw(
      `UPDATE finance.cash_ledger SET origen_tipo = 'cobro', origen_ref = ?, updated_at = now()
        WHERE tenant_id = ? AND folio = ? AND origen_tipo IS NULL`, [ref, TENANT, v.folio]);
    const t = `CGA-A.31 (2026-10-20): ${v.nota}`;
    await knex.raw(SQL_NOTA, [t, t, TENANT, v.folio]);
  }

  // Escritura 3: el documento declarado sin vincular.
  await knex.raw(
    `UPDATE finance.cash_ledger SET declared_doc_ref = ?, updated_at = now()
      WHERE tenant_id = ? AND folio = ? AND declared_doc_ref IS NULL`,
    [DECLARADO_CON_DOC.ref, TENANT, DECLARADO_CON_DOC.folio]);
  await knex.raw(SQL_NOTA,
    [DECLARADO_CON_DOC.motivo, DECLARADO_CON_DOC.motivo, TENANT, DECLARADO_CON_DOC.folio]);

  // Escritura 4: los 3 declarados sin documento.
  for (const d of DECLARADOS) {
    await knex.raw(SQL_NOTA, [d.motivo, d.motivo, TENANT, d.folio]);
  }

  // Comprobacion final: ningun movimiento vivo queda sin vinculo NI declaracion.
  const { rows: sueltos } = await knex.raw(
    `SELECT folio FROM finance.cash_ledger
      WHERE tenant_id = ? AND deleted_at IS NULL AND estado <> 'cancelado'
        AND origen_tipo IS NULL AND declared_doc_ref IS NULL
        AND (sin_documento_motivo IS NULL OR sin_documento_motivo = '')`, [TENANT]);
  if (sueltos.length) {
    abortar(`quedan ${sueltos.length} sin vinculo ni declaracion: ${sueltos.map((s) => s.folio).join(', ')}`);
  }
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`, ni una fila mas.
 *
 * ⚠️ Quita el vinculo y el `declared_doc_ref`, y recorta el tramo ` | CGA-A.31 …` que se añadio,
 *    dejando intacto lo que la persona habia escrito antes.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  for (const v of GASTOS) {
    await knex.raw(
      `UPDATE finance.cash_ledger SET origen_tipo = NULL, origen_ref = NULL, updated_at = now()
        WHERE tenant_id = ? AND folio = ? AND origen_tipo = 'pago_proveedor' AND origen_ref = ?`,
      [TENANT, v.folio, v.ref]);
  }
  for (const v of COBROS) {
    await knex.raw(
      `UPDATE finance.cash_ledger SET origen_tipo = NULL, origen_ref = NULL, updated_at = now()
        WHERE tenant_id = ? AND folio = ? AND origen_tipo = 'cobro' AND origen_ref = ?`,
      [TENANT, v.folio, `${v.almacen}|U-A-5|${v.cobroFolio}|0011`]);
  }
  await knex.raw(
    `UPDATE finance.cash_ledger SET declared_doc_ref = NULL, updated_at = now()
      WHERE tenant_id = ? AND folio = ? AND declared_doc_ref = ?`,
    [TENANT, DECLARADO_CON_DOC.folio, DECLARADO_CON_DOC.ref]);

  // Recorta la nota que agregó el `up`, conserve o no texto previo.
  const folios = [...GASTOS, ...COBROS, ...DECLARADOS].map((x) => x.folio).concat(DECLARADO_CON_DOC.folio);
  await knex.raw(
    `UPDATE finance.cash_ledger
        SET sin_documento_motivo = NULLIF(regexp_replace(sin_documento_motivo,
              '( \\| )?CGA-A\\.31 \\(2026-10-20\\).*$', ''), ''),
            updated_at = now()
      WHERE tenant_id = ? AND folio = ANY(?::text[])
        AND position('CGA-A.31' in COALESCE(sin_documento_motivo, '')) > 0`,
    [TENANT, folios]);
};
