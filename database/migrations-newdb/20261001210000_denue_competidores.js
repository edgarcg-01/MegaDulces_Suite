'use strict';
/**
 * [PR.M4] -- La competencia con NOMBRE y domicilio: DENUE deja de servir solo para prospectar.
 *
 * -- Lo que ya existia y lo que faltaba -------------------------------------------------------
 * El modulo de prospeccion (Fase DENUE, ADR-025) cosecha de INEGI con tres clases de MENUDEO:
 * 461160 dulcerias, 461110 abarrotes, 462112 minisuper. Esos son CLIENTES posibles.
 * Las clases de MAYOREO nunca se pidieron, y ahi esta la competencia:
 *
 *   431180  Comercio al por mayor de dulces y materias primas para reposteria  (directa)
 *   431110  Comercio al por mayor de abarrotes                                 (adyacente)
 *   431199  Comercio al por mayor de otros alimentos
 *
 * Medido en vivo el 2026-10-01 sobre Michoacan, Guanajuato y Jalisco: 1,158 unidades, de las
 * cuales 2 son NUESTRAS (DENUE nos ve: "MEGA DULCES DE LOS ALTOS" en La Piedad) y 1,156 son
 * competencia -- 215 directas, 842 de abarrotes, 99 de otros alimentos. Por tamano: 17 con 251 o
 * mas personas, 25 de 101 a 250, 33 de 51 a 100.
 *
 * -- Por que NO una tabla nueva ---------------------------------------------------------------
 * Una unidad economica de DENUE es una unidad economica de DENUE: mismos 22 campos, misma llave
 * (source, source_ref), mismo upsert. Crear commercial.competitor_sites seria una segunda
 * materializacion de lo mismo, que es justo lo que la regla principal prohibe. Lo que cambia no
 * es la FORMA sino el PAPEL, y eso es una columna: "rol".
 *
 * -- ⛔ Por que la columna "rol" no es cosmetica ----------------------------------------------
 * ProspectsService.dedup() PURGA del tablero todo lo que caiga fuera de la geocerca de 100 km
 * alrededor de La Piedad, y corre en un cron nocturno. Sin separar el rol, la primera pasada
 * borraria en silencio a todos los competidores de Guadalajara y Leon -- que son justamente los
 * mas grandes. Y el whitespace_score trataria a un mayorista rival como una tienda por abrir.
 * El filtro por rol en dedup/list/penetration es un requisito de correccion, no un adorno.
 *
 * -- Lo que esta fuente SI y NO dice -----------------------------------------------------------
 * DENUE es un CENSO: dice que existe, donde, de que tamano por rango de personal ocupado, y como
 * contactarlo. NO dice cuanto vende, ni a que precio, ni que surte. Eso no se deduce: el "cuanto
 * vende la competencia" sale de otra fuente (ISCAM, agregado y anonimo) y las dos NO se pueden
 * empatar -- el panel de ISCAM identifica a sus 116 participantes con claves anonimas.
 * Ese hueco se declara, no se rellena.
 */

const T = 'commercial.prospect_stores';
const CFG = 'commercial.prospect_sources';
const CLASES_MAYOREO = ['431180', '431110', '431199'];
const ENTIDADES = ['16', '11', '14']; // Michoacan, Guanajuato, Jalisco

exports.up = async function up(knex) {
  await knex.raw("SET LOCAL lock_timeout = '10s'");

  const tiene = async (tabla, c) => {
    const [esquema, nombre] = tabla.split('.');
    return (await knex.raw(
      'SELECT 1 FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?',
      [esquema, nombre, c])).rows.length > 0;
  };

  if (!(await tiene(T, 'rol'))) {
    await knex.raw(`ALTER TABLE ${T} ADD COLUMN rol text NOT NULL DEFAULT 'prospecto'`);
    await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT prospect_stores_rol_chk
      CHECK (rol IN ('prospecto','competidor','propio'))`);
    await knex.raw(`CREATE INDEX prospect_stores_rol_idx ON ${T} (tenant_id, rol, status)`);
  }

  // Cuantas de NUESTRAS propias unidades ve DENUE. No son prospecto (ya somos clientes de
  // nosotros mismos) ni competencia. Se marcan para que no ensucien ninguno de los dos conteos.
  const propias = await knex.raw(`
    UPDATE ${T} SET rol = 'propio', updated_at = now()
    WHERE rol <> 'propio' AND (
          nombre ILIKE 'MEGA DULCES%'
       OR email  ILIKE '%megadulces%'
       OR web    ILIKE '%megadulces%')`);

  // Cuantos puntos PROPIOS hay cerca: es lo que separa a un rival que respira sobre nuestros
  // clientes de uno que esta a 200 km. NULL = todavia no se midio, nunca 0.
  if (!(await tiene(T, 'propios_1km'))) {
    await knex.raw(`ALTER TABLE ${T} ADD COLUMN propios_1km int`);
    await knex.raw(`ALTER TABLE ${T} ADD COLUMN propios_5km int`);
    await knex.raw(`ALTER TABLE ${T} ADD COLUMN proximidad_medida_at timestamptz`);
    await knex.raw(`COMMENT ON COLUMN ${T}.propios_1km IS
      'Puntos propios (clientes con coordenadas + PdV auditados) a menos de 1 km. NULL = no medido, nunca 0. Cobertura declarada: 438 de 937 clientes tienen coordenadas (46.7%), mas 1,604 PdV auditados. [PR.M4]'`);
  }

  // La configuracion del tenant gana su mitad de mayoreo, al lado de la de menudeo que ya tenia.
  if (!(await tiene(CFG, 'competidor_scian_codes'))) {
    await knex.raw(`ALTER TABLE ${CFG} ADD COLUMN competidor_scian_codes jsonb`);
    await knex.raw(`ALTER TABLE ${CFG} ADD COLUMN competidor_entidades jsonb`);
  }
  await knex(CFG).whereNull('competidor_scian_codes')
    .update({ competidor_scian_codes: JSON.stringify(CLASES_MAYOREO) });
  await knex(CFG).whereNull('competidor_entidades')
    .update({ competidor_entidades: JSON.stringify(ENTIDADES) });

  await knex.raw(`COMMENT ON COLUMN ${T}.rol IS
    'Que papel juega esta unidad de DENUE: prospecto (cliente posible, clases de menudeo), competidor (clases de mayoreo 4311xx) o propio (somos nosotros). dedup/list/penetration filtran por esta columna: sin el filtro, el cron nocturno purga a los competidores fuera de la geocerca. [PR.M4]'`);

  // -- La vista de lectura: la competencia, ordenable por lo que de verdad amenaza -----------
  await knex.raw('DROP VIEW IF EXISTS commercial.v_competidores');
  await knex.raw(`
    CREATE VIEW commercial.v_competidores WITH (security_invoker = true) AS
    SELECT
      p.id, p.tenant_id, p.nombre, p.razon_social, p.scian, p.scian_label,
      CASE p.scian WHEN '431180' THEN 'directa' WHEN '431110' THEN 'abarrotes'
                   ELSE 'otros alimentos' END AS tipo_competencia,
      p.estrato,
      -- El orden del rango de personal ocupado, para poder ordenar por tamano sin inventar
      -- un numero que DENUE no da. NULL cuando el rango no viene.
      CASE p.estrato
        WHEN '0 a 5 personas' THEN 1 WHEN '6 a 10 personas' THEN 2
        WHEN '11 a 30 personas' THEN 3 WHEN '31 a 50 personas' THEN 4
        WHEN '51 a 100 personas' THEN 5 WHEN '101 a 250 personas' THEN 6
        WHEN '251 y más personas' THEN 7 END AS tamano_orden,
      p.municipio, p.entidad, p.lat, p.lng,
      concat_ws(' ', p.calle, p.num_ext, p.colonia, p.cp) AS direccion,
      p.telefono, p.email, p.web,
      p.propios_1km, p.propios_5km, p.nearest_customer_m AS punto_propio_mas_cerca_m,
      p.proximidad_medida_at,
      p.discovered_at, p.last_seen_at
    FROM ${T} p
    WHERE p.rol = 'competidor'`);
  await knex.raw('GRANT SELECT ON commercial.v_competidores TO app_runtime');
  await knex.raw(`COMMENT ON VIEW commercial.v_competidores IS
    'Competidores mayoristas censados por INEGI DENUE. Dice QUE existe, DONDE y de QUE TAMANO (rango de personal). NO dice cuanto vende ni a que precio: eso no esta en DENUE y no se deduce. El cuanto-vende viene de ISCAM, agregado y anonimo, y las dos fuentes NO se pueden empatar. [PR.M4]'`);

  // eslint-disable-next-line no-console
  console.log('[PR.M4] prospect_stores.rol listo · ' + (propias.rowCount || 0)
    + ' unidades propias marcadas · v_competidores lista.');
};

exports.down = async function down(knex) {
  await knex.raw("SET LOCAL lock_timeout = '10s'");
  await knex.raw('DROP VIEW IF EXISTS commercial.v_competidores');
  await knex.raw(`DELETE FROM ${T} WHERE rol = 'competidor'`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS prospect_stores_rol_chk`);
  await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS rol`);
  await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS propios_1km`);
  await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS propios_5km`);
  await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS proximidad_medida_at`);
  await knex.raw(`ALTER TABLE ${CFG} DROP COLUMN IF EXISTS competidor_scian_codes`);
  await knex.raw(`ALTER TABLE ${CFG} DROP COLUMN IF EXISTS competidor_entidades`);
};
