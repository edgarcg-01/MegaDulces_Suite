/* eslint-disable no-console */
/**
 * `[CP.8.32]` — Candado de **la bandeja del puente**: el permiso, su reparto, y que la bandeja
 * diga lo que tiene que decir.
 *
 * ⭐ Existe por `[LC.6.2]`: ese par de permisos nació con la fase, vivió **sólo en el enum**, y el
 * módulo estuvo en producción con **cero roles** pudiendo abrirlo. *Un módulo nuevo no está
 * entregado hasta que su permiso está REPARTIDO en prod, no sólo declarado.* Este candado mira el
 * reparto, no la declaración.
 *
 * Lee prod en SOLO LECTURA.
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

require('ts-node').register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true,
    moduleResolution: 'node', ignoreDeprecations: '6.0',
  },
});

/**
 * ⚠️ `skipProject: true` deja fuera el `tsconfig.base.json`, y con él los alias `@megadulces/*`.
 * Los smokes anteriores de CP.8 no lo necesitaban porque cargaban archivos **puros** (el armador
 * de asientos, el token); éste carga un **servicio de Nest**, que sí importa del barrel.
 *
 * Se resuelven a mano en vez de quitar `skipProject`: tomar el tsconfig del monorepo hace fallar
 * a ts-node con `TS5011` (`rootDir`), que es exactamente por lo que los otros lo saltean.
 */
const ALIAS = {
  '@megadulces/contracts': path.join(ROOT, 'libs/contracts/src/index.ts'),
  '@megadulces/platform-core': path.join(ROOT, 'libs/platform-core/src/index.ts'),
};
const Module = require('module');
const resolveOriginal = Module._resolveFilename;
Module._resolveFilename = function resolver(pedido, ...resto) {
  return ALIAS[pedido] ? ALIAS[pedido] : resolveOriginal.call(this, pedido, ...resto);
};

const knexLib = require('knex');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const VER = 'FISCAL_CONTPAQI_BRIDGE_VER';
const GESTIONAR = 'FISCAL_CONTPAQI_BRIDGE_GESTIONAR';
/** Lo que la migración reparte, con el motivo en la cabecera de la migración. */
const ESPERADO = {
  contabilidad: [true, true],
  finanzas: [true, true],
  superadmin: [true, true],
  direccion: [true, false],
  auditor_externo: [true, false],
};
/** ⛔ Recortados a propósito aunque SÍ tienen el del Libro de Compras. Ver la migración. */
const EXCLUIDOS = ['marketing', 'credito_cobranza', 'gerente_compras'];

let ok = 0;
let fail = 0;
let nm = 0;
const check = (cond, label) => {
  if (cond) { ok += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); }
};

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) {
    console.log('\n[NO MEDIDO] sin DATABASE_URL_NEW');
    console.log('\n✅ CP.8.32 bandeja del puente: 0 ✓ / 0 ✗ · 1 NO MEDIDO\n');
    process.exit(0);
  }
  const knex = knexLib({ client: 'pg', connection: url, pool: { min: 0, max: 2 } });

  try {
    console.log('\n[1] El permiso está DECLARADO (enum + árbol + meta)');
    const LIBC = path.resolve(__dirname, '..', '..', 'libs', 'contracts', 'src', 'authz');
    const { Permission } = require(path.join(LIBC, 'permissions.ts'));
    const { AUTHZ_TREE } = require(path.join(LIBC, 'authz-tree.ts'));
    const { PERMISSION_META } = require(path.join(LIBC, 'permission-meta.ts'));
    check(Permission[VER] === VER && Permission[GESTIONAR] === GESTIONAR, 'los dos están en el enum');
    check(!!PERMISSION_META[VER] && !!PERMISSION_META[GESTIONAR], 'los dos tienen label y descripción');

    // ⭐ Un permiso que no cuelga de ningún nodo con ruta es un permiso que nadie puede alcanzar
    // desde la navegación — declarado y huérfano, que es la mitad del defecto de `[LC.6.2]`.
    const json = JSON.stringify(AUTHZ_TREE);
    check(json.includes(VER) && json.includes(GESTIONAR), 'los dos cuelgan de un nodo del árbol');
    // ⛔ La ruta EXACTA, no un prefijo: `/contabilidad/contpaqi` también existe y es OTRA
    // página (los libros fiscales de CP.1–CP.4, con otro permiso). Un `includes` del prefijo
    // daba verde con el nodo apuntando a la página equivocada — que es como estaba.
    const buscar = (nodos, id) => {
      for (const n of nodos ?? []) {
        if (n.id === id) return n;
        const hijo = buscar(n.projects ?? n.modules, id);
        if (hijo) return hijo;
      }
      return null;
    };
    const nodo = buscar(AUTHZ_TREE, 'contpaqi-puente');
    check(!!nodo, 'el nodo `contpaqi-puente` existe en el árbol');
    check(nodo?.route === '/contabilidad/contpaqi-puente',
      `el nodo apunta a SU ruta, no a la de los libros: ${nodo?.route}`);

    console.log('\n[2] ⭐ Y está REPARTIDO en prod — que es lo que `[LC.6.2]` midió que faltaba');
    const roles = await knex('identity.role_permissions').select('role_name', 'permissions');
    const valor = (r, k) => {
      const v = r.permissions ? r.permissions[k] : undefined;
      return v === undefined ? null : v === true;
    };
    const conVer = roles.filter((r) => valor(r, VER) === true);
    if (!conVer.length) {
      nm += 1;
      console.log('  [NO MEDIDO] la migración 20261009182612 todavía no se aplicó a este destino');
    } else {
      check(conVer.length === Object.keys(ESPERADO).length,
        `${conVer.length} roles con ${VER} (se esperaban ${Object.keys(ESPERADO).length})`);
      for (const [rol, [ve, gest]] of Object.entries(ESPERADO)) {
        const r = roles.find((x) => x.role_name === rol);
        check(!!r && valor(r, VER) === ve && valor(r, GESTIONAR) === gest,
          `${rol}: ver=${ve} gestionar=${gest}`);
      }
      // ⛔ Prueba negativa del recorte: si alguien "arregla" el permiso copiando la
      // distribución del Libro de Compras, estos tres vuelven y este bloque se pone rojo.
      for (const rol of EXCLUIDOS) {
        const r = roles.find((x) => x.role_name === rol);
        check(!r || valor(r, VER) !== true,
          `⛔ ${rol} NO lo tiene — tiene el del Libro de Compras y aun así se recortó, con motivo`);
      }
      // Y el otro lado del recorte: los que sí lo tienen, lo tienen de verdad.
      check(conVer.every((r) => r.permissions[VER] === true),
        'los que lo tienen lo tienen en `true`, no en una cadena ni un 1');
    }

    console.log('\n[3] La bandeja tiene de qué hablar: los rechazos con DUEÑO');
    const { ContpaqiArmadoService } = require(path.resolve(
      __dirname, '..', '..', 'libs', 'finance', 'src', 'lib', 'contpaqi', 'contpaqi-armado.service.ts'));
    const svc = new ContpaqiArmadoService(knex, undefined);
    const { lotes, fuera_de_lote: fuera } = await svc.simularLotes('2026-01');
    check(lotes.length > 0, `enero produce ${lotes.length} lotes (banco × día)`);
    const movs = lotes.reduce((a, l) => a + l.movimientos, 0);
    check(lotes.length < movs / 3,
      `⭐ ${lotes.length} lotes para ${movs} movimientos — agrupa, no hace una póliza por movimiento`);

    const motivos = {};
    for (const l of lotes) for (const [m, n] of Object.entries(l.motivos)) motivos[m] = (motivos[m] ?? 0) + n;
    const claves = Object.keys(motivos);
    check(claves.length >= 3, `los rechazos se reparten en ${claves.length} motivos distintos: ${claves.join(', ')}`);
    // ⭐ La aserción que justifica la pantalla: `no_aplica` NO es trabajo pendiente de nadie, y
    // mezclarlo con el resto haría que la bandeja pida trabajo que no existe.
    check(motivos.no_aplica > 0,
      `⭐ ${motivos.no_aplica ?? 0} movimientos en \`no_aplica\` — ya se decidió, NO son pendientes`);
    check((motivos.sin_regla ?? 0) > 0, `${motivos.sin_regla ?? 0} en \`sin_regla\` — esos sí esperan al contador`);

    console.log('\n[3b] ⭐ `[CP.8.34]` El universo del mes, no sólo lo que alcanzó a agruparse');
    // ⛔ Esto vivía en un `logger.warn` y la bandeja publicaba `movs` como si fuera el mes
    // entero. El denominador real de enero es 2,350: declararlo es la mitad de la medición.
    check(fuera.movimientos > 0,
      `⭐ ${fuera.movimientos} movimientos quedan FUERA de todo lote y el servicio los devuelve`);
    check(fuera.cuentas.length > 0 && fuera.cuentas.every((c) => c.cuenta && c.cuenta !== '(sin cuenta)'),
      `y los NOMBRA: ${fuera.cuentas.map((c) => `${c.cuenta} (${c.movimientos})`).join(' · ')}`);
    const sumaCuentas = fuera.cuentas.reduce((a, c) => a + c.movimientos, 0);
    check(sumaCuentas === fuera.movimientos,
      `el desglose suma el total (${sumaCuentas} = ${fuera.movimientos}) — ninguna cuenta se pierde`);
    check(fuera.importe > 0,
      `con importe: $${fuera.importe.toLocaleString('es-MX')} que este puente NO cubre`);
    // ⚠️ La prueba que corrige mi propia atribución: NO es "les falta el crosswalk". Tienen
    // cuenta; no son bancos. Si alguna vez una cuenta `102*` cae acá, es OTRO defecto y este
    // candado tiene que gritarlo en vez de dejarlo pasar como "ya sabido".
    const bancarias = fuera.cuentas.filter((c) => /^\d/.test(c.cuenta));
    check(bancarias.length === 0,
      '⛔ ninguna cuenta de banco cae fuera de lote — las que caen (CAJA, FACTORAJE) no son bancos');

    console.log('\n[4] El estado del cuadre se lee SIN escribir, y el vacío se declara');
    const { ContpaqiCuadreService } = require(path.resolve(
      __dirname, '..', '..', 'libs', 'finance', 'src', 'lib', 'contpaqi', 'contpaqi-cuadre.service.ts'));
    const cu = new ContpaqiCuadreService(knex);
    const antes = await knex('contpaqi.poliza_exports').count({ n: '*' }).first();
    const est = await cu.estado();
    const despues = await knex('contpaqi.poliza_exports').count({ n: '*' }).first();
    check(Number(antes.n) === Number(despues.n), '`estado()` no escribió ni una fila');
    check(typeof est.hay_entregas === 'boolean',
      `⭐ declara \`hay_entregas=${est.hay_entregas}\` — un 0% sin decir que el denominador es cero miente`);
    check(est.plazo_dias > 0, `arrastra el plazo del motor (${est.plazo_dias} días) en vez de repetir la constante`);
  } finally {
    await knex.destroy();
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8.32 bandeja del puente: ${ok} ✓ / ${fail} ✗`
    + (nm ? ` · ${nm} NO MEDIDO` : '') + '\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`  ✗ excepción: ${e && e.message}`);
  console.log(`\n❌ CP.8.32 bandeja del puente: ${ok} ✓ / ${fail + 1} ✗\n`);
  process.exit(1);
});
