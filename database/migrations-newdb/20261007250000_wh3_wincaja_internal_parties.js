'use strict';
/**
 * `[WH.3]` — **El padrón de contrapartes internas de Wincaja.** Quién NO es un cliente.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────────
 * La historia de Wincaja (2017–2025, 9.72 M de tickets) mete en la misma tabla tres cosas que se
 * ven iguales y no lo son: la venta a un cliente, el **traspaso a otra sucursal** y el **surtido
 * de un camión de ruta**. Las dos últimas **se vuelven a vender río abajo** — el traspaso en la
 * sucursal que lo recibe, el surtido en el `.mdb` de la ruta —, así que publicarlas como venta es
 * contar el mismo peso dos y hasta tres veces.
 *
 * Medido en Padre Hidalgo, 9 años: traspaso $301,031,704 + surtido $163,550,917 = **$464.6 M**
 * en UNA sucursal. Y el CEDIS es el caso extremo: sus ocho contrapartes son todas almacenes,
 * **$1,062,548,192 — no vende nada**.
 *
 * ── Por qué es una TABLA y no un `CASE` en una vista ─────────────────────────────────────────
 * Tres mediciones, cada una mató una regla más simple:
 *
 * 1. **No alcanza la CAJA.** El operador decía que la caja 98 era surtido a ruta y la 99 traspaso
 *    — cierto, y confirmado por los datos. Pero **64 movimientos internos ($1,026,211) se cobraron
 *    en otras cajas** y **23 ventas reales ($176,422) se cobraron en la 98/99**. La caja es el
 *    mostrador donde se tecleó, no la naturaleza del movimiento.
 * 2. **No alcanza el NOMBRE.** Canindo registra sus rutas con el nombre del repartidor
 *    (`501` = VICTOR MANUEL ZALAPA BARRIGA, 2,096 tickets), así que un patrón por nombre les
 *    publica **$64.8 M** de surtido como venta. Es la lección que `[VEC.0-6.2]` ya había pagado.
 *    ⚠️ Y al revés: `RUTA` casa dentro de **`FRUTA`** — sin anclar, ~60 clientes de frutas y
 *    verduras quedan marcados como movimiento interno.
 * 3. **No alcanza el CÓDIGO.** `25` es una ruta en varias plazas y en Canindo es
 *    **MUNICIPIO DE JACONA MICHOACAN**, un cliente con 1,515 tickets. Y `3071554` es
 *    `RD CANINDO` en Padre Hidalgo y `ALMACEN ZAMORA` en 8 Esquinas.
 *
 * ⭐ **La identidad es el par `(sucursal, tercero)`, y lo dudoso se DECLARA.** Por eso hay una
 * clase `sin_clasificar`: lo que no se pudo decidir no se descarta (perdería venta) ni se incluye
 * (publicaría doble conteo) — se publica aparte, con su monto, hasta que una persona lo revise
 * (ADR-056).
 *
 * ── Qué NO hace ──────────────────────────────────────────────────────────────────────────────
 * No borra ni filtra nada por sí sola: es un catálogo que la vista de `[WH.2b]` consulta. Y el
 * semillero de abajo nace **todo con `revisado = false`**: está DERIVADO de los datos, no firmado
 * por nadie. Firmar es de la persona que opera Compras.
 *
 * Sin RLS, patrón `analytics.*` (tenant explícito en cada consulta).
 *
 * @param { import("knex").Knex } knex
 */
const MD = '00000000-0000-0000-0000-00000000d01c';

/**
 * Semillero derivado del espejo el 2026-10-07 (sólo lectura), NO tecleado a mano:
 *   · `nombre_anclado` — el nombre en `Clientes` empieza con ALMACEN/SUC/CEDIS/RUTA/RD (anclado).
 *   · `codigo_ruta`    — el nombre no lo delata, pero el código es el de una ruta que YA publica
 *                        en `wincaja_ruta` (`RUTA-501`…`505`, `RUTA-21`…`28`, `RUTA-300`…).
 *   · `codigo_ambiguo` — el código parece de ruta pero el nombre dice otra cosa. **Se deja
 *                        `sin_clasificar` a propósito**: es justo donde una regla ciega se equivoca.
 * La última columna son los tickets observados en 2017–2025: es el peso de la decisión, para que
 * quien revise empiece por lo que mueve dinero.
 */
const SEMILLA = [
    ['00', '10', 'ALMACEN PADRE HIDALGO', 'traspaso_interno', 'nombre_anclado', 3568],
    ['00', '30', 'ALMACEN MORELIA ABASTOS', 'traspaso_interno', 'nombre_anclado', 1295],
    ['00', '40', 'ALMACEN 8 ESQUINAS', 'traspaso_interno', 'nombre_anclado', 1140],
    ['00', '50', 'ALMACEN ZAMORA CANINDO', 'traspaso_interno', 'nombre_anclado', 1047],
    ['00', '42', 'ALMACEN MERCADO DE ABASTOS LP', 'traspaso_interno', 'nombre_anclado', 794],
    ['00', '32', 'ALMACEN MORELIA MADERO', 'traspaso_interno', 'nombre_anclado', 272],
    ['00', '44', 'ALMACEN YURECUARO', 'traspaso_interno', 'nombre_anclado', 33],
    ['00', '54', 'ALMACEN ZAMORA CENTRO', 'traspaso_interno', 'nombre_anclado', 6],
    ['01', '40', 'ALMACEN 8 ESQUINAS', 'traspaso_interno', 'nombre_anclado', 2786],
    ['01', '23', 'RUTA 23', 'surtido_ruta', 'nombre_anclado', 2406],
    ['01', '21', 'RUTA 21', 'surtido_ruta', 'nombre_anclado', 2317],
    ['01', '22', 'RUTA 22', 'surtido_ruta', 'nombre_anclado', 2310],
    ['01', '26', 'RUTA 26', 'surtido_ruta', 'nombre_anclado', 2279],
    ['01', '42', 'ALMACEN ABASTOS LA PIEDAD', 'traspaso_interno', 'nombre_anclado', 2211],
    ['01', '27', 'RUTA 27', 'surtido_ruta', 'nombre_anclado', 1749],
    ['01', '28', 'RUTA 28', 'surtido_ruta', 'nombre_anclado', 789],
    ['01', '30', 'ALMACEN MORELIA ABASTOS', 'traspaso_interno', 'nombre_anclado', 713],
    ['01', '50', 'ALMACEN ZAMORA CANINDO', 'traspaso_interno', 'nombre_anclado', 657],
    ['01', '0', 'ALMACEN CEDIS', 'traspaso_interno', 'nombre_anclado', 544],
    ['01', '44', 'ALMACEN YURECUARO', 'traspaso_interno', 'nombre_anclado', 306],
    ['01', '32', 'ALMACEN MORELIA MADERO', 'traspaso_interno', 'nombre_anclado', 57],
    ['01', '050', 'ALMACEN YURECUARO', 'traspaso_interno', 'nombre_anclado', 41],
    ['01', '61', '61 RUTA 61 GDL', 'surtido_ruta', 'nombre_anclado', 39],
    ['01', '54', 'ALMACEN ZAMORA CENTRO', 'traspaso_interno', 'nombre_anclado', 15],
    ['01', '3071555', 'SUC 8 EZQUINAS', 'traspaso_interno', 'nombre_anclado', 3],
    ['01', '10', 'ALMACEN PHIDALGO', 'traspaso_interno', 'nombre_anclado', 2],
    ['01', '3071554', 'RD CANINDO', 'surtido_ruta', 'nombre_anclado', 1],
    ['02', '942', 'ALMACEN LA PIEDAD ABASTOS', 'traspaso_interno', 'nombre_anclado', 3507],
    ['02', '10', 'ALMACEN P HIDALGO', 'traspaso_interno', 'nombre_anclado', 916],
    ['02', '40', 'ALMACEN 8 ESQUINAS', 'traspaso_interno', 'nombre_anclado', 348],
    ['02', '21', 'RUTA 21', 'surtido_ruta', 'nombre_anclado', 151],
    ['02', '23', 'RUTA 23', 'surtido_ruta', 'nombre_anclado', 134],
    ['02', '27', 'RUTA 27', 'surtido_ruta', 'nombre_anclado', 119],
    ['02', '0', 'ALMACEN CEDIS', 'traspaso_interno', 'nombre_anclado', 81],
    ['02', '422037', 'ALMACEN PHIDALGO', 'traspaso_interno', 'nombre_anclado', 80],
    ['02', '30', 'ALMACEN MORELIA ABASTOS', 'traspaso_interno', 'nombre_anclado', 22],
    ['02', '50', 'ALMACEN ZAMORA CANINDO', 'traspaso_interno', 'nombre_anclado', 14],
    ['02', '421583', 'RUTA 22', 'surtido_ruta', 'nombre_anclado', 2],
    ['02', '421584', 'RUTA 26', 'surtido_ruta', 'nombre_anclado', 1],
    ['02', '42', 'ALMACEN LA PIEDAD ABASTOS', 'traspaso_interno', 'nombre_anclado', 1],
    ['02', '422936', 'ALMACEN YURECUARO', 'traspaso_interno', 'nombre_anclado', 1],
    ['03', '10', 'ALMACEN PADRE HIDALGO', 'traspaso_interno', 'nombre_anclado', 1091],
    ['03', '42', 'ALMACEN MERCADO DE ABASTOS LP', 'traspaso_interno', 'nombre_anclado', 170],
    ['03', '0', 'ALMACEN CEDIS', 'traspaso_interno', 'nombre_anclado', 59],
    ['03', '30', 'ALMACEN MORELIA ABASTOS', 'traspaso_interno', 'nombre_anclado', 45],
    ['03', '50', 'ALMACEN ZAMORA CANINDO', 'traspaso_interno', 'nombre_anclado', 22],
    ['03', '3071574', 'SUC LA PIEDAD ABASTOS', 'traspaso_interno', 'nombre_anclado', 22],
    ['03', '44', 'ALMACEN YURECUARO', 'traspaso_interno', 'nombre_anclado', 8],
    ['03', '3071554', 'ALMACEN ZAMORA', 'traspaso_interno', 'nombre_anclado', 2],
    ['03', '40', 'ALMACEN 8 ESQUINAS', 'traspaso_interno', 'nombre_anclado', 2],
    ['03', '0051', 'CEDIS', 'traspaso_interno', 'nombre_anclado', 2],
    ['03', '32', 'ALMACEN MORELIA MADERO', 'traspaso_interno', 'nombre_anclado', 1],
    ['04', '10', 'ALMACEN PADRE HIDALGO', 'traspaso_interno', 'nombre_anclado', 67],
    ['04', '40', 'ALMACEN 8 ESQUINAS', 'traspaso_interno', 'nombre_anclado', 7],
    ['04', '44', 'SUC YURECUARO', 'traspaso_interno', 'nombre_anclado', 3],
    ['04', '44564', 'ALMACEN CANINDO', 'traspaso_interno', 'nombre_anclado', 1],
    ['04', '42', 'ALMACEN ABASTOS LA PIEDAD', 'traspaso_interno', 'nombre_anclado', 1],
    ['05', '50', 'SUC CANINDO ABASTOS', 'traspaso_interno', 'nombre_anclado', 22],
    ['05', '10', 'SUC PADRE HIDALGO', 'traspaso_interno', 'nombre_anclado', 2],
    ['06', '10', 'ALMACÉN PADRE HIDALGO', 'traspaso_interno', 'nombre_anclado', 461],
    ['06', '30', 'ALMACEN MORELIA ABASTOS', 'traspaso_interno', 'nombre_anclado', 342],
    ['06', '54', 'ALMACEN DAMASO CARDENAS', 'traspaso_interno', 'nombre_anclado', 332],
    ['06', '0', 'ALMACEN CEDIS', 'traspaso_interno', 'nombre_anclado', 135],
    ['06', '40', 'ALMACEN 8 ESQUINAS', 'traspaso_interno', 'nombre_anclado', 132],
    ['06', '42', 'ALMACEN ABASTOS LA PIEDAD', 'traspaso_interno', 'nombre_anclado', 59],
    ['06', '32', 'ALMACEN MORELIA MADERO', 'traspaso_interno', 'nombre_anclado', 9],
    ['06', '0051', 'CEDIS', 'traspaso_interno', 'nombre_anclado', 5],
    ['06', '44', 'ALMACEN YURECUARO', 'traspaso_interno', 'nombre_anclado', 4],
    ['06', '50', 'ALMACEN ZAMORA CANINDO', 'traspaso_interno', 'nombre_anclado', 1],
    ['06', '501321', 'ALMACEN PHIDALGO', 'traspaso_interno', 'nombre_anclado', 1],
    ['07', '322', '32 RUTA 322', 'surtido_ruta', 'nombre_anclado', 942],
    ['07', '321', '32 RUTA 321', 'surtido_ruta', 'nombre_anclado', 745],
    ['07', '30', 'ALMACEN MORELIA ABASTOS', 'traspaso_interno', 'nombre_anclado', 741],
    ['07', '300', 'RUTA 300', 'surtido_ruta', 'nombre_anclado', 292],
    ['07', '321998', 'RUTA 301', 'surtido_ruta', 'nombre_anclado', 289],
    ['07', '0', 'ALMACEN CEDIS', 'traspaso_interno', 'nombre_anclado', 35],
    ['07', '32', 'ALMACEN MORELIA MADERO', 'traspaso_interno', 'nombre_anclado', 10],
    ['07', '10', 'ALMACEN PADRE HIDALGO', 'traspaso_interno', 'nombre_anclado', 10],
    ['07', '40', 'ALMACEN 8 ESQUINAS', 'traspaso_interno', 'nombre_anclado', 4],
    ['07', '50', 'ALMACEN ZAMORA CANINDO', 'traspaso_interno', 'nombre_anclado', 3],
    ['08', '32', 'ALMACEN MORELIA MADERO', 'traspaso_interno', 'nombre_anclado', 4842],
    ['08', '10', 'ALMACEN PADRE HIDALGO', 'traspaso_interno', 'nombre_anclado', 1088],
    ['08', '50', 'ALMACEN CANINDO ABASTOS', 'traspaso_interno', 'nombre_anclado', 694],
    ['08', '40', 'ALMACEN 8 ESQUINAS', 'traspaso_interno', 'nombre_anclado', 503],
    ['08', '0', 'ALMACEN CEDIS', 'traspaso_interno', 'nombre_anclado', 348],
    ['08', '3071672', 'RUTA 300', 'surtido_ruta', 'nombre_anclado', 257],
    ['08', '42', 'ALMACEN LA PIEDAD ABASTOS', 'traspaso_interno', 'nombre_anclado', 138],
    ['08', '3071675', 'RUTA 301', 'surtido_ruta', 'nombre_anclado', 40],
    ['08', '54', 'ALMACEN ZAMORA CENTRO', 'traspaso_interno', 'nombre_anclado', 21],
    ['08', '30', 'ALMACEN MORELIA ABASTOS', 'traspaso_interno', 'nombre_anclado', 15],
    ['08', '44', 'ALMACEN YURECUARO', 'traspaso_interno', 'nombre_anclado', 7],
    ['08', '30A', 'ALMACEN MORELIA MADERO', 'traspaso_interno', 'nombre_anclado', 5],
    ['08', '30HUMBE1', 'ALMACEN MORELIA ABASTOS', 'traspaso_interno', 'nombre_anclado', 2],
    ['08', '	', 'ALMACEN MORELIA MADERO', 'traspaso_interno', 'nombre_anclado', 1],
    ['02', '22',  'MARIO', 'surtido_ruta', 'codigo_ruta', 164],
    ['02', '26',  'ARTURO', 'surtido_ruta', 'codigo_ruta', 120],
    ['06', '501', 'VICTOR MANUEL ZALAPA BARRIGA', 'surtido_ruta', 'codigo_ruta', 2096],
    ['06', '502', 'DANIEL PADILLA ROJANO', 'surtido_ruta', 'codigo_ruta', 1733],
    ['06', '503', 'JOSE ZAVALA VILLALOBOS', 'surtido_ruta', 'codigo_ruta', 1311],
    ['06', '504', 'JOSE LUIS MUNOZ MOTA', 'surtido_ruta', 'codigo_ruta', 1272],
    ['06', '505', 'FRANCISCO MARTINEZ RAZO', 'surtido_ruta', 'codigo_ruta', 1476],
    ['08', '301', 'ROBERTO ENRIQUE OMANA BORJA', 'surtido_ruta', 'codigo_ruta', 13],
    ['06', '24',  'LUIS GABRIEL ALVAREZ MOLINA', 'sin_clasificar', 'codigo_ambiguo', 1302],
    ['06', '25',  'MUNICIPIO DE JACONA MICHOACAN', 'sin_clasificar', 'codigo_ambiguo', 1515],
];

exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.wincaja_internal_parties (
      tenant_id    uuid NOT NULL,
      sucursal     text NOT NULL,              -- codigo de tienda (01..08, 00 CEDIS)
      tercero      text NOT NULL,              -- MaestroMovAlmacen.Tercero, tal cual
      nombre       text,                       -- lo que dice Clientes.Nombre (para que se lea)
      clase        text NOT NULL,
      origen       text NOT NULL,              -- como se propuso: nombre_anclado | codigo_ruta | codigo_ambiguo | manual
      tickets_obs  integer,                    -- tickets 2017-2025: el peso de la decision
      revisado     boolean NOT NULL DEFAULT false,
      revisado_por text,
      revisado_at  timestamptz,
      nota         text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, sucursal, tercero),
      CONSTRAINT wip_clase_chk CHECK (clase IN ('venta_cliente','traspaso_interno','surtido_ruta','sin_clasificar')),
      CONSTRAINT wip_origen_chk CHECK (origen IN ('nombre_anclado','codigo_ruta','codigo_ambiguo','manual')),
      -- Firmar es un acto con autor y fecha: no se puede marcar revisado sin decir quien y cuando.
      CONSTRAINT wip_revisado_chk CHECK (revisado = false OR (revisado_por IS NOT NULL AND revisado_at IS NOT NULL))
    )`);

  await knex.raw(`COMMENT ON TABLE analytics.wincaja_internal_parties IS
    'WH.3 - Quien NO es un cliente en la historia de Wincaja. El par (sucursal, tercero) decide si un ticket es venta, traspaso a sucursal o surtido a ruta. NO alcanza la caja (64 movimientos internos se cobraron fuera de las cajas 98/99 y 23 ventas dentro), NI el nombre (Canindo registra sus rutas con el nombre del repartidor: $64.8M), NI el codigo (25 es ruta en varias plazas y en Canindo es MUNICIPIO DE JACONA). Lo dudoso vive como sin_clasificar y se DECLARA con su monto, nunca se descarta ni se incluye. Semilla derivada del espejo 2026-10-07, toda con revisado=false.'`);

  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_wip_pendientes
    ON analytics.wincaja_internal_parties (tenant_id, clase)
    WHERE revisado = false`);

  const filas = SEMILLA.map(([sucursal, tercero, nombre, clase, origen, tickets_obs]) => ({
    tenant_id: MD, sucursal, tercero, nombre, clase, origen, tickets_obs,
  }));
  // Idempotente y NO destructivo: si alguien ya revisó una fila, la semilla no le pisa el veredicto.
  await knex('analytics.wincaja_internal_parties')
    .insert(filas)
    .onConflict(['tenant_id', 'sucursal', 'tercero'])
    .merge(['nombre', 'tickets_obs', 'updated_at'])
    .whereRaw('analytics.wincaja_internal_parties.revisado = false');
};

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS analytics.wincaja_internal_parties`);
};
