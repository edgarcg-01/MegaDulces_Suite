/**
 * FKJ (hardening) — realinea las FK que quedaron en `ON DELETE NO ACTION` (default de Postgres,
 * no decisión) a la regla semántica del codebase:
 *   - columna FK NULLABLE  → `ON DELETE SET NULL`   (opcional: perder el padre nulifica; el NULL ya es válido)
 *   - columna FK NOT NULL  → `ON DELETE RESTRICT`   (atributo requerido: protege, no borres el padre con hijos)
 * (CASCADE no se auto-asigna: las composiciones que lo necesitan ya lo tienen; ninguna de estas lo es.)
 * `ON UPDATE` se deja NO ACTION (el PK uuid es inmutable → nunca dispara).
 *
 * Ninguna FK dispara hoy (las dims son soft-delete) → el cambio es de CONVENCIÓN, cero riesgo de datos.
 * Data-driven: al aplicar, busca las FK `confdeltype='a'` en los schemas de app y las realinea. Salta
 * tablas backup (`*_snapshot_bak`, `*_backup_*`). Para FK compuestas `(tenant_id, col)` usa la sintaxis
 * PG≥15 `SET NULL (col)` para NO nular `tenant_id`. Idempotente (tras correr, ya no son NO ACTION →
 * un re-run no encuentra nada). NO TRANSACCIONAL: cada FK autocommittea (DROP+ADD toma ACCESS EXCLUSIVE
 * brevísimo por tabla y lo suelta; VALIDATE usa lock débil que NO bloquea INSERT/UPDATE de los feeds).
 * En una transacción, los ACCESS EXCLUSIVE de las 69 tablas se acumularían hasta el commit → bloqueo.
 *
 * @param { import("knex").Knex } knex
 */
exports.config = { transaction: false };

const SCHEMAS = ['commercial', 'analytics', 'finance', 'catalog', 'logistics', 'hr', 'fiscal', 'identity', 'trade', 'public'];
const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';

exports.up = async function (knex) {
  const fks = (await knex.raw(`
    SELECT con.conname, ns.nspname AS sch, rel.relname AS tab, fns.nspname AS fsch, frel.relname AS ftab,
           (SELECT string_agg(a.attname, ',' ORDER BY x.ord)
              FROM unnest(con.conkey) WITH ORDINALITY x(attnum,ord)
              JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=x.attnum) AS cols,
           (SELECT string_agg(a.attname, ',' ORDER BY x.ord)
              FROM unnest(con.confkey) WITH ORDINALITY x(attnum,ord)
              JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=x.attnum) AS fcols
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid=con.conrelid
      JOIN pg_namespace ns ON ns.oid=rel.relnamespace
      JOIN pg_class frel ON frel.oid=con.confrelid
      JOIN pg_namespace fns ON fns.oid=frel.relnamespace
     WHERE con.contype='f' AND con.confdeltype='a' AND ns.nspname = ANY(?)
     ORDER BY ns.nspname, rel.relname, con.conname`, [SCHEMAS])).rows;

  let restrict = 0, setnull = 0, skipped = 0;
  const notValidated = [];
  for (const fk of fks) {
    if (/_snapshot_bak$/.test(fk.tab) || /_backup_/.test(fk.tab)) { skipped++; continue; }
    const cols = fk.cols.split(',');
    const fcols = fk.fcols.split(',');
    const biz = cols.filter((x) => x !== 'tenant_id');

    let nullable = false;
    for (const bc of biz) {
      const r = (await knex.raw(
        `SELECT is_nullable FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?`,
        [fk.sch, fk.tab, bc])).rows[0];
      if (r && r.is_nullable === 'YES') nullable = true;
    }
    const composite = cols.length > 1;
    const onDel = !nullable ? 'RESTRICT'
      : (composite ? `SET NULL (${biz.map(q).join(',')})` : 'SET NULL');

    const colList = cols.map(q).join(',');
    const fcolList = fcols.map(q).join(',');
    const tbl = `${q(fk.sch)}.${q(fk.tab)}`;
    await knex.raw(`ALTER TABLE ${tbl} DROP CONSTRAINT ${q(fk.conname)}`);
    await knex.raw(
      `ALTER TABLE ${tbl} ADD CONSTRAINT ${q(fk.conname)} FOREIGN KEY (${colList})
         REFERENCES ${q(fk.fsch)}.${q(fk.ftab)} (${fcolList}) ON DELETE ${onDel} NOT VALID`);
    if (nullable) setnull++; else restrict++;
    // La regla (ON DELETE) YA quedó realineada con el ADD. El VALIDATE solo marca la FK como
    // verificada; si la tabla tiene huérfanos legacy (ej. product_sales_daily, productos borrados)
    // falla → se deja NOT VALID (igual enforcea escrituras nuevas, tolera los viejos), como estaba
    // antes. NO abortar el realineado del resto por eso.
    try {
      await knex.raw(`ALTER TABLE ${tbl} VALIDATE CONSTRAINT ${q(fk.conname)}`);
    } catch (e) {
      notValidated.push(`${fk.sch}.${fk.tab}.${fk.conname}`);
      // eslint-disable-next-line no-console
      console.log(`  ⚠ ${fk.sch}.${fk.tab}.${fk.conname}: realineada a ${onDel} pero queda NOT VALID (${e.message.slice(0, 60)})`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[realign FK] ${restrict} RESTRICT · ${setnull} SET NULL · ${skipped} backups saltados · ${notValidated.length} NOT VALID (huérfanos)`);
};

// Downgrade: revertir a NO ACTION sería un retroceso de convención. No-op (el estado realineado es
// estrictamente mejor y no cambia comportamiento — las dims son soft-delete).
exports.down = function () { return Promise.resolve(); };
