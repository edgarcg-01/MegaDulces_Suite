/**
 * Fase RH · `[RH.3.2]` — a qué vacante se refiere lo que escribió el candidato. Lógica PURA, portada de
 * `vacante-match.js` de Mega Talento (con sus reglas y sus porqués; recibe la lista, no la busca).
 *
 *   1. Nombre idéntico (normalizado).  "chofer" → Chofer, no "Aux de chofer".
 *   2. Que TODAS las palabras significativas de la vacante estén en el texto; gana la que casó más palabras.
 *   3. Si ninguna, basta una palabra DISCRIMINANTE (en el nombre de una sola vacante) que no sea genérica.
 *   4. Si no, null: no hay vacante para lo que pidió, y hay que decirlo.
 *
 * Por qué no basta «que coincida una palabra»: en Mega Talento, al desactivarse "Auxiliar de Prevención", la palabra
 * "auxiliar" quedó en una sola vacante y 30 candidatos que pedían "Auxiliar de <otra cosa>" se mandaron a Aux de
 * chofer. Lo que identifica a un "Auxiliar de X" (o a una "Jefatura de X") es la X: de ahí `GENERICAS`.
 */

const ABREVIATURAS: Record<string, string> = { aux: 'auxiliar', ayte: 'ayudante', enc: 'encargado' };

const GENERICAS = new Set([
  'auxiliar', 'ayudante', 'asistente', 'encargado', 'encargada', 'personal',
  'general', 'operativo', 'operativa', 'empleado', 'trabajador', 'puesto', 'area',
  'jefatura', 'jefe', 'jefa', 'gerente', 'gerencia', 'supervisor', 'supervisora',
  'supervision', 'coordinador', 'coordinadora', 'coordinacion', 'lider', 'director',
  'directora', 'direccion', 'responsable', 'analista',
]);

/** Nombres con los que la gente pide lo mismo (RH, becario, servicio social…). */
const SIGLAS: Array<[RegExp, string]> = [
  [/\brrhh\b/g, 'recursos humanos'],
  [/\brh\b/g, 'recursos humanos'],
  [/\bbecari[oa]s?\b/g, 'practicante'],
  [/\bpasantes?\b/g, 'practicante'],
  [/\bservicio social\b/g, 'practicante'],
  [/\bestadias?\b/g, 'practicante'],
];

/** Minúsculas, sin acentos, sólo letras y espacios. */
export function normalizaVacante(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function palabrasClave(texto: string): string[] {
  let t = normalizaVacante(texto);
  for (const [re, val] of SIGLAS) t = t.replace(re, val);
  return t.split(' ').map((w) => ABREVIATURAS[w] || w).filter((w) => w.length >= 4);
}

/** Casan por raíz de 5 letras, en cualquier dirección ("cajero" con "cajera", "choferes" con "chofer"). */
function casaPalabra(palabrasTexto: string[], w: string): boolean {
  const raiz = w.slice(0, 5);
  return palabrasTexto.some((tk) => tk.startsWith(raiz) || w.startsWith(tk.slice(0, 5)));
}

export interface VacanteNombrada { name: string }

/** La vacante a la que se refiere el texto, o null si ninguna corresponde. */
export function resolverVacante<V extends VacanteNombrada>(texto: string | null | undefined, vacantes: readonly V[]): V | null {
  const t = normalizaVacante(texto);
  const lista = vacantes.filter((p) => p && String(p.name || '').trim());
  if (!t || !lista.length) return null;

  const exacta = lista.find((p) => normalizaVacante(p.name) === t);
  if (exacta) return exacta;

  const palabrasTexto = palabrasClave(String(texto));
  if (!palabrasTexto.length) return null;

  const enCuantas = new Map<string, number>();
  for (const p of lista) for (const w of new Set(palabrasClave(p.name))) enCuantas.set(w, (enCuantas.get(w) || 0) + 1);

  let completa: { puesto: V; casadas: number } | null = null;
  let porDiscriminante: V | null = null;
  for (const p of lista) {
    const claves = palabrasClave(p.name);
    if (!claves.length) continue;
    const casadas = claves.filter((w) => casaPalabra(palabrasTexto, w));
    if (!casadas.length) continue;
    if (casadas.length === claves.length) {
      if (!completa || casadas.length > completa.casadas) completa = { puesto: p, casadas: casadas.length };
      continue;
    }
    if (!porDiscriminante && casadas.some((w) => enCuantas.get(w) === 1 && !GENERICAS.has(w))) porDiscriminante = p;
  }
  return completa ? completa.puesto : porDiscriminante;
}

/** Las vacantes sin repetir por nombre (RH a veces da de alta dos iguales). */
export function vacantesUnicas<V extends VacanteNombrada>(vacantes: readonly V[]): V[] {
  const vistos = new Set<string>();
  return vacantes.filter((p) => {
    const k = normalizaVacante(p.name);
    if (!k || vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}
