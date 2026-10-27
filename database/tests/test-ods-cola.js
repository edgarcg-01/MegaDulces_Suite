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
const { syncCtid, crearCicloTiempoReal, borrarEnVivo } = require('../importers/kepler/replicate-ods-live').__test;

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
    const correr = async (code, opts) => {
      const consultas = [];
      const p = { async query(sql) { consultas.push(String(sql)); return /SELECT last_ctid FROM ods\.ctl/.test(sql) ? { rows: [{ last_ctid: '(0,0)' }] } : { rows: [], rowCount: 0 }; } };
      await syncCtid(p, code, 'kdm1', META, { apply: true, full: false, ...opts });
      return consultas;
    };
    const red = (qs) => qs.some((s) => /current_date - 3/.test(s));
    const estado = (qs) => qs.some((s) => /"c1" = \$1 AND/.test(s));
    // ⛔ La puesta al día: medido en el piloto de la 06, dos facturas capturadas segundos ANTES del
    // trigger quedaron fuera de la cola Y fuera de la red (que ya se saltaba). La primera pasada con
    // la cola activa tiene que correr las dos redes completas.
    const primera = await correr('06', { colaActiva: true });
    A(red(primera) && estado(primera), '⛔ PRIMERA pasada con cola: corre las dos redes una vez (cubre lo de antes del trigger)');
    const conCola = await correr('06', { colaActiva: true });
    A(conCola.some((s) => /ctid > \$1::tid/.test(s)), 'con cola, el ctid SIGUE corriendo (es barato y mantiene `ods.ctl` al día)');
    A(!red(conCola) && !estado(conCola), 'ya puesta al día: NI la red de 3 días NI la de estado (eran el ciclo de ~1.5 s cada 5 min)');
    const sinCola = await correr('07', { colaActiva: false });
    A(red(sinCola) && estado(sinCola), 'CONTROL: sin cola, las dos redes corren como siempre');
    // El caso real de una instalación: la rama corrió su red hace un momento (SIN cola) y en ese
    // instante se activa la cola. La puesta al día no puede esperar su turno de 5 min, ni darse por
    // hecha porque la red ya había corrido sin cola.
    await correr('08', { colaActiva: false });
    const recienActivada = await correr('08', { colaActiva: true });
    A(red(recienActivada) && estado(recienActivada),
      '⛔ recién activada la cola, la puesta al día corre YA aunque la red haya corrido hace segundos sin cola');
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
          const pedidosDeBorrar = [];
          const r3 = await drenar({ borrar: async (t, m, ll) => { pedidosDeBorrar.push(...ll); return { borradas: ll.length }; } });
          A(r3.borradas === 1 && llamadas.length === 0, '⛔ un borrado se CUENTA y no se entrega como fila');
          A(pedidosDeBorrar.length === 1 && Number(pedidosDeBorrar[0].c7) === 3 && r3.propagadas === 1,
            '[OBS.15.10] y a `borrar` le llega EXACTAMENTE la llave que el origen ya no tiene');

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
    A(/^(1|true|yes)$/i.test(valor('ODS_COLA_BORRAR')), '[OBS.15.10] el carril de caja propaga los borrados (decisión del PM)');
    const hot = yamls.find((y) => /20-ods-live-hot/.test(y.f))?.t || '';
    const valorHot = (k) => ((hot.match(new RegExp(`name: ${k}\\s*\\n\\s*value: "?([^"\\n]*)"?`)) || [])[1] || '').trim();
    A(valorHot('ODS_COLA_CUBRE') === 'kdm2', '[OBS.15.12] el caliente sabe que kdm2 la cubre la cola (no re-embarca su ventana)');
    A(!valorHot('ODS_COLA_TABLES'), 'y NO vacía la cola: ese sigue siendo el de caja');
  }

  console.log('\n[6] [OBS.15.12] Con la cola de otro carril, la red de kdm2 manda SKUs al recálculo, no filas');
  {
    const cols = [['c1', 'character varying'], ['c2', 'character varying'], ['c3', 'character varying'], ['c4', 'numeric'],
      ['c5', 'numeric'], ['c6', 'character varying'], ['c7', 'numeric'], ['c8', 'character varying'], ['c10', 'timestamp without time zone'],
      ['c32', 'date']].map(([column_name, data_type]) => ({ column_name, data_type }));
    const META = { cols, pk: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'] };
    const correr = async (code, table, opts) => {
      const consultas = [], encolados = [];
      const p = { async query(sql) {
        const s = String(sql); consultas.push(s);
        if (/SELECT last_ctid FROM ods\.ctl/.test(s)) return { rows: [{ last_ctid: '(0,0)' }] };
        if (/SELECT DISTINCT btrim/.test(s)) return { rows: [{ k: '17804' }, { k: '17805' }] };
        return { rows: [], rowCount: 0 };
      } };
      await syncCtid(p, code, table, META, { apply: true, full: false, encolarFn: (t, k) => { encolados.push(...k); return k.length; }, ...opts });
      return { consultas, encolados, reembarca: consultas.some((s) => /current_date - 3/.test(s) && !/DISTINCT/.test(s)) };
    };
    const cub = await correr('01', 'kdm2', { colaCubre: true, modoPg: true });
    A(cub.encolados.join(',') === '17804,17805', 'cubierta: los SKUs de la ventana van al recálculo de precio');
    A(!cub.reembarca, '⛔ cubierta: NO re-embarca la ventana (eran ~82k renglones cada 5 min)');
    const ctl = await correr('02', 'kdm2', { colaCubre: false, modoPg: true });
    A(ctl.reembarca && !ctl.encolados.length, 'CONTROL: sin cola en la rama, la red de siempre');
    const http = await correr('03', 'kdm2', { colaCubre: true, modoPg: false });
    A(http.reembarca && !http.encolados.length, 'sin sink pg (el coalescedor no vive en este proceso): la red de siempre');
    const kdij = await correr('04', 'kdij', { colaCubre: true, modoPg: true });
    A(kdij.reembarca && !kdij.encolados.length, 'una tabla sin columna de SKU declarada: la red de siempre');
    const noCoal = await correr('05', 'kdm2', { colaCubre: true, modoPg: true, encolarFn: () => -1 });
    A(noCoal.reembarca, 'si el recálculo responde -1 (no coalescible), vuelve a la red de siempre');

    // El handler REAL del feed `raw-normalize` (el que corre en el proceso del caliente).
    const { HANDLERS } = require(path.resolve(__dirname, '../../services/feeds-ingest/apply-handlers.js'));
    const T = '00000000-0000-0000-0000-00000000d01c';
    const n1 = await HANDLERS['raw-normalize'](null, T, [{ k: ' 17804 ' }, { k: '17804' }, { k: '' }, { k: '17805' }], { table: 'kdm2' });
    A(n1 === 2, `raw-normalize sobre kdm2: deduplica y limpia (2 SKUs de 4 llegadas, dio ${n1})`);
    const n2 = await HANDLERS['raw-normalize'](null, T, [{ k: 'X' }], { table: 'kdii' });
    A(n2 === -1, 'raw-normalize sobre kdii (su precio va AL MOMENTO, [TDA.1]): -1, no se junta');
  }

  console.log('\n[7] [OBS.15.10] Borrados en vivo: sólo lo reciente, nunca una poda');
  {
    const cols = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'].map((n) => ({ column_name: n, data_type: /c[457]/.test(n) ? 'numeric' : 'character varying' }));
    const META = { cols, pk: cols.map((c) => c.column_name) };
    const ll = (n) => Array.from({ length: n }, (_, i) => ({ c1: '08', c2: 'U', c3: 'D', c4: 8, c5: 1, c6: '0000555', c7: i + 1 }));
    const dest = (filas) => { const q = []; return { q, async query(sql, params) { q.push({ sql: String(sql), params }); return { rows: filas }; } }; };
    let enviados = [];
    const shipFn = async (rows) => { enviados.push(...rows); return { rowCount: rows.length }; };

    const d1 = dest(ll(501));
    const r1 = await borrarEnVivo({ code: '08', tabla: 'kdm2', meta: META, llaves: ll(501), dest: d1, shipFn });
    A(r1.borradas === 0 && !d1.q.length && !enviados.length, '⛔ 501 borrados en una pasada (> 500): NO se toca ninguno — es una poda');
    const d2 = dest(ll(2));
    const r2 = await borrarEnVivo({ code: '08', tabla: 'kdm2', meta: META, llaves: ll(3), dest: d2, shipFn });
    A(/current_date - \$3::int/.test(d2.q[0]?.sql || '') && d2.q[0].params[1] === '08' && d2.q[0].params[2] === 7,
      'le pregunta al ODS por SU sucursal y por fecha de negocio de los últimos 7 días');
    A(/"c32" >= current_date/.test(d2.q[0]?.sql || ''), 'en kdm2 la fecha es la del renglón (c32)');
    A(r2.borradas === 2 && enviados.length === 2 && enviados.every((x) => x.sucursal === '08'),
      'borra SÓLO las que el ODS tiene con fecha reciente (2 de 3)');
    A(/1 viejas/.test(r2.nota || ''), 'y declara cuántas dejó sin tocar');
    enviados = [];
    const r3 = await borrarEnVivo({ code: '01', tabla: 'kdij', meta: META, llaves: ll(2), dest: dest(ll(2)), shipFn });
    A(r3.borradas === 0 && !enviados.length && /sin fecha/.test(r3.nota || ''), 'una tabla sin fecha declarada (kdij, el kárdex que se poda): NUNCA');
    const r4 = await borrarEnVivo({ code: '01', tabla: 'kdm2', meta: META, llaves: ll(2), dest: null, shipFn });
    A(r4.borradas === 0 && !enviados.length && /sin destino/.test(r4.nota || ''), 'sin destino pg: no borra (y lo dice)');
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
      const s = [{ suc: '06', tabla: 'cola', carril: 'cola', leidas: 2, escritas: 2, espera_max_ms: 120 }];
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

    // ⛔ Lo no medido se DECLARA. La primera versión escribía «peor réplica→ODS 0 ms» con la cola
    // apagada en las 9 ramas (medido en prod a minutos de desplegar).
    const notaDe = async (cola, filasCola) => {
      const notas = [];
      const t = crearCicloTiempoReal({
        ciclo: async () => { reloj += 50; const s = [...filasCola]; s.fallas = []; s.marcas = []; s.cola = cola; return s; },
        latir: async (f, d) => { if (f === 'end') notas.push(d.note); }, marcarRamas: async () => { /* sin marcas en este caso */ }, cadaMs: 1000, ahora,
      });
      for (let i = 0; i < 6; i++) { await t({ full: false }); reloj += 200; }
      return notas[0] || '';
    };
    const apagada = await notaDe({ activas: 0, ramas: 9, faltan: ['06(kdm1:ausente,kdm2:ausente)'] }, []);
    A(/peor réplica→ODS sin medir/.test(apagada) && !/réplica→ODS 0 ms/.test(apagada), '⛔ sin cola activa la espera dice «sin medir», no «0 ms»');
    const quieta = await notaDe({ activas: 1, ramas: 9, faltan: [] }, [{ carril: 'cola', leidas: 0, escritas: 0, espera_max_ms: 0 }]);
    A(/sin movimientos en la ventana/.test(quieta) && !/réplica→ODS 0 ms/.test(quieta), '⛔ con cola pero sin entradas, dice «sin movimientos», no «0 ms»');
  }

  console.log(`\n${fail ? '✖' : '✔'} ${ok} ok · ${fail} fallas · ${noMedido} NO MEDIDO`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
