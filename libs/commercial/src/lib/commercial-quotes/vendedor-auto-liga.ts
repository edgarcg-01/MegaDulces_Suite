/**
 * `[COT.25]` Liga AUTOMÁTICA usuario de la Suite ↔ vendedor de Kepler, por nombre, sin copiar nada:
 * se calcula al pedirla, así un usuario nuevo queda ligado en cuanto su nombre coincide.
 *
 * ⚠️ El nombre solo NO basta (medido en prod el 2026-11-04): «Luis Fernando Muñoz Herrera» caía en
 * el código de «José Luis Mota Muñoz» con una coincidencia floja, y «Daniel Francisco Franco
 * Martinez» casa con «FRANCISCO MARTINEZ» (código 505) además de con el suyo. Por eso la regla es
 * estricta y lo dudoso NO se liga:
 *
 *  1. TODAS las palabras del nombre del vendedor en Kepler (sin prefijos como TLMKT, VMPH01, RD,
 *     RVMA02) tienen que estar en el nombre del usuario, en cualquier orden, y al menos dos.
 *     Una palabra casa si es igual, si es el principio de la del usuario (Kepler corta a 30
 *     caracteres: «CASTELLA») o si sólo difiere en la última letra («YARET»/«YARED»).
 *  2. El código no puede casar con dos personas: si casa con dos, no se liga a ninguna.
 *  3. Si una persona casa con varios códigos en la misma sucursal, gana el único que tiene
 *     pedidos o facturas ahí en los últimos 90 días; si no hay uno solo, no se liga.
 *
 * Sólo personas (`identity.users.kind = 'interno'`): las cuentas de dispositivo («Etiquetas -
 * Padre Hidalgo») casarían con los vendedores que llevan el nombre de la plaza.
 */

export interface UsuarioParaLiga {
  user_id: string;
  nombre: string;
}

export interface VendedorKepler {
  sucursal: string;
  code: string;
  name: string;
}

export interface LigaVendedor {
  code: string;
  name: string;
}

/** Palabras que en Kepler son prefijo del puesto o de la plaza, no parte del nombre de la persona. */
const NO_NOMBRE = new Set(['DEL', 'LAS', 'LOS', 'TLMK', 'TLMKT', 'VMPH', 'RVMM', 'RVMA', 'MOR', 'CAN']);

/**
 * Un «vendedor» de Kepler que NO es una persona: la plaza, el piso, la ruta, el comercio en línea
 * («SUCURSAL ZAMORA CENTRO PISO», «RUTA VECINAL PH 01», «PV MORELIA MADERO», «E-COMMERCE»). Ése
 * nunca se liga a un usuario, aunque una cuenta lleve el nombre de la plaza.
 */
const NO_PERSONA = /\b(SUCURSAL|PISO|RUTA|VECINAL|VENTAS|COMMERCE|VENDEDORES|ZONA|OTROS|INGRESOS|PV)\b/;
const PLAZAS = new Set([
  'PADRE', 'HIDALGO', 'PIEDAD', 'ABASTO', 'ABASTOS', 'ESQUINAS', 'YURECUARO', 'ZAMORA', 'CENTRO',
  'CANINDO', 'MORELIA', 'MADERO', 'CEDIS', 'MATRIZ',
]);

function sinAcentos(s: string): string {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

/** ¿El vendedor de Kepler es una persona? (no una plaza, un piso o una ruta) */
export function esPersona(nombreKepler: string): boolean {
  if (NO_PERSONA.test(sinAcentos(nombreKepler))) return false;
  const p = palabrasDeNombre(nombreKepler);
  return p.length >= 2 && !p.every((t) => PLAZAS.has(t));
}

/** Mayúsculas sin acentos, palabras de 3+ letras, sin las que llevan dígitos ni las de `NO_NOMBRE`. */
export function palabrasDeNombre(nombre: string): string[] {
  return sinAcentos(nombre)
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length >= 3 && !/[0-9]/.test(t) && !NO_NOMBRE.has(t));
}

function casaPalabra(deKepler: string, delUsuario: string): boolean {
  if (deKepler === delUsuario) return true;
  if (deKepler.length >= 4 && delUsuario.startsWith(deKepler)) return true;
  return (
    deKepler.length >= 5 &&
    deKepler.length === delUsuario.length &&
    deKepler.slice(0, -1) === delUsuario.slice(0, -1)
  );
}

/** Regla 1: todas las palabras del vendedor (2 o más) están en el nombre del usuario. */
export function casaNombre(vendedor: string, usuario: string): boolean {
  if (!esPersona(vendedor)) return false;
  const v = palabrasDeNombre(vendedor);
  const u = palabrasDeNombre(usuario);
  return v.length >= 2 && v.every((pv) => u.some((pu) => casaPalabra(pv, pu)));
}

/**
 * Las ligas automáticas de TODOS los usuarios: `user_id → { sucursal → vendedor }`.
 * `activos` = `"sucursal|código"` con pedidos o facturas en 90 días (sólo desempata, regla 3).
 * `tomados` = `"sucursal|código"` ya ligados a mano a alguien: ésos no se reparten por nombre.
 */
export function ligasAutomaticas(
  usuarios: UsuarioParaLiga[],
  vendedores: VendedorKepler[],
  activos: Set<string>,
  tomados: Set<string> = new Set(),
): Map<string, Record<string, LigaVendedor>> {
  const pares: Array<{ user_id: string; v: VendedorKepler }> = [];
  for (const v of vendedores) {
    if (tomados.has(`${v.sucursal}|${v.code}`)) continue;
    for (const u of usuarios) if (casaNombre(v.name, u.nombre)) pares.push({ user_id: u.user_id, v });
  }

  // Regla 2: un código que casa con dos personas no es de ninguna.
  const personasPorCodigo = new Map<string, Set<string>>();
  for (const p of pares) {
    const k = `${p.v.sucursal}|${p.v.code}`;
    if (!personasPorCodigo.has(k)) personasPorCodigo.set(k, new Set());
    personasPorCodigo.get(k)!.add(p.user_id);
  }
  const unicos = pares.filter((p) => personasPorCodigo.get(`${p.v.sucursal}|${p.v.code}`)!.size === 1);

  // Regla 3: varios códigos de la misma persona en la misma sucursal → el único activo, o ninguno.
  const porPersonaSucursal = new Map<string, VendedorKepler[]>();
  for (const p of unicos) {
    const k = `${p.user_id}|${p.v.sucursal}`;
    if (!porPersonaSucursal.has(k)) porPersonaSucursal.set(k, []);
    porPersonaSucursal.get(k)!.push(p.v);
  }
  const out = new Map<string, Record<string, LigaVendedor>>();
  for (const [k, vs] of porPersonaSucursal) {
    const distintos = [...new Map(vs.map((v) => [v.code, v])).values()];
    let elegido: VendedorKepler | null = null;
    if (distintos.length === 1) elegido = distintos[0];
    else {
      const conActividad = distintos.filter((v) => activos.has(`${v.sucursal}|${v.code}`));
      if (conActividad.length === 1) elegido = conActividad[0];
    }
    if (!elegido) continue;
    const userId = k.slice(0, k.lastIndexOf('|'));
    if (!out.has(userId)) out.set(userId, {});
    out.get(userId)![elegido.sucursal] = { code: elegido.code, name: elegido.name };
  }
  return out;
}
