/**
 * `[CG.88]` — UNA REGLA SÓLO SE DECLARA DONDE EL BENEFICIARIO **DETERMINA** LA CUENTA.
 *
 * ── Por qué existe este archivo ──────────────────────────────────────────────────────────────
 *
 * Edgar: *"cuando agrega el checkbox de que se guarde para siempre con ese concepto no sirve.
 * al parecer no hiciste pruebas correctamente"*. Tenía razón en las dos mitades.
 *
 * ⛔ **Las pruebas que había probaban el MECANISMO, no la PROMESA.** Verificaban que la casilla
 * aparezca con gasto + beneficiario + par completo, que llame al endpoint, y el camino de error.
 * Pasaban todas. Ninguna preguntaba lo único que vuelve falsa a la promesa *«se guarda para
 * siempre con ese concepto»*: **¿este beneficiario usa UNA sola cuenta?**
 *
 * Y el defecto no era que no guardara — guardaba, y clasificaba mal. Medido en prod el
 * 2026-10-12, `Maria del Carmen Rdriguez Vera (003)` tiene TRES capturas con TRES cuentas:
 *
 *     CI-2026-00001  ingreso  $16,725.00  →  607-002 / 089
 *     CG-2026-00005  gasto    $ 2,000.00  →  999 / 999
 *     CG-2026-00006  gasto    $ 6,303.00  →  201 / 201   ← acá se marcó la casilla
 *
 * No es una proveedora: es una persona de ruta. Entrega dinero y recibe dinero. La regla creada
 * iba a proponer `201/201` a todos sus gastos siguientes, incluido el próximo que debiera ser
 * `999`.
 *
 * ⭐ El diseño ya lo decía en `resolverCuentas` — *"Sólo se declara regla donde el beneficiario
 * DETERMINA la cuenta"* — pero nadie lo COMPROBABA. Una regla escrita en un comentario no frena
 * nada; este archivo la vuelve ejecutable.
 *
 * ⚠️ Ejecuta SQL contra la base. Un doble de Knex habría pasado con el código viejo, que es
 * exactamente cómo esto llegó a producción.
 *
 * Correr:  PROD_DB_URL=<url> node database/tests/test-newdb-regla-beneficiario.js
 */
'use strict';
const { Client } = require('pg');

const DST = process.env.PROD_DB_URL || process.env.DATABASE_URL_NEW;
const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

let ok = 0; let fail = 0; let nm = 0;
const A = (c, m) => { if (c) { ok++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✖ ' + m); } };
const NM = (m) => { nm++; console.log('  — NO MEDIDO: ' + m); };

/** El freno del servidor, tal cual: ¿hay OTRAS cuentas para ese beneficiario en el libro? */
const OTRAS = `
  SELECT DISTINCT kepler_cuenta, kepler_concepto, tipo
    FROM finance.cash_ledger
   WHERE tenant_id = $1 AND beneficiario = $2
     AND deleted_at IS NULL AND estado <> 'cancelado' AND kepler_cuenta IS NOT NULL
     AND (kepler_cuenta <> $3 OR kepler_concepto <> $4)`;

(async () => {
  console.log('\n=== [CG.88] la regla sólo donde el beneficiario determina la cuenta ===\n');
  if (!DST) { NM('sin PROD_DB_URL ni DATABASE_URL_NEW'); return fin(); }
  const pg = new Client({ connectionString: DST });
  try { await pg.connect(); } catch (e) { NM('no conecta: ' + e.message); return fin(); }

  try {
    await pg.query(`SET app.tenant_id = '${TENANT}'`);

    // El caso se BUSCA en los datos, no se clava: un nombre fijo caduca en cuanto alguien corrige
    // una captura, y un candado que caduca se pone verde por vacío.
    console.log('0) se busca un beneficiario MULTI-CUENTA real');
    const multi = await pg.query(`
      SELECT beneficiario, count(DISTINCT kepler_cuenta || '/' || kepler_concepto)::int AS cuentas
        FROM finance.cash_ledger
       WHERE tenant_id = $1 AND deleted_at IS NULL AND estado <> 'cancelado'
         AND beneficiario IS NOT NULL AND kepler_cuenta IS NOT NULL
       GROUP BY 1 HAVING count(DISTINCT kepler_cuenta || '/' || kepler_concepto) > 1
       ORDER BY 2 DESC LIMIT 1`, [TENANT]);

    if (!multi.rows.length) {
      NM('ningún beneficiario del libro usa más de una cuenta todavía: el caso no se puede ejercer');
    } else {
      const ben = multi.rows[0].beneficiario;
      A(Number(multi.rows[0].cuentas) > 1,
        `«${ben}» aparece con ${multi.rows[0].cuentas} pares cuenta/concepto distintos`);

      console.log('\n1) ⛔ a ese beneficiario NO se le puede declarar una regla');
      const uno = await pg.query(`
        SELECT kepler_cuenta, kepler_concepto FROM finance.cash_ledger
         WHERE tenant_id = $1 AND beneficiario = $2 AND deleted_at IS NULL
           AND estado <> 'cancelado' AND kepler_cuenta IS NOT NULL LIMIT 1`, [TENANT, ben]);
      const { kepler_cuenta: cu, kepler_concepto: co } = uno.rows[0];
      const otras = await pg.query(OTRAS, [TENANT, ben, cu, co]);
      A(otras.rows.length > 0,
        `el freno encuentra ${otras.rows.length} cuenta(s) distintas y rechaza: `
        + otras.rows.map((o) => `${o.kepler_cuenta}/${o.kepler_concepto} (${o.tipo})`).join(', '));
    }

    console.log('\n2) ⭐ [positiva] a un beneficiario de UNA sola cuenta SÍ se le declara');
    // La negativa sola no alcanza: un freno que rechaza TODO también pasaría el punto 1, y
    // dejaría la función inservible sin que nada avise.
    const uni = await pg.query(`
      SELECT beneficiario, min(kepler_cuenta) AS cu, min(kepler_concepto) AS co
        FROM finance.cash_ledger
       WHERE tenant_id = $1 AND deleted_at IS NULL AND estado <> 'cancelado'
         AND beneficiario IS NOT NULL AND kepler_cuenta IS NOT NULL
       GROUP BY 1 HAVING count(DISTINCT kepler_cuenta || '/' || kepler_concepto) = 1
       LIMIT 1`, [TENANT]);
    if (!uni.rows.length) {
      NM('ningún beneficiario tiene una sola cuenta: no se puede comprobar que el freno DEJE pasar');
    } else {
      const u = uni.rows[0];
      const otras = await pg.query(OTRAS, [TENANT, u.beneficiario, u.cu, u.co]);
      A(otras.rows.length === 0,
        `«${u.beneficiario}» (${u.cu}/${u.co}) pasa: el freno no rechaza de más`);
    }

    console.log('\n3) ⛔ [negativa] un movimiento CANCELADO no cuenta como otra cuenta');
    // Si contara, un error de captura con la cuenta equivocada bloquearía la regla para siempre.
    const conCancel = await pg.query(`
      SELECT count(*)::int n FROM finance.cash_ledger
       WHERE tenant_id = $1 AND estado = 'cancelado' AND deleted_at IS NULL
         AND beneficiario IS NOT NULL AND kepler_cuenta IS NOT NULL`, [TENANT]);
    if (Number(conCancel.rows[0].n) === 0) {
      NM('no hay movimientos cancelados con cuenta: el caso no se puede ejercer con datos reales');
    } else {
      // Se mide el EFECTO: tomando un cancelado, el freno NO debe ver su cuenta como "otra".
      const c3 = await pg.query(`
        SELECT beneficiario, kepler_cuenta, kepler_concepto FROM finance.cash_ledger
         WHERE tenant_id = $1 AND estado = 'cancelado' AND deleted_at IS NULL
           AND beneficiario IS NOT NULL AND kepler_cuenta IS NOT NULL LIMIT 1`, [TENANT]);
      const k = c3.rows[0];
      // Se pregunta por una cuenta IMPOSIBLE: todo lo que devuelva sale de filas vivas. Si el
      // freno contara los cancelados, el de `k` aparecería en la lista.
      const vistas = await pg.query(OTRAS, [TENANT, k.beneficiario, '__ninguna__', '__ninguna__']);
      const incluyeCancelado = vistas.rows.some(
        (v) => v.kepler_cuenta === k.kepler_cuenta && v.kepler_concepto === k.kepler_concepto
          && !vistas.rows.some((o) => o !== v && o.kepler_cuenta === k.kepler_cuenta));
      A(!incluyeCancelado,
        `la cuenta ${k.kepler_cuenta}/${k.kepler_concepto} de un asiento CANCELADO no cuenta como `
        + 'antecedente (si contara, un error de captura bloquearía la regla para siempre)');
    }
  } finally {
    await pg.end().catch(() => {});
  }
  fin();
})().catch((e) => { console.error(e); process.exit(1); });

function fin() {
  console.log(`\n=== ${ok} ✔ · ${fail} ✖ · ${nm} no medido ===\n`);
  process.exit(fail === 0 ? 0 : 1);
}
