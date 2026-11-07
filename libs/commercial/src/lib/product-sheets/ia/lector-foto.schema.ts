/**
 * `[NP.7.L.11d]` Lo que se le manda al modelo junto con la foto: el JSON Schema de la respuesta
 * (`output_config.format`) y el system prompt. Los dos son ESTABLES (sin fechas, ids ni SKU) porque el
 * prefijo se cachea (`cachePrefix`) y el esquema se compila una vez y se reusa 24 h del lado de la API.
 *
 * ── Por qué el esquema no es `LecturaFotoV1` campo por campo ────────────────────────────────────────
 * ⛔ La API de structured outputs admite **a lo más 16 parámetros con unión** (`anyOf` o `type: [.., 'null']`)
 * sumando todo el esquema, y a lo más 24 opcionales; pasarse da 400. Fuente: la documentación pública de
 * structured outputs, leída el 2026-11-04 (⚠️ NO MEDIDO contra la API: la IA no se enciende hasta D6). `LecturaFotoV1` tiene 33 cosas anulables (los 20 campos,
 * los 10 renglones de nutrición, tipo y material del empaque y `motivo_no_legible`). Por eso, en el CABLE:
 *   - los 20 campos van SIEMPRE presentes y «ausente» se dice con **evidencia vacía** (y valor de relleno:
 *     "", 0, []); `normalizarLectura` convierte cada campo con evidencia vacía en `null`, que es lo que el
 *     contrato guarda (regla 11: lo que no se ve es `null`, nunca un cero). Es la misma regla que el
 *     contrato ya fija («evidencia vacía no se acepta»), aplicada en la frontera;
 *   - las uniones con `null` quedan sólo donde el 0 es un dato real (renglones de la tabla nutrimental: un
 *     «0 g de grasas trans» impreso NO es «no aparece»), en tipo/material del empaque y en
 *     `motivo_no_legible`: **13 de 16**. La prueba `lector-foto.schema.spec.ts` cuenta y se pone roja al pasar.
 *     `rostro_visible` es booleano obligatorio, NO anulable: no suma al conteo (un «no sé» no existe en el
 *     cable; si falta, `normalizarLectura` invalida la lectura, nunca supone `false`).
 *
 * Orden de las propiedades: la API respeta el del esquema (todas son requeridas). Va primero lo que decide
 * si la foto sirve (`persona_visible` → `rostro_visible`, `legible`), después la transcripción (`texto_literal`)
 * y al final lo derivado; dentro de cada campo, la **evidencia antes que el valor**: el modelo cita y luego
 * interpreta. Por eso `persona_visible` (lo amplio: ¿hay alguna parte de una persona?) va ANTES que
 * `rostro_visible` (lo que bloquea: ¿esa persona muestra la cara?).
 */
import {
  ALERGENOS,
  LECTURA_FOTO_VERSION,
  LEYENDAS_NOM051,
  NIVELES_FISICOS,
  SELLOS_NOM051,
  UNIDADES_CONTENIDO,
} from './lectura-foto.contract';

type Esquema = Record<string, unknown>;

const NULO: Esquema = { type: 'null' };
const anulable = (s: Esquema): Esquema => ({ anyOf: [s, NULO] });
const texto: Esquema = { type: 'string' };
const numero: Esquema = { type: 'number' };
const enumerado = (valores: readonly string[]): Esquema => ({ type: 'string', enum: [...valores] });
const lista = (items: Esquema): Esquema => ({ type: 'array', items });

/** Objeto cerrado: todas sus propiedades requeridas y nada extra (lo exige structured outputs). */
function objeto(propiedades: Record<string, Esquema>): Esquema {
  return { type: 'object', properties: propiedades, required: Object.keys(propiedades), additionalProperties: false };
}

const CONFIANZA: Esquema = enumerado(['alta', 'media', 'baja']);

/** Un campo leído en el cable: evidencia, valor y confianza. Ausente = evidencia "". */
const campo = (valor: Esquema): Esquema => objeto({ evidencia: texto, valor, confianza: CONFIANZA });

const CANTIDAD: Esquema = objeto({ cantidad: numero, unidad: enumerado(UNIDADES_CONTENIDO) });

const NUTRICION: Esquema = objeto({
  base: CANTIDAD,
  kcal: anulable(numero),
  proteinas_g: anulable(numero),
  grasas_totales_g: anulable(numero),
  grasas_saturadas_g: anulable(numero),
  grasas_trans_mg: anulable(numero),
  carbohidratos_g: anulable(numero),
  azucares_g: anulable(numero),
  azucares_anadidos_g: anulable(numero),
  fibra_g: anulable(numero),
  sodio_mg: anulable(numero),
});

const EMPAQUE: Esquema = objeto({ tipo: anulable(texto), material: anulable(texto), colores: lista(texto) });

/** El JSON Schema de `output_config.format`: la forma de cable de `LecturaFotoV1` (ver arriba). */
export const ESQUEMA_LECTURA_FOTO: Esquema = objeto({
  version: { type: 'string', const: LECTURA_FOTO_VERSION },
  persona_visible: { type: 'boolean' },
  rostro_visible: { type: 'boolean' },
  legible: enumerado(['si', 'parcial', 'no']),
  motivo_no_legible: anulable(texto),
  texto_literal: lista(texto),
  nivel_fisico: campo(enumerado(NIVELES_FISICOS)),
  campos: objeto({
    marca: campo(texto),
    denominacion: campo(texto),
    nombre_comercial: campo(texto),
    variante: campo(texto),
    edicion: campo(texto),
    fabricante: campo(texto),
    contenido_neto: campo(CANTIDAD),
    piezas: campo(numero),
    contenido_por_pieza: campo(CANTIDAD),
    sellos_nom051: campo(lista(enumerado(SELLOS_NOM051))),
    leyendas_nom051: campo(lista(enumerado(LEYENDAS_NOM051))),
    alergenos: campo(lista(enumerado(ALERGENOS))),
    puede_contener: campo(lista(enumerado(ALERGENOS))),
    alergenos_otros: campo(lista(texto)),
    ingredientes: campo(texto),
    nutricion: campo(NUTRICION),
    codigo_barras_visible: campo(texto),
    pais_origen: campo(texto),
    conservacion: campo(texto),
    empaque: campo(EMPAQUE),
  }),
});

/** Tope de la API para parámetros con unión en structured outputs (docs públicas, leídas el 2026-11-04). */
export const TOPE_UNIONES_STRUCTURED_OUTPUTS = 16;

/**
 * El system prompt del lector. ⛔ ESTABLE: nada que cambie entre llamadas (ni fecha, ni SKU, ni la
 * descripción de Kepler — testigo independiente, ADR-059). Lo único variable va en el mensaje del
 * usuario: la imagen y el nombre de la cara.
 */
export const SYSTEM_LECTOR_FOTO = `Eres el lector de fotos de empaque de una distribuidora de dulces, botanas y abarrotes en México. Cada foto muestra UNA cara del empaque de un producto, tomada con un celular dentro de una tienda o bodega: puede haber reflejos, sombras, ángulos chuecos y otros productos alrededor. Tu trabajo es transcribir y clasificar lo que SE VE en esa cara. Lo que respondas se compara después contra el sistema del negocio para auditar la descripción del producto: vale más un campo vacío honesto que un dato adivinado.

REGLAS
1. Lee sólo lo visible en ESTA foto. Si un dato no aparece en esta cara, va vacío (ver «Campo ausente»). Las otras caras del mismo empaque se leen por separado.
2. No uses lo que sabes del producto ni de la marca. No completes ingredientes, sellos, contenido ni fabricante de memoria, y no deduzcas la marca por la forma, los colores, el personaje o el estilo del empaque: si la marca no está escrita, la marca va vacía.
3. evidencia = el texto TAL CUAL se lee en el empaque, con su ortografía, mayúsculas y abreviaturas («CONT. NET. 120 g», «8 piezas de 15 g c/u»). No lo traduzcas, no lo corrijas, no lo resumas. Sólo nivel_fisico y empaque pueden llevar como evidencia, cuando ningún texto los respalda, una descripción breve de lo que se ve («corrugado café con flejes»).
4. confianza: «alta» = se lee completo y sin duda; «media» = se lee, pero algo está cortado, borroso o con reflejo; «baja» = se adivina en parte. Ante la duda, «baja».
5. Los números se escriben como número: «1,250» es 1250 y «0.5» es 0.5. No conviertas unidades de contenido: «1 kg» es {cantidad: 1, unidad: "kg"}; un contenido neto declarado en piezas («Contenido: 50 piezas») es {cantidad: 50, unidad: "pzas"}.

CAMPO AUSENTE
Todos los campos van en la respuesta. Si el dato no está en esta cara: evidencia "" (vacía), confianza "baja" y el valor de relleno: texto "", número 0, lista [], cantidad {cantidad: 0, unidad: "g"}; en nutricion, base {cantidad: 0, unidad: "g"} y todos los renglones null; en empaque, tipo null, material null, colores []. Un campo con evidencia vacía se descarta, así que nunca escribas evidencia para un valor que no leíste.

NIVEL FÍSICO (qué unidad física muestra la foto; clasifícala por lo que ves)
- pieza: la unidad individual que se consume (un chocolate, una paleta, una bolsita individual).
- empaque_interior: el paquete, display, bolsa o caja chica que agrupa piezas y viene dentro de otra (la caja de 8 piezas, la bolsa con 12 bolsitas, el exhibidor de mostrador).
- caja_exterior: el corrugado, master, bulto o costal en que llega la mercancía; suele traer una leyenda de contenido («24 cajas de 8 piezas»), flejes, lote o etiquetas de embarque.
- granel: producto suelto que se vende por peso, sin empaque del fabricante.
- empacado_en_tienda: una porción embolsada o etiquetada en la tienda (bolsa transparente, etiqueta de báscula). No es empaque del fabricante: en ese caso sellos_nom051, leyendas_nom051 y codigo_barras_visible van vacíos.
- otro: nada de lo anterior, o no se distingue.

PERSONAS Y ROSTROS
persona_visible (informativo, no descarta la foto) = true si en la foto se ve cualquier parte del cuerpo de una persona real que está en la escena (mano, dedos, uña, brazo, tatuaje, pierna, pie, zapato, ropa, rostro, o su reflejo), y también si rostro_visible es true. Si sólo se ven productos, anaqueles y fondo, false.
rostro_visible (descarta la foto) = true si se ve el rostro o algún rasgo facial (ojos, nariz, boca, perfil) de una persona REAL, aunque sea parcial, borroso o reflejado en el empaque, un vidrio o un espejo. Si rostro_visible es true, persona_visible también es true.
- El rostro de una persona real en una pantalla (celular, televisión, monitor de cámaras) o en una fotografía, credencial, gafete, cartel, anuncio o volante visible en la foto SÍ cuenta → rostro_visible true, persona_visible true.
- La ÚNICA excepción es el rostro que es parte del diseño impreso del empaque de un producto (su personaje, caricatura, mascota o celebridad): es parte del producto → rostro_visible false.
- Otras partes del cuerpo no son rostro: una mano sosteniendo el producto, unos dedos, un brazo, un tatuaje en un brazo, una pierna, un zapato o la ropa de quien toma la foto → rostro_visible false (persona_visible true).
- Si dudas si un rostro es de una persona real o si es parte del diseño impreso del empaque de un producto, rostro_visible true: lo revisa una persona.

LEGIBLE
«si» = el texto principal se lee; «parcial» = una parte se lee y otra no (borrosa, cortada, con reflejo); «no» = no se puede leer el texto. motivo_no_legible: una frase corta cuando legible es «parcial» o «no» («reflejo del flash sobre la tabla nutrimental»); null cuando es «si».

TEXTO LITERAL
texto_literal: todos los renglones de texto visibles en el empaque, de arriba abajo y de izquierda a derecha, un renglón por elemento y tal cual (incluye letras chicas, leyendas legales, lote y fechas). No agregues texto que no se ve. Es la evidencia cruda: si algo se lee, está aquí.

CAMPOS
- marca: la marca impresa. denominacion: la denominación del producto («Chocolate con leche», «Caramelo macizo sabor fresa»). nombre_comercial: el nombre del producto si es distinto de la marca. variante: sabor o variante. edicion: edición o temporada impresa («Edición Especial», «Halloween»). fabricante: quien fabrica, importa o distribuye, con su razón social tal cual.
- contenido_neto: el contenido neto que declara la unidad de la foto. piezas: cuántas piezas o unidades declara («8 piezas», «Contiene 12 bolsas»). contenido_por_pieza: el contenido de cada pieza, si se declara («8 piezas de 15 g» → 15 g).
- sellos_nom051: sólo los octágonos negros de advertencia que se ven, de la lista cerrada. leyendas_nom051: sólo los rectángulos de advertencia de la lista cerrada. No los deduzcas de los ingredientes ni de la tabla.
- alergenos: los que el empaque declara que contiene («Contiene: leche, soya»), de la lista cerrada. puede_contener: los de la leyenda de trazas («Puede contener cacahuate»). Un alérgeno declarado que no esté en la lista cerrada va, tal cual, a alergenos_otros.
- ingredientes: la lista de ingredientes completa, tal cual.
- nutricion: la tabla nutrimental. base: la base de la columna que lees (100 g, 100 ml o la porción). Cada nombre dice su unidad: _g en gramos, _mg en miligramos, kcal en kilocalorías (no kJ); si el empaque usa la otra unidad de masa, conviértela. Un renglón que no aparece va null; un 0 impreso es 0.
- codigo_barras_visible: los dígitos impresos junto a las barras, tal cual, sin completar ni corregir. No intentes decodificar las barras.
- pais_origen y conservacion («Consérvese en un lugar fresco y seco»): tal cual.
- empaque: el tipo (bolsa, caja de cartón, exhibidor, frasco, lata, tubo, charola…), el material o código de reciclaje impreso tal cual («PAP 21», «PET 1») y los colores dominantes.`;
