#!/usr/bin/env node
'use strict';
/**
 * `[CP.8.23]` — **La lista acotada de proveedores que falta enlazar a su cuenta de ContPAQi.**
 *
 * ── De dónde sale la pregunta ───────────────────────────────────────────────────────────────
 * `[CP.8.21]` midió que 216 movimientos de enero se rechazan con `proveedor_sin_cuenta`: el
 * armador no sabe **a qué proveedor** le estamos pagando.
 *
 * ⭐ El primer intento fue el equivocado: enganchar el **movimiento bancario** al pago. Da 57.8 %
 * de enganche (216× el placebo) pero sólo **8.6 %** llega a una cuenta, porque el RFC que Kepler
 * guarda viene vacío en el 74 % y sucio en el resto (`CCO-820507-BV` truncado y con guiones
 * contra `CCO820507BV4`; `DC9181011CK5` contra `DCP181011CK5`).
 *
 * ⭐⭐ El replanteo: **la contadora no adivina el proveedor mirando el estado de cuenta — lo lee
 * del pago registrado en Kepler.** Así que la fuente del asiento de pago a proveedor no es el
 * movimiento bancario: es `analytics.erp_supplier_payments`, que trae el **nombre** del
 * proveedor aunque el RFC falte.
 *
 * Medido ene–feb 2026 (1,030 pagos · $97,729,712.85):
 *
 * | vía | pagos | % | importe |
 * |---|--:|--:|--:|
 * | RFC exacto | 197 | 19.1 | $45,742,440.01 |
 * | nombre normalizado (un solo tercero) | 138 | 13.4 | $25,353,361.88 |
 * | **nombre ambiguo** | **0** | 0 | — |
 * | sin resolver | 695 | 67.5 | $26,633,910.96 |
 *
 * **32.5 % de los pagos pero 72.7 % del importe** — los grandes resuelven. Y **cero ambigüedad**:
 * acá el nombre sí discrimina, al revés que en `[CP.8.20]` (donde se emparejaban cuentas contra
 * proveedores dentro del mismo catálogo y PASCUAL colapsaba con una persona física).
 *
 * ── ⭐ Lo que entrega este script: una tarea humana ACOTADA ─────────────────────────────────
 * Lo que falta **no son datos faltantes, son ALIAS**:
 *
 *     EFFEM MEXICO INC. Y COMPAÑÍAS EN N.C DE CV   vs  EFFEM MEXICO INC Y COMPAÑIA S EN NC DE CV
 *     TRESMONTES LUCHETTI (NUTRESA)                vs  TRESMONTES LUCCHETTI MEXICO SA DE CV
 *     DIST CABADAS DE LA PIEDAD SA DE CV           vs  DISTRIBUCIONES CABADAS DE LA PIEDAD SA DE CV
 *     ABARROTES LA VIOLETA                         vs  ABARROTES LA VIOLETA SA DE CV
 *
 * ⛔ **No se resuelven normalizando más fuerte.** Ya está medido en `[CP.8.20]` que pasado cierto
 * punto la normalización empieza a emparejar terceros distintos. Se resuelven con un **alias que
 * alguien escribe una vez**.
 *
 * ⭐ Y la lista es chica: **136 nombres distintos, y los primeros 33 cubren el 80 % del importe
 * que falta.** Treinta y tres líneas llevan la cobertura de 72.7 % a ~94.5 % del dinero.
 *
 * ⚠️ **Hallazgo colateral: 5 nombres llegan con la Ñ rota** (`CONSERVAS LA COSTE?A`). Es un
 * problema de codificación en la ingesta de Kepler, no del enlace — y hay que arreglarlo allá,
 * porque ningún alias debería tener que escribirse contra un carácter corrupto.
 *
 * READ-ONLY. No escribe en ninguna base.
 *
 *   node database/scripts/proveedores-sin-cuenta-contpaqi.js
 *   node database/scripts/proveedores-sin-cuenta-contpaqi.js --desde 2026-01-01 --hasta 2026-10-01 --top 50
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Client } = require('pg');

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const DESDE = arg('desde', '2026-01-01');
const HASTA = arg('hasta', '2026-03-01');
const TOP = Number(arg('top', 33));

/** Misma normalización que `import-contpaqi-account-map.js`: la puntuación interna se BORRA. */
const norm = (s) => (s || '').trim().toUpperCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’.]/g, '')
  .replace(/[,"()\-/]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const mx = (v) => v.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL_NEW });
  await pg.connect();
  const { rows: pagos } = await pg.query(
    `SELECT proveedor_nombre, upper(btrim(coalesce(proveedor_rfc,''))) rfc,
            count(*)::int n, sum(monto)::float8 monto
       FROM analytics.erp_supplier_payments
      WHERE pago_date >= $1 AND pago_date < $2
      GROUP BY 1, 2`, [DESDE, HASTA]);
  const { rows: sa } = await pg.query(
    `SELECT cuenta, cuenta_nombre, proveedor_nombre, upper(btrim(coalesce(rfc,''))) rfc
       FROM contpaqi.supplier_accounts
      WHERE veredicto IN ('confirmado','uuid_solido')`);
  await pg.end();

  const porNombre = new Map();
  for (const r of sa) {
    for (const nom of [r.cuenta_nombre, r.proveedor_nombre]) {
      const k = norm(nom);
      if (!k) continue;
      if (!porNombre.has(k)) porNombre.set(k, new Map());
      porNombre.get(k).set(r.rfc || '(sin rfc)', r);
    }
  }
  const porRfc = new Map();
  for (const r of sa) if (r.rfc) porRfc.set(r.rfc, r);

  let resueltos = 0; let mResueltos = 0; let total = 0; let mTotal = 0;
  const falta = new Map();
  for (const p of pagos) {
    total += p.n; mTotal += p.monto;
    const hit = (p.rfc && porRfc.get(p.rfc))
      || (() => { const c = porNombre.get(norm(p.proveedor_nombre)); return c && c.size === 1 ? [...c.values()][0] : null; })();
    if (hit) { resueltos += p.n; mResueltos += p.monto; continue; }
    const k = (p.proveedor_nombre || '(sin nombre)').trim();
    const a = falta.get(k) || { pagos: 0, monto: 0, rfc: p.rfc || '' };
    a.pagos += p.n; a.monto += p.monto;
    falta.set(k, a);
  }

  console.log(`\n[CP.8.23] pagos a proveedor ${DESDE} -> ${HASTA}: ${total} · ${mx(mTotal)}`);
  console.log(`cuentas de proveedor utilizables en el mapa: ${sa.length}`);
  console.log(`RESUELTO: ${((100 * resueltos) / total).toFixed(1)}% de los pagos`
    + ` · ${((100 * mResueltos) / mTotal).toFixed(1)}% del importe\n`);

  const lista = [...falta.entries()].sort((a, b) => b[1].monto - a[1].monto);
  const mFalta = lista.reduce((s, x) => s + x[1].monto, 0);
  let acc = 0; let n80 = 0;
  for (const [, v] of lista) { acc += v.monto; n80 += 1; if (acc >= 0.8 * mFalta) break; }

  console.log(`SIN RESOLVER: ${lista.length} nombres distintos · ${mx(mFalta)}`);
  console.log(`⭐ los primeros ${n80} cubren el 80% de ese importe\n`);

  let corr = 0;
  const tabla = lista.slice(0, TOP).map(([nombre, v], i) => {
    if (nombre.includes('?')) corr += 1;
    return {
      '#': i + 1,
      nombre_en_kepler: nombre,
      rfc_kepler: v.rfc || '(sin)',
      pagos: v.pagos,
      importe: mx(v.monto),
      // ⭐ La columna que el humano llena. Vacía a propósito: proponer un candidato acá
      // invitaría a aceptarlo sin mirar, y ya se midió que el nombre engaña.
      cuenta_contpaqi: '',
    };
  });
  console.table(tabla);
  const rotos = lista.filter(([k]) => k.includes('?')).length;
  if (rotos) {
    console.log(`⚠️ ${rotos} nombre(s) llegan con la Ñ rota (ej. "COSTE?A"): es codificación en la`
      + ' ingesta de Kepler, se arregla allá — no con un alias contra un carácter corrupto.');
  }
  void corr;
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
