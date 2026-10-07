/**
 * `[MS.3.10]` La asignación AUTOMÁTICA de un ticket nuevo. Función pura. ADR-081.
 *
 * Pedido de Sistemas (2026-10-02): *«si una solicitud menciona algo como sistemas, cpu, impresora, asignarla
 * a Felipe; todo lo de desarrollo, a David»*. Una regla = una persona + lo que la dispara.
 *
 * ── Qué dispara una regla ────────────────────────────────────────────────────────────────────
 *  · la **categoría** que eligió quien reporta (exacta, la señal confiable), **o**
 *  · una **palabra clave** en el título o la descripción (la señal que pidieron: lo que la persona ESCRIBE).
 *
 * Gana la **primera** regla que aplica, por `sort_order`. Si un ticket menciona «impresora» y «desarrollo» y la
 * regla de impresoras va primero, va a quien atiende impresoras: el orden es la desambiguación, y por eso se ve
 * y se edita en pantalla.
 *
 * ── Cómo se compara el texto ─────────────────────────────────────────────────────────────────
 * Sin mayúsculas, sin acentos y por PALABRA: la clave `impresora` encuentra «Impresora», «impresoras» y
 * «IMPRESORA» pero NO «impresoraXL-pro» pegado a otra cosa por azar de subcadena (`red` no encuentra «ocurrido»).
 * Regla exacta: una palabra del texto **empieza con** la clave (así el plural entra sin pedirle a nadie que liste
 * las dos formas). Una clave de varias palabras («nueva funcionalidad») debe aparecer como frase, empezando en
 * una frontera de palabra.
 *
 * ⚠️ «empieza con» también es lo que deja pasar `red` ⊂ «redes» y `cpu` ⊂ «cpus» — y de rebote `red` ⊂
 * «redacción». Es el costo de aceptar plurales; por eso las claves se declaran a mano y se ven en pantalla, no se
 * deducen. Lo que NO hace esta función es adivinar sinónimos ni corregir faltas de ortografía.
 *
 * ⛔ Esto elige a QUIÉN le toca, no si PUEDE atenderlo: que el destino tenga permiso lo verifica quien llama
 * (`routing.service`), y si no puede el ticket se queda sin asignar. Nunca se le asigna a alguien que no puede
 * abrir su propia ficha.
 */

export interface ReglaRuteo {
  id: string;
  name: string;
  keywords: readonly string[];
  category_id: string | null;
  assignee_id: string;
  sort_order: number;
  active: boolean;
}

export interface EntradaRuteo {
  title: string;
  description: string;
  categoryId: string;
}

/**
 * Minúsculas, sin acentos, todo lo que no sea letra o dígito se vuelve un espacio y se colapsa. La ñ se pliega a n
 * (como un acento más): quien escribe «diseno» sin ñ en el celular tiene que encontrar la clave «diseño».
 */
export function normalizarTexto(s: string): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Las claves se guardan normalizadas, sin vacíos ni repetidas. */
export function normalizarClaves(claves: readonly string[]): string[] {
  return [...new Set(claves.map(normalizarTexto).filter((c) => c.length > 0))];
}

/**
 * ¿`clave` (ya normalizada) aparece en `texto` (ya normalizado)? Una palabra del texto empieza con la clave; una
 * clave de varias palabras se busca como frase que empieza en frontera de palabra.
 */
export function contieneClave(texto: string, clave: string): boolean {
  if (!clave) return false;
  const t = ` ${texto}`;
  return t.includes(` ${clave}`);
}

/** Cuál de las claves de una regla aparece en el texto, o `null`. */
export function claveEncontrada(texto: string, claves: readonly string[]): string | null {
  for (const c of claves) if (contieneClave(texto, normalizarTexto(c))) return c;
  return null;
}

export interface ResultadoRuteo {
  regla: ReglaRuteo;
  /** Por qué le tocó: `categoria` o la `palabra` exacta que la disparó. Se guarda en el hilo, para que se vea. */
  motivo: { tipo: 'categoria' } | { tipo: 'palabra'; palabra: string };
}

/** La primera regla activa que aplica (por `sort_order`, luego por nombre), o `null`. */
export function elegirRegla(reglas: readonly ReglaRuteo[], e: EntradaRuteo): ResultadoRuteo | null {
  const texto = normalizarTexto(`${e.title} ${e.description}`);
  const ordenadas = [...reglas]
    .filter((r) => r.active)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  for (const regla of ordenadas) {
    if (regla.category_id && regla.category_id === e.categoryId) return { regla, motivo: { tipo: 'categoria' } };
    const palabra = claveEncontrada(texto, regla.keywords);
    if (palabra) return { regla, motivo: { tipo: 'palabra', palabra } };
  }
  return null;
}
