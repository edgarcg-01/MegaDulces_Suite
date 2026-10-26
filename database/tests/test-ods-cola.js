/* eslint-disable no-console */
/**
 * `[OBS.15]` EL CANDADO DE LA COLA DE CAMBIOS — con sus pruebas NEGATIVAS.
 *
 * QUÉ PROTEGE. La cabecera de un documento (`kdm1`) llegaba al ODS en ~1 s y sus renglones
 * (`kdm2`) de 0 a 5.6 min después, porque el carril CTID no ve las filas que el heap de la réplica
 * acomoda por debajo del watermark (medido 2026-10-26: 4 de 9 ramas ciegas en `kdm2`, 2 en `kdm1`).
 * La cola (`database/importers/lib/ods-cola.js`) es el detector que no depende de la posición.
 *
 * Las formas de que esto sea decorativo, cada una con su bloque:
 *   · instalar el trigger SIN `ENABLE ALWAYS` (bloques 1 y 3): en el apply worker no dispara y la
 *     cola queda vacía PARA SIEMPRE — se vería exactamente igual que «no pasó nada»;
 *   · que el trigger pueda TIRAR (bloques 1 y 3): congelaría la suscripción entera de esa sucursal;
 *   · retirar la tabla antes que los triggers (bloque 1): el mismo congelamiento, al desinstalar;
 *   · que el drenado borre la entrada ANTES de entregar (bloque 3): un fallo perdería el cambio;
 *   · que la cabecera no viaje antes que sus renglones (bloque 3);
 *   · que propague borrados en vivo (bloque 3): el origen PODA historia que el ODS conserva;
 *   · que con la cola activa el carril siga corriendo la red de 5 min (bloque 2), o que SIN cola
 *     la apague (bloque 2, control): esa red es lo único que hoy repone lo que el ctid salta;
 *   · que dos carriles vacíen la misma cola, o que el de caja no esté en tiempo real (bloque 4).
 *
 * El bloque 3 necesita un Postgres LOCAL con superusuario (`SET session_replication_role` lo
 * exige): en CI es el de `pruebas-db`; en la máquina, `ODS_COLA_TEST_URL`. Sin eso: NO MEDIDO.
 * Corre todo en UNA transacción con ROLLBACK: no deja nada en la base.
 *
 * Uso: node database/tests/test-ods-cola.js
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
// Antes del require: el carril lee la lista de la cola al cargar, y el bloque 5 mide su nota.
process.env.ODS_COLA_TABLES = 'kdm1,kdm2';
const { instalarSql, quitarSql, estadoCola, drenarCola, TRIGGER } = require('../importers/lib/ods-cola');
const { syncCtid, crearCicloTiempoReal } = require('../importers/kepler/replicate-ods-live').__test;

let ok = 0, fail = 0, noMedido = 0;
const A = (cond, msg) => { if (cond) { ok++; console.log(`  ✔ ${msg}`); } else { fail++; console.log(`  ✖ ${msg}`); } };
const NM = (msg) => { noMedido++; console.log(`  ○ NO MEDIDO — ${msg}`); };

const TABLAS = [{ tabla: 'kdm1', pk: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] }, { tabla: 'kdm2', pk: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'] }];

(async () => {
  console.log('\n[1] El SQL de instalación (puro)');
  {
    const lotes = instalarSql(TABLAS);
    const [base, ...porTabla] = lotes;
    const funcion = base.find((s) => /FUNCTION/.test(s));
    A(porTabla.length === 2, 'una transacción por tabla');
    A(porTabla.every((l) => l.some((s) => /CREATE OR REPLACE TRIGGER/.test(s)) && l.some((s) => /ENABLE ALWAYS TRIGGER/.test(s))),
      '⛔ el trigger y su ENABLE ALWAYS van en la MISMA transacción: nunca existe sin disparar en el apply worker');
    A(porTabla.every((l) => l[0] === `SET LOCAL lock_timeout = '3s'`), 'cada tabla con lock_timeout: no se cuelga detrás del apply worker');
    A(/to_regclass\('"ods"\.cola'\) IS NULL THEN RETURN NULL/.test(funcion), 'sin cola, el trigger sale sin error (no congela la suscripción)');
    A(!/EXCEPTION/i.test(funcion), '⛔ sin bloque EXCEPTION: una subtransacción por fila desbordaría la caché del clúster');
    A(!/--/.test(funcion), 'sin comentarios de línea dentro de la función (el instalador la imprime en una línea)');
    A(porTabla[1].some((s) => s.includes(`encolar('c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7')`)), 'la PK viaja como argumentos del trigger');
    let tiro = false; try { instalarSql([{ tabla: 'x', pk: [] }]); } catch { tiro = true; }
    A(tiro, 'una tabla sin PK se rechaza al instalar (no se podría leer por llave)');

    const q = quitarSql(TABLAS);
    const iTabla = q.findIndex((l) => l.some((s) => /DROP TABLE/.test(s)));
    const iTrig = q.map((l, i) => (l.some((s) => /DROP TRIGGER/.test(s)) ? i : -1)).filter((i) => i >= 0);
    A(iTrig.length === 2 && iTrig.every((i) => i < iTabla), '⛔ al retirar, los triggers SIEMPRE antes que la tabla');
  }

  console.log('\n[2] El cableado: con la cola activa el carril se salta las redes; sin ella, no');
  {
    const COLS = [['c1', 'character varying'], ['c2', 'character varying'], ['c3', 'character varying'], ['c4', 'numeric'],
      ['c5', 'numeric'], ['c6', 'character varying'], ['c9', 'date'], ['c43', 'character varying'], ['c68', 'date']]
      .map(([column_name, data_type]) => ({ column_name, data_type }));
    const META = { cols: COLS, pk: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] };
    const correr = async (opts) => {
      const consultas = [];
      const p = { async query(sql) { consultas.push(String(sql)); return /SELECT last_ctid FROM ods\.ctl/.test(sql) ? { rows: [{ last_ctid: '(0,0)' }] } : { rows: [], rowCount: 0 }; } };
      await syncCtid(p, '06', 'kdm1', META, { apply: true, full: false, ...opts });
      return consultas;
    };
    const conCola = await correr({ colaActiva: true });
    const sinCola = await correr({ colaActiva: false });
    const red = (qs) => qs.some((s) => /current_date - 3/.test(s));
    const estado = (qs) => qs.some((s) => /"c1" = \$1 AND/.test(s));
    A(conCola.some((s) => /ctid > \$1::tid/.test(s)), 'con cola, el ctid SIGUE corriendo (es barato y mantiene `ods.ctl` al día)');
    A(!red(conCola) && !estado(conCola), 'con cola, NI la red de 3 días NI la de estado (eran el ciclo de ~1.5 s cada 5 min)');
    A(red(sinCola) && estado(sinCola), 'CONTROL: sin cola, las dos redes corren como siempre');
    const full = []; const pf = { async query(sql) { full.push(String(sql)); return /last_ctid/.test(sql) ? { rows: [{ last_ctid: '(0,0)' }] } : { rows: [], rowCount: 0 }; } };
    await syncCtid(pf, '06', 'kdm1', META, { apply: true, full: true, colaActiva: true });
    A(red(full), '`--full` corre la red aunque haya cola (una reparación no se salta nada)');
  }

  console.log('\n[2b] El ORDEN del drenado (con un doble: valida el orden, no el SQL — eso es el bloque 3)');
  {
    const META = { cols: [{ column_name: 'c1', data_type: 'character varying' }, { column_name: 'c7', data_type: 'numeric' }], pk: ['c1', 'c7'] };
    const doble = (pasos) => ({
      async query(sql) {
        const s = String(sql);
        if (/FROM "ods"\.cola WHERE tabla = ANY/.test(s)) {
          pasos.push('leer-cola');
          return { rows: [{ id: 1, tabla: 'kdm2', llave: { c1: '06', c7: 1 }, op: 'I', espera_ms: 40 },
            { id: 2, tabla: 'kdm1', llave: { c1: '06', c7: 1 }, op: 'I', espera_ms: 30 }] };
        }
        if (/jsonb_to_recordset/.test(s)) { pasos.push('leer-filas'); return { rows: [{ c1: '06', c7: 1 }] }; }
        if (/DELETE FROM "ods"\.cola/.test(s)) { pasos.push('borrar'); return { rowCount: 1 }; }
        return { rows: [] };
      },
    });
    const pasos = [];
    await drenarCola(doble(pasos), { tablas: ['kdm1', 'kdm2'], metaDe: async () => META, enviar: async (t) => { pasos.push(`enviar-${t}`); return { rowCount: 1 }; } });
    A(pasos.indexOf('enviar-kdm1') < pasos.indexOf('enviar-kdm2'), 'la cabecera (kdm1) se entrega antes que el renglón (kdm2) aunque llegó DESPUÉS a la cola');
    A(pasos.indexOf('enviar-kdm1') < pasos.indexOf('borrar'), '⛔ se borra de la cola DESPUÉS de entregar, nunca antes');
    const fallo = [];
    let tiro = false;
    try { await drenarCola(doble(fallo), { tablas: ['kdm1'], metaDe: async () => META, enviar: async () => { throw new Error('destino caído'); } }); } catch { tiro = true; }
    A(tiro && !fallo.includes('borrar'), '⛔ si la entrega falla, NO se borra nada de la cola (se reintenta en la pasada siguiente)');
  }

  console.log('\n[3] Contra un Postgres real: el trigger, el apply worker y el drenado');
  {
    const url = process.env.ODS_COLA_TEST_URL || process.env.DATABASE_URL_NEW || '';
    const local = /@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
    if (!local) {
      NM('ni ODS_COLA_TEST_URL ni DATABASE_URL_NEW apuntan a un Postgres local; corre en CI (pruebas-db).');
    } else {
      const c = new Client({ connectionString: url.replace('localhost', '127.0.0.1'), statement_timeout: 30000 });
      await c.connect();
      const su = (await c.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)).rows[0]?.rolsuper;
      if (!su) {
        NM('el rol no es superusuario: no puede fijar session_replication_role (lo que hace el apply worker).');
      } else {
        const sfx = String(process.pid);
        const F = `zz_md_${sfx}`, Q = `zz_ods_${sfx}`;
        const op = { esquemaFuente: F, esquemaCola: Q };
        await c.query('BEGIN');
        try {
          await c.query(`CREATE SCHEMA ${F}`);
          await c.query(`CREATE TABLE ${F}.kdm1 (c1 varchar, c2 varchar, c3 varchar, c4 numeric, c5 numeric, c6 varchar, c16 numeric,
                           PRIMARY KEY (c1, c2, c3, c4, c5, c6))`);
          await c.query(`CREATE TABLE ${F}.kdm2 (c1 varchar, c2 varchar, c3 varchar, c4 numeric, c5 numeric, c6 varchar, c7 numeric,
                           c8 varchar, c13 numeric, PRIMARY KEY (c1, c2, c3, c4, c5, c6, c7))`);
          for (const l of instalarSql(TABLAS, op)) for (const s of l) await c.query(s);
          // Columnas como las reporta information_schema de la réplica (c4/c5 numéricos, como en md.*).
          const cols = (pares) => pares.map(([column_name, data_type]) => ({ column_name, data_type }));
          const LLAVE = [['c1', 'character varying'], ['c2', 'character varying'], ['c3', 'character varying'],
            ['c4', 'numeric'], ['c5', 'numeric'], ['c6', 'character varying']];
          const META = {
            kdm1: { cols: cols([...LLAVE, ['c16', 'numeric']]), pk: TABLAS[0].pk },
            kdm2: { cols: cols([...LLAVE, ['c7', 'numeric'], ['c8', 'character varying'], ['c13', 'numeric']]), pk: TABLAS[1].pk },
          };
          const cuenta = async () => Number((await c.query(`SELECT count(*) FROM ${Q}.cola`)).rows[0].count);
          const llamadas = [];
          const enviar = async (t, meta, filas) => { llamadas.push({ t, filas }); return { rowCount: filas.length }; };
          const drenar = (extra = {}) => drenarCola(c, { tablas: ['kdm1', 'kdm2'], metaDe: async (t) => META[t], enviar, ...op, ...extra });

          A((await estadoCola(c, ['kdm1', 'kdm2'], op)).tablas.kdm2 === 'activa', 'instalada: estado `activa`');

          // ⛔ La negativa que justifica el ALWAYS: con el trigger normal, el apply worker no lo dispara.
          await c.query(`ALTER TABLE ${F}.kdm2 ENABLE TRIGGER ${TRIGGER}`);
          A((await estadoCola(c, ['kdm2'], op)).tablas.kdm2 === 'apagada', 'con ENABLE normal el estado dice `apagada` (no `activa`, no `ausente`)');
          await c.query(`SET LOCAL session_replication_role = replica`);
          await c.query(`INSERT INTO ${F}.kdm2 VALUES ('06','U','D',8,1,'0000001',9,'X',1)`);
          A(await cuenta() === 0, '⛔ NEGATIVA: trigger sin ALWAYS + rol de réplica (el apply worker) = la cola NO se entera');
          await c.query(`DELETE FROM ${F}.kdm2`);
          await c.query(`SET LOCAL session_replication_role = origin`);
          await c.query(`ALTER TABLE ${F}.kdm2 ENABLE ALWAYS TRIGGER ${TRIGGER}`);
          await c.query(`SET LOCAL session_replication_role = replica`);

          // Una factura: cabecera + 3 renglones, como los aplica la suscripción.
          await c.query(`INSERT INTO ${F}.kdm2 VALUES ('06','U','D',8,1,'0001853',1,'17804',100),('06','U','D',8,1,'0001853',2,'17805',200),('06','U','D',8,1,'0001853',3,'17806',300)`);
          await c.query(`INSERT INTO ${F}.kdm1 VALUES ('06','U','D',8,1,'0001853',600)`);
          A(await cuenta() === 4, 'con ALWAYS + rol de réplica, la cola anota las 4 filas');
          const r1 = await drenar();
          A(r1.porTabla.kdm1?.enviadas === 1 && r1.porTabla.kdm2?.enviadas === 3, 'el drenado entrega 1 cabecera y 3 renglones');
          A(llamadas[0]?.t === 'kdm1' && llamadas[1]?.t === 'kdm2', 'la cabecera se entrega ANTES que sus renglones, en la misma pasada');
          A(llamadas[0]?.filas[0]?.c16 !== undefined && Number(llamadas[0].filas[0].c16) === 600, 'entrega la FILA completa leída por su PK (no sólo la llave)');
          A(await cuenta() === 0, 'y vacía lo que entregó');
          A(Number.isFinite(r1.espera_max_ms) && r1.espera_max_ms >= 0, 'mide la espera réplica→ODS con el reloj de la base');

          // UPDATE: viaja el valor NUEVO. Tres updates de la misma fila = una sola lectura.
          llamadas.length = 0;
          for (const v of [101, 102, 103]) await c.query(`UPDATE ${F}.kdm2 SET c13 = ${v} WHERE c7 = 1`);
          const r2 = await drenar();
          A(r2.leidas === 3 && r2.porTabla.kdm2?.llaves === 1 && Number(llamadas[0]?.filas[0]?.c13) === 103,
            'tres UPDATE de la misma fila → UNA lectura, con el valor final');

          // DELETE: se cuenta, NO se entrega (el origen poda historia que el ODS conserva).
          llamadas.length = 0;
          await c.query(`DELETE FROM ${F}.kdm2 WHERE c7 = 3`);
          const r3 = await drenar();
          A(r3.borradas === 1 && llamadas.length === 0, '⛔ un borrado se CUENTA y no se entrega ni se propaga');

          // Si entregar falla, nada se pierde.
          await c.query(`UPDATE ${F}.kdm2 SET c13 = 999 WHERE c7 = 2`);
          let tiro = false;
          try { await drenarCola(c, { tablas: ['kdm1', 'kdm2'], metaDe: async (t) => META[t], enviar: async () => { throw new Error('destino caído'); }, ...op }); } catch { tiro = true; }
          A(tiro && await cuenta() === 1, '⛔ si la entrega falla, la entrada se QUEDA en la cola (se borra sólo al entregar)');
          llamadas.length = 0;
          await drenar();
          A(Number(llamadas[0]?.filas[0]?.c13) === 999 && await cuenta() === 0, 'y la pasada siguiente la entrega');

          // Un UPDATE que cambia la llave deja la vieja anotada como borrado.
          llamadas.length = 0;
          await c.query(`UPDATE ${F}.kdm2 SET c7 = 20 WHERE c7 = 2`);
          const r4 = await drenar();
          A(r4.porTabla.kdm2?.enviadas === 1 && r4.borradas === 1, 'cambiar la llave: la nueva se entrega y la vieja se cuenta como borrada');

          // El trigger NO puede romper la replicación: sin cola, la escritura sigue.
          await c.query(`SAVEPOINT sin_cola`);
          await c.query(`DROP TABLE ${Q}.cola`);
          let escribio = true;
          try { await c.query(`INSERT INTO ${F}.kdm2 VALUES ('06','U','D',8,1,'0009999',1,'X',1)`); } catch { escribio = false; }
          A(escribio, '⛔ sin la tabla de la cola, la fila se aplica igual (la suscripción no se congela)');
          await c.query(`ROLLBACK TO SAVEPOINT sin_cola`);

          await c.query(`SET LOCAL session_replication_role = origin`);
          for (const l of quitarSql(TABLAS, op)) for (const s of l) await c.query(s);
          A((await estadoCola(c, ['kdm1', 'kdm2'], op)).tablas.kdm1 === 'ausente', 'retirada: estado `ausente`');
        } finally {
          await c.query('ROLLBACK').catch(() => { /* la transacción ya terminó: nada que deshacer */ });
        }
      }
      await c.end();
    }
  }

  console.log('\n[4] Los manifiestos: UN consumidor, y en tiempo real');
  {
    const dir = path.join(__dirname, '../../ops/k3s');
    const yamls = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => ({ f, t: fs.readFileSync(path.join(dir, f), 'utf8') }));
    const conCola = yamls.filter((y) => /name: ODS_COLA_TABLES/.test(y.t));
    A(conCola.length === 1, `ODS_COLA_TABLES en UN solo manifiesto (hay ${conCola.length}): dos consumidores se repartirían la cola`);
    const caja = conCola[0]?.t || '';
    A(/27-ods-live-caja/.test(conCola[0]?.f || ''), 'y es el carril de caja');
    const valor = (k) => ((caja.match(new RegExp(`name: ${k}\\s*\\n\\s*value: "?([^"\\n]*)"?`)) || [])[1] || '').trim();
    A(valor('ODS_COLA_TABLES') === 'kdm1,kdm2', 'vacía kdm1 y kdm2 (cabecera y renglones)');
    A(/^(1|true|yes)$/i.test(valor('ODS_TIEMPO_REAL')), 'con ODS_TIEMPO_REAL (sin él el piso del sondeo vuelve a 1 s)');
    // De la línea `command:`, no del texto: el encabezado del YAML cita `--watch=1` en su historia.
    const w = Number((caja.match(/^\s*command:.*--watch=([0-9.]+)/m) || [])[1]);
    A(w > 0 && w < 1, `--watch por debajo de 1 s (es ${w})`);
    A(valor('KP_ODS_TABLES') === 'kdm1', 'y su KP_ODS_TABLES sigue siendo SÓLO kdm1 (kdm2 es del carril caliente: el recálculo de precio vive ahí)');
  }

  console.log('\n[5] El latido por ventana (TIEMPO_REAL): una escritura cada 10 s, no dos por ciclo');
  {
    let reloj = 0;
    const ahora = () => reloj;
    const latidos = [], marcas = [];
    let modo = 'ok';
    const ciclo = async () => {
      reloj += 50; // el ciclo tarda 50 ms
      if (modo === 'tira') throw new Error('réplica caída');
      const s = [{ suc: '06', tabla: 'cola', carril: 'cola', escritas: 2, espera_max_ms: 120 }];
      s.fallas = modo === 'falla' ? ['07: no conecta'] : [];
      s.marcas = [{ suc: '06', tablas: 1, filas: 2, error: null }];
      s.cola = { activas: 9, ramas: 9, faltan: [] };
      return s;
    };
    const tick = crearCicloTiempoReal({ ciclo, latir: async (f, d) => latidos.push({ f, d }), marcarRamas: async (m) => marcas.push(m), cadaMs: 10000, ahora });
    // Un ciclo cada 250 ms: 50 de trabajo + 200 de espera.
    const correr = async (n) => { for (let i = 0; i < n; i++) { await tick({ full: false }).catch(() => { /* el error se mide en su propia aserción */ }); reloj += 200; } };

    await correr(1);
    A(latidos.length === 1 && latidos[0].f === 'begin', 'el primer ciclo abre la corrida (`begin` fija el host que mira la sonda)');
    await correr(39);
    A(latidos.length === 1, '40 ciclos en 10 s: CERO escrituras más a prod (antes eran 2 por ciclo = 80)');
    await correr(1);
    const fin = latidos[1];
    A(fin?.f === 'end' && fin.d.status === 'ok' && fin.d.rows === 82 && /en 41 ciclos/.test(fin.d.note),
      'cumplidos los 10 s, UN latido con lo acumulado (82 filas de 41 ciclos)');
    A(/cola 9\/9 ramas/.test(fin?.d.note || '') && /peor réplica→ODS 120 ms/.test(fin?.d.note || ''),
      'el latido dice en cuántas ramas está la cola y la PEOR espera medida');
    A(marcas.length === 1, 'y la marca por rama sale una vez por latido');

    modo = 'falla'; await correr(1); modo = 'ok'; await correr(39);
    const conError = latidos[2];
    A(conError?.d.status === 'error' && /07: no conecta/.test(conError.d.error || ''),
      '⛔ un error a MITAD de la ventana deja el latido en error aunque el último ciclo salga limpio');
    await correr(40);
    A(latidos[3]?.d.status === 'ok', 'y la ventana siguiente vuelve a ok (no arrastra el error viejo)');

    modo = 'tira'; let tiro = false;
    try { await tick({ full: false }); } catch { tiro = true; }
    modo = 'ok';
    A(tiro, 'si el ciclo tira, el error sube al bucle (que lo registra y sigue)');
    A(latidos.filter((l) => l.f === 'begin').length === 1, '`begin` sale UNA sola vez en toda la vida del proceso');

    const mudo = crearCicloTiempoReal({ ciclo, latir: async () => { throw new Error('no debía latir'); }, marcarRamas: async () => { /* sin latido tampoco hay marca */ }, cadaMs: 10000, ahora, late: false });
    let callado = true;
    try { for (let i = 0; i < 60; i++) { await mudo({ full: false }); reloj += 200; } } catch { callado = false; }
    A(callado, 'sin destino de latido (`late=false`) no intenta latir');
  }

  console.log(`\n${fail ? '✖' : '✔'} ${ok} ok · ${fail} fallas · ${noMedido} NO MEDIDO`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
