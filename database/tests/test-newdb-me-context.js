/* eslint-disable no-console */
/**
 * `[SN.2]` `[SN.7]` — Smoke de los dos endpoints "de lo mío" de la landing:
 * `GET /users/me/context` (quién sos) y `GET /users/me/work` (qué te toca hacer).
 *
 * Cuatro bloques, porque fallan por motivos distintos:
 *   1. Los endpoints contestan con la FORMA de su contrato. En `me/context`,
 *      `position`/`department` son objeto `{code,name}` **o `null` declarado** — nunca ausentes,
 *      nunca un string sacado del rol. En `me/work`, `no_medido` siempre viene (aunque vacío) y
 *      ningún pendiente llega en 0 (una bandeja vacía no se manda: no se pintan cajas en cero).
 *   2. Sin token → 401 (son self-scoped, no públicos).
 *   3. Gate ESTÁTICO sobre el controller: los dos están declarados ANTES de `@Get(':id')` y sin
 *      `@RequirePermissions`. Si alguien los mueve debajo de `:id`, la ruta genérica se los traga
 *      (misma trampa documentada en `me/scope`) y este bloque se pone rojo aunque la API esté viva.
 *   4. Gate ESTÁTICO de las bandejas: cada una lleva a una ruta cuyo guard ACEPTA su permiso. El
 *      defecto que evita ya se cobró tres veces en la landing (`landing-guards.spec.ts`): un
 *      número que invita a hacer clic y aterriza en un 403. Acá sería peor — el conteo diría
 *      "99 por aprobar" y la puerta rebotaría.
 *
 * Los dos gates estáticos trabajan por LÍNEAS, no con un ancla `^\s*` en un regex sobre todo el
 * archivo: `\s` se traga los saltos de línea, el ancla cae en cualquier renglón en blanco de más
 * arriba y el cuerpo de la ruta sale vacío — la primera corrida dio los 8 guards en `[]` por eso.
 * Y el decorador se busca como decorador: la palabra `@RequirePermissions` también aparece en los
 * comentarios de estos handlers, y la primera versión la acusaba como si fuera código.
 *
 * Requiere API en :3334. Si no está, se declara NO MEDIDO (exit 2), no verde.
 * Correr: node database/tests/test-newdb-me-context.js
 */

const fs = require('fs');
const path = require('path');
const { noMedido } = require('./_lib/no-medido');

const BASE = process.env.API_BASE || 'http://localhost:3334/api';
let pass = 0;
let fail = 0;
let sinMedir = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); fail++; }
};
/*
 * `[SN.15]` El tercer estado, para el caso concreto de que el PROCESO vivo sea anterior al código
 * que estamos probando: un campo nuevo que llega `undefined` no es una regresión, es una API sin
 * reiniciar. Marcarlo FAIL deja un rojo permanente que enseña a ignorar el tablero; marcarlo OK
 * sería verde sin medir. Se declara (ADR-056 / `_lib/no-medido.js`), y el proceso sale con 2.
 */
const declarar = (name, motivo) => {
  console.log(`  ⓘ NO MEDIDO ${name} — ${motivo}`);
  sinMedir++;
};

async function req(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, body: json };
}

/** ¿Alguna línea de este tramo es el DECORADOR (no la palabra suelta en un comentario)? */
const tieneDecoradorPermisos = (tramo) =>
  tramo.split('\n').some((l) => l.trim().startsWith('@RequirePermissions('));

(async () => {
  // ── 3. Gate estático del controller (no necesita API; va primero para que un fallo de entorno
  //      no lo esconda) ────────────────────────────────────────────────────────────────────────
  console.log('── 3. Orden de rutas en el controller ──');
  const ctrl = fs.readFileSync(
    path.resolve(__dirname, '../../libs/trade/src/lib/users/users.controller.ts'),
    'utf8',
  );
  const iId = ctrl.indexOf("@Get(':id')");
  check("@Get(':id') existe (si no, el gate no mide nada)", iId >= 0);

  for (const [ruta, metodo] of [['me/context', 'myContext'], ['me/work', 'myWork']]) {
    const i = ctrl.indexOf(`@Get('${ruta}')`);
    check(`${ruta} está declarado`, i >= 0);
    if (i < 0) continue;
    check(`${ruta} va ANTES de @Get(':id')`, iId >= 0 && i < iId, { i, iId });
    // El tramo es SÓLO este handler: desde su @Get hasta el siguiente @Get. Un recorte fijo de N
    // caracteres alcanzaba al método vecino (`:id/scope`, que sí exige USUARIOS_VER) y acusaba en
    // falso — la primera corrida de este test lo demostró.
    const sig = ctrl.indexOf('@Get(', i + 1);
    const tramo = ctrl.slice(i, sig > 0 ? sig : i + 400);
    check(`el handler de ${ruta} contiene un método (el tramo no está vacío)`, tramo.includes(`${metodo}(`));
    check(`${ruta} NO exige @RequirePermissions (self-scoped)`, !tieneDecoradorPermisos(tramo));
  }

  // ── 4. Cada bandeja lleva a una ruta que ACEPTA su permiso ───────────────────────────────────
  console.log('\n── 4. Bandejas de me/work vs los guards de sus rutas ──');
  const src = fs.readFileSync(path.resolve(__dirname, '../../libs/trade/src/lib/users/me-work.ts'), 'utf8');
  const rutas = fs
    .readFileSync(path.resolve(__dirname, '../../apps/view/src/app/app.routes.ts'), 'utf8')
    .split('\n');

  // Bandejas declaradas: id + ruta + claves del anyOf, en el orden del archivo.
  const bandejas = [...src.matchAll(/id: '([^']+)',[\s\S]*?ruta: '([^']+)',[\s\S]*?anyOf: \[([^\]]*)\]/g)].map((m) => ({
    id: m[1],
    ruta: m[2],
    anyOf: [...m[3].matchAll(/Permission\.([A-Z0-9_]+)/g)].map((x) => x[1]),
  }));
  check('se leyeron las bandejas del registro (si no, este bloque no mide nada)', bandejas.length >= 6, bandejas.length);

  /** Las rutas de primer nivel del árbol llevan exactamente 4 espacios de indentación. */
  const esProyecto = (i) => /^ {4}path: '/.test(rutas[i]);
  const esLineaDePath = (i) => /^\s*path: '[^']*',$/.test(rutas[i]);

  /**
   * Guard de una ruta hija, buscado DENTRO del bloque de su proyecto — si se buscara en todo el
   * archivo, `compras/hallazgos` quedaría satisfecho por el bloque de `finanzas/hallazgos`, que
   * pide otra clave.
   */
  const guardDe = (ruta) => {
    const [, proyecto, ...resto] = ruta.split('/');
    const objetivoHija = `path: '${resto.join('/')}',`;

    let ini = -1;
    for (let i = 0; i < rutas.length; i++) {
      if (esProyecto(i) && rutas[i].trim() === `path: '${proyecto}',`) { ini = i; break; }
    }
    if (ini < 0) return { encontrada: false };
    let fin = rutas.length;
    for (let i = ini + 1; i < rutas.length; i++) if (esProyecto(i)) { fin = i; break; }

    /*
     * `[SN.15]` El árbol usa DOS estilos y hay que aceptar los dos. La mayoría declara la hija en
     * varias líneas (`path: 'hallazgos',` sola), pero el bloque `dashboard` la declara entera en
     * una: `{ path: 'supervisor-ai', loadComponent: …, canActivate: [...] },`. Comparando sólo con
     * `===` el candado decía «la ruta no existe en app.routes.ts» sobre una ruta que existe y que
     * sí tiene guard — un falso negativo que además impedía verificar su permiso, que es para lo
     * único que este bloque sirve.
     */
    let iHija = -1;
    let enUnaLinea = false;
    for (let i = ini + 1; i < fin; i++) {
      const t = rutas[i].trim();
      if (t === objetivoHija) { iHija = i; break; }
      if (t.startsWith(`{ ${objetivoHija}`)) { iHija = i; enUnaLinea = true; break; }
    }
    if (iHija < 0) return { encontrada: false };

    // Cuerpo de la ruta: la propia línea si es de una sola; si no, hasta la próxima `path: '...',`.
    let finHija = fin;
    for (let i = iHija + 1; i < fin; i++) if (esLineaDePath(i)) { finHija = i; break; }
    const cuerpo = enUnaLinea ? rutas[iHija] : rutas.slice(iHija, finHija).join('\n');
    return { encontrada: true, perms: [...cuerpo.matchAll(/Permission\.([A-Z0-9_]+)/g)].map((x) => x[1]) };
  };

  for (const b of bandejas) {
    const g = guardDe(b.ruta);
    check(`${b.id}: la ruta ${b.ruta} existe en app.routes.ts`, g.encontrada);
    if (!g.encontrada) continue;
    check(`${b.id}: la ruta ${b.ruta} declara algún permiso (si no, el gate no mide nada)`, g.perms.length > 0, g.perms);
    const acepta = g.perms.some((p) => b.anyOf.includes(p));
    check(`${b.id}: el guard de ${b.ruta} acepta alguna clave de su anyOf`, acepta, {
      guard: g.perms, bandeja: b.anyOf,
    });
  }

  /*
   * ── 4b. `[SN.15]` Las FUENTES DE TAREA, con el mismo candado que las bandejas ────────────────
   * Una tarea asignada puede llevar a una ruta que su dueño no abre — eso es un hallazgo y la
   * pantalla lo muestra sin enlace. Pero el registro NO puede apuntar a una ruta inexistente o sin
   * guard: eso sería un bug nuestro, no un desajuste de reparto.
   */
  console.log('\n── 4b. Fuentes de tarea de me/work vs los guards de sus rutas ──');
  const srcT = fs.readFileSync(path.resolve(__dirname, '../../libs/trade/src/lib/users/me-tasks.ts'), 'utf8');
  const fuentes = [...srcT.matchAll(/fuente: '([^']+)',[\s\S]*?ruta: '([^']+)',[\s\S]*?anyOf: \[([^\]]*)\]/g)].map((m) => ({
    fuente: m[1],
    ruta: m[2],
    anyOf: [...m[3].matchAll(/Permission\.([A-Z0-9_]+)/g)].map((x) => x[1]),
  }));
  check('se leyeron las 4 fuentes de tarea (si no, este bloque no mide nada)', fuentes.length === 4, fuentes.length);
  for (const f of fuentes) {
    const g = guardDe(f.ruta);
    check(`${f.fuente}: la ruta ${f.ruta} existe en app.routes.ts`, g.encontrada);
    if (!g.encontrada) continue;
    check(`${f.fuente}: la ruta ${f.ruta} declara algún permiso`, g.perms.length > 0, g.perms);
    check(`${f.fuente}: el guard de ${f.ruta} acepta alguna clave de su anyOf`,
      g.perms.some((p) => f.anyOf.includes(p)), { guard: g.perms, fuente: f.anyOf });
  }

  /*
   * ── 4c. `[SN.15]` Un solo vocabulario para las ocho colas ────────────────────────────────────
   * `me-work.ts` las llamaba `cuadre` y `identity.responsibilities` `almacen.cuadre`, sin ningún
   * mapeo en código. El día que `[OR.3]` enrute trabajo por responsabilidad, no iba a poder cruzar
   * contra la bandeja que la muestra. El candado exige BIYECCIÓN: ni una clave del catálogo sin
   * cola, ni una cola con una clave que el catálogo no declara.
   */
  /*
   * ── 4d. `[SN.16]` Los CICLOS, con el mismo candado ───────────────────────────────────────────
   * Una celda de la tira es un enlace con el mes ya puesto. Si la ruta no existe o su guard no
   * acepta el permiso del ciclo, el clic aterriza en un 403 — el defecto que este bloque vigila
   * para bandejas y tareas desde SN.7.
   */
  console.log('\n── 4d. Ciclos por periodo vs los guards de sus rutas ──');
  const srcC = fs.readFileSync(path.resolve(__dirname, '../../libs/trade/src/lib/users/me-cycles.ts'), 'utf8');
  const ciclos = [...srcC.matchAll(/id: '([^']+)',[\s\S]*?ruta: '([^']+)',[\s\S]*?anyOf: \[([^\]]*)\]/g)].map((m) => ({
    id: m[1],
    ruta: m[2],
    anyOf: [...m[3].matchAll(/Permission\.([A-Z0-9_]+)/g)].map((x) => x[1]),
  }));
  check('se leyeron los ciclos del registro (si no, este bloque no mide nada)', ciclos.length >= 2, ciclos.length);
  for (const cy of ciclos) {
    const g = guardDe(cy.ruta);
    check(`${cy.id}: la ruta ${cy.ruta} existe en app.routes.ts`, g.encontrada);
    if (!g.encontrada) continue;
    check(`${cy.id}: la ruta ${cy.ruta} declara algún permiso`, g.perms.length > 0, g.perms);
    check(`${cy.id}: el guard de ${cy.ruta} acepta alguna clave de su anyOf`,
      g.perms.some((p) => cy.anyOf.includes(p)), { guard: g.perms, ciclo: cy.anyOf });
  }

  console.log('\n── 4c. Biyección bandeja/tarea ↔ identity.responsibilities ──');
  /*
   * El catálogo NO vive en una sola migración: `[OR.1b]` sembró las 8 primeras y `[SN.17]` agregó
   * las 2 de conciliación. Leer sólo la primera hacía que este bloque acusara en falso a las
   * claves nuevas — pasó al agregarlas. Se juntan las claves de toda migración que inserte en
   * `identity.responsibilities`.
   */
  const dirMig = path.resolve(__dirname, '../migrations-newdb');
  const catalogo = [];
  for (const f of fs.readdirSync(dirMig).filter((x) => x.endsWith('.js'))) {
    const txt = fs.readFileSync(path.join(dirMig, f), 'utf8');
    if (!txt.includes('identity.responsibilities')) continue;
    // Sólo el array de definición: `['clave', 'Etiqueta', …]` al inicio de la fila.
    // `\s*` tras el corchete: hay arrays en una línea (`['x', 'Y', …]`) y otros multilínea.
    for (const m of txt.matchAll(/\[\s*'([a-z]+\.[a-z_]+)',\s*'/g)) {
      if (!catalogo.includes(m[1])) catalogo.push(m[1]);
    }
  }
  check('se leyó el catálogo de las migraciones (si no, este bloque no mide nada)',
    catalogo.length === 10, catalogo);

  /*
   * `[SN.17]` Las colas viven en TRES registros y las tres cuentan: bandejas, tareas y ciclos.
   * Cuando se agregó el ciclo de conciliación el catálogo pasó a 10 claves y este bloque habría
   * acusado 2 "sin cola" si sólo mirara los dos primeros archivos.
   */
  const declaradas = [
    ...[...src.matchAll(/responsabilidad: '([^']+)'/g)].map((m) => m[1]),
    ...[...srcT.matchAll(/responsabilidad: '([^']+)'/g)].map((m) => m[1]),
    ...[...srcC.matchAll(/responsabilidad: '([^']+)'/g)].map((m) => m[1]),
  ];
  check('cada cola declara su responsabilidad (7 bandejas + 1 tarea + 4 ciclos)',
    declaradas.length === 12, declaradas);
  const sinCatalogo = declaradas.filter((k) => !catalogo.includes(k));
  const sinCola = catalogo.filter((k) => !declaradas.includes(k));
  check('ninguna cola usa una clave que el catálogo no declara', sinCatalogo.length === 0, sinCatalogo);
  check('ninguna clave del catálogo se quedó sin cola', sinCola.length === 0, sinCola);
  /*
   * ⚠️ La unicidad ya NO se exige, y no es un relajamiento: **una responsabilidad puede cubrir
   * varias colas**. Quien responde de la conciliación de ingresos responde de las dos fuentes
   * —bancos y caja—, así que `finanzas.conciliacion_ingresos` aparece dos veces a propósito.
   * Lo que sí tiene que cerrar es el CONJUNTO: ninguna clave inventada, ninguna clave huérfana.
   */
  check('el conjunto de claves usadas coincide con el catálogo',
    new Set(declaradas).size === catalogo.length, {
      usadas: [...new Set(declaradas)].length, catalogo: catalogo.length,
    });

  /*
   * ── 4e. `[SN.21]` La regla de delegación no puede vaciar la pantalla ─────────────────────────
   *
   * `workFor` recorta «Mi trabajo» a lo que responde el reparto de cada persona. La versión
   * ingenua de esa regla —«tenés alguna responsabilidad ⇒ filtrá»— **se midió contra prod antes de
   * escribirla y dejaba a 6 personas sin nada**: su única delegación es `finanzas.hallazgos`, y esa
   * bandeja está RETIRADA desde `[SN.18]`. Filtrar por una delegación que no puede mostrar nada es
   * esconderlo todo a cambio de cero.
   *
   * Lo que hace segura a la regla son tres propiedades del CÓDIGO, y este bloque las vigila. No
   * miden el dato (para eso está `database/scripts/sn-delegacion-impacto.js`, que corre contra
   * prod): miden que nadie las quite al simplificar, que es como volverían a romperse.
   */
  console.log('\n── 4e. La regla de delegación se calcula sobre lo VISIBLE ──');
  const srcSvc = fs.readFileSync(
    path.resolve(__dirname, '../../libs/trade/src/lib/users/users.service.ts'),
    'utf8',
  );
  const mFiltrables = /const bandejasFiltrables = BANDEJAS\.filter\(([\s\S]*?)\n {4}\);/.exec(srcSvc);
  check('existe el conjunto de bandejas filtrables (si no, el resto de este bloque no mide nada)',
    !!mFiltrables);
  if (mFiltrables) {
    const cuerpo = mFiltrables[1];
    check('la bandeja RETIRADA no cuenta para encender el filtro (el caso que vaciaba 6 pantallas)',
      /!b\.retirada/.test(cuerpo), cuerpo.trim());
    check('tu BORRADOR (alcance mio) no cuenta ni se filtra: nadie te lo delegó, lo empezaste vos',
      /b\.alcance !== 'mio'/.test(cuerpo), cuerpo.trim());
    check('sólo cuenta lo que tu permiso ABRE (si no, filtraría por algo que igual no ves)',
      /puedeVerBandeja\(b, permisos, esAdmin\)/.test(cuerpo), cuerpo.trim());
  }
  const mActiva = /const delegacionActiva =([\s\S]*?);\n/.exec(srcSvc);
  check('existe la condición que enciende el filtro', !!mActiva);
  if (mActiva) {
    const cond = mActiva[1];
    /*
     * ⛔ La prueba NEGATIVA de este bloque: la condición NO puede ser `misResponsabilidades.size`.
     * Ésa es exactamente la versión que se midió y se descartó, y es la que alguien volvería a
     * escribir por ser la obvia. Se rompió a propósito una vez (cambiando la condición por
     * `misResponsabilidades.size > 0`) y estas dos aserciones se pusieron rojas.
     */
    check('la condición se calcula sobre lo que la persona VE, no sobre cuántas claves tiene',
      /bandejasFiltrables\.some/.test(cond) && /ciclosVisibles\.some/.test(cond), cond.trim());
    check('la condición NO es "tiene alguna responsabilidad" (la versión que vaciaba pantallas)',
      !/misResponsabilidades[?.]*\.size/.test(cond), cond.trim());
  }
  check('lo que el filtro esconde se DECLARA en la respuesta (ocultas), no desaparece en silencio',
    /ocultasPorDelegacion\+\+/.test(srcSvc) && /ocultas: ocultasPorDelegacion/.test(srcSvc));

  /*
   * ── 4f. `[SN.22]` Ninguna medición puede envenenar a las demás ───────────────────────────────
   *
   * `KNEX_CONNECTION` es un proxy que enruta al trx de la request, y en Postgres una sentencia
   * fallida ABORTA la transacción: todo lo que siga responde `25P02`. **De eso no se sale con un
   * `try/catch`.** Por eso cada `catch` de `workFor` mentía: declaraba «esta bandeja no respondió»
   * como si las demás siguieran siendo confiables.
   *
   * Medido en vivo el 2026-09-12 contra `platform_test` (que no tiene las tablas de `[OR.1b]`):
   * un `42P01` real dejó las NUEVE mediciones de Mayra en «Sin medir», ocho de ellas por arrastre.
   * Con savepoint, la misma cascada da 1 falla aislada y 3 conteos correctos — reproducido.
   *
   * Este bloque vigila que el aislamiento siga puesto en los cinco lugares que lo necesitan.
   */
  console.log('\n── 4f. Cada medición de me/work corre aislada (savepoint) ──');
  check('el helper `aislado` usa un SAVEPOINT sobre el trx de la request, no una conexión nueva',
    /private aislado<T>/.test(srcSvc) && /store\.tx\.transaction\(\(sp\) =>/.test(srcSvc) &&
      /legacyTxStorage\.run\(\{ tx: sp/.test(srcSvc));
  check('sin trx de request el helper NO abre nada (los scripts y los tests no pagan el savepoint)',
    /if \(!store\?\.tx\) return fn\(\);/.test(srcSvc));

  /*
   * ⛔ La prueba NEGATIVA: se quitó `this.aislado(...)` de la bandeja y este bloque se puso rojo.
   * Es la forma en que volvería a romperse — alguien «simplificando» el envoltorio.
   */
  const envueltos = [
    ['la bandeja', /await this\.aislado\(\(\) => b\.medir\(this\.knex, ctx\)\)/],
    ['la tarea', /await this\.aislado\(\(\) => f\.medir\(this\.knex, this\.tenantId, userId\)\)/],
    ['el ciclo', /await this\.aislado\(\(\) => c\.medir\(this\.knex, ctx\)\)/],
    ['el alcance por sucursal', /await this\.aislado\(\(\) => this\.scopeService!\.forUser\(/],
    ['las responsabilidades', /await this\.aislado\(async \(\) => \(\{/],
  ];
  for (const [que, re] of envueltos) {
    check(`${que} se mide DENTRO de un savepoint`, re.test(srcSvc));
  }
  /*
   * Y el `catch` va por FUERA: si se atrapa adentro, el error no escapa, el savepoint se libera
   * como si todo hubiera ido bien y el aislamiento queda de adorno.
   */
  check('el catch de las responsabilidades NO está dentro del savepoint',
    srcSvc.indexOf('try {\n      /*\n       * `[SN.22]`') < srcSvc.indexOf('await this.aislado(async () => ({'));

  // ── 1 y 2. En vivo ────────────────────────────────────────────────────────────────────────────
  console.log('\n── 1. Login ──');
  let login;
  try {
    login = await req('POST', '/auth-mt/login', {
      tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot',
    });
  } catch (e) {
    noMedido(`la API en ${BASE} no contesta — ${e.message}`);
  }
  const token = login.body?.access_token;
  check('JWT recibido', !!token, login.status);
  // Mismo motivo que el cierre de abajo: `process.exit()` acá salía con 127 en Windows.
  if (!token) { console.log(`\n${pass} OK · ${fail} FAIL`); process.exitCode = fail ? 1 : 0; return; }

  console.log('\n── 2. GET /users/me/context ──');
  const me = await req('GET', '/users/me/context', null, token);
  check('200', me.status === 200, { status: me.status, body: me.body });
  const b = me.body || {};
  check('user_id + username presentes', typeof b.user_id === 'string' && typeof b.username === 'string');
  check('username es el del login', b.username === 'superoot', b.username);
  check('role_name presente', typeof b.role_name === 'string' && b.role_name.length > 0, b.role_name);
  const esRefONull = (v) => v === null || (v && typeof v.code === 'string' && typeof v.name === 'string');
  check('position es {code,name} o null DECLARADO (nunca ausente)', 'position' in b && esRefONull(b.position), b.position);
  check('department es {code,name} o null DECLARADO', 'department' in b && esRefONull(b.department), b.department);
  check('nombre es string o null (nunca undefined)', 'nombre' in b && (b.nombre === null || typeof b.nombre === 'string'));
  check('zona y warehouse_code declarados (string o null)',
    'zona' in b && 'warehouse_code' in b && (b.zona === null || typeof b.zona === 'string') && (b.warehouse_code === null || typeof b.warehouse_code === 'string'));
  // El puesto NO se deriva del rol: si viene, tiene que ser un código del catálogo, no el role_name.
  if (b.position) check('position.code no es el role_name disfrazado', b.position.code !== b.role_name, b.position);

  console.log('\n── 2b. Sin token ──');
  const anon = await req('GET', '/users/me/context', null, null);
  check('401 sin token', anon.status === 401, anon.status);

  console.log('\n── 5. GET /users/me/work ──');
  const w = await req('GET', '/users/me/work', null, token);
  check('200', w.status === 200, { status: w.status, body: w.body });
  const wb = w.body || {};
  check('pendientes es arreglo', Array.isArray(wb.pendientes));
  check('no_medido es arreglo DECLARADO (nunca ausente)', Array.isArray(wb.no_medido));

  /*
   * `[SN.22]` — **Una falla por ARRASTRE no es una medición fallida: es la pantalla entera rota.**
   *
   * `KNEX_CONNECTION` enruta al trx de la request; en Postgres una sentencia fallida aborta la
   * transacción y todo lo que sigue responde `25P02`. Sin este bloque el smoke se ponía VERDE con
   * la respuesta vacía —menos aserciones, ninguna roja— que es el «verde sin medir» que ADR-056
   * prohíbe: medido el 2026-09-12, la cuenta cayó de 125 a 104 checks y nadie se enteró.
   *
   * Se imprime el motivo de cada una: sin eso, nueve fallas se leen como nueve problemas
   * independientes cuando en realidad hay UNO real y ocho de arrastre.
   */
  for (const nm of wb.no_medido ?? []) console.log(`  ⓘ no_medido: ${nm.id} — ${nm.motivo}`);
  const arrastre = (wb.no_medido ?? []).filter((nm) => /25P02|abortad|aborted/i.test(nm.motivo ?? ''));
  check(
    'ninguna medición falló por ARRASTRE de otra (25P02 = la trx de la request quedó abortada)',
    arrastre.length === 0,
    arrastre.length
      ? {
          arrastradas: arrastre.map((a) => a.id),
          remedio: 'el aislamiento por savepoint de [SN.22] no está en el proceso vivo — reiniciar la API',
        }
      : undefined,
  );

  check('medido_at es ISO (el número es de ahora, no de un rollup)',
    typeof wb.medido_at === 'string' && !Number.isNaN(Date.parse(wb.medido_at)));
  /*
   * `[SN.18]` Las bandejas RETIRADAS no deben llegar nunca a la respuesta. Se apagan en el
   * registro con un motivo (no se borran), así que el candado las lee de ahí: si alguien quita la
   * línea `retirada` sin querer, el conteo vuelve a aparecer y esto lo caza.
   */
  /*
   * ⚠️ NO con `/id: '(…)'[\s\S]*?retirada:/`: ese `[\s\S]*?` cruza el límite entre objetos y toma
   * el id de la PRIMERA bandeja del array, no el de la retirada — la primera versión de este
   * bloque acusó a `caducidades-mias` estando retirada `finanzas-hallazgos`. Se busca cada
   * `retirada:` y se retrocede al `id:` más cercano, que sí está en el mismo objeto.
   */
  const retiradas = [];
  for (const m of src.matchAll(/^\s*retirada:/gm)) {
    const ids = [...src.slice(0, m.index).matchAll(/id: '([^']+)'/g)];
    if (ids.length) retiradas.push(ids[ids.length - 1][1]);
  }
  check('se leyeron las bandejas retiradas del registro', retiradas.length >= 1, retiradas);
  // Misma señal que el bloque 5c: sin `ciclos` el proceso vivo es anterior a este código, así que
  // una bandeja retirada que todavía aparece NO es una regresión — es una API sin reiniciar.
  const apiAnterior = wb.ciclos === undefined;
  for (const id of retiradas) {
    if (apiAnterior) {
      declarar(`bandeja retirada ${id}`, 'la API viva es anterior al retiro');
      continue;
    }
    check(`la bandeja retirada ${id} NO viene en la respuesta`,
      !(wb.pendientes ?? []).some((p) => p.id === id), id);
    check(`la bandeja retirada ${id} tampoco va a no_medido (se apagó, no falló)`,
      !(wb.no_medido ?? []).some((n) => n.id === id), id);
  }

  const idsBandeja = new Set(bandejas.map((x) => x.id));
  for (const p of wb.pendientes ?? []) {
    check(`pendiente ${p.id}: sale del registro de bandejas`, idsBandeja.has(p.id), p.id);
    check(`pendiente ${p.id}: total > 0 (una bandeja en cero no se manda)`, typeof p.total === 'number' && p.total > 0, p);
    check(`pendiente ${p.id}: alcance declarado`, p.alcance === 'mio' || p.alcance === 'bandeja', p.alcance);
    check(`pendiente ${p.id}: ruta absoluta`, typeof p.ruta === 'string' && p.ruta.startsWith('/'), p.ruta);
    // `[SN.15]` El universo del conteo se DECLARA: un número sin universo se lee como "lo mío".
    if (p.ambito === undefined) declarar(`pendiente ${p.id}: ámbito`, 'la API viva es anterior a SN.15');
    else check(`pendiente ${p.id}: ámbito declarado`,
      ['red', 'sucursal', 'red_sin_ficha'].includes(p.ambito), p.ambito);
  }

  /*
   * `[SN.15]` Las tareas asignadas. Hasta hoy la pantalla afirmaba «Nadie te asignó trabajo hoy»
   * SIEMPRE, sobre una medición del 10-sep que decía que las tablas de asignación estaban en cero;
   * medido el 11-sep contra prod: 151 tareas vivas sobre 38 de 118 personas.
   */
  console.log('\n── 5b. Tareas asignadas (me/work.tareas) ──');
  if (wb.tareas === undefined) {
    declarar('bloque 5b completo', `la API en ${BASE} responde sin \`tareas\`: corre código anterior a SN.15, hay que reiniciarla`);
  } else {
    check('tareas es arreglo DECLARADO (nunca ausente)', Array.isArray(wb.tareas), typeof wb.tareas);
    check('tiene_responsabilidades es booleano o null DECLARADO',
      'tiene_responsabilidades' in wb &&
        (wb.tiene_responsabilidades === null || typeof wb.tiene_responsabilidades === 'boolean'),
      wb.tiene_responsabilidades);
  }

  /*
   * `[SN.21]` El recorte por reparto viaja DECLARADO. `null` es una respuesta legítima ("no se
   * pudieron leer las responsabilidades"), distinta de un objeto con `activa: false`.
   */
  if (wb.delegacion === undefined) {
    declarar('delegacion en me/work', `la API en ${BASE} responde sin \`delegacion\`: corre código anterior a SN.21, hay que reiniciarla`);
  } else if (wb.delegacion === null) {
    check('delegacion null = las responsabilidades no se pudieron leer, y se declara', true);
  } else {
    const d = wb.delegacion;
    check('delegacion trae activa/claves/ocultas con su tipo',
      typeof d.activa === 'boolean' && Array.isArray(d.claves) && typeof d.ocultas === 'number', d);
    /*
     * ⛔ El invariante que hace segura a la regla, medido en vivo: **si el filtro está encendido,
     * algo sobrevivió**. Si alguna vez `activa: true` llega con las tres listas vacías, la regla
     * dejó a esta persona sin pantalla — que es justo lo que la versión ingenua hacía con 6.
     */
    if (d.activa) {
      const quedaAlgo =
        (wb.tareas ?? []).length + (wb.pendientes ?? []).length + (wb.ciclos ?? []).length > 0;
      check('con el filtro ENCENDIDO queda al menos una cosa que mostrar', quedaAlgo, {
        tareas: (wb.tareas ?? []).length, pendientes: (wb.pendientes ?? []).length, ciclos: (wb.ciclos ?? []).length,
      });
    } else {
      check('con el filtro apagado no se esconde nada (ocultas = 0)', d.ocultas === 0, d.ocultas);
    }
  }
  const fuentesRegistradas = new Set(fuentes.map((f) => f.fuente));
  for (const t of wb.tareas ?? []) {
    check(`tarea ${t.fuente}: sale del registro de fuentes`, fuentesRegistradas.has(t.fuente), t.fuente);
    check(`tarea ${t.fuente}: total > 0 (una fuente en cero no se manda)`, typeof t.total === 'number' && t.total > 0, t.total);
    // La regla del caso sin permiso: o hay ruta, o hay motivo. Nunca las dos, nunca ninguna.
    const conRuta = typeof t.ruta === 'string' && t.ruta.startsWith('/');
    check(`tarea ${t.fuente}: o lleva ruta o DECLARA por qué no`,
      (conRuta && t.sin_acceso === null) || (t.ruta === null && typeof t.sin_acceso === 'string'),
      { ruta: t.ruta, sin_acceso: t.sin_acceso });
    // `vence_at: null` significa "esta fuente no maneja vencimiento", y entonces `vencidas` NO
    // puede ser 0: sería afirmar que ninguna venció sobre un dato que no existe (ADR-056).
    check(`tarea ${t.fuente}: vencidas es null si la fuente no maneja vencimiento`,
      t.vence_at === null ? t.vencidas === null : typeof t.vencidas === 'number',
      { vence_at: t.vence_at, vencidas: t.vencidas });
    check(`tarea ${t.fuente}: no_responde declarado`, Array.isArray(t.no_responde), t.no_responde);
  }

  console.log('\n── 5c. Ciclos por periodo (me/work.ciclos) ──');
  if (wb.ciclos === undefined) {
    declarar('bloque 5c completo', `la API en ${BASE} responde sin \`ciclos\`: corre código anterior a SN.16`);
  } else {
    check('ciclos es arreglo DECLARADO (nunca ausente)', Array.isArray(wb.ciclos), typeof wb.ciclos);
    const idsCiclo = new Set(ciclos.map((x) => x.id));
    const ESTADOS = ['sin_datos', 'sin_empezar', 'en_proceso', 'al_dia'];
    for (const cy of wb.ciclos ?? []) {
      check(`ciclo ${cy.id}: sale del registro`, idsCiclo.has(cy.id), cy.id);
      check(`ciclo ${cy.id}: trae los 12 periodos (un mes ausente se declara, no se omite)`,
        Array.isArray(cy.periodos) && cy.periodos.length === 12, cy.periodos?.length);
      for (const p of cy.periodos ?? []) {
        check(`ciclo ${cy.id} ${p.periodo}: estado declarado`, ESTADOS.includes(p.estado), p.estado);
        check(`ciclo ${cy.id} ${p.periodo}: formato YYYY-MM`, /^\d{4}-\d{2}$/.test(p.periodo), p.periodo);
        /*
         * ⭐ La regla que da sentido a la fase: un mes SIN DATOS no navega. Medido en prod,
         * 2026-06 y 2026-07 no tienen estado de cuenta; ofrecer un enlace ahí manda a la persona
         * a una pantalla que no le puede contestar nada, y contar ese mes como pendiente le
         * inventa trabajo que no puede hacer.
         */
        if (p.estado === 'sin_datos') {
          check(`ciclo ${cy.id} ${p.periodo}: sin_datos NO navega`,
            p.ruta === null && p.queryParams === null, { ruta: p.ruta, q: p.queryParams });
          check(`ciclo ${cy.id} ${p.periodo}: sin_datos no inventa un conteo`, p.faltan === null, p.faltan);
        } else {
          check(`ciclo ${cy.id} ${p.periodo}: navega con el mes puesto`,
            typeof p.ruta === 'string' && p.ruta.startsWith('/') &&
              p.queryParams && Object.values(p.queryParams).includes(p.periodo),
            { ruta: p.ruta, q: p.queryParams });
        }
      }
      const esperados = (cy.periodos ?? []).filter(
        (p) => p.estado === 'sin_empezar' || p.estado === 'en_proceso',
      ).length;
      check(`ciclo ${cy.id}: \`pendientes\` no cuenta los meses sin datos`, cy.pendientes === esperados,
        { dice: cy.pendientes, son: esperados });
    }

    /*
     * `[SN.20]` Si a esta persona se le delegó algo, la lista trae **sólo lo suyo**: no puede venir
     * un ciclo ajeno mezclado. Es la regla de «Mi trabajo» como lista de trabajo delegado — y no
     * afecta el acceso, que lo sigue dando el permiso sobre el módulo.
     */
    const algunoMio = (wb.ciclos ?? []).some((c) => c.es_mio === true);
    if (algunoMio) {
      const ajenos = (wb.ciclos ?? []).filter((c) => !c.es_mio).map((c) => c.id);
      check('con trabajo delegado, NO se cuelan ciclos ajenos en la lista', ajenos.length === 0, ajenos);
    } else if ((wb.ciclos ?? []).length) {
      // Sin reparto se ven todos: quedarse con la pantalla vacía sería peor que verlo de más.
      check('sin trabajo delegado, los ciclos visibles NO se esconden',
        (wb.ciclos ?? []).every((c) => c.es_mio === false), wb.ciclos?.map((c) => c.id));
    }
  }

  const anonW = await req('GET', '/users/me/work', null, null);
  check('401 sin token', anonW.status === 401, anonW.status);

  console.log(`\n${pass} OK · ${fail} FAIL${sinMedir ? ` · ${sinMedir} NO MEDIDO` : ''}`);
  /*
   * `[SN.15]` `process.exitCode` y NO `process.exit()`.
   *
   * Con `process.exit()` este script terminaba con **127** en Windows, no con su código: node
   * abortaba en `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c` al matar
   * el proceso con los sockets keep-alive de `fetch` todavía cerrándose. El resumen se imprimía
   * bien, así que a simple vista parecía que todo estaba en orden.
   *
   * Daba igual mientras los códigos fueran 0 y 1 —cualquier cosa ≠ 0 se leía como "falló"— pero
   * con el tercer estado deja de dar igual: 127 haría que un **NO MEDIDO** (2) se reporte como
   * regresión, que es justo la confusión que `_lib/no-medido.js` existe para eliminar.
   */
  process.exitCode = fail ? 1 : sinMedir ? 2 : 0;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
