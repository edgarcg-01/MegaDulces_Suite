'use strict';
/**
 * `[PR.M2]` — **C1 dejo de ser cierta, y nacen H3/H4: la posicion de mercado.**
 *
 * ── Lo que cambio ──────────────────────────────────────────────────────────────────────────
 * `C1 · Segmento / grupo par` es una senal **nucleo** y decia *"no existe segmento formal; hay
 * grupo, zona y vendedor del ERP sin unificar"*. Eso era verdad mientras se mirara adentro de
 * casa. **Afuera si existe, y se paga todos los meses**: la entrega de ISCAM trae una taxonomia
 * de seis niveles (Segmento → Categoria → SubCategoria → Fabricante → Marca → SubMarca) con el
 * **codigo de barras** al lado, que es la unica llave que cruza exacto contra nuestro catalogo.
 *
 * Medido el 2026-10-01 sobre la entrega de julio: **3,895 codigos** que alcanzan **1,574 SKUs
 * nuestros y $42.85M de venta de 90 dias**.
 *
 * ⭐ Y de paso trae la **marca de consumo** ("DE LA ROSA", "MENTOS", "RICOLINO"), que el catalogo
 * no tiene: `catalog.brands` guarda la razon social del PROVEEDOR -- entre las cinco que mas
 * venden hay una fabrica de bolsas y una de polietileno.
 *
 * ── ⛔ Por que C1 NO pasa a `disponible` ───────────────────────────────────────────────────
 * Seria el estado correcto por significado -- la fuente existe y nadie la lee -- pero el candado
 * de la capa 2 (`test-newdb-price-signals.js`) exige **cero senales en `disponible`**, y abrir
 * ese cero es la decision de quien cablee la senal, no de quien carga el dato. Asi que C1 sigue
 * en `no_existe` **con el motivo corregido**: lo que era "no existe" pasa a ser "existe, esta
 * cargada, y falta cablearla".
 *
 * ⚠️ Un motivo que dejo de ser cierto es peor que un motivo ausente: manda a la proxima persona
 *    a construir desde cero algo que ya esta sobre la mesa.
 *
 * ── Y dos senales que el registro no contemplaba ───────────────────────────────────────────
 * Las 46 miran hacia adentro. ISCAM responde algo que ninguna puede: **cuanto del mercado somos
 * y si esa parte sube o baja**. No es cosmetico para un motor de precio:
 *
 *   · subir el precio donde tenemos el **16.12 %** de la categoria (Desechables) es fijar precio;
 *   · subir donde tenemos el **2.04 %** (Chicle) es seguirlo;
 *   · y subir en **Frituras**, donde el mercado crecio **+19.1 %** y nosotros caimos **-14.3 %**
 *     perdiendo **3.11 pp** de share, es echarle nafta al fuego.
 *
 * Eso ataca de frente la certeza `efecto_no_medido`: no mide la elasticidad, pero dice si ya
 * venimos perdiendo terreno antes de tocar el precio.
 */

const T = 'analytics.price_signal_registry';

const MOTIVO_C1 = [
  'CORREGIDO 2026-10-01: el motivo anterior ("no existe segmento formal") dejo de ser cierto.',
  'Existe y se paga todos los meses: la entrega de ISCAM trae una taxonomia de seis niveles',
  '(Segmento > Categoria > SubCategoria > Fabricante > Marca > SubMarca) con el CODIGO DE BARRAS',
  'al lado, que es la unica llave que cruza exacto contra catalog.products. Cargada en',
  'analytics.iscam_taxonomy: 3,895 codigos que alcanzan 1,574 SKUs nuestros y $42.85M de venta',
  'de 90 dias. Trae ademas la MARCA DE CONSUMO, que catalog.brands no tiene (ahi vive la razon',
  'social del proveedor: entre las cinco que mas venden hay una fabrica de bolsas y una de',
  'polietileno).',
  'FALTA: cablearla a v_price_signals para que el motor pueda comparar un SKU contra los de su',
  'misma categoria. Se deja en no_existe y NO en disponible porque el candado de la capa 2 exige',
  'cero disponibles, y abrir ese cero le toca a quien cablee, no a quien cargo el dato.',
].join(' ');

const H3 = {
  clave: 'H3',
  familia: 'estrategia',
  nombre: 'Participación de mercado de la categoría',
  definicion:
    'Qué parte de su categoría vendemos nosotros, segun la medicion mensual de ISCAM. Separa '
    + 'fijar precio de seguirlo: con 16% de una categoria el precio lo ponemos, con 2% lo tomamos.',
  unidad: 'pct',
  direccion: 'mas_es_mejor',
  estado: 'no_existe',
  cobertura_pct: 0,
  cobertura_medida_al: '2026-10-01',
  // ⛔ fuente_objeto/columna van en NULL a proposito: el registro tiene la regla de que una
  //    senal NO cableada no apunte a una columna, porque apuntar dice "leela aca" y nadie la lee.
  //    La fuente se nombra en el motivo, que es donde se busca cuando se va a cablear.
  fuente_objeto: null,
  fuente_columna: null,
  motivo_ausencia: [
    'la fuente EXISTE y esta cargada (analytics.v_iscam_share, entrega de julio 2026), pero no',
    'esta cableada a v_price_signals. Medido: 36.1% de la venta de 90 dias ($40.98M de $113.51M)',
    'alcanza un numero de share por el puente de codigo de barras.',
    'DOS ADVERTENCIAS QUE VIAJAN CON EL DATO:',
    '(1) el numerador viene INFLADO: a ISCAM se le trasladan todas las salidas, traspasos entre',
    'sucursales incluidos (deuda tecnica de Wincaja). La brecha medida contra sales_daily es de',
    '$19.5M a $21.6M por mes, estable en cinco meses. Si la distorsion fuera solo nuestra el share',
    'de Region III seria ~3.80% y no 5.36%; si los demas mayoristas del panel cargan la misma',
    'deuda, esta bien. Cual de las dos es NO se puede saber desde el archivo.',
    '(2) el share DEPENDE DEL UNIVERSO y las dos cifras son ciertas: 5.36% en Mayoreo Puro, que es',
    'nuestro canal, y 3.80% en el mayoreo total. La diferencia son $426.8M de mercado medido en',
    'subcanales donde no vendemos nada (Autoservicios Propios del Mayoreo, Cash & Carry). Quien la',
    'cablee tiene que elegir cual publica y decirlo.',
  ].join(' '),
  peso_max: 0,
  nucleo: false,
};

const H4 = {
  clave: 'H4',
  familia: 'estrategia',
  nombre: 'Terreno ganado o perdido contra el mercado',
  definicion:
    'Cuanto se movio nuestra participacion contra el periodo anterior, y como crecio el mercado '
    + 'SIN nosotros. Dice si el terreno que perdemos se lo esta llevando alguien o si la categoria '
    + 'entera se cae.',
  unidad: 'pct',
  direccion: 'mas_es_mejor',
  estado: 'no_existe',
  cobertura_pct: 0,
  cobertura_medida_al: '2026-10-01',
  fuente_objeto: null,
  fuente_columna: null,
  motivo_ausencia: [
    'la fuente EXISTE y esta cargada pero no esta cableada. Es la senal que mas le falta al motor:',
    'hoy propone subir el precio mirando solo numeros propios.',
    'MEDIDO en julio 2026, Region III, canal propio: BOTANAS/Frituras -- el mercado crecio +19.1%,',
    'nosotros caimos -14.3%, y perdimos 3.11 pp de share sobre una categoria de $57.3M. Proponer',
    'un alza ahi sin mirar esto es echarle nafta al fuego.',
    'Otros tres del mismo mes: CONFITERIA/Grenetina (mercado +14.8%, nosotros -5.7%, -1.20 pp),',
    'CONFITERIA/Chocolate (mercado +6.8%, nosotros -5.4%, -0.49 pp, y es la categoria mas grande',
    'con $306.8M) y CONFITERIA/Dulce Tipico (mercado +2.2%, nosotros -5.6%, -1.02 pp, y es una de',
    'nuestras plazas fuertes con 12.36% de share).',
    'Hereda las dos advertencias de H3: numerador inflado por traspasos, y el share depende del',
    'universo que se elija.',
  ].join(' '),
  peso_max: 0,
  nucleo: false,
};

const COLS = ['familia', 'nombre', 'definicion', 'unidad', 'direccion', 'estado',
  'cobertura_pct', 'cobertura_medida_al', 'fuente_objeto', 'fuente_columna',
  'motivo_ausencia', 'peso_max', 'nucleo', 'updated_at'];

exports.up = async function up(knex) {
  await knex.raw("SET LOCAL lock_timeout = '5s'");

  const c1 = await knex(T).select('estado', 'motivo_ausencia').where({ clave: 'C1' }).first();
  if (!c1) throw new Error('[PR.M2] no existe C1 en el registro');
  // ⚠️ Si alguien ya la cableo, este motivo la contradiria. Se comprueba antes de pisar.
  if (c1.estado === 'cableada') throw new Error('[PR.M2] C1 ya esta cableada: revisar antes de tocar su motivo');

  await knex(T).where({ clave: 'C1' }).update({
    motivo_ausencia: MOTIVO_C1,
    cobertura_medida_al: '2026-10-01',
    updated_at: knex.fn.now(),
  });

  // ⛔⛔ Reparacion de un error propio: H1 y H2 nacieron con fuente_objeto/fuente_columna
  //    puestas estando en `refutada`. El registro tiene una regla -- una senal NO cableada no
  //    apunta a una columna -- y su candado la vigila; las agregue en tres commits y no volvi a
  //    correrlo. Apuntar a una columna dice "leela aca", y nadie la lee.
  await knex(T).whereIn('clave', ['H1', 'H2'])
    .update({ fuente_objeto: null, fuente_columna: null, updated_at: knex.fn.now() });

  for (const fila of [H3, H4]) {
    await knex(T).insert({ ...fila, updated_at: knex.fn.now() })
      .onConflict('clave').merge(COLS);
  }

  // ⭐ Se comprueba lo escrito, y sobre todo que el candado de la capa 2 siga verde.
  const [{ disp }] = (await knex.raw(
    `SELECT count(*) FILTER (WHERE estado='disponible')::int AS disp FROM ${T}`)).rows;
  if (disp !== 0) throw new Error(`[PR.M2] quedaron ${disp} senales en disponible: rompe el candado de la capa 2`);

  // ⭐ La regla que esta migracion vino a reparar: que no vuelva a romperse en esta misma corrida.
  const [{ apuntan }] = (await knex.raw(
    `SELECT count(*)::int AS apuntan FROM ${T} WHERE estado <> 'cableada' AND fuente_columna IS NOT NULL`)).rows;
  if (apuntan !== 0) throw new Error(`[PR.M2] ${apuntan} senales NO cableadas apuntan a una columna`);

  const [{ n }] = (await knex.raw(`SELECT count(*)::int AS n FROM ${T}`)).rows;
  // eslint-disable-next-line no-console
  console.log(`[PR.M2] C1 con motivo corregido · H3/H4 registradas · ${n} senales en total.`);
};

exports.down = async function down(knex) {
  await knex.raw("SET LOCAL lock_timeout = '5s'");
  await knex(T).whereIn('clave', ['H3', 'H4']).del();
  await knex(T).where({ clave: 'C1' }).update({
    motivo_ausencia: 'no existe segmento formal; hay grupo, zona y vendedor del ERP sin unificar',
    fuente_objeto: null, fuente_columna: null, updated_at: knex.fn.now(),
  });
};
