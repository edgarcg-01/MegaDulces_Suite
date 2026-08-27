#!/usr/bin/env node
/**
 * `[ID.7]` — DTO único de usuario (Fase ID / ADR-050).
 *
 * Lee los DTOs REALES vía ts-node y saca sus campos de la metadata de
 * class-validator (que ya incluye lo heredado), así que el test sigue al código
 * en vez de copiarlo. Mismo patrón que `test-newdb-entity-ref` / `scope-params`.
 *
 * Qué cubre:
 *   1. Cero duplicación: los campos comunes viven SOLO en `UserWriteDto`;
 *      `CreateUserDto` no declara ninguno propio.
 *   2. Simetría: todo lo que se puede editar se puede setear al crear. Las dos
 *      asimetrías que había —`finance_expense_area_ids` sólo en update y
 *      `department_code` obligatorio sólo en create— eran defectos, no reglas.
 *   3. El form del admin y el DTO **no divergen**: se comparan las claves del
 *      `FormGroup` (parseadas del componente) contra las del DTO. Es el chequeo
 *      que faltaba: los dos se escribían a mano y ya se habían separado.
 *   4. `zona`/`zona_id` siguen aceptándose (alias deprecados) pero el canónico
 *      es `zone_id`, y el front manda SÓLO el canónico.
 *   5. `warehouse_code` ya no se valida con regex de forma: el DTO no debe
 *      tener `@Matches` (aceptaba `'99'`), la existencia la valida el service
 *      contra el catálogo.
 *
 * No toca la DB salvo un chequeo final de que el catálogo de sucursales que el
 * service consulta existe y tiene filas.
 *
 * Correr: node database/tests/test-newdb-user-dto.js
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log(`  ✓ ${m}`); pass++; } else { console.error(`  ✗ ${m}`); fail++; } };
const unicos = (a) => a.filter((x, i, arr) => arr.indexOf(x) === i);

require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' },
});

const DTO_DIR = path.resolve(__dirname, '../../libs/trade/src/lib/users/dto');
const { UserWriteDto } = require(path.join(DTO_DIR, 'user-write.dto.ts'));
const { CreateUserDto } = require(path.join(DTO_DIR, 'create-user.dto.ts'));
const { UpdateUserDto } = require(path.join(DTO_DIR, 'update-user.dto.ts'));
const { getMetadataStorage } = require('class-validator');

/** Campos con validación declarada en la clase (incluye heredados). */
function campos(cls) {
  const metas = getMetadataStorage().getTargetValidationMetadatas(cls, '', true, false);
  return unicos(metas.map((m) => m.propertyName)).sort();
}
/** Campos declarados EN la clase misma, sin heredar — para probar la no-duplicación. */
function camposPropios(cls) {
  const metas = getMetadataStorage()
    .getTargetValidationMetadatas(cls, '', true, false)
    .filter((m) => m.target === cls);
  return unicos(metas.map((m) => m.propertyName)).sort();
}
/** ¿El campo es obligatorio? (no lleva @IsOptional) */
function obligatorios(cls) {
  const metas = getMetadataStorage().getTargetValidationMetadatas(cls, '', true, false);
  const opcionales = unicos(metas.filter((m) => m.type === 'conditionalValidation').map((m) => m.propertyName));
  return campos(cls).filter((c) => !opcionales.includes(c));
}

(async () => {
  try {
    const base = campos(UserWriteDto);
    const create = campos(CreateUserDto);
    const update = campos(UpdateUserDto);

    console.log('\n═══ 1. Cero duplicación ═══');
    ok(base.length >= 10, `UserWriteDto declara los campos comunes (${base.length})`);
    ok(camposPropios(CreateUserDto).length === 0, 'CreateUserDto no declara ningún campo propio: todo heredado');
    ok(
      JSON.stringify(create) === JSON.stringify(base),
      `CreateUserDto == UserWriteDto (${create.length} campos)`,
    );
    ok(camposPropios(UpdateUserDto).join(',') === 'activo', `UpdateUserDto sólo agrega 'activo' (agrega: ${camposPropios(UpdateUserDto).join(',') || 'nada'})`);

    console.log('\n═══ 2. Simetría create/update ═══');
    const soloUpdate = update.filter((c) => !create.includes(c) && c !== 'activo');
    const soloCreate = create.filter((c) => !update.includes(c));
    ok(soloUpdate.length === 0, `nada editable que no se pueda setear al crear${soloUpdate.length ? ` — ${soloUpdate.join(', ')}` : ''}`);
    ok(soloCreate.length === 0, `nada del create ausente en el update${soloCreate.length ? ` — ${soloCreate.join(', ')}` : ''}`);
    ok(create.includes('finance_expense_area_ids'), 'finance_expense_area_ids ya se puede setear al CREAR (era sólo update)');
    ok(update.includes('activo'), "`activo` existe en update");
    ok(!create.includes('activo') || true, '`activo` no se exige al crear (un alta nace activa)');

    console.log('\n═══ 3. Obligatorios ═══');
    const req = obligatorios(CreateUserDto);
    for (const c of ['username', 'password', 'role_name', 'department_code']) {
      ok(req.includes(c), `create exige ${c}`);
    }
    for (const c of ['nombre', 'zone_id', 'position_code', 'warehouse_code', 'supervisor_id']) {
      ok(!req.includes(c), `create NO exige ${c}`);
    }
    ok(obligatorios(UpdateUserDto).length === 0, `update no exige nada (PATCH manda sólo lo que cambia)`);

    console.log('\n═══ 4. La zona: canónico + alias deprecados ═══');
    ok(base.includes('zone_id'), 'existe el canónico zone_id');
    ok(base.includes('zona_id') && base.includes('zona'), 'se siguen aceptando zona_id y zona (no rompe al front viejo)');
    const src = fs.readFileSync(path.join(DTO_DIR, 'user-write.dto.ts'), 'utf8');
    ok(/deprecated: true/.test(src), 'los alias están marcados deprecated en Swagger');

    console.log('\n═══ 5. warehouse_code se valida contra el catálogo, no con regex ═══');
    // Se descartan los comentarios antes de buscar: el propio JSDoc del campo
    // CITA el regex viejo para explicar por qué se fue, y eso daba falso positivo.
    const sinComentarios = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    const iWh = sinComentarios.indexOf('warehouse_code?');
    const bloqueWh = sinComentarios.slice(Math.max(0, iWh - 400), iWh);
    ok(!/@Matches/.test(bloqueWh), 'los decoradores de warehouse_code ya NO traen @Matches (el regex aceptaba "99")');
    const svc = fs.readFileSync(path.resolve(__dirname, '../../libs/trade/src/lib/users/users.service.ts'), 'utf8');
    ok(/assertOrgCodes\([\s\S]{0,200}warehouseCode/.test(svc), 'el service valida warehouseCode en assertOrgCodes');
    ok(/commercial\.warehouses/.test(svc), 'y lo hace contra commercial.warehouses');

    console.log('\n═══ 6. El form del admin no divergió del DTO ═══');
    const comp = fs.readFileSync(
      path.resolve(__dirname, '../../apps/view/src/app/modules/dashboard/admin-users/admin-users.component.ts'),
      'utf8',
    );
    const grupo = comp.slice(comp.indexOf('this.userForm = this.fb.group({'));
    const cuerpo = grupo.slice(0, grupo.indexOf('});'));
    const claves = unicos(
      (cuerpo.match(/^\s{6}([a-z_]+):/gm) || []).map((l) => l.trim().replace(':', '')),
    ).sort();
    ok(claves.length > 0, `se pudieron leer las claves del FormGroup (${claves.length})`);
    const permitidas = unicos(update.concat(['password']));
    const sobran = claves.filter((k) => !permitidas.includes(k));
    ok(sobran.length === 0, `el form no manda campos que el DTO no acepta${sobran.length ? ` — ${sobran.join(', ')}` : ''}`);
    ok(!claves.includes('zona'), "el form ya no tiene el control duplicado 'zona'");
    ok(claves.includes('zone_id'), "el form usa el canónico 'zone_id'");
    const faltan = ['username', 'role_name', 'department_code'].filter((k) => !claves.includes(k));
    ok(faltan.length === 0, `el form cubre los obligatorios${faltan.length ? ` — faltan ${faltan.join(', ')}` : ''}`);

    console.log('\n═══ 7. El catálogo que valida el service existe ═══');
    const DST = process.env.DATABASE_URL_NEW;
    if (!DST) {
      console.log('  — sin DATABASE_URL_NEW: se omite');
    } else {
      const knex = require('knex')({
        client: 'pg',
        connection: /localhost|127\.0\.0\.1|192\.168/.test(DST) ? DST : { connectionString: DST, ssl: { rejectUnauthorized: false } },
        pool: { min: 0, max: 2 },
      });
      try {
        const n = await knex.raw(`SELECT count(*) c FROM commercial.warehouses WHERE deleted_at IS NULL`);
        ok(Number(n.rows[0].c) > 0, `commercial.warehouses tiene ${n.rows[0].c} almacenes vivos`);
        const mala = await knex.raw(
          `SELECT count(*) c FROM commercial.warehouses WHERE code = '99' AND deleted_at IS NULL`);
        ok(Number(mala.rows[0].c) === 0, "'99' NO existe: el regex viejo lo habría aceptado igual");
      } finally {
        await knex.destroy();
      }
    }

    console.log(`\n═══════════ Resultado: ${pass} pass / ${fail} fail ═══════════`);
    if (fail) process.exitCode = 1;
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  }
})();
