'use strict';
/**
 * ⭐⭐ `[CGA-A.36]` — **Fuera los 3 movimientos de prueba, y el empate de `CI-00017` resuelto
 * por el ORDEN DE CAPTURA.**
 *
 * Dos cosas pedidas por Edgar el 2026-10-20, las dos sobre el libro de prod.
 *
 * ── 1. Los 3 movimientos de prueba, medidos ──────────────────────────────────────────────────
 *
 *     CG-2026-00003   08-oct   $20.00    «PRUEBA E2E [CG.70] — movimiento de prueba, anular»
 *     CG-2026-00042   14-oct   $100.00   «AUDITORIA E2E prueba negativa»
 *     CG-2026-00043   14-oct   $1.00     «AUDITORIA E2E idempotencia 14-oct-2026»
 *                              ────────
 *                               $121.00   los tres de `superoot`, los tres ya `cancelado`
 *
 * ⭐ **Borrarlos no mueve ningún número, y eso está medido, no supuesto:** `CC-2026-00003` guarda
 * `total_gastos = $9,559.83` y la suma del libro contando los cancelados da **$9,660.83**. La
 * diferencia son exactamente los **$101.00** de los dos que cuelgan de ese corte, o sea que el
 * corte **ya los excluía**. El arqueo firmado no se toca.
 *
 * ⛔ **Borrado SUAVE (`deleted_at`), no `DELETE`.** Dos de los tres tienen `corte_id` apuntando a
 * un corte **cerrado**: un `DELETE` rompería esa referencia y, peor, borraría el rastro de que
 * alguien probó contra producción — que es información de auditoría, no basura. Todo el código
 * filtra por `deleted_at IS NULL`, así que desaparecen de la pantalla sin desaparecer del
 * registro. ⚠️ Se conserva `estado = 'cancelado'`: ya lo estaban, y el borrado no es una
 * cancelación nueva.
 *
 * ── 2. `CI-2026-00017` → `06-002|U-A-5|0000006|0011` ($16,482.23) ────────────────────────────
 *
 * `[CGA-A.31]` lo declaró **irresoluble** hace una hora, y con razón para lo que miraba: tenía
 * **dos candidatos idénticos** —`06-002` (ruta_502) y `06-004` (ruta_504)—, los dos de
 * **$16,482.23** y los dos del 08-oct. Por importe no se distinguen, y la glosa «VENTA 08/10» no
 * nombra ruta.
 *
 * ⭐⭐ **Lo que lo resolvió fue una observación de Edgar: los cuatro movimientos de ese día son
 * UNO POR ALMACÉN, no un agregado.** Cuatro movimientos, cuatro almacenes `06-00X`, el mismo
 * folio de cobro `0000006`, el mismo día:
 *
 *     CI-2026-00016   $29,340.00   ←→  06-001  ruta_501   $29,339.77   −$0.23    ✔ vinculado en A.31
 *     CI-2026-00017   $16,482.00   ←→  06-002  ruta_502   $16,482.23   −$0.23    ← ESTA migración
 *     CI-2026-00018   $24,451.00   ←→  06-003  ruta_503   $24,450.80   −$0.20    ✔ vinculado en A.31
 *     CI-2026-00019   $16,583.00   ←→  06-004  ruta_504   $16,482.23   −$100.77  ⛔ NO se vincula
 *
 * Y el **orden de captura** confirma la correspondencia posicional — Carmen los tecleó almacén por
 * almacén, en el mismo orden que los folios:
 *
 *     CI-2026-00016   created_at 13:22:35
 *     CI-2026-00017   created_at 13:23:38
 *     CI-2026-00018   created_at 13:25:11
 *     CI-2026-00019   created_at 13:25:55
 *
 * ⭐ Así que `CI-00017` → `06-002` se apoya en **tres hechos independientes**: el importe (dentro
 * de 23 centavos, el mismo redondeo al peso que tienen los otros tres), la posición en la
 * secuencia de captura, y que los **dos anclajes de los extremos** (`06-001` y `06-003`) están
 * confirmados por importe único. No es el importe solo — que es justo lo que A.31 declaró
 * insuficiente.
 *
 * ── ⛔⛔ Y por qué `CI-2026-00019` NO entra en esta migración ─────────────────────────────────
 *
 * Por posición y por descarte le toca `06-004`, pero su importe está **$100.77 por encima**
 * ($16,583.00 contra $16,482.23) — **438 veces** el redondeo de sus tres hermanos, que va de
 * $0.20 a $0.23. Un vínculo ahí mete $100.77 en el lugar equivocado y nadie vuelve a mirarlo.
 *
 * ⚠️ **La pregunta es para Carmen, no para la base:** ¿tecleó 16,583 donde iba 16,482, o ese
 * movimiento trae algo más adentro? Hasta que conteste queda declarado con la cifra nombrada, y
 * `06-004|U-A-5|0000006|0011` **sigue libre** esperándolo.
 *
 * ⛔ **No se toca su importe.** Está `en_corte`: corregirlo sería reabrir un arqueo firmado.
 *
 * ── Guardas ─────────────────────────────────────────────────────────────────────────────────
 *
 * El `up` **aborta entero** si: alguno de los 3 de prueba no existe, ya está borrado o **no está
 * cancelado** (un movimiento vivo no se borra por esta vía); si `CI-2026-00017` no existe, no
 * está vivo o ya se vinculó a otra cosa; si el cobro de `06-002` no mide $16,482.23 al centavo en
 * un solo grupo y una sola ruta; o si esa `origen_ref` ya la tomó otro movimiento vivo.
 *
 * Idempotente: todo va con `WHERE ... IS NULL`.
 *
 * ⚠️ **Sólo hace UPDATE: no crea ningún objeto de esquema, así que la compuerta del despliegue la
 *    clasifica NO_MEDIDO y FRENA al equipo hasta que alguien la aplique a mano. Va ANTES de
 *    mergear**, por el camino de k3s de `apply-one-migration-prod.js`.
 *    ⛔ Y ese runbook tiene un defecto: su `jsonpath '{.items[0]}'` eligió el 2026-10-20 un pod
 *    **`Completed` hacía 34 h**. Usar `--field-selector=status.phase=Running`.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';

/** Los 3 de prueba. `monto` se verifica: si cambió, no es el movimiento que medí. */
const PRUEBAS = [
  { folio: 'CG-2026-00003', monto: '20.00' },
  { folio: 'CG-2026-00042', monto: '100.00' },
  { folio: 'CG-2026-00043', monto: '1.00' },
];

const BORRADO = 'CGA-A.36 (2026-10-20): movimiento de PRUEBA contra produccion, borrado suave a pedido de Edgar. Ya estaba cancelado y el corte que lo contiene ya lo excluia de total_gastos, asi que el borrado no mueve ninguna cifra.';

/** El vínculo que resuelve el empate de A.31. */
const CI17 = {
  folio: 'CI-2026-00017',
  ref: '06-002|U-A-5|0000006|0011',
  almacen: '06-002',
  cobroFolio: '0000006',
  docImporte: '16482.23',
  ruta: 'ruta_502',
  nota: 'CGA-A.36 (2026-10-20): RESUELTO el empate que A.31 declaro irresoluble. Los 4 movimientos VENTA 08/10 son UNO POR ALMACEN (06-001..06-004, mismo folio 0000006), no un agregado; el orden de captura (13:22:35 / 13:23:38 / 13:25:11 / 13:25:55) coincide con el orden de los almacenes, y los dos extremos (06-001 y 06-003) estan confirmados por importe unico. Tres hechos independientes, no solo el importe. Documento $16,482.23 contra movimiento $16,482.00: -$0.23, el mismo redondeo al peso de sus tres hermanos.',
};

/** Añade la nota SIN borrar lo que había antes. */
const SQL_NOTA = `
  UPDATE finance.cash_ledger
     SET sin_documento_motivo = CASE
           WHEN sin_documento_motivo IS NULL OR sin_documento_motivo = '' THEN ?
           WHEN position('CGA-A.36' in sin_documento_motivo) > 0 THEN sin_documento_motivo
           ELSE sin_documento_motivo || ' | ' || ?
         END,
         updated_at = now()
   WHERE tenant_id = ? AND folio = ?`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const abortar = (m) => {
    throw new Error(`[CGA-A.36] ${m} -- migracion abortada, no se toco ninguna fila.`);
  };

  // Guarda 1: los 3 de prueba existen, siguen cancelados y con el importe medido.
  for (const p of PRUEBAS) {
    const { rows } = await knex.raw(
      `SELECT monto, estado, deleted_at FROM finance.cash_ledger
        WHERE tenant_id = ? AND folio = ?`, [TENANT, p.folio]);
    if (rows.length !== 1) abortar(`${p.folio}: esperaba 1 fila y hay ${rows.length}`);
    const m = rows[0];
    if (m.deleted_at) continue;                       // ya borrado: idempotente, no es error
    // ⛔ Un movimiento VIVO no se borra por esta via: si dejo de estar cancelado, algo cambio.
    if (m.estado !== 'cancelado') abortar(`${p.folio}: ya no esta cancelado (${m.estado})`);
    if (Math.abs(Number(m.monto) - Number(p.monto)) > 0.001) {
      abortar(`${p.folio}: mide ${m.monto} y se midio ${p.monto}`);
    }
  }

  // Guarda 2: CI-2026-00017 existe, esta vivo y sigue sin vincular.
  {
    const { rows } = await knex.raw(
      `SELECT monto, origen_tipo, origen_ref, estado, deleted_at FROM finance.cash_ledger
        WHERE tenant_id = ? AND folio = ?`, [TENANT, CI17.folio]);
    if (rows.length !== 1) abortar(`${CI17.folio}: esperaba 1 fila y hay ${rows.length}`);
    const m = rows[0];
    if (m.deleted_at) abortar(`${CI17.folio}: esta borrado`);
    if (m.estado === 'cancelado') abortar(`${CI17.folio}: esta cancelado`);
    if (m.origen_tipo !== null && m.origen_ref !== CI17.ref) {
      abortar(`${CI17.folio}: ya esta vinculado a otra cosa (${m.origen_tipo} / ${m.origen_ref})`);
    }
  }

  // ⚠️ Se fija el tenant: route_collections filtra por `current_tenant_id()` y sin esto devuelve
  //    CERO filas SIN ningun error -- la trampa de RLS de este repo.
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);

  // Guarda 3: el cobro de 06-002 existe, en UN grupo, con UNA ruta y el importe al centavo.
  {
    const { rows } = await knex.raw(
      `SELECT sum(importe) AS imp, string_agg(DISTINCT truck, ',') AS trucks
         FROM analytics.route_collections
        WHERE tenant_id = ? AND almacen = ? AND cobro_folio = ? AND cuenta = '0011'
        GROUP BY fecha`, [TENANT, CI17.almacen, CI17.cobroFolio]);
    if (rows.length !== 1) abortar(`${CI17.almacen}/${CI17.cobroFolio}: esperaba 1 grupo y hay ${rows.length}`);
    if (Math.abs(Number(rows[0].imp) - Number(CI17.docImporte)) > 0.001) {
      abortar(`${CI17.almacen}/${CI17.cobroFolio}: mide ${rows[0].imp} y se midio ${CI17.docImporte}`);
    }
    if (rows[0].trucks !== CI17.ruta) {
      abortar(`${CI17.almacen}/${CI17.cobroFolio}: esperaba ${CI17.ruta} y trae ${rows[0].trucks}`);
    }
  }

  // Guarda 4: la ref no esta tomada por otro movimiento vivo (ux_cash_ledger_origen_vivo).
  {
    const { rows } = await knex.raw(
      `SELECT folio FROM finance.cash_ledger
        WHERE tenant_id = ? AND origen_ref = ? AND deleted_at IS NULL AND estado <> 'cancelado'
          AND folio <> ?`, [TENANT, CI17.ref, CI17.folio]);
    if (rows.length) abortar(`${CI17.ref}: ya la usa ${rows[0].folio}`);
  }

  // Escritura 1: borrado suave de los 3 de prueba.
  for (const p of PRUEBAS) {
    await knex.raw(
      `UPDATE finance.cash_ledger SET deleted_at = now(), updated_at = now()
        WHERE tenant_id = ? AND folio = ? AND deleted_at IS NULL`, [TENANT, p.folio]);
    await knex.raw(SQL_NOTA, [BORRADO, BORRADO, TENANT, p.folio]);
  }

  // Escritura 2: el vinculo de CI-2026-00017.
  await knex.raw(
    `UPDATE finance.cash_ledger SET origen_tipo = 'cobro', origen_ref = ?, updated_at = now()
      WHERE tenant_id = ? AND folio = ? AND origen_tipo IS NULL`, [CI17.ref, TENANT, CI17.folio]);
  await knex.raw(SQL_NOTA, [CI17.nota, CI17.nota, TENANT, CI17.folio]);

  // Comprobacion 1: los 3 quedaron fuera de la vista viva del libro.
  const { rows: vivos } = await knex.raw(
    `SELECT folio FROM finance.cash_ledger
      WHERE tenant_id = ? AND folio = ANY(?::text[]) AND deleted_at IS NULL`,
    [TENANT, PRUEBAS.map((p) => p.folio)]);
  if (vivos.length) abortar(`siguen vivos: ${vivos.map((v) => v.folio).join(', ')}`);

  // Comprobacion 2: ningun movimiento vivo queda sin vinculo NI declaracion.
  const { rows: sueltos } = await knex.raw(
    `SELECT folio FROM finance.cash_ledger
      WHERE tenant_id = ? AND deleted_at IS NULL AND estado <> 'cancelado'
        AND origen_tipo IS NULL AND declared_doc_ref IS NULL
        AND (sin_documento_motivo IS NULL OR sin_documento_motivo = '')`, [TENANT]);
  if (sueltos.length) {
    abortar(`quedan ${sueltos.length} sin vinculo ni declaracion: ${sueltos.map((s) => s.folio).join(', ')}`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila mas. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  for (const p of PRUEBAS) {
    await knex.raw(
      `UPDATE finance.cash_ledger SET deleted_at = NULL, updated_at = now()
        WHERE tenant_id = ? AND folio = ? AND deleted_at IS NOT NULL`, [TENANT, p.folio]);
  }
  await knex.raw(
    `UPDATE finance.cash_ledger SET origen_tipo = NULL, origen_ref = NULL, updated_at = now()
      WHERE tenant_id = ? AND folio = ? AND origen_tipo = 'cobro' AND origen_ref = ?`,
    [TENANT, CI17.folio, CI17.ref]);

  // Recorta la nota que agrego el `up`, conserve o no texto previo.
  const folios = PRUEBAS.map((p) => p.folio).concat(CI17.folio);
  await knex.raw(
    `UPDATE finance.cash_ledger
        SET sin_documento_motivo = NULLIF(regexp_replace(sin_documento_motivo,
              '( \\| )?CGA-A\\.36 \\(2026-10-20\\).*$', ''), ''),
            updated_at = now()
      WHERE tenant_id = ? AND folio = ANY(?::text[])
        AND position('CGA-A.36' in COALESCE(sin_documento_motivo, '')) > 0`,
    [TENANT, folios]);
};
