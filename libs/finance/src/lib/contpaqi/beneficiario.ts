/**
 * `[CP.8.80]` — **La regla que recuerda a un beneficiario.** Una persona categoriza «Oscar Hernandez» una vez y
 * todos sus pagos —los que ya están y los que vengan en el próximo estado de cuenta— caen en esa categoría.
 *
 * ⭐ El motor de bancos (`classifyWith`) ya sabe aplicar reglas; lo que faltaba era alguien que las escribiera
 * sin saber de regex. Esto traduce «lo que dice el banco» a una regla del mismo motor, sin motor nuevo.
 *
 * ── Por qué «empieza con», y no el texto exacto ─────────────────────────────────────────────
 * Medido en prod (2026-10-22): el mismo beneficiario llega como «Oscar Hernandez», «Oscar Hernandez R» y
 * «Oscar Hernandez Rodriguez» (y una vez «Oscar Hernnandez Rodriguez»). El texto exacto agarraría uno de
 * cuatro. «Empieza con OSCAR HERNANDEZ» agarra tres y deja el del error de dedo para categorizarlo aparte:
 * la vista previa lo muestra ANTES de guardar, así que quien decide ve qué captura.
 *
 * ⛔ Palabra completa: «OSCAR HERNANDEZ R» no captura «OSCAR HERNANDEZ RODRIGUEZ». Un prefijo a media palabra
 * es como se cuela un beneficiario ajeno.
 *
 * ⚠️ Las reglas del motor no tienen dirección (depósito/retiro). Medido: 13 de 488 conceptos de egreso sin
 * categoría aparecen también como depósito. Por eso la regla se ata además al TIPO del movimiento (`G`, `C`…)
 * cuando el banco lo trae: los depósitos de esos 13 llegan con otro tipo (`I`, `DS`).
 */

/** Igual que `normKey` del motor de bancos: espacios colapsados, sin orillas, mayúsculas. */
export function claveMotor(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
}

/** Lo que la regla deja pasar después del texto: cualquier cosa que no siga la palabra. */
const FIN_DE_PALABRA = '(?![A-Z0-9ÁÉÍÓÚÜÑ])';
/** El motor compara contra el texto CON acentos (`normKey` no los quita): cada letra que los lleva acepta los dos. */
const CON_ACENTO: Record<string, string> = { A: '[AÁ]', E: '[EÉ]', I: '[IÍ]', O: '[OÓ]', U: '[UÚÜ]', N: '[NÑ]' };

/** El texto como lo comparo: sin acentos, mayúsculas, espacios colapsados. */
export function textoBeneficiario(s: unknown): string {
  return claveMotor(String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, ''));
}

/**
 * La regex «empieza con este texto, en palabra completa», sin distinguir acentos. Todo lo que no es letra ni
 * dígito se escapa: un «.» o un «*» del banco no puede volverse comodín.
 */
export function patronDe(texto: string): string {
  const cuerpo = [...texto].map((ch) => {
    if (CON_ACENTO[ch]) return CON_ACENTO[ch];
    if (/[A-Z0-9 ]/.test(ch)) return ch;
    if (/[\x21-\x7e]/.test(ch)) return '\\' + ch;   // puntuación ASCII: literal
    return '.';                                     // cualquier otro símbolo: un carácter, sin adivinar cuál
  }).join('');
  return `^${cuerpo}${FIN_DE_PALABRA}`;
}

export interface MovimientoParaRegla {
  raw_type: string | null;
  raw_code: string | null;
  concept: string | null;
}

export interface ReglaBeneficiario {
  match_type: string | null;
  match_code: string | null;
  match_concept: string | null;
  /** El texto tal como lo guarda la nota y lo ve la persona. */
  texto: string;
}

/** Menos de esto no es un nombre: «SA», «PAGO», «613» capturarían medio banco. */
const MINIMO_LETRAS = 5;

/**
 * La regla para el texto que eligió la persona, a partir del movimiento que está categorizando.
 *
 * ⛔ Se niega (devuelve el motivo) si el texto es muy corto, si sólo son números, o si **el propio movimiento no
 * coincide**: una regla que no captura el movimiento con que se creó es un error de quien la escribió.
 */
export function reglaBeneficiario(m: MovimientoParaRegla, texto: unknown): ReglaBeneficiario | { error: string } {
  const t = textoBeneficiario(texto);
  const letras = t.replace(/[^A-ZÑ]/g, '').length;
  if (t.replace(/[^A-Z0-9Ñ]/g, '').length < MINIMO_LETRAS || letras < 3) {
    return { error: `«${t || '(vacío)'}» es muy corto para reconocer a un beneficiario: escribe su nombre` };
  }
  // El banco a veces trae el texto en el código y el concepto vacío (BANORTE, `[CB.54]`): la regla va donde está.
  const enConcepto = claveMotor(m.concept) !== '';
  // Se comprueba contra el texto como lo ve el MOTOR (con acentos), no contra el normalizado.
  const donde = claveMotor(enConcepto ? m.concept : m.raw_code);
  const patron = patronDe(t);
  if (!new RegExp(patron, 'i').test(donde)) {
    return { error: `el movimiento dice «${donde || '(nada)'}» y no empieza con «${t}»` };
  }
  const tipo = claveMotor(m.raw_type);
  return {
    match_type: tipo ? `^${tipo.replace(/[^A-Z0-9]/g, (c) => '\\' + c)}$` : null,
    match_code: enConcepto ? null : patron,
    match_concept: enConcepto ? patron : null,
    texto: t,
  };
}
