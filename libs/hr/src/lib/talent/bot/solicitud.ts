import { pareceTecleoAlAzar, type DatosRegistro } from './registro';

/**
 * Fase RH · `[RH.3.3.3]` — LA SOLICITUD DE EMPLEO, PREGUNTA POR PREGUNTA (para quien no tiene CV). Lógica PURA, portada
 * de `solicitud.js` de Mega Talento: el CV es obligatorio, y mucha gente que sirve para el puesto no tiene uno ni sabe
 * hacerlo. El bot le hace las preguntas de la hoja de papel que RH ya usa (TPASA 2002) y con eso arma su CV.
 *
 * Es un CATÁLOGO, no un if gigante: ~130 preguntas que se cuentan, se prueban y se reordenan sin tocar la lógica. La
 * máquina recibe las respuestas que hay y dice cuál sigue.
 *
 * Cuando un dato ya lo tenemos del registro (nombre, correo, RFC, NSS…), la pregunta se hace igual pero con la
 * respuesta sugerida: contesta *sí* y avanza. Confirmar no es saltarse; es no escribir dos veces lo mismo.
 *
 * ── Lo sensible, con consentimiento expreso (decisión de David, 14-oct) ─────────────────────────────────────────────
 *  La hoja pregunta salud, estatura y peso, familia, situación económica y afiliación sindical. La salud y el sindicato
 *  son datos SENSIBLES (LFPDPPP art. 3) y piden consentimiento expreso y por escrito (art. 9). Esas preguntas sólo
 *  EXISTEN si hay un texto de consentimiento VIGENTE (`CtxSolicitud.consentimiento`) y la persona contestó «sí»; si
 *  dice que no —o se retracta con «atrás»—, no se le preguntan y lo ya contestado se BORRA (`purgarSensibles`). Sin
 *  texto vigente, el bloque no se pregunta (mismo criterio fail-closed que el aviso de privacidad de PRV.2).
 *  «¿Estás embarazada?» sigue apagada (LFT art. 133 XIV), como en Mega Talento.
 *
 * ── Lo que no se porta todavía ──────────────────────────────────────────────────────────────────────────────────────
 *  Leer un dato de la FOTO de un documento (INE, CURP…): el catálogo conserva `deFoto`, pero la pregunta no ofrece
 *  mandar foto mientras no exista quien la lea (sería prometer algo que no hace).
 */

export type Respuestas = Record<string, string>;

/** El texto de consentimiento para las preguntas sensibles. Su versión queda guardada junto a la respuesta. */
export interface ConsentimientoSensibles { version: string; texto: string }

export interface CtxSolicitud {
  /** Lo que contestó en el registro (para las sugerencias). */
  registro: DatosRegistro;
  /** Su teléfono (10 dígitos). */
  telefono: string;
  /** El consentimiento VIGENTE; null = no hay texto oficial y lo sensible no se pregunta. */
  consentimiento: ConsentimientoSensibles | null;
  /** Por omisión apagada (LFT art. 133 XIV). */
  preguntarEmbarazo?: boolean;
  /** Para calcular la edad (inyectable en pruebas). */
  hoy?: Date;
}

type Validacion = { ok: true; valor: string } | { ok: false; error: string };

interface Pregunta {
  k: string;
  bloque: string;
  etiqueta: string;
  pregunta: string | ((ctx: CtxSolicitud) => string);
  validar?: (t: string, ctx: CtxSolicitud) => Validacion;
  opciones?: readonly string[];
  sugerir?: (d: Respuestas, ctx: CtxSolicitud) => string;
  cuando?: (d: Respuestas, ctx: CtxSolicitud) => boolean;
  sinDato?: boolean;
  numeroOk?: boolean;
  deFoto?: string;
  tipo?: 'foto';
  /** Sólo con consentimiento expreso vigente. */
  sensible?: boolean;
}

// ── Textos fijos ─────────────────────────────────────────────────────────────────────────

export const NO_APLICA = 'No aplica';
const SIN_MEMORIA = 'No recuerda';

const CONFIRMA = /^(s[ií]|si+|sip|claro|correcto|as[ií] es|exacto|est[aá] bien|ok|okey|okay|afirmativo|sale|va|yes)\.?$/i;
// El `(?:l[oa]s?\s+|me\s+)?`: la gente contesta «no LA tengo», «no LO sé», «no ME acuerdo».
const SIN_DATO = /\bno\s+(?:l[oa]s?\s+|me\s+)?(tengo|aplica|cuento|s[eé]|recuerdo|manejo|uso|acuerdo)\b|^no\.?$|^ninguno\.?$|^ninguna\.?$|^n\/?a\.?$|^na\.?$|^-+$|no\s+aplica|sin\s+dato/i;
export const CMD_PAUSA = /^(pausa|pausar|luego|despu[eé]s|ahorita no|espera|alto|stop)\.?$/i;
export const CMD_ATRAS = /^(atr[aá]s|atras|anterior|regresa[r]?|volver|me equivoqu[eé]|corrige|corregir)\.?$/i;
export const CMD_SEGUIR = /^(seguir|continuar|contin[uú]a|sigue|retomar|ya|listo|vamos|dale)\.?$/i;
// La salida explícita para quien de plano no sabe el dato (no basta un «-»): se guarda como dato, no como hueco.
const NO_RECUERDO = /^(no lo recuerdo|no recuerdo|no me acuerdo|ya no (lo )?recuerdo|se me olvid[oó]|no me acuerdo bien)\.?$/i;

// ── Validadores (a propósito TOLERANTES: rechazar de más es perder al candidato en la pregunta 40) ──────────────

/** Texto libre: con sustancia («--», «...», «aa», «ok» no; «CFE» y «2800» sí) y sin tecleo al azar. */
export function vTexto(t: string): Validacion {
  const v = String(t ?? '').trim().replace(/\s+/g, ' ');
  const pegado = v.replace(/\s/g, '');
  const letras = (v.match(/[a-záéíóúüñA-ZÁÉÍÓÚÜÑ]/g) ?? []).length;
  const digitos = (v.match(/\d/g) ?? []).length;
  const flojo: Validacion = { ok: false, error: 'Eso no se ve como una respuesta 🤔 Escríbela completa, por favor.\n'
    + '_Si de plano no te acuerdas, escribe *no lo recuerdo* y seguimos._' };
  if (!letras && !digitos) return flojo;
  if (pegado.length >= 2 && new Set(pegado.toLowerCase()).size <= 1) return flojo;
  // Si trae dígitos no se exigen dos letras: «D-8659550» es una matrícula de cartilla de verdad.
  if (!digitos && (pegado.length < 3 || letras < 2)) return { ok: false, error: 'Se ve muy corto. Escríbelo completo, por favor.' };
  if (pareceTecleoAlAzar(v)) {
    return { ok: false, error: 'Mmm, eso no lo entendí 🤔 Parece que se te fue el dedo. Escríbelo de nuevo, por favor.\n'
      + '_Si no sabes qué contestar aquí, escribe *no lo recuerdo* y seguimos._' };
  }
  return { ok: true, valor: v };
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const sinAcentos = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** Edad a partir de «DD/MM/AAAA» o «AAAA-MM-DD»; null si no se entiende. */
export function edadDesde(fecha: string | null | undefined, hoy: Date = new Date()): number | null {
  const s = String(fecha ?? '').trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const mex = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  let a: number, m: number, d: number;
  if (iso) { a = +iso[1]; m = +iso[2]; d = +iso[3]; } else if (mex) { d = +mex[1]; m = +mex[2]; a = +mex[3]; } else return null;
  let e = hoy.getFullYear() - a;
  if (!(hoy.getMonth() + 1 > m || (hoy.getMonth() + 1 === m && hoy.getDate() >= d))) e -= 1;
  return e;
}

/** Fecha de nacimiento: «02/11/2007», «2 de noviembre de 2007», «02-11-07»; se guarda DD/MM/AAAA. */
export function vFecha(t: string, ctx?: CtxSolicitud): Validacion {
  const s = String(t ?? '').toLowerCase().trim();
  let d = 0, m = 0, a = 0;
  const num = s.match(/(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{2,4})/);
  if (num) { d = +num[1]; m = +num[2]; a = +num[3]; } else {
    const txt = s.match(/(\d{1,2})\s*(?:de\s+)?([a-záéíóú]+)\s*(?:de\s+)?(\d{2,4})/);
    if (txt) {
      const i = MESES.findIndex((n) => n.startsWith(sinAcentos(txt[2]).slice(0, 3)));
      if (i !== -1) { d = +txt[1]; m = i + 1; a = +txt[3]; }
    }
  }
  if (!d || !m || !a) return { ok: false, error: 'No entendí la fecha. Escríbela así: *02/11/2007* (día/mes/año).' };
  if (a < 100) a += a <= 25 ? 2000 : 1900;
  if (m < 1 || m > 12 || d < 1 || d > 31) return { ok: false, error: 'Esa fecha no existe. Escríbela así: *02/11/2007* (día/mes/año).' };
  const anios = edadDesde(`${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, ctx?.hoy);
  if (anios === null || anios < 14 || anios > 80) {
    return { ok: false, error: `Con esa fecha tendrías ${anios} años y no me cuadra. Revísala, por favor: *día/mes/año*.` };
  }
  return { ok: true, valor: `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${a}` };
}

export function vTelefono(t: string): Validacion {
  const v = String(t ?? '').replace(/\D/g, '').replace(/^52/, '');
  return v.length === 10 ? { ok: true, valor: v } : { ok: false, error: 'El teléfono va a *10 dígitos*, con lada. Ejemplo: *4431185227*.' };
}

export function vCorreo(t: string): Validacion {
  let v = String(t ?? '').trim().toLowerCase();
  v = v.replace(/\s*\(?\barroba\b\)?\s*/g, '@').replace(/\s+/g, '').replace(/[.,;]+$/, '');
  return /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(v) ? { ok: true, valor: v } : { ok: false, error: 'Ese correo no se ve completo. Escríbelo así: *nombre@gmail.com*' };
}

export function vCP(t: string): Validacion {
  const v = String(t ?? '').replace(/\D/g, '');
  return v.length === 5 ? { ok: true, valor: v } : { ok: false, error: 'El código postal son *5 dígitos*. Ejemplo: *58300*.' };
}

export function vRFC(t: string): Validacion {
  const v = String(t ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
  return /^[A-ZÑ&]{4}[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[A-Z0-9]{3}$/.test(v)
    ? { ok: true, valor: v }
    : { ok: false, error: 'Ese RFC no cuadra: son *13 caracteres* — 4 letras, 6 dígitos de fecha y 3 de homoclave (ejemplo: LOGA900101AB1).' };
}

export function vNSS(t: string): Validacion {
  const v = String(t ?? '').replace(/\D/g, '');
  return /^\d{11}$/.test(v) ? { ok: true, valor: v } : { ok: false, error: 'El NSS son exactamente *11 dígitos* (ejemplo: 12345678901).' };
}

/** Nivel de idioma: tiene que MENCIONAR un nivel (alguien contestó su teléfono y se guardaba como su nivel de inglés). */
export function vNivelIdioma(t: string): Validacion {
  const v = String(t ?? '').trim().replace(/\s+/g, ' ');
  return /basic|intermedi|avanzad|nativ|lengua materna|materno|poco|regular|fluid|bueno/.test(sinAcentos(v.toLowerCase()))
    ? { ok: true, valor: v }
    : { ok: false, error: 'Dime el *nivel*, con una de estas palabras: *básico*, *intermedio*, *avanzado* o *nativo*.\n_Ejemplo: "español nativo, inglés básico"._' };
}

/** ¿Es SOLO un número? Casi siempre es un error (el nombre de una escuela nunca lo es); `numeroOk` lo permite. */
export function esSoloNumero(texto: string): boolean {
  const v = String(texto ?? '').trim();
  return !!v && !/[a-záéíóúüñ]/i.test(v) && /\d/.test(v);
}

export function vINE(t: string): Validacion {
  const v = String(t ?? '').replace(/\D/g, '');
  return v.length >= 9 && v.length <= 18 ? { ok: true, valor: v } : { ok: false, error: 'Ese número no cuadra: el de la credencial trae entre 9 y 18 dígitos.' };
}

export function vCURP(t: string): Validacion {
  const v = String(t ?? '').toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z]{4}\d{6}[HM][A-Z]{2}[A-Z]{3}[A-Z0-9]\d$/.test(v)
    ? { ok: true, valor: v }
    : { ok: false, error: 'Esa CURP no cuadra: son *18 caracteres* (ejemplo: REHJ071102HSPYRS05).\nLa traes en tu INE o la consultas en gob.mx/curp. Si no la tienes, escribe *no tengo*.' };
}

/** Estatura en metros («1.65», «165», «1 m 65»): se normaliza a «1.65 m». */
export function vEstatura(t: string): Validacion {
  const m = String(t ?? '').toLowerCase().replace(',', '.').match(/(\d+(?:\.\d+)?)/);
  if (!m) return { ok: false, error: 'Dime tu estatura en metros. Ejemplo: *1.65*' };
  let n = parseFloat(m[1]);
  if (n > 100) n /= 100;
  if (n > 3) n /= 10;
  return n < 1.2 || n > 2.3 ? { ok: false, error: 'Esa estatura no me cuadra. Dímela en metros, ejemplo: *1.65*' } : { ok: true, valor: `${n.toFixed(2)} m` };
}

export function vPeso(t: string): Validacion {
  const m = String(t ?? '').replace(',', '.').match(/(\d+(?:\.\d+)?)/);
  if (!m) return { ok: false, error: 'Dime tu peso en kilos. Ejemplo: *56*' };
  const n = parseFloat(m[1]);
  return n < 35 || n > 250 ? { ok: false, error: 'Ese peso no me cuadra. Dímelo en kilos, ejemplo: *56*' } : { ok: true, valor: `${n % 1 ? n.toFixed(1) : n} kg` };
}

export function vRangoAnios(t: string): Validacion {
  const nums = String(t ?? '').match(/\d{4}/g);
  if (!nums?.length) return { ok: false, error: 'Dime los años. Ejemplo: *2013 a 2020*' };
  if (nums.length === 1) return { ok: true, valor: nums[0] };
  const [a, b] = [parseInt(nums[0], 10), parseInt(nums[1], 10)];
  return b < a ? { ok: false, error: 'El año de término va después del de inicio. Ejemplo: *2013 a 2020*' } : { ok: true, valor: `${a} - ${b}` };
}

/** Opciones fijas: por número, por palabra o por algo parecido («casada» ≈ «Casado(a)»). Con dos empates, se repregunta. */
export function vOpciones(opciones: readonly string[]): (t: string) => Validacion {
  const raiz = (x: string): string => sinAcentos(String(x ?? '').toLowerCase()).replace(/\([^)]*\)/g, '').replace(/[^a-z]/g, '');
  return (t) => {
    const dado = raiz(t);
    const n = parseInt(String(t ?? '').trim(), 10);
    if (Number.isInteger(n) && n >= 1 && n <= opciones.length) return { ok: true, valor: opciones[n - 1] };
    if (dado) {
      const candidatas = opciones.filter((o) => {
        const oo = raiz(o);
        return !!oo && (oo === dado || oo.startsWith(dado) || dado.startsWith(oo) || (oo.length >= 5 && dado.length >= 5 && oo.slice(0, 5) === dado.slice(0, 5)));
      });
      if (candidatas.length === 1) return { ok: true, valor: candidatas[0] };
    }
    return { ok: false, error: `Elige una opción:\n${opciones.map((o, i) => `${i + 1}. ${o}`).join('\n')}` };
  };
}

const SI_NO = ['Sí', 'No'] as const;
export const esSi = (v: unknown): boolean => /^s[ií]$/i.test(String(v ?? '').trim());

/** «Nombre(s) Paterno Materno», con partículas («de los Santos»). */
export function partirNombre(completo: string | null | undefined): { nombres: string; paterno: string; materno: string } {
  const t = String(completo ?? '').trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  if (t.length < 2) return { nombres: t.join(' '), paterno: '', materno: '' };
  if (t.length === 2) return { nombres: t[0], paterno: t[1], materno: '' };
  const particulas = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'san', 'santa', 'mc', 'da', 'di']);
  let iMaterno = t.length - 1;
  while (iMaterno > 1 && particulas.has(t[iMaterno - 1].toLowerCase())) iMaterno--;
  let iPaterno = iMaterno - 1;
  while (iPaterno > 1 && particulas.has(t[iPaterno - 1].toLowerCase())) iPaterno--;
  return { nombres: t.slice(0, iPaterno).join(' '), paterno: t.slice(iPaterno, iMaterno).join(' '), materno: t.slice(iMaterno).join(' ') };
}

/** Lo que ya contestó en el registro; los centinelas («No aplica», «Sin correo») no son sugerencia. */
const delRegistro = (campo: keyof DatosRegistro) => (_d: Respuestas, c: CtxSolicitud): string => {
  const s = String(c.registro[campo] ?? '').trim();
  return !s || /^(no aplica|sin correo)$/i.test(s) ? '' : s;
};

export function esNoAplica(v: unknown): boolean {
  return /^(no aplica|no tengo|ninguno|ninguna|desconocido|sin foto|no recuerda)$/i.test(String(v ?? '').trim());
}

// ── El catálogo, en el orden de la hoja (para que RH coteje renglón por renglón) ────────────────────────────────

export const BLOQUES = [
  { id: 'personales', titulo: 'Datos personales' },
  { id: 'documentacion', titulo: 'Documentación' },
  { id: 'salud', titulo: 'Salud y hábitos' },
  { id: 'familiares', titulo: 'Datos familiares' },
  { id: 'escolaridad', titulo: 'Escolaridad' },
  { id: 'conocimientos', titulo: 'Conocimientos' },
  { id: 'empleos', titulo: 'Empleos' },
  { id: 'referencias', titulo: 'Referencias personales' },
  { id: 'generales', titulo: 'Datos generales' },
  { id: 'economicos', titulo: 'Datos económicos' },
  { id: 'cierre', titulo: 'Foto y cierre' },
] as const;

const ORDINAL = ['', 'primer', 'segundo', 'tercer', 'cuarto'];
const casadoOUnion = (d: Respuestas): boolean => /casad|uni[oó]n/i.test(d['estado_civil'] ?? '');

// La hoja trae 4 empleos, 3 referencias y 5 niveles de escuela: antes de cada repetición se pregunta si la hay.
function bloqueEmpleo(n: number): Pregunta[] {
  const pre = `emp${n}_`;
  const orden = n === 1 ? 'tu *empleo actual o el último* que tuviste' : `tu *${ORDINAL[n]} empleo anterior*`;
  const hubo: Pregunta = n === 1
    ? { k: `${pre}hubo`, bloque: 'empleos', etiqueta: '¿Ha trabajado?', opciones: SI_NO, pregunta: '¿Has *trabajado antes*, aunque haya sido temporal o por vacaciones?' }
    : { k: `${pre}hubo`, bloque: 'empleos', etiqueta: `¿Hubo ${ORDINAL[n]} empleo?`, opciones: SI_NO, cuando: (d) => esSi(d[`emp${n - 1}_hubo`]),
      pregunta: '¿Tuviste *otro empleo antes* de ese? (si ya no hay más, contesta *no*)' };
  const activa = (d: Respuestas): boolean => esSi(d[`${pre}hubo`]);
  const q = (k: string, etiqueta: string, pregunta: string, extra: Partial<Pregunta> = {}): Pregunta =>
    ({ k: pre + k, bloque: 'empleos', etiqueta: `${etiqueta} (empleo ${n})`, pregunta, cuando: activa, ...extra });
  return [
    hubo,
    q('compania', 'Compañía', `¿Cómo se llama la *empresa* de ${orden}?`),
    q('domicilio', 'Domicilio', '¿En qué *dirección o ciudad* estaba esa empresa?'),
    q('telefono', 'Teléfono', '¿Cuál es el *teléfono* de esa empresa? (si no lo sabes, escribe *no tengo*)', { sinDato: true, numeroOk: true }),
    q('puesto', 'Puesto', '¿Qué *puesto* tenías ahí?'),
    q('funciones', 'Funciones', '¿*Qué hacías* en ese puesto? Cuéntame tus tareas principales — esto es lo que más pesa en tu CV. 💪'),
    q('logro', 'Logro', '¿Algo que hayas *logrado o mejorado* ahí? (si no se te ocurre, escribe *no aplica*)', { sinDato: true }),
    q('desde', 'Desde', '¿*Cuándo entraste*? (mes y año, ejemplo: *junio 2025*)'),
    q('hasta', 'Hasta', '¿*Hasta cuándo* estuviste? (si sigues ahí, escribe *actualmente*)'),
    q('sueldo', 'Sueldo', '¿Cuánto *ganabas*? (puedes decir semanal o mensual)', { numeroOk: true }),
    q('motivo', 'Motivo de separación', '¿Por qué *ya no trabajas* ahí?'),
    q('jefe_nombre', 'Jefe directo', '¿Cómo se llamaba tu *jefe directo*?', { sinDato: true }),
    q('jefe_puesto', 'Puesto del jefe', '¿Qué *puesto* tenía tu jefe?', { sinDato: true }),
    q('informes', 'Podemos pedir informes', '¿Podemos *pedir informes* de ti en esa empresa?', { opciones: SI_NO }),
  ];
}

function bloqueReferencia(n: number): Pregunta[] {
  const pre = `ref${n}_`;
  const activa = n === 1 ? (d: Respuestas) => esSi(d['ref_intro']) : (d: Respuestas) => esSi(d[`${pre}hubo`]);
  const q = (k: string, etiqueta: string, pregunta: string, extra: Partial<Pregunta> = {}): Pregunta =>
    ({ k: pre + k, bloque: 'referencias', etiqueta: `${etiqueta} (referencia ${n})`, pregunta, cuando: activa, ...extra });
  const lista = [
    q('nombre', 'Nombre', `Dame el *nombre completo* de tu *${ORDINAL[n]} referencia*.`),
    q('domicilio', 'Domicilio', '¿En qué *colonia o ciudad* vive?'),
    q('telefono', 'Teléfono', '¿Cuál es su *teléfono*?', { validar: vTelefono }),
    q('ocupacion', 'Ocupación', '¿A qué se *dedica*?'),
    q('tiempo', 'Tiempo de conocerlo', '¿*Cuánto tiempo* la conoces? (ejemplo: *8 años*)'),
  ];
  if (n === 1) return lista;
  return [
    { k: `${pre}hubo`, bloque: 'referencias', etiqueta: `¿${ORDINAL[n]} referencia?`, opciones: SI_NO,
      cuando: (d) => esSi(d[`ref${n - 1}_hubo`]) || (n === 2 && !!d['ref1_nombre']),
      pregunta: '¿Me puedes dar *otra referencia personal*? (la hoja pide 3; si no tienes más, contesta *no*)' },
    ...lista,
  ];
}

function bloqueEscuela(nivel: string, etiqueta: string, pregunta: string): Pregunta[] {
  const activa = (d: Respuestas): boolean => esSi(d[`esc_${nivel}_hubo`]);
  const q = (k: string, et: string, pr: string, extra: Partial<Pregunta> = {}): Pregunta =>
    ({ k: `esc_${nivel}_${k}`, bloque: 'escolaridad', etiqueta: `${et} (${etiqueta})`, pregunta: pr, cuando: activa, ...extra });
  return [
    { k: `esc_${nivel}_hubo`, bloque: 'escolaridad', etiqueta: `¿Cursó ${etiqueta}?`, opciones: SI_NO, pregunta },
    q('escuela', 'Escuela', `¿Cómo se llama la *escuela* donde cursaste ${etiqueta}?`),
    q('domicilio', 'Domicilio', '¿En qué *ciudad o dirección* está?'),
    q('anios', 'Años', '¿De qué *año a qué año*? (ejemplo: *2013 a 2020*)', { validar: vRangoAnios }),
    q('titulo', 'Título recibido', '¿Qué *documento recibiste*? (certificado, título, constancia… o *ninguno* si está en trámite)', { sinDato: true }),
  ];
}

export const K_CONSENTIMIENTO = 'consentimiento_sensibles';

export const PREGUNTAS: readonly Pregunta[] = [
  // ── DATOS PERSONALES ──
  { k: 'puesto_solicitado', bloque: 'personales', etiqueta: 'Puesto solicitado', pregunta: '¿Qué *puesto* estás solicitando?', sugerir: delRegistro('position_interest') },
  { k: 'sueldo_deseado', bloque: 'personales', etiqueta: 'Sueldo mensual deseado', pregunta: '¿Cuánto te gustaría *ganar al mes*?', numeroOk: true, sugerir: delRegistro('desired_salary') },
  { k: 'apellido_paterno', bloque: 'personales', etiqueta: 'Apellido paterno', pregunta: '¿Cuál es tu *apellido paterno*?', sugerir: (_d, c) => partirNombre(c.registro.full_name).paterno },
  { k: 'apellido_materno', bloque: 'personales', etiqueta: 'Apellido materno', pregunta: '¿Cuál es tu *apellido materno*?', sinDato: true, sugerir: (_d, c) => partirNombre(c.registro.full_name).materno },
  { k: 'nombres', bloque: 'personales', etiqueta: 'Nombre(s)', pregunta: '¿Cuál es tu *nombre (o nombres)*?', sugerir: (_d, c) => partirNombre(c.registro.full_name).nombres },
  { k: 'email', bloque: 'personales', etiqueta: 'E-mail', pregunta: '¿Cuál es tu *correo electrónico*?', sinDato: true, validar: vCorreo, sugerir: delRegistro('email') },
  { k: 'domicilio', bloque: 'personales', etiqueta: 'Domicilio', pregunta: '¿Cuál es tu *domicilio*? (calle y número)' },
  { k: 'colonia', bloque: 'personales', etiqueta: 'Colonia', pregunta: '¿En qué *colonia* vives?' },
  { k: 'codigo_postal', bloque: 'personales', etiqueta: 'Código postal', pregunta: '¿Cuál es tu *código postal*?', validar: vCP, sinDato: true, numeroOk: true },
  { k: 'telefono_casa', bloque: 'personales', etiqueta: 'Teléfono', pregunta: '¿A qué *teléfono* te podemos localizar?', validar: vTelefono, sugerir: (_d, c) => c.telefono },
  { k: 'sexo', bloque: 'personales', etiqueta: 'Sexo', opciones: ['Masculino', 'Femenino'], pregunta: '¿Sexo?\n1. Masculino\n2. Femenino' },
  { k: 'lugar_nacimiento', bloque: 'personales', etiqueta: 'Lugar de nacimiento', pregunta: '¿*Dónde naciste*? (ciudad y estado)' },
  { k: 'fecha_nacimiento', bloque: 'personales', etiqueta: 'Fecha de nacimiento', pregunta: '¿Cuál es tu *fecha de nacimiento*? (día/mes/año)', validar: vFecha },
  // La edad se calcula de la fecha y se pide confirmar (preguntarla suelta es como se cuelan las edades que no cuadran).
  { k: 'edad', bloque: 'personales', etiqueta: 'Edad', pregunta: '¿Tu *edad* es correcta?',
    sugerir: (d, c) => { const e = edadDesde(d['fecha_nacimiento'], c.hoy); return e === null ? '' : `${e} años`; } },
  { k: 'nacionalidad', bloque: 'personales', etiqueta: 'Nacionalidad', pregunta: '¿Cuál es tu *nacionalidad*?', sugerir: () => 'Mexicana' },
  // El consentimiento expreso para lo sensible: sólo existe si hay texto VIGENTE.
  { k: K_CONSENTIMIENTO, bloque: 'personales', etiqueta: 'Consentimiento para datos sensibles', opciones: SI_NO,
    cuando: (_d, c) => !!c.consentimiento,
    pregunta: (c) => `${c.consentimiento?.texto ?? ''}\n\n¿*Das tu consentimiento*? Contesta *sí* o *no*. Si dices que no, no te pregunto esa parte y tu solicitud sigue igual.` },
  { k: 'estatura', bloque: 'personales', etiqueta: 'Estatura', pregunta: '¿Cuál es tu *estatura* en metros? (ejemplo: 1.65)', validar: vEstatura, sensible: true },
  { k: 'peso', bloque: 'personales', etiqueta: 'Peso', pregunta: '¿Cuál es tu *peso* en kilos? (ejemplo: 65)', validar: vPeso, sensible: true },
  { k: 'vive_con', bloque: 'personales', etiqueta: 'Vive con', opciones: ['Sus padres', 'Su familia', 'Parientes', 'Solo'], sensible: true,
    pregunta: '¿Con quién *vives*?\n1. Mis padres\n2. Mi familia (esposo/a e hijos)\n3. Parientes\n4. Solo(a)' },
  { k: 'dependientes', bloque: 'personales', etiqueta: 'Personas que dependen de usted', sinDato: true, sensible: true,
    pregunta: '¿*Quién depende económicamente de ti*? (hijos, esposo/a, papás, otros… o *nadie*)' },
  { k: 'estado_civil', bloque: 'personales', etiqueta: 'Estado civil', opciones: ['Soltero(a)', 'Casado(a)', 'Unión libre', 'Divorciado(a)', 'Viudo(a)'], sensible: true,
    pregunta: '¿Cuál es tu *estado civil*?\n1. Soltero(a)\n2. Casado(a)\n3. Unión libre\n4. Divorciado(a)\n5. Viudo(a)' },

  // ── DOCUMENTACIÓN ──
  { k: 'rfc', bloque: 'documentacion', etiqueta: 'RFC', pregunta: '¿Cuál es tu *RFC*?', validar: vRFC, sinDato: true, deFoto: 'rfc', sugerir: delRegistro('rfc') },
  { k: 'nss', bloque: 'documentacion', etiqueta: 'NSS (IMSS)', pregunta: '¿Cuál es tu *número de seguro social (NSS)*?', validar: vNSS, sinDato: true, deFoto: 'nss', sugerir: delRegistro('nss') },
  { k: 'curp', bloque: 'documentacion', etiqueta: 'CURP', pregunta: '¿Cuál es tu *CURP*? (18 caracteres, viene en tu INE)', validar: vCURP, sinDato: true, deFoto: 'curp' },
  { k: 'credencial_elector', bloque: 'documentacion', etiqueta: 'Credencial de elector',
    pregunta: '¿Cuál es el *número de tu credencial de elector (INE)*? (los 13 dígitos del frente)', validar: vINE, sinDato: true, deFoto: 'credencial_elector' },
  { k: 'cartilla_militar', bloque: 'documentacion', etiqueta: 'Cartilla del servicio militar',
    pregunta: '¿Tienes *cartilla del servicio militar*? Si sí, dime su número.', sinDato: true, numeroOk: true, deFoto: 'cartilla_militar' },
  { k: 'pasaporte', bloque: 'documentacion', etiqueta: 'Pasaporte', pregunta: '¿Tienes *pasaporte*? Si sí, dime su número.', sinDato: true, numeroOk: true },
  { k: 'afore', bloque: 'documentacion', etiqueta: 'AFORE', pregunta: '¿En qué *AFORE* estás? (si no sabes, escribe *no sé*)', sinDato: true },
  { k: 'licencia', bloque: 'documentacion', etiqueta: '¿Tiene licencia de manejo?', opciones: SI_NO, pregunta: '¿Tienes *licencia de manejo*?' },
  { k: 'licencia_datos', bloque: 'documentacion', etiqueta: 'Clase y número de licencia', pregunta: '¿De qué *clase* es tu licencia y cuál es su *número*?',
    cuando: (d) => esSi(d['licencia']), sinDato: true, deFoto: 'licencia_datos' },
  { k: 'documento_extranjero', bloque: 'documentacion', etiqueta: 'Documento que le permite trabajar en el país',
    pregunta: 'Como no eres mexicano(a): ¿qué *documento* te permite trabajar en México?', cuando: (d) => !!d['nacionalidad'] && !/mexic/i.test(d['nacionalidad']) },

  // ── SALUD Y HÁBITOS ──
  { k: 'salud', bloque: 'salud', etiqueta: 'Estado de salud', opciones: ['Bueno', 'Regular', 'Malo'], sensible: true,
    pregunta: '¿Cómo consideras tu *estado de salud* actual?\n1. Bueno\n2. Regular\n3. Malo' },
  { k: 'enfermedad_cronica', bloque: 'salud', etiqueta: 'Enfermedad crónica', pregunta: '¿Padeces alguna *enfermedad crónica*? (si no, escribe *no*)', sinDato: true, sensible: true },
  { k: 'embarazo', bloque: 'salud', etiqueta: 'Embarazo', opciones: SI_NO, pregunta: '¿Estás embarazada?', sensible: true,
    cuando: (d, c) => c.preguntarEmbarazo === true && /femen/i.test(d['sexo'] ?? '') },
  { k: 'deporte', bloque: 'salud', etiqueta: 'Deporte', pregunta: '¿Practicas algún *deporte*? ¿Cuál?', sinDato: true },
  { k: 'club', bloque: 'salud', etiqueta: 'Club social o deportivo', pregunta: '¿Perteneces a algún *club social o deportivo*? ¿Cuál?', sinDato: true },
  { k: 'pasatiempo', bloque: 'salud', etiqueta: 'Pasatiempo favorito', pregunta: '¿Cuál es tu *pasatiempo favorito*?' },
  { k: 'meta_vida', bloque: 'salud', etiqueta: 'Meta en la vida', pregunta: '¿Cuál es tu *meta en la vida*? 🎯 (esto va en tu CV, tómate tu tiempo)' },

  // ── DATOS FAMILIARES (todos sensibles: situación familiar) ──
  { k: 'padre_nombre', bloque: 'familiares', etiqueta: 'Nombre del padre', pregunta: '¿Cómo se llama tu *papá*? (si no lo conoces, escribe *no aplica*)', sinDato: true, sensible: true },
  { k: 'padre_vive', bloque: 'familiares', etiqueta: 'Padre vive/finado', opciones: ['Vive', 'Finado'], sensible: true,
    pregunta: 'Tu papá, ¿*vive* o ya *falleció*?\n1. Vive\n2. Finado', cuando: (d) => !!d['padre_nombre'] && !esNoAplica(d['padre_nombre']) },
  { k: 'padre_domicilio', bloque: 'familiares', etiqueta: 'Domicilio del padre', pregunta: '¿Dónde *vive* tu papá? (si no sabes, escribe *desconocido*)', sinDato: true, sensible: true,
    cuando: (d) => /vive/i.test(d['padre_vive'] ?? '') },
  { k: 'padre_ocupacion', bloque: 'familiares', etiqueta: 'Ocupación del padre', pregunta: '¿A qué se *dedica* tu papá?', sinDato: true, sensible: true,
    cuando: (d) => /vive/i.test(d['padre_vive'] ?? '') },
  { k: 'madre_nombre', bloque: 'familiares', etiqueta: 'Nombre de la madre', pregunta: '¿Cómo se llama tu *mamá*?', sinDato: true, sensible: true },
  { k: 'madre_vive', bloque: 'familiares', etiqueta: 'Madre vive/finada', opciones: ['Vive', 'Finada'], sensible: true,
    pregunta: 'Tu mamá, ¿*vive* o ya *falleció*?\n1. Vive\n2. Finada', cuando: (d) => !!d['madre_nombre'] && !esNoAplica(d['madre_nombre']) },
  { k: 'madre_domicilio', bloque: 'familiares', etiqueta: 'Domicilio de la madre', pregunta: '¿Dónde *vive* tu mamá?', sinDato: true, sensible: true,
    cuando: (d) => /vive/i.test(d['madre_vive'] ?? '') },
  { k: 'madre_ocupacion', bloque: 'familiares', etiqueta: 'Ocupación de la madre', pregunta: '¿A qué se *dedica* tu mamá?', sinDato: true, sensible: true,
    cuando: (d) => /vive/i.test(d['madre_vive'] ?? '') },
  { k: 'conyuge_nombre', bloque: 'familiares', etiqueta: 'Nombre del cónyuge', pregunta: '¿Cómo se llama tu *esposo(a) o pareja*?', sinDato: true, sensible: true, cuando: casadoOUnion },
  { k: 'conyuge_domicilio', bloque: 'familiares', etiqueta: 'Domicilio del cónyuge', pregunta: '¿*Viven juntos* en el mismo domicilio? Si no, dime dónde vive.', sinDato: true, sensible: true,
    cuando: (d) => casadoOUnion(d) && !!d['conyuge_nombre'] },
  { k: 'conyuge_ocupacion', bloque: 'familiares', etiqueta: 'Ocupación del cónyuge', pregunta: '¿A qué se *dedica* tu esposo(a)?', sinDato: true, sensible: true,
    cuando: (d) => casadoOUnion(d) && !!d['conyuge_nombre'] },
  { k: 'hijos', bloque: 'familiares', etiqueta: 'Nombre y edades de los hijos', pregunta: '¿Tienes *hijos*? Dime sus *nombres y edades* (o escribe *ninguno*)', sinDato: true, sensible: true },

  // ── ESCOLARIDAD ──
  ...bloqueEscuela('primaria', 'primaria', '¿Cursaste la *primaria*?'),
  ...bloqueEscuela('secundaria', 'secundaria', '¿Cursaste la *secundaria*?'),
  ...bloqueEscuela('prepa', 'preparatoria o vocacional', '¿Cursaste *preparatoria o vocacional*?'),
  ...bloqueEscuela('profesional', 'profesional', '¿Estudiaste una *carrera profesional* (universidad)?'),
  ...bloqueEscuela('comercial', 'comercial u otros', '¿Estudiaste algo *comercial u otro curso* (computación, inglés, oficio…)?'),
  { k: 'estudia_ahora', bloque: 'escolaridad', etiqueta: '¿Estudia actualmente?', opciones: SI_NO, pregunta: '¿Estás *estudiando ahora*?' },
  { k: 'estudia_escuela', bloque: 'escolaridad', etiqueta: 'Escuela actual', pregunta: '¿En qué *escuela* estudias?', cuando: (d) => esSi(d['estudia_ahora']) },
  { k: 'estudia_curso', bloque: 'escolaridad', etiqueta: 'Curso o carrera', pregunta: '¿Qué *curso o carrera* llevas?', cuando: (d) => esSi(d['estudia_ahora']) },
  { k: 'estudia_grado', bloque: 'escolaridad', etiqueta: 'Grado', pregunta: '¿En qué *grado o semestre* vas?', numeroOk: true, cuando: (d) => esSi(d['estudia_ahora']) },
  { k: 'estudia_horario', bloque: 'escolaridad', etiqueta: 'Horario de estudio', pregunta: '¿En qué *horario* son tus clases? (importante para acomodar tu turno)',
    cuando: (d) => esSi(d['estudia_ahora']) },

  // ── CONOCIMIENTOS ──
  { k: 'idiomas', bloque: 'conocimientos', etiqueta: 'Idiomas que domina', pregunta: '¿Qué *idiomas* hablas? (si solo español, escríbelo así)' },
  { k: 'idiomas_nivel', bloque: 'conocimientos', etiqueta: 'Nivel de idiomas', pregunta: '¿Qué *nivel* tienes en cada uno? (básico, intermedio, avanzado o nativo)',
    validar: vNivelIdioma, sugerir: (d) => (/^\s*(espa[nñ]ol|solo espa[nñ]ol)\s*$/i.test(d['idiomas'] ?? '') ? 'Español: nativo' : '') },
  { k: 'funciones_oficina', bloque: 'conocimientos', etiqueta: 'Funciones de oficina que domina',
    pregunta: '¿Qué *programas de computadora* manejas? (Word, Excel, punto de venta, correo… o *ninguno*)', sinDato: true },
  { k: 'maquinas', bloque: 'conocimientos', etiqueta: 'Máquinas o equipo que sabe manejar',
    pregunta: '¿Qué *máquinas o equipo* sabes manejar? (caja registradora, patín, montacargas, herramienta…)', sinDato: true },
  { k: 'otros_conocimientos', bloque: 'conocimientos', etiqueta: 'Otros trabajos y funciones que domina', pregunta: '¿Qué *otras cosas sabes hacer* que sirvan en el trabajo?', sinDato: true },

  // ── EMPLEOS (hasta 4, como la hoja) ──
  ...bloqueEmpleo(1), ...bloqueEmpleo(2), ...bloqueEmpleo(3), ...bloqueEmpleo(4),

  // ── REFERENCIAS (3, como la hoja) ──
  { k: 'ref_intro', bloque: 'referencias', etiqueta: 'Acepta dar referencias', opciones: SI_NO,
    pregunta: 'Ahora las *referencias personales*: 3 personas que te conozcan y que *no sean* tus parientes ni tus jefes anteriores. ¿Las tienes a la mano?' },
  ...bloqueReferencia(1), ...bloqueReferencia(2), ...bloqueReferencia(3),

  // ── DATOS GENERALES ──
  { k: 'como_supo', bloque: 'generales', etiqueta: '¿Cómo supo de este empleo?', pregunta: '¿*Cómo te enteraste* de esta vacante? (Facebook, un conocido, anuncio, pasé por la tienda…)' },
  { k: 'parientes_empresa', bloque: 'generales', etiqueta: 'Parientes en la empresa',
    pregunta: '¿Tienes *parientes trabajando* en Mega Dulces? Si sí, dime quién y qué parentesco.', sinDato: true, sugerir: delRegistro('relative_in_company') },
  { k: 'afianzado', bloque: 'generales', etiqueta: '¿Ha estado afianzado?',
    pregunta: '¿Alguna vez has estado *afianzado* (fianza de fidelidad en un trabajo)? Si sí, dime con qué compañía.', sinDato: true },
  { k: 'sindicato', bloque: 'generales', etiqueta: 'Sindicato', pregunta: '¿Has estado *afiliado a un sindicato*? Si sí, ¿a cuál?', sinDato: true, sensible: true },
  { k: 'seguro_vida', bloque: 'generales', etiqueta: 'Seguro de vida', pregunta: '¿Tienes *seguro de vida*? Si sí, dime la compañía y la suma asegurada.', sinDato: true, sensible: true },
  { k: 'puede_viajar', bloque: 'generales', etiqueta: '¿Puede viajar?', pregunta: '¿*Puedes viajar* si el puesto lo pide? (si no, dime por qué)' },
  { k: 'cambiar_residencia', bloque: 'generales', etiqueta: '¿Cambiaría de residencia?', pregunta: '¿Estarías dispuesto(a) a *cambiar de ciudad*? (si no, dime por qué)' },
  { k: 'fecha_presentarse', bloque: 'generales', etiqueta: 'Fecha en que podría presentarse', pregunta: '¿*Cuándo podrías empezar* a trabajar?' },

  // ── DATOS ECONÓMICOS (todos sensibles: situación económica) ──
  { k: 'otros_ingresos', bloque: 'economicos', etiqueta: 'Otros ingresos', pregunta: '¿Tienes *otros ingresos* además del trabajo? (si sí, dime de qué y cuánto al mes)',
    sinDato: true, numeroOk: true, sensible: true },
  { k: 'conyuge_trabaja', bloque: 'economicos', etiqueta: 'Cónyuge trabaja', pregunta: '¿Tu *esposo(a) trabaja*? Si sí, dime dónde y cuánto gana al mes.', sinDato: true,
    sensible: true, cuando: casadoOUnion },
  { k: 'casa_propia', bloque: 'economicos', etiqueta: 'Casa propia', pregunta: '¿Vives en *casa propia*? (si sí, dime su valor aproximado)', sinDato: true, numeroOk: true, sensible: true },
  { k: 'renta', bloque: 'economicos', etiqueta: 'Renta', pregunta: '¿*Pagas renta*? Si sí, ¿cuánto al mes?', sinDato: true, numeroOk: true, sensible: true },
  { k: 'automovil', bloque: 'economicos', etiqueta: 'Automóvil', pregunta: '¿Tienes *automóvil*? Si sí, dime marca y modelo.', sinDato: true, sensible: true },
  { k: 'deudas', bloque: 'economicos', etiqueta: 'Deudas', pregunta: '¿Tienes *deudas*? Si sí, con quién, cuánto y cuánto abonas al mes.', sinDato: true, numeroOk: true, sensible: true },
  { k: 'gastos_mensuales', bloque: 'economicos', etiqueta: 'Gastos mensuales', pregunta: '¿A cuánto llegan tus *gastos al mes*, más o menos?', sinDato: true, numeroOk: true, sensible: true },

  // ── CIERRE (la foto al final: pedirla antes hace que la gente abandone) ──
  { k: 'foto', bloque: 'cierre', etiqueta: 'Fotografía', tipo: 'foto', sinDato: true,
    pregunta: '¡Ya casi! 🎉 Mándame una *foto tuya* tipo credencial (de frente, cara despejada). Va en tu CV.\n\n_Si prefieres no poner foto, escribe *sin foto* y la dejo fuera._' },
  { k: 'veraz', bloque: 'cierre', etiqueta: 'Hago constar que mis respuestas son verdaderas', opciones: SI_NO,
    pregunta: 'Última: ¿*haces constar* que todo lo que me dijiste es *verdad*? (es la firma de la solicitud; con esto la doy por firmada)' },
];

// ── La máquina (pura) ────────────────────────────────────────────────────────────────────

const consentido = (d: Respuestas, c: CtxSolicitud): boolean => !!c.consentimiento && esSi(d[K_CONSENTIMIENTO]);

/** Las preguntas que APLICAN para estas respuestas (una respuesta abre o cierra bloques enteros). */
export function aplicables(d: Respuestas, c: CtxSolicitud): Pregunta[] {
  return PREGUNTAS.filter((q) => (!q.sensible || consentido(d, c)) && (!q.cuando || q.cuando(d, c)));
}

/** La siguiente sin contestar, o null si ya terminó. */
export function siguiente(d: Respuestas, c: CtxSolicitud): Pregunta | null {
  return aplicables(d, c).find((q) => d[q.k] === undefined) ?? null;
}

/**
 * Sin consentimiento (dijo que no, se retractó con «atrás», o el texto dejó de estar vigente), lo sensible que ya
 * hubiera contestado se BORRA: no se conserva un dato sensible sin su consentimiento.
 */
export function purgarSensibles(d: Respuestas, c: CtxSolicitud): Respuestas {
  if (consentido(d, c)) return d;
  const fuera = new Set(PREGUNTAS.filter((q) => q.sensible).map((q) => q.k));
  return Object.fromEntries(Object.entries(d).filter(([k]) => !fuera.has(k)));
}

/**
 * El avance: el TOTAL no es fijo (cada «sí, tuve otro empleo» suma 14 preguntas), así que no se promete un total —en
 * Mega Talento se vio subir de 66 a 170 en un recorrido—. Se muestran los BLOQUES (fijos) y cuántas lleva (sólo sube).
 */
export function progreso(d: Respuestas, c: CtxSolicitud): { hechas: number; total: number; bloque: number; bloquesTotal: number; pct: number } {
  const apl = aplicables(d, c);
  const contestado = (q: Pregunta): boolean => d[q.k] !== undefined;
  const terminado = (id: string): boolean => apl.filter((q) => q.bloque === id).every(contestado);
  const terminados = BLOQUES.filter((b) => terminado(b.id)).length;
  const iActual = BLOQUES.findIndex((b) => !terminado(b.id));
  const enCurso = iActual === -1 ? 0 : apl.filter((q) => q.bloque === BLOQUES[iActual].id && contestado(q)).length;
  const dentro = iActual === -1 ? 0 : enCurso / (enCurso + 6);
  return {
    hechas: apl.filter(contestado).length, total: apl.length,
    bloque: iActual === -1 ? BLOQUES.length : iActual + 1, bloquesTotal: BLOQUES.length,
    pct: Math.min(100, Math.round(((terminados + dentro) / BLOQUES.length) * 100)),
  };
}

export function barra(pct: number): string {
  const n = Math.round((Math.max(0, Math.min(100, pct)) / 100) * 10);
  return '▓'.repeat(n) + '░'.repeat(10 - n);
}

const textoDe = (q: Pregunta, c: CtxSolicitud): string => (typeof q.pregunta === 'function' ? q.pregunta(c) : q.pregunta);

/** La pregunta como se le manda: el bloque cuando cambia, la pregunta, la sugerencia y el avance. */
export function textoPregunta(q: Pregunta, d: Respuestas, c: CtxSolicitud, opciones: { conAvance?: boolean } = {}): string {
  const apl = aplicables(d, c);
  const idx = apl.findIndex((x) => x.k === q.k);
  const anterior = idx > 0 ? apl[idx - 1] : null;
  const partes: string[] = [];
  if (!anterior || anterior.bloque !== q.bloque) {
    const n = BLOQUES.findIndex((x) => x.id === q.bloque);
    if (n !== -1) partes.push(`━━━━━━━━━━━━━━━\n📋 *${BLOQUES[n].titulo.toUpperCase()}*  (bloque ${n + 1} de ${BLOQUES.length})\n━━━━━━━━━━━━━━━`);
  }
  partes.push(textoDe(q, c));
  const sug = q.sugerir ? q.sugerir(d, c).trim() : '';
  if (sug) partes.push(`_Tengo esto:_ *${sug}*\n_Si está bien contesta *sí*; si no, escríbelo correcto._`);
  else if (q.sinDato) partes.push('_(Si no lo tienes o no aplica, escribe *no tengo*.)_');
  if (opciones.conAvance !== false) {
    const p = progreso(d, c);
    partes.push(`_${barra(p.pct)} bloque ${p.bloque}/${p.bloquesTotal} · ${p.hechas === 1 ? '1 respuesta' : `${p.hechas} respuestas`}_`);
  }
  return partes.join('\n\n');
}

export type Respuesta = { comando: 'pausa' | 'atras' } | { error: string } | { valor: string } | { esperaFoto: true };

/** Interpreta la respuesta a una pregunta. */
export function responder(q: Pregunta, textoCrudo: string | null, d: Respuestas, c: CtxSolicitud): Respuesta {
  const texto = String(textoCrudo ?? '').trim();
  if (CMD_PAUSA.test(texto)) return { comando: 'pausa' };
  if (CMD_ATRAS.test(texto)) return { comando: 'atras' };
  if (q.tipo === 'foto') return /^(sin foto|no quiero|no tengo|sin|paso|omitir|no)\.?$/i.test(texto) ? { valor: 'Sin foto' } : { esperaFoto: true };
  if (texto === '') return { error: 'Necesito que me contestes con *texto* 🙂' };
  const sug = q.sugerir ? q.sugerir(d, c).trim() : '';
  if (sug && CONFIRMA.test(texto)) return { valor: sug };
  // Creíamos tener el dato y no lo tenemos: un «sí» pelón NO es la respuesta (guardaría «sí» como su apellido).
  if (!sug && q.sugerir && !q.opciones && CONFIRMA.test(texto)) return { error: 'Ese dato no lo tengo todavía, así que escríbemelo completo, por favor 🙂' };
  if (q.sinDato && SIN_DATO.test(texto) && !q.opciones) return { valor: NO_APLICA };
  if (!q.opciones && NO_RECUERDO.test(texto)) return { valor: SIN_MEMORIA };
  if (q.opciones) {
    const r = vOpciones(q.opciones)(texto);
    return r.ok ? { valor: r.valor } : { error: r.error };
  }
  if (q.validar) {
    const r = q.validar(texto, c);
    if (r.ok) return { valor: r.valor };
    if (q.sinDato && SIN_DATO.test(texto)) return { valor: NO_APLICA };
    return { error: r.error };
  }
  if (!q.numeroOk && esSoloNumero(texto)) return { error: `Eso se ve como un número, y aquí necesito otra cosa 🙂\n\n${textoDe(q, c)}` };
  const v = vTexto(texto);
  return v.ok ? { valor: v.valor } : { error: v.error };
}

/** Quita la última respuesta dada («atrás»); devuelve la clave borrada. */
export function atras(d: Respuestas, c: CtxSolicitud): { respuestas: Respuestas; borrada: string | null } {
  const dadas = aplicables(d, c).filter((q) => d[q.k] !== undefined);
  if (!dadas.length) return { respuestas: d, borrada: null };
  const ultima = dadas[dadas.length - 1].k;
  const resto = { ...d };
  delete resto[ultima];
  return { respuestas: resto, borrada: ultima };
}

export function etiqueta(k: string): string {
  return PREGUNTAS.find((x) => x.k === k)?.etiqueta ?? k;
}

/** La solicitud agrupada por bloque (para RH y para el PDF). */
export function porBloques(d: Respuestas, c: CtxSolicitud): Array<{ id: string; titulo: string; datos: Array<{ k: string; etiqueta: string; valor: string }> }> {
  const apl = aplicables(d, c);
  return BLOQUES.map((b) => ({
    id: b.id, titulo: b.titulo,
    datos: apl.filter((q) => q.bloque === b.id && d[q.k] !== undefined).map((q) => ({ k: q.k, etiqueta: q.etiqueta, valor: d[q.k] })),
  })).filter((b) => b.datos.length);
}

// ── Lo que necesita el CV ────────────────────────────────────────────────────────────────

export interface EmpleoCv { compania: string; puesto: string; desde: string; hasta: string; funciones: string; logro: string }
export function empleos(d: Respuestas): EmpleoCv[] {
  const out: EmpleoCv[] = [];
  for (let n = 1; n <= 4; n++) {
    const p = `emp${n}_`;
    if (!esSi(d[`${p}hubo`]) || !d[`${p}compania`]) continue;
    out.push({
      compania: d[`${p}compania`], puesto: d[`${p}puesto`] ?? '', desde: d[`${p}desde`] ?? '', hasta: d[`${p}hasta`] ?? '',
      funciones: d[`${p}funciones`] ?? '', logro: esNoAplica(d[`${p}logro`]) ? '' : (d[`${p}logro`] ?? ''),
    });
  }
  return out;
}

const NIVELES: ReadonlyArray<[string, string]> = [
  ['profesional', 'Profesional'], ['prepa', 'Preparatoria o vocacional'], ['comercial', 'Comercial u otros'], ['secundaria', 'Secundaria'], ['primaria', 'Primaria'],
];
export interface EscuelaCv { nivel: string; escuela: string; anios: string; titulo: string }
export function escolaridad(d: Respuestas): EscuelaCv[] {
  return NIVELES.filter(([n]) => esSi(d[`esc_${n}_hubo`]) && d[`esc_${n}_escuela`] && !esNoAplica(d[`esc_${n}_escuela`]))
    .map(([n, titulo]) => ({ nivel: titulo, escuela: d[`esc_${n}_escuela`], anios: d[`esc_${n}_anios`] ?? '', titulo: esNoAplica(d[`esc_${n}_titulo`]) ? '' : (d[`esc_${n}_titulo`] ?? '') }));
}

export interface ReferenciaCv { nombre: string; telefono: string; ocupacion: string; tiempo: string }
export function referencias(d: Respuestas): ReferenciaCv[] {
  const out: ReferenciaCv[] = [];
  for (let n = 1; n <= 3; n++) {
    const p = `ref${n}_`;
    if (d[`${p}nombre`]) out.push({ nombre: d[`${p}nombre`], telefono: d[`${p}telefono`] ?? '', ocupacion: d[`${p}ocupacion`] ?? '', tiempo: d[`${p}tiempo`] ?? '' });
  }
  return out;
}

const NIVEL_PCT: Record<string, number> = { basico: 35, intermedio: 60, avanzado: 85, nativo: 100 };
/** Idiomas con su nivel, buscado DENTRO del pedazo que habla de ese idioma; lo que no diga nivel queda sin barra. */
export function idiomas(d: Respuestas): Array<{ nombre: string; nivel: string; pct: number }> {
  const limpio = (x: unknown): string => sinAcentos(String(x ?? '').toLowerCase());
  const nombres = String(d['idiomas'] ?? '').split(/[,;/]|\by\b|\se\s/i)
    .map((x) => x.replace(/\b(solo|nada mas|nadamas|idioma|idiomas|hablo)\b/gi, '').trim()).filter((x) => x.length > 2);
  const trozos = limpio(d['idiomas_nivel']).split(/[,;\n]|\by\b/);
  const nivelesEn = (t: string): string[] => Object.keys(NIVEL_PCT).filter((n) => t.includes(n));
  const todos = nivelesEn(limpio(d['idiomas_nivel']));
  return nombres.map((nombre) => {
    const suyo = trozos.find((t) => t.includes(limpio(nombre)));
    let nivel = suyo ? nivelesEn(suyo)[0] : undefined;
    if (!nivel && nombres.length === 1 && todos.length === 1) nivel = todos[0];
    const may = (s: string): string => s.replace(/^\w/, (x) => x.toUpperCase());
    return { nombre: may(nombre), nivel: nivel ? may(nivel) : '', pct: nivel ? NIVEL_PCT[nivel] : 0 };
  });
}

/** Lo que declaró saber, partido en viñetas (máx. 8). */
export function habilidades(d: Respuestas): string[] {
  const items: string[] = [];
  for (const f of [d['funciones_oficina'], d['maquinas'], d['otros_conocimientos']]) {
    if (!f || esNoAplica(f)) continue;
    for (const parte of String(f).split(/[,;\n]|\by\b/i)) {
      const v = parte.trim().replace(/^[-•*\s]+/, '');
      if (v.length >= 3 && items.length < 8) items.push(v.replace(/^\w/, (x) => x.toUpperCase()));
    }
  }
  return items;
}

export function nombreCompleto(d: Respuestas): string {
  return [d['nombres'], d['apellido_paterno'], d['apellido_materno']].filter((s) => s && !esNoAplica(s)).join(' ').replace(/\s+/g, ' ').trim();
}
