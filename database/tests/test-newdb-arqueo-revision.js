/**
 * [SM.55] Revisión de turnos — la encargada justifica, sigue hasta cerrar y firma cada día.
 *
 * El camino de escritura REAL (regla 13): `TurnoRevisionService` con el MISMO payload que manda
 * `/tienda/arqueo/revision` (`ArqueoRevisionService` en apps/view), contra la base, y leyendo las
 * filas escritas después. La lista sale de `BlindCountService.cajasDelDia` real.
 *
 * Tres turnos de Kepler de prueba (sucursal ZZ-SM55, 3-ene-2026):
 *   caja 1 · folio 9001 — Kepler registró $5,000 en retiros, nadie contó nada  → POR JUSTIFICAR
 *   caja 2 · folio 9002 — $3,000 en retiros, contados, y el cajón contado      → CUADRA (control)
 *   caja 3 · folio 9003 — turno ABIERTO                                         → no sale (control)
 *   caja 4 · folio 9004 — sin retiros, nadie contó el cajón                     → CUADRA en retiros: el cajón
 *                          es dato, no se justifica (versión simple, 2026-11-24)
 *
 * Todo corre dentro de UNA transacción que se revierte: no deja filas.
 * ⚠️ Si la base no tiene `analytics.v_pos_cashiers` (la local no la tiene), se crea una vista
 * vacía DENTRO de la transacción revertida: la consulta del arqueo la une con LEFT JOIN.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
const WH = 'ZZ-SM55';
const FECHA = '2026-01-03';
const CLAVE = `turno_sin_verificar:${WH}:1:${FECHA}:9001`;

let pass = 0, fail = 0, nm = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const noMedido = (msg) => { nm++; console.log('  ⊘ NO MEDIDO —', msg); };
const RB = '__rb__';
const rechaza = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };

/** Los servicios REALES; solo se sustituye la infraestructura de Nest (tenant y conexión). */
function cargarServicios() {
  const path = require('path');
  const Module = require('module');
  const fs = require('fs');
  const raiz = path.resolve(__dirname, '..', '..');
  const caja = (f) => JSON.stringify(path.join(raiz, 'libs/platform-core/src/lib/caja', f));
  const mapa = {
    '@megadulces/platform-core': path.join(__dirname, '.stub-sm55-platform-core.js'),
    '@megadulces/contracts': path.join(__dirname, '.stub-sm55-contracts.js'),
    '@megadulces/contracts/http/arqueo-cajas': path.join(raiz, 'libs/contracts/src/http/arqueo-cajas.contract.ts'),
  };
  // La liga conteo ↔ turno y el cuadre son los REALES (platform-core/lib/caja, solo se importan).
  fs.writeFileSync(mapa['@megadulces/platform-core'], `module.exports = {
    TenantKnexService: class TenantKnexService {}, TenantContextService: class TenantContextService {},
    ...require(${caja('ligar-conteos.ts')}), ...require(${caja('cash-cut-identity.ts')}),
  };`);
  fs.writeFileSync(mapa['@megadulces/contracts'], `module.exports = {
    ...require(${JSON.stringify(path.join(raiz, 'libs/contracts/src/money/denominations.ts'))}),
    ...require(${JSON.stringify(path.join(raiz, 'libs/contracts/src/ports/recon-notifier.port.ts'))}),
  };`);
  process.on('exit', () => {
    for (const f of Object.values(mapa)) {
      if (!path.basename(f).startsWith('.stub-')) continue;
      try { fs.unlinkSync(f); } catch { /* ya no esta */ }
    }
  });
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (req, ...rest) { return mapa[req] || orig.call(this, req, ...rest); };
  require('ts-node').register({
    transpileOnly: true, skipProject: true,
    compilerOptions: {
      module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node',
      experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0',
    },
  });
  require('reflect-metadata');
  const lib = (f) => require(path.join(raiz, 'libs/reconciliation/src/lib', f));
  return {
    BlindCountService: lib('blind-count.service.ts').BlindCountService,
    TurnoRevisionService: lib('turno-revision.service.ts').TurnoRevisionService,
  };
}

async function fixture(trx) {
  await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
  const vista = (await trx.raw(`SELECT to_regclass('analytics.v_pos_cashiers') AS r`)).rows[0].r;
  if (!vista) {
    await trx.raw(`CREATE VIEW analytics.v_pos_cashiers AS
      SELECT NULL::uuid AS tenant_id, NULL::text AS warehouse_code, NULL::text AS cajero_code, NULL::text AS nombre WHERE false`);
  }
  const turno = (caja, folio, cajero, retirado, abierto) => trx.raw(
    `INSERT INTO kepler_ods.kdpv_folio_caja (sucursal, c1, c2, c3, c5, c6, c8, c10, c11, c15, c25, c35, c43, c44, c46, c48)
     VALUES (?, ?, ?, ?, ?::timestamp, '07:00:00', ?, ?::timestamp, ?, ?, ?, 0, 1000, 0, 10000, ?)`,
    [WH, `SM55-${folio}`, caja, folio, FECHA, cajero,
      abierto ? '1800-01-01' : FECHA, abierto ? null : '15:00:00', retirado + 1000, retirado + 1000, retirado]);
  await turno('1', 9001, 'ZZC01', 5000, false);
  await turno('2', 9002, 'ZZC02', 3000, false);
  await turno('3', 9003, 'ZZC03', 2000, true);
  await turno('4', 9004, 'ZZC04', 0, false);
  // Caja 2: el retiro y el cajón contados, ligados por folio, a media mañana (10:00 en MX).
  const conteo = (tipo, sec, total) => trx.raw(
    `INSERT INTO reconciliation.blind_counts
       (tenant_id, warehouse_code, caja, business_date, cajero_code, tipo, secuencia, concepto, denominations,
        total_contado, cash_cut_folio, captured_at)
     VALUES (?, ?, '2', ?, 'ZZC02', ?, ?, ?, '{}'::jsonb, ?, '9002', '2026-01-03T16:00:00Z')`,
    [T, WH, FECHA, tipo, sec, tipo === 'retiro' ? 'retiro_caja' : null, total]);
  await conteo('retiro', 1, 3000);
  await conteo('cierre', 1, 1000);
}

(async () => {
  let Svc;
  try { Svc = cargarServicios(); } catch (e) { console.log('  ✗ no cargan los servicios:', e.message); process.exit(1); }

  console.log('\n[0] Arranque: Nest inyecta por design:paramtypes (#414 tiró la API con el CI en verde)');
  const tipos = Reflect.getMetadata('design:paramtypes', Svc.TurnoRevisionService) || [];
  ok(tipos.length === 3 && tipos[2] === Svc.BlindCountService,
    `TurnoRevisionService declara 3 dependencias y la 3ª es BlindCountService (${tipos.map((t) => t && t.name).join(', ')})`);

  const existe = (await knex.raw(`SELECT to_regclass('kepler_ods.kdpv_folio_caja') k, to_regclass('reconciliation.discrepancy_feedback') f`)).rows[0];
  if (!existe.k || !existe.f) {
    noMedido('la base no tiene kepler_ods.kdpv_folio_caja o reconciliation.discrepancy_feedback');
  } else {
    await knex.transaction(async (trx) => {
      await fixture(trx);
      const tk = { run: async (a, b) => (typeof a === 'function' ? a(trx) : b(trx)) };
      const ctx = { requireTenantId: () => T };
      const blind = new Svc.BlindCountService(tk, ctx, {}, undefined);
      const svc = new Svc.TurnoRevisionService(tk, ctx, blind);
      const lista = () => svc.pendientes(FECHA, FECHA, [WH]);
      const turnoDe = (r, caja) => r.turnos.find((t) => t.caja === caja);
      const filas = async () => (await trx.raw(
        `SELECT d.status, d.causa_confirmada, d.observado::numeric o, d.esperado::numeric e, d.importe::numeric i,
                fb.verdict, fb.causa, fb.nota, fb.created_by, r.enabled
           FROM reconciliation.discrepancies d
           JOIN reconciliation.discrepancy_feedback fb ON fb.tenant_id = d.tenant_id AND fb.discrepancy_id = d.id
           JOIN reconciliation.rule_registry r ON r.tenant_id = d.tenant_id AND r.rule_key = d.rule_key
          WHERE d.tenant_id = ? AND d.dedup_key = ? ORDER BY fb.created_at, fb.id`, [T, CLAVE])).rows;

      console.log('\n[1] La lista: todos los turnos cerrados, cada uno con su estado');
      const r0 = await lista();
      ok(r0.turnos.map((t) => `${t.caja}:${t.estado}`).join(',') === '1:por_justificar,2:cuadra,4:cuadra',
        `caja 1 por justificar, cajas 2 y 4 cuadran en retiros, la 3 (abierta) no sale (${r0.turnos.map((t) => `${t.caja}:${t.estado}`).join(',')})`);
      const t1 = turnoDe(r0, '1') || {};
      ok(JSON.stringify(t1.motivos) === JSON.stringify(['retiros_sin_contar', 'cajon_sin_contar']), `motivos: retiros y cajón sin contar (${JSON.stringify(t1.motivos)})`);
      ok(t1.retirado_kepler === 5000 && t1.retiros_contados === 0 && t1.retiros_diferencia === -5000, 'montos: Kepler $5,000, contado $0, diferencia −$5,000');
      ok(JSON.stringify((turnoDe(r0, '4') || {}).motivos) === JSON.stringify(['cajon_sin_contar']), 'caja 4: el cajón sin contar sigue como dato en motivos');
      ok(r0.dias.length === 1 && r0.dias[0].turnos === 3 && r0.dias[0].cuadran === 2 && r0.dias[0].por_justificar === 1 && r0.dias[0].revisado === null,
        'control por día: 3 turnos, 2 cuadran, 1 por justificar, sin firmar');
      ok(r0.cajeras.length === 1 && r0.cajeras[0].cajero_code === 'ZZC01' && r0.cajeras[0].motivos.retiros_sin_contar === 1,
        'por cajera: solo sale la de retiros que no empatan (ZZC01); ZZC04 (solo cajón) no');
      const c1 = r0.cajeras[0] || {};
      ok(c1.retirado_kepler === 5000 && c1.retiros_contados === 0 && c1.retiros_diferencia === -5000 && c1.retiros_descuadre === 5000 && c1.motivos.cajon_sin_contar === 1,
        `ZZC01: Kepler $5,000 · Suite $0 · −$5,000 y 1 cajón sin contar (${JSON.stringify([c1.retirado_kepler, c1.retiros_contados, c1.retiros_diferencia, c1.retiros_descuadre])})`);
      const k = r0.totales || {};
      ok(k.retirado_kepler === 8000 && k.retiros_contados === 3000 && k.retiros_diferencia === -5000 && k.retiros_descuadre === 5000
        && k.turnos_descuadre === 1 && k.cajeras_descuadre === 1 && k.por_justificar === 1,
        `totales de la sucursal: Kepler $8,000 · Suite $3,000 · −$5,000, 1 turno de 1 cajera (${JSON.stringify(k)})`);
      ok(r0.sucursales[0].pendientes === 1 && r0.sucursales[0].dias_sin_revisar === 1, 'resumen: 1 por justificar y 1 día sin revisar');

      console.log('\n[2] Lo que debe rechazarse ANTES de justificar');
      const base = { warehouse_code: WH, fecha: FECHA, caja: '1', folio: '9001' };
      ok(await rechaza(() => svc.justificar({ warehouse_code: WH, fecha: FECHA, caja: '4', folio: '9004', causa: 'otro', nota: 'Solo el cajón quedó sin contar.' }, 'X'), /no tiene retiros por revisar/),
        'NEGATIVA: justificar un turno con SOLO el cajón sin contar → rechazado (no es caso)');
      ok(await rechaza(() => svc.accion({ ...base, accion: 'hablo_cajera', nota: 'Hablé con ella del retiro.', cerrar: false }, 'X'), /Primero di qué pasó/),
        'NEGATIVA: registrar una acción sin causa → rechazado');
      ok(await rechaza(() => svc.marcarDia({ warehouse_code: WH, fecha: FECHA }, 'X'), /Faltan 1 turno/), 'NEGATIVA: firmar el día con un turno sin justificar → rechazado');

      console.log('\n[3] Justificar con el payload de la pantalla (regla 13)');
      const just = { ...base, causa: 'no_capturado', nota: 'La cajera hizo el retiro y no lo capturó; el sobre está en la bóveda.' };
      const j = await svc.justificar(just, 'ZZENCARGADA');
      ok(j.causa === 'no_capturado' && j.por === 'ZZENCARGADA' && !!j.at, 'responde causa, quién y cuándo');
      let f = await filas();
      ok(f.length === 1 && f[0].status === 'confirmado' && f[0].causa_confirmada === 'no_capturado', 'FILA LEÍDA: el caso queda confirmado con la causa');
      ok(f[0].verdict === 'util' && f[0].nota === just.nota && f[0].created_by === 'ZZENCARGADA', 'veredicto util, nota y quién, tal cual');
      ok(Number(f[0].e) === 5000 && Number(f[0].o) === 0 && Number(f[0].i) === 5000, 'la evidencia guarda los montos del turno');
      ok(f[0].enabled === false, 'la regla queda registrada APAGADA (el escáner nocturno no la corre)');
      ok(turnoDe(await lista(), '1').estado === 'en_seguimiento', 'el turno pasa a «en seguimiento»');

      console.log('\n[4] Acción y cierre');
      ok(await rechaza(() => svc.accion({ ...base, accion: 'se_perdio', nota: 'Nota suficientemente larga.', cerrar: false }, 'X'), /Elige qué se hizo/),
        'NEGATIVA: acción fuera del catálogo → rechazada');
      ok(await rechaza(() => svc.accion({ ...base, accion: 'hablo_cajera', nota: 'corta', cerrar: false }, 'X'), /mínimo/), 'NEGATIVA: acción con nota corta → rechazada');
      const h1 = await svc.accion({ ...base, accion: 'hablo_cajera', nota: 'Le expliqué que cada retiro se cuenta al momento.', cerrar: false }, 'ZZENCARGADA');
      ok(h1.map((e) => e.tipo).join(',') === 'causa,accion', `historial: causa, acción (${h1.map((e) => e.tipo).join(',')})`);
      ok(turnoDe(await lista(), '1').estado === 'en_seguimiento', 'con una acción sin cerrar sigue en seguimiento');
      const h2 = await svc.accion({ ...base, accion: 'corrigio_suite', nota: 'Se capturó el retiro de las 14:00 en la Suite.', cerrar: true }, 'ZZENCARGADA');
      ok(h2.map((e) => e.tipo).join(',') === 'causa,accion,accion,cerrado', `cerrar agrega la acción y el cierre (${h2.map((e) => e.tipo).join(',')})`);
      f = await filas();
      ok(f[0].status === 'corregido' && f.length === 4 && f[3].causa === 'cerrado', 'FILA LEÍDA: el caso queda «corregido» con 4 renglones de historial');
      const r2 = await lista();
      ok(turnoDe(r2, '1').estado === 'cerrado', 'el turno sale como cerrado');
      ok(await rechaza(() => svc.justificar({ ...just, causa: 'otra_caja' }, 'X'), /ya está cerrado/), 'NEGATIVA: cambiar la causa de un caso cerrado → rechazado');
      ok(await rechaza(() => svc.accion({ ...base, accion: 'escalo', nota: 'Otra acción más larga.', cerrar: false }, 'X'), /ya está cerrado/), 'NEGATIVA: otra acción en un caso cerrado → rechazada');

      console.log('\n[5] Firmar el día');
      const firma = await svc.marcarDia({ warehouse_code: WH, fecha: FECHA, nota: null }, 'ZZENCARGADA');
      ok(firma.por === 'ZZENCARGADA' && !!firma.at, 'la firma devuelve quién y cuándo');
      const r3 = await lista();
      ok(r3.dias[0].revisado && r3.dias[0].revisado.por === 'ZZENCARGADA', 'el día sale revisado por la encargada');
      ok(r3.sucursales[0].dias_sin_revisar === 0, 'resumen: 0 días sin revisar');
      const fd = (await trx.raw(`SELECT d.status, fb.causa, r.enabled FROM reconciliation.discrepancies d
        JOIN reconciliation.discrepancy_feedback fb ON fb.tenant_id = d.tenant_id AND fb.discrepancy_id = d.id
        JOIN reconciliation.rule_registry r ON r.tenant_id = d.tenant_id AND r.rule_key = d.rule_key
        WHERE d.tenant_id = ? AND d.dedup_key = ?`, [T, `dia_revisado:${WH}:${FECHA}`])).rows;
      ok(fd.length === 1 && fd[0].causa === 'dia_revisado' && fd[0].enabled === false, 'FILA LEÍDA: la firma del día con su regla apagada');
      const res = await svc.resumen(FECHA, FECHA, [WH]);
      ok(res.por_justificar === 0 && res.en_seguimiento === 0 && res.dias_sin_revisar === 0, 'el aviso de las pestañas queda en cero');
      const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
      ok(await rechaza(() => svc.marcarDia({ warehouse_code: WH, fecha: hoy }, 'X'), /ya terminó/), 'NEGATIVA: firmar el día de HOY → rechazado');

      console.log('\n[6] Otras negativas');
      ok(await rechaza(() => svc.justificar({ ...just, nota: '          x ' }, 'X'), /mínimo/), 'NEGATIVA: nota de puros espacios → rechazada');
      ok(await rechaza(() => svc.justificar({ ...just, causa: 'se_perdio' }, 'X'), /Elige la causa/), 'NEGATIVA: causa fuera del catálogo → rechazada');
      ok(await rechaza(() => svc.justificar({ ...just, caja: '2', folio: '9002' }, 'X'), /no tiene retiros por revisar/), 'NEGATIVA: un turno que cuadra (caja 2) no se justifica');
      ok(await rechaza(() => svc.justificar({ ...just, caja: '3', folio: '9003' }, 'X'), /no tiene retiros por revisar/), 'NEGATIVA: un turno abierto (caja 3) no se justifica');
      ok(await rechaza(() => svc.justificar({ ...just, folio: '12345' }, 'X'), /no tiene retiros por revisar/), 'NEGATIVA: un folio que no existe → rechazado');
      ok(await rechaza(() => svc.pendientes('2026-01-01', '2026-03-01', [WH]), /Máximo/), 'NEGATIVA: más de 31 días por consulta → rechazado');

      throw new Error(RB);
    }).catch((e) => { if (!e.message.includes(RB)) throw e; });
  }
  noMedido('403 de la cajera y de otra sucursal: lo cobran RolesGuard + ScopeService en el controller; necesita la API (HTTP)');
})()
  .catch((e) => { fail++; console.log('  ✗ ERROR', e.message); })
  .finally(async () => {
    await knex.destroy();
    console.log(`\n${pass} ✓ · ${fail} ✗ · ${nm} NO MEDIDO`);
    process.exit(fail ? 1 : 0);
  });
