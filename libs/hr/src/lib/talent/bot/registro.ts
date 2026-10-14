import { HR_SUCURSALES_EMPLEO, hrVacanteEnCiudad } from '@megadulces/contracts';
import { resolverVacante, vacantesUnicas } from './vacante-match';
import {
  ciudadesDelTexto, clasificarPuestoTexto, etiquetaCiudad, interpretarRespuestaOferta, mensajeOrientacion,
  nombresOfrecidos, orientar, vocabularioDe, type VacanteOrientable,
} from './orientacion';

/**
 * Fase RH · `[RH.3.2]` — la CONVERSACIÓN DE REGISTRO por WhatsApp, como lógica PURA: recibe el estado, lo contestado y
 * el mensaje, y devuelve el estado nuevo, lo contestado y qué decirle. No toca base ni red (lo hace el servicio).
 *
 * Portada de `conversacion.js` de Mega Talento con sus textos y sus reglas, que cada una ya costó algo:
 *   · 12 pasos EN ORDEN; puesto y ciudad son CLAVE: «cualquiera», «no sé», «donde sea» no cuentan, y sin ellos no se
 *     pasa del resumen (RH encontró postulaciones sin ciudad ni puesto que no se podían asignar a nada).
 *   · Un SALUDO donde iba el puesto no se guarda como puesto (hay candidatos cuyo puesto dice «Hola»).
 *   · El correo es suave para todos («no tengo» → «Sin correo»); RFC y NSS son suaves sólo para practicantes.
 *   · Si no sabe su RFC o NSS, se le da el enlace oficial para sacarlo, sin avanzar.
 *   · Tecleo al azar no se acepta (el nombre va impreso en su CV).
 *   · Comandos en cualquier momento (`reiniciar`, `ayuda`, `vacantes`, `sucursales`), sólo si el mensaje ES el comando.
 *   · Resumen numerado: «sí» confirma, un número corrige ese dato y regresa al resumen.
 *   · Tras confirmar, el CV es OBLIGATORIO: sin CV no hay postulación (lo recibe el servicio).
 *
 *   · `[RH.3.2.2]` A quien pide un puesto que no hay, se le ORIENTA (`orientacion.ts`): se le ofrece lo abierto en su
 *     ciudad (o se le pregunta primero dónde vive), máximo dos rondas y nunca se le deja atorado. Lo que pidió se guarda
 *     siempre: es el único registro de la demanda que no cubrimos.
 *
 * Lo que NO trae todavía (declarado en FASE_RH §RH.3): la interpretación con IA de mensajes con varios datos
 * (`[RH.3.2.1]`) y armar el CV con la solicitud (`[RH.3.3]`).
 */

// ── Datos ────────────────────────────────────────────────────────────────────────────────

/** Los campos, con el nombre de columna de `talent.candidates`. */
export type CampoRegistro =
  | 'position_interest' | 'full_name' | 'email' | 'city_branch' | 'commute_time' | 'availability'
  | 'previous_employer' | 'desired_salary' | 'rfc' | 'nss' | 'relative_in_company' | 'rehire_note';

export type DatosRegistro = Partial<Record<CampoRegistro, string>>;

/** Una vacante tal como la necesita el bot. */
export interface VacanteBot extends VacanteOrientable {
  id: string;
  /** Para contestar dudas con datos reales (`[RH.3.2.1]`). */
  schedule_text?: string | null;
  requirements?: string | null;
}

export interface ContextoRegistro {
  /** Las vacantes publicadas (`talent.job_postings` activas). */
  vacantes: readonly VacanteBot[];
  /** El reloj (para fechar la orientación); por omisión, ahora. */
  ahora?: Date;
  /**
   * `[RH.3.2.1]` Lo que la IA propuso para ESTE mensaje (el servicio la consulta antes, sólo si `faltantesParaIA` lo
   * pide). Es una propuesta: cada dato pasa por los mismos validadores que la captura a mano. Sin ella, o si no trajo
   * nada, sigue el camino determinista.
   */
  interpretacion?: InterpretacionRegistro | null;
}

/** Lo que la IA sacó de un mensaje: los datos que menciona explícitamente y, si preguntó algo, la respuesta. */
export interface InterpretacionRegistro {
  datos: Partial<Record<CampoRegistro, string | null>>;
  respuesta_pregunta: string | null;
}

export type EstadoTerminal = 'postulada' | 'rechazada';

/**
 * Lo que se le ofreció cuando pidió un puesto que no hay: para entender su respuesta y para que RH vea la demanda real
 * (qué pidió, qué se le ofreció, qué aceptó o si lo rechazó).
 */
export interface EstadoOrientacion {
  pedido: string;
  tipo: string;
  ofrecidas: string[];
  rondas: number;
  en: string;
  aceptada?: string;
  aceptada_en?: string;
  rechazada?: boolean;
  rechazada_en?: string;
}

export interface Turno {
  estado: string;
  datos: DatosRegistro;
  /** La orientación vigente (se conserva entre turnos; `reiniciar` la borra). */
  orientacion: EstadoOrientacion | null;
  respuestas: string[];
  /** Acaba de confirmar sus datos: el servicio revisa las reglas de postulación ANTES de pedirle el CV. */
  confirmado?: boolean;
  /** Pidió empezar de nuevo: el servicio limpia el resultado anterior. */
  reiniciado?: boolean;
}

// ── Utilidades de texto ──────────────────────────────────────────────────────────────────

const lleno = (v: unknown): v is string => v !== null && v !== undefined && String(v).trim() !== '';

export function normalizarTexto(texto: string | null | undefined): string {
  return String(texto ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** ¿Dice que NO sabe/tiene el dato? (El lookahead final cubre los acentos donde `\b` falla, p. ej. «sé».) */
export function esNoSe(texto: string): boolean {
  const t = (texto || '').toLowerCase().trim();
  return /\bno\s+(lo\s+|la\s+)?(s[eé]|tengo|cuento|recuerdo|conozco)(?![a-záéíóúñ])/.test(t)
    || /no\s+me\s+acuerdo|ni\s+idea|no\s+cu[aá]l/.test(t)
    || t === 'nel';
}

/** ¿Lo quiere dar DESPUÉS? («se lo paso luego», «más adelante»). */
function quiereDespues(texto: string): boolean {
  return /(despues|mas adelante|mas tarde|luego|al rato|posterior|otro momento|ahorita no|por (ahora|el momento) no|(lo|los|te|se)\s+\w*\s*(paso|doy|mando|env[ií]o|entrego))/
    .test(normalizarTexto(texto));
}

function quiereOmitir(texto: string): boolean {
  return esNoSe(texto) || quiereDespues(texto);
}

// Secuencias de teclado ("asdf", "qwer"…).
const TECLADO = [
  'asdf', 'sdfg', 'dfgh', 'fghj', 'ghjk', 'hjkl', 'jklñ',
  'qwer', 'wert', 'erty', 'rtyu', 'tyui', 'yuio', 'uiop',
  'zxcv', 'xcvb', 'cvbn', 'vbnm',
  'lkjh', 'kjhg', 'jhgf', 'hgfd', 'gfds', 'fdsa',
  'poiu', 'oiuy', 'iuyt', 'mnbv', 'nbvc', 'bvcx',
];

/**
 * ¿Tecleo al azar? Por cómo se ve el español escrito, no por diccionario: rachas de 5+ consonantes, muy pocas vocales
 * en palabras largas (≥8, para salvar «CBTIS»), sílabas repetidas («jajaja») o secuencias de teclado.
 * Caso real de Mega Talento: «dkañslkdñaskdñlaks» se iba impreso en un CV.
 */
export function pareceTecleoAlAzar(texto: string): boolean {
  const limpio = normalizarTexto(texto).replace(/ñ/g, 'n');
  if (!/[a-z]/.test(limpio)) return false;
  if (TECLADO.some((seq) => limpio.includes(seq))) return true;
  for (const p of limpio.split(/[^a-z]+/).filter(Boolean)) {
    if (p.length >= 6 && /^(.{1,3}?)\1{2,}$/.test(p)) return true;
    const consonantes: string[] = p.match(/[bcdfghjklmnpqrstvwxyz]+/g) ?? [];
    if (Math.max(0, ...consonantes.map((r) => r.length)) >= 5) return true;
    const vocales: string[] = p.match(/[aeiou]/g) ?? [];
    if (p.length >= 8 && vocales.length / p.length < 0.22) return true;
  }
  return false;
}

// ── Validadores ──────────────────────────────────────────────────────────────────────────

type Validacion = { ok: true; valor: string } | { ok: false; error: string };

/** RFC de persona física: 4 letras + AAMMDD + 3 de homoclave. */
export function validarRFC(texto: string): Validacion {
  const v = (texto || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-ZÑ&]{4}[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[A-Z0-9]{3}$/.test(v)) {
    return { ok: false, error: '⚠️ Ese RFC no parece válido. Debe tener 13 caracteres: 4 letras, '
      + '6 dígitos de fecha y 3 de homoclave (ejemplo: LOGA900101AB1).\nPor favor escríbelo de nuevo:' };
  }
  return { ok: true, valor: v };
}

/** Correo, tolerando los errores de dedo de WhatsApp («juan arroba gmail.com», mayúsculas, punto final). */
export function validarCorreo(texto: string): Validacion {
  // «arroba» se traduce ANTES de quitar los espacios: después ya no se distingue la palabra.
  let v = (texto || '').trim().toLowerCase();
  v = v.replace(/\s*\(?\barroba\b\)?\s*/g, '@').replace(/\s+/g, '').replace(/[.,;]+$/, '');
  if (!/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(v)) {
    return { ok: false, error: '⚠️ Ese correo no se ve completo. Escríbelo así: *nombre@gmail.com* 📧\n'
      + 'Si no tienes correo, escribe *no tengo* y seguimos.' };
  }
  return { ok: true, valor: v };
}

/** NSS del IMSS: 11 dígitos (acepta separadores y los limpia). */
export function validarNSS(texto: string): Validacion {
  const v = (texto || '').replace(/\D/g, '');
  if (!/^\d{11}$/.test(v)) {
    return { ok: false, error: '⚠️ El NSS debe tener exactamente 11 dígitos (ejemplo: 12345678901).\nPor favor escríbelo de nuevo:' };
  }
  return { ok: true, valor: v };
}

// ── Los pasos ────────────────────────────────────────────────────────────────────────────

export const NO_APLICA = 'No aplica';
export const SIN_CORREO = 'Sin correo';

const AYUDA = {
  rfc: 'Si no conoces tu *RFC*, puedes generarlo/consultarlo con tu CURP en el SAT:\n'
    + '👉 https://www.sat.gob.mx (busca "Genera tu RFC con tu CURP")\n'
    + 'Cuando lo tengas, escríbelo aquí. Si no lo consigues ahora, puedes seguir y dárnoslo después.',
  nss: 'Si no conoces tu *NSS* (Número de Seguro Social), localízalo en el IMSS con tu CURP:\n'
    + '👉 https://serviciosdigitales.imss.gob.mx (opción "Consulta tu número de seguridad social")\n'
    + 'Cuando lo tengas, escríbelo aquí. Si no lo consigues ahora, puedes seguir y dárnoslo después.',
};

export interface Paso {
  campo: CampoRegistro;
  etiqueta: string;
  pregunta: string;
  validar?: (t: string) => Validacion;
  ayuda?: string;
  /** Suave para todos (el correo). */
  opcionalSiempre?: boolean;
  sentinelOmitido?: string;
  pistaOpcional?: string;
  avisoOmitido?: string;
}

export const PASOS: readonly Paso[] = [
  { campo: 'position_interest', etiqueta: 'Puesto de interés', pregunta: 'Para empezar, ¿qué *puesto* te interesa?' },
  { campo: 'full_name', etiqueta: 'Nombre completo', pregunta: '¿Cuál es tu *nombre completo*?' },
  {
    campo: 'email', etiqueta: 'Correo electrónico',
    pregunta: '¿Cuál es tu *correo electrónico*? 📧 Ahí te llegará la prueba en línea del proceso.',
    validar: validarCorreo, opcionalSiempre: true, sentinelOmitido: SIN_CORREO,
    pistaOpcional: '_(Si no tienes correo, escribe *no tengo* y seguimos.)_',
    avisoOmitido: 'Sin problema, seguimos sin correo. ',
  },
  { campo: 'city_branch', etiqueta: 'Ciudad/sucursal', pregunta: '¿En qué *ciudad o sucursal* te interesa trabajar?' },
  { campo: 'commute_time', etiqueta: 'Tiempo de traslado', pregunta: '¿Cuánto *tiempo de traslado* tienes desde tu casa hasta ahí? (por ejemplo: 30 minutos)' },
  { campo: 'availability', etiqueta: 'Disponibilidad', pregunta: '¿Cuál es tu *disponibilidad* de horario? (por ejemplo: tiempo completo, medio turno, fines de semana)' },
  { campo: 'previous_employer', etiqueta: 'Empresa anterior', pregunta: '¿En qué *empresa trabajaste anteriormente*?' },
  { campo: 'desired_salary', etiqueta: 'Salario deseado', pregunta: '¿Cuál es tu *salario deseado*? (mensual o por hora)' },
  { campo: 'rfc', etiqueta: 'RFC', pregunta: '¿Cuál es tu *RFC*?', validar: validarRFC, ayuda: AYUDA.rfc },
  { campo: 'nss', etiqueta: 'NSS', pregunta: '¿Cuál es tu *NSS* (Número de Seguro Social)?', validar: validarNSS, ayuda: AYUDA.nss },
  {
    campo: 'relative_in_company', etiqueta: 'Familiar/pareja en la empresa',
    pregunta: '¿Tienes algún *familiar o pareja* que trabaje *actualmente* en Mega Dulces? '
      + '(esposo/a, hermano/a, hijo/a, papá/mamá o novio/a)\n\n'
      + '• Si *sí*: dime su *nombre* y el *parentesco*.\n• Si *no*: escribe *ninguno*.',
  },
  {
    // Reingresos: los cuatro datos que pidió Capital Humano en UNA pregunta (cuatro pasos los contestaría «no aplica»
    // la gran mayoría, que nunca ha trabajado aquí).
    campo: 'rehire_note', etiqueta: 'Ya trabajó en Mega Dulces',
    pregunta: 'Una última pregunta 🙏 ¿*Ya habías trabajado* en Mega Dulces antes?\n\n'
      + '• Si *sí*: dime en qué *sucursal*, qué *puesto* tenías, quién era tu *jefe directo* y *cuánto tiempo* estuviste.\n'
      + '• Si *no*: escribe *no*.',
  },
];

const CAMPOS_OPCIONALES_PRACTICANTE: readonly CampoRegistro[] = ['rfc', 'nss'];

export function esPracticante(datos: DatosRegistro): boolean {
  return /practic|becari|pasant/.test(normalizarTexto(datos.position_interest));
}

/** ¿Este paso es opcional para ESTA persona? El correo siempre; RFC/NSS si es practicante. */
function campoOpcional(paso: Paso, datos: DatosRegistro): boolean {
  return !!paso.opcionalSiempre || (CAMPOS_OPCIONALES_PRACTICANTE.includes(paso.campo) && esPracticante(datos));
}

/** ¿Se puede zafar de este paso con «no tengo»/«después»? */
function puedeOmitirse(paso: Paso): boolean {
  return !!paso.opcionalSiempre || CAMPOS_OPCIONALES_PRACTICANTE.includes(paso.campo);
}

function preguntaDe(paso: Paso, datos: DatosRegistro): string {
  if (!campoOpcional(paso, datos)) return paso.pregunta;
  return `${paso.pregunta}\n${paso.pistaOpcional
    || '_(Si no lo tienes a la mano, escribe *después* y seguimos; puedes entregarlo más adelante.)_'}`;
}

// ── Puesto y ciudad: sin ellos no se avanza ──────────────────────────────────────────────

const CAMPOS_CLAVE: readonly CampoRegistro[] = ['position_interest', 'city_branch'];
const RESPUESTA_VAGA = /^(cualquier[a]?( (puesto|cosa|ciudad|lugar|sucursal|lado|parte))?|lo que (sea|haya|tengan?)|el que (sea|haya|tengan?)|la que (sea|haya|tengan?)|donde (sea|haya|tengan?|me toque)|en donde sea|no se|nose|ns|ninguno|ninguna|nada|na|n ?\/? ?a|no|x+|todos?|todas?|indistinto|me da igual|da igual|igual|lo que me (den|ofrezcan))$/;

/** ¿La respuesta dice de verdad una ciudad o un puesto? */
export function esDatoClaro(valor: string | null | undefined): boolean {
  if (!lleno(valor)) return false;
  const t = normalizarTexto(valor).replace(/[^a-z0-9/ ]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length >= 2 && !RESPUESTA_VAGA.test(t);
}

function falta(paso: Paso, datos: DatosRegistro): boolean {
  const v = datos[paso.campo];
  return CAMPOS_CLAVE.includes(paso.campo) ? !esDatoClaro(v) : !lleno(v);
}

function faltaClave(datos: DatosRegistro): Paso | null {
  return PASOS.find((p) => CAMPOS_CLAVE.includes(p.campo) && falta(p, datos)) ?? null;
}

function pideDatoClave(paso: Paso): string {
  return paso.campo === 'position_interest'
    ? 'Para avanzar necesito saber *qué puesto* te interesa 🙏 Dime uno en concreto '
      + '(por ejemplo: *cajero*, *vendedor*, *almacenista*).\n\n'
      + '_Si no sabes cuáles hay, escribe *vacantes* y te muestro las que están abiertas._'
    : 'Para avanzar necesito saber en *qué ciudad* te gustaría trabajar 🙏 '
      + '(por ejemplo: *Zamora*, *La Piedad*, *Morelia*, *Yurécuaro*).\n\n'
      + '_Si no sabes dónde estamos, escribe *sucursales* y te las muestro._';
}

/**
 * ¿Es un saludo y no un puesto? Un «hola, busco de cajera» NO lo es: si habla de trabajo, trae contenido. El mismo
 * clasificador que usa la orientación (una sola lista de cortesías, no dos).
 */
export function esSaludoSinPuesto(texto: string, vacantes: readonly VacanteBot[]): boolean {
  return clasificarPuestoTexto(texto, vocabularioDe(vacantes)) === 'saludo';
}

/** La ciudad del catálogo que nombra el texto, o null si no nombra ninguna (o nombra varias: no se adivina). */
export function ciudadDelCatalogo(texto: string | null | undefined): string | null {
  const encontradas = ciudadesDelTexto(texto);
  return encontradas.length === 1 ? etiquetaCiudad(encontradas[0]) : null;
}

// ── Mensajes ─────────────────────────────────────────────────────────────────────────────

export const SALUDO = '¡Hola! 👋 Bienvenido(a) al reclutamiento de *MegaDulces*. '
  + 'Te haré unas preguntas para registrar tu solicitud.\n'
  + '💡 En cualquier momento puedes escribir *vacantes*, *sucursales* o *ayuda*.';

export const PIDE_CV = '¡Gracias! Ya tengo tus datos. 🙌\n\n'
  + 'Para *completar tu postulación* falta un último paso: tu *currículum (CV)* 📄\n\n'
  + 'Mándamelo por aquí en *PDF* o *foto* y con eso quedas listo(a).\n\n'
  + '_Sin tu CV tu postulación no queda registrada, así que no lo dejes pasar._';

const RECUERDA_CV = 'Sólo me falta tu *currículum (CV)* 📄 Mándamelo por aquí en *PDF* o *foto*.\n\n'
  + '_Si quieres corregir tus datos antes, escribe *reiniciar*._';

// `[RH.3.3]` traerá «yo te lo armo» (la solicitud de empleo por aquí). Mientras, se dice la verdad.
const SIN_CV_TODAVIA = 'Entiendo 🙏 Por ahora necesito tu CV en *PDF* o como *foto* (aunque sea sencillo, '
  + 'con tus datos y tus trabajos anteriores). Tus datos ya quedaron guardados: cuando lo tengas, mándamelo por aquí.';

export const EN_REVISION = '¡Gracias! Tu postulación está *completa* y en este momento el equipo de '
  + 'Capital Humano la está *revisando* 👀\n\n'
  + 'En cuanto tengamos una respuesta te escribimos por aquí. No necesitas hacer nada más. 🙌';

const YA_RESPONDIDA = 'Ya revisamos tu solicitud y te respondimos arriba 🙌\n'
  + 'Si quieres registrarte de nuevo más adelante, escribe *reiniciar*.';

export function construirMenu(): string {
  return '🤖 *Soy el asistente de reclutamiento de MegaDulces.* Te ayudo a registrarte como candidato.\n\n'
    + 'En cualquier momento puedes escribir:\n'
    + '• *vacantes* — ver los puestos disponibles\n'
    + '• *sucursales* — ver nuestras tiendas y direcciones\n'
    + '• *reiniciar* — empezar tu registro de nuevo\n\n'
    + 'O simplemente responde las preguntas para completar tu registro. '
    + 'Si no sabes un dato (como tu RFC o NSS), escríbeme "no sé" y te digo cómo obtenerlo.';
}

export function construirVacantes(vacantes: readonly VacanteBot[]): string {
  const cierre = '\n\nSi te interesa alguna, continúa con tu registro y te contactamos. '
    + 'Y si no ves el puesto que buscas, ¡regístrate igual! Te tomamos en cuenta para futuras vacantes.';
  const unicas = vacantesUnicas(vacantes);
  if (!unicas.length) {
    return '💼 Por ahora no tenemos vacantes publicadas, pero *regístrate igual*: te tomamos en cuenta para las próximas.';
  }
  const lineas = unicas.map((v) => `• *${v.name}*${lleno(v.salary_text) ? ` — ${v.salary_text.trim()}` : ''}`).join('\n');
  return `💼 *Vacantes disponibles en MegaDulces:*\n${lineas}${cierre}`;
}

export function construirSucursales(): string {
  return `📍 *Nuestras sucursales:*\n\n${HR_SUCURSALES_EMPLEO.map((s) => `*${s.ciudad}*\n${s.direccion}`).join('\n\n')}`;
}

/** Sólo para el puesto que SÍ existe: el que no existe pasa por la orientación. */
function comentarioPuesto(nombreVacante: string): string {
  return `¡Buenas noticias! 🎉 Sí tenemos vacante de *${nombreVacante}*. Sigamos con tu registro.`;
}

export function construirResumen(datos: DatosRegistro): string {
  const lineas = PASOS.map((p, i) => `${i + 1}. *${p.etiqueta}:* ${lleno(datos[p.campo]) ? datos[p.campo] : '—'}`).join('\n');
  return `Revisa que tus datos sean correctos:\n\n${lineas}\n\n¿Todo correcto? Responde *sí* para confirmar.\n`
    + `Para corregir un dato, escribe su *número* (1-${PASOS.length}).\nO escribe *reiniciar* para empezar de nuevo.`;
}

// ── Comandos ─────────────────────────────────────────────────────────────────────────────

const RELLENO_COMANDO = new Set([
  'hola', 'oye', 'ver', 'veo', 'mostrar', 'muestrame', 'muestreme', 'dime', 'digame',
  'quiero', 'saber', 'busco', 'que', 'cuales', 'cual', 'donde', 'hay', 'tienen', 'tiene',
  'son', 'estan', 'esta', 'el', 'la', 'las', 'los', 'sus', 'de', 'del', 'mas', 'disponibles',
  'disponible', 'abiertas', 'abiertos', 'actuales', 'por', 'favor', 'porfa', 'porfavor',
  'me', 'puedes', 'puede', 'pasar', 'pasas', 'lista', 'info', 'informacion',
]);
const PALABRAS_COMANDO: Record<'menu' | 'vacantes' | 'sucursales', readonly string[]> = {
  menu: ['ayuda', 'menu', 'opciones', 'comandos'],
  vacantes: ['vacante', 'vacantes', 'empleo', 'empleos', 'puesto', 'puestos', 'trabajo', 'trabajos'],
  sucursales: ['sucursal', 'sucursales', 'tienda', 'tiendas', 'ubicacion', 'ubicaciones', 'direccion', 'direcciones'],
};

/**
 * ¿El mensaje ES un comando? Sólo si, quitando el relleno («ver», «qué», «hay»…), queda UNA de esas palabras. Antes
 * bastaba con que la contuviera, y quien contestaba «el puesto de vendedor» recibía la lista de vacantes para siempre.
 */
export function comandoInformativo(texto: string): 'menu' | 'vacantes' | 'sucursales' | null {
  if (String(texto || '').trim() === '?') return 'menu';
  const palabras = normalizarTexto(texto).replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/).filter((p) => p && !RELLENO_COMANDO.has(p));
  if (palabras.length !== 1) return null;
  for (const [comando, lista] of Object.entries(PALABRAS_COMANDO) as Array<[keyof typeof PALABRAS_COMANDO, readonly string[]]>) {
    if (lista.includes(palabras[0])) return comando;
  }
  return null;
}

// ── La respuesta a un paso ───────────────────────────────────────────────────────────────

type Procesado = { error: string } | { valor: string; omitido?: boolean };

function procesarRespuesta(paso: Paso, texto: string, datos: DatosRegistro, ctx: ContextoRegistro): Procesado {
  if (texto === '') return { error: `Por favor responde con *texto* 🙂\n\n${paso.pregunta}` };
  if (campoOpcional(paso, datos) && quiereOmitir(texto)) return { valor: paso.sentinelOmitido || NO_APLICA, omitido: true };
  if (CAMPOS_CLAVE.includes(paso.campo) && !esDatoClaro(texto)) return { error: pideDatoClave(paso) };
  if (paso.campo === 'position_interest' && esSaludoSinPuesto(texto, ctx.vacantes)) {
    return { error: '¡Hola! 👋 Con gusto te ayudo.\n\nPara empezar dime qué *puesto* te interesa. Si no sabes cuál, '
      + 'escribe *vacantes* y te muestro lo que hay abierto 👇' };
  }
  if (paso.ayuda && esNoSe(texto)) return { error: paso.ayuda };
  if (paso.validar) {
    const r = paso.validar(texto);
    return r.ok ? { valor: r.valor } : { error: r.error };
  }
  if (pareceTecleoAlAzar(texto)) {
    return { error: `Mmm, eso no lo entendí 🤔 Parece que se te fue el dedo. Escríbelo de nuevo, por favor:\n\n${paso.pregunta}` };
  }
  return { valor: texto.replace(/\s+/g, ' ').slice(0, 300) };
}

const PREFIJO = 'esperando_';
const PREFIJO_EDIT = 'editando_';
const AFIRMATIVAS = ['si', 'sí', 'ok', 'okay', 'correcto', 'confirmar', 'confirmo', 'claro', 'sip'];

function indicePorPrefijo(estado: string, prefijo: string): number {
  if (!estado.startsWith(prefijo)) return -1;
  const campo = estado.slice(prefijo.length);
  return PASOS.findIndex((p) => p.campo === campo);
}

export const ESTADO_ORIENTA = 'orientando_puesto';

/** Cuántas veces se le repregunta si su respuesta a la oferta no se entiende (a la siguiente, sigue el registro). */
const MAX_RONDAS_ORIENTACION = 2;

/** Tope de la respuesta de la IA a una duda: es texto que le llega a una persona, se acota. */
const MAX_RESPUESTA_IA = 600;

/**
 * `[RH.3.2.1]` ¿Hay que consultar a la IA para este mensaje, y por cuáles campos? Devuelve los que faltan, o null si NO
 * se consulta. Las mismas reglas que Mega Talento:
 *   · Sólo en el primer mensaje (`nuevo`) o capturando un dato. En la orientación, el resumen, las correcciones y el CV
 *     manda el camino determinista.
 *   · Nunca para un comando ni para `reiniciar`.
 *   · Nunca si quiere omitir/diferir un dato que puede omitirse: al obligatorio se le contesta firme y el opcional se
 *     salta (la IA lo leía como duda y lo volvía a pedir en un bucle).
 */
export function faltantesParaIA(estado: string, datos: DatosRegistro, textoCrudo: string | null): CampoRegistro[] | null {
  const texto = (textoCrudo ?? '').trim();
  if (!texto || texto.toLowerCase() === 'reiniciar' || comandoInformativo(texto)) return null;
  if (estado === 'nuevo') return PASOS.map((p) => p.campo);
  const i = indicePorPrefijo(estado, PREFIJO);
  if (i === -1) return null;
  if (puedeOmitirse(PASOS[i]) && quiereOmitir(texto)) return null;
  const faltan = PASOS.filter((p) => falta(p, datos)).map((p) => p.campo);
  return faltan.length ? faltan : null;
}

/** Lo que se le recuerda tras contestarle un comando (o un archivo/audio fuera de lugar), para que sepa qué le tocaba. */
export function preguntaPendiente(estado: string, datos: DatosRegistro, orientacion: EstadoOrientacion | null = null): string {
  const i = indicePorPrefijo(estado, PREFIJO);
  if (i !== -1) return `\n\n${preguntaDe(PASOS[i], datos)}`;
  const e = indicePorPrefijo(estado, PREFIJO_EDIT);
  if (e !== -1) return `\n\n${preguntaDe(PASOS[e], datos)}`;
  if (estado === 'confirmando') return '\n\nResponde *sí* para confirmar tus datos.';
  if (estado === 'esperando_cv') return `\n\n${RECUERDA_CV}`;
  // En medio de la orientación: si no se le recuerda, tras pedir «vacantes» no sabe qué le tocaba contestar.
  if (estado === ESTADO_ORIENTA) {
    const ofrecidas = orientacion?.ofrecidas ?? [];
    return ofrecidas.length
      ? `\n\n¿Cuál de estas te interesa? ${ofrecidas.map((n) => `*${n}*`).join(', ')} — o escribe *ninguno*.`
      : '\n\nDime en qué *ciudad* te queda mejor trabajar y te digo qué hay cerca de ti.';
  }
  return '';
}

// ── El turno ─────────────────────────────────────────────────────────────────────────────

/**
 * Un mensaje de texto de la persona → el estado nuevo y qué decirle. `texto` es null para lo que no es texto (el
 * servicio atiende el CV antes de llegar aquí). `orientacion`: la que traía la conversación.
 */
export function avanzarRegistro(estado: string, datos: DatosRegistro, textoCrudo: string | null, ctx: ContextoRegistro,
  orientacion: EstadoOrientacion | null = null): Turno {
  const texto = (textoCrudo ?? '').trim();
  const ahora = (ctx.ahora ?? new Date()).toISOString();
  const turno = (e: string, d: DatosRegistro, ...respuestas: string[]): Turno => ({ estado: e, datos: d, orientacion, respuestas });

  // `reiniciar` funciona en cualquier momento: borra lo contestado y vuelve al primer paso.
  if (texto.toLowerCase() === 'reiniciar') {
    return { estado: PREFIJO + PASOS[0].campo, datos: {}, orientacion: null, respuestas: [`🔄 Empezamos de nuevo.\n\n${PASOS[0].pregunta}`], reiniciado: true };
  }

  const comando = comandoInformativo(texto);
  if (comando) {
    const info = comando === 'menu' ? construirMenu() : comando === 'vacantes' ? construirVacantes(ctx.vacantes) : construirSucursales();
    if (estado === 'nuevo') return turno(PREFIJO + PASOS[0].campo, datos, `${info}\n\n${SALUDO}\n\n${PASOS[0].pregunta}`);
    return turno(estado, datos, info + preguntaPendiente(estado, datos, orientacion));
  }

  /** Sigue el registro donde se quedó (tras la orientación): el primer dato que falte, o el resumen. */
  const seguirRegistro = (d: DatosRegistro, ori: EstadoOrientacion | null, texto0: string): Turno => {
    const siguiente = PASOS.find((p) => falta(p, d));
    return siguiente
      ? { estado: PREFIJO + siguiente.campo, datos: d, orientacion: ori, respuestas: [`${texto0}\n\n${preguntaDe(siguiente, d)}`] }
      : { estado: 'confirmando', datos: d, orientacion: ori, respuestas: [`${texto0}\n\n${construirResumen(d)}`] };
  };

  /**
   * Le ofrece lo que hay (o le pregunta su ciudad) y deja constancia de qué pidió y qué se le ofreció. Si no hay mensaje
   * de orientación (era un saludo), vuelve a pedirle el puesto.
   */
  const orientarTurno = (d: DatosRegistro, pedido: string, rondas: number, prefijo = ''): Turno => {
    const decision = orientar(pedido, d.city_branch, ctx.vacantes);
    const msg = mensajeOrientacion(decision, pedido);
    if (!msg) {
      const sinPuesto = { ...d };
      delete sinPuesto.position_interest;
      return { estado: PREFIJO + PASOS[0].campo, datos: sinPuesto, orientacion, respuestas: [prefijo + PASOS[0].pregunta] };
    }
    const ori: EstadoOrientacion = {
      ...(orientacion ?? {}), pedido: pedido.slice(0, 200), tipo: decision.tipo, ofrecidas: nombresOfrecidos(decision), rondas, en: ahora,
    };
    return { estado: ESTADO_ORIENTA, datos: d, orientacion: ori, respuestas: [prefijo + msg] };
  };

  /**
   * `[RH.3.2.1]` Aplica lo que la IA propuso (el `manejarConIA` de Mega Talento): primero contesta su duda, luego guarda
   * SÓLO los datos que pasan los validadores, y pide el siguiente que falte (o el resumen). Un RFC/NSS/correo mal formado
   * se le dice y no se guarda; un puesto o ciudad vagos, o un saludo como puesto, se descartan en silencio y se vuelven a
   * pedir. El puesto que no existe va a la orientación, con todo lo anterior de prefijo.
   */
  const aplicarIA = (interp: InterpretacionRegistro, prefijo: string | null): Turno => {
    const partes: string[] = prefijo ? [prefijo] : [];
    const duda = String(interp.respuesta_pregunta ?? '').trim();
    if (duda) partes.push(duda.slice(0, MAX_RESPUESTA_IA));
    const nuevos: DatosRegistro = { ...datos };
    let puestoNuevo: string | null = null;
    for (const p of PASOS) {
      const val = String(interp.datos?.[p.campo] ?? '').trim();
      if (!val) continue;
      if (CAMPOS_CLAVE.includes(p.campo) && !esDatoClaro(val)) continue;
      if (p.campo === 'position_interest' && esSaludoSinPuesto(val, ctx.vacantes)) continue;
      if (p.validar) {
        const r = p.validar(val);
        if (!r.ok) { partes.push(r.error); continue; }
        nuevos[p.campo] = r.valor;
      } else {
        nuevos[p.campo] = val.replace(/\s+/g, ' ').slice(0, 300);
      }
      if (p.campo === 'position_interest') puestoNuevo = nuevos[p.campo] ?? null;
    }
    if (puestoNuevo) {
      const vacante = resolverVacante(puestoNuevo, vacantesUnicas(ctx.vacantes));
      if (!vacante) return orientarTurno(nuevos, puestoNuevo, 0, partes.length ? `${partes.join('\n\n')}\n\n` : '');
      partes.push(comentarioPuesto(vacante.name));
    }
    const siguiente = PASOS.find((p) => falta(p, nuevos));
    if (!siguiente) return turno('confirmando', nuevos, [...partes, construirResumen(nuevos)].join('\n\n'));
    return turno(PREFIJO + siguiente.campo, nuevos, [...partes, preguntaDe(siguiente, nuevos)].join('\n\n'));
  };
  const iaUtil = (interp: InterpretacionRegistro | null | undefined): interp is InterpretacionRegistro =>
    !!interp && (Object.values(interp.datos ?? {}).some((v) => lleno(v)) || lleno(interp.respuesta_pregunta));

  // Contestó a la oferta. Cuatro caminos y ninguno lo deja atorado.
  if (estado === ESTADO_ORIENTA) {
    const ofrecidas = orientacion?.ofrecidas ?? [];
    const rondas = orientacion?.rondas ?? 0;
    const pedido = orientacion?.pedido || datos.position_interest || '';
    const r = interpretarRespuestaOferta(texto, ofrecidas);
    // 1. Eligió una de las vacantes: ese es su puesto.
    if (r.tipo === 'elige') {
      return seguirRegistro({ ...datos, position_interest: r.nombre },
        { ...(orientacion as EstadoOrientacion), aceptada: r.nombre, aceptada_en: ahora },
        `¡Excelente elección! 🎉 Te registro para *${r.nombre}*. Sigamos con tus datos.`);
    }
    // 2. Dijo su ciudad: se guarda si aún no la teníamos y se le vuelve a ofrecer (no cuenta como ronda fallida).
    if (r.tipo === 'ciudad') {
      const d = lleno(datos.city_branch) ? datos : { ...datos, city_branch: texto.replace(/\s+/g, ' ').slice(0, 300) };
      return orientarTurno(d, pedido, rondas);
    }
    // 3. No le interesa nada: se respeta, su registro vale igual y queda anotado para cuando se abra lo que busca.
    if (r.tipo === 'rechaza') {
      return seguirRegistro(datos, { ...(orientacion as EstadoOrientacion), rechazada: true, rechazada_en: ahora },
        `Sin problema 🙌 Te dejo registrado para *${pedido || 'el puesto que buscas'}* y en cuanto se abra algo así te escribo. `
        + 'Terminemos tus datos para tenerte listo.');
    }
    // 4. No se entendió: una repregunta con la lista numerada, y ya.
    if (rondas < MAX_RONDAS_ORIENTACION - 1 && ofrecidas.length) {
      return {
        estado, datos, orientacion: { ...(orientacion as EstadoOrientacion), rondas: rondas + 1 },
        respuestas: ['Perdón, no te entendí 🤔 Dime el *número* o el *nombre* del puesto que te interesa:\n\n'
          + `${ofrecidas.map((n, k) => `${k + 1}. *${n}*`).join('\n')}\n\n`
          + 'Y si ninguno te late, escribe *ninguno* y seguimos con tu registro de todos modos 🙌'],
      };
    }
    // Se agotaron las rondas: NUNCA se le deja dando vueltas.
    return seguirRegistro(datos, orientacion, 'Va, sigamos con tu registro y lo vemos más adelante 🙌');
  }

  // Nuevo: se saluda y se pide el primer dato. El «hola» NO se guarda como dato. Si el primer mensaje ya traía datos
  // («hola, soy Juan de Zamora») o una duda, se aprovecha con el saludo de prefijo.
  if (estado === 'nuevo') {
    if (iaUtil(ctx.interpretacion)) return aplicarIA(ctx.interpretacion, SALUDO);
    return turno(PREFIJO + PASOS[0].campo, datos, `${SALUDO}\n\n${PASOS[0].pregunta}`);
  }

  // Capturando un dato.
  const i = indicePorPrefijo(estado, PREFIJO);
  if (i !== -1) {
    const paso = PASOS[i];
    const opcional = campoOpcional(paso, datos);
    // Quiere diferir un dato OBLIGATORIO: respuesta clara y firme, sin bucle.
    if (puedeOmitirse(paso) && !opcional && quiereOmitir(texto) && !(paso.ayuda && esNoSe(texto))) {
      return turno(estado, datos, `Te entiendo 🙂, pero el *${paso.etiqueta}* sí lo necesitamos para completar tu `
        + 'registro y poder avanzar con tu proceso. En cuanto lo tengas a la mano, escríbelo aquí y seguimos.');
    }
    // La IA, si el servicio la consultó y trajo algo (varios datos a la vez, o una duda).
    if (iaUtil(ctx.interpretacion)) return aplicarIA(ctx.interpretacion, null);
    const r = procesarRespuesta(paso, texto, datos, ctx);
    if ('error' in r) return turno(estado, datos, r.error);
    const nuevos = { ...datos, [paso.campo]: r.valor };
    // El puesto que NO existe se desvía a la orientación (lo pedido se guarda: es la demanda que no cubrimos).
    const vacante = paso.campo === 'position_interest' ? resolverVacante(r.valor, vacantesUnicas(ctx.vacantes)) : null;
    if (paso.campo === 'position_interest' && !vacante) return orientarTurno(nuevos, r.valor, 0);
    // Lo que falta (en orden): así un dato ya capturado (p. ej. tras corregir) no se vuelve a pedir.
    const siguiente = PASOS.slice(i + 1).find((p) => falta(p, nuevos)) ?? PASOS.find((p) => falta(p, nuevos));
    if (!siguiente) return turno('confirmando', nuevos, construirResumen(nuevos));
    const extra = vacante ? `${comentarioPuesto(vacante.name)}\n\n` : '';
    const aviso = 'omitido' in r && r.omitido ? (paso.avisoOmitido || 'Sin problema, lo dejamos pendiente. ') : '';
    return turno(PREFIJO + siguiente.campo, nuevos, extra + aviso + preguntaDe(siguiente, nuevos));
  }

  // Corrigiendo un dato desde el resumen: se guarda y se regresa al resumen.
  const e = indicePorPrefijo(estado, PREFIJO_EDIT);
  if (e !== -1) {
    const paso = PASOS[e];
    const r = procesarRespuesta(paso, texto, datos, ctx);
    if ('error' in r) return turno(estado, datos, r.error);
    const nuevos = { ...datos, [paso.campo]: r.valor };
    return turno('confirmando', nuevos, `✅ *${paso.etiqueta}* actualizado.\n\n${construirResumen(nuevos)}`);
  }

  if (estado === 'confirmando') {
    if (AFIRMATIVAS.includes(texto.toLowerCase())) {
      // Sin puesto y ciudad claros no se pasa de aquí.
      const clave = faltaClave(datos);
      if (clave) return turno(PREFIJO_EDIT + clave.campo, datos, pideDatoClave(clave));
      return { ...turno('esperando_cv', datos, PIDE_CV), confirmado: true };
    }
    const num = Number(texto);
    if (Number.isInteger(num) && num >= 1 && num <= PASOS.length) {
      const paso = PASOS[num - 1];
      return turno(PREFIJO_EDIT + paso.campo, datos, `Vamos a corregir *${paso.etiqueta}*.\n\n${preguntaDe(paso, datos)}`);
    }
    return turno(estado, datos, `Responde *sí* para confirmar, el *número* (1-${PASOS.length}) del dato a corregir, `
      + 'o *reiniciar* para empezar de nuevo.');
  }

  if (estado === 'esperando_cv') {
    const t = normalizarTexto(texto);
    const noTiene = /^(2|dos)$/.test(t)
      || /(ayuda|ayudame|hazme|armalo|no tengo|no cuento|no se hacer|no se como|nunca he hecho|no lo tengo|como lo hago|no puedo)/.test(t);
    return turno(estado, datos, noTiene ? SIN_CV_TODAVIA : RECUERDA_CV);
  }

  if (estado === 'postulada') return turno(estado, datos, EN_REVISION);
  if (estado === 'rechazada') return turno(estado, datos, YA_RESPONDIDA);

  // Un estado que no se conoce (no debería pasar): se retoma el registro donde falte.
  const pendiente = PASOS.find((p) => falta(p, datos));
  return pendiente
    ? turno(PREFIJO + pendiente.campo, datos, preguntaDe(pendiente, datos))
    : turno('confirmando', datos, construirResumen(datos));
}

// ── De lo contestado a la postulación ────────────────────────────────────────────────────

export interface PostulacionDesdeBot {
  full_name: string | null;
  email: string | null;
  city_branch: string | null;
  job_posting_id: string | null;
  position_interest: string | null;
  relative_in_company: string | null;
  rehire_note: string | null;
  commute_time: string | null;
  availability: string | null;
  previous_employer: string | null;
  desired_salary: string | null;
  rfc: string | null;
  nss: string | null;
}

/**
 * Lo contestado, listo para las reglas de postulación:
 *   · la ciudad se lleva al CATÁLOGO cuando se reconoce («canindo» → Zamora); si no, queda como la escribió;
 *   · la vacante se liga por id sólo si se reconoce Y aplica en esa ciudad (si no, `postular` la rechazaría con un
 *     error que la persona no entendería: queda como puesto de interés, en texto, para que RH lo vea);
 *   · los centinelas («Sin correo», «No aplica») no se mandan como dato: son ausencia declarada.
 */
export function postulacionDesdeRegistro(datos: DatosRegistro, vacantes: readonly VacanteBot[]): PostulacionDesdeBot {
  const v = (k: CampoRegistro): string | null => (lleno(datos[k]) && datos[k] !== NO_APLICA && datos[k] !== SIN_CORREO ? String(datos[k]).trim() : null);
  const ciudad = ciudadDelCatalogo(datos.city_branch);
  const vacante = resolverVacante(datos.position_interest, vacantesUnicas(vacantes));
  const aplica = !!vacante && (!vacante.branch_codes?.length || (!!ciudad && hrVacanteEnCiudad(vacante.branch_codes, ciudad)));
  return {
    full_name: v('full_name'), email: v('email'), city_branch: ciudad ?? v('city_branch'),
    job_posting_id: aplica && vacante ? vacante.id : null,
    position_interest: aplica && vacante ? vacante.name : v('position_interest'),
    relative_in_company: v('relative_in_company'), rehire_note: v('rehire_note'), commute_time: v('commute_time'),
    availability: v('availability'), previous_employer: v('previous_employer'), desired_salary: v('desired_salary'),
    rfc: v('rfc'), nss: v('nss'),
  };
}
