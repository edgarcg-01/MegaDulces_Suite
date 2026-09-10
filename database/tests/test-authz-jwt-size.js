'use strict';
/**
 * `[ID.29]` — Al token sólo viajan las claves CONCEDIDAS, y el header entra en
 * el buffer que nginx acepta por default.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 * `/admin/roles` guarda el JSONB **completo** (el front itera todo el enum y
 * escribe las 175 claves, la mayoría en `false`) y ese mapa viaja en el header
 * `Authorization` de **cada request**. Ya reventó una vez: los **tres**
 * `nginx.conf` del repo llevan el mismo parche `large_client_header_buffers`
 * con el mismo comentario explicando que el JWT pasaba los 8k y daba 400 en
 * todo `/api`.
 *
 * Este candado mide el peso REAL por rol contra prod y afirma dos cosas: que el
 * filtro está puesto en los DOS caminos de login, y que ningún rol vivo se
 * acerca al límite.
 *
 * ── Lo que NO afirma, y hay que decirlo ──────────────────────────────────────
 * No prueba que el permiso salga del token. Eso es la segunda mitad de la
 * etapa: los tres guards de ruta del front leen `authService.user()?.permissions`
 * —el mapa decodificado del JWT— así que quitarlo antes de que la UI resuelva
 * `GET /users/me/access` rebotaría a todo no-admin a `/sin-acceso`.
 *
 * Read-only. No firma tokens: el peso lo domina el payload en base64url, y las
 * dos partes fijas (header + firma HS256) suman igual en los dos escenarios.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const fs = require('fs');
const knex = require('knex');

const URL = process.env.FLEET_DB_URL || process.env.DATABASE_URL_NEW;
const REPO = path.resolve(__dirname, '..', '..');
const TENANT = '00000000-0000-0000-0000-00000000d01c';

/** Lo que nginx acepta sin el parche. Es el número que importa. */
const LIMITE_NGINX = 8192;
/** "Bearer " + header + los dos puntos + firma HS256. */
const FIJO = 120;

let ok = 0;
let fail = 0;
let nomedido = 0;
const check = (cond, msg) => {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ FAIL ${msg}`); }
};
const declarar = (msg) => { nomedido++; console.log(`  ~ NO MEDIDO ${msg}`); };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url').length;

(async () => {
  if (!URL) { console.error('Falta FLEET_DB_URL / DATABASE_URL_NEW'); process.exit(1); }
  const k = knex({
    client: 'pg',
    pool: { min: 0, max: 2 },
    connection: /rlwy|railway/i.test(URL)
      ? { connectionString: URL, ssl: { rejectUnauthorized: false } }
      : URL,
  });

  try {
    console.log('\n[1] El filtro está en los DOS caminos de login');
    // Hay dos: `/auth/login` (legacy) y `/auth-mt/login`. Que uno lo tenga y el
    // otro no es peor que no tenerlo: el peso vuelve por la puerta que nadie mira.
    const LOGINS = [
      'apps/api/src/modules/auth/auth.service.ts',
      'apps/api/src/modules/auth-mt/auth-mt.service.ts',
    ];
    for (const f of LOGINS) {
      const src = fs.readFileSync(path.join(REPO, f), 'utf8');
      check(/soloConcedidos\s*\(/.test(src), `${f.split('/').pop()} filtra con soloConcedidos()`);
    }
    // Y que el primitivo viva en libs/, no copiado (ADR-056).
    const helper = 'libs/platform-core/src/lib/ability/granted-permissions.ts';
    check(fs.existsSync(path.join(REPO, helper)), `el primitivo vive en ${helper}, no copiado en cada login`);

    console.log('\n[2] PRUEBA NEGATIVA — el filtro realmente descarta');
    // Se ejecuta el `.ts` REAL con ts-node, igual que hace el smoke del DTO con
    // los decoradores: probar una copia de la regla escrita acá comprobaría que
    // sé escribir un filter, no que el login filtre. Si ts-node no está, se
    // DECLARA — no se sustituye por una reimplementación que siempre pasa.
    let filtrar = null;
    try {
      // `skipProject: true` es obligatorio: sin él ts-node toma el tsconfig del
      // monorepo y falla con TS5011 («the common source directory…»). Mismo
      // patrón que `test-newdb-user-dto` / `scope-params`, que ya lo aprendieron.
      // El helper no importa nada, así que descartar los `paths` no lo afecta.
      require('ts-node').register({
        transpileOnly: true, skipProject: true,
        compilerOptions: {
          module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node',
          // Sin esto: TS5107, `moduleResolution=node10` está deprecado. Mismo
          // juego de opciones que `test-newdb-user-dto`, que ya pasó por acá.
          ignoreDeprecations: '6.0',
        },
      });
      filtrar = require(path.join(REPO, helper)).soloConcedidos;
    } catch (e) {
      declarar(`no se pudo cargar el .ts real (${e.message.split('\n')[0]}): la prueba negativa del filtro queda sin sujeto`);
    }
    if (typeof filtrar !== 'function') {
      declarar('`soloConcedidos` no se pudo ejecutar: los bloques [2] y [3] no comprueban el filtro real');
      filtrar = (m) => Object.fromEntries(Object.entries(m || {}).filter(([, v]) => v === true));
    } else {
      const muestra = { A: true, B: false, C: true, D: undefined, E: null };
      const r = filtrar(muestra);
      check(Object.keys(r).length === 2 && r.A === true && r.C === true,
        `de {A:true,B:false,C:true,D:undefined,E:null} sobreviven sólo A y C (quedaron: ${Object.keys(r).join(',') || 'ninguna'})`);
      check(Object.keys(filtrar(null)).length === 0, 'un mapa nulo devuelve {} y no revienta el login');
      // Y la que de verdad muerde: que NO sea la identidad. Un filtro que
      // devuelve lo mismo que recibe pasaría las dos de arriba si el mapa
      // viniera sin `false`, y no habría ahorrado un solo byte.
      check(Object.keys(filtrar({ X: false, Y: false })).length === 0,
        'un mapa TODO en false colapsa a {} — el filtro no es la identidad');
    }

    console.log('\n[3] El header de cada rol vivo, medido contra prod');
    const { rows } = await k.raw(
      `SELECT rp.role_name, rp.permissions,
              (SELECT count(*)::int FROM identity.users u
                WHERE u.tenant_id = rp.tenant_id AND u.role_name = rp.role_name
                  AND u.activo AND u.deleted_at IS NULL) AS usuarios
         FROM identity.role_permissions rp
        WHERE rp.tenant_id = ? AND rp.deleted_at IS NULL
        ORDER BY 3 DESC, 1`,
      [TENANT],
    );
    const vivos = rows.filter((r2) => r2.usuarios > 0);
    if (!vivos.length) {
      declarar('ningún rol tiene usuarios activos: no hay header que medir');
    } else {
      const base = {
        sub: '00000000-0000-0000-0000-000000000000', tenant_id: TENANT,
        username: 'usuario_de_ejemplo', role_name: 'x',
        zona_id: '00000000-0000-0000-0000-000000000000', zona: 'LA PIEDAD RD',
        warehouse_code: '02', iat: 1757000000, exp: 1757043200,
      };
      let peorAntes = { n: 0 }, peorDespues = { n: 0 }, masFlaco = { concedidos: Infinity };
      for (const r2 of vivos) {
        const concedidos = Object.keys(filtrar(r2.permissions)).length;
        const antes = b64({ ...base, role_name: r2.role_name, permissions: r2.permissions || {} }) + FIJO;
        const despues = b64({ ...base, role_name: r2.role_name, permissions: filtrar(r2.permissions) }) + FIJO;
        if (antes > peorAntes.n) peorAntes = { n: antes, rol: r2.role_name, gente: r2.usuarios };
        if (despues > peorDespues.n) peorDespues = { n: despues, rol: r2.role_name, gente: r2.usuarios };
        if (concedidos < masFlaco.concedidos) masFlaco = { concedidos, n: despues, antes, rol: r2.role_name, gente: r2.usuarios };
      }
      console.log(`      peor ANTES:   ${peorAntes.rol} ${peorAntes.n} B (${peorAntes.gente} persona/s)`);
      console.log(`      peor DESPUÉS: ${peorDespues.rol} ${peorDespues.n} B (${peorDespues.gente} persona/s)`);
      check(peorDespues.n < LIMITE_NGINX,
        `el peor header entra en el default de nginx (${peorDespues.n} < ${LIMITE_NGINX} B)`);

      // ⚠️ El invariante que el filtro SÍ garantiza, y es el que hay que
      // afirmar: **el header pesa en proporción a lo que la persona puede
      // hacer, no una constante**. Antes el rol más flaco del padrón cargaba
      // casi lo mismo que el más gordo, que es el absurdo que esto corrige.
      check(masFlaco.n < 1500,
        `el rol más flaco (${masFlaco.rol}, ${masFlaco.concedidos} permiso/s, ${masFlaco.gente} persona/s) ` +
          `pesa ${masFlaco.n} B y no ${masFlaco.antes} — el header es proporcional al acceso`);

      // ⚠️ Y lo que el filtro NO arregla, DECLARADO en vez de dibujado verde:
      // el techo lo pone `superadmin`, que concede 166 de 175 claves y por lo
      // tanto no se comprime. Sólo sacar el mapa del token baja ese techo.
      const margenAntes = Math.round((1 - peorAntes.n / LIMITE_NGINX) * 100);
      const margenDespues = Math.round((1 - peorDespues.n / LIMITE_NGINX) * 100);
      console.log(`      margen contra el límite: ${margenAntes}% antes → ${margenDespues}% después`);
      if (margenDespues < 40) {
        declarar(
          `el techo sigue alto: ${peorDespues.rol} (${peorDespues.gente} persona/s) deja sólo ${margenDespues}% de margen. ` +
            'Es un rol que concede casi todo, así que el filtro no lo comprime — ' +
            'bajar ese techo exige sacar el mapa del token (2ª mitad de la etapa), no filtrarlo.',
        );
      } else {
        check(true, `queda margen real contra el límite (${margenDespues}%)`);
      }
    }

    console.log('\n[4] El parche de nginx sigue puesto — y por qué todavía');
    // No se retira acá. Un token viejo (12 h de vida, y hasta 3,650 días en las
    // cuentas de kiosco) sigue cargando el mapa completo hasta que caduque, así
    // que sacar el buffer hoy le daría 400 en todo `/api` a quien no se
    // re-loguee. Se declara la condición para retirarlo, no se adivina.
    const confs = [];
    const buscar = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) { if (!['node_modules', 'dist', '.angular', '.git'].includes(e.name)) buscar(f); continue; }
        if (/nginx.*\.conf$/.test(e.name)) confs.push(f);
      }
    };
    buscar(REPO);
    const conParche = confs.filter((f) => /large_client_header_buffers/.test(fs.readFileSync(f, 'utf8')));
    console.log(`      ${conParche.length} de ${confs.length} nginx.conf con el parche`);
    check(conParche.length > 0,
      `el parche sigue puesto: retirarlo exige que caduque el último token viejo (TTL hasta 3,650 días en kioscos)`);

    console.log(`\n${fail === 0 ? '✅' : '❌'} [ID.29] tamaño del JWT: ${ok} ok, ${fail} fallos, ${nomedido} no medido(s)`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error(`\n❌ ERROR: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await k.destroy();
  }
})();
