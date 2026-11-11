#!/usr/bin/env node
'use strict';
/**
 * `[AU.34]` Cambiar el username de una cuenta — sólo si nada lo usa como llave.
 *
 *   A. El catálogo (`username-history.ts`, puro): identificadores válidos y sin repetir, y el
 *      DTO del cambio exige el MISMO formato que el alta.
 *   B. El endpoint que ESCRIBE (regla 13): el servicio real contra una base real, con el payload
 *      de la pantalla (`{ username, motivo }`). Una cuenta limpia se renombra: cambia el nombre,
 *      no la contraseña, se cierra su sesión, queda el evento y se invalida el caché. Y se
 *      rechaza, sin tocar nada, cuando:
 *        · es cajero en Kepler (aunque el código venga en otra caja de letras),
 *        · el nombre ya existe, es la propia cuenta, es el mismo nombre o falta el motivo.
 *      El `PUT` general ya no renombra (era la puerta trasera), pero acepta el mismo nombre.
 *   PRUEBA NEGATIVA de la compuerta: sin poder revisar una tabla obligatoria, NO renombra
 *   (NO MEDIDO ≠ limpio). Si eso saliera verde, la compuerta no estaría midiendo.
 *
 * Todo dentro de una transacción que se revierte. Sin base o sin `sessions_revoked_at`
 * (migración [ID.38]): NO MEDIDO, nunca ✔.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-users-rename');

const T = '00000000-0000-0000-0000-00000000d01c';
const ADMIN = '99999999-3434-4000-8000-000000000001';
const LIMPIA = '99999999-3434-4000-8000-000000000002';
const CAJERA = '99999999-3434-4000-8000-000000000003';
const OTRA = '99999999-3434-4000-8000-000000000004';
const REVERTIR_ID = '99999999-3434-4000-8000-000000000005';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

// `platform-core` exige JWT_SECRET AL IMPORTARSE (fail-fast a propósito), y el job `pruebas-db` del CI no
// lo define: sin esto la prueba quedaba NO MEDIDA en el CI y verde sólo en una laptop con `.env`. Es un
// secreto GENERADO que no firma nada real — el mismo recurso que `libs/hr` y `libs/finance` en su vitest.
if (!process.env.JWT_SECRET) {
  const { randomUUID } = require('crypto');
  process.env.JWT_SECRET = `pruebas-${randomUUID()}-${randomUUID()}`;
}

let Servicio, Catalogo, RenameUserDto, UserWriteDto, getMetadataStorage;
try {
  require('ts-node').register({
    transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' },
  });
  const fs = require('fs');
  const tsc = require('typescript');
  const TSCONFIG = path.join(__dirname, '../../tsconfig.base.json');
  const base = tsc.parseConfigFileTextToJson(TSCONFIG, fs.readFileSync(TSCONFIG, 'utf8')).config;
  require('tsconfig-paths').register({ baseUrl: path.join(__dirname, '../..'), paths: base.compilerOptions.paths });
  require('reflect-metadata');
  const U = path.join(__dirname, '../../libs/trade/src/lib/users');
  Catalogo = require(path.join(U, 'username-history.ts'));
  ({ RenameUserDto } = require(path.join(U, 'dto/rename-user.dto.ts')));
  ({ UserWriteDto } = require(path.join(U, 'dto/user-write.dto.ts')));
  ({ getMetadataStorage } = require('class-validator'));
  ({ UsersService: Servicio } = require(path.join(U, 'users.service.ts')));
} catch (e) { noMedido(`no se pudo cargar el código real con ts-node: ${e.message}`); salir(); }

console.log('\n── A. el catálogo y el formato ──');
{
  const { CHEQUEOS_DE_USUARIO, partesDeTabla, expresionNormalizada } = Catalogo;
  let validos = true;
  for (const c of CHEQUEOS_DE_USUARIO) {
    try { partesDeTabla(c.tabla); c.columnas.forEach((col) => expresionNormalizada(col, !!c.persona)); } catch { validos = false; }
  }
  ok(validos, `las ${CHEQUEOS_DE_USUARIO.length} entradas tienen tabla y columnas válidas`);
  const claves = CHEQUEOS_DE_USUARIO.map((c) => c.clave);
  ok(new Set(claves).size === claves.length, 'ninguna clave se repite');
  let rechaza = false;
  try { partesDeTabla('analytics.x; drop table y'); } catch { rechaza = true; }
  ok(rechaza, 'PRUEBA NEGATIVA: un identificador con SQL adentro se rechaza');

  const reglas = (cls) => getMetadataStorage().getTargetValidationMetadatas(cls, '', true, false)
    .filter((m) => m.propertyName === 'username')
    .map((m) => `${m.name || m.type}:${JSON.stringify(m.constraints || [])}`).sort().join('|');
  ok(reglas(RenameUserDto) !== '' && reglas(RenameUserDto) === reglas(UserWriteDto),
    'el DTO del cambio exige el mismo formato de username que el alta');

  // `#414`: un decorador mal leído tumbó la API con el CI en verde. El ValidationPipe valida el
  // cuerpo contra el tipo que dice `design:paramtypes`; si ahí no está RenameUserDto, el cuerpo
  // pasaría sin validar. (Leído con ts-node: es la metadata que emite TypeScript, no el bundle.)
  try {
    const { UsersController } = require(path.join(__dirname, '../../libs/trade/src/lib/users/users.controller.ts'));
    const tipos = Reflect.getMetadata('design:paramtypes', UsersController.prototype, 'rename') || [];
    ok(tipos[1] === RenameUserDto, 'POST /users/:id/rename valida el cuerpo contra RenameUserDto (design:paramtypes)');
  } catch (e) { noMedido(`no se pudo cargar el controlador: ${e.message}`); }
}

console.log('\n── B. el endpoint que escribe, contra base real ──');
(async () => {
  const knex = require('knex')(require('../knexfile-newdb.js').development);
  const REVERTIR = new Error('revertir');
  try { await knex.raw('SELECT 1'); } catch (e) { noMedido(`sin base: ${e.message}`); await knex.destroy().catch(() => {}); return salir(); }

  try {
    await knex.transaction(async (trx) => {
      const col = (await trx.raw(`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='identity'
        AND table_name='users' AND column_name='sessions_revoked_at') AS c`)).rows[0].c;
      if (!col) { noMedido('falta identity.users.sessions_revoked_at (migración [ID.38] sin aplicar)'); throw REVERTIR; }
      if (!(await trx.raw('SELECT 1 FROM identity.tenants WHERE id = ?', [T])).rows.length) { noMedido('la base no tiene el tenant mega_dulces'); throw REVERTIR; }
      // `[CANON.6.1]` Los cajeros de Kepler se leen de la vista `analytics.v_pos_cashiers` sobre el ODS. Una
      // base sin ODS (la del CI) no tiene `kepler_ods.kdpv_*`: las tablas las crea el handler de ingesta en
      // runtime, no una migración. Se crean con lo mínimo y la vista con SU migración, dentro de esta
      // transacción (que se revierte).
      if (!(await trx.raw(`SELECT to_regclass('analytics.v_pos_cashiers') t`)).rows[0].t) {
        try {
          await trx.raw('SAVEPOINT ods_au34');
          await trx.raw('CREATE SCHEMA IF NOT EXISTS kepler_ods');
          await trx.raw('CREATE TABLE IF NOT EXISTS kepler_ods.kdpv_kdku (sucursal text, c1 text, c2 text)');
          await trx.raw('CREATE TABLE IF NOT EXISTS kepler_ods.kdpv_gerentes (sucursal text, c1 text, c2 text, c3 text)');
          await require(path.join(__dirname, '../migrations-newdb', '20261111093151_canon61_v_pos_cashiers.js')).up(trx);
          await trx.raw('RELEASE SAVEPOINT ods_au34');
          console.log('  ·  (se creó analytics.v_pos_cashiers con su migración, dentro de la transacción)');
        } catch (e) {
          await trx.raw('ROLLBACK TO SAVEPOINT ods_au34');
          noMedido(`falta analytics.v_pos_cashiers y su migración no aplica en esta base: ${e.message.slice(0, 120)}`);
          throw REVERTIR;
        }
      }
      // Una base local atrasada no tiene todas las tablas del catálogo. Se crean con SU migración
      // dentro de esta transacción (que se revierte); si alguna no aplica, se declara, no se finge.
      const MIGRACION_DE = {
        'budget.budgets': ['20260914130000_budget_and_obligation_origins', '20260917140000_budget_lines_ledger'],
        'commercial.purchase_deliveries': ['20260929180300_re32_purchase_deliveries'],
      };
      for (const [tabla, migs] of Object.entries(MIGRACION_DE)) {
        if ((await trx.raw('SELECT to_regclass(?) t', [tabla])).rows[0].t) continue;
        try {
          await trx.raw('SAVEPOINT mig_au34');
          for (const mig of migs) await require(path.join(__dirname, '../migrations-newdb', `${mig}.js`)).up(trx);
          await trx.raw('RELEASE SAVEPOINT mig_au34');
          console.log(`  ·  (se creó ${tabla} con ${migs.join(' + ')}, dentro de la transacción)`);
        } catch (e) {
          await trx.raw('ROLLBACK TO SAVEPOINT mig_au34');
          noMedido(`falta ${tabla} y su migración no aplica en esta base: ${e.message.slice(0, 120)}`);
          throw REVERTIR;
        }
      }

      // Un rol que YA existe: `fk_users_tenant_role` se revisa al renombrar (UPDATE), aunque el
      // INSERT de abajo vaya sin disparadores.
      const rol = (await trx.raw(`SELECT role_name FROM identity.users WHERE tenant_id = ? AND role_name IS NOT NULL
        GROUP BY role_name ORDER BY count(*) DESC LIMIT 1`, [T])).rows[0]?.role_name;
      if (!rol) { noMedido('la base no tiene ninguna cuenta con rol para copiarlo'); throw REVERTIR; }
      await trx.raw('SET LOCAL session_replication_role = replica');
      for (const [id, u] of [[ADMIN, 'au34_admin'], [LIMPIA, 'au34_limpia'], [CAJERA, 'au34_cajera'], [OTRA, 'au34_otra'], [REVERTIR_ID, 'au34_revertir']]) {
        await trx.raw(`INSERT INTO identity.users (id, tenant_id, username, role_name, activo, kind, password_hash, created_at, updated_at)
          VALUES (?, ?, ?, ?, true, 'interno', 'hash-de-prueba', now(), now())`, [id, T, u, rol]);
      }
      // El código de cajero viene de Kepler en MAYÚSCULAS: tiene que reconocerse igual. El segundo es
      // de un cajero SIN cuenta en la Suite: nadie debe poder renombrarse a él y heredar sus cortes.
      await trx.raw(`INSERT INTO kepler_ods.kdpv_kdku (sucursal, c1, c2) VALUES
        ('99', 'AU34_CAJERA', 'CAJERA DE PRUEBA'), ('99', 'AU34_AJENO', 'CAJERO SIN CUENTA')`);
      await trx.raw('SET LOCAL session_replication_role = origin');

      let invalidados = 0;
      const s = Object.create(Servicio.prototype);
      Object.assign(s, {
        knex: trx,
        logger: { log() {}, warn() {}, error() {}, debug() {} },
        tenantCtx: { requireTenantId: () => T },
        permsCache: { invalidateUser: () => { invalidados++; } },
      });
      const yo = { sub: ADMIN, username: 'au34_admin' };
      const falla = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
      const fila = async (id) => (await trx.raw('SELECT username, password_hash, sessions_revoked_at FROM identity.users WHERE id = ?', [id])).rows[0];

      // 1. Cuenta limpia, con el payload de la pantalla.
      // El reloj de la BASE, no el de Node: el corte se compara contra el iat de un token emitido
      // mientras corría el cambio. Con `now()` el corte caía en el INICIO de la transacción (aquí,
      // el inicio de toda la prueba) y un token de en medio sobrevivía — esta comparación lo caza.
      const reloj = async () => Number((await trx.raw('SELECT extract(epoch FROM clock_timestamp())::float8 AS t')).rows[0].t);
      const t0 = await reloj();
      const r = await s.rename(LIMPIA, 'AU34_Corregida', 'tenía un error de dedo', yo);
      const tFin = await reloj();
      const f = await fila(LIMPIA);
      ok(r.username === 'au34_corregida' && f.username === 'au34_corregida', 'se renombra, en minúsculas como el alta');
      ok(r.username_anterior === 'au34_limpia', 'la respuesta dice cómo se llamaba');
      ok(f.password_hash === 'hash-de-prueba', 'la contraseña no cambia');
      const corte = f.sessions_revoked_at ? new Date(f.sessions_revoked_at).getTime() / 1000 : null;
      ok(corte !== null && corte >= t0 && corte <= tFin,
        `el corte de sesión cae al FINAL del cambio (no al inicio de la transacción): un token emitido mientras corría queda anterior${corte !== null ? ` [${(corte - t0).toFixed(3)} s después de empezar]` : ''}`);
      ok(invalidados >= 1, 'se invalida el caché del guard (si no, el corte tarda 30 s)');
      const ev = (await trx.raw(`SELECT detalle, actor_user_id FROM identity.user_events WHERE user_id = ? AND event = 'username_renombrado'`, [LIMPIA])).rows;
      const det = ev[0] && (typeof ev[0].detalle === 'string' ? JSON.parse(ev[0].detalle) : ev[0].detalle);
      ok(ev.length === 1 && det.antes === 'au34_limpia' && det.despues === 'au34_corregida' && det.motivo === 'tenía un error de dedo' && ev[0].actor_user_id === ADMIN,
        'queda en la bitácora: antes, después, motivo y quién');

      // 2. Cajera de Kepler: se rechaza con la lista y no cambia nada.
      let e = await falla(() => s.rename(CAJERA, 'au34_cajera2', 'cambio de prueba', yo));
      const cuerpo = e && e.getResponse ? e.getResponse() : {};
      ok(e && e.getStatus && e.getStatus() === 409 && cuerpo.code === 'usuario_con_historia', 'cajera de Kepler: 409 usuario_con_historia');
      ok(Array.isArray(cuerpo.encontrados) && cuerpo.encontrados.some((h) => h.clave === 'kepler_cajero'), 'dice dónde aparece (código de cajero en Kepler)');
      ok((await fila(CAJERA)).username === 'au34_cajera', 'y su usuario no cambió');

      // 2b. El nombre NUEVO es el código de un cajero de Kepler sin cuenta: renombrarse a él heredaría sus cortes.
      e = await falla(() => s.rename(OTRA, 'au34_ajeno', 'cambio de prueba', yo));
      const c3 = e && e.getResponse ? e.getResponse() : {};
      ok(e && e.getStatus && e.getStatus() === 409 && c3.code === 'usuario_nuevo_ocupado' && (c3.encontrados || []).some((h) => h.clave === 'kepler_cajero'),
        'el nombre nuevo ya es llave de otra persona (cajero de Kepler): 409 usuario_nuevo_ocupado');
      ok((await fila(OTRA)).username === 'au34_otra', 'y la cuenta quedó igual');

      // 3. Los rechazos sencillos, sin tocar nada.
      e = await falla(() => s.rename(OTRA, 'au34_corregida', 'cambio de prueba', yo));
      ok(e && e.getStatus && e.getStatus() === 409 && (await fila(OTRA)).username === 'au34_otra', 'nombre ya usado: 409 y sin cambio');
      e = await falla(() => s.rename(ADMIN, 'au34_admin2', 'cambio de prueba', yo));
      ok(e && e.getStatus && e.getStatus() === 403, 'nadie se renombra a sí mismo: 403');
      e = await falla(() => s.rename(OTRA, 'AU34_OTRA', 'cambio de prueba', yo));
      ok(e && e.getStatus && e.getStatus() === 400, 'el mismo nombre (aunque cambie la caja de letras): 400');
      e = await falla(() => s.rename(OTRA, 'au34_otra2', 'no', yo));
      ok(e && e.getStatus && e.getStatus() === 400 && (await fila(OTRA)).username === 'au34_otra', 'sin motivo: 400 y sin cambio');

      // 4. La puerta trasera: el PUT general ya no renombra.
      e = await falla(() => s.update(OTRA, { username: 'au34_por_put' }, yo));
      ok(e && e.getStatus && e.getStatus() === 400 && (await fila(OTRA)).username === 'au34_otra', 'PUT /users/:id con otro username: 400 y sin cambio');
      e = await falla(() => s.update(OTRA, { username: 'au34_otra', nombre: 'Otra Persona' }, yo));
      const nombreGuardado = (await trx.raw('SELECT nombre FROM identity.users WHERE id = ?', [OTRA])).rows[0]?.nombre;
      ok(!e && nombreGuardado === 'Otra Persona',
        `PUT con el MISMO username sigue guardando lo demás${e ? ` (respondió ${e.getStatus ? e.getStatus() : ''} ${e.message})` : ''}`);

      // 5. PRUEBA NEGATIVA de la compuerta: si una tabla obligatoria no se puede revisar, no renombra.
      await trx.raw('SAVEPOINT sin_tabla');
      await trx.raw('ALTER VIEW analytics.v_pos_cashiers RENAME TO v_pos_cashiers_au34');
      e = await falla(() => s.rename(OTRA, 'au34_otra3', 'cambio de prueba', yo));
      const c2 = e && e.getResponse ? e.getResponse() : {};
      ok(e && ['usuario_con_historia', 'usuario_nuevo_ocupado'].includes(c2.code) && (c2.sin_revisar || []).some((h) => h.clave === 'kepler_cajero'),
        'sin poder revisar los cajeros de Kepler: NO renombra (NO MEDIDO ≠ limpio)');
      ok((c2.sin_revisar || []).every((h) => Object.keys(h).sort().join() === 'clave,etiqueta'),
        'al navegador va sólo QUÉ no se revisó (clave y etiqueta), nunca el error de la base con su SQL');
      await trx.raw('ROLLBACK TO SAVEPOINT sin_tabla');
      ok((await fila(OTRA)).username === 'au34_otra', 'y la cuenta quedó igual');

      // 6. Lo que aparece con el nombre viejo MIENTRAS se cambia: el cambio se deshace. Se simula con un
      // disparador que, al renombrar, crea un código de cajero con el nombre viejo (lo que haría un
      // corte que la persona cerró con su sesión todavía viva). Vive en esta transacción y se revierte.
      await trx.raw(`CREATE FUNCTION pg_temp.au34_aparece() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN
          INSERT INTO kepler_ods.kdpv_kdku (sucursal, c1, c2)
          VALUES ('98', upper(OLD.username), 'APARECIO DURANTE EL CAMBIO') ON CONFLICT DO NOTHING;
          RETURN NEW;
        END $f$`);
      await trx.raw(`CREATE TRIGGER au34_aparece AFTER UPDATE OF username ON identity.users
        FOR EACH ROW WHEN (OLD.username = 'au34_revertir') EXECUTE FUNCTION pg_temp.au34_aparece()`);
      e = await falla(() => s.rename(REVERTIR_ID, 'au34_revertir_nuevo', 'cambio de prueba', yo));
      await trx.raw('DROP TRIGGER au34_aparece ON identity.users');
      const c4 = e && e.getResponse ? e.getResponse() : {};
      ok(e && e.getStatus && e.getStatus() === 409 && c4.code === 'renombre_revertido',
        `si aparece algo con el nombre viejo durante el cambio: 409 renombre_revertido${e && !c4.code ? ` (${e.message})` : ''}`);
      const fr = await fila(REVERTIR_ID);
      ok(fr.username === 'au34_revertir', 'y la cuenta vuelve a su nombre (nada queda huérfano)');
      const evs = (await trx.raw(`SELECT event FROM identity.user_events WHERE user_id = ? ORDER BY created_at, event`, [REVERTIR_ID])).rows.map((x) => x.event);
      ok(evs.includes('username_renombrado') && evs.includes('username_renombre_revertido'), 'la bitácora tiene el cambio Y la reversa');

      throw REVERTIR;
    });
  } catch (e) {
    if (e !== REVERTIR) {
      fail++;
      const det = e && e.getResponse ? e.getResponse().sin_revisar : null;
      console.log('  ✗ error inesperado:', e && e.message, det ? `\n    sin revisar: ${det.map((h) => h.motivo).join(' · ')}` : '');
    }
  } finally {
    await knex.destroy().catch(() => {});
  }
  salir();
})();
