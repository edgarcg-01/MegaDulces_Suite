import { normalizaVacante, vacantesUnicas } from './vacante-match';

/**
 * Fase RH · `[RH.3.2.2]` — A QUIEN PIDE UN PUESTO QUE NO EXISTE, ORIENTARLO, NO BOTARLO. Lógica PURA, portada de
 * `orientacion.js` de Mega Talento con sus textos (recibe las vacantes, no las busca).
 *
 * Lo medido allá (17/08/2026, 543 candidatos con puesto): 43 no casaban con ninguna vacante, y no eran un caso sino tres:
 *   1. NO CONTESTÓ LA PREGUNTA (12): «Hola», «Me interesa», «Este es mi CV» → se repregunta (lo hace `registro.ts`).
 *   2. LE DA IGUAL EL PUESTO (8): «Cualquier está bien», «El solicitado» → el más fácil de colocar, y se perdía.
 *   3. PIDIÓ ALGO PARECIDO A LO QUE HAY (23): «Atención al cliente» ≈ Cajero(a); cinco pidieron «RH» con la Jefatura de
 *      recursos humanos abierta y nadie se los dijo.
 *
 * La regla dura: SÓLO VACANTES REALES, SÓLO EN SU ZONA. Las opciones salen siempre de la lista recibida (no inventa
 * nombres ni promete plazas) y se filtran por ciudad: la mitad de los candidatos vive por La Piedad y la mitad de las
 * vacantes está en Morelia, a dos horas. Si no sabemos su ciudad, se le pregunta antes de ofrecer.
 */

/** Una vacante, con lo que la orientación necesita. */
export interface VacanteOrientable {
  name: string;
  salary_text: string | null;
  branch_codes: readonly string[] | null;
  /** El domicilio como lo escribió RH: ubica la ciudad si la sucursal es nueva y su clave no se conoce. */
  branches_text?: string | null;
  sort_order?: number | null;
}

// ── Ciudades ─────────────────────────────────────────────────────────────────────────────

type ClaveCiudad = 'morelia' | 'zamora' | 'la_piedad' | 'santa_ana' | 'yurecuaro';

/**
 * Las ciudades con sucursal, con cómo las escribe la GENTE (el nombre comercial de la sucursal incluido: contestan
 * «Padre Hidalgo» o «Canindo» cuando se les pregunta la ciudad). `etiqueta` = el nombre de `HR_CIUDADES_EMPLEO`.
 */
export const CIUDADES: ReadonlyArray<{ clave: ClaveCiudad; etiqueta: string; alias: RegExp }> = [
  { clave: 'morelia', etiqueta: 'Morelia', alias: /morelia|madero pte|figaredo|vicente guerrero/ },
  { clave: 'zamora', etiqueta: 'Zamora', alias: /zamora|canindo|jacona|damaso cardenas|jardines de catedral/ },
  { clave: 'la_piedad', etiqueta: 'La Piedad', alias: /la piedad|piedad de cabadas|cabadas|pino suarez|mariano jimenez|esquinas/ },
  { clave: 'santa_ana', etiqueta: 'Santa Ana Pacueco', alias: /santa ana|sta ana|pacueco|padre hidalgo/ },
  { clave: 'yurecuaro', etiqueta: 'Yurécuaro', alias: /yurecuaro/ },
];

// La Piedad y Santa Ana Pacueco son dos pueblos pegados (el río Lerma de por medio): para ofrecer, el MISMO lugar.
const MISMA_ZONA: ClaveCiudad[][] = [['la_piedad', 'santa_ana']];

// Cercanas pero otro viaje (~40–60 min): se ofrecen si en su ciudad no hay nada, diciéndole dónde. Morelia nunca.
const VECINAS: Partial<Record<ClaveCiudad, ClaveCiudad[]>> = {
  zamora: ['yurecuaro'],
  yurecuaro: ['zamora', 'la_piedad'],
  la_piedad: ['yurecuaro'],
  santa_ana: ['yurecuaro'],
};

// El nombre con el que se conoce cada sucursal; las demás se arman desde su clave («morelia-centro» → «Morelia Centro»).
const NOMBRE_SUCURSAL: Record<string, string> = {
  'morelia-vicente-guerrero': 'Morelia Madero',
  'morelia-figaredo': 'Morelia Abastos',
  'zamora-catedral': 'Zamora Centro',
  'zamora-canindo': 'Canindo',
  'la-piedad-abastos': 'La Piedad Abastos',
  'la-piedad-centro': '8 Esquinas',
  'santa-ana-pacueco': 'Padre Hidalgo',
  'yurecuaro-centro': 'Yurécuaro',
};

export function etiquetaCiudad(clave: ClaveCiudad): string {
  return CIUDADES.find((c) => c.clave === clave)?.etiqueta ?? clave;
}

function nombreSucursal(slug: string): string {
  return NOMBRE_SUCURSAL[slug]
    ?? slug.split('-').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Las ciudades que menciona un texto libre (lo que escribió el candidato, o una dirección). */
export function ciudadesDelTexto(texto: string | null | undefined): ClaveCiudad[] {
  const t = normalizaVacante(texto);
  return t ? CIUDADES.filter((c) => c.alias.test(t)).map((c) => c.clave) : [];
}

/**
 * En qué ciudades está una vacante (por sus claves de sucursal y su domicilio). Una vacante que no ubica ninguna ciudad
 * aplica en TODAS — la misma regla que `hrVacanteEnCiudad` para la web (en Mega Talento toda vacante traía sucursales;
 * en la Suite `branch_codes` vacío significa «en cualquiera», y sin esto la orientación nunca la ofrecería).
 */
export function ciudadesDeVacante(v: VacanteOrientable): ClaveCiudad[] {
  const ciudades = [...new Set(ciudadesDelTexto(`${(v.branch_codes ?? []).join(' ')} ${v.branches_text ?? ''}`))];
  return ciudades.length ? ciudades : CIUDADES.map((c) => c.clave);
}

function conMismaZona(claves: ClaveCiudad[]): ClaveCiudad[] {
  const set = new Set(claves);
  for (const grupo of MISMA_ZONA) if (grupo.some((c) => set.has(c))) grupo.forEach((c) => set.add(c));
  return [...set];
}

function vecinasDe(claves: ClaveCiudad[]): ClaveCiudad[] {
  const zona = new Set(conMismaZona(claves));
  const out = new Set<ClaveCiudad>();
  for (const c of claves) for (const v of VECINAS[c] ?? []) if (!zona.has(v)) out.add(v);
  return [...out];
}

// ── ¿Qué contestó? Saludo, «lo que sea» o un puesto ──────────────────────────────────────

const CORTESIA = [
  /^(hola+|holi|buenas?|buen(os)? dias?|buenas (tardes|noches)|que tal|qtal|hey|saludos|disculpe|disculpa)\b/,
  /^(si|sip|no|ok|okey|oki|va|vale|sale|claro|gracias|de acuerdo|bien|perfecto|correcto|aja|mmm+)$/,
  /deseo un buen (dia|tarde)/,
  /espero me (solucionen|apoyen|ayuden|contesten|respondan)/,
  /(mire|vi|encontre|me llego) (una|la|su) (publicacion|anuncio|oferta|pagina|vacante)/,
  /(envio|le mando|te mando|aqui esta|este es|le comparto|adjunto) mi (cv|curriculum)/,
  /(quiero|quisiera|quiera|queria) (formar|ser) parte/,
  /^(me interesa|me interesaria|estoy interesad[oa])( (la|el|una|un) (vacante|oferta|trabajo|empleo))?$/,
  /^(vengo|escribo) por (el|la) (anuncio|vacante|publicacion|oferta)/,
  /^(busco|necesito|quiero) (trabajo|empleo|chamba)$/,
  // Una palabra suelta que no dice nada: gente tanteando si del otro lado hay alguien.
  /^(tiene|tienen|hay|cual|cuales|donde|cuando|como|info|informacion|mande|bueno|aqui|listo|ya)$/,
];

const SIN_PREFERENCIA = [
  /lo que (sea|haya|tengan|ofrezcan|me den|puedan|este disponible)/,
  /cualquier(a| cosa| puesto| vacante| trabajo)?( (esta|estaria|me) (bien|bueno))?/,
  /el (que|puesto que) (sea|haya|tengan|este)/,
  /donde (sea|me acomoden|quepa)/,
  /^no se$/,
  /^nose$/,
  /^n se$/,
  /no tengo prefer/,
  /me (acomodo|adapto) a (lo que sea|cualquier)/,
  /estoy (abiert[oa]|dispuest[oa]) a (lo que sea|cualquier|todo)/,
  /el (solicitado|solisitado|que ocupen|que necesiten)/,
  /(en|para) lo que (pueda|guste|ocupen|necesiten)/,
];

// De lo que la persona DESCRIBE a las vacantes que se le parecen. `apunta` son fragmentos del NOMBRE de la vacante (el
// día que RH abra «Cajero de mostrador», «cajer» ya la encuentra) y su ORDEN pesa: la primera es la más parecida.
// `porque` explica el puente con SUS palabras: es la diferencia entre una lista y una sugerencia.
const AFINIDADES: ReadonlyArray<{ dice: RegExp; apunta: string[]; porque: string }> = [
  { dice: /\bcaja\b|cajer|cobr(ar|o|ando)|punto de venta|ventanilla|mostrador|checador de precios/, apunta: ['cajer'], porque: 'lo de caja y cobro es justo lo de' },
  { dice: /atencion (a|al) (cliente|publico)|atender (client|gent|public)|servicio al cliente|ate.{0,6}sin al cliente|trato con (la gente|client)/, apunta: ['cajer', 'vendedor', 'anaquelista', 'ventas'], porque: 'si lo tuyo es tratar con la gente, va muy con eso' },
  { dice: /ayudante general|ayudante|acomod|descarg|estib|surtir|surtido|almacen|bodega|inventario|mercancia|piso|montacarg/, apunta: ['surtidor', 'anaquelista', 'almacenista', 'bodeguero'], porque: 'para trabajo de mercancía y piso es exactamente' },
  { dice: /administrativ|oficina|captur|excel|contab|facturacion|auxiliar contable|secretari|archiv|nomina/, apunta: ['credito', 'practicante', 'jefatura'], porque: 'del lado administrativo lo que hay abierto es' },
  { dice: /recursos humanos|rrhh|\brh\b|reclutamiento|reclutador|capital humano|personal administrativo|seleccion de personal/, apunta: ['jefatura', 'practicante'], porque: 'de recursos humanos justo está abierta' },
  { dice: /vend|ventas|promotor|preventa|comercial|ruta|mercadeo|encuestador/, apunta: ['vendedor', 'ventas'], porque: 'si vienes de ventas, te va' },
  { dice: /chofer|conducir|manejar|maneja|reparti|entrega|camion|camioneta|licencia (de manejo|tipo|clase)|transportista/, apunta: ['chofer', 'repartidor'], porque: 'si manejas, te sirve' },
  { dice: /cobranza|credito|cartera|recuperacion|moroso/, apunta: ['credito'], porque: 'de cobranza tenemos' },
  { dice: /practic|becari|pasant|servicio social|estudi(o|ante)|escuela/, apunta: ['practicante'], porque: 'si andas estudiando, la de' },
  { dice: /vigilan|prevenci|seguridad|guardia|auditor|contralor|supervision/, apunta: ['prevencion', 'jefatura'], porque: 'por tu experiencia en supervisión y control, va' },
  { dice: /dulce|abarrote|tienda|super|comercio|autoservicio/, apunta: ['anaquelista', 'cajer', 'surtidor'], porque: 'para trabajo en tienda tenemos' },
];

export type ClasePuesto = 'saludo' | 'abierto' | 'puesto';

/**
 * Lo que puso donde iba el puesto. Un «hola, busco de cajera» NO es saludo: trae contenido de trabajo (`vocabulario` =
 * palabras de las vacantes publicadas, o una afinidad).
 */
export function clasificarPuestoTexto(texto: string | null | undefined, vocabulario: readonly string[] = []): ClasePuesto {
  const t = normalizaVacante(texto);
  if (!t) return 'saludo';
  const hayContenido = vocabulario.some((w) => w && t.includes(w)) || AFINIDADES.some((a) => a.dice.test(t));
  if (!hayContenido && CORTESIA.some((re) => re.test(t))) return 'saludo';
  if (SIN_PREFERENCIA.some((re) => re.test(t))) return 'abierto';
  return 'puesto';
}

/** Las palabras que hablan de trabajo: las de los nombres de las vacantes publicadas. */
export function vocabularioDe(vacantes: readonly VacanteOrientable[]): string[] {
  return vacantes.flatMap((v) => normalizaVacante(v.name).split(' ')).filter((w) => w.length >= 4);
}

// ── La decisión ──────────────────────────────────────────────────────────────────────────

/** Cuántas opciones: con una parece que no hay de dónde escoger; con siete no escoge ninguna. */
export const MAX_OPCIONES = 3;

interface Opcion<V extends VacanteOrientable> { vacante: V; score: number; porque: string | null }

function ordenar<V extends VacanteOrientable>(texto: string, vacantes: V[]): Opcion<V>[] {
  const t = normalizaVacante(texto);
  return vacantes
    .map((v) => {
      const nombre = normalizaVacante(v.name);
      let score = 0;
      let porque: string | null = null;
      for (const a of AFINIDADES) {
        if (!a.dice.test(t)) continue;
        const idx = a.apunta.findIndex((frag) => nombre.includes(frag));
        if (idx === -1) continue;
        score += 1 / (1 + idx);
        porque ??= a.porque;
      }
      return { vacante: v, score, porque };
    })
    .sort((x, y) => (y.score !== x.score ? y.score - x.score : (x.vacante.sort_order ?? 999) - (y.vacante.sort_order ?? 999)))
    .slice(0, MAX_OPCIONES);
}

export type Orientacion<V extends VacanteOrientable = VacanteOrientable> =
  | { tipo: 'no_es_puesto'; clase: ClasePuesto }
  | { tipo: 'nada'; clase: ClasePuesto }
  | { tipo: 'falta_ciudad'; clase: ClasePuesto; ciudadesConVacante: string[] }
  | { tipo: 'ofrecer'; clase: ClasePuesto; ciudades: string[]; opciones: Opcion<V>[]; zona?: ClaveCiudad[]; fuera?: true }
  | { tipo: 'otras_ciudades'; clase: ClasePuesto; ciudades: string[]; opciones: Opcion<V>[]; ciudadesConVacante: string[] };

/**
 * Qué ofrecerle a quien pidió `texto`, sabiendo (o no) su `ciudadTexto`, con las vacantes publicadas.
 *   no_es_puesto → era un saludo (se repregunta) · falta_ciudad → primero su ciudad · ofrecer → hay en su zona (o en
 *   una vecina, con `fuera`) · otras_ciudades → sólo lejos · nada → no hay ninguna vacante publicada.
 */
export function orientar<V extends VacanteOrientable>(texto: string | null | undefined, ciudadTexto: string | null | undefined,
  vacantes: readonly V[] | null | undefined): Orientacion<V> {
  const lista = vacantesUnicas(vacantes ?? []).filter((v) => String(v.name || '').trim());
  const clase = clasificarPuestoTexto(texto, vocabularioDe(lista));
  if (clase === 'saludo') return { tipo: 'no_es_puesto', clase };
  if (!lista.length) return { tipo: 'nada', clase };

  const suyas = ciudadesDelTexto(ciudadTexto);
  if (!String(ciudadTexto ?? '').trim() && !suyas.length) {
    const conVacante = [...new Set(lista.flatMap((v) => ciudadesDeVacante(v)))];
    return { tipo: 'falta_ciudad', clase, ciudadesConVacante: conVacante.map(etiquetaCiudad) };
  }

  const zona = new Set(conMismaZona(suyas));
  const vecinas = new Set(vecinasDe(suyas));
  const ciudades = suyas.map(etiquetaCiudad);
  const t = String(texto ?? '');

  const aqui = lista.filter((v) => ciudadesDeVacante(v).some((c) => zona.has(c)));
  if (aqui.length) return { tipo: 'ofrecer', clase, zona: [...zona], ciudades, opciones: ordenar(t, aqui) };

  const cerca = lista.filter((v) => ciudadesDeVacante(v).some((c) => vecinas.has(c)));
  if (cerca.length) return { tipo: 'ofrecer', clase, fuera: true, ciudades, opciones: ordenar(t, cerca) };

  const resto = lista.filter((v) => !ciudadesDeVacante(v).some((c) => zona.has(c) || vecinas.has(c)));
  if (!resto.length) return { tipo: 'nada', clase };
  const opciones = ordenar(t, resto);
  // Las ciudades salen de lo que SE LE VA A MOSTRAR: anunciar cinco y enseñar dos se lee como que le escondimos algo.
  return {
    tipo: 'otras_ciudades', clase, ciudades, opciones,
    ciudadesConVacante: [...new Set(opciones.flatMap((o) => ciudadesDeVacante(o.vacante)))].map(etiquetaCiudad),
  };
}

/** Los nombres que se le ofrecieron (para entender su respuesta después). */
export function nombresOfrecidos(d: Orientacion): string[] {
  return 'opciones' in d ? d.opciones.map((o) => o.vacante.name) : [];
}

// ── El mensaje ───────────────────────────────────────────────────────────────────────────
// No dice «no calificas» (no hay vacante: eso es de la empresa, no de la persona), no vuelca todas las vacantes y no
// promete la plaza: ofrece postularse, que es lo que sí podemos dar.

/** ¿Se puede repetir lo que pidió como si fuera el nombre de un puesto? (Una frase larga no es un título.) */
function pedidoCorto(texto: string | null | undefined): string | null {
  const t = String(texto ?? '').trim();
  if (!t || t.length > 34 || normalizaVacante(t).split(' ').filter(Boolean).length > 4) return null;
  return t;
}

/** Una opción. Con `zona`, sólo se nombran las sucursales que le quedan cerca (no «Surtidor — Morelia» a alguien de La Piedad). */
function lineaOpcion(o: Opcion<VacanteOrientable>, zona: readonly ClaveCiudad[] = []): string {
  let ids = [...(o.vacante.branch_codes ?? [])];
  if (zona.length) {
    const cerca = ids.filter((id) => ciudadesDelTexto(id).some((c) => zona.includes(c)));
    if (cerca.length) ids = cerca;
  }
  const sucursales = ids.map(nombreSucursal).slice(0, 2);
  const donde = sucursales.length ? ` — ${sucursales.join(' y ')}` : '';
  const sueldo = String(o.vacante.salary_text ?? '').trim();
  // Un sueldo de una línea convence; una descripción de pago larga estorba.
  return `• *${o.vacante.name}*${donde}${sueldo && sueldo.length <= 24 ? ` · ${sueldo}` : ''}`;
}

function puente(opciones: Opcion<VacanteOrientable>[]): string {
  const con = opciones.find((o) => o.porque);
  return con?.porque ? `\n\n${con.porque.charAt(0).toUpperCase()}${con.porque.slice(1)} *${con.vacante.name}*.` : '';
}

function listaCiudades(nombres: readonly string[]): string {
  const l = nombres.filter(Boolean);
  if (!l.length) return '';
  if (l.length === 1) return `*${l[0]}*`;
  return `${l.slice(0, -1).map((x) => `*${x}*`).join(', ')} y *${l[l.length - 1]}*`;
}

/** El texto para el candidato, o null si la decisión no es de orientación (`no_es_puesto` lo maneja el registro). */
export function mensajeOrientacion(d: Orientacion | null, pedido: string | null | undefined): string | null {
  if (!d) return null;
  const abierto = d.clase === 'abierto';
  const eso = pedidoCorto(pedido);
  const deEso = eso && !abierto ? `de *${eso}*` : 'de lo que me pides';

  if (d.tipo === 'falta_ciudad') {
    const ciudades = listaCiudades(d.ciudadesConVacante);
    const donde = ciudades ? ` Tenemos sucursal en ${ciudades}.` : '';
    if (abierto) {
      return '¡Va, eso me facilita las cosas! 🙌 Con esa disposición seguro te acomodamos.\n\n'
        + `Nomás dime una cosa: ¿en qué *ciudad* te queda mejor trabajar?${donde}\n\n`
        + 'Con eso te digo qué hay abierto cerca de ti 👇';
    }
    return 'Mmm, con ese nombre no tengo una vacante abierta 🤔 pero no te vayas, que seguro algo de lo que hay te acomoda.\n\n'
      + `Antes de seguir: ¿en qué *ciudad* te queda mejor trabajar?${donde}\n\n`
      + 'Con eso te digo qué se está abriendo cerca de ti 👇';
  }

  if (d.tipo === 'ofrecer') {
    const lineas = d.opciones.map((o) => lineaOpcion(o, d.zona ?? [])).join('\n');
    const ciudad = listaCiudades(d.ciudades);
    if (d.fuera) {
      const donde = listaCiudades([...new Set(d.opciones.flatMap((o) => ciudadesDeVacante(o.vacante).map(etiquetaCiudad)))]);
      return `Te lo digo derecho: ${ciudad ? `en ${ciudad} ` : 'ahí '}no tengo nada abierto ahorita 😕\n\n`
        + `Lo más cerca que hay es en ${donde}:\n${lineas}${puente(d.opciones)}\n\n`
        + '¿Se te haría muy lejos? Si te queda, dime cuál te interesa y seguimos con tu registro 🙌';
    }
    const encabezado = abierto
      ? `¡Perfecto! Esto es lo que hay abierto${ciudad ? ` en ${ciudad}` : ''} ahora mismo:`
      : `${deEso.charAt(0).toUpperCase()}${deEso.slice(1)} no tengo nada abierto${ciudad ? ` en ${ciudad}` : ''} ahora mismo 😕 `
        + '— pero ahí sí hay movimiento:';
    return `${encabezado}\n${lineas}${puente(d.opciones)}\n\n¿Te late alguna? Dime cuál y seguimos con tu registro 🙌`;
  }

  if (d.tipo === 'otras_ciudades') {
    const lineas = d.opciones.map((o) => lineaOpcion(o)).join('\n');
    // Sin echarle su ciudad de vuelta: puede haber escrito cualquier cosa.
    const suya = d.ciudades.length ? `en ${listaCiudades(d.ciudades)}` : 'por tu zona';
    return `Te lo digo con honestidad: ${suya} no tengo sucursal con vacante abierta ahora mismo 😕\n\n`
      + `Donde sí hay movimiento es en ${listaCiudades(d.ciudadesConVacante)}:\n${lineas}${puente(d.opciones)}\n\n`
      + '¿Te quedaría trasladarte a alguna de esas? Si no, con gusto te dejo registrado y te escribo '
      + 'en cuanto se abra algo más cerca de ti 🙌';
  }

  if (d.tipo === 'nada') {
    return 'Ahorita no tengo vacantes abiertas 😕 Pero te dejo *registrado* y en cuanto se abra algo te escribo yo mismo. '
      + 'Sigamos con tus datos para tenerte listo 🙌';
  }
  return null;
}

// ── Entender su respuesta a la oferta ────────────────────────────────────────────────────

const ORDINALES = [
  { re: /\b(1|primer[ao]?|la primera|el primero|uno)\b/, i: 0 },
  { re: /\b(2|segund[ao]|la segunda|el segundo|dos)\b/, i: 1 },
  { re: /\b(3|tercer[ao]?|la tercera|el tercero|tres)\b/, i: 2 },
];

const RECHAZO = [
  /^(no|nop|nel|ninguna|ninguno|nada|no gracias|gracias pero no)$/,
  /no me (interesa|late|conviene|sirve|acomoda|gusta)/,
  /ningun[ao] (me|de)/,
  /(solo|solamente|nomas|unicamente) (me interesa|busco|queria|quiero)/,
  /(muy|esta|queda) lejos/,
  /no puedo (trasladarme|viajar|moverme|ir hasta)/,
  /(esperar|aviso|avisen|avisame|me avisan) (a que|cuando|hasta que)?/,
  /prefiero esperar/,
];

const ACEPTA_SIN_NOMBRE = [
  /^(si|sip|va|vale|sale|claro|orale|dale|esa|ese|esa si|la primera|cualquiera|la que sea|me interesa|acepto|de acuerdo|estoy de acuerdo)$/,
  /me (late|interesa|gusta|acomoda|sirve|parece bien) (esa|ese|la|el)?$/,
  /(si|claro) me interesa/,
];

// `normalizaVacante` borra los dígitos; aquí importan: mucha gente contesta «la 2».
function normalizaConNumeros(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

export type RespuestaOferta = { tipo: 'elige'; nombre: string } | { tipo: 'rechaza' } | { tipo: 'ciudad' } | { tipo: 'no_claro' };

/**
 * Lo que contestó a la oferta. Por NOMBRE antes que por número («la de cajera» elige aunque traiga números); el rechazo
 * antes que el ordinal («ninguna de las 3» trae un 3); un «sí» pelón sólo vale si se le ofreció UNA cosa.
 */
export function interpretarRespuestaOferta(texto: string | null | undefined, ofrecidas: readonly string[] = []): RespuestaOferta {
  const t = normalizaConNumeros(texto);
  if (!t) return { tipo: 'no_claro' };
  for (const nombre of ofrecidas) {
    const claves = normalizaVacante(nombre).split(' ').filter((w) => w.length >= 4);
    if (claves.length && claves.some((w) => t.includes(w.slice(0, 5)))) return { tipo: 'elige', nombre };
  }
  if (RECHAZO.some((re) => re.test(t))) return { tipo: 'rechaza' };
  for (const o of ORDINALES) if (o.re.test(t) && ofrecidas[o.i]) return { tipo: 'elige', nombre: ofrecidas[o.i] };
  if (ACEPTA_SIN_NOMBRE.some((re) => re.test(t))) {
    return ofrecidas.length === 1 ? { tipo: 'elige', nombre: ofrecidas[0] } : { tipo: 'no_claro' };
  }
  if (ciudadesDelTexto(texto).length) return { tipo: 'ciudad' };
  return { tipo: 'no_claro' };
}
