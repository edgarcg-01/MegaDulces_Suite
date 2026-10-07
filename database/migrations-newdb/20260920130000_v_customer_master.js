/**
 * `[TDA.A4]` **El maestro de clientes del ERP, DERIVADO del ODS.** La ficha que Kepler
 * muestra en «Datos del cliente», disponible para analítica sin importer y sin tabla
 * nueva — la regla principal del proyecto.
 *
 * ── El decode, con dos capturas de la ficha como sonda ─────────────────────────────────
 * El negocio mandó la pantalla del ERP para dos clientes (`00001` y `10259` INSTITUCIONALES
 * Y SERVICIOS ISICLEAN). Cada campo se ubicó en `kepler_ods.kdud` y su catálogo se encontró
 * buscando el texto exacto de la captura entre las 215 tablas chicas del ODS:
 *
 *     c2  = Clave        c3 = Nombre    c4/c5/c6 = dirección / ciudad / estado
 *     c27 = Código postal
 *     c12 = **Vendedor** → kepler_ods.kduv (c2=código, c3=nombre)  '10005' = SUCURSAL LA PIEDAD ABASTO PISO
 *     c13 = **Grupo**    → kepler_ods.kduj (c1=código, c2=nombre)  '1VP03' = VENTAS DE PISO ABASTOS
 *     c14 = **Zona**     → kepler_ods.kduk (c1=código, c2=nombre)  '10000' = CLIENTES ZONA LA PIEDAD
 *     c15 = **Límite de crédito** (numeric)     c16 = **Plazo** en días (numeric)
 *
 * ⚠️ **El casi-acierto que costó una pasada:** la Zona resolvía contra `kduv` y daba
 * «VENDEDORES ZONA LA PIEDAD» — mismo código, nombre parecido, catálogo equivocado. El
 * bueno es `kduk`, «CLIENTES ZONA LA PIEDAD». Se vio SÓLO porque la captura traía el texto
 * exacto; contra un agregado habría pasado sin que nada fallara.
 *
 * ── ⭐ LA CLAVE DE CLIENTE ES POR SUCURSAL, y por eso esta vista NO deduplica ───────────
 * El propio ERP lo advierte al pie de su pantalla: *«Debe Tener Cuidado de No Sobreescribir
 * una Clave en Datos Internos de la Sucursal»*. Medido: de **1,574 claves**, 1,195 existen
 * en varias plazas y **141 son un cliente DISTINTO según la plaza**:
 *
 *     clave 00002 → 00=TANIA YAZMIN SANCHEZ LEAL | 01=VIVIANA FLOREZ
 *                   04=YANETT VENTURA QUINTERO   | 05=NO TOCAR JESUS ZUNO RUIZ
 *
 * Los «NO TOCAR» / «NO USAR» dentro del nombre son el personal defendiéndose a mano de la
 * colisión. Por eso la llave es **(fuente_sucursal, cliente_code)** y no la clave sola:
 * anclar al CEDIS —como sí se hace con el SKU de producto, que es global— mostraría a
 * Tania cuando la venta fue de Viviana. Los catálogos se leen de LA MISMA plaza.
 *
 * ⚠️ **Un cliente real puede aparecer bajo claves distintas en plazas distintas, y le
 * pueden vender varios vendedores o sucursales** (confirmado por el negocio). O sea que
 * **no se pueden sumar clientes entre plazas**: el conteo mezclaría a un mismo cliente
 * contado dos veces con dos personas distintas colapsadas en una. La pantalla lo declara.
 *
 * ── ⭐ Lo que esta vista SEPARA importa más que lo que trae ─────────────────────────────
 * `es_interno` marca los grupos que NO son clientes: la propia tienda y las cuentas de los
 * vendedores. Medido sobre 12 meses de facturación de mostrador (sin televenta):
 *
 *     PV-01  PISOS DE VENTA ...  2 «clientes»  $6,481,684   ← la propia tienda
 *     1V001  VECINAL LA PIEDAD  145 clientes     $941,299   ← clientes de verdad
 *     1RD01  RUTA DIRECTA .....   8 clientes     $251,512
 *
 * **UN solo código, `10-00` «Padre Hidalgo Piso», explica el 80 % de toda la venta
 * "identificada"** con 33 documentos. Un ranking que no lo separe pone a la propia tienda
 * en primer lugar y nadie lo nota, porque el nombre parece un cliente. Misma familia del
 * hallazgo `TI*` = traspaso en proveedores.
 *
 * ⚠️ La lista sale de LEER los 20 nombres del catálogo, no de un patrón: los grupos
 * «VENTAS DE PISO ‹plaza›» (1VP01..1VP04, 3VP01..) **NO son internos** — son clientes de
 * verdad que compran en el piso, como ISICLEAN. Un `nombre ILIKE '%PISO%'` los habría
 * borrado a todos.
 *
 * Se MARCAN, no se borran: borrarlos haría que la suma dejara de cuadrar contra la
 * facturación y nadie sabría por qué.
 *
 * ── Techo de cobertura, para que nadie lo olvide al leer la pantalla ───────────────────
 * La facturación a nombre son **$23.1M** contra **$105.2M** del fact de venta, y el 62 %
 * de eso es televenta. Con el recorte de la pantalla (mostrador, sin televenta) quedan
 * **$7.96M de 284 clientes**, y quitando los pisos de venta, ~$1.5M = **1.4 % de la
 * venta**. El mostrador es anónimo: no es un defecto del dato, es el negocio.
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = `
CREATE OR REPLACE VIEW analytics.v_customer_master AS
SELECT d.sucursal                          AS fuente_sucursal,
       btrim(d.c2)                         AS cliente_code,
       NULLIF(btrim(d.c3), '')             AS nombre,
       NULLIF(btrim(d.c4), '')             AS direccion,
       NULLIF(btrim(d.c5), '')             AS ciudad,
       NULLIF(btrim(d.c6), '')             AS estado,
       NULLIF(btrim(d.c27), '')            AS codigo_postal,
       NULLIF(btrim(d.c13), '')            AS grupo_code,
       NULLIF(btrim(g.c2), '')             AS grupo_nombre,
       NULLIF(btrim(d.c12), '')            AS vendedor_code,
       NULLIF(btrim(v.c3), '')             AS vendedor_nombre,
       NULLIF(btrim(d.c14), '')            AS zona_code,
       NULLIF(btrim(z.c2), '')             AS zona_nombre,
       d.c15                               AS limite_credito,
       d.c16                               AS plazo_dias,
       (btrim(d.c13) IN ('PV-01', 'RV-01', 'RD-01', 'RM-01', 'OI-01')) AS es_interno
  FROM kepler_ods.kdud d
  LEFT JOIN kepler_ods.kduj g ON btrim(g.c1) = btrim(d.c13) AND g.sucursal = d.sucursal
  LEFT JOIN kepler_ods.kduv v ON btrim(v.c2) = btrim(d.c12) AND v.sucursal = d.sucursal
  LEFT JOIN kepler_ods.kduk z ON btrim(z.c1) = btrim(d.c14) AND z.sucursal = d.sucursal
 WHERE btrim(COALESCE(d.c2, '')) <> ''`;

exports.up = async function up(knex) {
  await knex.raw(VIEW);
  await knex.raw('GRANT SELECT ON analytics.v_customer_master TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.v_customer_master IS
    'derive-no-copy sobre kepler_ods.kdud + kduj (Grupo) + kduv (Vendedor) + kduk (Zona de CLIENTES, NO kduv que es la de vendedores y da un nombre parecido). Decodificada con dos capturas de la pantalla Datos del cliente como sonda. LLAVE = (fuente_sucursal, cliente_code) y NO deduplica: la clave es POR SUCURSAL y 141 de 1574 claves son un cliente distinto segun la plaza (el propio ERP lo advierte al pie; el personal escribe NO TOCAR en el nombre para defenderse). Un cliente real puede tener claves distintas en plazas distintas y le pueden vender varios vendedores: NO se pueden sumar clientes entre plazas. es_interno marca PV-01/RV-01/RD-01/RM-01/OI-01 = la propia tienda y las cuentas de vendedores; UNA sola (10-00 Padre Hidalgo Piso, 33 docs) explica el 80% de la venta llamada identificada. Los grupos VENTAS DE PISO <plaza> NO son internos: son clientes reales. TECHO: la facturacion a nombre es 23.1M contra 105.2M del fact, 62% televenta; el mostrador es anonimo.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_customer_master');
};
