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
    .split('\n')
    /*
     * ⛔ `[JZ.3]` **El `\r` invisible que dejó ciego a este candado.**
     *
     * `app.routes.ts` está en CRLF, y `esLineaDePath` ancla con `,$`: el `\r` queda entre la coma
     * y el fin de línea, así que el regex **no matcheó NUNCA** — medido, `0 de 198` líneas `path:`.
     * Consecuencia: el "cuerpo" de cada ruta se extendía hasta el fin del proyecto entero, y
     * `guardDe` devolvía la unión de decenas de permisos. Los bloques 4a/4b/4c llevaban meses
     * diciendo «el guard de X acepta la clave de la bandeja» sobre una lista donde estaba **casi
     * cualquier** clave del proyecto.
     *
     * Lo destapó la prueba negativa de 4i: se cambió a propósito el permiso de
     * `/comercial/ventas-por-ruta` por otro y el candado **siguió verde**. Es la lección de la
     * fase, otra vez: *una prueba negativa que no se ejerce no prueba nada*.
     *
     * Se normaliza acá, en el origen, y no arreglando el regex: cualquier otro ancla `$` que se
     * agregue más abajo tendría el mismo agujero y nadie lo notaría.
     */
    .map((l) => l.replace(/\r$/, ''));

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
    const perms = [...cuerpo.matchAll(/Permission\.([A-Z0-9_]+)/g)].map((x) => x[1]);
    if (perms.length) return { encontrada: true, perms };

    /*
     * `[SN.36]` ⛔ **Tercera forma de declarar el gate, y el candado estaba CIEGO a ella.**
     *
     * La mayoría de las rutas escribe `permissionGuard(Permission.X)` inline, así que la clave se
     * lee del propio `app.routes.ts`. Pero `/finanzas/cartera` usa `canActivate: [carteraEntryGuard]`
     * —un guard con nombre que además redirige a `/finanzas/cobranza` a quien sólo tenga
     * `FINANCE_COLLECTIONS_VER`— y ahí no hay ni un `Permission.` que leer. El candado reportaba
     * «la ruta no declara ningún permiso» sobre una ruta que SÍ exige `FINANCE_RECEIVABLES_VER`.
     *
     * Es literalmente la lección que este archivo ya tenía escrita dos veces (`const KEY =` en
     * `[SN.32]`, `@Get(':id')` citado en prosa): **un candado lee CÓDIGO, y sólo el que sabe leer**;
     * un falso positivo suyo entrena a ignorarlo, que es peor que no tenerlo.
     *
     * ⚠️ Sigue UN nivel de indirección, a propósito. Un guard que delegue en otro —o los
     * `landingRedirectGuard(X_LANDING, …)`, que sacan sus claves de un array aparte— vuelve a salir
     * vacío y el candado vuelve a acusar. Es el comportamiento correcto: hoy ninguna bandeja apunta
     * a una landing, y el día que apunte, que se note.
     */
    const nombre = cuerpo.match(/canActivate: \[([a-zA-Z0-9_]+)\]/);
    if (!nombre) return { encontrada: true, perms: [] };
    const srcGuards = fs.readFileSync(
      path.resolve(__dirname, '../../apps/view/src/app/core/guards/permission.guard.ts'), 'utf8',
    );
    const iG = srcGuards.indexOf(`export const ${nombre[1]}`);
    if (iG < 0) return { encontrada: true, perms: [] };
    const sig = srcGuards.indexOf('\nexport const ', iG + 1);
    const cuerpoG = srcGuards.slice(iG, sig < 0 ? srcGuards.length : sig);
    return {
      encontrada: true,
      perms: [...cuerpoG.matchAll(/Permission\.([A-Z0-9_]+)/g)].map((x) => x[1]),
    };
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
  check('se leyeron las 5 fuentes de tarea (si no, este bloque no mide nada)', fuentes.length === 5, fuentes.length);
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
    /*
     * ⛔ `[SN.32]` **El lector estaba CIEGO a una segunda forma de declarar la clave**, y no en
     * teoría: `[CG.21]` la escribió como `const KEY = 'finanzas.caja'` en vez de un array, así que
     * el catálogo salía en 14 con 15 claves sembradas y las dos aserciones de biyección de abajo
     * acusaban en falso a una clave que SÍ estaba declarada. Es la misma familia que la advertencia
     * de la cabecera: **un candado lee CÓDIGO, y sólo el que sabe leer**. Se acepta la segunda
     * forma en vez de pedirle a la migración que cambie: las dos son declaraciones legítimas.
     */
    for (const m of txt.matchAll(/\bKEY\s*=\s*'([a-z]+\.[a-z_]+)'/g)) {
      if (!catalogo.includes(m[1])) catalogo.push(m[1]);
    }
  }
  // `[SN.32]` +1: entró «Salud de las bases de datos» con su clave `sistemas.salud_datos`.
  // `[SN.36]` +1: entró «Cartera de clientes» con su clave `finanzas.cartera`.
  // `[SN.39]` +1: entró «Comprobantes de entrada de mercancía» con su clave `compras.entradas`.
  // `[MS.3.8]` +1: entró «Solicitudes de servicio por asignar» con su clave `servicio.atender`.
  check('se leyó el catálogo de las migraciones (si no, este bloque no mide nada)',
    catalogo.length === 19, catalogo);

  /*
   * `[SN.17]` Las colas viven en TRES registros y las tres cuentan: bandejas, tareas y ciclos.
   * Cuando se agregó el ciclo de conciliación el catálogo pasó a 10 claves y este bloque habría
   * acusado 2 "sin cola" si sólo mirara los dos primeros archivos.
   */
  /*
   * `[JZ.3]` Y ahora son CUATRO registros: entró «Cómo va tu zona», que no es una cola sino un
   * resultado, y por eso declara sus claves en un mapa (`RESPONSABILIDAD_CANAL`) y no en un campo
   * `responsabilidad:` de una definición de bandeja. La biyección igual tiene que cerrar: una
   * clave del catálogo que ningún registro use es un bloque que nadie va a ver nunca.
   */
  /*
   * ⚠️ **Un candado lee CÓDIGO, no prosa.** La cabecera de este archivo ya lo advertía para
   * `@RequirePermissions`, y volvió a cobrar: el chequeo de «la venta de ruta NO sale de
   * `sales_daily`» buscaba `RUTA-` y lo encontró en el COMENTARIO que explica por qué se dejó de
   * usar. Es la tercera vez en esta fase (la otra fue `@Get(':id')` citado en prosa). Se quitan
   * los comentarios antes de juzgar — mismo criterio que `cssDelComponente()` en el spec de la
   * pantalla, que los quita porque CITAN las reglas retiradas.
   */
  const sinComentarios = (t) =>
    t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const srcZraw = fs.readFileSync(path.resolve(__dirname, '../../libs/trade/src/lib/users/me-zona.ts'), 'utf8');
  const srcZ = sinComentarios(srcZraw);
  const declaradas = [
    ...[...src.matchAll(/responsabilidad: '([^']+)'/g)].map((m) => m[1]),
    ...[...srcT.matchAll(/responsabilidad: '([^']+)'/g)].map((m) => m[1]),
    ...[...srcC.matchAll(/responsabilidad: '([^']+)'/g)].map((m) => m[1]),
    ...[...srcZ.matchAll(/^\s*(?:tienda|ruta|vecinal): '([a-z]+\.[a-z_]+)',/gm)].map((m) => m[1]),
    /*
     * `[JZ.7]` La clave de dirección no vive en el mapa por canal —no ES un canal, es el sujeto:
     * todas las zonas— así que se declara como constante y se lee aparte. Sin esta línea el
     * candado de «ninguna clave del catálogo se quedó sin cola» la reportaría huérfana, que es
     * exactamente lo que hizo la primera vez que corrió.
     */
    ...[...srcZ.matchAll(/RESPONSABILIDAD_TODAS_LAS_ZONAS = '([a-z]+\.[a-z_]+)'/g)].map((m) => m[1]),
  ];
  // `[CG.21]` +1: entró «Movimientos de caja por confirmar» con su clave `finanzas.caja`.
  // `[SN.32]` +1: entró «Fuentes de datos con falla» con su clave `sistemas.salud_datos`.
  // `[SN.36]` +2 COLAS pero +1 CLAVE: «vencido» y «sobre su línea» son dos renglones de la misma
  // responsabilidad (`finanzas.cartera`), así que `declaradas` sube 2 y `catalogo` sólo 1. Es el
  // caso que la aserción de conjunto de abajo cubre y la de unicidad (retirada) habría roto.
  // `[SN.39]` +1 bandeja y +1 clave: «Entradas de mercancía sin comprobante».
  // `[MS.3.8]` +1 bandeja y +1 clave: «Solicitudes de servicio sin asignar». ⚠️ El esperado venía en 21 con 22
  // declaradas desde antes de este cambio (una bandeja anterior no actualizó la cuenta): 22 + la de la Mesa = 23.
  check('cada cola declara su responsabilidad (14 bandejas + 1 tarea + 4 ciclos + 3 canales + dirección)',
    declaradas.length === 23, declaradas);
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
   * ── 4e. `[SN.24]` El trabajo con dueño SÓLO lo ve su dueño ───────────────────────────────────
   *
   * Edgar (2026-09-14): *"todos pueden ver el trabajo de conciliación, que está mal. Ese trabajo
   * sólo lo puede ver quien tiene designada esa actividad."* Medido: cada conciliación la veían
   * **15 personas**, siendo de Ivonne (ingresos) y Mayra (egresos).
   *
   * La causa era el SUJETO de la condición. `[SN.21]` preguntaba «¿VOS tenés reparto?» y, como casi
   * nadie lo tiene, su salvaguarda («sin reparto, ves todo») se volvió el caso normal. Ahora la
   * pregunta es **por cola**: «¿esta actividad tiene dueño?».
   *
   * Este bloque vigila la FORMA en el código; el efecto sobre el dato lo mide
   * `database/scripts/sn-landing-censo.js` contra prod.
   */
  console.log('\n── 4e. Una cola se muestra SÓLO si vos respondés de ella ──');
  const srcSvc = fs.readFileSync(
    path.resolve(__dirname, '../../libs/trade/src/lib/users/users.service.ts'),
    'utf8',
  );

  /*
   * ⛔ `[SN.30]` **La consulta de "qué colas tienen dueño" ya no debe existir.**
   *
   * `[SN.24]` preguntaba «¿esta actividad tiene dueño?» y, si no lo tenía, la ofrecía a cualquiera
   * con permiso. Esa mitad se cayó por decisión de Edgar (*«si no tiene responsabilidades no se le
   * muestra nada»*), y con ella el concepto entero de «cola sin dueño»: acá ya sólo se pregunta si
   * la cola es TUYA. Dejar la consulta viva sería una pasada a dos tablas por request que nadie
   * lee — y peor, la tentación de volver a colgarle la regla vieja.
   */
  check('⛔ responsabilidadesConDueno() se retiró (el concepto de "cola sin dueño" ya no existe)',
    !/private async responsabilidadesConDueno\(/.test(srcSvc));

  const mAjena = /const ajena = \(([\s\S]*?)\n    \};/.exec(srcSvc);
  check('existe la compuerta (`ajena`)', !!mAjena);
  if (mAjena) {
    const cond = mAjena[1];
    /*
     * ⛔ Prueba NEGATIVA de este bloque, ejercida: se le devolvió la rama vieja
     * (`tieneDueno(clave) && !propia`) y las dos primeras aserciones se pusieron rojas.
     */
    check('la condición es "no es tuya" a secas — NO "tiene otro dueño"',
      /return !propia;/.test(cond) && !/tieneDueno/.test(cond), cond.trim());
    check('⛔ y NO vuelve a preguntar por la persona ("¿vos tenés reparto?" era la salvaguarda de [SN.21])',
      !/delegacionActiva/.test(cond) && !/\.size > 0/.test(cond), cond.trim());
    check('tu BORRADOR (alcance mio) nunca se esconde: lo empezaste vos',
      /alcance === 'mio'/.test(cond), cond.trim());
    /*
     * ⛔ `[SN.28]` **El god-mode NO puede ser una exención acá**, y con `[SN.30]` es redundante por
     * construcción: la compuerta ya no mira permisos, sólo responsabilidad. La aserción se queda
     * porque es barata y porque la línea que protege ya se escribió mal una vez — hasta `[SN.28]`
     * este mismo check exigía lo CONTRARIO (`check('god-mode ve todo', /esAdmin/…)`) y por eso el
     * defecto pasaba verde: el candado protegía el bug.
     */
    check('el god-mode NO convierte a nadie en dueño (es acceso, no responsabilidad)',
      !/esAdmin/.test(cond), cond.trim());
    check('el god-mode SÍ sigue decidiendo el acceso, que es otro eje',
      /puedeVerBandeja\(b, permisos, esAdmin\)/.test(srcSvc) &&
      /puedeVerCiclo\(c, permisos, esAdmin\)/.test(srcSvc));
    check('si no se pudieron leer las responsabilidades, se falla ABIERTO (no se vacía por una falla)',
      /misResponsabilidades === null/.test(cond), cond.trim());
  }

  /*
   * ⛔ `[SN.30]` **Una cola sin `responsabilidad` declarada es INVISIBLE PARA SIEMPRE.**
   *
   * Con la regla nueva, una cola se muestra sólo si vos respondés de ella — y no se puede
   * responder de algo que no tiene clave en el catálogo de `[OR.1b]`. Antes esto no dolía: sin
   * dueño, la cola caía en «compartida» y la veía cualquiera con permiso. Ahora desaparece de la
   * portada de todo el mundo, **en silencio**, que es la forma exacta de fallar que ADR-056
   * prohíbe.
   *
   * Se enumera la deuda conocida en vez de exigir cero: agregar una nueva pone esto en ROJO, y
   * arreglar una y no sacarla de la lista también. Mismo patrón que la lista DEUDA de
   * `landing-guards.spec.ts`.
   *
   * ⚠️ `logistics.flota` es el caso GEMELO pero de DATO, no de código: la bandeja sí declara su
   * clave y lo que falta es que alguna PERSONA la tenga. Eso no se puede vigilar desde acá —
   * lo mide `database/scripts/sn-landing-censo.js` contra prod.
   */
  console.log('\n── 4h. Ninguna cola nueva puede quedar sin responsabilidad (= invisible) ──');
  const SIN_RESPONSABILIDAD_CONOCIDOS = {
    'libro-de-compras':
      'Nadie respondía de él cuando se creó ([SN.16]); con [SN.30] no lo ve nadie hasta que se ' +
      'le declare una clave en identity.responsibilities y se le asigne a contabilidad.',
  };
  const srcCiclos = fs.readFileSync(
    path.resolve(__dirname, '../../libs/trade/src/lib/users/me-cycles.ts'), 'utf8');
  const bloquesCiclo = [...srcCiclos.matchAll(/\n    id: '([^']+)',([\s\S]*?)(?=\n    id: '|\n\];)/g)];
  check('se leyeron los ciclos del registro (si no, este bloque no mide nada)',
    bloquesCiclo.length >= 4, bloquesCiclo.length);
  const huerfanos = bloquesCiclo
    .filter((m) => !/\n\s*responsabilidad:/.test(m[2]))
    .map((m) => m[1]);
  const nuevos = huerfanos.filter((id) => !(id in SIN_RESPONSABILIDAD_CONOCIDOS));
  const yaArreglados = Object.keys(SIN_RESPONSABILIDAD_CONOCIDOS).filter((id) => !huerfanos.includes(id));
  check('⛔ ningún ciclo NUEVO sin responsabilidad (seria invisible para todos, en silencio)',
    nuevos.length === 0, nuevos);
  check('la deuda declarada sigue siendo real (si se arregló, hay que sacarla de la lista)',
    yaArreglados.length === 0, yaArreglados);
  for (const id of huerfanos) {
    console.log(`  ⓘ DEUDA ${id} — ${SIN_RESPONSABILIDAD_CONOCIDOS[id] ?? 'sin motivo declarado'}`);
  }

  /*
   * El caso que sin esta rama borraría una cola de la suite entera: medido, los 3 dueños de
   * `comercial.thot` no tienen `COMMERCIAL_THOT_GESTIONAR`, así que «sólo la ve su dueño» +
   * «su dueño no puede abrirla» = nadie. Se muestra al dueño, sin enlace y con el motivo.
   */
  check('la cola que es TUYA pero tu permiso no abre se muestra sin enlace (no desaparece)',
    /if \(!abre && !propia\) continue;/.test(srcSvc) && /if \(!abreCiclo && !mio\) continue;/.test(srcSvc));
  check('y viaja con su motivo, nunca con enlace y motivo a la vez',
    /ruta: abre \? b\.ruta : null/.test(srcSvc) && /sin_acceso: abre/.test(srcSvc));
  check('lo que se esconde por no ser tuyo se DECLARA (ocultas), no desaparece en silencio',
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

  /**
   * ── 4g. `[SN.29]` Toda bandeja viva declara su umbral y su columna de cierre ─────────────────
   *
   * Es el candado que evita repetir, en las bandejas, el defecto que la Fase VP encontró en
   * `db-health`: `cfg ? classify : 'ok'` daba **verde incondicional** a toda fuente sin umbral
   * registrado. Acá el equivalente es una bandeja sin `umbral_dias`: `veredictoDe` no puede
   * emitirle `atrasada` nunca, así que se pinta al día para siempre por más vieja que esté.
   *
   * ⛔ Prueba negativa EJERCIDA: se le quitó `umbral_dias` a `cuadre` y la primera aserción se
   * puso roja (`5 de 6`). Es la forma exacta en que volvería a romperse — alguien agregando una
   * bandeja nueva copiando otra y borrando la línea que "no entiende".
   */
  console.log('\n── 4g. Umbral y columna de cierre declarados por bandeja ──');
  /** Cada bloque de bandeja, de `id:` al `id:` siguiente (o al fin del arreglo). */
  const bloques = [...src.matchAll(/\n    id: '([^']+)',([\s\S]*?)(?=\n    id: '|\n\];)/g)].map((m) => ({
    id: m[1],
    cuerpo: m[2],
  }));
  check('se leyeron los bloques de bandeja (si no, este bloque no mide nada)', bloques.length >= 6, bloques.length);

  const vivas = bloques.filter((b) => !/\n\s*retirada:/.test(b.cuerpo));
  check('hay bandejas vivas que auditar', vivas.length >= 5, vivas.length);

  for (const b of vivas) {
    const umbral = b.cuerpo.match(/umbral_dias: (\d+)/);
    /*
     * `[MS.3.8]` Una bandeja puede declarar su plazo en MINUTOS HÁBILES leídos de la configuración
     * (`umbral_dias: null` + `plazoHabil`). Lo que NO puede es no declarar ninguno: sería el verde
     * incondicional de siempre. `null` sin `plazoHabil` es el caso que se vigila acá.
     */
    const dinamico = /umbral_dias: null/.test(b.cuerpo) && /plazoHabil: async/.test(b.cuerpo);
    check(`${b.id} declara su plazo (umbral_dias, o plazoHabil leído de la configuración)`,
      !!umbral || dinamico, umbral ? `${umbral[1]} d` : dinamico ? 'minutos hábiles (configuración)' : 'AUSENTE');
    if (umbral) {
      check(`${b.id}: el umbral es un plazo real (1..90 días)`,
        Number(umbral[1]) >= 1 && Number(umbral[1]) <= 90, umbral[1]);
    }
    /*
     * ⛔ `cierre` puede ser `null` a propósito (la fuente no puede contestarlo) pero NO puede
     * FALTAR: si falta, `medirCola` no recibe la propiedad y `cerradas_30d` saldría del `else`
     * igual — sólo que sin que nadie lo haya decidido. Lo que se exige es la DECISIÓN explícita.
     */
    check(b.id + ' declara columna de cierre (o null con motivo)', /cierre: ('[^']+'|null)/.test(b.cuerpo));
  }

  // El registro no puede volver a la forma vieja, donde el estado iba en el `.where()` y el flujo
  // era inmedible sin una segunda consulta por bandeja.
  check('medirCola recibe los EJES, no una consulta ya filtrada al estado abierto',
    /async function medirCola\(knex: Knex, q: Knex\.QueryBuilder, ejes: EjesCola\)/.test(src));
  check('el flujo sale de la MISMA pasada (count filter), no de una segunda consulta',
    (src.match(/count\(\*\) filter \(where/g) || []).length >= 3);
  check('⛔ cerradas_30d viaja null cuando no hay columna de cierre, NUNCA 0',
    /null::int as c30/.test(src) && !/c30.*\?\?\s*0/.test(src));

  // `veredictoDe` vive donde SÍ hay runner de pruebas (ADR-056: el primitivo va a `libs/`).
  const srcVer = fs.readFileSync(
    path.resolve(__dirname, '../../libs/contracts/src/http/identity-me.contract.ts'), 'utf8');
  check('veredictoDe vive en libs/contracts (donde corre jest), no en libs/trade (que sólo lintea)',
    /export function veredictoDe\(/.test(srcVer) && !/export function veredictoDe\(/.test(src));
  check('tiene su propio spec con negativas',
    fs.existsSync(path.resolve(__dirname, '../../libs/contracts/src/http/veredicto.spec.ts')));

  /**
   * ── 4i. `[JZ.3]` El bloque de zona: destino con guard, y el −100 % que no se puede publicar ──
   *
   * Dos defectos distintos, los dos ya vividos en esta pantalla:
   *
   *  1. **Un número que invita a hacer clic y aterriza en un 403.** Es el mismo candado que 4a
   *     aplica a las bandejas; acá el destino no vive en un `anyOf` sino en el mapa `DESTINO`, y
   *     su permiso tiene que ser el que gatea la ruta en `app.routes.ts`.
   *
   *  2. **Dibujar «−100 %» sobre un dato que dejó de llegar.** Medido en prod: las 5 rutas de
   *     ZAMORA no registran venta desde el 11-12 de agosto y vendieron $824k en julio — la pierna
   *     Wincaja del sell-out, no una caída. El candado exige que la variación salga del primitivo
   *     de `libs/contracts` (que sí tiene jest y sus negativas) y que este archivo no se la
   *     calcule a mano, que es como volvería a aparecer.
   *
   * ⛔ Prueba negativa EJERCIDA: se cambió el permiso de `ruta` a `COMMERCIAL_ANALYTICS_VER` y la
   * aserción del guard se puso roja.
   */
  console.log('\n── 4i. [JZ.3] Cómo va tu zona: destino, permiso y el no−100% ──');

  /*
   * ⚠️ El regex atraviesa saltos de línea a propósito, y esa NO fue la primera versión. La de una
   * sola línea leyó **1 de 2 destinos** —prettier parte la entrada de `ruta` en tres renglones—
   * así que el guard de `/comercial/ventas-por-ruta`, que es justo el que falla en prod (la jefa
   * de zona no tiene su permiso), no se estaba verificando. El bucle habría corrido sobre un solo
   * elemento y salido verde. Lo agarró la aserción de abajo: **por eso un candado empieza
   * afirmando que leyó lo que cree haber leído** (cero coincidencias no es cero infracciones).
   */
  const destinos = [...srcZ.matchAll(/(tienda|ruta): \{\s*ruta: '([^']+)',\s*permiso: Permission\.([A-Z0-9_]+)/g)]
    .map((m) => ({ grupo: m[1], ruta: m[2], permiso: m[3] }));
  check('se leyó el mapa DESTINO COMPLETO (si no, este bloque mide de menos)', destinos.length === 2, destinos);
  for (const d of destinos) {
    const g = guardDe(d.ruta);
    check(`${d.grupo}: la ruta ${d.ruta} existe en app.routes.ts`, g.encontrada);
    if (!g.encontrada) continue;
    check(`${d.grupo}: el guard de ${d.ruta} acepta ${d.permiso}`, g.perms.includes(d.permiso), {
      guard: g.perms, declarado: d.permiso,
    });
  }

  // La variación NO se calcula acá: sale del primitivo probado. Una resta a mano es el camino de
  // vuelta al −100 %, porque `null - 824000` en JS no falla: da NaN, y NaN sobrevive a JSON.
  check('⛔ la variación sale de variacionPct(), no de una resta local',
    /variacionPct\(/.test(srcZ) && !/\(\s*monto\s*-\s*comparado\s*\)\s*\//.test(srcZ));
  check('variacionPct y ventanaComparable viven en libs/contracts (donde corre jest)',
    /export function variacionPct\(/.test(srcVer) && /export function ventanaComparable\(/.test(srcVer));
  check('tienen su propio spec con negativas',
    fs.existsSync(path.resolve(__dirname, '../../libs/contracts/src/http/zona-venta.spec.ts')));

  /*
   * `monto: null` es "no hubo ninguna fila", NUNCA 0. Un `?? 0` acá borra la distinción entera.
   *
   * ⚠️ `[CDRP.1]` Este candado estaba clavado a la EXPRESIÓN literal
   * `mtd === null || mtd === undefined ? null : Number(mtd)`, y se puso rojo al factorizarla en el
   * helper `num()` para reusarla con costo y tickets — con la invariante intacta. Que se ponga
   * rojo ante un refactor está BIEN (obliga a re-apuntarlo a conciencia), pero apuntarlo a otro
   * literal repetiría el problema: ahora vigila la SEMÁNTICA —el helper con su cuerpo exacto, que
   * `guardar` lo use, y que no aparezca ningún `?? 0` sobre un valor medido—.
   */
  const NUM = /const num = \(v: unknown\) => \(v === null \|\| v === undefined \? null : Number\(v\)\)/;
  check('⛔ el monto preserva el null y no cae a 0',
    NUM.test(srcZ) && /monto: num\(mtd\)/.test(srcZ)
      && !/(mtd|costo|tickets|ventaConCosto)\s*\?\?\s*0/.test(srcZ));

  /*
   * `[CDRP.1]` El margen del canal y su COBERTURA viajan juntos o no viajan.
   *
   * ⛔ Medido el 2026-09-18: la venta por ruta NO tiene costo (`costo_status` dice
   * `sin_dato_en_la_fuente` en el 100 % de las filas del tramo, $3.16 M). Un margen de zona que
   * sumara los dos canales taparía que el 11 % de la venta no tiene con qué calcularse, y un
   * margen sin cobertura al lado se lee igual con el 89 % que con el 100 %.
   */
  check('⛔ el margen se calcula sobre la venta QUE TIENE COSTO, no sobre la venta total',
    /\(ventaConCosto - costo\) \/ ventaConCosto/.test(srcZ)
      && /margen_cobertura/.test(srcZ));
  /* El cuerpo de cada interfaz, para poder preguntar EN CUÁL de las dos vive el campo. */
  const cuerpoDe = (nombre) => {
    const i = srcVer.indexOf('export interface ' + nombre + ' {');
    return i < 0 ? '' : srcVer.slice(i, srcVer.indexOf(String.fromCharCode(10) + '}', i));
  };
  check('⛔ el margen vive en el BLOQUE (por canal), no en la zona',
    /margen_pct/.test(cuerpoDe('MeZonaBloque')) && !/margen_pct/.test(cuerpoDe('MeZona')));
  check('⛔ el ticket promedio es por canal y nace del conteo, no de una división inventada',
    /ticket_promedio: tickets === null \|\| tickets === 0/.test(srcZ));
  check('la última venta se busca con tope en hoy (sales_daily tiene filas en el FUTURO)',
    /\.where\('sale_date', '<=', v\.hasta\)/.test(srcZ));
  /*
   * ⚠️ Acá se vigilaba que lo AMBIGUO se declarara. `[JZ.6]` disolvió la ambigüedad —la
   * pertenencia sale del registro operativo y ahí no hay disputa— así que lo que queda por
   * declarar es la serie HISTÓRICA de una ruta, que es el otro caso de «no se puede sumar».
   */
  /*
   * ⚠️ `[JZ.7]` Acá decía `excluidos[r.tipo].push`. Con N zonas eso dejó de ser un `Record` por
   * grupo y pasó a ser un `Map` por (zona, grupo) —lo excluido de LA PIEDAD no es lo excluido de
   * ZAMORA—, así que el candado se ató al nombre nuevo. **El candado se puso rojo solo cuando
   * cambié la estructura**, que es exactamente lo que tenía que hacer.
   */
  check('lo que no se puede sumar se DECLARA en excluidos, con su motivo',
    /excluir\(r\.zone_id, r\.tipo, \{/.test(srcZ) && /if \(r\.historica\)/.test(srcZ));

  /*
   * ⛔ **El pareo de los dos lados de la comparación.** Lo destapó el reporte contra prod, no una
   * revisión de código: ZAMORA publicaba **−42.2 %** porque el `monto` sumaba UN canal y el
   * `comparado` sumaba DOS — su tienda de septiembre contra la tienda más tres rutas de agosto.
   * Es el −100 % un nivel arriba, y más peligroso porque el número es verosímil.
   *
   * Si alguien vuelve a `sumaMedida(filas.map(f => f.comparado))` —que es la forma obvia— esto se
   * pone rojo. Prueba negativa EJERCIDA.
   */
  check('⛔ el subtotal parea los dos lados: un canal entra en ambos o en ninguno',
    /function sumaPareada\(/.test(srcZ) && /dentro\.length === 0 \? null : sumaMedida\(dentro\.map/.test(srcZ));
  check('⛔ y lo que queda fuera se CUENTA, no desaparece del subtotal',
    /no_comparado/.test(srcZ) && /monto_anterior/.test(srcZ));

  /*
   * ── `[JZ.4]` El tramo termina donde termina el DATO, y el grano lo elige la persona ──────────
   *
   * ⛔ El recorte por frescura nació de una mentira publicada: MORELIA ABASTOS decía **−26.1 %**
   * comparando 10 días de septiembre contra 15 de agosto, porque `wincaja_*` no entregaba desde
   * el 10. Con el tramo parejo la zona **sube 17.1 %** — una inversión de signo completa sobre la
   * única cifra de esa portada. `hasta` salía de `todayMx()` y no de hasta dónde llegó la fuente.
   *
   * ⚠️ La línea que separa «la fuente va atrasada» de «este canal murió»: sólo recorta un canal
   * que entregó ALGO dentro del tramo en curso. Sin eso, las rutas de ZAMORA —que no entregan
   * desde el 11-ago— recortarían la zona entera cinco semanas.
   */
  check('⛔ el tramo termina en el último día ENTREGADO, no en el reloj',
    /ventanaComparable\(hoy, periodo, masLento\.ultimo\)/.test(srcZ));
  /*
   * ⚠️ La línea entre «va atrasada» y «murió» es un UMBRAL declarado, no el tramo. La primera
   * versión preguntaba «¿entregó algo dentro del tramo?» y con el grano `dia` el tramo es UN día:
   * la venta por ruta, un día atrás, se leía como muerta y los 9 canales de ruta salían «sin
   * medir». Medido: las fuentes vivas van 1-5 días atrás, las cortadas llevaban 35.
   */
  check('⛔ la vivencia de una fuente sale de un UMBRAL declarado, no del tramo',
    /const VIVA_DIAS = \d+;/.test(srcZ) && /limiteVivo/.test(srcZ));
  check('el recorte se DECLARA con su fuente y sus días', /corte = \{/.test(srcZ)
    && /dias_sin_entregar/.test(srcZ) && /fuentes:/.test(srcZ));

  const srcCtrl = fs.readFileSync(
    path.resolve(__dirname, '../../libs/trade/src/lib/users/users.controller.ts'), 'utf8');
  check('el endpoint acepta ?periodo=', /@Query\('periodo'\)/.test(srcCtrl));
  /*
   * ⛔ Lista CERRADA. Un `periodo` libre elegiría un comparador que nadie diseñó — y como cada
   * grano compara contra un tramo distinto, el número saldría verosímil y mal.
   */
  check('⛔ y lo valida contra la lista cerrada, cayendo a "mes"',
    /periodo === 'dia' \|\| periodo === 'semana' \|\| periodo === 'mes' \? periodo : 'mes'/.test(srcCtrl));
  check('los tres granos existen en el contrato',
    /'dia' \| 'semana' \| 'mes'/.test(srcVer));
  check('⛔ dia y semana NO incluyen el día en curso; mes lo DECLARA cuando llega a hoy',
    (srcVer.match(/incluye_dia_en_curso: false/g) || []).length >= 2
      && /incluye_dia_en_curso: hasta === hoy/.test(srcVer));

  /*
   * ── `[JZ.5]` El WS de tienda REFRESCA el bloque; no es su fuente ──────────────────────────────
   *
   * ⛔ Medido contra prod antes de elegir: el stream de `/tienda/live` cubre las 8 tiendas al
   * minuto y **cero rutas** (`RUTA%` no existe en `store_live_tickets`, nunca), y sus totales NO
   * son los del fact — hoy la sucursal `01` da 124.9 % y la `06` un **49.7 %**, porque el stream
   * es de MOSTRADOR y la `06` también vende crédito y mayoreo. Tomar el total del stream habría
   * publicado una cifra que no es ni el mostrador ni la venta. Por eso el ticket sólo dice
   * «volvé a preguntar» y el número sigue saliendo de `analytics.sales_daily`.
   */
  /*
   * ── `[JZ.6]` La portada toma el número de donde lo toma la pantalla a la que manda ───────────
   *
   * ⛔ Medido el 2026-09-17: este bloque publicaba la venta de ruta desde `analytics.sales_daily`
   * (almacén `RUTA-NN`) y la pantalla que abre lee `sales_by_route_monthly`. **Ruta 27, 1-16 de
   * septiembre: 429,639 contra 224,025** — 1.92×, y el clic llevaba de un número al otro. El
   * almacén `RUTA-27` ni siquiera tiene una fila del canal de ruta.
   */
  check('⛔ la venta de RUTA sale de la misma familia que la pantalla, no de sales_daily',
    /v_rd_route_daily/.test(srcZ) && !/'RUTA-/.test(srcZ));
  check('la pertenencia sale del registro OPERATIVO (v_route_zone), no del catálogo',
    /v_route_zone/.test(srcZ) && !/v_route_warehouse/.test(srcZ));
  /*
   * ⛔ El filtro que `/comercial/ventas-por-ruta` acepta es `"<sucursal>|<route_code>"`. `[JZ.1]`
   * mandaba el código de almacén y la tabla abría VACÍA — la prueba afirmaba sobre el argumento
   * que viajaba, no sobre el valor que el backend reconoce.
   */
  check('⛔ el enlace arma el filtro que la pantalla RECONOCE',
    /\$\{r\.parent_code\}\|WIN-\$\{r\.route_code\}/.test(srcZ));
  check('la serie histórica de una ruta se DECLARA, no se suma',
    /if \(r\.historica\)/.test(srcZ) && /la contaría dos veces/.test(srcZ));
  check('vecinal es un canal propio, con su propia clave de responsabilidad',
    /vecinal: 'comercial\.venta_vecinal'/.test(srcZ));

  check('⛔ el refresco en vivo tiene endpoint PROPIO (me/work cuesta 14 mediciones)',
    /@Get\('me\/work\/zona'\)/.test(srcCtrl) && /zonaFor\(/.test(srcCtrl));
  /*
   * La misma trampa que `me/scope`: si `me/work/zona` cayera DEBAJO de `@Get(':id')`, la ruta
   * genérica se lo tragaría y el refresco devolvería un 404 o el usuario «zona».
   */
  /*
   * ⚠️ El decorador se busca **como decorador**: anclado al principio de la línea y con su
   * indentación. La primera versión usaba `indexOf("@Get(':id')")` y encontró **el comentario de
   * arriba**, que cita esa ruta en prosa para explicar por qué el orden importa — reportó que el
   * endpoint estaba después de `:id` cuando está 130 líneas antes. Es la misma trampa que la
   * cabecera de este archivo ya documentaba para `@RequirePermissions`, y volvió a cobrar.
   */
  const lineaDe = (re) => srcCtrl.split('\n').findIndex((l) => re.test(l));
  const lZona = lineaDe(/^\s*@Get\('me\/work\/zona'\)/);
  const lId = lineaDe(/^\s*@Get\(':id'\)/);
  check("⛔ y está declarado ANTES de @Get(':id'), que si no se lo traga",
    lZona >= 0 && lId >= 0 && lZona < lId, { zona: lZona + 1, id: lId + 1 });

  const srcMt = fs.readFileSync(
    path.resolve(__dirname, '../../apps/view/src/app/modules/mi-trabajo/mi-trabajo.component.ts'),
    'utf8');
  check('⛔ el ticket sólo DISPARA: el monto no sale del stream',
    /workZona\(this\.periodoZona\(\)\)/.test(srcMt) && !/ticket\.total/.test(srcMt));
  /*
   * ⛔ El filtro por sucursal NO es una optimización. Quien no tiene `warehouse_code` en su ficha
   * entra al room del TENANT COMPLETO (`StoreGateway.handleConnection`) y recibe los tickets de
   * las 8 sucursales — 2 de los 3 jefes de zona están en ese caso. Sin filtrar, la venta de Zamora
   * refrescaría la portada de Morelia.
   */
  check('⛔ y sólo escucha las sucursales de SU zona',
    /sucursalesDeMiZona\(\)\.has\(/.test(srcMt));
  check('el refresco tiene techo (throttle), no dispara por cada ticket',
    /throttleTime\(/.test(srcMt));

  /*
   * Las dos claves tienen que existir en el catálogo, y su migración tiene que repartirlas: una
   * clave declarada y no repartida es un bloque que no ve NADIE — el defecto exacto de `[LC.6.2]`
   * («un módulo no está entregado hasta que su permiso está repartido, no sólo declarado»).
   */
  const migZ = fs.readdirSync(dirMig).filter((f) => /responsabilidades_venta_zona/.test(f));
  check('existe la migración que declara las dos claves de venta por zona', migZ.length === 1, migZ);
  if (migZ.length === 1) {
    const txtZ = fs.readFileSync(path.join(dirMig, migZ[0]), 'utf8');
    for (const k of ['comercial.venta_tiendas', 'comercial.venta_rutas']) {
      check(`la migración declara "${k}"`, txtZ.includes(k));
      check(`me-zona.ts usa la MISMA clave "${k}"`, srcZ.includes(k));
    }
    check('⛔ la migración REPARTE las claves a un puesto, no sólo las declara',
      /position_responsibilities/.test(txtZ) && /jefe_zona/.test(txtZ));
  }

  /*
   * ── `[JZ.7]` La clave de DIRECCIÓN: todas las zonas, y un solo tramo ────────────────────────
   *
   * Nace de una corrección al organigrama (Edgar, 2026-09-17: «luis francisco es dirección general
   * y guillermo lopez es dirección comercial») que destapó el hueco: medido en prod, sólo 12 de
   * ~50 puestos tienen alguna responsabilidad y NINGUNO es de dirección → por `[SN.30]` el dueño
   * de la empresa abría «Mi trabajo» y no veía nada.
   *
   * ⛔ Las tres condiciones son distintas y ninguna implica a la otra:
   *   1. que la clave exista y se REPARTA (la lección de `[LC.6.2]`),
   *   2. que vaya a los DOS puestos de dirección, no sólo a uno,
   *   3. que el tramo sea UNO para todas las zonas — si cada una se midiera hasta donde llega su
   *      fuente, el total sumaría 15 días de una contra 14 de otra y las zonas dejarían de ser
   *      comparables entre sí, que es exactamente para lo que sirve la pantalla.
   */
  const migD = fs.readdirSync(dirMig).filter((f) => /responsabilidad_venta_zonas/.test(f));
  check('existe la migración de la clave de dirección', migD.length === 1, migD);
  if (migD.length === 1) {
    const txtD = fs.readFileSync(path.join(dirMig, migD[0]), 'utf8');
    check('la migración declara "comercial.venta_zonas"', txtD.includes('comercial.venta_zonas'));
    check('me-zona.ts usa la MISMA clave', srcZ.includes('comercial.venta_zonas'));
    check('⛔ la reparte a los DOS puestos de dirección',
      /'direccion'/.test(txtD) && /'direccion_comercial'/.test(txtD));
    /*
     * ⛔ La clave de dirección va SIN dimensión a propósito: con `'zone'` anclaría en
     * `identity.users.zona_id`, y la ficha de los dos directores dice OFICINAS — 0 almacenes y 0
     * rutas. Les publicaría «la venta de OFICINAS», un cero con cara de cifra.
     */
    check('⛔ y va SIN dimensión (con "zone" publicaría la venta de OFICINAS)',
      /'comercial\.venta_zonas',[\s\S]{0,400}?null,/.test(txtD));
  }

  /*
   * ── `[SN.32]` La clave de SISTEMAS: la salud de las bases de datos ─────────────────────────
   *
   * Mismo hueco que `[JZ.7]`, otro puesto: medido en prod el 2026-09-22, `sistemas` tenía CERO
   * responsabilidades, así que `superoot` abría «Mi trabajo» y no veía nada — con 6 alertas de
   * salud abiertas (5 críticas, la más vieja del 12-sep) esperando dueño.
   *
   * ⛔ Las tres condiciones son distintas:
   *   1. que la clave exista y se REPARTA a un puesto (la lección de `[LC.6.2]`: declarar no es
   *      repartir, y un módulo sin permiso repartido en prod no está entregado),
   *   2. que la bandeja use la MISMA clave (si no, el catálogo tiene una huérfana y la bandeja
   *      nunca se le muestra a nadie),
   *   3. que el estado abierto salga de `resolved_at` y NO de `status` — `status` es la
   *      GRAVEDAD (`warn|critical`), y usarlo como estado contaría las críticas como abiertas y
   *      las de aviso como cerradas: un número verosímil y falso.
   */
  const migS = fs.readdirSync(dirMig).filter((f) => /responsabilidad_salud_datos/.test(f));
  check('existe la migración de la clave de Sistemas', migS.length === 1, migS);
  if (migS.length === 1) {
    const txtS = fs.readFileSync(path.join(dirMig, migS[0]), 'utf8');
    check('la migración declara "sistemas.salud_datos"', txtS.includes('sistemas.salud_datos'));
    check('me-work.ts usa la MISMA clave', src.includes("responsabilidad: 'sistemas.salud_datos'"));
    check('⛔ la REPARTE al puesto sistemas, no sólo la declara',
      /position_responsibilities/.test(txtS) && /'sistemas'/.test(txtS));
    const bloqueS = (bloques.find((b) => b.id === 'salud-datos') || {}).cuerpo || '';
    check('⛔ el estado abierto sale de resolved_at, NO de status (que es la gravedad)',
      /estadoCol: 'resolved_at'/.test(bloqueS) && /estadoAbierto: null/.test(bloqueS)
        && !/estadoCol: 'status'/.test(bloqueS),
      bloqueS ? 'bloque leído' : 'NO se encontró el bloque salud-datos');
    check('⛔ y su ruta es la pantalla que YA publica esa tabla',
      /ruta: '\/admin\/db-health'/.test(bloqueS));

    /*
     * ── `[SN.33]` El DESGLOSE: un renglón por fuente ──────────────────────────────────────────
     *
     * Pedido de Edgar (2026-09-22): *«tienes que desglosarlo»*. Lo que se vigila acá no es que
     * exista —eso lo prueban las 5 pruebas de `mi-trabajo.component.spec.ts`, que sí ejercen el
     * render— sino las DOS formas en que esto se degrada sin que nadie lo note:
     *
     *  1. que alguien se lo copie a una cola grande. `cuadre` tiene 2,409 filas: desglosarla
     *     mudaría su pantalla entera a la portada, que es justo lo que `[SN.7]` regla 1 prohíbe.
     *  2. que la gravedad se rellene con un default. `status` es lo ÚNICO que dice si es crítico
     *     o aviso; un `?? 'warn'` hace que un crítico se lea como aviso, en la única lista que
     *     existe para separarlos de un vistazo.
     */
    check('[SN.33] el tope del desglose está declarado y es un número usable',
      /export const TOPE_DESGLOSE = (\d+);/.test(src)
        && Number(src.match(/export const TOPE_DESGLOSE = (\d+);/)[1]) >= 1
        && Number(src.match(/export const TOPE_DESGLOSE = (\d+);/)[1]) <= 50,
      (src.match(/export const TOPE_DESGLOSE = (\d+);/) || [])[1]);

    /*
     * `[SN.36]` El candado pasa de «sólo `salud-datos`» a una LISTA que hay que editar a
     * propósito. No es un relajamiento: lo que `[SN.33]` prohíbe es que el desglose se copie a
     * una cola grande **por inercia** (`cuadre` tiene 2,409 filas), y para eso lo que hace falta
     * es que agregarlo obligue a tocar este archivo y escribir por qué. Las dos entradas de hoy
     * pasan criterios distintos y los dos son legítimos:
     *
     *  · `salud-datos` — el desglose es EXHAUSTIVO: la cola vive entre 0 y una decena, así que
     *    los 8 renglones son la cola entera.
     *  · `cartera-vencida` — el desglose es el TRABAJO: son 680 clientes, pero los 8 primeros por
     *    monto concentran el grueso del dinero (los dos primeros, $22.1 M de $52.7 M) y la lista
     *    es literalmente a quién llamar hoy. Su hermana `cartera-sobre-limite` NO se desglosa, y
     *    esa asimetría es la prueba de que el criterio se aplicó y no se copió.
     *
     * ⛔ Lo que sigue prohibido es lo de siempre: un desglose sobre una cola cuyas 8 filas no
     * concentren ni la cola ni la decisión — ahí la portada se vuelve la pantalla (`[SN.7]` r.1).
     */
    const DESGLOSE_PERMITIDO = ['salud-datos', 'cartera-vencida', 'entradas-sin-comprobante'];
    const conDesglose = bloques.filter((b) => /\n\s*desglosar:/.test(b.cuerpo)).map((b) => b.id);
    const deMas = conDesglose.filter((id) => !DESGLOSE_PERMITIDO.includes(id));
    check('⛔ [SN.33] sólo se desglosan las colas declaradas (una cola grande mudaría su pantalla a la portada)',
      deMas.length === 0, { conDesglose, deMas });
    check('⛔ [SN.36] y las declaradas siguen ahí (si no, el permiso de arriba no vigila nada)',
      DESGLOSE_PERMITIDO.every((id) => conDesglose.includes(id)), conDesglose);

    check('⛔ [SN.33] el desglose ordena por GRAVEDAD antes que por fecha',
      /case when status = 'critical' then 0 else 1 end[\s\S]{0,200}?orderBy\('first_seen_at'/.test(bloqueS));

    check('⛔ [SN.33] la gravedad NO se rellena con un default (sería un crítico con cara de aviso)',
      !/nivel:[^,\n]*\?\?\s*'(warn|critical)'/.test(bloqueS));

    /*
     * ⛔ Cuántas quedaron fuera se calcula contra el `total` YA medido, no lo inventa la bandeja:
     * es el único número que puede decirlo exacto, y recortar sin declararlo hace que «eso es
     * todo» y «eso es lo que cabe» se lean igual ([SN.21]).
     */
    const srcSvc = sinComentarios(
      fs.readFileSync(path.resolve(__dirname, '../../libs/trade/src/lib/users/users.service.ts'), 'utf8'),
    );
    check('⛔ [SN.33] lo truncado se deriva del total medido, no de la consulta recortada',
      /desglose_truncado:\s*Math\.max\(0,\s*total - items\.length\)/.test(srcSvc));
  }

  /*
   * ── `[SN.34]` «Tus espacios» NO se recorta por departamento ──────────────────────────────────
   *
   * Este bloque exigía lo contrario —que «Administración y Finanzas» desapareciera de la portada
   * de Sistemas— y se dio vuelta el mismo día, 2026-09-22, con la corrección de Edgar: *«te dije
   * que me ocultaras finanzas pero sólo lo de mi trabajo, no el módulo»*.
   *
   * ⭐ El error no era el alcance sino la COLUMNA. `/projects` tiene dos: «Tu trabajo» (las colas)
   * y «Tus espacios» (los mosaicos, que son la navegación a los módulos). El recorte cayó en la
   * segunda, o sea que le quitó la puerta en vez de la cola.
   *
   * ⛔ Y no hizo falta nada en su lugar: «Tu trabajo» de Sistemas **ya no tiene nada de finanzas**
   * —`[SN.30]` sólo muestra las colas de las que uno responde— y el único resto es un contador
   * anónimo que nunca nombra un dominio. Lo que se vigila ahora es que el recorte no vuelva.
   */
  console.log('\n── 4j. [SN.34] «Tus espacios» no se recorta por departamento ──');
  const srcMapa = sinComentarios(
    fs.readFileSync(path.resolve(__dirname, '../../libs/contracts/src/authz/suite-map.ts'), 'utf8'),
  );
  check('⛔ el mecanismo de ocultar espacios por departamento se retiró con su único uso',
    !/hideForDepartments/.test(srcMapa), null);
  check('⛔ y tampoco se oculta por ROL (3 de los 8 superadmin son jefes de zona, medido)',
    !/hideForRoles:[^\n]*superadmin/.test(srcMapa));
  const srcPortada = sinComentarios(
    fs.readFileSync(path.resolve(__dirname, '../../apps/view/src/app/modules/mi-trabajo/mi-trabajo.component.ts'), 'utf8'),
  );
  check('⛔ la portada no filtra la lista de espacios por el departamento',
    !/hideForDepartments/.test(srcPortada), null);
  /*
   * ⚠️ El departamento SIGUE leyéndose, y tiene que seguir: `[SN.35]` lo usa para apagar el bloque
   * «A tu nombre». Sin esta línea, un revert de más se llevaría también ese pedido, que sí está
   * vigente.
   */
  check('⚠️ pero el departamento se sigue leyendo (lo necesita [SN.35])',
    /miDepartamento = computed/.test(srcPortada));

  /*
   * ── `[SN.35]` «A tu nombre», apagado hasta nuevo aviso ───────────────────────────────────────
   *
   * Pedido de Edgar (2026-09-22): *«eliminemos esas conciliación a nombres de personas hasta nuevo
   * aviso, solo debe aparecer la base de datos (en mi caso)»*.
   *
   * ⛔ Lo que este bloque vigila NO es que esté apagado —eso lo ejercen 4 pruebas del componente—
   * sino las dos formas de que el apagado se vuelva una mentira:
   *   1. que la lista se vacíe o se vuelva global. Medido: 151 tareas vivas sobre 38 de 118
   *      personas; apagarlo para todos dejaría a 37 sin ver lo que alguien les asignó con nombre.
   *   2. que se oculte SIN declararlo. Una portada recortada en silencio es indistinguible de una
   *      portada vacía, y el titular seguiría publicando «0 pendientes a tu nombre» sobre 10
   *      escondidos — que no es un recorte, es una afirmación falsa.
   */
  console.log('\n── 4k. [SN.35] El trabajo nominal, apagado por departamento ──');
  const srcNominal = sinComentarios(
    fs.readFileSync(path.resolve(__dirname, '../../libs/contracts/src/work/portada-nominal.contract.ts'), 'utf8'),
  );
  const lista = srcNominal.match(/DEPARTAMENTOS_SIN_TRABAJO_NOMINAL: readonly string\[\] = \[([^\]]*)\]/);
  const depts = lista ? lista[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  check('la política declara a QUÉ departamentos se les apaga', !!lista, lista && lista[1]);
  check('⛔ y es una lista ACOTADA, no un apagado global (151 tareas vivas sobre 38 personas)',
    depts.length >= 1 && depts.length <= 3, depts);
  check('el motivo que se imprime vive CON la política, no suelto en la plantilla',
    /MOTIVO_SIN_TRABAJO_NOMINAL/.test(srcNominal) && /No se borró/.test(srcNominal));
  check('la portada lo aplica a las tareas y a los borradores propios',
    /if \(this\.sinTrabajoNominal\(\)\) return \[\];/.test(srcPortada)
      && /this\.sinTrabajoNominal\(\) \? \[\] : this\.pendientes\(\)/.test(srcPortada));
  const htmlPortada = fs.readFileSync(
    path.resolve(__dirname, '../../apps/view/src/app/modules/mi-trabajo/mi-trabajo.component.html'), 'utf8',
  ).replace(/<!--[\s\S]*?-->/g, '');
  check('⛔ el TITULAR se apaga con el bloque (si no, publicaría 0 sobre lo escondido)',
    /hayTrabajo\(\) && !buscando\(\) && !sinTrabajoNominal\(\)/.test(htmlPortada));
  check('⛔ y lo oculto se DECLARA en pantalla', /motivoSinNominal/.test(htmlPortada));

  console.log('\n── 4l. [SN.36] La cartera de Crédito y Cobranza ──');
  const srcSinCom = sinComentarios(src);
  const migCartera = fs.readFileSync(
    path.resolve(dirMig, '20260922210000_responsabilidad_cartera.js'), 'utf8',
  );
  check('la migración declara la clave Y la reparte a un puesto que existe',
    /'finanzas\.cartera'/.test(migCartera)
      && /PUESTO = 'auxiliar_credito_cobranza'/.test(migCartera)
      && /position_responsibilities/.test(migCartera), null);
  check('⛔ y NO otorga permisos (FINANCE_RECEIVABLES_VER ya estaba repartido)',
    !/role_permissions/.test(migCartera));

  const cartera = [...srcSinCom.matchAll(/id: '(cartera-[a-z-]+)'/g)].map((m) => m[1]);
  check('son DOS bandejas (cobrar lo vencido y frenar la venta a crédito)',
    cartera.length === 2, cartera);
  /*
   * ⛔ El bloque de cada bandeja se recorta del fuente SIN comentarios: la prosa de arriba cita
   * `/finanzas/hallazgos` para explicar por qué NO se enlaza ahí, y un grep ingenuo lo tomaría por
   * la ruta real. Es la cuarta vez en esta suite que un candado lee prosa (ver la cabecera).
   */
  for (const id of cartera) {
    const i = srcSinCom.indexOf(`id: '${id}'`);
    const bloque = srcSinCom.slice(i, i + 900);
    check(`${id} enlaza a la pantalla que YA existe (/finanzas/cartera)`,
      /ruta: '\/finanzas\/cartera'/.test(bloque), bloque.slice(0, 160));
    check(`${id} gatea con el permiso de esa misma pantalla`,
      /anyOf: \[Permission\.FINANCE_RECEIVABLES_VER\]/.test(bloque));
    check(`${id} responde de finanzas.cartera`,
      /responsabilidad: 'finanzas\.cartera'/.test(bloque));
  }

  /*
   * ⛔ **La prueba negativa del predicado nuevo.** `abiertaExtra` narra el lado ABIERTO; si sus
   * bindings se colaran al contador de cerradas, knex tiraría «Expected N bindings» en runtime —
   * que es justo lo que el build NO ve. El candado mira que `CERRADA` use `baseAb` y que el
   * predicado se concatene sólo sobre `BASE_AB`.
   */
  check('⛔ el predicado extra pesa SÓLO del lado abierto',
    /const ABIERTA = abiertaExtra \? `\(\$\{BASE_AB\}\) and \(\$\{abiertaExtra\.sql\}\)` : BASE_AB;/
      .test(srcSinCom), null);
  check('⛔ y el contador de cerradas NO lleva sus bindings (si no: «Expected N bindings»)',
    /\[\.\.\.baseAb, cierre\]/.test(srcSinCom) && !/\[\.\.\.argsAb, cierre\]/.test(srcSinCom));

  /*
   * ⛔ El ancla del predicado es `max(last_seen)` de la PROPIA regla, no `current_date`: con la
   * fecha de hoy, el día que el detector no corra la cola publicaría **0** en vez de quedarse
   * quieta — el cero disfrazado que ADR-056 prohíbe.
   */
  check('⛔ la frescura se ancla a la última pasada del detector, no al día de hoy',
    /last_seen >= \(select max\(last_seen\)::date from finance\.findings/.test(srcSinCom)
      && !/last_seen >= now\(\)::date/.test(srcSinCom));
  check('⛔ la cola NO se cuelga de la vista viva de cartera (1,336 ms medidos vs 10.6 ms)',
    !/customer_receivables/.test(srcSinCom), null);
  check('el desglose ordena por DINERO (a quién llamar primero), no por fecha',
    /\.orderBy\('importe', 'desc'\)/.test(srcSinCom));
  check('⛔ el id del desglose lleva la sucursal (el mismo cliente sale en dos carteras)',
    /id: `\$\{f\.sucursal \?\? '\?'\}:\$\{f\.cliente_code \?\? f\.id\}`/.test(srcSinCom));
  check('⛔ la gravedad sale de la fuente, sin default benigno',
    !/severity \?\? 'warn'/.test(srcSinCom));

  console.log('\n── 4m. [SN.39] El comprobante de las entradas de mercancía ──');
  const migEnt = fs.readFileSync(
    path.resolve(dirMig, '20260923120000_responsabilidad_entradas.js'), 'utf8',
  );
  check('la migración declara la clave y la reparte a los DOS puestos que suben el comprobante',
    /'compras\.entradas'/.test(migEnt)
      && /'auxiliar_compras'/.test(migEnt)
      && /'analista_abastecimiento_comercial'/.test(migEnt), null);
  check('⛔ y NO otorga permisos (COMPRAS_ENTRADAS_GESTIONAR ya lo tienen los 5)',
    !/role_permissions/.test(migEnt));
  /*
   * ⚠️ El pedido es «de su sucursal» y hoy NINGUNO de los cinco tiene `warehouse_code`. La
   * migración lo IMPRIME en su log en vez de dejarlo sólo en un comentario — un aviso que nadie
   * corre no avisa.
   */
  check('⚠️ la migración DECLARA a quién le falta la sucursal en su ficha',
    /whereNull\('warehouse_code'\)/.test(migEnt) && /de toda la red/.test(migEnt));

  const iEnt = srcSinCom.indexOf(`id: 'entradas-sin-comprobante'`);
  check('existe la bandeja de entradas', iEnt >= 0, null);
  /*
   * ⚠️ 3,400 y no 2,600: con el corte corto el slice terminaba **300 caracteres antes** del
   * `nivel:`/`nota:` del desglose, y dos candados daban rojo sobre código que sí estaba. Un
   * candado que lee una ventana fija falla del lado equivocado cuando el bloque crece — se
   * verifica abajo que la ventana alcanza para el final del bloque, en vez de confiar en el número.
   */
  const bEnt = iEnt >= 0 ? srcSinCom.slice(iEnt, iEnt + 3400) : '';
  check('la ventana del candado llega hasta el final de la bandeja (si no, mide de menos)',
    /nota:/.test(bEnt), bEnt.length);
  check('enlaza a la pantalla que YA existe (/compras/entradas)',
    /ruta: '\/compras\/entradas'/.test(bEnt));
  /*
   * ⛔ La ruta la gatea `permissionGuard(COMPRAS_ENTRADAS_GESTIONAR)`, NO un `anyPermissionGuard`.
   * Con `_VER` acá, `direccion` (que tiene VER true y GESTIONAR false) iría a un rebote — el
   * defecto exacto que la regla 1 de `me-work.ts` existe para impedir.
   */
  check('⛔ gatea con GESTIONAR, no con VER (direccion tiene VER y no GESTIONAR)',
    /anyOf: \[Permission\.COMPRAS_ENTRADAS_GESTIONAR\]/.test(bEnt));
  check('⛔ la cola son las que NO tienen comprobante (leftJoin … is null), no todas las entradas',
    /leftJoin\('finance\.goods_receipt_proofs as p'/.test(bEnt)
      && /estadoCol: 'p\.folio'/.test(bEnt) && /estadoAbierto: null/.test(bEnt));
  /*
   * ⛔ Una entrada no «se cierra»: aparece su comprobante en OTRA tabla. Sin columna de cierre,
   * `cerradas_30d` tiene que viajar `null` — nunca 0, que diría «nadie la trabaja» justo cuando en
   * la sucursal 08 subieron el 78%.
   */
  check('⛔ declara que no tiene columna de cierre (null, nunca 0)', /cierre: null,/.test(bEnt));
  check('⭐ el desglose publica el PORCENTAJE por sucursal (es el pedido)',
    /subidas · \$\{pct\}%/.test(bEnt) && /groupBy\('r\.sucursal'\)/.test(bEnt));
  /*
   * ⛔ Sin entradas en la ventana NO hay porcentaje: `null`, no `0%`. «Nadie subió nada» y «no
   * hubo entradas» son afirmaciones distintas y el 0% las confunde (ADR-056).
   */
  check('⛔ sin entradas el porcentaje es null, no 0%',
    /total > 0 \? Math\.round\(\(con \/ total\) \* 1000\) \/ 10 : null/.test(bEnt));
  /*
   * ⛔ `nivel: null` a propósito: no hay meta de cobertura registrada en ningún lado, y pintar un
   * semáforo exigiría inventar el umbral acá — el `cfg ? classify : 'ok'` de ADR-076 al revés.
   */
  check('⛔ no inventa semáforo: sin meta registrada, nivel null', /nivel: null,/.test(bEnt));
  const tope = Number((src.match(/export const TOPE_DESGLOSE = (\d+);/) || [])[1]);
  check('⛔ el tope del desglose alcanza para las 9 sucursales (si no, esconde una entera)',
    tope >= 9, tope);

  /*
   * El tramo común no se puede leer del fuente con un grep honesto, así que se verifica dónde se
   * decide: el ancla (`ventanaComparable(hoy, periodo, masLento.ultimo)`) tiene que calcularse
   * UNA vez, FUERA del bucle que arma las zonas. Si entrara al bucle, cada zona se recortaría sola.
   */
  const iAncla = srcZ.indexOf('ventanaComparable(hoy, periodo, masLento.ultimo)');
  const iBucle = srcZ.indexOf('for (const zona of zonasObjetivo)');
  check('⛔ el ancla del tramo se resuelve ANTES del bucle de zonas (tramo ÚNICO)',
    iAncla >= 0 && iBucle >= 0 && iAncla < iBucle, { ancla: iAncla, bucle: iBucle });

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
     * `[SN.30]` **Ningún ciclo ajeno puede venir en la lista, tenga reparto esta persona o no.**
     *
     * ⚠️ Acá vivía la regla contraria y hay que dejar el rastro: `[SN.20]` sólo exigía que NO se
     * colaran ajenos *si* la persona tenía algo propio, y la otra rama afirmaba literalmente que
     * «sin reparto se ven todos». Esa salvaguarda era mía y —medido— cubría al **77 % del padrón**,
     * así que era el caso normal, no la excepción: es la que producía el titular de 2,082 de un
     * superadmin que no responde de ninguna de esas colas.
     *
     * Edgar (2026-09-14): *«si no tiene responsabilidades no se le muestra nada»*.
     *
     * ⛔ **La única forma legítima de que llegue un `es_mio: false` es la válvula de falla abierta**
     * de `[SN.22]`: si las responsabilidades no se pudieron leer, el backend manda todo con
     * `delegacion: null` en vez de vaciar la pantalla por un error transitorio. Por eso la
     * aserción se condiciona a ESE hecho y no a la presencia de ajenos — condicionarla al síntoma
     * la volvería incapaz de detectar el bug que vigila.
     *
     * ⚠️ Mientras la API viva corra código anterior a `[SN.30]` esto va a dar rojo, y es correcto
     * que lo dé: significa «falta reiniciar», no «el código está mal». Se declara NO MEDIDO en vez
     * de FAIL sólo cuando el proceso vivo ni siquiera conoce el campo.
     */
    const ajenos = (wb.ciclos ?? []).filter((c) => c.es_mio === false).map((c) => c.id);
    if (wb.delegacion === null) {
      check('falla abierta: sin poder leer el reparto se manda todo (no se vacía la pantalla)',
        true, { motivo: 'delegacion=null', ciclos: wb.ciclos?.length ?? 0 });
    } else if (wb.delegacion === undefined) {
      declarar('ningún ciclo ajeno en la lista ([SN.30])',
        'la API viva corre código anterior: no manda `delegacion`. Reiniciar y volver a correr.');
    } else {
      check('⛔ [SN.30] ningún ciclo ajeno en la lista (una cola se ve SÓLO si respondes de ella)',
        ajenos.length === 0, ajenos);
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
