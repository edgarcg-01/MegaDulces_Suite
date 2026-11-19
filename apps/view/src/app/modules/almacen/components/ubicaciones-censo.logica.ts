import {
  ASSIGNMENT_ROLES,
  LOCATION_KINDS,
  parseLocationCode,
  type AssignmentRole,
  type LocationCodeParts,
  type LocationKind,
  type LocationZone,
  type ProductLocationDetail,
  type ProductPlace,
  type ProductPresentation,
  type WarehouseLocationRow,
} from '@megadulces/contracts';

/**
 * `[UB.3b]` Lo que decide el censo por escaneo, sin pantalla de por medio (FASE_UB §5, camino 3):
 * qué se escaneó, qué papel le toca a un producto en esa ubicación y qué presentación es el código.
 * Todo lo que el sistema puede deducir se deduce: la persona sólo escanea.
 */

export type Lectura =
  | { tipo: 'vacia' }
  | { tipo: 'ubicacion'; code: string; parts: LocationCodeParts }
  | { tipo: 'producto'; texto: string };

/** Un cartel de ubicación (`BA053`) o cualquier otra cosa, que se busca como producto. */
export function clasificarLectura(raw: string | null | undefined): Lectura {
  const texto = String(raw ?? '').trim();
  if (!texto) return { tipo: 'vacia' };
  const u = parseLocationCode(texto);
  if (u.ok) return { tipo: 'ubicacion', code: u.code, parts: u.parts };
  return { tipo: 'producto', texto };
}

/** Al dar de alta desde el escaneo: bodega = surtido (lo más común), tienda = piso. */
export function tipoPorDefecto(zona: LocationZone): LocationKind {
  return zona === 'B' ? 'surtido' : 'tienda_piso';
}

export const tipoLabel = (t: LocationKind | null): string => LOCATION_KINDS.find((k) => k.key === t)?.label ?? 'Sin tipo';
export const papelLabel = (p: AssignmentRole): string => ASSIGNMENT_ROLES.find((r) => r.key === p)?.label ?? p;

/**
 * El papel de un producto en esta ubicación, deducido de la ubicación (`ASSIGNMENT_ROLES`: surtido y
 * reserva en bodega, exhibición en tienda). Una ubicación bloqueada, dada de baja, sin el formato
 * nuevo o de un tipo que no es casa de un producto (recepción, cuarentena, merma) no recibe ninguno.
 */
export function papelParaUbicacion(u: Pick<WarehouseLocationRow, 'code' | 'zona' | 'tipo' | 'estado'>): { papel: AssignmentRole } | { motivo: string } {
  if (u.estado === 'bloqueada') return { motivo: `${u.code} está bloqueada: no se le asignan productos.` };
  if (u.estado === 'baja') return { motivo: `${u.code} está dada de baja.` };
  if (u.zona === 'T') return { papel: 'exhibicion_tienda' };
  if (u.zona !== 'B') return { motivo: `${u.code} no tiene el formato de ubicación (BA053): recodifícala primero.` };
  if (u.tipo === 'reserva') return { papel: 'reserva_preferida' };
  if (u.tipo === null || u.tipo === 'surtido') return { papel: 'surtido_fijo' };
  return { motivo: `${u.code} es de ${tipoLabel(u.tipo).toLowerCase()}: ahí no va el lugar de un producto.` };
}

const norm = (s: string): string => s.trim().toUpperCase();

/** `[UB.RF.11]` Un renglón de «dónde está» de una tarjeta: el lugar en palabras o que falta (con palabra, no con color). */
export interface LugarEnPalabras { etiqueta: 'Tienda' | 'Bodega' | 'Reserva'; valor: string | null }

/**
 * `[UB.RF.11]` Dónde está un producto, para su tarjeta: tienda y bodega siempre (si falta, se dice),
 * reserva sólo si tiene. Con más de una presentación entre sus lugares, cada código lleva su rótulo
 * («BA053 (CJA)»); con una sola, el rótulo sobra.
 */
export function lugaresEnPalabras(lugares: ReadonlyArray<Pick<ProductPlace, 'papel' | 'code' | 'presentacion' | 'rotulo'>>): LugarEnPalabras[] {
  const varias = new Set(lugares.map((l) => l.presentacion)).size > 1;
  const de = (papel: AssignmentRole) =>
    lugares.filter((l) => l.papel === papel).map((l) => (varias && l.rotulo ? `${l.code} (${l.rotulo})` : l.code)).join(', ') || null;
  const out: LugarEnPalabras[] = [
    { etiqueta: 'Tienda', valor: de('exhibicion_tienda') },
    { etiqueta: 'Bodega', valor: de('surtido_fijo') },
  ];
  const reserva = de('reserva_preferida');
  if (reserva) out.push({ etiqueta: 'Reserva', valor: reserva });
  return out;
}

/**
 * `[UB.RF.11]` Con un producto abierto, ¿a qué presentación va la ubicación que se escaneó? La que la
 * persona señaló («Poner lugar» de esa presentación); si no señaló, la única que todavía no tiene ese
 * papel; si son varias (o todas ya lo tienen), se pregunta con un botón por presentación.
 */
export function presentacionParaLugar(
  d: Pick<ProductLocationDetail, 'presentaciones' | 'asignaciones'>,
  papel: AssignmentRole,
  senalada: number | null,
): { peldano: 1 | 2 | 3 } | { opciones: ProductPresentation[] } {
  const s = d.presentaciones.find((p) => p.peldano === senalada);
  if (s) return { peldano: s.peldano };
  if (d.presentaciones.length === 1) return { peldano: d.presentaciones[0].peldano };
  const sinPapel = d.presentaciones.filter((p) => !d.asignaciones.some((a) => a.presentacion === p.peldano && a.papel === papel && a.estado !== 'baja'));
  if (sinPapel.length === 1) return { peldano: sinPapel[0].peldano };
  return { opciones: sinPapel.length ? sinPapel : d.presentaciones };
}

/**
 * Qué presentación es lo que se escaneó: la que trae ese código de barras en la ficha de Kepler de la
 * sucursal (FASE_UB D10, el mismo que distingue caja de paquete en el checado). Si se tecleó la clave
 * o el nombre y el producto tiene una sola presentación, es ésa. Si no se puede saber, se pregunta.
 */
export function presentacionDeLectura(d: Pick<ProductLocationDetail, 'presentaciones'>, texto: string): { peldano: 1 | 2 | 3 } | { opciones: ProductPresentation[] } {
  const t = norm(texto);
  const porCodigo = d.presentaciones.filter((p) => p.codigos.some((c) => norm(c) === t));
  if (porCodigo.length === 1) return { peldano: porCodigo[0].peldano };
  if (d.presentaciones.length === 1) return { peldano: d.presentaciones[0].peldano };
  return { opciones: porCodigo.length > 1 ? porCodigo : d.presentaciones };
}
