#!/usr/bin/env node
/**
 * Seed de PRUEBA para el monitor de Tienda (`/tienda/live`).
 *
 * Llena `analytics.store_live_tickets` con tickets del día para poder trabajar la
 * pantalla sin depender del poller on-prem (que alimenta prod, no las bases de
 * desarrollo). NO es un importer de negocio: es data inventada, y por eso vive en
 * `scripts/` y no en `importers/`.
 *
 * Qué lo hace útil de verdad y no ruido:
 *  - Los SKUs y sus precios salen de `analytics.v_product_unit_ladder` EN VIVO, no
 *    hardcodeados. Así el resolvedor de peldaño (el que convierte `cant` a unidades
 *    base comparando el precio cobrado contra la escalera del ERP) se ejercita con
 *    números que existen de verdad.
 *  - Una parte de los renglones se vende en el SEGUNDO peldaño (paquete) al precio
 *    `p2`. Es el caso que `UNIDADES_DE_MEDIDA.md` §7 documenta como la trampa: el
 *    mismo SKU, el mismo rótulo, dos peldaños. Si el resolvedor se rompe, se nota acá.
 *  - Un puñado de renglones lleva un precio fuera de la banda 0.5×–2× a propósito,
 *    para que `coverage_pct` NO dé 100% y se vea la declaración de cobertura. Una
 *    cobertura perfecta escondería que la pantalla sabe declarar lo que no midió.
 *  - `total` del ticket == Σ `importe` de sus renglones (invariante verificada en la
 *    tabla real; si se rompe, los KPIs de partidas y los de venta dejan de cuadrar).
 *
 * Seguridad (esto escribe en una DB COMPARTIDA):
 *  - Dry-run por default. Escribe solo con `--apply` (convención de los importers).
 *  - Se niega a correr contra Railway/producción.
 *  - Todo lo que inserta lleva la serie `SEEDXX`, así que `--clean` borra exactamente
 *    lo suyo y nada más.
 *
 * Uso:
 *   node database/scripts/seed-store-live-tickets.js                # dry-run, muestra qué haría
 *   node database/scripts/seed-store-live-tickets.js --apply        # escribe
 *   node database/scripts/seed-store-live-tickets.js --clean --apply # borra solo lo suyo
 *   ... --tickets=600 --branches=01,02,03
 */
const path = require('path');
const knexFactory = require('knex');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const TENANT = process.env.MEGA_DULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const TZ = 'America/Mexico_City';
const SERIE = 'SEEDXX'; // marca de agua: todo lo de este script sale de acá

// Sucursales que venden al público (el 00 CEDIS no) + su peso relativo de tráfico,
// para que el ranking por sucursal de la tarjeta "Partidas por ticket" tenga forma.
const BRANCHES = [
  { code: '01', name: 'Padre Hidalgo',      peso: 1.00, partidasObj: 4.2 },
  { code: '02', name: 'La Piedad Abastos',  peso: 0.85, partidasObj: 3.4 },
  { code: '03', name: '8 Esquinas',         peso: 0.70, partidasObj: 5.1 },
  { code: '04', name: 'Yurécuaro',          peso: 0.45, partidasObj: 2.6 },
  { code: '05', name: 'Zamora Centro',      peso: 0.60, partidasObj: 3.9 },
  { code: '06', name: 'Canindo',            peso: 0.50, partidasObj: 3.1 },
];

const FORMAS = ['EFECTIVO', 'EFECTIVO', 'EFECTIVO', 'TARJETA', 'TARJETA', 'TRANSFER'];

/** PRNG con semilla: correr dos veces da los MISMOS tickets (idempotente en contenido). */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}
const has = (f) => process.argv.includes(`--${f}`);

async function main() {
  const apply = has('apply');
  const clean = has('clean');
  const nTickets = Math.max(1, Number(arg('tickets', 420)));
  const only = String(arg('branches', '')).split(',').map((s) => s.trim()).filter(Boolean);
  const branches = only.length ? BRANCHES.filter((b) => only.includes(b.code)) : BRANCHES;
  if (!branches.length) throw new Error(`--branches no coincidió con ninguna sucursal (válidas: ${BRANCHES.map((b) => b.code).join(',')})`);

  const conn = process.env.DATABASE_URL_NEW || process.env.KNEX_CONNECTION || '';
  if (!conn) throw new Error('Falta DATABASE_URL_NEW en el .env');
  // Guarda dura: esto inventa ventas. En producción no entra ni con --apply.
  if (/rlwy|railway|\.proxy\./i.test(conn)) {
    throw new Error('DATABASE_URL_NEW apunta a Railway (producción). Este script NO escribe ahí.');
  }
  const dbName = (conn.split('/').pop() || '').split('?')[0];
  console.log(`Base destino : ${dbName}`);
  console.log(`Modo         : ${clean ? 'CLEAN' : 'SEED'} ${apply ? '(APPLY — escribe)' : '(dry-run — no escribe)'}`);

  const db = knexFactory({ client: 'pg', connection: conn, pool: { min: 0, max: 4 } });
  try {
    if (clean) {
      const { rows } = await db.raw(
        `SELECT count(*)::int n FROM analytics.store_live_tickets WHERE tenant_id = ? AND serie = ?`,
        [TENANT, SERIE],
      );
      console.log(`Tickets del seed en la base: ${rows[0].n}`);
      if (apply && rows[0].n) {
        const del = await db.raw(
          `DELETE FROM analytics.store_live_tickets WHERE tenant_id = ? AND serie = ?`,
          [TENANT, SERIE],
        );
        console.log(`Borrados: ${del.rowCount}`);
      } else if (!apply) {
        console.log('(dry-run) Con --apply se borrarían esos tickets. No toca nada más.');
      }
      return;
    }

    // ── Pool de SKUs REALES con su escalera de precios ──────────────────
    const { rows: pool } = await db.raw(
      `SELECT l.sku, p.nombre, l.p1::float8 AS p1, l.p2::float8 AS p2, l.f2::float8 AS f2
         FROM analytics.v_product_unit_ladder l
         JOIN catalog.products p ON p.sku = l.sku AND p.deleted_at IS NULL
        WHERE l.p1 BETWEEN 5 AND 60
          AND NOT l.is_weight
          AND p.nombre IS NOT NULL AND btrim(p.nombre) <> ''
          AND p.nombre !~ '^[*#]'
          AND p.nombre !~* '(comision|regalo|gratis|etiqueta|prepar)'
          AND length(p.nombre) BETWEEN 8 AND 42
        ORDER BY l.sku
        LIMIT 300`,
    );
    if (!pool.length) throw new Error('La escalera (analytics.v_product_unit_ladder) no devolvió SKUs — ¿está el ODS en esta base?');
    const conPaquete = pool.filter((p) => p.p2 > 0 && p.f2 >= 4 && p.f2 <= 30 && p.p2 / p.p1 > 2);
    console.log(`Pool de SKUs : ${pool.length} (${conPaquete.length} con segundo peldaño usable)`);

    // ── Generación ──────────────────────────────────────────────────────
    const rand = rng(20260909);
    const pick = (arr) => arr[Math.floor(rand() * arr.length) % arr.length];
    const pesoTotal = branches.reduce((s, b) => s + b.peso, 0);

    // Ventana del día: de las 9:00 a la hora actual MX (nunca al futuro — un ticket
    // "del futuro" rompería la curva por hora y el cálculo de sucursal sin conexión).
    const nowMx = new Date(Date.now() - 6 * 3600e3); // -06:00 fijo, igual que el resto del módulo
    const hNow = nowMx.getUTCHours();
    const hIni = 9;
    const hFin = Math.max(hIni + 1, Math.min(22, hNow));
    const fecha = nowMx.toISOString().slice(0, 10);

    const tickets = [];
    let fueraDeBanda = 0, enPaquete = 0;
    for (const b of branches) {
      const cuantos = Math.max(1, Math.round((nTickets * b.peso) / pesoTotal));
      for (let i = 0; i < cuantos; i++) {
        // Curva del día: pico al mediodía y a la tarde (sesgo con dos muestras).
        const h = Math.min(hFin, Math.max(hIni, Math.floor(hIni + (rand() + rand()) / 2 * (hFin - hIni + 1))));
        const mm = Math.floor(rand() * 60);
        const ts = `${fecha}T${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-06:00`;

        // Partidas por ticket alrededor del objetivo de la sucursal (mínimo 1).
        const nLineas = Math.max(1, Math.round(b.partidasObj + (rand() - 0.5) * 2.4));
        const items = [];
        const usados = new Set();
        for (let j = 0; j < nLineas; j++) {
          const esPaquete = conPaquete.length && rand() < 0.10;
          const prod = esPaquete ? pick(conPaquete) : pick(pool);
          if (usados.has(prod.sku)) continue; // un SKU no se repite en el mismo ticket
          usados.add(prod.sku);

          let precio, cant;
          if (esPaquete) {
            // Se vende el PAQUETE: cantidad chica y precio del 2º peldaño.
            precio = prod.p2; cant = 1 + Math.floor(rand() * 2); enPaquete++;
          } else {
            // Pieza suelta, con un descuento chico ocasional (dentro de banda).
            const desc = rand() < 0.15 ? 0.92 : 1;
            precio = prod.p1 * desc; cant = 1 + Math.floor(rand() * 4);
          }
          // ~1.5% de renglones con precio fuera de la banda 0.5×–2×: el resolvedor
          // NO debe adivinarlos, y la pantalla debe declarar la cobertura < 100%.
          if (rand() < 0.015) { precio = prod.p1 * 3.7; fueraDeBanda++; }

          items.push({
            sku: prod.sku,
            nombre: String(prod.nombre).trim(),
            cant,
            importe: +(precio * cant).toFixed(2),
          });
        }
        if (!items.length) continue;
        tickets.push({
          tenant_id: TENANT,
          warehouse_code: b.code,
          warehouse_name: b.name,
          serie: SERIE,
          folio: `${b.code}${String(i + 1).padStart(5, '0')}`,
          ticket_ts: ts,
          total: +items.reduce((s, it) => s + it.importe, 0).toFixed(2),
          forma_pago: pick(FORMAS),
          items: JSON.stringify(items),
        });
      }
    }

    const partidas = tickets.reduce((s, t) => s + JSON.parse(t.items).length, 0);
    const venta = tickets.reduce((s, t) => s + t.total, 0);
    console.log(`\nGenerado (día ${fecha}, ${hIni}:00–${hFin}:59 MX):`);
    console.log(`  tickets            : ${tickets.length}`);
    console.log(`  partidas           : ${partidas}  (${(partidas / tickets.length).toFixed(2)} por ticket)`);
    console.log(`  venta              : $${venta.toLocaleString('es-MX', { maximumFractionDigits: 2 })}`);
    console.log(`  valor por partida  : $${(venta / partidas).toFixed(2)}`);
    console.log(`  renglones paquete  : ${enPaquete}  (ejercitan el 2º peldaño)`);
    console.log(`  fuera de banda     : ${fueraDeBanda}  (deben quedar SIN resolver)`);

    if (!apply) {
      console.log('\n(dry-run) No se escribió nada. Repetí con --apply.');
      console.log('Ejemplo del primer ticket:');
      console.log(JSON.stringify({ ...tickets[0], items: JSON.parse(tickets[0].items) }, null, 2).slice(0, 700));
      return;
    }

    // Idempotente por la única de la tabla: (tenant_id, warehouse_code, serie, folio).
    let escritos = 0;
    for (let i = 0; i < tickets.length; i += 200) {
      const lote = tickets.slice(i, i + 200);
      await db.raw(
        `INSERT INTO analytics.store_live_tickets
           (tenant_id, warehouse_code, warehouse_name, serie, folio, ticket_ts, total, forma_pago, items)
         VALUES ${lote.map(() => '(?, ?, ?, ?, ?, ?::timestamptz, ?, ?, ?::jsonb)').join(', ')}
         ON CONFLICT (tenant_id, warehouse_code, serie, folio) DO UPDATE
            SET ticket_ts = EXCLUDED.ticket_ts, total = EXCLUDED.total,
                forma_pago = EXCLUDED.forma_pago, items = EXCLUDED.items,
                warehouse_name = EXCLUDED.warehouse_name`,
        lote.flatMap((t) => [t.tenant_id, t.warehouse_code, t.warehouse_name, t.serie, t.folio, t.ticket_ts, t.total, t.forma_pago, t.items]),
      );
      escritos += lote.length;
    }
    console.log(`\nEscritos/actualizados: ${escritos} tickets (serie ${SERIE}).`);
    console.log(`Para deshacer: node database/scripts/seed-store-live-tickets.js --clean --apply`);
  } finally {
    await db.destroy();
  }
}

main().catch((e) => { console.error(`\nERROR: ${e.message}`); process.exit(1); });
