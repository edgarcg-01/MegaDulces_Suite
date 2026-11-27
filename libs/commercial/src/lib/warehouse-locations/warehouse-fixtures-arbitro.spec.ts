import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { ARBITRO_CARA_POR_SLOT } from './warehouse-fixtures.arbitros';

/**
 * `[UB.PL.14]` El árbitro del `ON CONFLICT` tiene que seguir describiendo al índice REAL.
 *
 * ── El defecto que esto caza, vivido en prod el 2026-11-26 y 27 ─────────────────────────────
 * `[UB.PL.12]` cambió el índice único de las caras de `(tenant_id, fixture_id, cara)` a
 * `(tenant_id, fixture_id, slot)`, **parcial** (`WHERE deleted_at IS NULL`), y dejó el
 * `ON CONFLICT` del servicio nombrando sólo las tres columnas. Postgres acepta un índice parcial
 * como árbitro **sólo si la cláusula repite su predicado**, así que todos los caminos que
 * insertan una cara —derivar, crear una pieza, agregar una cara— devolvían 500. El croquis
 * estuvo **muerto para escritura un día entero** y nadie lo vio, porque el botón que lo dispara
 * estaba escondido detrás de `@if (!piezasDeZona().length)`.
 *
 * ⭐ **Por qué esta prueba lee la MIGRACIÓN y no repite la consulta.** Un test que vuelve a
 * escribir el `INSERT … ON CONFLICT` se pone verde con la lógica equivocada: copiaría el mismo
 * error. Lo único que prueba algo es atar las dos puntas — lo que el servicio manda contra lo
 * que la base tiene — y que se rompa si alguien cambia una sin la otra.
 *
 * ⛔ Lo que esta prueba NO puede hacer: comprobar que Postgres lo acepta. Eso se ejerció a mano
 * contra la base real de prod, dentro de una transacción con `ROLLBACK`, con su control negativo
 * (sin el predicado falla con el mismo mensaje que daba producción).
 */
describe('[UB.PL.14] el árbitro del ON CONFLICT describe al índice real', () => {
  // La raíz del repo se BUSCA subiendo, no se arma con `__dirname` ni con un `../../..` contado a
  // mano: vitest corre este archivo con distinto cwd según se invoque la lib sola o el monorepo.
  const raiz = (() => {
    let d = process.cwd();
    for (let i = 0; i < 8; i++) {
      if (existsSync(join(d, 'database', 'migrations-newdb'))) return d;
      const arriba = dirname(d);
      if (arriba === d) break;
      d = arriba;
    }
    throw new Error('no encuentro database/migrations-newdb subiendo desde ' + process.cwd());
  })();
  const MIGRACION = join(raiz, 'database/migrations-newdb/20261126171303_ub_pl12_la_cara_se_configura.js');
  const sql = readFileSync(MIGRACION, 'utf8');

  /** El `CREATE UNIQUE INDEX … commercial_faces_slot_unico …` tal como lo escribe la migración. */
  const definicion = (() => {
    const i = sql.indexOf('commercial_faces_slot_unico');
    // ⛔ Un `expect` acá NO corre: fuera de un `it` no hay contexto y vitest muere antes de
    // ejecutar una sola prueba, con «Cannot read properties of undefined». Se lanza a mano.
    if (i < 0) throw new Error('la migración de [UB.PL.12] ya no crea commercial_faces_slot_unico');
    return sql.slice(i, sql.indexOf('`', i)).replace(/\s+/g, ' ');
  })();

  it('⭐ el índice es PARCIAL, que es de donde nace todo el problema', () => {
    expect(definicion.toUpperCase()).toContain('WHERE DELETED_AT IS NULL');
  });

  it('⭐ el árbitro nombra las MISMAS columnas que el índice, en el mismo orden', () => {
    const delIndice = definicion.slice(definicion.indexOf('(') + 1, definicion.indexOf(')'));
    const columnas = delIndice.split(',').map((c) => c.trim());
    expect(columnas).toEqual(['tenant_id', 'fixture_id', 'slot']);
    const delArbitro = ARBITRO_CARA_POR_SLOT.slice(1, ARBITRO_CARA_POR_SLOT.indexOf(')'))
      .split(',')
      .map((c) => c.trim());
    expect(delArbitro).toEqual(columnas);
  });

  it('⛔ y repite su predicado: sin esto Postgres NO lo acepta como árbitro', () => {
    expect(ARBITRO_CARA_POR_SLOT.toUpperCase()).toContain('WHERE DELETED_AT IS NULL');
  });

  it('el árbitro viaja entre paréntesis, porque knex lo inserta tal cual en el ON CONFLICT', () => {
    expect(ARBITRO_CARA_POR_SLOT.startsWith('(')).toBe(true);
    expect(ARBITRO_CARA_POR_SLOT).toMatch(/^\([^)]+\)\s+WHERE\s/i);
  });
});
