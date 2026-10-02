/**
 * `[TP.11]` — Acceso al panel de Obligaciones a proveedor para Operaciones y los encargados.
 *
 * Pedido: que puedan entrar a `/compras/obligaciones` Guillermo López Gutiérrez, Arizbeth, Gera,
 * Aide, «compras Zamora», Ivette, Ramón, Aarón y los encargados de sucursal.
 *
 * ── Medido ANTES de tocar nada: 6 de los 8 nombrados YA entran ──────────────
 * El guard de la ruta es `anyPermissionGuard(COMPRAS_OBLIGACIONES_VER, FINANCE_PAYMENTS_GESTIONAR)`
 * — o sea que hay **dos** puertas, y la segunda ya estaba abierta para varios:
 *
 *   guillermo_lopez    direccion            VER ✓
 *   arizbeth_gonzalez  gerente_compras      VER ✓ (y GESTIONAR)
 *   gerardo_ramirez    auxiliar_compras     VER ✓            ← «Gera»
 *   ivette_cruz        superadmin           god-mode
 *   ramon_rodriguez    superadmin           god-mode
 *   aaron_alejo        superadmin           god-mode
 *
 * Así que esta migración reparte sólo lo que FALTA, y a nadie más:
 *
 *   compras_operaciones  → 1 persona  (Aide Piceno)
 *   encargado_tienda     → 7 personas (los encargados de sucursal)
 *
 * ── Qué NO hace, y por qué ──────────────────────────────────────────────────
 * **Sólo `VER`, no `GESTIONAR`.** El pedido dice «tengan acceso», que es entrar y mirar. Calca el
 * precedente de `direccion`, que es el único rol con `VER` sin `GESTIONAR`. Dar de más un permiso
 * de escritura porque «ya que estamos» es como se llega a un padrón que nadie puede auditar.
 *
 * **No crea «compras Zamora».** No existe esa cuenta: la única de Zamora en el padrón es
 * `etiquetas.05` (impresión de etiquetas). Inventar un usuario o adivinar a quién se refiere
 * sería peor que dejarlo declarado.
 *
 * ── ⚠️ Lo que este permiso significa de verdad ──────────────────────────────
 * `supplier-payment-obligations.service.ts` tiene **cero** usos de `ScopeService` (medido). O sea
 * que `COMPRAS_OBLIGACIONES_VER` **no se acota por sucursal**: los 7 encargados van a ver las
 * obligaciones a proveedor de **toda la red**, no las de su plaza. Es lo que se pidió y se otorga,
 * pero queda escrito acá para que nadie lo descubra después pensando que es un bug.
 *
 * ⚠️ El permiso viaja en el JWT → **hay que volver a entrar** para que surta efecto.
 */

const ROLES = ['compras_operaciones', 'encargado_tienda'];
const CLAVE = 'COMPRAS_OBLIGACIONES_VER';

exports.up = async function up(knex) {
  // ── Candado 1: la clave ya existe en el padrón ───────────────────────────
  // Si no la tuviera nadie, estaríamos inventando un permiso — y uno que el enum no conozca se
  // reparte igual y no gatea nada (la lección de `[LC.6.2]`: declarado ≠ repartido).
  const { rows: yaLaTienen } = await knex.raw(
    `SELECT role_name FROM identity.role_permissions WHERE permissions -> ? IS NOT NULL ORDER BY 1`,
    [CLAVE],
  );
  if (!yaLaTienen.length) {
    throw new Error(`[TP.11] Ningún rol declara "${CLAVE}": sería inventar un permiso.`);
  }

  for (const rol of ROLES) {
    const fila = await knex('identity.role_permissions').where({ role_name: rol }).first('role_name', 'permissions');
    if (!fila) throw new Error(`[TP.11] No existe el rol "${rol}".`);

    // ⛔ Un `false` EXPLÍCITO no se pisa. Es residuo de guardar el mapa completo desde
    // /admin/roles, pero también puede ser una decisión — y distinguirlas desde acá no se puede.
    // ⚠️ Se pregunta con `-> 'KEY' IS NULL`, NO con el operador `?` de JSONB: knex no lo escapa.
    const { rows: [estado] } = await knex.raw(
      `SELECT permissions -> ? IS NULL AS ausente, (permissions ->> ?)::bool AS valor
         FROM identity.role_permissions WHERE role_name = ?`,
      [CLAVE, CLAVE, rol],
    );
    if (!estado.ausente && estado.valor === false) {
      console.log(`[TP.11] ${rol}: tiene "${CLAVE}" en FALSE explícito — no se pisa. Se declara.`);
      continue;
    }

    await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || jsonb_build_object(?::text, true)
        WHERE role_name = ?`,
      [CLAVE, rol],
    );
  }

  // ── Candado 2: las personas del pedido resuelven a ACCESO ────────────────
  // No se verifica «el UPDATE corrió»: se verifica que la puerta abra, que es la pregunta real.
  const NOMBRADOS = [
    'guillermo_lopez', 'arizbeth_gonzalez', 'gerardo_ramirez',
    'aide_piceno', 'ivette_cruz', 'ramon_rodriguez', 'aaron_alejo',
  ];
  const { rows: puerta } = await knex.raw(
    `SELECT u.username,
            coalesce((rp.permissions ->> 'COMPRAS_OBLIGACIONES_VER')::bool, false)
              OR coalesce((rp.permissions ->> 'FINANCE_PAYMENTS_GESTIONAR')::bool, false)
              OR lower(u.role_name) IN ('superadmin', 'admin') AS entra
       FROM identity.users u
       LEFT JOIN identity.role_permissions rp ON rp.role_name = u.role_name
      WHERE u.deleted_at IS NULL AND u.username = ANY (?)`,
    [NOMBRADOS],
  );
  const afuera = puerta.filter((r) => !r.entra).map((r) => r.username);
  if (afuera.length) {
    throw new Error(`[TP.11] Siguen sin poder entrar: ${afuera.join(', ')}. Se revierte.`);
  }
  const faltantes = NOMBRADOS.filter((n) => !puerta.some((r) => r.username === n));
  if (faltantes.length) {
    throw new Error(`[TP.11] No se encontró en el padrón: ${faltantes.join(', ')}. Se revierte.`);
  }

  const { rows: alcance } = await knex.raw(
    `SELECT rp.role_name, (SELECT count(*)::int FROM identity.users u
                            WHERE u.role_name = rp.role_name AND u.deleted_at IS NULL) AS personas
       FROM identity.role_permissions rp
      WHERE (rp.permissions ->> ?)::bool IS TRUE ORDER BY 1`,
    [CLAVE],
  );
  console.log(
    `[TP.11] "${CLAVE}" ahora en ${alcance.length} roles · ` +
      `${alcance.reduce((s, r) => s + r.personas, 0)} personas: ` +
      alcance.map((r) => `${r.role_name} (${r.personas})`).join(', '),
  );
  console.log(`         ${puerta.length} de los nombrados entran. ⚠️ Hay que volver a entrar: el permiso va en el JWT.`);
  console.log('         ⛔ «compras Zamora» NO se creó: no existe esa cuenta en el padrón.');
};

exports.down = async function down(knex) {
  for (const rol of ROLES) {
    await knex.raw(
      `UPDATE identity.role_permissions SET permissions = permissions - ?::text WHERE role_name = ?`,
      [CLAVE, rol],
    );
  }
};
