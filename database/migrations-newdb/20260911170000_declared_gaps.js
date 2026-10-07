/**
 * R.0 — UN HUECO DECLARADO CARGA SU CONDICIÓN DE CADUCIDAD.
 *
 * Pedido de Edgar (2026-09-11): *"todo lo declarado. lo tenemos que resolver. busquemos patrones en
 * las fallas para poder resolverlo"*.
 *
 * ── El patrón que se encontró, y es el que esta tabla existe para romper ─────────────────────
 *
 * Se midieron los ~10 huecos de `docs/VERDAD_ABSOLUTA.md` §7 contra prod. **No son diez problemas.**
 * Dos de los más grandes comparten exactamente la misma falla:
 *
 *   · **`U-D-8` "no es arbitrable"** ($16,197,173 / 90 d) — se declaró porque `c62`/`c63` están
 *     vacíos (confirmado hoy: **1.15%** poblados). Pero **`c58`, el peldaño, está al 99.97%**, la
 *     escalera pagada cubre el **100%** de sus 2,804 SKUs y `v_erp_unit_cost` el **99.54%**.
 *   · **Wincaja "no declara peldaño"** ($84.07M, 55% del ingreso) — `v_unit_truth` ya resuelve
 *     **330,504 de 343,015 celdas (96.4%)**.
 *
 * Los resolvedores que los cierran se construyeron **en las últimas 48 horas, para otra cosa**.
 * Nadie volvió a preguntarle al hueco si seguía siendo hueco.
 *
 * ⭐ **La causa raíz no es de datos: las declaraciones no caducan.** Un hueco declarado en agosto
 * contra la caja de herramientas de agosto sigue declarado en septiembre, aunque la herramienta que
 * lo cierra exista desde hace un mes. La prosa de un `.md` no puede re-medirse sola.
 *
 * ── Qué cambia ──────────────────────────────────────────────────────────────────────────────
 *
 * Cada hueco deja de ser un párrafo y pasa a ser una fila con **`recheck_sql`**: la consulta que
 * decide si todavía es hueco. El candado `test-newdb-declared-gaps.js` la corre y se pone **ROJO
 * cuando un hueco deja de serlo** — que es la compuerta que hoy no existe.
 *
 * Contrato de `recheck_sql`: devuelve **UNA fila** con
 *   · `sigue_siendo_hueco` boolean  — el veredicto
 *   · `detalle` text                — la cifra de hoy, para que el rojo diga cuánto cambió
 *
 * ⛔ **Es SQL guardado en una tabla, así que se blinda en los dos lados.** Acá, un CHECK rechaza
 * cualquier verbo de escritura. En el candado, además, corre dentro de una transacción
 * `READ ONLY`, que es lo único que de verdad lo garantiza (un CHECK por palabras se puede
 * esquivar; un `SET TRANSACTION READ ONLY` no).
 *
 * ⚠️ Tabla REAL y no vista, a propósito: esto es dato **nuestro** (qué declaramos y cuándo), no
 * derivable del ODS. Es el caso que la regla principal del proyecto permite explícitamente.
 *
 * ⚠️ `analytics.*` no lleva RLS en este proyecto — el filtro por `tenant_id` es responsabilidad del
 * consumidor, igual que en `product_box_price` y el resto del schema.
 *
 * @param { import("knex").Knex } knex
 */

const ESTADOS = ['abierto', 'cerrado', 'irresoluble_con_la_fuente'];

// Verbos de escritura. Defensa en profundidad: el freno REAL es la transaccion READ ONLY del
// candado, pero un CHECK barato ataja el error honesto (alguien pega un UPDATE por descuido).
const PROHIBIDO = '(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|vacuum|call|do)';

exports.up = async function up(knex) {
  const ya = (await knex.raw(`SELECT to_regclass('analytics.declared_gaps') t`)).rows[0].t;
  if (!ya) {
    await knex.raw(`
      CREATE TABLE analytics.declared_gaps (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid        NOT NULL,
        clave             text        NOT NULL,
        titulo            text        NOT NULL,
        monto             numeric,
        unidad            text,
        declarado_en      date        NOT NULL,
        motivo            text        NOT NULL,
        resolver_faltante text,
        recheck_sql       text        NOT NULL,
        estado            text        NOT NULL DEFAULT 'abierto',
        ultima_medicion   timestamptz,
        ultimo_detalle    text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now()
      )`);
    await knex.raw(`CREATE UNIQUE INDEX declared_gaps_clave_uq
                      ON analytics.declared_gaps (tenant_id, clave)`);
    await knex.raw(`ALTER TABLE analytics.declared_gaps
                      ADD CONSTRAINT declared_gaps_estado_chk
                      CHECK (estado IN ('${ESTADOS.join("','")}'))`);
    // El recheck no puede escribir. No reemplaza a la transaccion READ ONLY del candado:
    // la complementa.
    await knex.raw(`ALTER TABLE analytics.declared_gaps
                      ADD CONSTRAINT declared_gaps_recheck_readonly_chk
                      CHECK (recheck_sql !~* '\\m${PROHIBIDO}\\M')`);
  }

  await knex.raw(`GRANT SELECT ON analytics.declared_gaps TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE analytics.declared_gaps IS
    'R.0: los huecos declarados de VERDAD_ABSOLUTA 7, pero con condicion de caducidad. recheck_sql devuelve UNA fila (sigue_siendo_hueco boolean, detalle text) y el candado test-newdb-declared-gaps.js se pone ROJO cuando un hueco deja de serlo. Existe porque dos de los huecos mas grandes (U-D-8 y el peldano de Wincaja) se declararon ANTES de que existiera el resolvedor que los cierra, y nadie los volvio a medir.'`);
  await knex.raw(`COMMENT ON COLUMN analytics.declared_gaps.resolver_faltante IS
    'Que resolvedor haria falta para cerrarlo. Si ese resolvedor se construye despues, esta columna es la que permite encontrar el hueco y re-medirlo.'`);
  await knex.raw(`COMMENT ON COLUMN analytics.declared_gaps.recheck_sql IS
    'SOLO LECTURA (CHECK por verbos + el candado la corre en transaccion READ ONLY). Devuelve UNA fila: sigue_siendo_hueco boolean, detalle text.'`);

  // ── Auto-verificación ──
  const cols = (await knex.raw(`
    SELECT count(*)::int n FROM information_schema.columns
     WHERE table_schema = 'analytics' AND table_name = 'declared_gaps'
       AND column_name IN ('clave','recheck_sql','estado','resolver_faltante','declarado_en')`)).rows[0].n;
  if (cols !== 5) throw new Error(`declared_gaps quedó con ${cols} de las 5 columnas del contrato`);

  // El CHECK de sólo-lectura tiene que MORDER. Prueba negativa dentro de la propia migración:
  // se intenta insertar un recheck con UPDATE y se exige que Postgres lo rechace.
  let mordio = false;
  try {
    await knex.raw(`
      INSERT INTO analytics.declared_gaps
        (tenant_id, clave, titulo, declarado_en, motivo, recheck_sql)
      VALUES ('00000000-0000-0000-0000-000000000000', '__probe__', 'probe', current_date,
              'probe', 'UPDATE analytics.sales_daily SET units = 0')`);
  } catch (e) {
    mordio = /declared_gaps_recheck_readonly_chk/.test(e.message);
  }
  await knex.raw(`DELETE FROM analytics.declared_gaps WHERE clave = '__probe__'`);
  if (!mordio) {
    throw new Error('el CHECK de sólo-lectura NO rechazó un recheck_sql con UPDATE: es decorativo');
  }

  console.log('  [declared-gaps] tabla lista · el CHECK de sólo-lectura mordió en la prueba negativa');
};

exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS analytics.declared_gaps`);
};
