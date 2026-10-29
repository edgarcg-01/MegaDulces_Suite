/* eslint-disable no-console */
/**
 * `[OPS-AUD.13.4]` EL ÁRBITRO DE PÓLIZAS POR VALOR — con sus pruebas NEGATIVAS.
 *
 * QUÉ PROTEGE. El 2026-10-28 el drenador de la cola borró del ODS 1,590 renglones de pólizas
 * editadas en Kepler (~$17 M) con todos los latidos en verde: todo lo que vigilaba pólizas comparaba
 * LLAVES. `database/importers/kepler/arbitro-polizas-valor.js` compara llave + cargo/abono + importe.
 *
 * Las formas de que sea decorativo, cada una con su prueba:
 *   · que la normalización NO empareje los dos lados (varchar vs text, 100.00 vs 100): daría un rojo
 *     permanente y se apagaría — el control POSITIVO va primero;
 *   · que otra sucursal del ODS cuente como sobrante (el ODS guarda las 9 en una tabla);
 *   · que no vea un importe cambiado, un cargo que pasó a abono, un renglón faltante o sobrante, o
 *     la fecha corrida 6 h (la llave del 13.2);
 *   · que repare con una réplica vacía (borraría el ODS entero vía el drenador);
 *   · que la llave encolada no tenga la forma de la del trigger (el drenador no la encontraría);
 *   · que una diferencia reparada, o una tabla no medida, salga en verde.
 *
 * El bloque 2 necesita un Postgres LOCAL (`ODS_COLA_TEST_URL`; en CI el de `pruebas-db`). Corre en
 * una transacción con ROLLBACK: no deja nada. Sin eso: NO MEDIDO.
 *
 * Uso: node database/tests/test-arbitro-polizas-valor.js
 */
const { Client } = require('pg');
const { diferencias, veredicto, arbitrarTabla, encolar } = require('../importers/kepler/arbitro-polizas-valor').__test;

let ok = 0, fail = 0, noMedido = 0;
const A = (cond, msg) => { if (cond) { ok++; console.log(`  ✔ ${msg}`); } else { fail++; console.log(`  ✖ ${msg}`); } };
const NM = (msg) => { noMedido++; console.log(`  ○ NO MEDIDO — ${msg}`); };

(async () => {
  console.log('\n[1] El veredicto (puro)');
  {
    const rep = new Map([['a', { v: 'C|10.00', llave: {} }], ['b', { v: 'A|5.00', llave: {} }], ['c', { v: 'C|1.00', llave: {} }]]);
    const ods = new Map([['a', { v: 'C|10.00', llave: {} }], ['b', { v: 'A|6.00', llave: {} }], ['z', { v: 'C|1.00', llave: {} }]]);
    const d = diferencias(rep, ods);
    A(d.length === 3 && d.find((x) => x.k === 'b')?.tipo === 'distinta' && d.find((x) => x.k === 'c')?.tipo === 'falta'
      && d.find((x) => x.k === 'z')?.tipo === 'sobra', 'nombra cada llave: distinta, falta y sobra');

    const limpio = veredicto([{ suc: '00', tabla: 'kdc22601', difs: [] }]);
    A(limpio.fallas.length === 0 && limpio.limpias === 1, 'todo igual: sin fallas');
    const rep2 = veredicto([{ suc: '00', tabla: 'kdc22601', difs: [{ tipo: 'falta' }] }], { reparadas: 1 });
    A(rep2.fallas.length === 2 && /re-encoladas/.test(rep2.fallas[0]), '⛔ una diferencia REPARADA sigue siendo falla');
    const nm = veredicto([{ suc: '03', tabla: 'kdc22601', difs: [], error: 'timeout' }]);
    A(nm.fallas.length === 1 && /NO MEDIDO/.test(nm.fallas[0]) && nm.limpias === 0, '⛔ lo no medido se declara, no cuenta como limpio');
    const fr = veredicto([{ suc: '03', tabla: 'kdc22601', difs: [], freno: 'réplica vacía con ODS lleno' }]);
    A(fr.fallas.length === 1 && fr.limpias === 0, 'un freno es falla aunque no haya diferencias listadas');
    const tope = veredicto([{ suc: '00', tabla: 'kdc22601', difs: [{ tipo: 'sobra' }] }], { noReparo: 'tope' });
    A(/NO se reparó/.test(tope.fallas[0]), 'si no reparó, lo dice primero');
    A(/NO compara concepto/.test(limpio.nota), 'la nota declara lo que NO compara');
  }

  console.log('\n[2] Contra un Postgres real');
  {
    const url = process.env.ODS_COLA_TEST_URL || process.env.DATABASE_URL_NEW || '';
    if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
      NM('ni ODS_COLA_TEST_URL ni DATABASE_URL_NEW apuntan a un Postgres local; corre en CI (pruebas-db).');
    } else {
      const c = new Client({ connectionString: url.replace('localhost', '127.0.0.1'), statement_timeout: 30000 });
      await c.connect();
      const s = String(process.pid);
      const R = `arb_rep_${s}`, O = `arb_ods_${s}`, Q = `arb_cola_${s}`;
      const opt = { esqRep: R, esqOds: O };
      try {
        await c.query('BEGIN');
        await c.query(`CREATE SCHEMA ${R}; CREATE SCHEMA ${O}; CREATE SCHEMA ${Q}`);
        // Los tipos REALES de cada lado (medidos en prod el 2026-10-29): la réplica en varchar y
        // numeric(·,2), el ODS en text y numeric sin escala.
        await c.query(`CREATE TABLE ${R}.kdc22601 (c1 numeric(10,0), c2 timestamp, c3 varchar(30), c4 varchar(1),
          c5 numeric(18,2), c8 varchar(10), c10 numeric(10,0), c19 varchar(20), PRIMARY KEY (c1, c2, c3, c8, c10))`);
        await c.query(`CREATE TABLE ${O}.kdc22601 (sucursal text, c1 numeric, c2 timestamp, c3 text, c4 text,
          c5 numeric, c8 text, c10 numeric, c19 text, PRIMARY KEY (sucursal, c1, c2, c3, c8, c10))`);
        await c.query(`CREATE TABLE ${Q}.cola (id bigint GENERATED ALWAYS AS IDENTITY, tabla text, llave jsonb, op text)`);
        await c.query(`INSERT INTO ${R}.kdc22601 VALUES
          (2151, '2026-01-05', '601-015 ', 'C', 100.00, 'D', 1, 'F1'),
          (2151, '2026-01-05', '102-001',  'A', 100.00, 'D', 2, 'F1'),
          (2152, '2026-01-06', '601-015',  'C', 7.50,   'D', 1, 'F2')`);
        await c.query(`INSERT INTO ${O}.kdc22601 VALUES
          ('08', 2151, '2026-01-05', '601-015 ', 'C', 100,  'D', 1, 'otro folio'),
          ('08', 2151, '2026-01-05', '102-001',  'A', 100.0, 'D', 2, 'F1'),
          ('08', 2152, '2026-01-06', '601-015',  'C', 7.5,  'D', 1, 'F2'),
          ('03', 9999, '2026-01-07', '601-014',  'C', 1,    'D', 1, 'X')`);

        let m = await arbitrarTabla(c, c, '08', 'kdc22601', opt);
        A(!m.error && m.difs.length === 0 && m.n_kepler === 3 && m.n_ods === 3,
          'CONTROL POSITIVO: varchar≡text, 100.00≡100≡100.0, la otra sucursal no cuenta, el folio no se compara');

        const mutar = async (sql, msg, espera) => {
          await c.query('SAVEPOINT m'); await c.query(sql);
          const r = await arbitrarTabla(c, c, '08', 'kdc22601', opt);
          A(espera(r), msg);
          await c.query('ROLLBACK TO SAVEPOINT m');
        };
        await mutar(`UPDATE ${O}.kdc22601 SET c5 = 100.01 WHERE c1 = 2151 AND c10 = 1`, 'un centavo de diferencia → distinta',
          (r) => r.difs.length === 1 && r.difs[0].tipo === 'distinta' && r.difs[0].kepler === 'C|100.00' && r.difs[0].ods === 'C|100.01');
        await mutar(`UPDATE ${O}.kdc22601 SET c4 = 'A' WHERE c1 = 2152`, 'un cargo que pasó a abono → distinta',
          (r) => r.difs.length === 1 && r.difs[0].tipo === 'distinta');
        await mutar(`DELETE FROM ${O}.kdc22601 WHERE c1 = 2152`, 'el caso del 2026-10-28: el ODS perdió un renglón → falta',
          (r) => r.difs.length === 1 && r.difs[0].tipo === 'falta');
        await mutar(`UPDATE ${O}.kdc22601 SET c2 = c2 + interval '6 hours' WHERE c1 = 2152`, 'la fecha corrida 6 h → falta + sobra',
          (r) => r.difs.length === 2 && r.difs.some((d) => d.tipo === 'falta') && r.difs.some((d) => d.tipo === 'sobra'));
        await mutar(`UPDATE ${O}.kdc22601 SET c3 = '601-014' WHERE c1 = 2152`, 'la cuenta reclasificada en Kepler que el ODS no recibió → falta + sobra',
          (r) => r.difs.length === 2);
        await mutar(`DELETE FROM ${R}.kdc22601`, '⛔ réplica vacía con ODS lleno → FRENO (no se repara)',
          (r) => r.freno === 'réplica vacía con ODS lleno');

        // La llave encolada tiene que ser la MISMA que escribe el trigger (to_jsonb de la fila de la
        // réplica): si no, el drenador no la encuentra por su PK.
        await c.query('SAVEPOINT e');
        await c.query(`DELETE FROM ${O}.kdc22601 WHERE c1 = 2152`);
        await c.query(`INSERT INTO ${O}.kdc22601 VALUES ('08', 3000, '2026-01-08', '601-015', 'C', 1, 'D', 1, 'Z')`);
        m = await arbitrarTabla(c, c, '08', 'kdc22601', opt);
        const n = await encolar(c, 'kdc22601', m.difs, Q);
        const cola = (await c.query(`SELECT llave FROM ${Q}.cola ORDER BY id`)).rows.map((x) => x.llave);
        const trig = (await c.query(`SELECT jsonb_build_object('c1', j->'c1', 'c2', j->'c2', 'c3', j->'c3', 'c8', j->'c8', 'c10', j->'c10') AS k
                                      FROM ${R}.kdc22601 t, LATERAL (SELECT to_jsonb(t) j) z WHERE c1 = 2152`)).rows[0].k;
        A(n === 2, 'encola una llave por diferencia (la que falta y la que sobra)');
        A(cola.some((k) => JSON.stringify(k) === JSON.stringify(trig)), '⛔ la llave encolada es idéntica a la que escribe el trigger de la cola');
        A(cola.some((k) => Number(k.c1) === 3000), 'la sobrante va con su llave del ODS (el drenador la borra porque la réplica no la tiene)');
        await c.query('ROLLBACK TO SAVEPOINT e');

        let tiro = null;
        const mm = await arbitrarTabla(c, c, '08', 'kdc29999', opt).catch((e) => { tiro = e; });
        A(!tiro && mm.error, 'una tabla que no existe NO lanza: vuelve como error (NO MEDIDO)');
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        await c.end();
      }
    }
  }

  console.log(`\n${fail ? '✖' : '✔'} ${ok} ok · ${fail} fallas · ${noMedido} NO MEDIDO`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
