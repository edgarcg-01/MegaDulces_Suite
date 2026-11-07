/**
 * `[NP.7.L.11d]` **El lenguaje JSON del catálogo**: qué lee la IA de UNA foto de empaque y cómo se guarda.
 *
 * Es el contrato entre las cuatro piezas del lector, y por eso vive en un solo archivo:
 *   1. el **lector** (`lector-foto.service.ts`): una llamada por foto → `LecturaFotoV1`;
 *   2. la **fusión** (`fusion-lecturas.ts`): las 5 caras de la unidad principal → `PropuestaAmpliada`
 *      (lo que después Catálogo acepta como `sheet.ampliado`, §7.2 del plan);
 *   3. la **auditoría** (`auditoria-kepler.ts`): la propuesta contra la ficha de Kepler (`kdii`) → hallazgos
 *      y una descripción propuesta. ⛔ La Suite no escribe en Kepler: todo hallazgo va a revisión;
 *   4. el **diccionario** (`diccionario.ts`): marcas, fabricantes, variantes… del catálogo entero,
 *      DERIVADO de las lecturas al pedirlo (derive-no-copy), nunca una tabla aparte.
 *
 * ⛔ Reglas que el contrato fija:
 *  - **Testigo independiente** (ADR-059): al lector NO se le pasa la descripción de Kepler. Si se la
 *    damos, «lee» lo que le dijimos y la auditoría compara a Kepler consigo mismo.
 *  - **Lo que no se ve es `null`**, nunca un valor inventado ni un cero (regla 11). Cada campo leído trae
 *    la **evidencia**: el texto tal cual aparece en el empaque, para que una persona lo pueda comprobar.
 *  - **El código de barras leído por la IA es evidencia, nunca fuente**: manda el lector de códigos (§5.1).
 *  - Lo que la norma cierra se cierra (sellos y leyendas de NOM-051, alérgenos declarables); lo que no
 *    (marca, sabor, tipo de empaque), queda abierto y el diccionario lo ordena después.
 *
 * Vive aquí y no en `libs/contracts` mientras sólo lo use el servidor: el índice de `libs/contracts` lo
 * tiene apartado otra sesión (2026-11-04). Se mueve allá cuando la bandeja lo pinte.
 */

export const LECTURA_FOTO_VERSION = 'lectura-foto-v1' as const;
export const AI_RAW_VERSION = 'ai-raw-v1' as const;

/** Nivel físico de lo que está en la foto (plan §10b.7 punto 7). */
export const NIVELES_FISICOS = ['pieza', 'empaque_interior', 'caja_exterior', 'granel', 'empacado_en_tienda', 'otro'] as const;
export type NivelFisico = (typeof NIVELES_FISICOS)[number];

/** Sellos octagonales de NOM-051 (modificación 2020). Lista cerrada. */
export const SELLOS_NOM051 = [
  'EXCESO CALORÍAS', 'EXCESO AZÚCARES', 'EXCESO GRASAS SATURADAS', 'EXCESO GRASAS TRANS', 'EXCESO SODIO',
] as const;
export type SelloNom051 = (typeof SELLOS_NOM051)[number];

/** Leyendas precautorias rectangulares de NOM-051. Lista cerrada. */
export const LEYENDAS_NOM051 = [
  'CONTIENE CAFEÍNA - EVITAR EN NIÑOS', 'CONTIENE EDULCORANTES - NO RECOMENDABLE EN NIÑOS',
] as const;
export type LeyendaNom051 = (typeof LEYENDAS_NOM051)[number];

/**
 * Alérgenos que el empaque declara (NOM-051 §4.2.2.2.3 y los que la industria agrega). Lo que el empaque
 * declare fuera de esta lista va a `alergenos_otros`, tal cual: el diccionario dirá si conviene cerrarlo.
 */
export const ALERGENOS = [
  'trigo', 'centeno', 'avena', 'cebada', 'gluten', 'crustaceos', 'moluscos', 'huevo', 'pescado',
  'cacahuate', 'soya', 'leche', 'nueces', 'ajonjoli', 'mostaza', 'sulfitos',
] as const;
export type Alergeno = (typeof ALERGENOS)[number];

export const UNIDADES_CONTENIDO = ['g', 'kg', 'mg', 'ml', 'l', 'pzas'] as const;
export type UnidadContenido = (typeof UNIDADES_CONTENIDO)[number];

export const CARAS_LECTURA = ['frente', 'posterior', 'lateral_1', 'lateral_2', 'codigo', 'otra'] as const;

/** Qué tan seguro está el lector de UN campo. Lo declara el modelo y nadie lo ha medido (NP.7.L.11b). */
export type Confianza = 'alta' | 'media' | 'baja';

/** Un campo leído: el valor, cuánta confianza declara el lector y el texto del empaque que lo respalda. */
export interface CampoLeido<T> {
  valor: T;
  confianza: Confianza;
  /** El texto TAL CUAL se lee en el empaque («CONT. NET. 120 g»). Vacío no se acepta. */
  evidencia: string;
}

export interface Cantidad {
  cantidad: number;
  unidad: UnidadContenido;
}

/** Tabla nutrimental. Lo que no aparece es `null` (no cero). */
export interface Nutricion {
  /** Base de la tabla: «100 g», «100 ml» o la porción. */
  base: Cantidad;
  kcal: number | null;
  proteinas_g: number | null;
  grasas_totales_g: number | null;
  grasas_saturadas_g: number | null;
  grasas_trans_mg: number | null;
  carbohidratos_g: number | null;
  azucares_g: number | null;
  azucares_anadidos_g: number | null;
  fibra_g: number | null;
  sodio_mg: number | null;
}

export interface Empaque {
  /** Abierto: «bolsa», «caja de cartón», «exhibidor», «frasco», «lata», «tubo», «charola»… */
  tipo: string | null;
  /** Código de reciclaje o material impreso («PAP 21», «PET 1», «PP 5»), tal cual. */
  material: string | null;
  colores: string[];
}

/** Los campos que se pueden leer de UNA cara. Un campo que no aparece en esa cara es `null`. */
export interface CamposLeidos {
  marca: CampoLeido<string> | null;
  /** Denominación del producto («Chocolate con leche», «Caramelo macizo»). */
  denominacion: CampoLeido<string> | null;
  /** Nombre comercial si es distinto de la marca («Bon o Bon», «Kranky»). */
  nombre_comercial: CampoLeido<string> | null;
  /** Sabor o variante («Fresa», «Picante», «Surtido»). */
  variante: CampoLeido<string> | null;
  /** Edición o temporada impresa («Edición Especial», «Halloween»). */
  edicion: CampoLeido<string> | null;
  fabricante: CampoLeido<string> | null;
  /** Contenido neto declarado de ESTA unidad («CONT. NET. 120 g»). */
  contenido_neto: CampoLeido<Cantidad> | null;
  /** Piezas que declara el empaque («8 piezas», «Contiene 12 bolsas»). */
  piezas: CampoLeido<number> | null;
  /** Contenido de cada pieza («8 piezas de 15 g» → 15 g). */
  contenido_por_pieza: CampoLeido<Cantidad> | null;
  sellos_nom051: CampoLeido<SelloNom051[]> | null;
  leyendas_nom051: CampoLeido<LeyendaNom051[]> | null;
  alergenos: CampoLeido<Alergeno[]> | null;
  /** «Puede contener…» (trazas). */
  puede_contener: CampoLeido<Alergeno[]> | null;
  /** Alérgenos declarados que no están en `ALERGENOS`, tal cual. */
  alergenos_otros: CampoLeido<string[]> | null;
  /** La lista de ingredientes, tal cual. */
  ingredientes: CampoLeido<string> | null;
  nutricion: CampoLeido<Nutricion> | null;
  /** Dígitos del código impreso, sólo como evidencia (manda el lector de códigos, §5.1). */
  codigo_barras_visible: CampoLeido<string> | null;
  pais_origen: CampoLeido<string> | null;
  conservacion: CampoLeido<string> | null;
  empaque: CampoLeido<Empaque> | null;
}

export const NOMBRES_CAMPOS = [
  'marca', 'denominacion', 'nombre_comercial', 'variante', 'edicion', 'fabricante', 'contenido_neto', 'piezas',
  'contenido_por_pieza', 'sellos_nom051', 'leyendas_nom051', 'alergenos', 'puede_contener', 'alergenos_otros',
  'ingredientes', 'nutricion', 'codigo_barras_visible', 'pais_origen', 'conservacion', 'empaque',
] as const satisfies ReadonlyArray<keyof CamposLeidos>;
export type NombreCampo = (typeof NOMBRES_CAMPOS)[number];

/** Lo que el lector devuelve de UNA foto, ya validado contra este contrato. */
export interface LecturaFotoV1 {
  version: typeof LECTURA_FOTO_VERSION;
  nivel_fisico: CampoLeido<NivelFisico>;
  /**
   * INFORMATIVO: se ve cualquier parte del cuerpo de una persona real (mano, dedos, brazo, pierna, zapato, ropa,
   * tatuaje… o el rostro). **No bloquea** (Francisco, 2026-11-05: «las fotos con partes de personas no hay
   * problema»; en la primera prueba, 2 de 15 fotos traían una pierna o un zapato). Lo que bloquea es `rostro_visible`.
   */
  persona_visible: boolean;
  /**
   * Un rostro o rasgos faciales (ojos, nariz, boca, perfil) de una persona REAL, aunque sea parcial o reflejado,
   * esté en la escena o en una pantalla, una fotografía, una credencial, un cartel, un anuncio o un volante.
   * **Bloquea**: la foto no se publica, no va a estudio y se pide otra (§10b.3 punto 7; Francisco, 2026-11-05, por
   * confirmar por Edgar y legal en D6). La ÚNICA excepción: el rostro del diseño impreso del EMPAQUE de un producto
   * (personaje, caricatura, mascota, celebridad) es parte del producto y no cuenta. ❌ Antes también se exceptuaban
   * el cartel y el anuncio: más amplio que lo decidido (revisión del 2026-11-05).
   *
   * ⚠️ Se juzga sobre lo que VIAJÓ al modelo: con `NP7_AI_RECORTE=silueta` (el defecto), el recorte del centro
   * (`LecturaGuardada.preparacion.recorte`; en una foto 3:4, ~73.6 % × 73.6 % = 54.2 % del área). `false` = «no se vio
   * un rostro EN EL RECORTE», NO «la foto guardada no tiene rostro»: los márgenes de la foto guardada (que se guarda
   * entera) nadie los revisa. Quien publique o mande a estudio (NP.7.F.3) elige: (i) usar sólo el recorte, o
   * (ii) que la marca manual «tiene rostro» cubra los márgenes. Una lectura que no quedó `ok` no trae este booleano:
   * su rostro es NO MEDIDO, nunca `false` (deuda (a) de `lector-worker.service.ts`).
   */
  rostro_visible: boolean;
  /** Si el texto del empaque se puede leer. `no` → la foto se pide de nuevo. */
  legible: 'si' | 'parcial' | 'no';
  motivo_no_legible: string | null;
  /** Todo el texto visible, renglón por renglón, tal cual. Es la evidencia cruda para auditar descripciones. */
  texto_literal: string[];
  campos: CamposLeidos;
}

/** Cómo terminó UNA llamada al lector. */
export type EstadoLectura = 'ok' | 'rechazada_por_modelo' | 'incompleta' | 'invalida' | 'error';

/** Lo que costó UNA llamada, tomado de la respuesta, no estimado. `costo_usd: null` = modelo sin precio en la tabla. */
export interface UsoLlamada {
  modelo: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  costo_usd: number | null;
  /** De dónde salió el precio («precios públicos de Anthropic, tabla al 2026-10-06»). */
  precio_fuente: string | null;
}

export interface ResultadoLectura {
  estado: EstadoLectura;
  lectura: LecturaFotoV1 | null;
  /** `null` sólo si la llamada nunca salió (sin uso que registrar). */
  uso: UsoLlamada | null;
  error: string | null;
}

/** Una lectura guardada en `ai_raw.lecturas[sha256]`. La llave es el `sha256` de la foto: idempotencia. */
export interface LecturaGuardada extends ResultadoLectura {
  cara: string;
  peldano: string | null;
  leida_en: string;
  /** Cómo se preparó la imagen antes de enviarla (recorte y tamaño), para poder repetirlo. */
  preparacion: { ancho: number; alto: number; recorte: { x: number; y: number; ancho: number; alto: number } | null; bytes: number } | null;
}

/** Un campo de la propuesta: el valor elegido, de qué cara salió y si otra cara dijo otra cosa. */
export interface CampoPropuesto<T> {
  valor: T;
  confianza: Confianza;
  evidencia: string;
  de_cara: string;
  /** Otra cara leyó un valor distinto: va a revisión con las dos lecturas. */
  conflicto: Array<{ cara: string; valor: T; evidencia: string }> | null;
}

/** Las 5 caras fusionadas: lo que Catálogo acepta (o corrige) como `sheet.ampliado`. */
export interface PropuestaAmpliada {
  version: typeof LECTURA_FOTO_VERSION;
  caras_leidas: string[];
  nivel_fisico: CampoPropuesto<NivelFisico> | null;
  /** INFORMATIVO: alguna cara muestra una parte del cuerpo de una persona real. No bloquea (Francisco, 2026-11-05). */
  persona_visible: boolean;
  /**
   * Alguna cara muestra un rostro o rasgos faciales de una persona REAL (en la escena, en una pantalla, una foto, una
   * credencial, un cartel…), aunque sea parcial o reflejado. Bloquea: la foto no se publica, no va a estudio y se pide
   * otra. Sólo el rostro del diseño impreso del EMPAQUE de un producto no cuenta (ver `LecturaFotoV1.rostro_visible`).
   * ⚠️ `false` = ninguna cara mostró un rostro EN SU RECORTE (`preparacion.recorte`): los márgenes no se revisan.
   */
  rostro_visible: boolean;
  campos: { [K in NombreCampo]: CampoPropuesto<NonNullable<CamposLeidos[K]>['valor']> | null };
}

export type TipoHallazgo =
  | 'marca_no_en_descripcion'
  /** El nombre comercial del empaque («Chupi Bomb») no está en la descripción de Kepler («CHUPI BUMB …»). */
  | 'nombre_comercial_no_en_descripcion'
  | 'variante_no_en_descripcion'
  | 'contenido_distinto'
  | 'piezas_distintas'
  | 'nivel_fisico_no_coincide'
  | 'campo_en_conflicto'
  /** Un rostro real en alguna cara. `persona_visible` (una mano, un zapato) ya NO es hallazgo. */
  | 'rostro_visible'
  | 'foto_no_legible';

/** Un hallazgo de la auditoría. Nunca se corrige solo: va a «Por revisar» (y después a Incidencias, L.3c). */
export interface HallazgoAuditoria {
  tipo: TipoHallazgo;
  /** Lo que dice Kepler (o `null` si el hallazgo no es contra Kepler). */
  kepler: string | null;
  /** Lo que dice la foto, con su evidencia. */
  foto: string;
  explicacion: string;
}

/** La auditoría de UNA ficha contra Kepler. */
export interface AuditoriaKepler {
  hallazgos: HallazgoAuditoria[];
  /** Descripción armada SÓLO con lo leído («BON O BON CHOCOLATE FRESA 8/15G»). Propuesta, nunca se escribe sola. */
  descripcion_propuesta: string | null;
  /** Campos que el empaque trae y Kepler no guarda (alérgenos, sellos, nutrición…): información nueva. */
  informacion_nueva: NombreCampo[];
}

/** Forma de `catalog.product_sheets.ai_raw`. Lo que la IA dijo; lo que la persona aceptó vive en `sheet`. */
export interface AiRawV1 {
  version: typeof AI_RAW_VERSION;
  lecturas: Record<string, LecturaGuardada>;
  propuesta: PropuestaAmpliada | null;
  auditoria: AuditoriaKepler | null;
  actualizado_en: string;
}

/** Una entrada del diccionario: un término normalizado y todas las formas en que aparece. */
export interface EntradaDiccionario {
  /** Clave sin acentos, minúsculas y sin signos («bonobon»). */
  clave: string;
  /** La forma más frecuente, para mostrar. */
  forma_principal: string;
  formas: Array<{ texto: string; veces: number }>;
  /** SKUs distintos donde aparece. */
  skus: string[];
}

export interface DiccionarioCatalogo {
  version: typeof LECTURA_FOTO_VERSION;
  fichas_leidas: number;
  marcas: EntradaDiccionario[];
  fabricantes: EntradaDiccionario[];
  variantes: EntradaDiccionario[];
  denominaciones: EntradaDiccionario[];
  tipos_empaque: EntradaDiccionario[];
  /** Cuántos SKUs llevan cada sello / leyenda / alérgeno (las listas cerradas, con su conteo). */
  sellos: Record<string, number>;
  leyendas: Record<string, number>;
  alergenos: Record<string, number>;
  /** Alérgenos fuera de la lista cerrada: candidatos a cerrarla. */
  alergenos_otros: EntradaDiccionario[];
}
