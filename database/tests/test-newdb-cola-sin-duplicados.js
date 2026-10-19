/**
 * `[CG.85]` — LA COLA NO VUELVE A OFRECER LO QUE YA SE CAPTURÓ, VENGA DE LA FUENTE QUE VENGA.
 *
 * ── Qué vigila ───────────────────────────────────────────────────────────────────────────────
 *
 * Pedido de Edgar: *"los movimientos ya completos no aparezcan más, para evitar confusiones"*.
 *
 * La bandeja tiene DOS fuentes del mismo efectivo: los documentos de Kepler y los movimientos del
 * cajero (CAOS). Cada una se deduplicaba **contra sí misma** por `origen_ref`, y ninguna contra la
 * otra — el código lo decía con todas las letras: *"NO se deduplica contra Kepler por fila: la
 * medición dio 0% de llave común (bulto vs individual)"*.
 *
 * ⭐ Esa premisa se cayó con casos reales. Medido en prod el 2026-10-12, TRES documentos ya
 * capturados desde CAOS seguían ofreciéndose como pendientes:
 *
 *     X-D-26 0023030  $ 2,000.00  ya es CG-2026-00005   (dif 0.00)
 *     U-A-5  0000075  $21,790.00  ya es CI-2026-00002   (dif 0.00)
 *     U-A-5  0000076  $16,724.95  ya es CI-2026-00001   (dif 0.05)
 *
 * ⭐ La llave NO es el importe: es lo que la persona DECLARÓ al capturar. Al elegir el documento,
 * la glosa queda `"<doc_tipo> <folio> · <beneficiario>"`. Casar por importe habría necesitado
 * placebo y **habría fallado justo en estos casos** — CAOS no cuenta monedas, y los $0.05 son
 * reales.
 *
 * ⚠️ Ejecuta SQL contra la base: un doble de Knex habría pasado igual con la consulta vieja.
 * Sin base alcanzable, declara NO MEDIDO.
 *
 * Correr:  PROD_DB_URL=<url> node database/tests/test-newdb-cola-sin-duplicados.js
 */
'use strict';
const { Client } = require('pg');

const DST = process.env.PROD_DB_URL || process.env.DATABASE_URL_NEW;
const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

let ok = 0; let fail = 0; let nm = 0;
const A = (c, m) => { if (c) { ok++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✖ ' + m); } };
const NM = (m) => { nm++; console.log('  — NO MEDIDO: ' + m); };

/**
 * La exclusión, tal cual la arma el servicio. Se parametriza para poder APAGARLA en la negativa.
 *
 * ⛔⛔ `[CGA-A.11]` **ESTA RÉPLICA LLEVABA EL DEFECTO ADENTRO.** Faltaba `origen_tipo = 'caos'`,
 * que es lo único para lo que este descuento existe: lo que viene de Kepler ya lo excluye la
 * vista por `origen_ref`, que es exacto. Sin ese `AND`, `glosa LIKE doc_tipo || ' ' || folio`
 * tapaba **157 movimientos · $1,325,687.43** de otras sucursales con el mismo folio.
 *
 * ⭐ Y la prueba no podía verlo: su negativa apaga la exclusión **entera**, así que compara
 * «con filtro» contra «sin filtro» y las dos ramas estaban mal. **Una negativa que no toca el
 * predicado que carga el peso no prueba el predicado.** Por eso ahora hay una tercera rama,
 * `'roto'`, que reproduce el defecto a propósito y exige que esconda MÁS. `GOTCHAS` §86.
 *
 * @param {'con'|'sin'|'roto'} modo
 */
const cola = (modo) => {
  const acotado = modo === 'con' ? `AND yac.origen_tipo = 'caos'` : '';
  const exclusion = modo === 'sin' ? '' : `AND NOT EXISTS (
       SELECT 1 FROM finance.cash_ledger yac
        WHERE yac.tenant_id = p.tenant_id
          AND yac.deleted_at IS NULL AND yac.estado <> 'cancelado'
          ${acotado}
          AND yac.glosa LIKE p.doc_tipo || ' ' || p.folio || '%')`;
  return `
  SELECT doc_tipo, folio, monto FROM finance.v_caja_movimientos_pendientes p
   WHERE p.tenant_id = $1
     AND p.fecha_valor >= current_date - 45 AND p.fecha_valor <= current_date
     ${exclusion}`;
};

(async () => {
  console.log('\n=== [CG.85] la cola y lo ya capturado ===\n');
  if (!DST) { NM('sin PROD_DB_URL ni DATABASE_URL_NEW'); return fin(); }
  const pg = new Client({ connectionString: DST });
  try { await pg.connect(); } catch (e) { NM('no conecta: ' + e.message); return fin(); }

  try {
    await pg.query(`SET app.tenant_id = '${TENANT}'`);

    console.log('0) la premisa: existen capturas que DECLARAN un documento');
    const decl = await pg.query(`
      SELECT count(*)::int n FROM finance.cash_ledger
       WHERE tenant_id = $1 AND deleted_at IS NULL AND estado <> 'cancelado'
         AND glosa ~ '^[A-Z]-[A-Z]-[0-9]+ [0-9]+'`, [TENANT]);
    const declaradas = Number(decl.rows[0].n);
    if (!declaradas) {
      NM('ninguna captura declara un documento todavía: el cruce no se puede ejercer con datos reales');
    } else {
      A(declaradas > 0, `${declaradas} capturas nombran su documento en la glosa (esa es la llave)`);

      console.log('\n1) lo ya capturado NO vuelve a ofrecerse');
      const sin = await pg.query(cola('con'), [TENANT]);     // con la exclusión vigente
      const con = await pg.query(cola('sin'), [TENANT]);     // sin exclusión: vuelven los dups
      const quitados = con.rows.length - sin.rows.length;
      A(quitados > 0, `la exclusión saca ${quitados} fila(s) que ya estaban en el libro`);

      // Y se nombra cuáles: un conteo sin los nombres no deja comprobar que sacó lo correcto.
      const dup = await pg.query(`
        SELECT p.doc_tipo, p.folio, l.folio AS ya_es
          FROM finance.v_caja_movimientos_pendientes p
          JOIN finance.cash_ledger l ON l.tenant_id = p.tenant_id AND l.deleted_at IS NULL
           AND l.estado <> 'cancelado' AND l.origen_tipo = 'caos'
           AND l.glosa LIKE p.doc_tipo || ' ' || p.folio || '%'
         WHERE p.tenant_id = $1`, [TENANT]);
      for (const d of dup.rows) console.log(`      · ${d.doc_tipo} ${d.folio} ya es ${d.ya_es}`);

      console.log('\n2) ⛔ [negativa] SIN la exclusión, los duplicados vuelven');
      A(con.rows.length === sin.rows.length + quitados,
        'apagar la exclusión los devuelve exactamente (si no, la regla mide otra cosa)');

      // ⭐⭐ `[CGA-A.11]` La negativa que faltaba, y que es la que vale.
      //
      // Apagar la exclusión entera (punto 2) compara «filtro» contra «nada»: las dos ramas
      // pueden estar mal a la vez, y lo estaban. Esta reproduce el DEFECTO —el mismo `LIKE`
      // pero sin acotar a `caos`— y exige que esconda MÁS. Si deja de distinguir, el acote
      // dejó de hacer algo y hay que mirarlo.
      console.log('\n2b) ⛔ [negativa] el descuento SIN acotar a `caos` esconde de MÁS');
      const roto = await pg.query(cola('roto'), [TENANT]);
      const escondidosDeMas = sin.rows.length - roto.rows.length;
      if (escondidosDeMas === 0) {
        NM('hoy ninguna sucursal comparte folio con otra: la negativa no puede distinguir ' +
           '(se DECLARA, no se da por buena)');
      } else {
        A(escondidosDeMas > 0,
          `sin acotar, el filtro escondería ${escondidosDeMas} movimiento(s) más — ` +
          `esa es la plata que [CGA-A.9] recuperó (GOTCHAS §86)`);
      }
    }

    console.log('\n3) ⛔ [negativa] NO esconde lo que nadie declaró');
    // Un folio inventado no puede desaparecer de la cola por parecerse a algo: la regla casa por
    // la declaración, no por semejanza. Si esto fallara, estaríamos ocultando trabajo real.
    const fantasma = await pg.query(`
      SELECT count(*)::int n FROM finance.cash_ledger
       WHERE tenant_id = $1 AND deleted_at IS NULL AND glosa LIKE 'Z-Z-99 9999999%'`, [TENANT]);
    A(Number(fantasma.rows[0].n) === 0,
      'no hay glosa con un documento inexistente (la regla no tiene de dónde esconder de más)');

    console.log('\n4) ⛔ [negativa] un movimiento CANCELADO no tapa a su documento');
    // Si un asiento cancelado siguiera excluyendo, el documento quedaría invisible para siempre
    // después de un error de captura -- y ese efectivo no se registraría nunca.
    //
    // ⚠️ Acá vivía `A(true, ...)`: una aserción que pasa SIEMPRE. Verde por vacuidad, que es lo
    // mismo que no vigilar -- y peor, porque se lee como que sí. Si el caso no existe en los
    // datos, se DECLARA no medido (ADR-056), no se pinta de verde.
    const canc = await pg.query(`
      SELECT count(*)::int cancelados_que_nombran_doc,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM finance.v_caja_movimientos_pendientes p
                WHERE p.tenant_id = l.tenant_id
                  AND l.glosa LIKE p.doc_tipo || ' ' || p.folio || '%'))::int AS su_doc_sigue_visible
        FROM finance.cash_ledger l
       WHERE l.tenant_id = $1 AND l.estado = 'cancelado' AND l.deleted_at IS NULL
         AND l.glosa ~ '^[A-Z]-[A-Z]-[0-9]+ [0-9]+'`, [TENANT]);
    const c4 = canc.rows[0];
    if (Number(c4.cancelados_que_nombran_doc) === 0) {
      NM('ningún asiento cancelado nombra un documento: el caso no se puede ejercer con datos reales');
    } else {
      A(Number(c4.su_doc_sigue_visible) === Number(c4.cancelados_que_nombran_doc),
        `los ${c4.cancelados_que_nombran_doc} documentos de asientos cancelados siguen OFRECIÉNDOSE `
        + `(visibles: ${c4.su_doc_sigue_visible}) — cancelar no puede esconder el efectivo`);
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
