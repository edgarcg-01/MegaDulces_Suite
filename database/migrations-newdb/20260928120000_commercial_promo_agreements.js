'use strict';
/**
 * `[MKT.1]` — `commercial.promo_agreements` + su EXPEDIENTE: el formato MKTN001 en la base.
 *
 * ── Qué es esto y por qué no cabe en `commercial.promotions` ─────────────────────────────────
 * `commercial.promotions` (mig `20260527000001`) es un **motor de precio**: reglas que
 * `OrdersService.recalcOrderTotals` aplica a un pedido (`percent_off_product`, `nxm`, …). Su
 * unidad es *«cómo se descuenta esta línea»*.
 *
 * Esto es otra cosa, y por eso es otra tabla: el **acuerdo negociado con el proveedor**, que en
 * papel es el formato **MKTN001** que firma Mercadotecnia. Su unidad es *«qué se pactó, con quién,
 * en qué plazas, con qué presupuesto, y quién lo autorizó»*. Un acuerdo puede no tener ninguna
 * regla de precio (el ejemplo real folio 1013 es «3% de descuento en la línea Alteño, aplicado por
 * Sistemas») y una regla de precio puede existir sin acuerdo. No son la misma entidad vista dos
 * veces: **tienen distinto dueño, distinto ciclo de vida y distinta evidencia**.
 *
 * ── Dato propio (HITL), no derivable ────────────────────────────────────────────────────────
 * Igual que `floor_stockouts` (`[FLT.0]`), esto cae en la excepción que la regla del ODS nombra.
 * La negociación con el proveedor **no deja rastro en ningún feed**: ocurre por correo, por
 * WhatsApp o en una visita, y termina en una hoja firmada. Kepler no la conoce. Lo que SÍ se
 * deriva —cuánto se vendió de esa marca en esas plazas y esas fechas— se lee del ODS en el
 * momento de leer el avance y **no se copia acá**.
 *
 * ── Las cuatro tablas y por qué son cuatro ──────────────────────────────────────────────────
 *   1. `promo_agreements`          — la carátula del formato. Una fila = un folio.
 *   2. `promo_agreement_codes`     — los renglones de «códigos de promoción». El papel trae 6
 *                                    casillas y la pantalla deja agregar hasta 30; una tabla hija
 *                                    en vez de 6 columnas porque 6 es un accidente del papel.
 *   3. `promo_agreement_channels`  — ⭐ **EL EXPEDIENTE**. Una fila por canal participante. Es la
 *                                    unidad de trabajo de la plaza y la unidad de control del
 *                                    jefe: cada canal marcado en el formato abre su expediente,
 *                                    y ahí es donde se sube la evidencia.
 *   4. `promo_agreement_files`     — los archivos. `channel_id` NULL = evidencia de la
 *                                    negociación (el correo, la cotización); NOT NULL = evidencia
 *                                    de ejecución de esa plaza (la foto de la exhibición).
 *
 * ── Dos módulos sobre la MISMA fila ─────────────────────────────────────────────────────────
 * No hay tabla «del jefe» y tabla «de la plaza». Hay una sola, y el corte es de alcance
 * (`ScopeService`, ADR-050): Mercadotecnia lee todos los canales, la plaza lee el suyo. Duplicar
 * la tabla para separar las vistas sería garantizar que un día digan cosas distintas.
 *
 * ── Lo que los CHECK impiden, y por qué cada uno ────────────────────────────────────────────
 *   · Un folio **sólo existe al autorizar** — en borrador es NULL, no un folio provisional que
 *     alguien imprima y después cambie.
 *   · El monto es **NULL cuando no se pactó**, nunca 0 (ADR-056): un cero se lee como «no cuesta
 *     nada», que es la conclusión contraria.
 *   · `recurso='otros'` exige decir cuál — el papel tiene la línea «(especifique)» y en Excel se
 *     dejaba vacía.
 *   · Un acuerdo autorizado tiene **quién** y **cuándo** lo autorizó, o no está autorizado.
 *   · La vigencia tiene fecha de fin **o** texto («hasta agotar»), nunca las dos ni ninguna: el
 *     campo `AL` del formato admite ambas formas y en la pantalla vieja se veía cortado.
 *
 * Aditiva e idempotente. RLS forzado + grant `app_runtime`. FKs compuestas `(tenant_id, id)`.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  const yaEsta = await knex.schema.withSchema('commercial').hasTable('promo_agreements');
  if (yaEsta) return;

  // ─────────────────────────── 1. la carátula del formato ───────────────────────────
  await knex.raw(`
    CREATE TABLE commercial.promo_agreements (
      id                      uuid NOT NULL DEFAULT gen_random_uuid(),
      tenant_id               uuid NOT NULL,

      -- Folio del formato. NULL mientras es borrador: un folio que se imprime y luego cambia
      -- es peor que no tener folio. Se asigna al autorizar (patrón de TP.8).
      folio                   varchar(20),
      formato                 varchar(20) NOT NULL DEFAULT 'MKTN001',
      empresa                 varchar(120) NOT NULL,

      -- Tipo de apoyo negociado. El papel dice "APOYO PARA SELL OUT" en la banda superior.
      apoyo                   varchar(24) NOT NULL DEFAULT 'sell_out',

      -- Con quién. Texto libre a propósito: el formato se imprime con el nombre tal cual se
      -- negoció, y hay marcas que no son un proveedor del catálogo. 'supplier_id' queda para
      -- cuando SÍ se puede ligar, sin obligar a que exista.
      proveedor               varchar(160) NOT NULL,
      supplier_id             uuid,

      agente_ventas           varchar(120),
      fecha_negociacion       date NOT NULL,
      periodo                 smallint,

      -- Vigencia. 'hasta_texto' cubre el "HASTA AGOTAR" que el papel admite en el campo AL.
      vigencia_desde          date NOT NULL,
      vigencia_hasta          date,
      vigencia_hasta_texto    varchar(60),

      -- Lo que se negoció (paso 2) y lo que se imprime (paso 3). Se guardan los dos: el segundo
      -- nace del primero pero se edita para el papel, y perder el original borraría la evidencia
      -- de qué se había pactado realmente.
      oferta_negociada        text,
      mecanica                text NOT NULL,

      presupuesto_tipo        varchar(16) NOT NULL DEFAULT 'topado',
      presupuesto_detalle     text,
      presupuesto_fecha       date,

      recurso                 varchar(32) NOT NULL,
      recurso_otros           varchar(200),

      conceptos               text,
      -- El "se paga" del formato. NULL = no se pactó monto, NUNCA 0 (ADR-056).
      monto                   numeric(14,2),

      -- Encabezado de la tabla de distribución del papel.
      distribucion_producto   varchar(160),
      distribucion_codigo     varchar(40),
      distribucion_cargo      varchar(12),

      autoriza_nombre         varchar(120),

      status                  varchar(16) NOT NULL DEFAULT 'borrador',

      created_by              uuid,
      created_by_username     varchar(80),
      authorized_by           uuid,
      authorized_by_username  varchar(80),
      authorized_at           timestamptz,
      closed_at               timestamptz,
      created_at              timestamptz NOT NULL DEFAULT now(),
      updated_at              timestamptz NOT NULL DEFAULT now(),
      deleted_at              timestamptz,

      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, folio),

      CONSTRAINT commercial_promo_agreements_apoyo_chk
        CHECK (apoyo IN ('sell_out','sell_in','exhibicion','promocional','otro')),
      CONSTRAINT commercial_promo_agreements_status_chk
        CHECK (status IN ('borrador','autorizado','vigente','cerrado','cancelado')),
      CONSTRAINT commercial_promo_agreements_presupuesto_chk
        CHECK (presupuesto_tipo IN ('topado','abierto','por_volumen')),
      CONSTRAINT commercial_promo_agreements_recurso_chk
        CHECK (recurso IN (
          'cedis_nota_credito','proveedor_sin_cargo','proveedor_promocionales',
          'presupuesto_a_favor','otros')),
      CONSTRAINT commercial_promo_agreements_cargo_chk
        CHECK (distribucion_cargo IS NULL OR distribucion_cargo IN ('con_cargo','sin_cargo')),

      -- El papel tiene la línea "(especifique)" y en Excel se dejaba vacía: sin el detalle,
      -- 'otros' no dice nada y el formato sale incompleto a la firma.
      CONSTRAINT commercial_promo_agreements_recurso_otros_chk
        CHECK (recurso <> 'otros' OR nullif(btrim(recurso_otros), '') IS NOT NULL),

      -- Un monto de 0 es indistinguible de "no se midió". Si no se pactó, va NULL.
      CONSTRAINT commercial_promo_agreements_monto_chk
        CHECK (monto IS NULL OR monto > 0),

      -- El folio nace con la autorización, y la autorización nace con nombre y hora.
      CONSTRAINT commercial_promo_agreements_folio_chk
        CHECK ((status = 'borrador'  AND folio IS NULL)
            OR (status <> 'borrador' AND folio IS NOT NULL)),
      CONSTRAINT commercial_promo_agreements_autorizacion_chk
        CHECK (status IN ('borrador','cancelado')
            OR (authorized_at IS NOT NULL AND authorized_by IS NOT NULL)),

      -- La vigencia termina en una fecha o en una condición ("hasta agotar"), nunca en las dos
      -- ni en ninguna: si no se sabe cuándo termina, no se puede cerrar ni reportar al proveedor.
      CONSTRAINT commercial_promo_agreements_vigencia_chk
        CHECK ((vigencia_hasta IS NOT NULL AND vigencia_hasta_texto IS NULL)
            OR (vigencia_hasta IS NULL AND nullif(btrim(vigencia_hasta_texto), '') IS NOT NULL)),
      CONSTRAINT commercial_promo_agreements_orden_fechas_chk
        CHECK (vigencia_hasta IS NULL OR vigencia_hasta >= vigencia_desde),

      CONSTRAINT fk_commercial_promo_agreements_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT
    )`);

  // ─────────────────────────── 2. los códigos del formato ───────────────────────────
  await knex.raw(`
    CREATE TABLE commercial.promo_agreement_codes (
      id            uuid NOT NULL DEFAULT gen_random_uuid(),
      tenant_id     uuid NOT NULL,
      agreement_id  uuid NOT NULL,
      position      smallint NOT NULL,
      code          varchar(40) NOT NULL,
      descripcion   varchar(160),
      product_id    uuid,
      created_at    timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, agreement_id, position),

      CONSTRAINT commercial_promo_agreement_codes_pos_chk
        CHECK (position BETWEEN 1 AND 30),

      CONSTRAINT fk_promo_agreement_codes_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      CONSTRAINT fk_promo_agreement_codes_agreement
        FOREIGN KEY (tenant_id, agreement_id)
        REFERENCES commercial.promo_agreements (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_promo_agreement_codes_product
        FOREIGN KEY (tenant_id, product_id)
        REFERENCES catalog.products (tenant_id, id) ON DELETE SET NULL (product_id)
    )`);

  // ──────────────────── 3. EL EXPEDIENTE: una fila por canal participante ────────────────────
  await knex.raw(`
    CREATE TABLE commercial.promo_agreement_channels (
      id                  uuid NOT NULL DEFAULT gen_random_uuid(),
      tenant_id           uuid NOT NULL,
      agreement_id        uuid NOT NULL,

      -- El canal. 'warehouse_code' es snapshot para que el expediente se lea sin join y
      -- sobreviva a un cambio de catálogo: es el mismo criterio que 'sku' en floor_stockouts.
      warehouse_id        uuid NOT NULL,
      warehouse_code      varchar(20) NOT NULL,
      warehouse_name      varchar(120),

      -- Distribución de cajas, tal como la escribe el formato ("13 cj 20054").
      cajas_texto         varchar(200),
      -- Mayoreo y las rutas se desglosan en tres plazas en el papel. Nullables: los ocho canales
      -- restantes no lo usan, y un 0 ahí diría "cero cajas" en vez de "no aplica".
      cajas_lp            numeric(12,2),
      cajas_can           numeric(12,2),
      cajas_mor           numeric(12,2),
      con_cargo           boolean,

      -- Cuántas piezas de evidencia se le piden a esta plaza y cuántas lleva. 'evidence_count'
      -- se RECALCULA desde promo_agreement_files (nunca '+= 1' a mano, patrón de TP).
      evidence_required   smallint NOT NULL DEFAULT 1,
      evidence_count      smallint NOT NULL DEFAULT 0,
      evidence_first_at   timestamptz,
      evidence_last_at    timestamptz,

      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      -- Un canal participa UNA vez en un acuerdo. Sin esto, dos altas crean dos expedientes de
      -- la misma plaza y la cobertura ("6 de 10") deja de significar algo.
      UNIQUE (tenant_id, agreement_id, warehouse_id),

      CONSTRAINT commercial_promo_agreement_channels_req_chk
        CHECK (evidence_required >= 0),
      CONSTRAINT commercial_promo_agreement_channels_count_chk
        CHECK (evidence_count >= 0),

      CONSTRAINT fk_promo_agreement_channels_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      CONSTRAINT fk_promo_agreement_channels_agreement
        FOREIGN KEY (tenant_id, agreement_id)
        REFERENCES commercial.promo_agreements (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_promo_agreement_channels_warehouse
        FOREIGN KEY (tenant_id, warehouse_id)
        REFERENCES commercial.warehouses (tenant_id, id) ON DELETE RESTRICT
    )`);

  // ─────────────────────────── 4. la evidencia ───────────────────────────
  await knex.raw(`
    CREATE TABLE commercial.promo_agreement_files (
      id                    uuid NOT NULL DEFAULT gen_random_uuid(),
      tenant_id             uuid NOT NULL,
      agreement_id          uuid NOT NULL,
      -- NULL = evidencia de la NEGOCIACIÓN (el correo, la cotización, el WhatsApp).
      -- NOT NULL = evidencia de EJECUCIÓN de esa plaza (la foto de la exhibición).
      channel_id            uuid,

      kind                  varchar(20) NOT NULL,
      file_name             varchar(200) NOT NULL,
      file_url              text NOT NULL,
      mime_type             varchar(120),
      size_bytes            integer,
      nota                  varchar(300),

      uploaded_by           uuid,
      uploaded_by_username  varchar(80),
      uploaded_at           timestamptz NOT NULL DEFAULT now(),
      deleted_at            timestamptz,

      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),

      CONSTRAINT commercial_promo_agreement_files_kind_chk
        CHECK (kind IN ('negociacion','evidencia','formato_pdf','nota_credito')),
      -- Una evidencia de ejecución SIN canal no se puede atribuir a nadie, y el conteo de
      -- cobertura por plaza dejaría de cuadrar. Al revés también: el correo de la negociación
      -- no pertenece a ninguna plaza en particular.
      CONSTRAINT commercial_promo_agreement_files_canal_chk
        CHECK ((kind = 'evidencia' AND channel_id IS NOT NULL)
            OR (kind <> 'evidencia' AND channel_id IS NULL)),
      CONSTRAINT commercial_promo_agreement_files_size_chk
        CHECK (size_bytes IS NULL OR size_bytes > 0),

      CONSTRAINT fk_promo_agreement_files_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      CONSTRAINT fk_promo_agreement_files_agreement
        FOREIGN KEY (tenant_id, agreement_id)
        REFERENCES commercial.promo_agreements (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_promo_agreement_files_channel
        FOREIGN KEY (tenant_id, channel_id)
        REFERENCES commercial.promo_agreement_channels (tenant_id, id) ON DELETE CASCADE
    )`);

  // ─────────────────────────── índices ───────────────────────────
  // Tablero del jefe: lo vigente primero, y dentro de eso lo que vence antes.
  await knex.raw(`
    CREATE INDEX ix_promo_agreements_tablero
      ON commercial.promo_agreements (tenant_id, status, vigencia_hasta)
      WHERE deleted_at IS NULL`);
  // "¿Qué le negociamos a este proveedor?" — la pregunta que abre cada renegociación.
  await knex.raw(`
    CREATE INDEX ix_promo_agreements_proveedor
      ON commercial.promo_agreements (tenant_id, proveedor)
      WHERE deleted_at IS NULL`);
  // Pantalla de la plaza: "lo que corre en MI sucursal". Es la consulta caliente del módulo 2.
  await knex.raw(`
    CREATE INDEX ix_promo_agreement_channels_plaza
      ON commercial.promo_agreement_channels (tenant_id, warehouse_code, agreement_id)`);
  await knex.raw(`
    CREATE INDEX ix_promo_agreement_channels_acuerdo
      ON commercial.promo_agreement_channels (tenant_id, agreement_id)`);
  await knex.raw(`
    CREATE INDEX ix_promo_agreement_files_acuerdo
      ON commercial.promo_agreement_files (tenant_id, agreement_id, kind)
      WHERE deleted_at IS NULL`);
  await knex.raw(`
    CREATE INDEX ix_promo_agreement_files_canal
      ON commercial.promo_agreement_files (tenant_id, channel_id)
      WHERE channel_id IS NOT NULL AND deleted_at IS NULL`);
  await knex.raw(`
    CREATE INDEX ix_promo_agreement_codes_acuerdo
      ON commercial.promo_agreement_codes (tenant_id, agreement_id, position)`);

  // ─────────────────────────── comentarios ───────────────────────────
  await knex.raw(`
    COMMENT ON TABLE commercial.promo_agreements IS
      '[MKT.1] Acuerdo promocional negociado con el proveedor = el formato MKTN001 que se firma. '
      'Dato propio HITL: la negociacion no deja rastro en ningun feed. NO confundir con commercial.promotions, '
      'que es el motor de PRECIO que aplica reglas a un pedido.'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.promo_agreements.folio IS
      'NULL mientras es borrador. Se asigna al AUTORIZAR (patron TP.8): un folio impreso que despues cambia es peor que no tener folio.'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.promo_agreements.monto IS
      'Lo que se paga. NULL = no se pacto monto, NUNCA 0 (ADR-056): un cero se lee como "no cuesta nada".'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.promo_agreements.vigencia_hasta_texto IS
      'El "HASTA AGOTAR" que admite el campo AL del formato. Excluyente con vigencia_hasta por CHECK.'`);
  await knex.raw(`
    COMMENT ON TABLE commercial.promo_agreement_channels IS
      '[MKT.1] EL EXPEDIENTE: una fila por canal participante. Unidad de trabajo de la plaza y unidad de control del jefe. '
      'El corte entre los dos modulos es de ALCANCE (ScopeService, ADR-050), no dos tablas distintas.'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.promo_agreement_channels.evidence_count IS
      'Se RECALCULA desde promo_agreement_files, nunca se incrementa a mano (patron TP): un contador que se suma solo termina mintiendo.'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.promo_agreement_channels.cajas_lp IS
      'Desglose LP/CAN/MOR que el papel pide SOLO en Mayoreo y las rutas. NULL = no aplica; un 0 diria "cero cajas".'`);
  await knex.raw(`
    COMMENT ON TABLE commercial.promo_agreement_files IS
      '[MKT.1] Evidencia. channel_id NULL = negociacion (correo/cotizacion). NOT NULL = ejecucion de esa plaza (foto de exhibicion).'`);

  // ─────────────────────────── RLS + grants ───────────────────────────
  for (const t of [
    'promo_agreements',
    'promo_agreement_codes',
    'promo_agreement_channels',
    'promo_agreement_files',
  ]) {
    await knex.raw(`ALTER TABLE commercial.${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.${t}`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.${t}
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.${t} TO app_runtime`);
  }
};

exports.down = async function down(knex) {
  // Orden inverso al de creación: los hijos referencian al padre.
  await knex.schema.withSchema('commercial').dropTableIfExists('promo_agreement_files');
  await knex.schema.withSchema('commercial').dropTableIfExists('promo_agreement_channels');
  await knex.schema.withSchema('commercial').dropTableIfExists('promo_agreement_codes');
  await knex.schema.withSchema('commercial').dropTableIfExists('promo_agreements');
};
