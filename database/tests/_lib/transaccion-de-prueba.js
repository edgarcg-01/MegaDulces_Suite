'use strict';
/**
 * `[CANON.6.8]` Cliente que vive DENTRO de la transacción de una prueba, para ejercer código que abre y
 * cierra sus propias transacciones (los normalizadores del hop-2, `applyRawUpsert`) sin que nada quede
 * escrito: la prueba hace `BEGIN` con el cliente real, le pasa ESTE cliente al código, y al final `ROLLBACK`.
 *
 *   BEGIN    → SAVEPOINT
 *   COMMIT   → RELEASE SAVEPOINT, y al cerrar el nivel de afuera suelta las tablas temporales (lo que
 *              haría `ON COMMIT DROP`; si no, la segunda llamada choca con «la relación ya existe»)
 *   ROLLBACK → ROLLBACK TO SAVEPOINT
 *   una sentencia suelta, fuera de un BEGIN, va en su propio savepoint: si falla, la transacción de la
 *   prueba sigue viva (sin esto, un error atrapado en JS la deja abortada con 25P02).
 *
 * Lo usan `test-newdb-markup-por-evento.js` y `test-newdb-promo-por-evento.js`.
 *
 * @param {import('pg').Client} c el cliente real, con la transacción de la prueba ya abierta
 */
function dentroDeLaPrueba(c) {
  const pila = []; let n = 0;
  const soltarTemporales = `DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT relname FROM pg_class WHERE relnamespace = pg_my_temp_schema() AND relkind = 'r'
      LOOP EXECUTE format('DROP TABLE pg_temp.%I', r.relname); END LOOP; END $$`;
  const vacio = { rows: [], rowCount: 0 };
  return {
    async query(sql, params) {
      const k = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
      if (k === 'BEGIN') { const sp = `sp_${++n}`; pila.push(sp); await c.query(`SAVEPOINT ${sp}`); return vacio; }
      if (k === 'COMMIT') {
        const sp = pila.pop();
        if (sp) await c.query(`RELEASE SAVEPOINT ${sp}`);
        if (!pila.length) await c.query(soltarTemporales);
        return vacio;
      }
      if (k === 'ROLLBACK') {
        const sp = pila.pop();
        if (sp) { await c.query(`ROLLBACK TO SAVEPOINT ${sp}`); await c.query(`RELEASE SAVEPOINT ${sp}`); }
        return vacio;
      }
      if (pila.length) return c.query(sql, params);
      const sp = `sq_${++n}`;
      await c.query(`SAVEPOINT ${sp}`);
      try { const r = await c.query(sql, params); await c.query(`RELEASE SAVEPOINT ${sp}`); return r; }
      catch (e) { await c.query(`ROLLBACK TO SAVEPOINT ${sp}`); await c.query(`RELEASE SAVEPOINT ${sp}`); throw e; }
    },
  };
}

module.exports = { dentroDeLaPrueba };
