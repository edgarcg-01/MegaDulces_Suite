'use strict';
/**
 * Fase WR-hist — inventario del corpus HISTÓRICO Wincaja (Access 97 por año) → Postgres local.
 *
 * Complementa `wincaja-replica-config.js` (carril VIVO, carpeta `Actuales`, schemas `wNN`, CDC continuo).
 * Este describe el carril HISTÓRICO: one-shot por (sucursal, corte), schemas `hNN`, sin CDC.
 *
 * ── Los dos hechos que definen el diseño (verificados 2026-09-01, sucursal 32) ──────────────────
 * 1. Cada carpeta `Z:\Salidas\Bases\<año>` es el corte de ESE año, NO un acumulado:
 *      2017/32 → Fecha 2017-01-02..2017-12-31 (121,980 cabeceras)
 *      2021/32 → Fecha 2021 (86,300)   ·   2025/32 → Fecha 2025 (129,760)
 * 2. **El `Consecutivo` REINICIA en 1 cada año**: 2021 va 1..89,586 y 2025 va 1..129,760 — tickets
 *    distintos con el mismo número. Por eso el corte (`_dataset`) es parte OBLIGATORIA de la
 *    identidad de escritura; sin él los años se pisan entre sí en silencio.
 * El bronze `wincaja.*` ya resolvió esto con `source_dataset` en el PK; acá se replica el criterio.
 *
 * Destino: `:5433/wincaja` (la misma DB del carril vivo, schemas distintos) — decisión Edgar
 * 2026-09-01: el crudo completo vive LOCAL (15–20 GB proyectados) y a prod sólo suben agregados.
 *
 * Alcance inicial (Edgar 2026-09-01): **2017–2025** (187 archivos / 22.4 GB, ya descomprimidos).
 * Los `.7z` 2009–2016 quedan como segunda ola (`WINCAJA_HIST_YEARS` los admite cuando se extraigan).
 */
const fs = require('fs');
const path = require('path');

const HIST_BASE = process.env.WINCAJA_HIST_BASE || 'Z:/Salidas/Bases';
const REPLICA_URL = process.env.WINCAJA_REPLICA_URL || 'postgresql://postgres:superoot@localhost:5433/wincaja';
const ADMIN_URL = process.env.WINCAJA_REPLICA_ADMIN_URL || 'postgresql://postgres:superoot@localhost:5433/postgres';

/**
 * Carpetas-corte a barrer. Cada una produce un `_dataset`.
 * `Actuales` y `Concentradas` van PRIMERO por la directiva de Edgar (2026-09-01): "priorizar lo
 * actual de prod, de reciente a viejo" — son el periodo corriente (incluye todo 2026, que en el
 * bronze de prod vive dentro del corte `actual`, no como corte propio).
 */
const YEARS = (process.env.WINCAJA_HIST_YEARS
  || 'Actuales,Concentradas,2025,2024,2023,2022,2021,2020,2019,2018,2017')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Sucursales que YA tienen espejo crudo VIVO (`wNN`, CDC continuo bajo PM2, frescura ~minutos).
 * Para el corte `Actuales` no se vuelven a cargar acá: sería una segunda copia del mismo dato, más
 * vieja que la del carril vivo, en la misma DB. `--include-live` fuerza cargarlas igual.
 */
const LIVE_MIRRORED = (process.env.WINCAJA_LIVE_MIRRORED || '00,30,32')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Staging LOCAL. Jet sobre SMB es inviable para el histórico: el sondeo directo sobre
 * `Z:\...\2017\30 MORELIA ABASTOS.MDB` (559 MB) llevaba >17 min sin terminar UN archivo, mientras
 * que sobre copia local el mismo scan agregado tarda ~4 s. La copia va a ~5.2 MB/s (medido) → 22.4 GB
 * = ~72 min de copia total, una sola pasada. Regla: copiar el `.mdb` y leerlo desde disco local.
 */
const STAGE = process.env.WINCAJA_HIST_STAGE
  || path.join(process.env.TEMP || process.env.TMP || '.', 'wincaja_hist');

/** Tablas con columna monótona → se leen en ventanas para no cargar 650k filas de golpe en Node. */
const CHUNK_COL = {
  MaestroMovAlmacen: 'Consecutivo',
  DetallesMovAlmacen: 'Consecutivo',
  PagosDia: 'Consecutivo',
  Arqueos: 'Consecutivo',
  Cortes: 'Folio',
  Retiros: 'Folio',
};
const CHUNK_SIZE = Number(process.env.WINCAJA_HIST_CHUNK) || 50000;

const pad2 = (s) => (String(s).length === 1 ? '0' + s : String(s));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/**
 * PRIORIDAD DE CARGA (Edgar 2026-09-01: "priorizar lo actual de prod, de reciente a viejo").
 * El corpus son 22 GB y la carga corre horas → el orden decide qué hay disponible en la primera hora.
 *
 * 1) Por corte: las carpetas vivas primero (`Actuales`, `Concentradas`), después los años DESC.
 * 2) Dentro del corte: por relevancia para prod, espejando `wincaja.branches.status`.
 */
const DATASET_HEAD = ['Actuales', 'Concentradas'];
/** Espejo de `wincaja.branches.status` (Railway). Rank menor = se carga antes. */
const BRANCH_RANK = {
  // live_on_wincaja — la venta que hoy NO está en Kepler
  '00': 0, 30: 0, 32: 0, 50: 0,
  // transition — Kepler ya la tomó pero Wincaja sigue escribiendo
  10: 1,
  // rutas de las anteriores (venta a bordo)
  321: 2, 322: 2, 501: 2, 502: 2, 503: 2, 504: 2, 505: 2, 21: 2, 22: 2, 23: 2, 26: 2, 27: 2, 28: 2,
  // legacy_on_kepler — su venta viva está en Kepler; Wincaja es la cola histórica
  40: 3, 42: 3, 44: 3, 54: 3,
};
const BRANCH_RANK_DEFAULT = 4; // sucursales/rutas que ya no existen (20, 24, 25, 51, 70, 300, 301, cedis_b)

function datasetRank(dataset) {
  const head = DATASET_HEAD.findIndex((h) => dataset === h || dataset.startsWith(h + '-'));
  if (head >= 0) return head;                        // 0,1 → las carpetas vivas primero
  const y = Number((/^(\d{4})/.exec(dataset) || [])[1]);
  return Number.isFinite(y) ? 10000 - y : 99999;     // año DESC (2025→7975 … 2017→7983)
}
function branchRank(code) {
  const r = BRANCH_RANK[String(code)];
  return r === undefined ? BRANCH_RANK_DEFAULT : r;
}

/**
 * Deriva el código de sucursal/ruta del nombre del `.mdb`. Alineado con `wincaja.branches`
 * (`source_branch`): las rutas se identifican por SU número, no por el de la sucursal madre —
 * `32 RUTA 321.MDB` → `321`, `50 RUTA 502.MDB` → `502`, `21 RUTA 21.MDB` → `21`.
 */
function parseBranch(fileName) {
  const stem = fileName.replace(/\.mdb$/i, '').trim();
  let m = /^(\d+)\s+RUTA\s+(\d+)\b(.*)$/i.exec(stem);
  if (m) return { code: m[2], name: `RUTA ${m[2]}`, parent: pad2(m[1]), isRoute: true, tail: m[3].trim() };
  m = /^(\d+)\s+(.*)$/.exec(stem);
  if (m) {
    // El nombre canónico es la primera palabra-bloque; lo que sobre (ej. "2025 Dic") es el sufijo
    // que distingue dos archivos del MISMO corte y sucursal.
    const rest = m[2].trim();
    const tail = (/\b(\d{4}\s+\w+)$/.exec(rest) || [])[1] || '';
    return { code: pad2(m[1]), name: tail ? rest.slice(0, rest.length - tail.length).trim() : rest, parent: null, isRoute: false, tail };
  }
  return { code: slug(stem), name: stem, parent: null, isRoute: false, tail: '' };
}

/** Schema Postgres del espejo histórico de una sucursal. */
function histSchema(code) { return 'h' + slug(code); }

/**
 * Barre las carpetas-corte y devuelve las unidades de carga.
 * Devuelve [{ code, name, dataset, year, mdb, file, sizeMB, schema, isRoute, parent }].
 *
 * Reglas de desambiguación:
 *  - Sucursal `00`: hay DOS archivos y el bueno es **`… MOV.MDB`** (DB completa); el otro es un
 *    snapshot de catálogo viejo con movimientos=0 → se omite (mismo criterio que el carril vivo).
 *  - Dos archivos del mismo (corte, sucursal): el de nombre más corto se queda con el `_dataset`
 *    limpio (`2025`) y los demás llevan sufijo (`2025-2025_dic`) → no se pisan.
 */
function inventory({ years = YEARS, branches = null, base = HIST_BASE, includeLive = false } = {}) {
  const only = branches ? new Set(branches.map(String)) : null;
  const live = new Set(LIVE_MIRRORED);
  const out = [];
  for (const year of years) {
    const dir = path.join(base, year);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => /\.mdb$/i.test(f)); }
    catch { continue; } // carpeta-corte ausente (ej. un año todavía en .7z)
    // Agrupa por código para desambiguar
    const byCode = new Map();
    for (const f of files) {
      const b = parseBranch(f);
      if (!byCode.has(b.code)) byCode.set(b.code, []);
      byCode.get(b.code).push({ f, b });
    }
    for (const [code, list] of byCode) {
      if (only && !only.has(code)) continue;
      // El corte vivo de 30/32/00 ya lo mantiene `replicate-wincaja-live.js` en wNN, más fresco.
      if (!includeLive && year === 'Actuales' && live.has(code)) continue;
      let picks = list;
      if (list.length > 1) {
        const mov = list.filter((x) => /\bMOV\b/i.test(x.f));
        // `00`: sólo el MOV. Otros códigos: se cargan todos, con sufijo en el _dataset.
        picks = mov.length && code === '00' ? mov : list;
      }
      picks.sort((a, b) => a.f.length - b.f.length);
      picks.forEach((x, i) => {
        const full = path.join(dir, x.f);
        let sizeMB = 0;
        try { sizeMB = Math.round(fs.statSync(full).size / 1048576 * 10) / 10; } catch { /* noop */ }
        out.push({
          code,
          name: x.b.name,
          isRoute: x.b.isRoute,
          parent: x.b.parent,
          year,
          dataset: i === 0 ? year : `${year}-${slug(x.b.tail || x.f.replace(/\.mdb$/i, ''))}`,
          mdb: full,
          file: x.f,
          sizeMB,
          schema: histSchema(code),
        });
      });
    }
  }
  // Orden de carga = prioridad (ver PRIORIDAD DE CARGA arriba): corte reciente primero y, dentro
  // del corte, las sucursales que le importan a prod antes que las que ya no existen.
  return out.sort((a, b) => datasetRank(a.dataset) - datasetRank(b.dataset)
    || branchRank(a.code) - branchRank(b.code)
    || a.code.localeCompare(b.code));
}

module.exports = {
  HIST_BASE, REPLICA_URL, ADMIN_URL, YEARS, STAGE,
  CHUNK_COL, CHUNK_SIZE, BRANCH_RANK, DATASET_HEAD, LIVE_MIRRORED,
  inventory, parseBranch, histSchema, slug, pad2, datasetRank, branchRank,
};
