import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[TDA.2]` — El mostrador dice DE DÓNDE salió el precio, y ya no publica una fila arbitraria.
 *
 * ── El defecto que se corrigió ──────────────────────────────────────────────
 * `kepler_ods.kdii` trae UNA FILA POR SUCURSAL. `/api/kp/precio` hacía `ORDER BY c1 LIMIT 1` sin
 * filtrar por plaza, así que se quedaba con la primera fila que Postgres devolviera — en orden
 * **arbitrario**. El número del mostrador podía cambiar solo cada vez que una sucursal se
 * re-sincronizaba, y podía ser el de **CEDIS** (`sucursal='00'`), que es exactamente la fila que la
 * etiquetera excluye a propósito.
 *
 * **Medido en prod el 2026-09-09: 712 de 9,348 códigos (7.6 %)** tienen más de un precio base
 * entre plazas. El comentario que vivía en `kp.service.ts` decía 385: la cifra había envejecido y
 * el defecto afectaba a casi el doble de productos de lo que el propio código declaraba.
 *
 * Y la otra mitad: la etiquetera respeta `source='manual'` (un precio corregido a mano, que el
 * importer nunca pisa) mientras el mostrador leía el ERP crudo. **Medido: hoy hay CERO filas
 * `manual` en prod**, así que ese defecto estaba latente, no activo — se arregla porque el día que
 * alguien use el override no puede ser el día en que se descubra que el mostrador lo ignora.
 *
 * Lo que este candado NO cubre —y hay que decirlo— es la pregunta de fondo: la etiquetera imprime
 * la MODA DE LA RED (excluyendo CEDIS) y el mostrador contesta por plaza. Son dos preguntas
 * distintas y cuál corresponde a la etiqueta del anaquel es una decisión de negocio, no de código.
 * Queda declarada como deuda, no resuelta por omisión.
 */

const SVC = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'apps', 'api', 'src', 'modules', 'kp', 'kp.service.ts'), 'utf8');
const CTRL = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'apps', 'api', 'src', 'modules', 'kp', 'kp.controller.ts'), 'utf8');
const FRONT = readFileSync(join(__dirname, 'verificador.service.ts'), 'utf8');
const PAGE = readFileSync(join(__dirname, 'pages', 'tienda-verificador.component.ts'), 'utf8');
/**
 * `[TDA.6]` La directiva COMPARTIDA de count-up. Se lee el archivo real y no una copia: el
 * formato con centavos (`money2`) se agregó ahí porque los tres formatos de dinero que había
 * redondean, y un ahorro de $25.77 se publicaba como $26 — otro número que el de la fuente.
 * Si alguien lo saca, este candado se pone rojo desde el consumidor.
 */
const DIRECTIVA = readFileSync(
  join(__dirname, '..', '..', 'shared', 'directives', 'count-up.directive.ts'), 'utf8');

describe('verificador · de qué plaza salió el precio', () => {
  it('el endpoint acepta sucursal', () => {
    expect(CTRL).toMatch(/getPrecio\(@Query\('q'\) q: string, @Query\('sucursal'\) sucursal\?: string\)/);
    expect(SVC).toMatch(/async getPrecio\(q: string, sucursal\?: string\)/);
  });

  // LA NEGATIVA DEL DEFECTO: si volviera el `LIMIT 1` sin orden por plaza, volvería el número
  // inestable. Se exige que el orden mande CEDIS al final y que no quede un LIMIT 1 arbitrario.
  it('ya NO se queda con una fila arbitraria', () => {
    const fn = /async getPrecio\([\s\S]*?\n  \}/.exec(SVC)![0];
    expect(fn).not.toMatch(/ORDER BY c1\s*\n\s*LIMIT 1/);
    expect(fn).toMatch(/ORDER BY \(TRIM\(sucursal::text\) = '00'\)/);
  });

  it('con sucursal contesta esa plaza; sin ella lo DECLARA', () => {
    const fn = /async getPrecio\([\s\S]*?\n  \}/.exec(SVC)![0];
    expect(fn).toMatch(/rows\.find\(\(x: any\) => x\.sucursal === suc\)/);
    // `precio_ambiguo` es el tercer estado: no es "está bien" ni "está mal", es "varía y no pude
    // acotarlo". Sin él la pantalla publicaría un número inestable como si fuera el único.
    expect(fn).toMatch(/const ambiguo = !suc && distintos\.size > 1/);
    expect(fn).toMatch(/precio_ambiguo: ambiguo/);
    // Y una plaza sin el producto no es un "no encontrado": el producto existe, no ahí.
    expect(fn).toMatch(/plaza_pedida_sin_dato/);
  });

  it('el override manual del anaquel gana, y se lee con el tenant puesto', () => {
    // [TDA.4] El filtro pasó de SQL a JS: la misma lectura trae ahora los tiers de mayoreo, así
    // que la query devuelve la fila completa y el override se decide sobre `source`. La garantía
    // vigilada es la misma: sólo un precio corregido A MANO pisa al del ERP.
    expect(SVC).toMatch(/l.source,/);
    expect(SVC).toMatch(/r.source === .manual./);
    // RLS FORCE + endpoint @Public(): sin el tenant en la MISMA tx la lectura vuelve vacía EN
    // SILENCIO si el rol es app_runtime, o sea el override desaparecería sin un solo error.
    // [TDA.4] El metodo pasa a llamarse `datosDeEtiqueta`: la misma lectura trae ahora tambien
    // los tiers de mayoreo, porque salen de la misma fila. La garantia vigilada es la misma.
    // El lookahead importa: sin él el regex paraba en el `}` del tipo de retorno multilínea y
    // el bloque examinado se quedaba en la firma, sin cuerpo — o sea el test miraba nada.
    const fn = /private async datosDeEtiqueta\([\s\S]*?\n  \}(?=\r?\n)/.exec(SVC)![0];
    expect(fn).toMatch(/SET LOCAL app\.tenant_id/);
    expect(fn).toMatch(/this\.db\.transaction/);
    // Es un refinamiento del precio, no el precio: si falla, el mostrador sigue contestando.
    // [TDA.4] El neutro ahora es `vacio` (override null + mayoreo []), no `null` pelado: la
    // misma lectura trae dos cosas. Lo que se vigila sigue siendo que el catch NO relance.
    expect(fn).toMatch(/catch[\s\S]*return vacio/);
  });

  it('el front manda la sucursal al live, no sólo al respaldo', () => {
    expect(FRONT).toMatch(/if \(sucursal\) params\['sucursal'\] = sucursal/);
    expect(FRONT).toMatch(/\{ params \}/);
  });

  // LA NEGATIVA QUE MÁS DUELE SI SE ROMPE: la procedencia tiene que resetearse en CADA resultado.
  // Pegada del producto anterior, la pantalla diría "precio corregido a mano" sobre uno que no lo
  // está — y eso es peor que no decir nada, porque suena a confirmación.
  it('la procedencia se resetea en cada resultado', () => {
    const fn = /private aplicar\(r: ResultadoBusqueda\): void \{[\s\S]*?\n  \}/.exec(PAGE)![0];
    for (const s of ['origenPrecio.set', 'precioAmbiguo.set', 'plazasDistintas.set', 'plazaSinDato.set']) {
      expect(fn).toContain(s);
    }
    // Con `??` y `=== true`: un campo ausente (el camino del respaldo no los trae) cae al valor
    // neutro, nunca a `undefined` colándose como verdadero.
    expect(fn).toMatch(/r\.origenPrecio \?\? 'kepler'/);
    expect(fn).toMatch(/r\.precioAmbiguo === true/);
  });

  it('la pantalla lo dice, no lo esconde', () => {
    expect(PAGE).toMatch(/origenPrecio\(\) === 'override_manual'/);
    expect(PAGE).toMatch(/precioAmbiguo\(\)/);
    expect(PAGE).toMatch(/plazaSinDato\(\)/);
  });
});

/**
 * `[TDA.3]` — El precio grande responde al código que se escaneó.
 *
 * Antes el número grande era **siempre `unidades[0]`**, o sea la unidad base: escanear el código
 * de la CAJA mostraba el precio de la PIEZA. Si el producto tenía base PZA y se escaneaba la pieza,
 * acertaba por coincidencia.
 *
 * El decode verificado (`services/feeds-ingest/barcode-compute.js`, contrastado contra la pantalla
 * del POS) dice que cada unidad tiene su casilla: base `c7`+`c93`, U2 `c82`+`c95`, U3 **`c85`**.
 * Este módulo se portó con `c7, c82, c93, c95, c96` — sin `c85` y con `c96`, que trae códigos
 * internos (`CB2383139`…), no EANs.
 *
 * Techo medido y dicho: **10,771 de 11,506 SKUs (93.6 %) tienen UNA sola unidad registrada**, así
 * que en 9 de cada 10 escaneos esto devuelve la única que hay. Por eso la pantalla calla ahí.
 */
describe('verificador · el precio grande sigue al barcode escaneado', () => {
  it('busca en el slot de la tercera unidad, que faltaba', () => {
    const fn = /async getPrecio\([\s\S]*?\n  \}/.exec(SVC)![0];
    expect(fn).toMatch(/TRIM\(c85::text\) = \$1/);
  });

  it('resuelve la unidad con el mapeo slot→unidad del decode verificado', () => {
    const fn = /private unidadDelCodigo\([\s\S]*?\n  \}/.exec(SVC)![0];
    expect(fn).toMatch(/igual\(r\.bc1\) \|\| igual\(r\.bc3\)/); // c7 / c93  → base (c11)
    expect(fn).toMatch(/igual\(r\.bc2\) \|\| igual\(r\.bc4\)/); // c82 / c95 → U2   (c80)
    expect(fn).toMatch(/igual\(r\.bc6\)/);                      // c85       → U3   (c83)
  });

  // `c96` trae códigos internos de Kepler, no barcodes: sirve para ENCONTRAR el producto (15 SKUs
  // tienen ahí algo de 8-14 dígitos) pero no puede decir una unidad. Si alguien lo cablea como
  // fuente de unidad, el mostrador afirmaría una unidad inventada.
  it('c96 NO se usa para deducir unidad', () => {
    const fn = /private unidadDelCodigo\([\s\S]*?\n  \}/.exec(SVC)![0];
    expect(fn).not.toMatch(/bc5/);
  });

  it('sólo afirma la unidad si además tiene precio', () => {
    // Decir "escaneaste CJA" sin poder mostrar el precio de CJA es peor que no decir nada.
    expect(SVC).toMatch(/unidad_escaneada: uEscaneada && unidades\.some\(\(x\) => x\.u === uEscaneada\)/);
    expect(FRONT).toMatch(/unidadEscaneada: uEsc && unidades\.some\(\(x\) => x\.u === uEsc\)/);
  });

  it('el snapshot offline lleva la unidad de cada barcode', () => {
    // Sin esto el kiosco SIN RED contestaba distinto que el kiosco con red: siempre la base.
    expect(SVC).toMatch(/bu: bus/);
    expect(FRONT).toMatch(/indiceUnidad/);
    // Y un respaldo viejo (sin `bu`) degrada al comportamiento anterior, no a una unidad inventada.
    expect(FRONT).toMatch(/bu\?: \(string \| null\)\[\]/);
  });

  // LA NEGATIVA CENTRAL: si el hero volviera a ser `unidades[0]` fijo, volvería el defecto.
  it('el precio grande NO es unidades[0] fijo', () => {
    expect(PAGE).not.toMatch(/precioPrincipal = computed\(\(\) => this\.producto\(\)\?\.unidades\?\.\[0\]/);
    expect(PAGE).toMatch(/unidadHero = computed/);
    expect(PAGE).toMatch(/esc && us\.find\(\(x\) => x\.u === esc\)\) \|\| us\[0\]/);
  });

  // El arreglo NO se reordena: los `factor` significan "cuántas unidades base entran acá", así que
  // poner otra unidad primero volveria falsa la leyenda de las demas ("1 CJA" para una pieza).
  it('la lista de abajo excluye la del hero y el factor se refiere a la BASE', () => {
    expect(PAGE).not.toMatch(/p\.unidades\.slice\(1\)/);
    expect(PAGE).toMatch(/otrasUnidades = computed/);
    expect(PAGE).toMatch(/u\.factor > 1 && unidadBase\(\)/);
    expect(PAGE).toMatch(/\{\{ u\.factor \}\} \{\{ unidadBase\(\) \}\}/);
  });

  it('calla cuando el producto tiene una sola unidad (el 93.6%)', () => {
    expect(PAGE).toMatch(/vaAclararUnidad = computed\(\s*\n?\s*\(\) => \(this\.producto\(\)\?\.unidades\?\.length \?\? 0\) > 1 && !!this\.unidadEscaneada\(\)/);
  });

  it('la unidad escaneada se resetea en cada resultado', () => {
    const fn = /private aplicar\(r: ResultadoBusqueda\): void \{[\s\S]*?\n  \}/.exec(PAGE)![0];
    expect(fn).toMatch(/unidadEscaneada\.set\(r\.unidadEscaneada \?\? null\)/);
  });

  // La equivalencia ("20 KG") se DERIVA de unidades[0], no del campo nuevo de la respuesta.
  // Depender del campo la hacía desaparecer con un respaldo viejo o un backend sin redeployar —
  // lo cazó `tienda-verificador.component.spec.ts`, que ya exigía ver el factor.
  it('la unidad base se deriva del arreglo, no del campo de la respuesta', () => {
    expect(PAGE).toMatch(/unidadBase = computed\(\(\) => this\.producto\(\)\?\.unidades\?\.\[0\]\?\.u \?\? null\)/);
    expect(PAGE).not.toMatch(/unidadBase\.set\(/);
  });
});

/**
 * `[TDA.4]` — El mayoreo: cuánto sale llevando más, y desde cuántas unidades.
 *
 * ── Por qué esto es el caso normal y no un extra ────────────────────────────
 * Medido en prod (2026-09-09): **8,481 de 9,020 productos (94 %) tienen mayoreo real** — 7,538 por
 * paquete, 1,563 por pieza. Aplicando las guardas sobre datos reales quedan **7,978 (88.8 %)** con
 * al menos un tier. El verificador no mostraba ninguno: leía UNA columna de la tabla de etiquetas
 * y sólo para el override manual.
 *
 * ── Las reglas NO se reinventan: se heredan de la etiquetera ────────────────
 * Cada una salió de un defecto real en producción. La que más importa es que **sin umbral real no
 * se muestra**: *"un mayoreo cuya condición de cantidad no se conoce fabrica una discusión en el
 * mostrador"*. Medido: 17 productos tienen precio de mayoreo de paquete sin umbral.
 */
describe('verificador · el mayoreo', () => {
  it('las cuatro guardas viven UNA vez, en tiersDeFila', () => {
    const fn = /private tiersDeFila\([\s\S]*?\n  \}(?=\r?\n)/.exec(SVC)![0];
    // 1. precio > 0 · 2. umbral > 1 · 3. más barato que el unitario · 4. tiene que haber unitario
    expect(fn).toMatch(/!Number\.isFinite\(p\) \|\| p <= 0/);
    expect(fn).toMatch(/!Number\.isFinite\(n\) \|\| n <= 1/);
    expect(fn).toMatch(/o\.base > 0\) \|\| p >= o\.base/);
  });

  /**
   * `[TDA.7]` LA BASE DE CADA ESCALÓN. Es una compuerta de dinero, no de estilo.
   *
   * `wholesale_pack_price` trae DOS unidades en la misma columna. Medido en prod el 2026-09-10
   * prestándole un precio conocido a cada conjunto:
   *  · base PAQ/CJA (6,462) -> `w / piece_price` mediana **0.92**: el paquete ES la base.
   *  · base pieza CON paquete registrado (380) -> `w / pack_price` mediana **0.93**, y
   *    `w / piece_price` = **8.99** (≈ `pack_size`). Comparar contra la pieza daba un
   *    "descuento" de **−798 %**: 376 de 380 escalones se caían por la guarda de "más barato" y
   *    los 4 que pasaban publicaban un ahorro que mezclaba paquete con pieza.
   *
   * Si alguien vuelve a usar una sola base para los dos escalones, esto se pone rojo.
   */
  it('el mayoreo de paquete se compara contra el precio del PAQUETE, no contra la pieza', () => {
    const fn = /private tiersDeFila\([\s\S]*?\n  \}(?=\r?\n)/.exec(SVC)![0];
    // La base agrupada se decide igual que en la etiquetera: sólo PAQ/CJA.
    expect(fn).toMatch(/baseAgrupada = ub === 'PAQ' \|\| ub === 'CJA'/);
    // Y hay un "paquete real" que exige las DOS columnas, no una.
    expect(fn).toMatch(/paqueteReal = !baseAgrupada && packPrice > 0 && packSize > 0/);
    // El escalón de paquete elige base según eso. Una sola base para ambos = rojo.
    expect(fn).toMatch(/base: paqueteReal \? packPrice : precioBase/);
    // Un producto que se vende por paquete no tiene "pieza suelta" que mayorear.
    expect(fn).toMatch(/baseAgrupada \? null : tier\(\{/);
    // Y las columnas TIENEN que venir en las dos consultas: sin ellas el arreglo es un no-op
    // silencioso (`undefined` -> paqueteReal false -> camino viejo). Es el defecto del freno que
    // pregunta por un campo que nadie trajo.
    const selects = SVC.match(/l\.pack_price,\s+l\.pack_size/g) || [];
    expect(selects.length).toBe(2);
  });

  /** `[TDA.7]` La unidad del monto viaja con el escalón; estaba cableada a `c/u`. */
  it('la unidad del monto la declara el escalón, no la plantilla', () => {
    expect(PAGE).toMatch(/class="vp-may-cu">\{\{ t\.unidad_monto \}\}/);
    expect(PAGE).not.toMatch(/class="vp-may-cu">c\/u</);
    const fn = /private tiersDeFila\([\s\S]*?\n  \}(?=\r?\n)/.exec(SVC)![0];
    expect(fn).toMatch(/unidad_monto: paqueteReal \? 'por paquete' : 'c\/u'/);
  });

  // LA NEGATIVA QUE MÁS DUELE: un umbral inventado. La etiquetera ponía "desde 3" por default y
  // afirmaba una condición que la caja no iba a respetar.
  it('NUNCA inventa un umbral', () => {
    const fn = /private tiersDeFila\([\s\S]*?\n  \}(?=\r?\n)/.exec(SVC)![0];
    expect(fn).not.toMatch(/\|\| 3/);
    expect(fn).not.toMatch(/desde: 3/);
    // Sin umbral el tier no se construye: devuelve null y se filtra.
    expect(fn).toMatch(/\.filter\(\(x\): x is MayoreoTier => x !== null\)/);
  });

  // El realce separa el DATO de la SEÑAL: 366 tiers tienen menos de 1 % de descuento y pintarlos
  // como oferta sería mentir con el color.
  it('el realce es umbral aparte, no el mismo que mostrar', () => {
    expect(SVC).toMatch(/const MAYOREO_MIN_DESC = 0\.01/);
    expect(SVC).toMatch(/realza: desc >= MAYOREO_MIN_DESC/);
    // Y la pantalla lo respeta: el ahorro en verde SÓLO si realza. `[TDA.7]` suma la segunda
    // condición — y sólo en el escalón de la unidad leída, para no poner dos ahorros grandes
    // compitiendo, uno de ellos en otra unidad.
    expect(PAGE).toMatch(/@if \(t\.realza && x\.destacado\) \{/);
  });

  it('una definición para los dos modos: en vivo y sin red', () => {
    // `tiersDeFila` lo usan la consulta de UN producto y el lote del snapshot. Si la regla del 1 %
    // viviera dos veces, el kiosco sin red contestaría distinto que el kiosco con red.
    expect(SVC).toMatch(/this\.tiersDeFila\(r\)/);
    const lote = /private async mayoreoDeTodos\([\s\S]*?\n  \}(?=\r?\n)/.exec(SVC)![0];
    expect(lote).toMatch(/this\.tiersDeFila\(r\)/);
  });

  it('el snapshot va compacto, y su inversa vive junto a la compresora', () => {
    // Con nombres largos el snapshot crecía 1,386 KB crudos: los nombres eran el 51 % de los bytes.
    expect(SVC).toMatch(/et\.mayoreo\.map\(compactarTier\)/);
    expect(FRONT).toMatch(/\(item\.m \|\| \[\]\)\.map\(expandirTier\)/);
    const CONTRATO = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'libs', 'contracts', 'src', 'http', 'store.contract.ts'), 'utf8');
    expect(CONTRATO).toMatch(/export function compactarTier/);
    expect(CONTRATO).toMatch(/export function expandirTier/);
  });

  it('la pantalla pinta, no decide', () => {
    // El computed no re-filtra: si lo hiciera, la condición del mayoreo viviría en dos lugares.
    expect(PAGE).toMatch(/mayoreo = computed\(\(\) => this\.producto\(\)\?\.mayoreo \?\? \[\]\)/);
  });

  it('el ahorro se muestra, que es lo que cierra la venta', () => {
    expect(SVC).toMatch(/ahorro_en_el_minimo: redondea\(\(o\.base - p\) \* nn\)/);
    expect(PAGE).toMatch(/Te ahorras/);
  });

  // Colorimetría (DESIGN.md 5): el color de marca va en UNA cosa —el umbral, que es el dato
  // accionable—, el ahorro usa el semántico `--ok-*`, y nada de hex inline.
  it('el color sigue el sistema: marca en el umbral, semántico en el ahorro', () => {
    expect(PAGE).toMatch(/\.vp-may-n \{[\s\S]*?var\(--action\)/);
    expect(PAGE).toMatch(/\.vp-may-ahorro[\s\S]*?var\(--ok-/);
    const css = /\.vp-mayoreo \{[\s\S]*?\.vp-gramaje/.exec(PAGE)![0];
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  // Movimiento (tokens.css BINDING): sólo transform+opacity, con TOKEN de duración, y nunca sobre
  // la cifra — en un mostrador el precio tiene que ser legible de inmediato, no al final de una
  // transición. Por eso tampoco hay count-up.
  /**
   * `[TDA.6]` Esta aserción estaba clavada al STRING de la implementación
   * (`vpEntra` + `translateY(4px)`), así que se rompía con cualquier rediseño y **no** cazaba
   * lo único que el contrato prohíbe: una duración sobre el techo, una propiedad que hace
   * reflow, o una librería. Ahora afirma el INVARIANTE.
   *
   * Y suma el que faltaba y es de cobro, no de estilo: el techo de 350 ms **contando el
   * retardo**. Un escalonado se sale del presupuesto sumando delays, no duraciones, y nada
   * lo miraba.
   */
  it('el movimiento respeta el techo (retardo incluido), sólo transform/opacity, y cero librerías', () => {
    // La escala BINDING de tokens.css. Si alguien inventa una duración fuera de la escala,
    // no está acá y la aserción de abajo la marca.
    const ESCALA: Record<string, number> = {
      '--dur-micro': 120, '--dur-short': 150, '--dur-standard': 250, '--dur-max': 350,
    };

    const decls = [...PAGE.matchAll(/animation:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(decls.length).toBeGreaterThan(3); // piso: si el regex deja de casar, no se pone verde en vacío

    for (const d of decls) {
      const tok = d.match(/var\((--dur-[a-z]+)/);
      expect(tok).not.toBeNull();
      const dur = ESCALA[tok![1]];
      expect(dur).toBeDefined();
      // El retardo es el 2º tiempo de la shorthand; sin él, 0.
      const delay = Number((d.match(/\)\s+(\d+)ms\b/) || [, '0'])[1]);
      expect(dur + delay).toBeLessThanOrEqual(ESCALA['--dur-max']);
    }

    // Los keyframes de esta pantalla sólo mueven transform/opacity: nada de width/height/
    // margin/padding/box-shadow, que hacen reflow (DESIGN.md §Motion).
    for (const kf of PAGE.matchAll(/@keyframes\s+vp[A-Za-z]+\s*\{([^@]*?)\}\s*\n/g)) {
      const props = [...kf[1].matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      expect(props.length).toBeGreaterThan(0);
      for (const p of props) expect(['opacity', 'transform']).toContain(p);
    }

    // El mecanismo de reinicio: dos juegos de keyframes + la clase que alterna. Sin esto la
    // entrada corre una sola vez por turno, porque la tarjeta es el mismo nodo del DOM.
    expect(PAGE).toMatch(/@keyframes vpEntraA/);
    expect(PAGE).toMatch(/@keyframes vpEntraB/);
    expect(PAGE).toMatch(/\[class\.is-pase-b\]="pase\(\) % 2 === 1"/);

    // Nada de librería de animación en esta pantalla (§U las nombra: anime.js/framer no entran).
    expect(PAGE).not.toMatch(/from 'gsap'|import\('gsap'\)|animejs|from 'motion'/);
  });

  /**
   * `[TDA.6]` El count-up: PERMITIDO en el ahorro, PROHIBIDO en los precios.
   *
   * Esta aserción decía `not.toMatch(/appCountUp|CountUpDirective/)` — prohibido en toda la
   * pantalla. El motivo escrito era bueno («en un mostrador el precio tiene que ser legible
   * de inmediato») pero la regla era más ancha que su motivo: aplica a las cifras que se le
   * leen en voz alta a una clienta, no al ahorro, que es la invitación.
   *
   * Lo que se afirma ahora es la distinción, no la ausencia: si alguien le pone count-up al
   * precio unitario o al de mayoreo, esto se pone rojo.
   */
  it('el count-up sólo toca el ahorro, nunca un precio', () => {
    // Está, y usa la directiva COMPARTIDA (no una copia local).
    expect(PAGE).toMatch(/\[appCountUp\]="t\.ahorro_en_el_minimo"/);
    expect(PAGE).toMatch(/from '\.\.\/\.\.\/\.\.\/shared\/directives\/count-up\.directive'/);
    // Con centavos: los otros formatos de dinero de la directiva redondean, y $25.77 saldría
    // $26 — otro número que el de la fuente.
    expect(PAGE).toMatch(/countUpFormat="money2"/);
    expect(DIRECTIVA).toMatch(/case 'money2'/);
    expect(DIRECTIVA).toMatch(/minimumFractionDigits:\s*2/);
    // Live: sin esto la directiva anima UNA vez en la vida del nodo y el 2º escaneo del turno
    // no contaría (la tarjeta no se recrea).
    expect(PAGE).toMatch(/\[appCountUpLive\]="true"/);

    // Y la línea que no se cruza: ninguna cifra de PRECIO se anima por dentro.
    const enHero = /class="vp-precio"[^>]*appCountUp|appCountUp[^>]*class="vp-precio"/;
    const enMayoreo = /class="vp-may-monto"[^>]*appCountUp|appCountUp[^>]*class="vp-may-monto"/;
    expect(PAGE).not.toMatch(enHero);
    expect(PAGE).not.toMatch(enMayoreo);
    // Los dos precios siguen siendo interpolación directa: visibles en el primer fotograma.
    expect(PAGE).toMatch(/class="vp-precio">\{\{ money\(precioPrincipal\(\)\) \}\}/);
    expect(PAGE).toMatch(/class="vp-may-monto">\{\{ money\(t\.precio_con_iva\) \}\}/);
  });

  /**
   * `[TDA.7]` RETIRO LA MITAD DE ESTA COMPUERTA QUE ERA MI OPINIÓN.
   *
   * Afirmaba `hero.max > may.max` y `hero.min > may.min`: el precio unitario tenía que ser
   * SIEMPRE la cifra más grande. Se apoyaba en §O.3 —*"el TOTAL y las acciones de cobro dominan
   * sobre cualquier otra métrica"*— y esa cita **no aplica acá**: esta pantalla no tiene TOTAL,
   * es una consulta de precio, no un carrito. O sea que la regla no contestaba la pregunta y el
   * test la estaba contestando por su cuenta.
   *
   * El costo era real: 0Sistemas pidió énfasis en el mayoreo, y este candado hacía **fallar el
   * build** si alguien se lo daba. Un test que vuelve rojo lo que pide el negocio, con una cita
   * que no viene al caso, no es una compuerta: es una opinión con disfraz.
   *
   * Lo que SÍ protege del cobro mal se queda, y es lo de abajo: la condición ("llevando 3 o
   * más") nunca en letra chica, y la cifra grande es la de la unidad que se ESCANEÓ — que es la
   * regla que dictó 0Sistemas y la que de verdad cierra el hueco, porque quien lleva una pieza
   * ve en grande el precio de la pieza.
   */
  it('la condición no se susurra, y los clamp respetan el techo de zoom', () => {
    const clampDe = (clase: string) => {
      const bloque = PAGE.slice(PAGE.indexOf(`.${clase} {`));
      const m = bloque.match(/font-size:\s*clamp\(([^)]+)\)/);
      expect(m).not.toBeNull();
      const partes = m![1].split(',').map((s) => s.trim());
      return { min: parseFloat(partes[0]), max: parseFloat(partes[2]) };
    };
    // Regla de clamp de DESIGN.md 9: el máximo no puede pasar 2.5x el mínimo (revienta el zoom
    // al 200 %, WCAG 1.4.4). Esta sí es una regla del sistema, no un criterio mío.
    for (const clase of ['vp-precio', 'vp-may-monto']) {
      const c = clampDe(clase);
      expect(c.max / c.min).toBeLessThanOrEqual(2.5);
    }

    // La condición viaja al tamaño del cuerpo, no en letra chica: si el monto de mayoreo crece y
    // la condición se susurra, alguien que lleva UNA pieza lee el precio de tres.
    const cond = PAGE.slice(PAGE.indexOf('.vp-may-cond {'), PAGE.indexOf('.vp-may-cond > i'));
    expect(cond).toMatch(/font-size:\s*var\(--fs-body/);
    expect(cond).not.toMatch(/font-size:\s*var\(--fs-(xs|micro)/);
  });

  /**
   * `[TDA.7]` La jerarquía la decide el CÓDIGO DE BARRAS que se leyó.
   *
   * El comportamiento se prueba renderizando, en `tienda-verificador.component.spec.ts`. Acá se
   * afirma lo que un test de render no ve: que la decisión reusa el mecanismo de `[TDA.3]`
   * (`unidadHero`) en vez de inventar una segunda resolución de unidad, y que el escalón que no
   * corresponde se ATENÚA en vez de competir.
   */
  it('el escalón destacado sale de la unidad escaneada, reusando unidadHero', () => {
    expect(PAGE).toMatch(/mayoreoConFoco = computed/);
    expect(PAGE).toMatch(/this\.unidadHero\(\)\?\.u === this\.unidadBase\(\)/);
    // El backend dice a qué unidad pertenece cada escalón; la pantalla sólo compara.
    expect(PAGE).toMatch(/\(t\.aplica_a \?\? 'base'\) === quiere/);
    // Y el que no está en foco pierde tamaño: su monto puede estar en otra unidad que el hero.
    expect(PAGE).toMatch(/\.vp-may-row:not\(\.is-foco\) \.vp-may-monto/);
  });

  /**
   * `[TDA.7]` La compuerta on-view no puede decidir si el número es correcto.
   *
   * La directiva compartida escribía `0` y esperaba al `IntersectionObserver`: si la pastilla no
   * llegaba a estar en viewport, el ahorro se quedaba en **`$0.00`** — y `prefers-reduced-motion`
   * no rescataba, porque la compuerta de visibilidad corre antes que la del movimiento. Es
   * dibujar un cero por no haber podido medir, lo que ADR-056 prohíbe por nombre.
   */
  it('el count-up no gatea la CORRECTEZA del importe en la intersección', () => {
    // En modo live (dato autoritativo) no se espera intersección.
    expect(DIRECTIVA).toMatch(/if \(this\.appCountUpLive \|\| typeof IntersectionObserver === 'undefined'\)/);
    // Y `maybeStart` ya no exige el observador, que era lo que congelaba el valor inicial.
    expect(DIRECTIVA).not.toMatch(/if \(this\.done \|\| !this\.visible \|\| !this\.io\) return;/);
    expect(DIRECTIVA).toMatch(/if \(this\.done \|\| !this\.visible\) return;/);
  });

  /**
   * `[TDA.7]` La curva: `--ease-spring` está acotada por DESIGN.md §Motion a "sólo gestos
   * drag-to-dismiss". La defendí con "ya existe en tokens.css" — existir no es estar permitido.
   */
  it('las entradas usan la curva de ENTRADA, no la de gesto', () => {
    expect(PAGE).not.toMatch(/animation:[^;]*--ease-spring/);
    expect(PAGE).toMatch(/animation: var\(--vp-in\) var\(--dur-short, 150ms\) var\(--ease-decelerate/);
  });
});
