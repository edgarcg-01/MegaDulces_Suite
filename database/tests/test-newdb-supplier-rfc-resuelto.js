/* eslint-disable no-console */
/**
 * [PGP.27] Candado del RFC del acreedor resuelto — `analytics.v_supplier_rfc` y lo que de ella
 * cuelga en el Calendario de Pagos (`analytics.v_payable_evidence`).
 *
 * ── QUÉ PASÓ ────────────────────────────────────────────────────────────────────────────────
 * El motor de evidencia sacaba el RFC del acreedor de UN solo lugar, `kepler_ods.kdxd.c10`, y
 * todo lo que no estuviera ahí quedaba sin factura con el rótulo *«el proveedor no tiene RFC
 * capturado en Kepler»*. Medido en prod el 2026-10-28: **1,000 documentos ($29,067,071) sin
 * RFC** y —lo que no se veía— **368 documentos ($20,232,802, 14 acreedores) CON un RFC mal
 * escrito**: `BALO20930EL9` por `BAL020930EL9` (letra O por cero, $14,281,642 de deuda),
 * `CAMR-590304-B` con guiones y truncado, `DGR0531773A` con un dígito de menos. Un RFC mal
 * formado no cruza con ningún CFDI: es indistinguible de no tenerlo, y se leía como si lo
 * tuviera.
 *
 * ── LO QUE SE VERIFICA ──────────────────────────────────────────────────────────────────────
 *  1. La vista existe. Si no está, NO MEDIDO — un candado que no encuentra su objeto no se pone
 *     verde (ADR-056).
 *  2. INVARIANTE de procedencia: `fuente` particiona. `kepler` ⇒ el RFC es el de Kepler y pasa
 *     la forma del SAT; `nombre` ⇒ el de Kepler NO sirve; `ninguna` ⇒ `rfc` es NULL.
 *  3. ⭐ INVARIANTE que es el corazón del cambio: **ningún RFC publicado está mal formado.**
 *     Antes del cambio, 188 acreedores lo estaban. Si esto falla, la pantalla volvió a publicar
 *     un RFC con el que no se puede cruzar nada.
 *  4. ADR-056: `fuente='ninguna'` SIEMPRE trae `motivo`. Nunca un hueco mudo.
 *  5. PRUEBA NEGATIVA del verificador de forma: tiene que marcar los valores que de verdad
 *     fallaron y NO marcar los correctos. Sin esto, un verificador que dijera «todo bien» se
 *     vería igual de verde.
 *  6. PRUEBA NEGATIVA del normalizador: tiene que empatar `GAMAHUBIN SA DE CV` con `GAMAHUBIN`
 *     y NO empatar dos razones sociales distintas. El cruce anterior comparaba 14 caracteres y
 *     perdía exactamente ese caso.
 *  7. El trabajo existe: tiene que haber acreedores resueltos por nombre. Si son cero, todo lo
 *     de arriba está sin ejercitar y se DECLARA — cero por defecto es indistinguible de cero
 *     por desuso.
 *  8. `v_payable_evidence` nunca publica evidencia por debajo del umbral 3, y declara la
 *     procedencia del RFC en cada fila.
 *
 * Read-only: no escribe ni una fila.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);

let pass = 0, fail = 0, nm = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function noMedido(msg) { nm++; console.log('  ⊘ NO MEDIDO:', msg); }

/** La misma forma que usa la vista. Si las dos se separan, este candado deja de medirla. */
const FORMA = `'^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$'`;

(async () => {
  try {
    const [{ existe }] = (await knex.raw(
      `SELECT count(*)::int AS existe FROM pg_views WHERE schemaname='analytics' AND viewname='v_supplier_rfc'`,
    )).rows;
    if (!existe) {
      noMedido('analytics.v_supplier_rfc no existe en esta base: falta aplicar la migracion 20261028085707. El bloque entero queda sin medir.');
      console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} ⊘\n`);
      await knex.destroy();
      process.exit(1);
    }
    ok(true, 'analytics.v_supplier_rfc existe');

    // ── 2, 3 y 4: los invariantes de la vista ────────────────────────────────────────────────
    const [inv] = (await knex.raw(`
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE fuente NOT IN ('kepler','nombre','ninguna'))::int AS fuente_rara,
             count(*) FILTER (WHERE fuente='kepler'  AND rfc IS DISTINCT FROM rfc_crudo)::int AS kepler_no_es_kepler,
             count(*) FILTER (WHERE fuente='ninguna' AND rfc IS NOT NULL)::int AS ninguna_con_rfc,
             count(*) FILTER (WHERE fuente='ninguna' AND motivo IS NULL)::int AS mudos,
             count(*) FILTER (WHERE fuente='nombre'  AND upper(rfc_crudo) ~ ${FORMA})::int AS nombre_pisa_kepler,
             count(*) FILTER (WHERE rfc IS NOT NULL AND NOT (upper(rfc) ~ ${FORMA}))::int AS publicado_mal_formado,
             count(*) FILTER (WHERE fuente='nombre')::int AS por_nombre,
             count(*) FILTER (WHERE rfc_kepler_mal_formado)::int AS kepler_mal
        FROM analytics.v_supplier_rfc`)).rows;

    ok(inv.fuente_rara === 0, `fuente solo toma los tres valores declarados (${inv.n} acreedores)`);
    ok(inv.kepler_no_es_kepler === 0, "fuente='kepler' siempre publica el RFC literal de Kepler");
    ok(inv.ninguna_con_rfc === 0, "fuente='ninguna' nunca publica un RFC");
    ok(inv.mudos === 0, "fuente='ninguna' SIEMPRE dice por que (ADR-056)");
    ok(inv.nombre_pisa_kepler === 0, 'el nombre NUNCA pisa un RFC de Kepler bien formado: Kepler manda cuando sirve');
    // ⭐ El invariante que justifica todo el cambio.
    ok(inv.publicado_mal_formado === 0,
      `ningun RFC publicado esta mal formado (Kepler trae ${inv.kepler_mal} que si lo estan, y quedan fuera)`);

    // ── 5: prueba negativa del verificador de forma ──────────────────────────────────────────
    const forma = (await knex.raw(`
      SELECT v, (upper(btrim(v)) ~ ${FORMA}) AS ok FROM (VALUES
        ('BAL020930EL9'), ('BALO20930EL9'), ('CAMR590304BVA'), ('CAMR-590304-B'),
        ('DGR05031773A'), ('DGR0531773A'), ('AAOJ620521PJ1'), ('AA0J620521PJ1')) t(v)`)).rows;
    const ESPERA = {
      BAL020930EL9: true, BALO20930EL9: false, CAMR590304BVA: true, 'CAMR-590304-B': false,
      DGR05031773A: true, DGR0531773A: false, AAOJ620521PJ1: true, AA0J620521PJ1: false,
    };
    const aciertos = forma.filter((r) => r.ok === ESPERA[r.v]).length;
    const rechaza = forma.filter((r) => !r.ok).length;
    ok(aciertos === forma.length, `el verificador de forma acierta los 8 casos reales (${aciertos}/${forma.length})`);
    // CONTROL POSITIVO: un verificador que rechazara TODO tambien acertaria los 4 malos.
    ok(rechaza === 4, `y rechaza exactamente los 4 que estan mal, no todo (rechazo ${rechaza})`);

    // ── 6: prueba negativa del normalizador ──────────────────────────────────────────────────
    const SUF = ['S A DE C V', 'SA DE CV', 'S DE R L DE C V', 'S DE RL DE CV', 'SA DE C V',
      'S A DE CV', 'SAPI DE CV', 'S A P I DE C V', 'SPR DE RL DE CV', 'SPR DE RL', 'S P R DE R L',
      'SC DE RL DE CV', 'S EN C', 'SRL DE CV', 'SRL', 'SA', 'SC', 'SAS', 'SOFOM ENR', 'SOFOM',
      'Y CIA', 'Y COMPANIAS', 'Y COMPANIA', 'EN N C DE CV', 'EN NC DE CV', 'INC'].join('|');
    const N = (c) => `nullif(regexp_replace(btrim(regexp_replace(
        upper(translate(coalesce(${c},''),'ÁÉÍÓÚÜÑÀÈÌÒÙÂÊÎÔÛáéíóúüñàèìòùâêîôû','AEIOUUNAEIOUAEIOUaeiouunaeiouaeiou')),
        '[^A-Za-z0-9]+',' ','g')),'( (${SUF}))+$','','g'),'')`;
    const nm2 = (await knex.raw(`
      SELECT a, b, (${N('a')} = ${N('b')}) AS empatan FROM (VALUES
        ('GAMAHUBIN SA DE CV','GAMAHUBIN'),
        ('Comercializadora Peñafiel, S. de R.L. de C.V.','COMERCIALIZADORA PENAFIEL'),
        ('EFFEM MEXICO INC. Y COMPANIAS EN N.C DE CV','EFFEM MEXICO'),
        ('BOTANAS Y DERIVADOS SA DE CV','BOTANAS Y DULCES SA DE CV'),
        ('DISTRIBUIDORA DEL NORTE','DISTRIBUIDORA DEL SUR')) t(a,b)`)).rows;
    const debenEmpatar = nm2.slice(0, 3).every((r) => r.empatan === true);
    const noDebenEmpatar = nm2.slice(3).every((r) => r.empatan === false);
    ok(debenEmpatar, 'el normalizador empata la misma razon social escrita distinto (GAMAHUBIN SA DE CV = GAMAHUBIN)');
    // ⛔ Sin esto, un normalizador que devolviera siempre lo mismo empataria todo y daria verde.
    ok(noDebenEmpatar, 'y NO empata dos razones sociales distintas');

    // ── 7: el trabajo existe ─────────────────────────────────────────────────────────────────
    if (inv.por_nombre > 0) {
      ok(true, `${inv.por_nombre} acreedores resuelven su RFC por el nombre: la maquinaria esta ejercitada`);
    } else {
      noMedido('ningun acreedor resuelve por nombre en esta base: todo lo de arriba queda sin ejercitar (en prod son 1,740 de 6,566).');
    }
    if (inv.kepler_mal === 0) {
      noMedido('ningun RFC de Kepler esta mal formado en esta base: el caso que motivo el cambio no esta presente (en prod son 188).');
    }

    // ── 8: lo que publica el Calendario de Pagos ─────────────────────────────────────────────
    const [{ cols }] = (await knex.raw(
      `SELECT count(*)::int AS cols FROM information_schema.columns
        WHERE table_schema='analytics' AND table_name='v_payable_evidence'
          AND column_name IN ('rfc','rfc_fuente')`,
    )).rows;
    ok(cols === 2, 'v_payable_evidence declara la procedencia del RFC (columnas rfc y rfc_fuente)');

    const [ev] = (await knex.raw(`
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE evidencia <> 'ninguna' AND puntaje < 3)::int AS bajo_umbral,
             count(*) FILTER (WHERE evidencia = 'ninguna' AND motivo IS NULL)::int AS mudos,
             count(*) FILTER (WHERE evidencia <> 'ninguna' AND rfc_fuente = 'nombre')::int AS por_nombre
        FROM analytics.v_payable_evidence`)).rows;
    ok(ev.bajo_umbral === 0, 'ninguna evidencia publicada por debajo del umbral 3');
    ok(ev.mudos === 0, 'ningun documento sin evidencia queda mudo (ADR-056)');
    if (ev.n === 0) {
      noMedido('v_payable_evidence no tiene filas en esta base: los dos candados de arriba no estan ejercitados.');
    } else if (ev.por_nombre > 0) {
      ok(true, `${ev.por_nombre} documentos encuentran su factura con un RFC que Kepler no tenia (en prod, 166 por $10,415,534)`);
    } else {
      noMedido('ningun documento gana evidencia por el nombre en esta base: el beneficio del cambio no esta ejercitado aqui.');
    }

    // ── 9-12: [PGP.29] la cuenta propuesta desde el REP del propio proveedor ─────────────────
    const [{ hay }] = (await knex.raw(
      `SELECT count(*)::int AS hay FROM pg_views WHERE schemaname='analytics' AND viewname='v_supplier_account_proposal'`,
    )).rows;
    if (!hay) {
      noMedido('analytics.v_supplier_account_proposal no existe: falta aplicar la migracion 20261028093850. Los candados de [PGP.29] quedan sin medir.');
    } else {
      const [pr] = (await knex.raw(`
        SELECT count(*)::int AS n,
               count(*) FILTER (WHERE estado='propuesta')::int AS propuestas,
               count(*) FILTER (WHERE estado='propuesta' AND clabe_propuesta IS NULL)::int AS propuesta_sin_clabe,
               count(*) FILTER (WHERE estado<>'propuesta' AND clabe_propuesta IS NOT NULL)::int AS clabe_sin_propuesta,
               count(*) FILTER (WHERE estado<>'propuesta' AND motivo IS NULL)::int AS mudos,
               count(*) FILTER (WHERE estado='propuesta' AND rep_uuid IS NULL)::int AS sin_evidencia,
               count(*) FILTER (WHERE estado NOT IN ('propuesta','varias','control_invalido','solo_cuenta_corta','sin_rep'))::int AS estado_raro
          FROM analytics.v_supplier_account_proposal`)).rows;
      ok(pr.estado_raro === 0, '[PGP.29] estado solo toma los cinco valores declarados');
      ok(pr.propuesta_sin_clabe === 0, "[PGP.29] toda fila 'propuesta' trae su CLABE");
      ok(pr.clabe_sin_propuesta === 0, '[PGP.29] ninguna fila publica una CLABE sin ser una propuesta');
      ok(pr.mudos === 0, '[PGP.29] lo que NO se puede proponer SIEMPRE dice por que (ADR-056)');
      // ⭐ El invariante que importa: nunca se propone una CLABE que no pase su digito de control.
      ok(pr.sin_evidencia === 0, '[PGP.29] toda propuesta trae el UUID del comprobante del que salio');
      const [{ malas }] = (await knex.raw(`
        SELECT count(*)::int AS malas FROM analytics.v_supplier_account_proposal
         WHERE clabe_propuesta IS NOT NULL
           AND NOT ((10 - (SELECT sum((substr(clabe_propuesta, g.i, 1)::int * (ARRAY[3,7,1])[((g.i-1)%3)+1]) % 10)
                             FROM generate_series(1,17) AS g(i)) % 10) % 10 = substr(clabe_propuesta, 18, 1)::int)`)).rows;
      ok(malas === 0, '[PGP.29] ninguna CLABE propuesta falla su digito de control');
      // PRUEBA NEGATIVA: el verificador tiene que RECHAZAR las mismas CLABE con el digito movido.
      const [{ rotas, totales }] = (await knex.raw(`
        WITH z AS (SELECT substr(clabe_propuesta,1,17) || ((substr(clabe_propuesta,18,1)::int + 1) % 10)::text AS v
                     FROM analytics.v_supplier_account_proposal WHERE clabe_propuesta IS NOT NULL)
        SELECT count(*) FILTER (WHERE (10 - (SELECT sum((substr(v,g.i,1)::int * (ARRAY[3,7,1])[((g.i-1)%3)+1]) % 10)
                                               FROM generate_series(1,17) AS g(i)) % 10) % 10 = substr(v,18,1)::int)::int AS rotas,
               count(*)::int AS totales FROM z`)).rows;
      ok(totales > 0 && rotas === 0,
        `[PGP.29] PRUEBA NEGATIVA: las ${totales} mismas CLABE con el digito de control movido NO pasan (${rotas} pasaron)`);
      if (pr.propuestas > 0) {
        ok(true, `[PGP.29] ${pr.propuestas} filas proponibles sobre ${pr.n}: la maquinaria esta ejercitada`);
      } else {
        noMedido('[PGP.29] ninguna cuenta proponible en esta base: los candados de arriba no estan ejercitados (en prod son 22 acreedores).');
      }
    }

    console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} ⊘\n`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('  ✗ EXCEPCION:', e.message);
    await knex.destroy();
    process.exit(1);
  }
})();
