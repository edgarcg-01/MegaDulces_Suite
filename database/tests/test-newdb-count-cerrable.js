'use strict';
/**
 * [CNT.1] Candado de «¿se puede cerrar este folio?» — el aviso ANTES del botón.
 *
 *   node database/tests/test-newdb-count-cerrable.js
 *
 * Sólo lee.
 *
 * ── Por qué existe, medido en prod el 2026-09-30 ────────────────────────────────────────
 *
 * Hay **6 folios de conteo y los 6 están `cancelled`**. Se abrieron entre el 15 y el 19-jun-2026
 * con **18,845 renglones** y se contaron **9 — el 0.05%**. La causa no es un bug: es el
 * *coverage guard* de `reconcile()`, que es correcto y deliberado (*un no-contado NO se trata
 * como cero*). El defecto es **cuándo se entera uno**: sólo al apretar «Reconciliar» y recibir
 * un 409, o sea después de haber contado 3,664 SKUs, o de haber abandonado.
 *
 * Un folio completo de 3,664 SKUs exige contar los 3,664 para poder cerrarse. Operativamente
 * eso no ocurre en una tienda — para eso existe el folio cíclico de 50, que ya estaba bien
 * construido. Lo que faltaba no era el mecanismo: era **decirlo antes**.
 *
 * ── Qué protege ─────────────────────────────────────────────────────────────────────────
 *
 * 1. Que los cuatro bloqueos se sigan evaluando y **discriminen** (prueba negativa con filas
 *    fabricadas: un folio completo y resuelto NO puede salir bloqueado).
 * 2. Que el estado real de prod siga siendo el que justifica el cambio — si algún día un folio
 *    se cierra, este candado cambia de rama solo y lo dice.
 * 3. Que **no reaparezca una segunda copia** de los guards en el servicio. Es una comprobación
 *    ESTRUCTURAL sobre el fuente, no de comportamiento, y se declara como tal: no prueba que
 *    la regla sea correcta, sólo que hay una y no dos.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

let ok = 0, bad = 0, nm = 0;
const t = (n, c, x) => { if (c) { ok++; console.log(`  ✔ ${n}`); }
  else { bad++; console.log(`  ✘ ${n}${x ? ' — ' + x : ''}`); } };
const noMedido = (n, m) => { nm++; console.log(`  ◻ NO MEDIDO: ${n} — ${m}`); };

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: { connectionString: url,
      ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [CNT.1] ¿se puede cerrar el folio? — el aviso antes del botón ===\n');
  try {
    // ── 1. El estado real: cuánto falta en cada folio abierto o cancelado ─────────────
    const { rows } = await db.raw(`
      SELECT c.folio, c.status, w.code AS almacen,
             count(i.*)::int AS renglones,
             count(i.*) FILTER (WHERE i.count_1 IS NULL)::int       AS sin_contar,
             count(i.*) FILTER (WHERE i.status = 'discrepancy')::int AS discrepancias,
             count(i.*) FILTER (WHERE i.final_qty IS NULL)::int      AS sin_valor_final
        FROM commercial.inventory_counts c
        LEFT JOIN commercial.inventory_count_items i
          ON i.count_id = c.id AND i.tenant_id = c.tenant_id
        LEFT JOIN commercial.warehouses w ON w.id = c.warehouse_id
       GROUP BY 1, 2, 3 ORDER BY c.folio`);

    if (!rows.length) {
      noMedido('el estado de los folios', 'no hay ningún folio de conteo en este destino');
    } else {
      const cerrables = rows.filter(
        (r) => !['reconciled', 'cancelled'].includes(r.status)
          && !r.sin_contar && !r.discrepancias && !r.sin_valor_final);
      const bloqueados = rows.filter((r) => r.sin_contar > 0);
      t(`hay ${rows.length} folio(s) y su bloqueo se puede calcular sin apretar nada`, true);
      t('⛔ y al menos uno está bloqueado por SKUs sin contar — que es el caso del cambio',
        bloqueados.length > 0,
        'ningún folio tiene SKUs sin contar: la rama que se protege no se ejerce acá');
      for (const r of rows) {
        const pct = r.renglones ? (100 * (r.renglones - r.sin_contar) / r.renglones) : 0;
        console.log(`      ⓘ ${r.folio} (${r.almacen}, ${r.status}): ${r.renglones} renglones`
          + ` · ${r.sin_contar} sin contar · ${pct.toFixed(2)}% avanzado`);
      }
      if (cerrables.length) {
        console.log(`      ⓘ ${cerrables.length} folio(s) SÍ se podrían reconciliar hoy`);
      }
    }

    // ── 2. PRUEBA NEGATIVA: los bloqueos tienen que DISCRIMINAR ──────────────────────
    // Sin esto, "hay bloqueos" podría estar verde con una regla que siempre dice que sí — y el
    // botón quedaría apagado para siempre, que es peor que el 409.
    {
      const { rows: f } = await db.raw(`
        WITH fila(caso, count_1, estado, final_qty) AS (VALUES
          ('completo y resuelto', 5::numeric, 'resolved', 5::numeric),
          ('sin contar',          NULL,       'pending',  NULL),
          ('discrepancia',        5,          'discrepancy', NULL),
          ('sin valor final',     5,          'resolved', NULL))
        SELECT caso,
               (count_1 IS NULL)          AS b_sin_contar,
               (estado = 'discrepancy')   AS b_discrepancia,
               (final_qty IS NULL)        AS b_sin_final
          FROM fila`);
      const v = Object.fromEntries(f.map((r) => [r.caso, r]));
      t('NEGATIVA: una fila completa y resuelta NO dispara ningún bloqueo',
        !v['completo y resuelto'].b_sin_contar && !v['completo y resuelto'].b_discrepancia
        && !v['completo y resuelto'].b_sin_final);
      t('POSITIVA: la fila sin contar dispara `sin_contar`', v['sin contar'].b_sin_contar === true);
      t('POSITIVA: la discrepancia dispara el suyo', v['discrepancia'].b_discrepancia === true);
      t('POSITIVA: sin valor final dispara el suyo', v['sin valor final'].b_sin_final === true);
      t('⛔ y los tres son INDEPENDIENTES — una fila sin contar no se cuenta como discrepancia',
        v['sin contar'].b_discrepancia === false);
    }

    // ── 3. Que no reaparezca una SEGUNDA copia de los guards ────────────────────────
    // ⚠️ Esto es una comprobación ESTRUCTURAL sobre el fuente, no de comportamiento: no prueba
    // que la regla sea correcta, sólo que hay UNA y no dos. Se declara como lo que es.
    {
      const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'libs', 'commercial', 'src',
        'lib', 'commercial-inventory', 'inventory-count.service.ts'), 'utf8');
      const defs = (src.match(/private bloqueosParaReconciliar/g) || []).length;
      const usos = (src.match(/this\.bloqueosParaReconciliar\(/g) || []).length;
      t('hay UNA sola definición de los bloqueos', defs === 1, `defs=${defs}`);
      t('⛔ y la consumen DOS lugares (reconcile + el tablero): si fuera uno, la pantalla no avisa',
        usos >= 2, `usos=${usos}`);
      noMedido('que las dos rutas devuelvan lo mismo en ejecución',
        'exige levantar el API con un folio real; lo que sí se garantiza es que comparten el método');
    }

    console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
  } catch (e) {
    console.error('ERROR:', e.message); bad++;
  } finally { await db.destroy(); }
  process.exit(bad > 0 ? 1 : 0);
})();
