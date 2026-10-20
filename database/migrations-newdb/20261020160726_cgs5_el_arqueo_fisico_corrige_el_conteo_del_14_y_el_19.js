'use strict';
/**
 * ⭐⭐ `[CGS.5]` — **El arqueo físico corrige el conteo sellado: 14-oct y 19-oct.**
 *
 * Edgar, 2026-10-20: *«los arqueos que se registraron desde el 12 hasta hoy se migran al corte de
 * ese día; cambiemos el resultado del corte»*. El conteo que manda es el **arqueo físico** que se
 * capturó en el Access `Control` — ahí se contó el cajón de verdad; en la Suite se tecleó.
 *
 * Requiere `[CGS.4]`, que es la que construyó la puerta. Sin ella la guardia rechaza esto.
 *
 * ── Qué se corrige, medido contra prod el 2026-10-20 ────────────────────────────────────────
 *
 *     dia      corte           contado Suite    arqueo Control        cambio
 *     14-oct   CC-2026-00003      24,960.00     A23648  14,128.50    −10,831.50
 *     19-oct   CC-2026-00007      88,272.50     A23677  87,772.50       −500.00
 *
 * Las dos rejas cierran **exacto** contra el total de Control, sin morralla y sin ninguna pieza
 * que la Suite no sepa capturar — verificado pieza por pieza antes de escribir esto. Es lo que
 * el trigger `cut_desglose_cuadra_chk` va a exigir al hacer commit, y por eso se verifica acá
 * también: una migración que descubre el problema en el COMMIT ya hizo la mitad del trabajo mal.
 *
 * ── ⛔ Los cuatro días que NO se tocan, cada uno con su razón ───────────────────────────────
 *
 * · **12-oct y 13-oct** — Control **no arqueó** esos días. No hay con qué corregir.
 * · **16-oct y 17-oct** — los dos conteos ya coinciden **al centavo** ($32,198.50 y $618.50).
 * · **15-oct** — ⛔ **es una trampa, y por eso queda FUERA por decisión explícita de Edgar.** El
 *   arqueo del 15-oct de Control **es el conteo del 13-oct de la Suite**: 9 de 11 denominaciones
 *   idénticas pieza por pieza, y las 2 que difieren son el mismo dinero partido distinto
 *   (Control `1×$1,000 + 79×$500`, Suite `81×$500`, los dos $40,500). **Placebo:** los pares de
 *   días vecinos comparten **0** denominaciones, así que el método discrimina en vez de emparejar
 *   todo con todo. Copiarlo dejaría el mismo conteo registrado en dos días.
 * · **20-oct** — la Suite todavía no tiene corte de hoy; no hay nada que corregir.
 *
 * ⚠️ **Y queda un hallazgo abierto con nombre:** el conteo del 15-oct de la Suite parece el del
 * 14-oct **tecleado un renglón más abajo** — 3 de sus 5 cantidades reaparecen en la denominación
 * siguiente (`200×77 → 100×77`, `100×68 → 50×68`). Sobre los 42 pares posibles la mediana es 0 %
 * y sólo 2 pares llegan a dos coincidencias, así que no es casualidad; con 3 de 5 **tampoco está
 * probado**, y se declara en vez de corregirse a ojo.
 *
 * ── Lo que esto NO cambia ───────────────────────────────────────────────────────────────────
 *
 * **El `esperado` no se toca.** Viene del libro, no del conteo, y corregir el conteo no cambia lo
 * que el libro dice que debería haber. La guardia de `[CGS.4]` lo impide explícitamente.
 *
 * ⚠️ Efecto declarado: la diferencia de los dos días **crece**, no se achica.
 *
 *     14-oct   −62,821.66  →  −73,653.16
 *     19-oct  −208,594.59  →  −209,094.59
 *
 * Eso **no es un retroceso**: el conteo pasa a ser el real y el descuadre deja de estar tapado
 * por una cifra tecleada de más. Lo que hay que arreglar sigue siendo el `esperado` (ver el
 * depósito al banco que nunca se registra), y ahora se mide contra el conteo que de verdad hubo.
 *
 * ⚠️ **`corrected_by` va en `NULL` a propósito.** Esta corrección no la hizo una persona: la hizo
 * esta migración, con su motivo nombrando el folio del arqueo. Ponerle el nombre de alguien que
 * no la hizo sería fabricar un registro de auditoría — exactamente lo contrario de para qué
 * existe el rastro.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SUCURSAL = '00';

/**
 * La reja de Control → la de la Suite. Verificado contra prod: para estos dos días Control no usó
 * ninguna pieza sin par (ni moneda de $100 ni centavos de 20/10/5), así que la morralla queda en
 * cero y no hay que repartir nada a ojo. Si algún día la hubiera, la guarda de abajo frena.
 */
const MAPA = [
  ['b1000', '1000', 1000], ['b500', '500', 500], ['b200', '200', 200], ['b100', '100', 100],
  ['b50', '50', 50], ['b20', '20', 20],
  ['m100', null, 100], ['m20', '20m', 20], ['m10', '10', 10], ['m5', '5', 5],
  ['m2', '2', 2], ['m1', '1', 1], ['m50c', '0.5', 0.5],
  ['m20c', null, 0.2], ['m10c', null, 0.1], ['m5c', null, 0.05], ['centavos', null, 0.01],
];

/** Lo medido. Se escribe acá para que la migración COMPRUEBE lo que espera, no lo descubra. */
const ESPERADO = [
  { dia: '2026-10-14', folio: 'CC-2026-00003', arqueo: 'A23648', antes: 24960.00, despues: 14128.50 },
  { dia: '2026-10-19', folio: 'CC-2026-00007', arqueo: 'A23677', antes: 88272.50, despues: 87772.50 },
];

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '10s'`);

  const abortar = (m) => { throw new Error(`[CGS.5] ${m} -- migracion abortada, sin tocar ninguna fila.`); };

  // ── Guarda 0: la puerta de `[CGS.4]` tiene que estar puesta.
  const { rows: g } = await knex.raw(`SELECT pg_get_functiondef('finance.cash_cut_guardia'::regproc) AS src`);
  if (!String(g[0]?.src ?? '').includes('cut_correccion_alcance_chk')) {
    abortar('falta [CGS.4]: la guardia todavia congela los cortes cerrados sin excepcion');
  }

  for (const plan of ESPERADO) {
    const { rows: cr } = await knex.raw(
      `SELECT id, folio, estado, contado, morralla, esperado, diferencia, conteo_previo, updated_at
         FROM finance.cash_ledger_cuts
        WHERE tenant_id = ? AND sucursal = ? AND fecha = ?::date`,
      [TENANT, SUCURSAL, plan.dia]);
    if (cr.length !== 1) abortar(`el ${plan.dia} tiene ${cr.length} cortes, se esperaba 1`);
    const c = cr[0];

    // Idempotencia: si ya se corrigió, no se vuelve a hacer (y NO se apila otro conteo_previo).
    if (c.conteo_previo != null) {
      // eslint-disable-next-line no-console
      console.log(`  ↷ [CGS.5] ${c.folio} ya tiene conteo previo guardado: se deja como está.`);
      continue;
    }
    if (c.folio !== plan.folio) abortar(`el ${plan.dia} es ${c.folio}, se midió ${plan.folio}`);
    if (r2(c.contado) !== plan.antes) {
      abortar(`${c.folio} tiene contado ${c.contado}, se midió ${plan.antes}: alguien lo cambió, parar`);
    }

    // ── El arqueo físico de ese día.
    const { rows: kr } = await knex.raw(
      `SELECT * FROM analytics.v_caja_control_cortes WHERE tiene_corte AND fecha = ?::date`, [plan.dia]);
    if (kr.length !== 1) abortar(`Control tiene ${kr.length} arqueos de cierre el ${plan.dia}, se esperaba 1`);
    const k = kr[0];
    if (String(k.corte_folio) !== plan.arqueo) abortar(`el arqueo del ${plan.dia} es ${k.corte_folio}, se midió ${plan.arqueo}`);
    if (k.corte_cuadra_ticket !== true) abortar(`el arqueo ${plan.arqueo} no cuadra consigo mismo: no sirve de fuente`);
    if (r2(k.total_efectivo) !== plan.despues) {
      abortar(`${plan.arqueo} dice ${k.total_efectivo}, se midió ${plan.despues}`);
    }

    // ── Armar la reja nueva, y comprobar que cierra ANTES de escribir.
    const filas = [];
    let suma = 0, sinPar = 0;
    for (const [col, llave, valor] of MAPA) {
      const piezas = Number(k[col] ?? 0);
      if (!piezas) continue;
      if (!llave) { sinPar += valor * piezas; continue; }
      filas.push({ denom_key: llave, denominacion: valor, piezas });
      suma += valor * piezas;
    }
    if (sinPar !== 0) {
      abortar(`${plan.arqueo} trae ${r2(sinPar)} en piezas que la reja de la Suite no tiene (moneda de $100 o centavos): repartirlas a mano seria inventar un conteo`);
    }
    if (r2(suma) !== plan.despues) {
      abortar(`la reja de ${plan.arqueo} suma ${r2(suma)} y su total dice ${plan.despues}`);
    }

    // ── El conteo que se reemplaza, guardado ENTERO antes de pisarlo.
    const { rows: previas } = await knex.raw(
      `SELECT denom_key, denominacion, piezas FROM finance.cash_ledger_cut_denominations
        WHERE tenant_id = ? AND cut_id = ? AND momento = 'cierre' ORDER BY denominacion DESC`,
      [TENANT, c.id]);
    const conteoPrevio = {
      denominaciones: previas,
      morralla: Number(c.morralla ?? 0),
      contado: Number(c.contado),
      sellado_at: c.updated_at,
      // ⚠️ Quién, no: esto no lo corrigió una persona. Lo dice el motivo.
      corregido_por: '[CGS.5] migracion',
    };
    const motivo = `El arqueo fisico ${plan.arqueo} de Control (${plan.dia}) conto ${plan.despues}; `
      + `el conteo tecleado en la Suite decia ${plan.antes}. Manda el arqueo fisico.`;

    const nuevaDif = r2(Number(k.total_efectivo) - Number(c.esperado));

    // ── La escritura. El desglose y el total van en la MISMA transaccion: el trigger
    //    `cut_desglose_cuadra_chk` es DEFERRABLE y comprueba la suma al hacer commit.
    await knex.raw(
      `UPDATE finance.cash_ledger_cuts
          SET contado = ?, diferencia = ?, morralla = 0,
              conteo_previo = ?::jsonb, reconteo_motivo = ?,
              corrected_by = NULL, corrected_at = now(), updated_at = now()
        WHERE tenant_id = ? AND id = ?`,
      [plan.despues, nuevaDif, JSON.stringify(conteoPrevio), motivo, TENANT, c.id]);

    await knex.raw(
      `DELETE FROM finance.cash_ledger_cut_denominations
        WHERE tenant_id = ? AND cut_id = ? AND momento = 'cierre'`, [TENANT, c.id]);
    for (const f of filas) {
      await knex.raw(
        `INSERT INTO finance.cash_ledger_cut_denominations
           (tenant_id, cut_id, momento, denom_key, denominacion, piezas)
         VALUES (?, ?, 'cierre', ?, ?, ?)`,
        [TENANT, c.id, f.denom_key, f.denominacion, f.piezas]);
    }

    // eslint-disable-next-line no-console
    console.log(`  ✅ [CGS.5] ${c.folio} (${plan.dia}): ${plan.antes} -> ${plan.despues}`
      + ` segun ${plan.arqueo} · ${filas.length} denominacion(es) · diferencia ${c.diferencia} -> ${nuevaDif}`);
  }

  // ── Comprobación final, dentro de la misma transacción.
  for (const plan of ESPERADO) {
    const { rows } = await knex.raw(
      `SELECT c.contado, c.conteo_previo IS NOT NULL AS tiene_previo,
              (SELECT coalesce(sum(d.denominacion * d.piezas),0)
                 FROM finance.cash_ledger_cut_denominations d
                WHERE d.tenant_id = c.tenant_id AND d.cut_id = c.id AND d.momento='cierre') AS suma
         FROM finance.cash_ledger_cuts c
        WHERE c.tenant_id = ? AND c.sucursal = ? AND c.fecha = ?::date`,
      [TENANT, SUCURSAL, plan.dia]);
    const f = rows[0];
    if (r2(f.contado) !== plan.despues) abortar(`${plan.dia} quedo en ${f.contado}, se esperaba ${plan.despues}`);
    if (!f.tiene_previo) abortar(`${plan.dia} quedo sin conteo previo: el rastro es la mitad del punto`);
    if (r2(f.suma) !== plan.despues) abortar(`${plan.dia}: la reja suma ${f.suma} y el contado dice ${plan.despues}`);
  }

  // eslint-disable-next-line no-console
  console.log('  ⚠️ [CGS.5] 15-oct NO se toco: su arqueo de Control es el conteo del 13-oct de la Suite'
    + ' (9 de 11 denominaciones identicas). Queda como hallazgo abierto.');
};

/**
 * Devuelve los dos cortes a su conteo anterior, desde el `conteo_previo` que esta misma migración
 * guardó. Es reversible **porque** se guardó: ese es el punto del rastro.
 *
 * ⛔ **Y la reversión es, ella misma, una corrección.** El primer `down` que escribí ponía
 * `conteo_previo = NULL` al restaurar — y la guardia de `[CGS.4]` lo habría **rechazado**, porque
 * cambiar el conteo de un corte cerrado exige conservar el que se reemplaza. El candado funcionó
 * contra su propio autor antes de llegar a producción, que es exactamente para lo que está.
 *
 * Así que el `down` guarda como `conteo_previo` el conteo CORREGIDO (el que está saliendo) y deja
 * su motivo. Volver atrás no borra el rastro: lo alarga.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '10s'`);
  for (const plan of ESPERADO) {
    const { rows } = await knex.raw(
      `SELECT id, contado, morralla, esperado, updated_at, conteo_previo
         FROM finance.cash_ledger_cuts
        WHERE tenant_id = ? AND sucursal = ? AND fecha = ?::date AND conteo_previo IS NOT NULL`,
      [TENANT, SUCURSAL, plan.dia]);
    if (!rows.length) continue;
    const c = rows[0];
    const prev = typeof c.conteo_previo === 'string' ? JSON.parse(c.conteo_previo) : c.conteo_previo;
    if (!prev || prev.contado == null) continue;

    const dif = r2(Number(prev.contado) - Number(c.esperado));

    // Lo que sale: el conteo corregido. Se conserva, o la guardia rechaza el UPDATE — y con razón.
    const { rows: actuales } = await knex.raw(
      `SELECT denom_key, denominacion, piezas FROM finance.cash_ledger_cut_denominations
        WHERE tenant_id = ? AND cut_id = ? AND momento = 'cierre' ORDER BY denominacion DESC`,
      [TENANT, c.id]);
    const constancia = {
      denominaciones: actuales, morralla: Number(c.morralla ?? 0),
      contado: Number(c.contado), sellado_at: c.updated_at,
      corregido_por: '[CGS.5] down · reversion',
    };
    const motivo = `Reversion de [CGS.5]: se devuelve el conteo tecleado en la Suite (${prev.contado}) `
      + `y sale el del arqueo ${plan.arqueo} (${c.contado}).`;

    await knex.raw(
      `UPDATE finance.cash_ledger_cuts
          SET contado = ?, morralla = ?, diferencia = ?,
              conteo_previo = ?::jsonb, reconteo_motivo = ?,
              corrected_by = NULL, corrected_at = now(), updated_at = now()
        WHERE tenant_id = ? AND id = ?`,
      [prev.contado, prev.morralla ?? 0, dif, JSON.stringify(constancia), motivo, TENANT, c.id]);

    await knex.raw(
      `DELETE FROM finance.cash_ledger_cut_denominations
        WHERE tenant_id = ? AND cut_id = ? AND momento = 'cierre'`, [TENANT, c.id]);
    for (const d of prev.denominaciones ?? []) {
      await knex.raw(
        `INSERT INTO finance.cash_ledger_cut_denominations
           (tenant_id, cut_id, momento, denom_key, denominacion, piezas)
         VALUES (?, ?, 'cierre', ?, ?, ?)`,
        [TENANT, c.id, d.denom_key, d.denominacion, d.piezas]);
    }
  }
};
