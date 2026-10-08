/* eslint-disable no-console */
/**
 * `[GX.73]` EL CANDADO DE LA RED DE SEGURIDAD DE ESTADO — con sus pruebas NEGATIVAS.
 *
 * QUÉ PROTEGE. Autorizar una solicitud de gasto en Kepler sólo cambia `kdm1.c43` (N → A) en el
 * renglón existente, sin tocar ninguna fecha. El carril CTID salta ese UPDATE y la ventana de 3 días
 * no lo cubre si la solicitud es más vieja: la Suite mostraba «por ejercer» indefinidamente un vale
 * que Kepler ya había autorizado. `reenviarAbiertos()` re-envía esos documentos sin depender de su
 * fecha (ver `database/importers/lib/ods-open-docs.js`).
 *
 * Las formas de que esto sea decorativo, cada una con su bloque:
 *   · que el filtro NO use la sucursal (bloque 1) → la consulta lee 1.8 GB por rama cada 5 min;
 *   · que compare `c4` numérico como texto o al revés (bloque 1) → el índice no entra o no casa;
 *   · que se apague en silencio cuando falta una columna (bloque 1) → `null`, declarado;
 *   · que re-envíe en CADA pasada de 15 s y no cada intervalo (bloque 2) → egress ×20;
 *   · que la transición FINAL (A → F, → C) no viaje (bloque 1: la rama de captura reciente);
 *   · que el SQL no sea válido contra un `kdm1` real (bloque 3, contra la base local).
 *
 * Uso: node database/tests/test-ods-open-docs.js
 */
const { Client } = require('pg');
const { openDocsSql, openDocsSqlTolerante, DIAS_DEFAULT } = require('../importers/lib/ods-open-docs');
const { __test } = require('../importers/kepler/replicate-ods-live');
const { reenviarAbiertos, OPEN_DOCS_INTERVAL_MS, syncCtid } = __test;

let ok = 0, fail = 0, noMedido = 0;
const A = (cond, msg) => { if (cond) { ok++; console.log(`  ✔ ${msg}`); } else { fail++; console.log(`  ✖ ${msg}`); } };

/** Columnas como las reporta information_schema de la réplica. */
const COLS = (over = {}) => Object.entries({
  c1: 'character varying', c2: 'character varying', c3: 'character varying',
  c4: 'numeric', c5: 'character varying', c6: 'character varying',
  c9: 'date', c43: 'character varying', c68: 'date', ...over,
}).filter(([, t]) => t !== null).map(([column_name, data_type]) => ({ column_name, data_type }));

(async () => {
  console.log('\n[1] El predicado (puro)');
  {
    const r = openDocsSql('kdm1', COLS());
    A(r && /^"c1" = \$1 AND /.test(r.sql), 'arranca por la SUCURSAL como parámetro (es lo que abre el índice)');
    A(r && r.sql.includes(`"c2" = 'X'`) && r.sql.includes(`"c3" = 'A'`) && r.sql.includes(`"c5" = '1'`),
      'la clave del documento con IGUALDAD exacta (no btrim): el índice (c1..c6) la puede usar');
    A(r && r.sql.includes('"c4" = 15') && !r.sql.includes(`"c4" = '15'`), 'c4 numérico → literal SIN comillas');
    A(r && r.sql.includes(`btrim("c43"::text) IN ('N', 'A')`), 'abiertas = N o A, sin importar su fecha');
    A(r && r.sql.includes(`"c68" >= current_date - ${DIAS_DEFAULT}`),
      `y TODAS las capturadas en ${DIAS_DEFAULT} días: lleva la transición FINAL (A → F, → C)`);
    A(r && r.nombres.length === 1 && /XA1501/.test(r.nombres[0]), 'declara qué documentos cubre');

    const t = openDocsSql('kdm1', COLS({ c4: 'character varying' }));
    A(t && t.sql.includes(`"c4" = '15'`), 'c4 texto → literal CON comillas');

    const sinFecha = openDocsSql('kdm1', COLS({ c68: 'character varying' }));
    A(sinFecha && !sinFecha.sql.includes('current_date'),
      'si c68 no es fecha NO entra la rama de captura (comparar texto con current_date revienta cada pasada)');
    A(sinFecha && sinFecha.sql.includes(`IN ('N', 'A')`), '…y las abiertas siguen cubiertas');

    A(openDocsSql('kdm1', COLS({ c43: null })) === null, '⛔ sin c43 → null (degradación limpia, no un filtro roto)');
    A(openDocsSql('kdm1', COLS({ c1: null })) === null, '⛔ sin la sucursal → null: NUNCA una consulta sin c1 (1.8 GB)');
    A(openDocsSql('kdm2', COLS()) === null, '⛔ una tabla sin tipos declarados → null');
    A(openDocsSql('kdm1', []) === null && openDocsSql('kdm1', undefined) === null, '⛔ sin columnas → null');

    A(openDocsSql('kdm1', COLS(), { dias: 30 }).sql.includes('current_date - 30'), 'los días se configuran');
    A(openDocsSql('kdm1', COLS(), { dias: 'x; DROP TABLE kdm1' }).sql.includes(`current_date - ${DIAS_DEFAULT}`),
      '⛔ días inválidos → default (no se interpola texto ajeno)');
    A(openDocsSql('kdm1', COLS(), { dias: -5 }).sql.includes(`current_date - ${DIAS_DEFAULT}`), '⛔ días negativos → default');

    const tol = openDocsSqlTolerante('kdm1', COLS());
    A(tol && tol.startsWith('btrim("c1"::text) = $1') && tol.includes(`btrim("c4"::text) = '15'`),
      'la versión tolerante (sólo para medir) usa btrim en toda la clave, como las vistas');
  }

  console.log('\n[2] reenviarAbiertos (cliente falso, envío inyectado)');
  {
    const META = { cols: COLS(), pk: ['c1', 'c2', 'c3', 'c4', 'c6'] };
    const filas = [
      { c1: '00', c2: 'X', c3: 'A', c4: 15, c5: '1', c6: '0009001', c9: '2026-08-01', c43: 'A', c68: '2026-08-01' },
      { c1: '00', c2: 'X', c3: 'A', c4: 15, c5: '1', c6: '0009002', c9: '2026-09-15', c43: 'N', c68: '2026-09-15' },
    ];
    const consultas = [];
    const p = { async query(sql, params) { consultas.push({ sql: String(sql), params }); return { rows: filas }; } };
    const envios = [];
    const shipFn = async (rows) => { envios.push(rows); return { rowCount: 1 }; };
    const ultimas = new Map();
    let reloj = 1_000_000;
    const ahora = () => reloj;

    const r1 = await reenviarAbiertos(p, '00', 'kdm1', META, { shipFn, ahora, ultimas });
    A(consultas.length === 1, 'la primera pasada consulta la réplica una vez');
    A(consultas[0].params && consultas[0].params[0] === '00', 'la sucursal viaja como PARÁMETRO ($1 = "00")');
    A(/FROM md\."kdm1" WHERE "c1" = \$1 AND/.test(consultas[0].sql), 'lee md.kdm1 filtrando por sucursal primero');
    A(envios.length === 1 && envios[0].length === 2, 'envía las filas encontradas');
    A(envios[0].every((o) => o.sucursal === '00'), 'cada fila sale con su `sucursal` (la columna de destino del ODS)');
    A(r1 && r1.revisadas === 2 && r1.actualizadas === 1, 'reporta revisadas y actualizadas');

    reloj += 15_000; // la siguiente pasada del --watch=15
    const r2 = await reenviarAbiertos(p, '00', 'kdm1', META, { shipFn, ahora, ultimas });
    A(r2 && r2.omitida === true && consultas.length === 1,
      '⛔ 15 s después NO vuelve a consultar: respeta su intervalo (si no, egress ×20)');

    reloj += OPEN_DOCS_INTERVAL_MS;
    await reenviarAbiertos(p, '00', 'kdm1', META, { shipFn, ahora, ultimas });
    A(consultas.length === 2, 'cumplido el intervalo, vuelve a re-enviar');

    await reenviarAbiertos(p, '00', 'kdm1', META, { shipFn, ahora, ultimas, full: true });
    A(consultas.length === 3, '`--full` se salta el intervalo');

    await reenviarAbiertos(p, '01', 'kdm1', META, { shipFn, ahora, ultimas });
    A(consultas.length === 4 && consultas[3].params[0] === '01', 'el intervalo es POR SUCURSAL: la 01 no espera a la 00');

    const nada = await reenviarAbiertos(p, '00', 'kdm2', META, { shipFn, ahora, ultimas: new Map() });
    A(nada === null && consultas.length === 4, '⛔ una tabla sin tipos declarados: null y CERO consultas');
  }

  console.log('\n[2b] El cableado: el carril CTID llama a la red de estado');
  {
    // Réplica sin filas nuevas, sin ventana y sin abiertas: así nada se envía (no se toca el sink
    // real) y lo único que se mide es QUÉ consultas hizo el carril.
    const consultas = [];
    const p = {
      async query(sql, params) {
        consultas.push({ sql: String(sql), params });
        if (/SELECT last_ctid FROM ods\.ctl/.test(sql)) return { rows: [{ last_ctid: '(0,0)' }] };
        return { rows: [], rowCount: 0 };
      },
    };
    const META = { cols: COLS(), pk: ['c1', 'c2', 'c3', 'c4', 'c6'] };
    await syncCtid(p, '07', 'kdm1', META, { apply: true, full: false });
    const estado = consultas.filter((q) => /WHERE "c1" = \$1 AND/.test(q.sql));
    A(estado.length === 1 && estado[0].params[0] === '07',
      '⭐ una pasada de syncCtid sobre kdm1 consulta los documentos con estado, con su sucursal');
    const ventana = consultas.findIndex((q) => /current_date - 3/.test(q.sql) && !/"c1" = \$1/.test(q.sql));
    const idx = consultas.findIndex((q) => /WHERE "c1" = \$1 AND/.test(q.sql));
    A(ventana >= 0 && idx > ventana, 'y lo hace DESPUÉS de la ventana de fechas, en consulta aparte (su plan no se toca)');

    const consultasKdm2 = [];
    const p2 = { async query(sql) { consultasKdm2.push(String(sql)); return /last_ctid/.test(sql) ? { rows: [{ last_ctid: '(0,0)' }] } : { rows: [] }; } };
    await syncCtid(p2, '07', 'kdm2', { cols: COLS({ c43: null, c68: null, c32: 'date' }), pk: ['c1'] }, { apply: true, full: false });
    A(!consultasKdm2.some((s) => /"c1" = \$1 AND/.test(s)), '⛔ en kdm2 (sin tipos declarados) no agrega ninguna consulta');
  }

  console.log('\n[3] El SQL contra un kdm1 real (base local)');
  {
    const url = process.env.DATABASE_URL_NEW || '';
    const local = /@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
    if (!local) {
      noMedido++;
      console.log('  ○ NO MEDIDO — DATABASE_URL_NEW no apunta a una base local; el SQL no se ejecutó.');
    } else {
      const c = new Client({ connectionString: url.replace('localhost', '127.0.0.1'), statement_timeout: 30000 });
      await c.connect();
      try {
        const reg = await c.query(`SELECT to_regclass('kepler_ods.kdm1') t`);
        if (!reg.rows[0].t) {
          noMedido++;
          console.log('  ○ NO MEDIDO — esta base no tiene kepler_ods.kdm1.');
        } else {
          const cols = (await c.query(`SELECT column_name, data_type FROM information_schema.columns
            WHERE table_schema='kepler_ods' AND table_name='kdm1'`)).rows;
          const pred = openDocsSql('kdm1', cols);
          const tol = openDocsSqlTolerante('kdm1', cols);
          A(pred !== null, 'con las columnas reales de kdm1 arma el predicado');
          const sucs = (await c.query(`SELECT DISTINCT btrim(c1::text) s FROM kepler_ods.kdm1
            WHERE c2='X' AND c3='A' AND btrim(c4::text)='15' ORDER BY 1`)).rows.map((r) => r.s);
          let exacto = 0, tolerante = 0;
          for (const s of sucs) {
            exacto += Number((await c.query(`SELECT count(*) n FROM kepler_ods.kdm1 WHERE ${pred.sql}`, [s])).rows[0].n);
            tolerante += Number((await c.query(`SELECT count(*) n FROM kepler_ods.kdm1 WHERE ${tol}`, [s])).rows[0].n);
          }
          A(true, `el SQL corre contra kepler_ods.kdm1 (${sucs.length} sucursal(es) con solicitudes)`);
          A(exacto === tolerante,
            `la igualdad exacta ve LO MISMO que el filtro tolerante de las vistas (${exacto} = ${tolerante}): sin espacios que la dejen ciega`);
        }
      } finally { await c.end(); }
    }
  }

  console.log(`\n${fail ? '✖' : '✔'} ${ok} ok · ${fail} fallas · ${noMedido} no medido`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
