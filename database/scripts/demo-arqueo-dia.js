/* eslint-disable no-console */
/**
 * Escenario de práctica — un día completo de caja en Padre Hidalgo (SM.10–SM.13).
 *
 * Monta una tienda ficticia **por el lado de Kepler** y deja que el resto de la
 * cadena corra sola: siembra los turnos y las ventas en `kepler_ods` (que es de
 * donde el ERP habla) y después ejecuta los mismos dos loaders que corren en
 * producción. No escribe a mano en `analytics.*` a propósito — si el escenario
 * apareciera por un atajo, no estaría probando nada.
 *
 *     Kepler (ODS)  →  load-cash-cuts-from-ods  →  analytics.cash_cuts
 *                   →  import-cash-sessions     →  analytics.cash_sessions
 *                                               →  /tienda/cajas · /tienda/arqueo
 *
 * ── El caso ───────────────────────────────────────────────────────────────────
 *
 * Tres cajas trabajaron hoy y cada una deja un desenlace distinto:
 *
 *   Caja 1 · Ana    — cerró. Kepler dice que **cuadró al centavo**… y en el cajón
 *                     faltan $1,240. Es el 74.5% de cortes exactos de SM.7 en vivo:
 *                     el arqueo ciego lo destapa y marca enmascaramiento.
 *   Caja 2 · Rosa   — cerró y **cuadra de verdad**. Sirve de control: si todo
 *                     saliera en rojo, el motor no estaría midiendo nada.
 *   Caja 3 · Luz    — **sigue cobrando**. Su turno está abierto: puede arquear,
 *                     pero todavía no hay corte contra el cual comparar.
 *
 * Y una encargada, Marisol, que valida yendo a cada caja.
 *
 * Uso:
 *   node database/scripts/demo-arqueo-dia.js --apply     # monta el escenario
 *   node database/scripts/demo-arqueo-dia.js --limpiar   # lo borra sin dejar rastro
 *   DATABASE_URL_NEW='postgres://…' node … --apply --sucursal 01
 */

const { Client } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');
try { require('dotenv').config(); } catch (e) { /* dotenv opcional */ }

const APPLY = process.argv.includes('--apply');
const LIMPIAR = process.argv.includes('--limpiar');
const RESET = process.argv.includes('--reset-arqueos');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const SUC = arg('--sucursal', '01');
const M = process.env.MAAT_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@127.0.0.1:5432/postgres_platform';

const PASS = 'Arqueo.2026';
// Fecha de negocio en hora de MÉXICO, no UTC: a las 18:00 de acá ya es el día
// siguiente en UTC, y el backend calcula el "hoy" con America/Mexico_City —
// sembrar en UTC deja el escenario en un día que la pantalla no mira.
const HOY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
/** Prefijo de todo lo sembrado: es lo que hace el `--limpiar` exacto. */
const MARCA = 'DEMO';

const PERSONAS = [
  {
    user: 'demo_ana', nombre: 'Ana Lorena Ruiz Medina', rol: 'cajero',
    caja: '1', folio: '9001', abrio: '07:05:00', cerro: '15:20:00', cerrado: true,
    efectivoEsperado: 18430.50, venta: 24300, tickets: 96,
    // Kepler declara contado == esperado (diff 0). En el cajón faltan $1,240.
    contadoKepler: 18430.50, enCajon: 17190.50,
    guion: 'Kepler dice que cuadró al centavo, pero faltan $1,240',
  },
  {
    user: 'demo_rosa', nombre: 'Rosa María Tinoco Vega', rol: 'cajero',
    caja: '2', folio: '9002', abrio: '07:10:00', cerro: '15:25:00', cerrado: true,
    efectivoEsperado: 12780.00, venta: 15900, tickets: 71,
    contadoKepler: 12780.00, enCajon: 12780.00,
    guion: 'Cuadra de verdad — el control del experimento',
  },
  {
    user: 'demo_luz', nombre: 'Luz Elena Barajas Soto', rol: 'cajero',
    caja: '3', folio: '9003', abrio: '07:12:00', cerro: null, cerrado: false,
    efectivoEsperado: 0, venta: 8450, tickets: 42,
    contadoKepler: 0, enCajon: null,
    guion: 'Sigue cobrando: turno abierto, todavía sin corte',
    // Lo que Kepler escribirá cuando Luz termine (`--cerrar-turno 3`). Tercer caso:
    // aquí SOBRA dinero. Un sobrante no es "un faltante al revés" — suele ser un
    // cobro mal registrado, y también hay que verlo.
    alCerrar: { hora: '20:40:00', efectivoEsperado: 6120.00, contadoKepler: 6120.00, enCajon: 6300.00 },
  },
];
const ENCARGADA = { user: 'demo_encargada', nombre: 'Marisol Cázares Duarte', rol: 'encargado_tienda' };

const money = (n) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

/** Reparte un total en `n` tickets con montos plausibles (el último ajusta el redondeo). */
function repartir(total, n) {
  const base = Math.floor((total / n) * 100) / 100;
  const t = Array.from({ length: n }, (_, i) => Math.round((base * (0.4 + ((i * 37) % 120) / 100)) * 100) / 100);
  const suma = t.reduce((a, b) => a + b, 0);
  t[t.length - 1] = Math.round((t[t.length - 1] + (total - suma)) * 100) / 100;
  return t;
}

async function limpiar(pg) {
  const users = [...PERSONAS.map((p) => p.user), ENCARGADA.user];
  const folios = PERSONAS.map((p) => p.folio);
  const cajeros = PERSONAS.map((p) => p.user.toUpperCase());
  await pg.query(`DELETE FROM reconciliation.discrepancies WHERE tenant_id=$1 AND (entity->>'cajero') = ANY($2)`, [M, cajeros]).catch(() => {});
  await pg.query(`DELETE FROM reconciliation.blind_counts WHERE tenant_id=$1 AND upper(cajero_code) = ANY($2)`, [M, cajeros]).catch(() => {});
  await pg.query(`DELETE FROM analytics.cash_cuts WHERE tenant_id=$1 AND warehouse_code=$2 AND folio = ANY($3)`, [M, SUC, folios]).catch(() => {});
  await pg.query(`DELETE FROM analytics.cash_sessions WHERE tenant_id=$1 AND warehouse_code=$2 AND folio = ANY($3)`, [M, SUC, folios]).catch(() => {});
  await pg.query(`DELETE FROM kepler_ods.kdpv_folio_caja WHERE sucursal=$1 AND c3::text = ANY($2)`, [SUC, folios]).catch(() => {});
  await pg.query(`DELETE FROM kepler_ods.kdm1 WHERE sucursal=$1 AND c6 LIKE '${MARCA}%'`, [SUC]).catch(() => {});
  await pg.query(`DELETE FROM identity.user_scopes WHERE tenant_id=$1 AND user_id IN (SELECT id FROM identity.users WHERE tenant_id=$1 AND username = ANY($2))`, [M, users]).catch(() => {});
  await pg.query(`DELETE FROM identity.users WHERE tenant_id=$1 AND username = ANY($2)`, [M, users]).catch(() => {});
  await pg.query(`DELETE FROM analytics.pos_cashiers WHERE tenant_id=$1 AND cajero_code = ANY($2)`, [M, cajeros]).catch(() => {});
}

/** Borra solo los conteos: deja el día montado para volver a arquearlo a mano. */
async function resetArqueos(pg) {
  const cajeros = PERSONAS.map((p) => p.user.toUpperCase());
  const d = await pg.query(`DELETE FROM reconciliation.discrepancies WHERE tenant_id=$1 AND (entity->>'cajero') = ANY($2)`, [M, cajeros]);
  const b = await pg.query(`DELETE FROM reconciliation.blind_counts WHERE tenant_id=$1 AND upper(cajero_code) = ANY($2)`, [M, cajeros]);
  return { arqueos: b.rowCount, descuadres: d.rowCount };
}

/**
 * Simula que la cajera terminó: Kepler cierra el turno y escribe su corte.
 * Es el momento exacto en el que el arqueo pasa de "sin corte para comparar" a
 * tener un esperado contra el cual medirse.
 */
async function cerrarTurno(pg, caja) {
  const p = PERSONAS.find((x) => x.caja === String(caja));
  if (!p) throw new Error(`No hay caja ${caja} en el escenario (hay: ${PERSONAS.map((x) => x.caja).join(', ')})`);
  const c = p.alCerrar || { hora: '20:30:00', efectivoEsperado: p.efectivoEsperado, contadoKepler: p.contadoKepler, enCajon: p.enCajon };
  const diff = Math.round((c.efectivoEsperado - c.contadoKepler) * 100) / 100;
  const r = await pg.query(
    `UPDATE kepler_ods.kdpv_folio_caja
        SET c10 = $1::timestamp, c11 = $2, c15 = $3, c25 = $4, c35 = $5, c49 = $3
      WHERE sucursal = $6 AND c3::text = $7`,
    [HOY, c.hora, c.efectivoEsperado, c.contadoKepler, diff, SUC, p.folio],
  );
  if (!r.rowCount) throw new Error(`El turno ${p.folio} no existe — ¿corriste --apply?`);
  return { p, c, diff };
}

async function sembrarUsuario(pg, bcrypt, { user, nombre, rol }) {
  const hash = await bcrypt.hash(PASS, 10);
  await pg.query(
    `INSERT INTO identity.users (tenant_id, username, password_hash, nombre, role_name, activo, warehouse_code)
     VALUES ($1,$2,$3,$4,$5,true,$6)
     ON CONFLICT (tenant_id, username) DO UPDATE SET password_hash=EXCLUDED.password_hash, nombre=EXCLUDED.nombre,
       role_name=EXCLUDED.role_name, activo=true, warehouse_code=EXCLUDED.warehouse_code, updated_at=now()`,
    [M, user, hash, nombre, rol, SUC],
  );
}

function correrLoader(script, extra = []) {
  const p = path.join(__dirname, '..', 'importers', 'kepler', script);
  try {
    const out = execFileSync(process.execPath, [p, '--apply', ...extra], {
      env: { ...process.env, DATABASE_URL_NEW: DST }, encoding: 'utf8', timeout: 300000,
    });
    const last = out.trim().split('\n').filter((l) => /✅|UPSERT|TOTAL/.test(l)).slice(-1)[0];
    console.log(`   ${script}: ${last ? last.trim() : 'ok'}`);
  } catch (e) {
    console.warn(`   ${script}: FALLÓ — ${String(e.message).slice(0, 160)}`);
  }
}

(async () => {
  const ssl = /rlwy|proxy|railway/.test(DST) ? { rejectUnauthorized: false } : false;
  const pg = new Client({ connectionString: DST, ssl });
  await pg.connect();

  if (LIMPIAR) {
    await limpiar(pg);
    console.log('Escenario borrado (usuarios, turnos, ventas, cortes, sesiones, arqueos y descuadres).');
    await pg.end();
    return;
  }

  if (RESET) {
    const n = await resetArqueos(pg);
    console.log(`Arqueos borrados: ${n.arqueos} conteos y ${n.descuadres} descuadres. El día sigue montado — volvé a capturarlos desde /tienda/arqueo.`);
    await pg.end();
    return;
  }

  const CERRAR = arg('--cerrar-turno', null);
  if (CERRAR) {
    const { p, c, diff } = await cerrarTurno(pg, CERRAR);
    console.log('');
    console.log(`Kepler cerró el turno de ${p.nombre} (caja ${p.caja}, folio ${p.folio}) a las ${c.hora}.`);
    console.log(`  efectivo esperado ${money(c.efectivoEsperado)} · Kepler declara ${money(c.contadoKepler)} (diferencia ${money(diff)})`);
    console.log('');
    console.log('Corriendo los loaders para que el corte llegue a la plataforma…');
    correrLoader('load-cash-cuts-from-ods.js', ['--sucursal', SUC]);
    correrLoader('import-cash-sessions.js');
    const sobra = Math.round((c.enCajon - c.efectivoEsperado) * 100) / 100;
    console.log('');
    console.log(`Ahora entrá como  ${p.user}  → /tienda/arqueo y contá el cajón.`);
    console.log(`  En la caja hay ${money(c.enCajon)}, o sea ${sobra > 0 ? 'SOBRAN ' + money(sobra) : sobra < 0 ? 'FALTAN ' + money(-sobra) : 'cuadra exacto'}.`);
    if (c.enCajon === 6300) console.log('  (6 billetes de $1000, 1 de $200 y 1 de $100)');
    console.log('  Ella no va a ver ese número. La encargada sí, en /almacen/cuadre.');
    console.log('');
    await pg.end();
    return;
  }

  if (!APPLY) {
    console.log('Escenario de práctica — un día de caja en la sucursal ' + SUC + ' (' + HOY + ')\n');
    for (const p of PERSONAS) {
      console.log(`  Caja ${p.caja} · ${p.nombre.split(' ')[0]} (${p.user}) — ${p.guion}`);
      console.log(`     venta del día ${money(p.venta)} en ${p.tickets} tickets · efectivo esperado ${money(p.efectivoEsperado)}`);
    }
    console.log(`\n  Encargada: ${ENCARGADA.nombre} (${ENCARGADA.user})`);
    console.log('\n(dry-run — usar --apply para montarlo)');
    await pg.end();
    return;
  }

  const bcrypt = require('bcryptjs');
  await limpiar(pg); // idempotente: re-montar el escenario no deja capas viejas

  console.log(`\n=== Montando el día en la sucursal ${SUC} (${HOY}) ===\n`);

  console.log('1. Personal');
  for (const p of PERSONAS) {
    await sembrarUsuario(pg, bcrypt, p);
    // Catálogo de cajeras del POS: es de donde /tienda/cajas saca el NOMBRE. Sin
    // esto la pantalla muestra el código (DEMO_ANA) y no "quién está cobrando".
    await pg.query(
      `INSERT INTO analytics.pos_cashiers (tenant_id, warehouse_code, cajero_code, nombre)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, warehouse_code, cajero_code) DO UPDATE SET nombre=EXCLUDED.nombre`,
      [M, SUC, p.user.toUpperCase(), p.nombre],
    ).catch(() => {});
  }
  await sembrarUsuario(pg, bcrypt, ENCARGADA);
  console.log(`   ${PERSONAS.length} cajeras + 1 encargada (password: ${PASS})`);

  console.log('2. Turnos y ventas del día en Kepler (kepler_ods)');
  for (const p of PERSONAS) {
    const cajero = p.user.toUpperCase();
    const diff = Math.round((p.efectivoEsperado - p.contadoKepler) * 100) / 100;
    await pg.query(
      `INSERT INTO kepler_ods.kdpv_folio_caja
         (sucursal, c1, c2, c3, c5, c6, c7, c8, c10, c11, c13, c15, c25, c35, c16, c26, c36, c17, c27, c37, c49)
       VALUES ($1,$1,$2,$3::numeric,$4::timestamp,$5,'GERENTE',$6,$7::timestamp,$8,'01',
               $9,$10,$11, 0,0,0, 0,0,0, $9)
       ON CONFLICT (sucursal, c1, c2, c3) DO NOTHING`,
      [SUC, p.caja, p.folio, HOY, p.abrio, cajero,
        p.cerrado ? HOY : '1800-01-01', p.cerrado ? p.cerro : null,
        p.efectivoEsperado, p.contadoKepler, diff],
    );
    // Tickets del día: es lo que le da "venta hoy" a la pantalla de cajas abiertas.
    const montos = repartir(p.venta, Math.min(p.tickets, 40));
    for (let i = 0; i < montos.length; i++) {
      await pg.query(
        `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c16)
         VALUES ($1,$1,'U','D','10',$2,$3,$4::timestamp,$5)`,
        [SUC, p.caja, `${MARCA}${p.caja}${String(i).padStart(4, '0')}`, HOY, montos[i]],
      );
    }
    console.log(`   caja ${p.caja} · ${cajero} · ${p.cerrado ? 'cerrado ' + p.cerro : 'ABIERTO'} · ${montos.length} tickets · ${money(p.venta)}`);
  }

  console.log('3. Corriendo los loaders reales (los mismos de producción)');
  correrLoader('load-cash-cuts-from-ods.js', ['--sucursal', SUC]);
  correrLoader('import-cash-sessions.js');

  const ses = await pg.query(
    `SELECT count(*)::int n FROM analytics.cash_sessions WHERE tenant_id=$1 AND warehouse_code=$2 AND business_date=$3`, [M, SUC, HOY]);
  const cut = await pg.query(
    `SELECT count(*)::int n FROM analytics.cash_cuts WHERE tenant_id=$1 AND warehouse_code=$2 AND business_date=$3 AND folio = ANY($4)`,
    [M, SUC, HOY, PERSONAS.map((p) => p.folio)]);
  console.log(`   → ${ses.rows[0].n} sesiones y ${cut.rows[0].n} cortes visibles para hoy\n`);

  console.log('════════════════════════ GUION DE LA PRÁCTICA ════════════════════════\n');
  console.log(`Todos entran con la contraseña  ${PASS}\n`);
  console.log('1) Entrá como  demo_encargada  → /tienda/cajas');
  console.log('   Tienen que aparecer 3 cajas con su cajera, la hora en que abrieron y');
  console.log('   la venta del día, ordenadas de mayor a menor. Caja 3 sigue cobrando.\n');
  console.log('2) Entrá como  demo_ana  → /tienda/arqueo');
  console.log('   No elige nada: su turno (caja 1) ya viene de Kepler y no se puede tocar.');
  console.log('   Contá el cajón — 17 billetes de $1000, 1 de $100, 1 de $50, 2 de $20 y una');
  console.log('   moneda de 50¢ = $17,190.50 — y guardá. Solo ve su total. Nada más.\n');
  console.log('3) Volvé a  demo_encargada  → /almacen/cuadre, pestaña Descuadres');
  console.log('   Ahí está el faltante de $1,240 marcado CRÍTICO, con la leyenda de que');
  console.log('   Kepler lo había dado por cuadrado. Ana nunca vio ese número.\n');
  console.log('4) Entrá como  demo_rosa  → contá $12,780 (12×$1000, 1×$500, 1×$200, 1×$50,');
  console.log('   1×$20, 1×$10). No levanta descuadre: cuadra de verdad.\n');
  console.log('5) Entrá como  demo_luz  → su turno está ABIERTO. Puede arquear, y el sistema');
  console.log('   le dice que el corte todavía no cerró en Kepler.\n');
  console.log('6) Cerrá como  demo_encargada  → /tienda/arqueo, columna Validado.');
  console.log('   Ve los tres arqueos (las cajeras solo veían el suyo) y los firma.');
  console.log('   Si una recaptura su conteo, la firma se cae y hay que validar de nuevo.\n');
  console.log('Cuando Luz termine su turno:  node database/scripts/demo-arqueo-dia.js --cerrar-turno 3');
  console.log('Para volver a arquear desde cero: node database/scripts/demo-arqueo-dia.js --reset-arqueos');
  console.log('Para borrarlo todo:  node database/scripts/demo-arqueo-dia.js --limpiar');
  console.log('══════════════════════════════════════════════════════════════════════');

  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
