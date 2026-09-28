/**
 * `[VSO.1]` El CANAL del sell-out deja de estar escrito a mano en cada publicador y pasa a ser
 * un **DATO**: `analytics.sellout_channel_map`.
 *
 * ── Qué lo disparó, medido contra prod el 2026-09-28 ────────────────────────────────────────
 * `analytics.v_sellout_daily` publica **seis** canales crudos. La pantalla conoce **cuatro**:
 *
 *   mostrador   kepler $51.88M · wincaja $40.59M   ✅ la pantalla lo conoce
 *   mayoreo     kepler $21,373,739                 ⛔ NO
 *   credito     wincaja $20.57M                    ✅
 *   ruta        kepler $13.68M · wincaja $3.12M    ✅
 *   preventa    kepler $6.61M  · wincaja $3.11M    ✅
 *   contado_nf  kepler $381,787                    ⛔ NO
 *
 * O sea **$21,755,526 en 90 días = 13.5% de la venta** sin etiqueta (`CHANNEL_LABELS` no los
 * tiene → la columna se rotula con el string crudo), sin casilla en el filtro Canal, y **sin hoja
 * en el árbol Avanzado** — lo último es lo que más duele: `sellOutCanales` sólo emite
 * `mostrador|ruta|preventa|credito`, así que abrir "Avanzado" y elegir CUALQUIER hoja arma un
 * `cellFilter` que descarta los $21.4M sin decir nada.
 *
 * ── La causa: el cambio de taxonomía entró por un SCRIPT, no por una migración ───────────────
 * La decisión SD-CH (Edgar: *"mayoreo es CANAL; el crédito es CONDICIÓN DE PAGO"*) se aplicó a
 * prod con `database/scripts/may-preserve-mayoreo-channel.js`, que reescribe la definición VIVA.
 * Quedó bien en la base y **en ningún lado más**: las SEIS migraciones que escriben
 * `v_sellout_daily` siguen diciendo `WHEN 'mayoreo' THEN 'credito'`, así que el próximo
 * `DROP ... CASCADE` de esa cadena revierte la taxonomía **solo y en silencio**; y el front, el
 * service, la plantilla de plaza y `v_sellout_vs_facturacion` nunca se enteraron.
 *
 * Es la R7 de `docs/VERDAD_ABSOLUTA.md` en su forma pura: *nadie verificaba que lo PUBLICADO
 * concordara con el resolvedor*. Por eso acá el canal se vuelve dato **y** trae su cobertura.
 *
 * ── El decode que decide el mapeo (medido, no supuesto) ─────────────────────────────────────
 * ⭐ `wincaja.caja_channels` dice, textual, que la **caja 70 = "Mayoreo a credito"**
 *    (`sale_channel='mayoreo_credito'` → canal `credito`). Y `kdmm` dice que **`U-D-8` = "Factura
 *    Telemarketing"** → canal `mayoreo`. **Son el MISMO canal de negocio a los dos lados del
 *    corte de ERP.** La prueba está en una sola celda: el almacén `08` en sep-2026 trae
 *    `credito` $2,920,676 (Wincaja, antes del 18-sep) **y** `mayoreo` $1,327,515 (Kepler, desde
 *    el 18-sep) — el mayoreo de la MISMA plaza partido en dos columnas por el cutover, que es
 *    exactamente lo que `warehouse_code` ya resuelve para la sucursal y el canal no resolvía.
 *
 * ⭐ `contado_nf` (`U-D-12` "Factura Contado No Fiscal") **es mostrador**, no un canal: 11 de sus
 *    13 vendedores son `SUCURSAL … PISO` / `VENTAS DE PISO`, y esos mismos códigos concentran su
 *    volumen en `mostrador` (`01:10003` PISO: $14.76M en mostrador contra $68k en `contado_nf`).
 *    Fiscal-vs-no-fiscal es una condición de FACTURACIÓN, no un canal — el mismo razonamiento con
 *    el que SD-CH sacó al crédito de ser canal. Entra a Mostrador, que es donde ocurrió la venta.
 *    ⚠️ Y **sí es venta**, no un re-facturado: `VERDAD_ABSOLUTA.md` §4.4 ya arbitró que `U-D-12`
 *    entra al universo (a diferencia de `U-D-6`, que re-factura el ticket en 93.1%).
 *
 * ── Por qué TABLA y no derivada ─────────────────────────────────────────────────────────────
 * Qué canal crudo pertenece a qué canal de negocio —y con qué rótulo y en qué orden— es una
 * **decisión**, igual que `kepler_cutover_date` en `v_branch_erp_cutover` (SB.1): no se deriva de
 * ningún hecho. Lo que SÍ se deriva es la **cobertura**: `v_sellout_channel_coverage` enumera los
 * canales crudos del universo que NO tienen fila, con su dinero, para que uno nuevo quede
 * DECLARADO en vez de caerse en silencio (ADR-056 R4: una fila ausente en un LEFT JOIN llega NULL
 * y se lee como sana).
 *
 * ⛔ **`v_sellout_daily` NO se toca.** El canal crudo conserva su procedencia (de qué ERP y de qué
 * documento salió la fila); lo canónico se resuelve al LEER. Plegar `credito`→`mayoreo` dentro de
 * la vista ahorraría una lectura y borraría para siempre cuál de los dos ERPs lo produjo.
 *
 * Aditiva e idempotente: crea tabla+vista si no existen y siembra con ON CONFLICT DO NOTHING.
 * Sin RLS propia, con `tenant_id` en la PK — convención de `analytics` (2 de 69 tablas tienen RLS;
 * `analytics.vendor_identity` es el molde que se calca acá).
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces

/**
 * El mapeo, con la EVIDENCIA de cada fila al lado. `orden` es el de la pantalla.
 * `canonical_channel` usa el nombre del canal de NEGOCIO, no el del documento que lo produjo.
 */
const MAPA = [
  ['kepler',  'mostrador',  'mostrador', 'Mostrador', 0, 'U-D-10 Ticket Contado Caja (y el resto de U-D no telemarketing)'],
  ['wincaja', 'mostrador',  'mostrador', 'Mostrador', 0, 'caja distinta de 15 y 70 (wincaja.caja_channels)'],
  ['kepler',  'contado_nf', 'mostrador', 'Mostrador', 0, 'U-D-12 Factura Contado No Fiscal = venta de PISO sin folio fiscal; 11 de 13 vendedores son SUCURSAL...PISO'],
  ['kepler',  'preventa',   'preventa',  'Vecinal',   1, 'kduv.c3 ~ RUTA VECINAL% o kdm1.c12 ~ [0-9]+V[0-9]'],
  ['wincaja', 'preventa',   'preventa',  'Vecinal',   1, 'caja 15 = Preventa vecinal (wincaja.caja_channels)'],
  ['kepler',  'ruta',       'ruta',      'Ruta',      2, 'kduv.c3 ~ RUTA % + venta a bordo Canindo (c67 ~ 500N); las camionetas entran por su propia pierna RUTA-%'],
  ['wincaja', 'ruta',       'ruta',      'Ruta',      2, 'wincaja.branches.is_route'],
  ['kepler',  'mayoreo',    'mayoreo',   'Mayoreo',   3, 'U-D-8 Factura Telemarketing (kdmm)'],
  ['wincaja', 'credito',    'mayoreo',   'Mayoreo',   3, 'caja 70 = "Mayoreo a credito" (wincaja.caja_channels) — el MISMO canal que U-D-8, del otro lado del cutover'],
];

exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('analytics').hasTable('sellout_channel_map'))) {
    await knex.raw(`
      CREATE TABLE analytics.sellout_channel_map (
        tenant_id         uuid NOT NULL,
        source            text NOT NULL,
        raw_channel       text NOT NULL,
        canonical_channel text NOT NULL,
        label             text NOT NULL,
        orden             int  NOT NULL,
        evidencia         text,
        created_at        timestamptz DEFAULT CURRENT_TIMESTAMP,
        updated_at        timestamptz DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, source, raw_channel)
      )`);
    await knex.raw(`CREATE INDEX ix_sellout_channel_map_canon ON analytics.sellout_channel_map (tenant_id, canonical_channel)`);
  }

  for (const [source, raw, canon, label, orden, evidencia] of MAPA) {
    await knex.raw(
      `INSERT INTO analytics.sellout_channel_map
         (tenant_id, source, raw_channel, canonical_channel, label, orden, evidencia)
       VALUES (?::uuid, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, source, raw_channel) DO NOTHING`,
      [TENANT, source, raw, canon, label, orden, evidencia],
    );
  }

  // Cobertura: lo que el universo publica y el mapa NO explica. Lee el ROLLUP (materializado) y no
  // la vista: `v_sellout_daily` tarda minutos en un scan completo y esto tiene que poder correrse
  // en un candado. El rollup se materializa DESDE la vista, así que su vocabulario es el mismo.
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_sellout_channel_coverage AS
      SELECT s.tenant_id,
             s.source,
             s.channel                       AS raw_channel,
             m.canonical_channel,
             m.label,
             m.orden,
             (m.raw_channel IS NOT NULL)     AS mapeado,
             sum(s.monto)::numeric(16,2)     AS monto_total,
             min(s.year_month)               AS desde,
             max(s.year_month)               AS hasta
        FROM analytics.mv_sellout_monthly s
        LEFT JOIN analytics.sellout_channel_map m
               ON m.tenant_id = s.tenant_id AND m.source = s.source AND m.raw_channel = s.channel
       GROUP BY s.tenant_id, s.source, s.channel, m.canonical_channel, m.label, m.orden, (m.raw_channel IS NOT NULL)`);

  await knex.raw(`GRANT SELECT ON analytics.sellout_channel_map TO app_runtime`);
  await knex.raw(`GRANT SELECT ON analytics.v_sellout_channel_coverage TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE analytics.sellout_channel_map IS
    'VSO.1 · RESOLVEDOR UNICO del canal del sell-out: (source, raw_channel) -> canal de NEGOCIO + rotulo + orden. Una fila por combinacion que el universo publica. wincaja:credito (caja 70 = Mayoreo a credito) y kepler:mayoreo (U-D-8 Factura Telemarketing) son EL MISMO canal a los dos lados del cutover; kepler:contado_nf (U-D-12) es mostrador facturado sin folio fiscal. NO volver a escribir el vocabulario de canal como literal en un publicador (ADR-056: un primitivo copiado a mano diverge - paso, y dejo 13.5% de la venta sin etiqueta ni filtro). Lo que el universo publique y no este aca sale listado en analytics.v_sellout_channel_coverage con mapeado=false.'`);
  await knex.raw(`COMMENT ON VIEW analytics.v_sellout_channel_coverage IS
    'VSO.1 · Cobertura del mapa de canal: una fila por (source, raw_channel) del universo, con su dinero y si el mapa lo explica. mapeado=false es un canal crudo que nadie declaro -> el candado test-newdb-sellout-channel-parity.js se pone rojo y lo nombra con su monto.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_sellout_channel_coverage`);
  await knex.raw(`DROP TABLE IF EXISTS analytics.sellout_channel_map`);
};
