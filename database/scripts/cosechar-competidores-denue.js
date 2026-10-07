/* eslint-disable no-console */
/**
 * `[PR.M4]` — Cosecha inicial de **competidores mayoristas** desde INEGI DENUE.
 *
 *   node database/scripts/cosechar-competidores-denue.js --fetch competidores.json
 *   node database/scripts/cosechar-competidores-denue.js --load  competidores.json [--apply]
 *
 * ── ⛔ Por qué DOS pasos y no uno ─────────────────────────────────────────────────────────
 * El token de DENUE vive en el `.env` de la máquina de trabajo; prod corre en otro servidor y
 * desde la máquina de trabajo la base es **de sólo lectura**. Hacerlo en un solo paso obliga a
 * mandarle el token al servidor por línea de comando, donde queda en el historial del shell y en
 * la lista de procesos. **Se parte en dos: el token nunca sale de donde ya estaba.**
 * El archivo intermedio es un censo público (dato abierto de INEGI): no lleva secretos.
 *
 * ⚠️ Esto es la cosecha **inicial**. La recurrente es el endpoint
 * `POST /commercial-map/prospects/ingest-competitors`, que hace lo mismo con el mismo upsert.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); }
catch { /* en el contenedor la URL ya viene del entorno */ }

const MODO = process.argv.includes('--fetch') ? 'fetch'
  : process.argv.includes('--load') ? 'load' : null;
const ARCHIVO = process.argv[process.argv.indexOf('--' + MODO) + 1];
const APLICAR = process.argv.includes('--apply');
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

const BASE = 'https://www.inegi.org.mx/app/api/denue/v1/consulta';
// Clases de MAYOREO. Las que el módulo de prospección ya usa (461160/461110/462112) son de
// MENUDEO: esos son clientes posibles, no competencia.
const CLASES = ['431180', '431110', '431199'];
const ENTIDADES = { 16: 'Michoacán', 11: 'Guanajuato', 14: 'Jalisco' };

/** DENUE nos ve a nosotros. Una unidad propia no es prospecto ni competencia. */
const esNuestra = (u) => /megadulces/i.test(`${u.Correo_e || ''} ${u.Sitio_internet || ''}`)
  || /^mega dulces/i.test(u.Nombre || '');

/** El código SCIAN no viene como campo: vive dentro del CLEE, posiciones 6 a 11. */
const scianDeClee = (clee) => (typeof clee === 'string' && clee.length >= 11 ? clee.slice(5, 11) : null);

async function cosechar() {
  const token = process.env.DENUE_TOKEN;
  if (!token) throw new Error('falta DENUE_TOKEN');
  const todo = [];
  for (const ent of Object.keys(ENTIDADES)) {
    for (const clase of CLASES) {
      for (let p = 0; p < 20; p++) {
        const ini = p * 100 + 1;
        const url = `${BASE}/BuscarAreaAct/${ent}/0/0/0/0/0/0/0/${clase}/0/${ini}/${ini + 99}/0/${token}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error('DENUE HTTP ' + r.status);
        let u = [];
        try { u = JSON.parse(await r.text()); } catch { u = []; }
        if (!u.length) break;
        u.forEach((x) => todo.push(x));
        if (u.length < 100) break;
      }
    }
    console.log(`  ${ENTIDADES[ent]}: ${todo.length} acumuladas`);
  }
  const propias = todo.filter(esNuestra);
  console.log(`\ntotal ${todo.length} · nuestras ${propias.length} · competencia ${todo.length - propias.length}`);
  propias.forEach((x) => console.log('  propia: ' + (x.Nombre || '')));
  fs.writeFileSync(ARCHIVO, JSON.stringify(todo));
  console.log(`\nescrito ${ARCHIVO} (${(fs.statSync(ARCHIVO).size / 1024).toFixed(0)} KB) — sin secretos adentro`);
}

async function cargar() {
  const { Client } = require('pg');
  const unidades = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
  console.log(`leidas ${unidades.length} unidades de ${ARCHIVO}`);
  const filas = unidades.filter((u) => u.Id).map((u) => ({
    source_ref: String(u.Id),
    rol: esNuestra(u) ? 'propio' : 'competidor',
    nombre: u.Nombre || null,
    razon_social: u.Razon_social || null,
    scian: scianDeClee(u.CLEE),
    scian_label: u.Clase_actividad || null,
    estrato: u.Estrato || null,
    tipo: u.Tipo || null,
    lat: u.Latitud ? Number(u.Latitud) : null,
    lng: u.Longitud ? Number(u.Longitud) : null,
    calle: u.Calle || null,
    num_ext: u.Num_Exterior || null,
    colonia: u.Colonia || null,
    cp: u.CP || null,
    municipio: (u.Ubicacion || '').split(',')[1]?.trim() || null,
    entidad: typeof u.CLEE === 'string' ? u.CLEE.slice(0, 2) : null,
    telefono: u.Telefono || null,
    email: u.Correo_e || null,
    web: u.Sitio_internet || null,
    raw: JSON.stringify(u),
  }));
  const sinScian = filas.filter((f) => !f.scian).length;
  console.log(`  a cargar ${filas.length} · propias ${filas.filter((f) => f.rol === 'propio').length}`
    + ` · sin SCIAN legible ${sinScian}`);
  if (sinScian > filas.length * 0.05) {
    throw new Error('mas del 5% sin SCIAN legible: el CLEE cambio de forma, NO se carga a ciegas');
  }
  if (!APLICAR) { console.log('\nnada escrito. Volve a correr con --apply.'); return; }

  const db = new Client({ connectionString: process.env.DATABASE_URL_NEW });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
    const COLS = 21;
    const LOTE = 200;
    let n = 0;
    for (let i = 0; i < filas.length; i += LOTE) {
      const trozo = filas.slice(i, i + LOTE);
      const vals = [];
      const args = [];
      trozo.forEach((f, j) => {
        const b = j * COLS;
        vals.push('(' + Array.from({ length: COLS }, (_, x) => '$' + (b + x + 1)).join(',') + ')');
        args.push(TENANT, 'denue', f.source_ref, f.rol, f.nombre, f.razon_social, f.scian,
          f.scian_label, f.estrato, f.tipo, f.lat, f.lng, f.calle, f.num_ext, f.colonia,
          f.cp, f.municipio, f.entidad, f.telefono, f.email, f.web);
      });
      await db.query(`
        INSERT INTO commercial.prospect_stores
          (tenant_id, source, source_ref, rol, nombre, razon_social, scian, scian_label,
           estrato, tipo, lat, lng, calle, num_ext, colonia, cp, municipio, entidad,
           telefono, email, web)
        VALUES ${vals.join(',')}
        ON CONFLICT (tenant_id, source, source_ref) DO UPDATE SET
          rol = CASE WHEN commercial.prospect_stores.rol = 'propio' THEN 'propio' ELSE EXCLUDED.rol END,
          nombre = EXCLUDED.nombre, razon_social = EXCLUDED.razon_social,
          scian = EXCLUDED.scian, scian_label = EXCLUDED.scian_label,
          estrato = EXCLUDED.estrato, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
          calle = EXCLUDED.calle, colonia = EXCLUDED.colonia, cp = EXCLUDED.cp,
          municipio = EXCLUDED.municipio, entidad = EXCLUDED.entidad,
          telefono = EXCLUDED.telefono, email = EXCLUDED.email, web = EXCLUDED.web,
          last_seen_at = now(), updated_at = now()`, args);
      n += trozo.length;
    }

    // Cuántos puntos NUESTROS rodea cada competidor. Es lo que separa a un rival que respira
    // sobre nuestros clientes de uno que está a 200 km.
    // ⚠️ Es un PISO: los clientes sin coordenadas no se pueden contar.
    const prop = (await db.query(`
      SELECT latitude::float lat, longitude::float lng FROM commercial.customers
      WHERE tenant_id=$1 AND deleted_at IS NULL AND latitude IS NOT NULL
      UNION ALL
      SELECT latitud::float, longitud::float FROM stores
      WHERE tenant_id=$1 AND deleted_at IS NULL AND latitud IS NOT NULL`, [TENANT])).rows
      .filter((p) => !isNaN(p.lat) && !isNaN(p.lng));
    const comp = (await db.query(`
      SELECT id, lat::float lat, lng::float lng FROM commercial.prospect_stores
      WHERE tenant_id=$1 AND rol='competidor' AND lat IS NOT NULL`, [TENANT])).rows;
    const hav = (a1, o1, a2, o2) => {
      const R = 6371000; const t = (x) => (x * Math.PI) / 180;
      const dA = t(a2 - a1); const dO = t(o2 - o1);
      const h = Math.sin(dA / 2) ** 2 + Math.cos(t(a1)) * Math.cos(t(a2)) * Math.sin(dO / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    };
    if (prop.length) {
      for (const c of comp) {
        let n1 = 0; let n5 = 0; let cerca = Infinity;
        for (const p of prop) {
          const d = hav(c.lat, c.lng, p.lat, p.lng);
          if (d < cerca) cerca = d;
          if (d <= 1000) n1++;
          if (d <= 5000) n5++;
        }
        await db.query(`UPDATE commercial.prospect_stores
          SET propios_1km=$2, propios_5km=$3, nearest_customer_m=$4,
              proximidad_medida_at=now(), updated_at=now() WHERE id=$1`,
        [c.id, n1, n5, isFinite(cerca) ? Math.round(cerca) : null]);
      }
      console.log(`  proximidad medida contra ${prop.length} puntos propios (es un PISO: `
        + 'los que no tienen coordenadas no se pudieron contar)');
    } else {
      console.log('  — NO MEDIDO: ningun punto propio tiene coordenadas, la proximidad queda NULL');
    }
    await db.query('COMMIT');
    console.log(`\nOK · ${n} unidades · ${comp.length} competidores con proximidad`);
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    await db.end();
  }
}

(async () => {
  if (!MODO || !ARCHIVO) throw new Error('uso: --fetch <archivo.json> | --load <archivo.json> [--apply]');
  void crypto;
  if (MODO === 'fetch') await cosechar(); else await cargar();
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
