/**
 * Fase RH · `[RH.1.11]` — el MOTOR que decide quién es la persona detrás de un código de reloj, como lógica pura.
 *
 * Nació en la carga única (`database/scripts/rh/carga-personas-mega-talento.js`, `[RH.1.4]`/`[RH.1.4b]`). Después del
 * corte ya no hay carga: las personas nuevas las liga RH desde `/rh/relojes` (`[RH.1.12]`), y la bandeja propone
 * candidatos con ESTAS mismas reglas. Vive aquí (no sólo en el guion) por ADR-056: lo que se construye encima no debe
 * reimplementar la decisión.
 *
 * ⚠️ El guion sigue con su copia en JavaScript a propósito: corre dentro del pod de prod, cuya imagen no trae `libs/`
 * ni TypeScript. `personas.spec.ts` exige que las dos copias decidan IGUAL sobre el mismo corpus; si una cambia y la
 * otra no, la prueba se pone roja.
 */

/** Palabras mínimas de un nombre para unir fichas o ligarlo a una cuenta: menos es un apodo. */
export const PALABRAS_MINIMAS = 3;

/** Nombre comparable: mayúsculas, sin acentos ni signos, espacios colapsados. */
export function normalizarNombre(v: unknown): string {
  return String(v ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[.,_-]/g, ' ').replace(/\s+/g, ' ').trim();
}

export const palabras = (normal: string): number => (normal ? normal.split(' ').length : 0);

/** La sección de RH como la guarda Mega Talento (MAYÚSCULAS, sin espacios de sobra); null si no hay. */
export function seccionDe(departamento: unknown): string | null {
  const s = String(departamento ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  return s || null;
}

export type DecisionPersona =
  | { accion: 'reusar'; userId: string }
  | { accion: 'por_decidir'; motivo: string }
  | { accion: 'ligar_cuenta'; userId: string }
  | { accion: 'crear'; aviso?: string };

/**
 * La decisión por persona. `ligadas` = personas que YA tienen los enrolamientos de alguno de sus códigos;
 * `cuentas` = cuentas de la Suite con el mismo nombre normalizado (ya filtradas por almacén compatible).
 */
export function decidir(a: { ligadas: string[]; cuentas: string[]; palabras: number }): DecisionPersona {
  if (a.ligadas.length === 1) return { accion: 'reusar', userId: a.ligadas[0] };
  if (a.ligadas.length > 1) return { accion: 'por_decidir', motivo: 'sus_codigos_estan_ligados_a_dos_personas' };
  if (a.cuentas.length === 1 && a.palabras >= PALABRAS_MINIMAS) return { accion: 'ligar_cuenta', userId: a.cuentas[0] };
  if (a.cuentas.length > 1) return { accion: 'crear', aviso: 'varias_cuentas_de_la_suite_con_el_mismo_nombre' };
  if (a.cuentas.length === 1) return { accion: 'crear', aviso: 'nombre_corto_coincide_con_una_cuenta' };
  return { accion: 'crear' };
}

// ── `[RH.1.12]` Los candidatos de la bandeja ─────────────────────────────────────────────────────────────────────

/** Una cuenta de la Suite que podría ser la persona. */
export interface CuentaPersona {
  id: string;
  nombre: string | null;
  warehouse_code: string | null;
  status: string | null;
}

export type MotivoCandidato = 'mismo_codigo' | 'mismo_nombre' | 'nombre_parecido';

export interface CandidatoPersona {
  user_id: string;
  nombre: string;
  status: string | null;
  motivo: MotivoCandidato;
  /** El que el motor elegiría solo (lo mismo que haría la carga). RH confirma igual: nunca se liga automático. */
  sugerido: boolean;
}

const RANGO: Record<MotivoCandidato, number> = { mismo_codigo: 0, mismo_nombre: 1, nombre_parecido: 2 };

/**
 * Quién podría ser la persona de un código sin ligar, en orden:
 *   1. `mismo_codigo` — su mismo código ya está ligado en otro reloj de la plaza (la carga lo «reusaría»);
 *   2. `mismo_nombre` — una cuenta con el mismo nombre normalizado de 3+ palabras, de un almacén compatible;
 *   3. `nombre_parecido` — una cuenta cuyo nombre contiene todas las palabras del nombre del reloj (2+ palabras).
 * El `sugerido` sale de `decidir()`, la misma regla de la carga. Con dos personas ligadas al mismo código no hay
 * sugerido: es el caso que la carga deja «por decidir».
 */
export function candidatosPara(a: {
  nombreReloj: string | null;
  almacen: string | null;
  ligadosMismoCodigo: string[];
  cuentas: CuentaPersona[];
  max?: number;
}): CandidatoPersona[] {
  const max = a.max ?? 5;
  const porId = new Map(a.cuentas.map((c) => [c.id, c]));
  const normal = normalizarNombre(a.nombreReloj);
  const n = palabras(normal);
  const compatible = (c: CuentaPersona) => !c.warehouse_code || !a.almacen || c.warehouse_code === a.almacen;
  const salida = new Map<string, CandidatoPersona>();
  const agregar = (c: CuentaPersona | undefined, motivo: MotivoCandidato) => {
    if (!c) return;
    const previo = salida.get(c.id);
    if (previo && RANGO[previo.motivo] <= RANGO[motivo]) return;
    salida.set(c.id, { user_id: c.id, nombre: c.nombre ?? '(sin nombre)', status: c.status, motivo, sugerido: false });
  };

  const ligados = [...new Set(a.ligadosMismoCodigo)];
  for (const id of ligados) agregar(porId.get(id), 'mismo_codigo');
  const mismos = n >= PALABRAS_MINIMAS ? a.cuentas.filter((c) => compatible(c) && normalizarNombre(c.nombre) === normal) : [];
  for (const c of mismos) agregar(c, 'mismo_nombre');
  if (n >= 2) {
    const mias = normal.split(' ');
    for (const c of a.cuentas) {
      if (!compatible(c)) continue;
      const suyas = new Set(normalizarNombre(c.nombre).split(' '));
      if (mias.every((p) => suyas.has(p))) agregar(c, 'nombre_parecido');
    }
  }

  const d = decidir({ ligadas: ligados, cuentas: mismos.map((c) => c.id), palabras: n });
  const elegido = d.accion === 'reusar' || d.accion === 'ligar_cuenta' ? d.userId : null;
  const lista = [...salida.values()]
    .map((c) => ({ ...c, sugerido: c.user_id === elegido }))
    .sort((x, y) => RANGO[x.motivo] - RANGO[y.motivo] || x.nombre.localeCompare(y.nombre, 'es'));
  return lista.slice(0, max);
}

/** `[RH.1.12]` Lo que RH tiene que escribir para dar de alta a alguien: nombre de 2+ palabras y su sección. */
export function validarAlta(b: { nombre?: unknown; seccion?: unknown }): { nombre: string; seccion: string } | { error: string } {
  const nombre = String(b?.nombre ?? '').replace(/\s+/g, ' ').trim();
  if (palabras(normalizarNombre(nombre)) < 2) return { error: 'Escribe el nombre completo (nombre y apellido).' };
  if (nombre.length > 120) return { error: 'El nombre es demasiado largo.' };
  const seccion = seccionDe(b?.seccion);
  if (!seccion) return { error: 'Elige la sección del reporte de RH (sin ella no puede entrar al cierre semanal).' };
  if (seccion.length > 80) return { error: 'La sección es demasiado larga.' };
  return { nombre, seccion };
}

/** `[RH.1.12]` Username de una persona dada de alta desde la bandeja: plaza + código, con prefijo propio. */
export function usernameAlta(sitio: string, codigo: string): string {
  const limpio = (s: string) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `rh.${limpio(sitio)}.${limpio(codigo)}`;
}
