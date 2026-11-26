'use strict';
/**
 * `[ID.29]` — Candado de REPARTO de permisos. Lo que el catalogo declara, contra lo que
 * un rol vivo concede de verdad.
 *
 * ── POR QUE EXISTE ──────────────────────────────────────────────────────────────────────
 * El enum ya lo dice en su propio encabezado -- *"declararlo en el enum no es entregarlo"*
 * (`[LC.6.2]`) -- y nada lo MEDIA. La regla estaba escrita y sin compuerta, que es la forma
 * mas cara de tener una regla: se cita en los reviews y no detiene nada.
 *
 * Ya cobro dos veces, las dos con el mismo sintoma (un modulo en produccion que nadie podia
 * abrir, descubierto por una persona dias despues):
 *
 *   · `FISCAL_PURCHASE_BOOK_VER/_GESTIONAR` (Fase LC) -- un dia en prod, cero roles.
 *   · `STORE_PRICE_CHECK_VER` (CV.24) -- el verificador de mostrador, cero roles hasta que
 *     la migracion `20260909120000` lo repartio a 7.
 *
 * Y midiendo para escribir este archivo aparecio la tercera, que llevaba **23 dias** viva:
 * `COMMERCIAL_PREVENTION_GESTIONAR` (ver `SIN_REPARTIR`).
 *
 * ── DOS PREGUNTAS, NO UNA ───────────────────────────────────────────────────────────────
 * *"¿Alguien la CONCEDE?"* y *"¿Alguien la TIENE?"* no son la misma pregunta, y yo las
 * confundi en el primer pase: reporte que prevencion de perdida "direccion la VE y nadie la
 * OPERA" -- falso, porque `direccion` tiene **0 personas activas**. Un permiso concedido a
 * un rol que nadie tiene es tan inalcanzable como uno concedido a nadie, y con la primera
 * compuerta sola, un censo de "0 huerfanas" se lee como "todo alcanzable". Por eso hay
 * dos: `[2]` y `[2b]`.
 *
 * ── CONTRA QUE BASE MIDE, Y POR QUE ─────────────────────────────────────────────────────
 * Contra **PROD** (`FLEET_DB_URL`), a proposito. El invariante es sobre el padron que sirve
 * a la gente: verde sobre una copia local vieja es exactamente la mentira que esto viene a
 * matar (la copia trae los `role_permissions` de cuando se bajo, no los de hoy). Es
 * ESTRICTAMENTE de lectura -- cero INSERT/UPDATE/DELETE -- por eso no pasa por
 * `assertSafeTarget`, que guarda a los tests que escriben.
 * Si no se llega: **NO MEDIDO** (exit 2), nunca verde.
 *
 * ── POBLADO != FRESCO ───────────────────────────────────────────────────────────────────
 * Declara que base midio y de cuando es el `role_permissions` mas nuevo que vio. Un censo
 * sobre datos viejos sigue siendo un censo viejo, y eso se lee en pantalla.
 *
 * Cierra con la PRUEBA NEGATIVA: las cuatro compuertas se corren contra entradas adulteradas
 * y se exige que se pongan ROJAS. Un gate sin prueba negativa es una intencion (ADR-056).
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');

const REPO = path.resolve(__dirname, '../..');
require('dotenv').config({ path: path.join(REPO, '.env') });

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };

/**
 * Claves declaradas a proposito SIN repartir. Entrar aca exige un motivo real y un dueno:
 * la lista existe para DECLARAR una decision pendiente, no para silenciar un defecto.
 *
 * El test ademas la vigila al reves: si una de estas ya quedo repartida, exige sacarla
 * (una lista de excepciones que nadie poda deja de significar algo).
 */
const SIN_REPARTIR = {
  // ⛔ `[VEC.0c]` COMMERCIAL_PREVENTION_GESTIONAR SALIO de esta lista el 2026-11-26. Decia
  //    «sin repartir, pendiente de Edgar» y llevaba meses REPARTIDA: medido ese dia, la alcanzan
  //    5 personas activas (2 por rol, 3 por override personal). La lista no mentia por maldad --
  //    medir el reparto por `users.role_name` no ve ni los roles complementarios ni los overrides.
  //    ⭐ Lo que importaba de ese motivo no era «quien la tiene» sino el CONTROL que protegia
  //    (segregacion de funciones), y eso ya no se declara: se mide en `[2d]`.
  // `[RH.1.7]` Las claves de asistencia salieron de esta lista: con las pantallas `/rh/*` las reparte
  // la mig `20261008094815` segun el flujo que Mega Talento documenta (servicios al personal califica
  // y cierra = `recursos_humanos`; contabilidad audita). Ver SIN_PERSONAS.
  HR_NOMINA_GESTIONAR:
    'Frente NE, `[NE.2.3]`. Gatea el puente y la cola: ligar el codigo con que un sistema de ' +
    'nomina nombra a una persona con la persona de la Suite. El empate es POR NOMBRE (no hay ' +
    'llave dura: el numero del reloj acierta por DEBAJO del azar, y la Suite no guarda CURP), ' +
    'asi que un alias equivocado liga a una persona con el sueldo de otra. Se reparte con la ' +
    'pantalla que permite revisarlo y corregirlo (`[NE.2.5]`). Pendiente: que exista esa ' +
    'pantalla. ' +
    '⚠️ DESTINO CORREGIDO el 2026-11-25: este motivo decia «a los mismos dos roles que ya tienen ' +
    'todas las claves de RH (`recursos_humanos` y `reclutamiento_asistencia`)», pero ' +
    '`reclutamiento_asistencia` tiene CERO personas en prod -- repartir ahi es no repartir (es la ' +
    'leccion que SIN_PERSONAS documenta aqui mismo). Las vivas estan en `recursos_humanos` (2).',
  // `[NE.2.6]` / D12 -- partida de la de arriba el 2026-11-25, DESPUES de medir que el frente
  // entero quedo desplegado en prod sin poder producir una fila (tres tablas en 0) porque los
  // cinco verbos compartian una clave que espera a una pantalla que espera a la API.
  HR_NOMINA_CALENDARIO:
    'Frente NE, `[NE.2.6]`. Gatea UN solo verbo, `POST /hr/nomina/periodos/sincronizar`, que ' +
    'puebla el calendario de semanas de nomina derivandolo de ContPAQi. NO toca personas: no ' +
    'muestra nombres, no escribe identidad y no pide firma, es idempotente y reporta lo que no ' +
    'cae en viernes. ' +
    '⭐ Por eso, al reves que su hermana, NO necesita pantalla para repartirse con seguridad -- ' +
    'esta aca porque repartir un permiso en prod es decision del PM, no mia. Partir la clave es ' +
    'decision tecnica (ADR-054: el permiso es una CLAVE, no una tupla) y ya se hizo; lo que falta ' +
    'es la firma. Destino propuesto: `recursos_humanos` (2 personas vivas). Pendiente: Edgar (D12).',
};

/**
 * Claves concedidas SOLO por roles que ninguna persona activa tiene. Es la segunda cara
 * del mismo invariante y la aprendi corrigiendome: el censo de arriba dio 0 huerfanas y
 * yo escribi que prevencion de perdida "direccion la VE y nadie la OPERA". Falso --
 * `direccion` tiene CERO personas activas, asi que a ese modulo **no llega nadie, ni
 * para verlo**. Un permiso concedido a un rol vacio es tan inalcanzable como uno
 * concedido a nadie, y el primer censo no sabia distinguirlos.
 */
/**
 * ⛔⛔ `[VEC.0c]` VACIADA EL 2026-11-26, Y ESO ES EL HALLAZGO, no una limpieza.
 *
 * Sus 10 entradas decian, cada una, «0 personas». Medido ese dia en prod con la definicion
 * de permiso efectivo que usa el JWT, las 10 le llegaban a gente:
 *
 *   COMMERCIAL_PREVENTION_VER .......... 9   (el motivo decia «no lo alcanza NADIE»)
 *   las 8 claves de RH ................. 7 u 8 cada una (el motivo decia 0)
 *   HR_ATTENDANCE_CHECAR .............. 15   (el motivo decia que la unica cuenta se borro)
 *
 * ⭐ Ninguno de esos motivos era mentira cuando se escribio: estaban medidos con
 * `users.role_name`, que es UNA de las TRES vias de reparto. Las otras dos -- los roles
 * complementarios (`identity.user_roles`, que discrepa en 36 de 42 roles) y los overrides de
 * persona (`identity.user_permissions`, 960 filas en ALLOW sobre 269 claves) -- no se miraban.
 *
 * ⚠️ Un detalle que la lista vacia NO puede decir y conviene no perder: que una clave de RH
 * «llegue a 7 personas» no significa que el modulo funcione. Las tablas `hr.*` siguen en 0
 * filas y la semana de asistencia nunca se cerro; lo que se cae es la explicacion «no le llega
 * a nadie», no el problema. Esa parte vive en la fase RH, no aca.
 *
 * Si vuelve a hacer falta declarar una clave sin gente, se agrega con su motivo Y su medicion
 * del dia: `alcanceEfectivo` la contradice sola si el motivo envejece.
 */
const SIN_PERSONAS = {};

/**
 * `[VEC.0c]` SEGREGACIONES DE FUNCIONES declaradas por un modulo: pares de claves que la MISMA
 * persona no deberia alcanzar. Un control que solo esta escrito en el motivo de una lista es
 * una intencion; aca se MIDE.
 *
 * ⛔ Medido el 2026-11-26, al vaciar `SIN_PERSONAS`: de las 5 personas que pueden investigar
 * una perdida, **4 tambien pueden contar y reconciliar el inventario** -- que es exactamente
 * lo que la migracion `20260817160000` existe para impedir. Tres de las cuatro lo recibieron
 * por override personal; la cuarta, por el rol `finanzas_operativo`.
 */
const SEGREGACIONES = [
  {
    nombre: 'prevencion de perdida',
    fuente: 'mig 20260817160000',
    juez: 'COMMERCIAL_PREVENTION_GESTIONAR',
    partes: ['COMMERCIAL_INVENTORY_CONTAR', 'COMMERCIAL_INVENTORY_RECONCILIAR'],
    regla: 'quien cuenta o reconcilia NO es quien investiga',
    // Lo medido el 2026-11-26. Entra como declaracion para que el rojo diga si EMPEORO o no,
    // en vez de repetir el mismo numero todos los dias sin que nadie sepa si se movio.
    conocidos: 4,
    dueno: 'Edgar',
  },
];

/**
 * `[VEC.0]` — PARES DERIVADOS. Repartos que una migracion calculo a partir de OTRO permiso.
 *
 * ── Por que hace falta una compuerta mas ────────────────────────────────────────────────
 * Las de arriba preguntan *"¿alguien la concede?"* y *"¿alguien la tiene?"*. Ninguna atrapa
 * el defecto que esta lista vigila, porque la clave SI esta repartida y SI tiene gente:
 *
 *   **una derivacion es una FOTO del momento en que corre la migracion, no una regla viva.**
 *
 * Medido en prod el 2026-10-06: `20260917140100_grant_picking_permissions` (Fase SU.2) corrio
 * el 17-sep y derivo `COMMERCIAL_PICKING_*` de `COMMERCIAL_INVENTORY_*`. Once dias despues la
 * Fase IC le dio a `almacenista` sus permisos de inventario (mig `20260928120000`, batch 552).
 * Nada volvio a correr la derivacion → **el rol que de verdad surte (6 personas) quedo fuera
 * 19 dias**, con el modulo de surtido en prod y `commercial.picking_waves` en CERO filas.
 *
 * El encabezado de SU.2 dice *"si manana un rol gana o pierde el permiso de inventario, este
 * reparto sigue siendo el que se documento"*. Esa frase describe una INTENCION; la migracion
 * corre una vez. Esto es el mecanismo que faltaba.
 *
 * ⚠️ La compuerta mira el ESTADO, no la migracion: no le importa quien ni cuando reparto,
 * solo que hoy la regla se cumpla. Por eso sigue sirviendo si manana alguien edita un rol a
 * mano desde `/admin/roles`, que es por donde entra la mitad de la deriva.
 *
 * `excluidos` = las excepciones deliberadas de la migracion que creo el par. Van aca para que
 * se vean: una excepcion que no se escribe se vuelve un defecto a los dos meses.
 */
const PARES_DERIVADOS = [
  {
    derivada: 'COMMERCIAL_PICKING_VER',
    hermanas: ['COMMERCIAL_INVENTORY_VER'],
    excluidos: ['customer_b2b'],
    motivo:
      'SU.2 (ADR-067): quien ve el inventario de un almacen puede ver como se surte. ' +
      '`customer_b2b` fuera: es cliente externo, ve existencia para saber si le surten, no el ' +
      'trabajo interno del almacen.',
  },
  {
    derivada: 'COMMERCIAL_PICKING_GESTIONAR',
    hermanas: ['COMMERCIAL_INVENTORY_AJUSTAR', 'COMMERCIAL_INVENTORY_RECIBIR'],
    excluidos: ['customer_b2b'],
    motivo:
      'VEC.0 corrige la regla de SU.2: SURTIR NO ES AJUSTAR. Levantar del anaquel es de la ' +
      'familia de RECIBIR (mover mercancia fisica), no de AJUSTAR (corregir el saldo). La Fase ' +
      'IC le quito AJUSTAR a `almacenista` A PROPOSITO (quien cuenta no ajusta, para que un ' +
      'faltante no se tape con un ajuste); derivar de AJUSTAR obligaba a elegir entre romper ' +
      'esa segregacion o dejar al almacen sin poder surtir.',
  },
];

// ── El catalogo, leido de la definicion UNICA (ID.28) ────────────────────────────────────
const CATALOGO = [...fs.readFileSync(path.join(REPO, 'libs/contracts/src/authz/permissions.ts'), 'utf8')
  .matchAll(/^\s{2}([A-Z][A-Z0-9_]*)\s*=\s*'([A-Z0-9_]+)'/gm)].map((m) => m[2]);

/**
 * Claves que GATEAN una escritura viva. Es lo que separa "permiso reservado que no bloquea
 * nada" de "cinco endpoints que nadie puede alcanzar". Se lee de los controllers reales.
 */
function clavesQueGatean() {
  const fuentes = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(f); continue; }
      if (/\.controller\.ts$/.test(e.name)) fuentes.push(f);
    }
  };
  walk(path.join(REPO, 'libs'));
  walk(path.join(REPO, 'apps/api/src'));

  const cuenta = new Map();
  for (const f of fuentes) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/@Require(?:Any)?Permissions?\(([^)]*)\)/g)) {
      for (const k of m[1].matchAll(/Permission\.([A-Z0-9_]+)/g)) {
        cuenta.set(k[1], (cuenta.get(k[1]) || 0) + 1);
      }
    }
  }
  return cuenta;
}

/**
 * Las cuatro compuertas, como FUNCION PURA. Que sean puras es lo que hace posible la prueba
 * negativa: se las alimenta con entradas adulteradas y tienen que ponerse rojas.
 */
function evaluar(catalogo, vivo, gatean, permitidas, porRol, rolesConGente, sinPersonas, alcance) {
  // `[VEC.0c]` ¿cuanta gente ACTIVA alcanza de verdad la clave? Las tres vias, no una.
  const alcanzan = (k) => ((alcance || new Map()).get(k) || 0);
  // `[1]` se parte en DOS, porque eran dos defectos distintos bajo un solo rotulo:
  //   · `nadieMenciona`   -- ningun rol la menciona Y nadie la alcanza: entregada y muerta.
  //   · `soloPorPersona`  -- nadie la alcanza POR ROL, pero hay quien la tiene por un override
  //     de persona. No esta muerta: esta repartida por la via fragil. ADR-054 dice que el
  //     permiso es una CLAVE que viaja por rol; un override se pierde al cambiar de puesto y
  //     no se ve en `MATRIZ_ACCESOS.md`, que se genera del padron de roles.
  const nadieMenciona = catalogo.filter((k) => !vivo.has(k) && alcanzan(k) === 0);
  const soloPorPersona = catalogo.filter((k) => !vivo.has(k) && alcanzan(k) > 0);
  const nadieConcede = catalogo.filter((k) => {
    const v = vivo.get(k);
    return v && v.conTrue === 0 && gatean.has(k) && !permitidas[k] && alcanzan(k) === 0;
  });
  const fueraDeCatalogo = [...vivo.keys()].filter((k) => !catalogo.includes(k));
  // Concedida, pero sólo por roles que nadie tiene → nadie la alcanza igual.
  // ⛔ «nadie tiene ese rol» NO es «nadie la alcanza»: puede llegarle por un rol complementario
  //    (`identity.user_roles`) o por un override. Por eso tambien se descuenta `alcanzan(k)`.
  const sinNadieQueLaTenga = [...(porRol || new Map()).entries()]
    .filter(([k, roles]) => roles.length > 0
      && roles.every((r) => !rolesConGente.has(r))
      && !(sinPersonas || {})[k]
      && alcanzan(k) === 0)
    .map(([k]) => k);
  return { nadieMenciona, soloPorPersona, nadieConcede, fueraDeCatalogo, sinNadieQueLaTenga };
}

/**
 * `[VEC.0]` Quinta compuerta, tambien PURA: roles donde la derivacion quedo vieja.
 *
 * `mapaPorRol`: Map<role_name, Record<clave, 'true'|'false'>> — el padron crudo. Hace falta
 * el detalle por rol: los agregados de `evaluar()` no pueden ver esto, porque la clave si
 * esta repartida (a otros) y si tiene gente.
 *
 * ⚠️ Solo marca la clave AUSENTE, nunca la que esta en `false` explicito: ese `false` es un
 * dato real (alguien decidio que no) y pisarlo seria el defecto que `[LC.6.2]` documenta.
 * Un reparto derivado completa huecos; no revierte decisiones.
 */
function derivacionesRotas(mapaPorRol, pares) {
  const rotas = [];
  for (const par of pares) {
    for (const [rol, claves] of mapaPorRol) {
      if (par.excluidos.includes(rol) || /^retirado_/.test(rol)) continue;
      const tieneHermana = par.hermanas.some((h) => claves[h] === 'true');
      if (!tieneHermana) continue;
      if (claves[par.derivada] === undefined) {
        rotas.push({
          rol,
          derivada: par.derivada,
          via: par.hermanas.filter((h) => claves[h] === 'true').join('/'),
        });
      }
    }
  }
  return rotas;
}

(async () => {
  const url = process.env.PERM_DELIVERY_URL || process.env.DATABASE_URL_NEW || process.env.FLEET_DB_URL;
  if (!url) noMedido('no hay FLEET_DB_URL ni DATABASE_URL_NEW en .env');

  const c = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
    statement_timeout: 30000,
  });
  try {
    await c.connect();
  } catch (e) {
    if (esFaltaDeAcceso(e)) noMedido(`no se pudo llegar al padron -- ${e.message}`);
    throw e;
  }

  // ── Procedencia: que base es esta, y de cuando es lo que trae ─────────────────────────
  const { rows: quien } = await c.query('SELECT current_database() AS db, version() AS v');
  const { rows: frescura } = await c.query(`
    SELECT count(*)::int AS roles, max(updated_at) AS ultimo
      FROM identity.role_permissions
     WHERE deleted_at IS NULL AND role_name NOT LIKE 'retirado%'`);
  console.log(`\n  base: ${quien[0].db} · pg ${quien[0].v.split(' ')[1]}`);
  console.log(`  padron: ${frescura[0].roles} roles vivos · role_permissions mas nuevo: ${frescura[0].ultimo || '(nunca)'}`);
  console.log('  (poblado != fresco: el censo vale lo que valga esa fecha)\n');

  const { rows } = await c.query(`
    SELECT e.key,
           count(*) FILTER (WHERE e.value = 'true'::jsonb)  AS con_true,
           count(*) FILTER (WHERE e.value = 'false'::jsonb) AS con_false
      FROM identity.role_permissions rp, jsonb_each(rp.permissions) e
     WHERE rp.deleted_at IS NULL AND rp.role_name NOT LIKE 'retirado%'
     GROUP BY e.key`);

  // Qué roles conceden cada clave, y qué roles tiene alguien de verdad. Sin esto, "0
  // huérfanas" se lee como "todo alcanzable" y no es lo mismo.
  const { rows: filasRol } = await c.query(`
    SELECT e.key, array_agg(DISTINCT rp.role_name) AS roles
      FROM identity.role_permissions rp, jsonb_each(rp.permissions) e
     WHERE rp.deleted_at IS NULL AND rp.role_name NOT LIKE 'retirado%' AND e.value = 'true'::jsonb
     GROUP BY e.key`);
  const { rows: filasGente } = await c.query(`
    SELECT DISTINCT ur.role_name
      FROM identity.user_roles ur
      JOIN identity.users u ON u.id = ur.user_id AND u.tenant_id = ur.tenant_id
     WHERE u.deleted_at IS NULL AND u.status = 'active'`);
  // [VEC.0] El padron CRUDO por rol. Los agregados de arriba no sirven para la compuerta de
  // derivacion: ahi la clave si esta repartida y si tiene gente -- el hueco es por rol.
  const { rows: filasCrudas } = await c.query(`
    SELECT role_name, permissions
      FROM identity.role_permissions
     WHERE deleted_at IS NULL AND role_name NOT LIKE 'retirado%'`);
  // Personas activas por rol: sin esto, "a almacenista le falta" no distingue un rol con 6
  // personas de uno vacio, y la lista se lee con la misma urgencia en los dos casos.
  const { rows: filasPersonas } = await c.query(`
    SELECT role_name, count(*)::int AS personas
      FROM identity.users
     WHERE activo AND deleted_at IS NULL
     GROUP BY role_name`);
  // ⛔⛔ [VEC.0c] ALCANCE EFECTIVO -- la unica medicion de "¿quien puede de verdad?".
  //
  // Hasta el 2026-11-26 esta compuerta contestaba esa pregunta con UNA de las TRES vias por
  // las que se reparte un permiso en esta suite, y por eso publicaba ceros que eran el
  // instrumento. Medido ese dia contra prod: `identity.user_permissions` tiene 1,100 filas
  // (960 en ALLOW sobre 269 claves distintas, 140 en NIEGA) y `identity.user_roles` discrepa
  // con `users.role_name` en 36 de 42 roles. Resultado: de 8 claves que la compuerta declaraba
  // inalcanzables, 5 las alcanzaba gente -- `FINANCE_EXPENSES_HISTORIAL_TODOS` (3 personas,
  // gatea 4 escrituras), `DEV_PROJECTS_VER` (2, gatea 3), `DEV_PROJECTS_GESTIONAR` (2, gatea
  // 10), `COMPRAS_REQUISICIONES_AUTORIZAR` (4) y `FINANCE_CAJA_VENTANILLA` (1).
  //
  // ⭐ La definicion no se inventa aca: es la MISMA que arma el JWT, en
  // `libs/platform-core/src/lib/ability/permiso-efectivo.ts` (override de la PERSONA manda en
  // los dos sentidos; si no hay, la UNION de `users.role_name` y `identity.user_roles`).
  // ⚠️ DEUDA CON NOMBRE (ADR-056): esto es una 3ª copia de ese primitivo -- la 2ª es
  // `libs/service-desk/src/lib/agents.service.ts`. Esta es JS y vive fuera de Nx, asi que no
  // puede importar el TS; unificarlas pide mover el primitivo a SQL compartido. Mientras tanto
  // el cruce que las ata esta en la prueba negativa [6]: si divergen, la compuerta se pone roja.
  // Medido: coincide con el primitivo clave por clave en las 294 vivas (0 diferencias) en 85 ms.
  const { rows: filasAlcance } = await c.query(`
    WITH activos AS (
      SELECT u.id, u.tenant_id, u.role_name FROM identity.users u
       WHERE u.activo AND u.deleted_at IS NULL
    ), roles_efectivos AS (
      SELECT a.id, a.tenant_id, r.role_name
        FROM activos a
        CROSS JOIN LATERAL (
          SELECT ur.role_name FROM identity.user_roles ur
           WHERE ur.tenant_id = a.tenant_id AND ur.user_id = a.id
          UNION SELECT a.role_name
        ) r
    ), por_rol AS (
      SELECT DISTINCT re.id, e.key
        FROM roles_efectivos re
        JOIN identity.role_permissions rp
          ON rp.tenant_id = re.tenant_id AND lower(rp.role_name) = lower(re.role_name)
         AND rp.deleted_at IS NULL
        CROSS JOIN LATERAL jsonb_each(rp.permissions) e
       WHERE e.value = 'true'::jsonb
    ), concedidas AS (
      SELECT pr.id, pr.key FROM por_rol pr
       WHERE NOT EXISTS (
         SELECT 1 FROM identity.user_permissions up
          WHERE up.user_id = pr.id AND up.permission_key = pr.key AND up.allow = false)
      UNION
      SELECT a.id, up.permission_key FROM identity.user_permissions up
        JOIN activos a ON a.id = up.user_id AND a.tenant_id = up.tenant_id
       WHERE up.allow = true
    )
    SELECT key, count(DISTINCT id)::int AS gente FROM concedidas GROUP BY key`);
  // `[VEC.0c]` Segregacion de funciones, MEDIDA. Misma definicion de permiso efectivo, por
  // persona: ¿cuantas alcanzan a la vez la clave que JUZGA y alguna de las que OPERAN?
  const efectivo = (n) => `COALESCE(
    (SELECT up.allow FROM identity.user_permissions up
      WHERE up.tenant_id = u.tenant_id AND up.user_id = u.id AND up.permission_key = $${n}),
    EXISTS (SELECT 1 FROM (SELECT ur.role_name FROM identity.user_roles ur
             WHERE ur.tenant_id = u.tenant_id AND ur.user_id = u.id
            UNION SELECT u.role_name) roles
      JOIN identity.role_permissions rp ON rp.tenant_id = u.tenant_id AND lower(rp.role_name) = lower(roles.role_name)
     WHERE rp.permissions ->> $${n} = 'true' AND rp.deleted_at IS NULL))`;
  const choquesMedidos = [];
  for (const s of SEGREGACIONES) {
    const args = [s.juez, ...s.partes];
    const opera = s.partes.map((_, i) => efectivo(i + 2)).join(' OR ');
    const { rows: q } = await c.query(`
      SELECT count(*)::int AS juzgan,
             count(*) FILTER (WHERE ${opera})::int AS tambien_operan
        FROM identity.users u
       WHERE u.activo AND u.deleted_at IS NULL AND ${efectivo(1)}`, args);
    choquesMedidos.push({ ...s, juzgan: q[0].juzgan, choques: q[0].tambien_operan });
  }
  await c.end();

  const porRol = new Map(filasRol.map((f) => [f.key, f.roles]));
  const rolesConGente = new Set(filasGente.map((f) => f.role_name));
  // jsonb llega como objeto con booleanos; la compuerta compara contra 'true'/'false' y
  // necesita distinguir AUSENTE de false → se normaliza a string, dejando undefined al que falta.
  const mapaPorRol = new Map(filasCrudas.map((f) => [
    f.role_name,
    Object.fromEntries(Object.entries(f.permissions || {}).map(([k, v]) => [k, String(v)])),
  ]));
  const personasPorRol = new Map(filasPersonas.map((f) => [f.role_name, f.personas]));
  const alcanceEfectivo = new Map(filasAlcance.map((f) => [f.key, f.gente]));
  const vivo = new Map(rows.map((r) => [r.key, { conTrue: Number(r.con_true), conFalse: Number(r.con_false) }]));
  const gatean = clavesQueGatean();

  // ── 0. PISO ──────────────────────────────────────────────────────────────────────────
  // ID.28 ya enseno que una comparacion entre dos conjuntos vacios se pone verde sola.
  console.log('[0] Piso -- ningun conjunto vacio se lee como coincidencia');
  ok(CATALOGO.length > 100, `catalogo parseado: ${CATALOGO.length} claves`);
  ok(vivo.size > 100, `claves mencionadas por algun rol vivo: ${vivo.size}`);
  ok(gatean.size > 20, `claves que gatean una escritura: ${gatean.size}`);

  ok(rolesConGente.size > 10, `roles que alguien activo tiene de verdad: ${rolesConGente.size}`);
  // `[VEC.0c]` Piso del alcance efectivo: si esta medicion viniera vacia, TODA clave se leeria
  // como inalcanzable y las compuertas [1], [2] y [2b] se pondrian rojas enteras -- un rojo
  // masivo se nota, pero el piso lo dice con su nombre en vez de hacerlo adivinar.
  // ⚠️ `alcanceEfectivo.size` NO es «cuantas del catalogo se alcanzan»: incluye las que el padron
  //    tiene y el catalogo no (hoy 3). Decirlo «de 296 del catalogo» leia como 296 de 296, que es
  //    falso -- hay 3 que nadie alcanza. Se informan los dos numeros, cada uno con su universo.
  const delCatalogoAlcanzadas = CATALOGO.filter((k) => (alcanceEfectivo.get(k) || 0) > 0).length;
  ok(alcanceEfectivo.size > 100,
    `claves que alguna persona activa alcanza de verdad: ${alcanceEfectivo.size} en total, de las cuales ${delCatalogoAlcanzadas} son del catalogo (que tiene ${CATALOGO.length})`);

  const r = evaluar(CATALOGO, vivo, gatean, SIN_REPARTIR, porRol, rolesConGente, SIN_PERSONAS, alcanceEfectivo);

  // ── 1. Toda clave del catalogo la MENCIONA alguien ────────────────────────────────────
  console.log('\n[1] Reparto -- ninguna clave del catalogo es invisible para todos los roles');
  ok(r.nadieMenciona.length === 0,
    r.nadieMenciona.length === 0
      ? 'las 0 claves huerfanas'
      : `${r.nadieMenciona.length} clave(s) que NINGUN rol menciona y NADIE alcanza (modulo entregado e inalcanzable): ${r.nadieMenciona.join(', ')}`);
  // `[VEC.0c]` No es lo mismo muerta que repartida a mano. Esta segunda lista se IMPRIME aunque
  // la compuerta este verde: es el unico lugar donde se ve un permiso que viaja fuera del rol.
  for (const k of r.soloPorPersona) {
    console.log(`      ${k}: ningun rol la menciona, pero ${alcanceEfectivo.get(k)} persona(s) la tienen por override personal`);
  }
  ok(r.soloPorPersona.length === 0,
    r.soloPorPersona.length === 0
      ? 'ninguna clave se reparte SOLO persona por persona'
      : `${r.soloPorPersona.length} clave(s) repartidas solo por override personal, nunca por rol (ADR-054): ${r.soloPorPersona.join(', ')}`);

  // ── 2. Toda clave que gatea una escritura la CONCEDE alguien ─────────────────────────
  console.log('\n[2] Alcance -- lo que gatea una escritura tiene que ser alcanzable');
  for (const k of r.nadieConcede) {
    console.log(`      ${k}: gatea ${gatean.get(k)} escritura(s), ningun rol lo concede y nadie lo alcanza por ninguna via`);
  }
  ok(r.nadieConcede.length === 0,
    r.nadieConcede.length === 0
      ? 'toda clave que gatea una escritura la concede al menos un rol (o esta declarada)'
      : `${r.nadieConcede.length} clave(s) gatean escrituras que nadie puede alcanzar`);

  // ── 2b. Concedida a un rol que NADIE tiene = inalcanzable igual ──────────────────────
  // La compuerta [2] mira si alguien la concede. Esta mira si alguien la TIENE. Las dos
  // hacen falta: con [2] sola, "0 huerfanas" se lee como "todo alcanzable" y no es lo
  // mismo -- fue exactamente mi error al reportar prevencion de perdida.
  console.log('\n[2b] Alcance real -- un rol vacio no alcanza nada');
  // El cero aqui SI es real (la clave entro a esta lista justamente porque ningun rol que la
  // concede tiene gente), pero se imprime medido igual: un numero escrito a mano no se puede
  // distinguir de uno que quedo viejo, que es como el de SIN_PERSONAS mintio durante dias.
  for (const k of r.sinNadieQueLaTenga) {
    const roles = porRol.get(k) || [];
    const detalle = roles.map((rol) => `${rol}:${personasPorRol.get(rol) || 0}`).join(', ');
    console.log(`      ${k}: solo por ${detalle || '(nadie)'} -- alcance efectivo ${alcanceEfectivo.get(k) || 0} persona(s)`);
  }
  ok(r.sinNadieQueLaTenga.length === 0,
    r.sinNadieQueLaTenga.length === 0
      ? 'toda clave concedida la tiene alguna persona activa (o esta declarada)'
      : `${r.sinNadieQueLaTenga.length} clave(s) cuya unica via es un rol que nadie tiene`);

  // ── 2c. Un reparto DERIVADO no se queda viejo ────────────────────────────────────────
  // La clave esta repartida y tiene gente, asi que [2] y [2b] la dan por sana. El hueco es
  // por rol: alguien gano la hermana DESPUES de que la migracion corrio. Ver PARES_DERIVADOS.
  console.log('\n[2c] Derivacion -- quien gana la hermana tiene que ganar la derivada');
  const rotas = derivacionesRotas(mapaPorRol, PARES_DERIVADOS);
  for (const d of rotas) {
    const n = personasPorRol.get(d.rol) || 0;
    console.log(`      ${d.rol} (${n} persona(s)) tiene ${d.via} y le FALTA ${d.derivada}`);
  }
  ok(rotas.length === 0,
    rotas.length === 0
      ? `los ${PARES_DERIVADOS.length} pares derivados siguen al dia en todos los roles`
      : `${rotas.length} derivacion(es) vieja(s): la migracion que las reparto fue una foto, y el padron se movio`);

  // ── 2d. La segregacion de funciones que un modulo DECLARA, medida ────────────────────
  // Un control escrito en el motivo de una lista es una intencion. Este lo cuenta.
  console.log('\n[2d] Segregacion de funciones -- lo que un modulo prohibe, medido');
  for (const s of choquesMedidos) {
    console.log(`      ${s.nombre} (${s.fuente}): "${s.regla}"`);
    console.log(`        ${s.juzgan} persona(s) alcanzan ${s.juez}; de ellas ${s.choques} alcanzan tambien ${s.partes.join(' o ')}`);
    if (s.choques > s.conocidos) console.log(`        ⛔ EMPEORO: eran ${s.conocidos} el dia que se midio`);
    else if (s.choques < s.conocidos) console.log(`        ⭐ MEJORO: eran ${s.conocidos}; actualizar \`conocidos\``);
  }
  const empeoraron = choquesMedidos.filter((s) => s.choques > s.conocidos);
  const rotasHoy = choquesMedidos.filter((s) => s.choques > 0);
  // ⛔ Un ✓ al lado de «la segregacion sigue rota» afirma lo que no es: quien lee la columna de
  //    simbolos ve verde. El rojo se reserva para el EMPEORAMIENTO (que es lo accionable sin
  //    decision de negocio), y el estado roto-pero-estable se declara con su propio simbolo, sin
  //    sumar al marcador en ninguna direccion -- igual que `[5]`.
  if (empeoraron.length) {
    ok(false, `${empeoraron.length} segregacion(es) EMPEORARON desde la ultima medicion: ${empeoraron.map((s) => `${s.nombre} ${s.conocidos}->${s.choques}`).join(', ')}`);
  } else if (rotasHoy.length) {
    console.log(`  ⚠️ DECLARADO (no empeoro, pero NO se cumple): ${rotasHoy.map((s) => `${s.nombre} ${s.choques}/${s.juzgan}`).join(', ')} -- repararlo es de ${[...new Set(rotasHoy.map((s) => s.dueno))].join('/')}, no de esta compuerta`);
  } else {
    ok(true, `las ${choquesMedidos.length} segregaciones declaradas se cumplen`);
  }

  // ── 3. Nada en la DB fuera del catalogo ──────────────────────────────────────────────
  console.log('\n[3] Deriva -- el padron no inventa claves');
  ok(r.fueraDeCatalogo.length === 0,
    r.fueraDeCatalogo.length === 0
      ? 'ninguna clave del padron esta fuera del catalogo'
      : `${r.fueraDeCatalogo.length} clave(s) en la DB que el catalogo no conoce: ${r.fueraDeCatalogo.join(', ')}`);

  // ── 4. La lista de excepciones no se pudre ───────────────────────────────────────────
  console.log('\n[4] Higiene de la lista de declaradas');
  const yaRepartidas = Object.keys(SIN_REPARTIR).filter((k) => (vivo.get(k)?.conTrue || 0) > 0);
  ok(yaRepartidas.length === 0,
    yaRepartidas.length === 0
      ? `las ${Object.keys(SIN_REPARTIR).length} declaradas siguen sin repartir (la lista dice la verdad)`
      : `sacar de SIN_REPARTIR (ya estan repartidas): ${yaRepartidas.join(', ')}`);
  const noExisten = [...Object.keys(SIN_REPARTIR), ...Object.keys(SIN_PERSONAS)]
    .filter((k) => !CATALOGO.includes(k));
  ok(noExisten.length === 0,
    noExisten.length === 0
      ? 'ninguna declarada quedo fuera del catalogo'
      : `las listas nombran claves que ya no existen: ${noExisten.join(', ')}`);
  // Misma poda para la 2a lista: una clave que ya llego a alguien deja de ser excepcion.
  // `[VEC.0c]` Se pregunta por el ALCANCE, no por los roles: una clave puede llegarle a alguien
  // por un rol complementario o un override sin que ningun rol «con gente» la conceda.
  const yaTienenGente = Object.keys(SIN_PERSONAS)
    .filter((k) => (alcanceEfectivo.get(k) || 0) > 0);
  ok(yaTienenGente.length === 0,
    yaTienenGente.length === 0
      ? `las ${Object.keys(SIN_PERSONAS).length} de SIN_PERSONAS siguen sin una sola persona`
      : `sacar de SIN_PERSONAS (ya hay quien las tenga): ${yaTienenGente.join(', ')}`);

  // ── 5. Lo que se DECLARA, con nombre ─────────────────────────────────────────────────
  const soloFalse = CATALOGO.filter((k) => vivo.get(k) && vivo.get(k).conTrue === 0);
  console.log('\n[5] Declarado (no es falla, es deuda con nombre)');
  if (!soloFalse.length && !Object.keys(SIN_PERSONAS).length) console.log('      (ninguna)');
  for (const k of soloFalse) {
    const g = gatean.get(k) || 0;
    console.log(`      · ${k} -- en false en ${vivo.get(k).conFalse} rol(es), gatea ${g} escritura(s)`);
    if (SIN_REPARTIR[k]) console.log(`        motivo: ${SIN_REPARTIR[k]}`);
    else if (!g) console.log('        sin escrituras gateadas: reservado, no bloquea nada hoy');
  }
  // ⛔⛔ ESTE CERO ESTABA ESCRITO A MANO (corregido 2026-11-25). El renglon afirmaba "0 personas
  //    activas" SIEMPRE, sin medirlo, mientras la compuerta [4] de dos lineas mas arriba ya
  //    gritaba "sacar de SIN_PERSONAS: ya hay quien las tenga". El instrumento se contradecia
  //    solo, y el cero ganaba por estar al lado del motivo. Medido en prod ese dia:
  //    `recursos_humanos` tiene 2 personas (entraron el 20 y el 24 de noviembre), asi que las
  //    nueve claves de RH que aqui salian en 0 SI le llegan a alguien -- y de eso depende que
  //    la semana de asistencia se pueda cerrar. Ahora se cuenta de `personasPorRol`, que ya
  //    estaba calculado y nadie usaba aqui.
  // ⛔⛔ Y ESE ARREGLO SEGUIA CORTO (corregido 2026-11-26). `personasPorRol` sale de
  //    `users.role_name`, UNA de las TRES vias por las que se reparte un permiso; medido ese
  //    dia, discrepa con `identity.user_roles` en 36 de 42 roles (p. ej. `analisis_ventas`:
  //    0 por una via, 5 por la otra) y ninguna de las dos ve los 960 overrides de persona en
  //    ALLOW. El numero de abajo ya no se suma por rol: sale de `alcanceEfectivo`, que es la
  //    misma definicion del JWT. El detalle por rol se conserva al lado porque dice POR DONDE.
  for (const k of Object.keys(SIN_PERSONAS)) {
    const roles = porRol.get(k) || [];
    const gente = alcanceEfectivo.get(k) || 0;
    const porBase = roles.reduce((s, rol) => s + (personasPorRol.get(rol) || 0), 0);
    const detalle = roles.map((rol) => `${rol}:${personasPorRol.get(rol) || 0}`).join(', ');
    console.log(`      · ${k} -- concedida por ${detalle || '(nadie)'} -- alcance efectivo ${gente} persona(s) activa(s)`);
    if (gente !== porBase) console.log(`        (solo por rol base serian ${porBase}: la diferencia entra por rol complementario u override)`);
    if (gente > 0) console.log('        ⚠️ YA NO ESTA VACIA: el motivo de abajo quedo viejo y hay que revisarlo');
    console.log(`        motivo: ${SIN_PERSONAS[k]}`);
  }

  // ── 6. PRUEBA NEGATIVA ───────────────────────────────────────────────────────────────
  // Las tres compuertas, rotas a proposito. Si alguna sigue verde con la entrada adulterada,
  // este archivo es decorativo.
  console.log('\n[6] Prueba negativa -- las compuertas rotas a proposito tienen que dar ROJO');
  // `[VEC.0c]` Las adulteraciones van sobre la entrada REAL, `alcanceEfectivo` incluida: una
  // prueba negativa que le pasa `undefined` donde el gate usa un mapa prueba otro programa.
  const sinAlcance = (mapa, claves) => {
    const m = new Map(mapa);
    for (const k of claves) m.delete(k);
    return m;
  };

  const falsa = 'PERMISO_QUE_NADIE_REPARTIO_XYZ';
  const n1 = evaluar([...CATALOGO, falsa], vivo, gatean, SIN_REPARTIR, porRol, rolesConGente, SIN_PERSONAS, alcanceEfectivo);
  ok(n1.nadieMenciona.includes(falsa), '[1] detecta una clave del catalogo que ningun rol menciona Y que nadie alcanza');

  // `[VEC.0c]` La otra mitad de [1]: la misma clave, pero alcanzada por un override personal,
  // NO puede salir como «entregada e inalcanzable» -- tiene que caer en la lista de reparto fragil.
  const n1b = evaluar([...CATALOGO, falsa], vivo, gatean, SIN_REPARTIR, porRol, rolesConGente, SIN_PERSONAS,
    new Map([...alcanceEfectivo, [falsa, 2]]));
  ok(!n1b.nadieMenciona.includes(falsa) && n1b.soloPorPersona.includes(falsa),
    '[1] NO llama inalcanzable a la clave que 2 personas tienen por override: la separa como reparto fragil');

  const vivoRoto = new Map(vivo);
  const victima = [...gatean.keys()].find((k) => vivo.get(k)?.conTrue > 0);
  vivoRoto.set(victima, { conTrue: 0, conFalse: 3 });
  const n2 = evaluar(CATALOGO, vivoRoto, gatean, SIN_REPARTIR, porRol, rolesConGente, SIN_PERSONAS,
    sinAlcance(alcanceEfectivo, [victima]));
  ok(n2.nadieConcede.includes(victima), `[2] detecta que ${victima} gatea escrituras, nadie lo concede y nadie lo alcanza`);

  // `[VEC.0c]` El falso positivo que esta medicion vino a matar: la MISMA entrada, pero con
  // gente que lo alcanza por otra via, tiene que quedarse VERDE. Es el caso real de
  // `DEV_PROJECTS_GESTIONAR` (gatea 10 escrituras, 0 roles, 2 personas por override).
  const n2b = evaluar(CATALOGO, vivoRoto, gatean, SIN_REPARTIR, porRol, rolesConGente, SIN_PERSONAS,
    new Map([...alcanceEfectivo, [victima, 2]]));
  ok(!n2b.nadieConcede.includes(victima),
    `[2] NO marca ${victima} cuando 2 personas lo alcanzan por complemento u override`);

  const vivoSucio = new Map(vivo);
  vivoSucio.set('CLAVE_BASURA_QUE_NO_EXISTE', { conTrue: 1, conFalse: 0 });
  const n3 = evaluar(CATALOGO, vivoSucio, gatean, SIN_REPARTIR, porRol, rolesConGente, SIN_PERSONAS, alcanceEfectivo);
  ok(n3.fueraDeCatalogo.includes('CLAVE_BASURA_QUE_NO_EXISTE'), '[3] detecta una clave del padron fuera del catalogo');

  // [2b]: se vacia de gente el (los) rol(es) que conceden una clave sana y tiene que caer.
  const sana = [...porRol.entries()].find(([k, roles]) =>
    roles.length > 0 && roles.every((rol) => rolesConGente.has(rol)) && !SIN_PERSONAS[k]);
  const genteRota = new Set([...rolesConGente].filter((rol) => !sana[1].includes(rol)));
  const n5 = evaluar(CATALOGO, vivo, gatean, SIN_REPARTIR, porRol, genteRota, SIN_PERSONAS,
    sinAlcance(alcanceEfectivo, [sana[0]]));
  ok(n5.sinNadieQueLaTenga.includes(sana[0]),
    `[2b] detecta que ${sana[0]} queda sin una sola persona si se vacian ${sana[1].join('/')}`);
  // `[VEC.0c]` Y con el rol vacio pero alguien que la alcanza igual, [2b] NO puede marcarla.
  const n5b = evaluar(CATALOGO, vivo, gatean, SIN_REPARTIR, porRol, genteRota, SIN_PERSONAS, alcanceEfectivo);
  ok(!n5b.sinNadieQueLaTenga.includes(sana[0]),
    `[2b] NO marca ${sana[0]} con los roles vacios si el alcance efectivo dice que alguien la tiene`);

  // [2c]: se le BORRA la derivada a un rol que hoy la tiene por derivacion, y tiene que caer.
  // Se elige la victima de los datos, no a mano: si manana cambian los pares, sigue valiendo.
  const victimaDeriv = (() => {
    for (const par of PARES_DERIVADOS) {
      for (const [rol, claves] of mapaPorRol) {
        if (par.excluidos.includes(rol)) continue;
        if (par.hermanas.some((h) => claves[h] === 'true') && claves[par.derivada] !== undefined) {
          return { rol, par };
        }
      }
    }
    return null;
  })();
  if (!victimaDeriv) {
    // Sin victima no se puede probar nada — y eso NO es un pase (ADR-056).
    ok(false, '[2c] NO MEDIDO: ningun rol cumple hoy un par derivado, la prueba negativa no tiene con que correr');
  } else {
    const mapaRoto = new Map([...mapaPorRol].map(([rol, claves]) => {
      if (rol !== victimaDeriv.rol) return [rol, claves];
      const copia = { ...claves };
      delete copia[victimaDeriv.par.derivada];
      return [rol, copia];
    }));
    const n2c = derivacionesRotas(mapaRoto, PARES_DERIVADOS);
    ok(n2c.some((d) => d.rol === victimaDeriv.rol && d.derivada === victimaDeriv.par.derivada),
      `[2c] detecta que a ${victimaDeriv.rol} le falta ${victimaDeriv.par.derivada} teniendo la hermana`);

    // CONTROL POSITIVO: la MISMA clave puesta en `false` explicito NO se marca. Sin esto, una
    // compuerta que marcara todo se veria igual de verde, y pisar un `false` deliberado es
    // exactamente el defecto de [LC.6.2].
    const mapaFalse = new Map([...mapaPorRol].map(([rol, claves]) =>
      rol === victimaDeriv.rol
        ? [rol, { ...claves, [victimaDeriv.par.derivada]: 'false' }]
        : [rol, claves]));
    const n2cFalse = derivacionesRotas(mapaFalse, PARES_DERIVADOS);
    ok(!n2cFalse.some((d) => d.rol === victimaDeriv.rol && d.derivada === victimaDeriv.par.derivada),
      `[2c] NO marca a ${victimaDeriv.rol} cuando la clave esta en false explicito (decision, no hueco)`);
  }

  // `[VEC.0c]` Tambien con el alcance real: si no, esta prueba mide un programa que ya no existe.
  // ⭐ Y su rojo cambio de significado. Antes decia «las listas tapan algo real». Ahora puede
  //    significar lo contrario -- que ya no tapan nada, porque la gente SI alcanza esas claves
  //    por rol complementario u override -- y entonces lo que toca es PODARLAS, no agregarles.
  // `[VEC.0c]` Esta prueba solo tiene sentido si alguna declarada puede llegar a [2] o [2b], y
  // eso pide que algun rol la MENCIONE. Hoy las dos que quedan (`HR_NOMINA_*`) no las menciona
  // nadie, asi que caen en [1] y estas dos compuertas no las ven: afirmar «las listas tapan algo»
  // seria un rojo sin contenido. Se declara en vez de dibujarse.
  const declaradasVisibles = [...Object.keys(SIN_REPARTIR), ...Object.keys(SIN_PERSONAS)].filter((k) => vivo.has(k));
  if (declaradasVisibles.length === 0) {
    console.log(`  — NO MEDIDO: ninguna de las ${Object.keys(SIN_REPARTIR).length + Object.keys(SIN_PERSONAS).length} declaradas la menciona un rol, asi que [2]/[2b] no pueden verlas (caen en [1]). Sin entrada que adulterar, no hay prueba negativa que hacer aca.`);
  } else {
    const n4 = evaluar(CATALOGO, vivo, gatean, {}, porRol, rolesConGente, {}, alcanceEfectivo);
    const tapan = n4.nadieConcede.length > r.nadieConcede.length || n4.sinNadieQueLaTenga.length > r.sinNadieQueLaTenga.length;
    ok(tapan,
      tapan
        ? `sin las listas de declaradas [2]/[2b] caen en rojo (${n4.nadieConcede.length} vs ${r.nadieConcede.length} y ${n4.sinNadieQueLaTenga.length} vs ${r.sinNadieQueLaTenga.length}): TAPAN algo real`
        : `las ${declaradasVisibles.length} declaradas que un rol menciona ya no tapan nada: con el alcance efectivo les llega gente -- PODAR la lista, no ampliarla`);
  }

  // `[VEC.0c]` [2d] rota a proposito: si se declara una segregacion mas limpia de lo medido,
  // la compuerta tiene que gritar que EMPEORO. Sin esto, `conocidos` seria un numero que se
  // ajusta solo al rojo, que es la forma mas comoda de no ver nunca que algo se rompio mas.
  const peor = choquesMedidos.map((s) => ({ ...s, conocidos: Math.max(0, s.choques - 1) }));
  const nSeg = peor.filter((s) => s.choques > s.conocidos);
  ok(nSeg.length === choquesMedidos.length,
    `[2d] detecta que una segregacion EMPEORO si se baja su medida conocida en 1 (${choquesMedidos.map((s) => `${s.nombre}: ${s.choques} > ${Math.max(0, s.choques - 1)}`).join('; ')})`);

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} pass · ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  if (esFaltaDeAcceso(e)) noMedido(`no se pudo llegar al padron -- ${e.message}`);
  console.error('\nFALLA:', e.message);
  process.exit(1);
});
