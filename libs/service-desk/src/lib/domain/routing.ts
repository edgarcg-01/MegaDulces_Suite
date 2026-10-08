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
 * ── `[MS.7.10]` La ubicación ─────────────────────────────────────────────────────────────────
 * Una regla puede traer además una UBICACIÓN (`warehouse_code`). Es un FILTRO: si la regla la trae, el ticket debe venir de ahí o
 * la regla no aplica — «Plomería en Oficinas → Pedro» no se dispara con una fuga en el CEDIS. Una regla con ubicación y SIN
 * categoría ni palabras se dispara por la ubicación sola («todo lo de Oficinas → Pedro»).
 *
 * Cuál gana: **la más específica, y entre iguales la primera por orden.** Especificidad = cuántas CONDICIONES trae: el disparador
 * (categoría o palabras, que son un solo «o») cuenta una vez y la ubicación otra. Así «categoría + ubicación» (2) le gana a
 * «categoría» (1) aunque vaya después en la lista, y TODA regla anterior (sin ubicación, especificidad 1) conserva exactamente su
 * orden de siempre: nada de lo que ya funciona cambia de dueño.
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
  /** `[MS.7.10]` Filtro de ubicación (código de sucursal o ubicación extra). `null`/ausente = no mira la ubicación. */
  warehouse_code?: string | null;
}

export interface EntradaRuteo {
  title: string;
  description: string;
  categoryId: string;
  /** `[MS.7.10]` La ubicación del ticket (si la indicó). */
  warehouseCode?: string | null;
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
  /** Por qué le tocó: `categoria`, la `palabra` exacta que la disparó o la `ubicacion`. Se guarda en el hilo, para que se vea. */
  motivo: MotivoRuteo;
}

export type MotivoRuteo = { tipo: 'categoria' } | { tipo: 'palabra'; palabra: string } | { tipo: 'ubicacion' };

/** `[MS.7.10]` Cuántas condiciones trae la regla (el disparador categoría/palabras es UNA; la ubicación, otra). */
export function especificidad(r: ReglaRuteo): number {
  return (r.warehouse_code ? 1 : 0) + (r.category_id || r.keywords.length > 0 ? 1 : 0);
}

/** ¿La regla aplica a este ticket y por qué? (`null` = no aplica). No mira si está activa. */
function motivoDe(r: ReglaRuteo, e: EntradaRuteo, texto: string): MotivoRuteo | null {
  // La ubicación es un filtro: una regla de «Oficinas» no aplica a un ticket del CEDIS (ni a uno sin ubicación).
  if (r.warehouse_code && r.warehouse_code !== (e.warehouseCode ?? null)) return null;
  if (r.category_id && r.category_id === e.categoryId) return { tipo: 'categoria' };
  const palabra = claveEncontrada(texto, r.keywords);
  if (palabra) return { tipo: 'palabra', palabra };
  // Sin categoría ni palabras, la ubicación (que ya coincidió) es el disparador.
  if (!r.category_id && r.keywords.length === 0 && r.warehouse_code) return { tipo: 'ubicacion' };
  return null;
}

/** La regla activa MÁS ESPECÍFICA que aplica (a igualdad, la primera por `sort_order`, luego por nombre), o `null`. */
export function elegirRegla(reglas: readonly ReglaRuteo[], e: EntradaRuteo): ResultadoRuteo | null {
  const texto = normalizarTexto(`${e.title} ${e.description}`);
  const aplican: ResultadoRuteo[] = [];
  for (const regla of reglas) {
    if (!regla.active) continue;
    const motivo = motivoDe(regla, e, texto);
    if (motivo) aplican.push({ regla, motivo });
  }
  aplican.sort((a, b) => especificidad(b.regla) - especificidad(a.regla) || a.regla.sort_order - b.regla.sort_order || a.regla.name.localeCompare(b.regla.name));
  return aplican[0] ?? null;
}
