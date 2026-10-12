/**
 * Fase CP `[CP.8.35]` — **Resolver a QUÉ proveedor se le pagó, desde el concepto del banco.**
 *
 * ── Por qué hacía falta, y por qué nadie lo había notado ────────────────────────────────────
 * `armarPagoProveedor` lee `regla.cuenta_gasto`, y para una regla `por_proveedor` esa columna es
 * **NULL por diseño** — lo exige el CHECK de coherencia de `[CP.8.19]`, porque la cuenta no es de
 * la categoría sino **del proveedor**. O sea que la cuenta hay que resolverla **por movimiento**,
 * y ese paso simplemente no existía: los 216 movimientos de `compra_mercancia` de enero
 * (**$43.5M**, la categoría más grande del puente) se rechazaban en bloque con
 * `proveedor_sin_cuenta`.
 *
 * ⭐ Y no necesita la firma del contador: `armarAsientoEgreso` devuelve en `por_proveedor`
 * **antes** de mirar `estado`.
 *
 * ── ⛔ Lo que midió el método, con control de placebo ────────────────────────────────────────
 * Primer intento, pareo por nombre normalizado contra todo el padrón: **3 de 216 (1.4%)** y
 * **153 ambiguos (70.8%)**. Parecía que el nombre no servía.
 *
 * ⭐ No era el nombre: era el **rubro**. Las cuentas de proveedor viven en TRES (`2120`, `5010`,
 * `5020`) y el mismo nombre aparece en los tres, así que todo salía "ambiguo". La propia regla ya
 * decía cuál es el suyo (`cuenta_prefijo = '2120'`): un pago carga a la cuenta **por pagar**, no a
 * la de compras. Honrando ese prefijo:
 *
 * | | antes | después |
 * |---|--:|--:|
 * | resuelto | 1.4 % | **70.4 %** |
 * | ambiguo | 70.8 % | 1.9 % |
 * | **placebo** | 0.0 % | **0.0 %** |
 *
 * El placebo (los mismos conceptos contra el padrón con los nombres invertidos) parea **cero**
 * en los dos casos: el método mide algo, no ruido.
 *
 * ── Las tres cosas que este resolvedor se NIEGA a hacer ─────────────────────────────────────
 *  1. **Elegir entre dos cuentas.** Si el nombre apunta a más de una, devuelve `ambiguo`. Elegir
 *     una sería inventar, y el error se ve recién al cuadrar la balanza.
 *  2. **Usar un veredicto sin RFC.** `solo_nombre` y `sin_proveedor` no tienen con qué sostenerse
 *     (8 de los 152 pareos de enero caen ahí). Se devuelven como `veredicto_debil`, no como cuenta.
 *  3. **Parear parecido.** Sin distancia de edición ni subcadenas: un `HERSHEYS` que casara con
 *     `HERSHEYS DISTRIBUIDORA` cargaría a la cuenta equivocada sin que nada se descuadre.
 */

/** Qué le pasó a un movimiento cuando se buscó su proveedor. */
export type VeredictoProveedor =
  | 'resuelto'
  /** El nombre existe pero apunta a 2+ cuentas del mismo rubro. */
  | 'ambiguo'
  /** Pareó, pero la cuenta no tiene RFC detrás: no se usa. */
  | 'veredicto_debil'
  /** El nombre no está en el padrón. */
  | 'sin_pareo'
  /** El movimiento no trae concepto con qué buscar. */
  | 'sin_concepto';

export interface CuentaProveedor {
  cuenta: string;
  proveedor_nombre: string | null;
  cuenta_nombre: string | null;
  veredicto: string;
  rfc: string | null;
}

export interface ResultadoProveedor {
  veredicto: VeredictoProveedor;
  cuenta: string | null;
  /** Para la bandeja: qué decir cuando no se resolvió. */
  motivo: string | null;
  /** El veredicto del padrón, cuando hubo pareo. Viaja aunque no se use. */
  veredicto_padron?: string;
}

/**
 * ⭐ Los únicos veredictos del padrón que sostienen una cuenta. Los dos exigen RFC — es el mismo
 * criterio que el CHECK de `contpaqi.supplier_accounts`, y acá se repite a propósito: un CHECK
 * protege la tabla, no al consumidor que lee una fila vieja.
 */
export const VEREDICTOS_USABLES = new Set(['confirmado', 'uuid_solido']);

/**
 * Normaliza un nombre para compararlo.
 *
 * ⚠️ La puntuación intra-palabra se **borra**, no se convierte en espacio: `CANEL'S` tiene que
 * dar `CANELS` y no `CANEL S`, que parte la palabra en dos y deja de parear. Es la misma regla
 * que usa el importador del mapa, y vale la pena que sea idéntica: dos normalizaciones distintas
 * sobre los mismos datos producen dos padrones distintos.
 *
 * Los sufijos societarios se quitan porque el banco los escribe de cualquier forma — medido en
 * enero: `"Distribuidora de la Rosa"`, `"DISTRIBUIDORA DE LA ROSA"` y
 * `"Distribuidora de la Rosa SA de CV"` son el mismo proveedor en tres renglones.
 */
export function normalizarNombre(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, '')
    .replace(/\b(SA|S A|DE|CV|C V|SAPI|S DE RL|RL|SC|MEXICO)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nombres más cortos que esto no se indexan: parearían demasiado. */
export const LARGO_MINIMO = 5;

export interface IndiceProveedores {
  /** nombre normalizado → cuentas candidatas (del rubro pedido). */
  readonly porNombre: Map<string, CuentaProveedor[]>;
  /**
   * `[CP.8.36]` alias normalizado → cuenta, **afirmado por una persona**.
   *
   * ⭐ Se consulta ANTES del padrón: lo que alguien confirmó le gana a lo derivado. Es el único
   * camino para los 72 que el padrón no resuelve ($6.8M de enero), y el único honesto: la
   * alternativa era parear por subcadena, que carga a la cuenta equivocada **y cuadra igual**.
   */
  readonly porAlias: Map<string, string>;
  readonly prefijo: string;
}

/** Una fila de `contpaqi.supplier_aliases`. */
export interface AliasProveedor {
  alias_normalizado: string;
  cuenta: string;
}

/**
 * Arma el índice para UN rubro. ⛔ El rubro es obligatorio y sin default: olvidarlo fue
 * exactamente el defecto que bajó la resolución de 70.4 % a 1.4 %.
 */
export function construirIndice(
  cuentas: CuentaProveedor[],
  prefijo: string,
  alias: AliasProveedor[] = [],
): IndiceProveedores {
  if (!prefijo || !/^\d{3,}$/.test(prefijo)) {
    throw new Error(
      `[CP.8.35] el rubro es obligatorio y debe ser numérico (vino "${prefijo}"): sin él, el mismo `
      + 'nombre aparece en 2120/5010/5020 y todo sale ambiguo.',
    );
  }
  const porNombre = new Map<string, CuentaProveedor[]>();
  for (const c of cuentas) {
    if (!String(c.cuenta ?? '').startsWith(prefijo)) continue;
    for (const campo of [c.proveedor_nombre, c.cuenta_nombre]) {
      const n = normalizarNombre(campo);
      if (n.length < LARGO_MINIMO) continue;
      const ya = porNombre.get(n);
      if (!ya) { porNombre.set(n, [c]); continue; }
      // La misma cuenta puede llegar por los dos campos; eso no es ambigüedad.
      if (!ya.some((x) => x.cuenta === c.cuenta)) ya.push(c);
    }
  }
  /**
   * ⛔ El alias se valida contra el MISMO rubro. Un alias que apuntara a una cuenta de otro
   * rubro sería una puerta trasera al defecto que costó 69 pp: se ignora y se deja ver.
   */
  const porAlias = new Map<string, string>();
  for (const a of alias) {
    const n = normalizarNombre(a.alias_normalizado);
    if (n.length < LARGO_MINIMO) continue;
    if (!String(a.cuenta ?? '').startsWith(prefijo)) continue;
    porAlias.set(n, a.cuenta);
  }
  return { porNombre, porAlias, prefijo };
}

/** Resuelve el concepto de un movimiento contra el índice. No adivina. */
export function resolverProveedor(indice: IndiceProveedores, concepto: unknown): ResultadoProveedor {
  const n = normalizarNombre(concepto);
  if (n.length < LARGO_MINIMO) {
    return {
      veredicto: 'sin_concepto',
      cuenta: null,
      motivo: `el movimiento no trae un nombre con qué buscar ("${String(concepto ?? '')}")`,
    };
  }
  /**
   * ⭐ `[CP.8.36]` El alias confirmado por una persona va PRIMERO. Si alguien ya dijo que
   * `"Hersheys Mexico"` del banco es tal cuenta, no hay nada que derivar — y deja de importar
   * que el padrón no tenga ese nombre.
   */
  const alias = indice.porAlias.get(n);
  if (alias) {
    return { veredicto: 'resuelto', cuenta: alias, motivo: null, veredicto_padron: 'alias_confirmado' };
  }

  const cand = indice.porNombre.get(n);
  if (!cand || !cand.length) {
    return {
      veredicto: 'sin_pareo',
      cuenta: null,
      motivo: `"${n}" no está en el padrón de cuentas ${indice.prefijo}* de ContPAQi`,
    };
  }
  if (cand.length > 1) {
    return {
      veredicto: 'ambiguo',
      cuenta: null,
      motivo: `"${n}" apunta a ${cand.length} cuentas ${indice.prefijo}* `
        + `(${cand.map((c) => c.cuenta).join(', ')}): elegir una sería inventar`,
    };
  }
  const c = cand[0];
  if (!VEREDICTOS_USABLES.has(c.veredicto)) {
    return {
      veredicto: 'veredicto_debil',
      cuenta: null,
      veredicto_padron: c.veredicto,
      motivo: `pareó con ${c.cuenta} pero su veredicto es "${c.veredicto}", que no lleva RFC detrás`,
    };
  }
  return { veredicto: 'resuelto', cuenta: c.cuenta, motivo: null, veredicto_padron: c.veredicto };
}

/**
 * `[CP.8.37]` — Palabras en común entre dos nombres, 0..1.
 *
 * ⛔ **Es una pista para ORDENAR, nunca un criterio para aplicar.** El resolvedor sigue negándose
 * a parear por parecido: lo que esto hace es poner arriba los candidatos que un humano va a
 * reconocer de un vistazo, no decidir por él.
 */
export function palabrasEnComun(a: unknown, b: unknown): number {
  const pa = new Set(normalizarNombre(a).split(' ').filter((w) => w.length > 2));
  const pb = new Set(normalizarNombre(b).split(' ').filter((w) => w.length > 2));
  if (!pa.size || !pb.size) return 0;
  let comunes = 0;
  for (const w of pa) if (pb.has(w)) comunes += 1;
  return comunes / Math.max(pa.size, pb.size);
}
