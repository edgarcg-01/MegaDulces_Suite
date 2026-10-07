/* eslint-disable no-console */
/**
 * [NORM.3b] EL CANDADO DE "DESTINO NUEVO" — con sus pruebas NEGATIVAS.
 *
 * QUÉ PROTEGE. `ods.shadow` guarda (tabla, pk, hash) por RÉPLICA y no tiene una sola columna que
 * diga A QUÉ DESTINO se shipeó esa fila. Mientras hubo un destino eso fue invisible. Cuando prod
 * se mudó de Railway a `pg-prod` (2026-09-22/23) el shadow siguió contestando "esa fila ya la
 * mandé" — y era CIERTO, la había mandado al destino viejo. Medido el 2026-09-23: **460 filas de
 * `kdii`** en las 9 ramas publicaban un precio que la sucursal ya no cobra (329 más barato que el
 * real, una en $0.00) y el carril decía **0 candidatas** en las nueve. No era rezago: no había
 * reintento posible.
 *
 * ⛔ POR QUÉ NO ALCANZA CON QUE "FUNCIONE". Las tres formas de que este candado sea decorativo son
 * silenciosas, y las tres tienen su prueba acá:
 *   · que resincronice en el ESTRENO (bloque 1) → un full de todo el carril hash en 9 réplicas a
 *     la vez, o sea el arreglo peor que el problema;
 *   · que una corrida EN SECO se lleve el claim (bloque 4) → la corrida real siguiente creería que
 *     el destino no cambió y no resincronizaría; el dry-run habría consumido la señal;
 *   · que quede INERTE sin identidad de destino y no lo diga (bloque 5) → apagado en silencio se
 *     lee igual que "todo bien".
 *
 * Se prueba con un cliente de pg falso: lo que puede estar mal acá es la DECISIÓN, no el SQL.
 */
const { __test } = require('../importers/kepler/replicate-ods-live');
const { ensureLocalCtl, DEST_CAMBIO, fijarDestIdent, reiniciarAviso } = __test;

let ok = 0, fail = 0;
const A = (cond, msg) => { if (cond) { ok++; console.log(`  ✔ ${msg}`); } else { fail++; console.log(`  ✖ ${msg}`); } };

/** Cliente falso: responde el SELECT de identidad y anota todo lo que se le pidió. */
function clienteFalso({ destGuardado = null, claimGana = true } = {}) {
  const hechas = [];
  return {
    hechas,
    escrituras: () => hechas.filter((q) => /INSERT|UPDATE/i.test(q.sql) && /sink_ident/i.test(q.sql)),
    async query(sql, params) {
      hechas.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (/CREATE (TABLE|SCHEMA)/i.test(sql)) return { rowCount: 0, rows: [] };
      if (/SELECT dest FROM ods\.sink_ident/i.test(sql)) {
        return destGuardado === null ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ dest: destGuardado }] };
      }
      if (/UPDATE ods\.sink_ident/i.test(sql)) return { rowCount: claimGana ? 1 : 0, rows: claimGana ? [{ dest: params[0] }] : [] };
      if (/INSERT INTO ods\.sink_ident/i.test(sql)) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    },
  };
}

(async () => {
  console.log('\n=== [NORM.3b] candado de destino del shadow ===\n');

  console.log('1) ESTRENO: siembra y NO resincroniza  ← negativa');
  DEST_CAMBIO.clear(); fijarDestIdent('pg-prod:5432/railway');
  let c = clienteFalso({ destGuardado: null });
  await ensureLocalCtl(c, '04', true);
  A(DEST_CAMBIO.get('04') !== true, 'no marca cambio la primera vez (si no, un full de 9 réplicas al desplegar)');
  A(c.hechas.some((q) => /INSERT INTO ods\.sink_ident/i.test(q.sql)), 'siembra la identidad del destino');
  A(c.hechas.some((q) => /CREATE TABLE IF NOT EXISTS ods\.sink_ident/i.test(q.sql)), 'crea la tabla si no existe');

  console.log('\n2) MISMO destino: no toca nada  ← negativa');
  DEST_CAMBIO.clear(); fijarDestIdent('pg-prod:5432/railway');
  c = clienteFalso({ destGuardado: 'pg-prod:5432/railway' });
  await ensureLocalCtl(c, '04', true);
  A(DEST_CAMBIO.get('04') !== true, 'no marca cambio cuando el destino es el mismo');
  A(c.escrituras().length === 0, 'no escribe en sink_ident cuando no cambió nada');

  console.log('\n3) DESTINO NUEVO con --apply: marca y reclama  ← la positiva');
  DEST_CAMBIO.clear(); fijarDestIdent('pg-prod:5432/railway');
  c = clienteFalso({ destGuardado: 'switchback.proxy.rlwy.net:5432/railway' });
  await ensureLocalCtl(c, '04', true);
  A(DEST_CAMBIO.get('04') === true, 'marca la rama → el carril hash ignora el shadow una pasada');
  A(c.hechas.some((q) => /UPDATE ods\.sink_ident/i.test(q.sql) && /IS DISTINCT FROM/i.test(q.sql)),
    'el claim es un UPDATE condicional (atómico entre procesos)');

  console.log('\n4) DESTINO NUEVO en SECO: avisa pero NO consume el claim  ← LA negativa que importa');
  DEST_CAMBIO.clear(); fijarDestIdent('pg-prod:5432/railway');
  c = clienteFalso({ destGuardado: 'switchback.proxy.rlwy.net:5432/railway' });
  await ensureLocalCtl(c, '04', false);
  A(DEST_CAMBIO.get('04') !== true, 'en seco NO marca la rama');
  A(c.escrituras().length === 0, 'en seco NO escribe sink_ident (si lo hiciera, la corrida real ya no resincronizaría)');

  console.log('\n5) SIN identidad de destino: inerte pero NO mudo  ← negativa');
  DEST_CAMBIO.clear(); fijarDestIdent(null); reiniciarAviso();
  const dicho = []; const log = console.log;
  console.log = (...a) => { dicho.push(a.join(' ')); };
  c = clienteFalso({ destGuardado: 'lo-que-sea' });
  await ensureLocalCtl(c, '04', true);
  console.log = log;
  A(DEST_CAMBIO.get('04') !== true, 'sin identidad no marca nada');
  A(dicho.some((l) => /INERTE/i.test(l)), 'lo DECLARA en vez de quedarse callado');

  console.log('\n6) Dos procesos a la vez: sólo uno se lleva el full  ← negativa');
  DEST_CAMBIO.clear(); fijarDestIdent('pg-prod:5432/railway');
  c = clienteFalso({ destGuardado: 'otro:5432/railway', claimGana: false }); // el otro proceso ganó
  await ensureLocalCtl(c, '07', true);
  A(DEST_CAMBIO.get('07') !== true, 'el que pierde el claim NO resincroniza (si no, 9 fulls simultáneos)');

  console.log(`\n=== ${ok} ✔ · ${fail} ✖ ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
