import {
  ETIQUETA_AREA_ACUERDO, ETIQUETA_SITUACION_ACUERDO, MAX_CONTACTO_PROVEEDOR, MAX_DESCRIPCION_ACUERDO,
  type AcuerdoVista, type AreaAcuerdo, type CapturarAcuerdoDto, type ListaAcuerdos, type SituacionAcuerdo,
} from '@megadulces/contracts';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import type { DialogPassThrough } from 'primeng/types/dialog';
import { diaCorto, relativo } from './citas-proveedores';

/**
 * `[PQ.3.10]` Compras › Proveedores › Acuerdos — lo que la pantalla dice y arma, sin Angular (se prueba con vitest).
 * La situación y los botones de cada acuerdo los calcula la API (la misma regla que frena la escritura); aquí sólo se
 * ponen en palabras y se filtra la lista que ya llegó entera.
 */

/**
 * El color acompaña a la etiqueta, nunca la sustituye. Rojo = ya pasó su fecha; ámbar = vence hoy; azul = esta semana;
 * gris = al día o cancelado (no pide nada hoy); verde = cumplido.
 */
export const SEVERIDAD_ACUERDO: Readonly<Record<SituacionAcuerdo, 'danger' | 'warn' | 'info' | 'success' | 'secondary'>> = {
  vencido: 'danger',
  vence_hoy: 'warn',
  esta_semana: 'info',
  al_dia: 'secondary',
  cumplido: 'success',
  cancelado: 'secondary',
};

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/**
 * La ✕ de los diálogos a 44 px cuando el puntero es el dedo (Fitts; la de PrimeNG mide 36). Con mouse, la de siempre
 * (gana la densidad). Lo encontró la prueba visual en el Fold 7 y en el celular.
 */
export function ptDialogoTactil(): DialogPassThrough | undefined {
  const tactil = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return tactil ? { pcCloseButton: { root: { style: { minWidth: 'var(--tap-min, 44px)', minHeight: 'var(--tap-min, 44px)' } } } } : undefined;
}

/** El área en palabras. */
export const areaAcuerdo = (a: AreaAcuerdo) => ETIQUETA_AREA_ACUERDO[a];

const DIA_MX = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' });

/**
 * El día de la Ciudad de México de un instante ISO (`AAAA-MM-DD`). Cortar el ISO (`slice(0, 10)`) da el día de UTC: de
 * las 18:00 en adelante, el de mañana.
 */
export function fechaMx(iso: string): string {
  return DIA_MX.format(new Date(iso));
}

/**
 * Cuándo vence, contra hoy (Ciudad de México): «Venció hace 3 días» · «Vence hoy» · «Vence mañana» · «Vence en 5 días»;
 * cerrado: «Cumplido el 24 nov» · «Cancelado el 24 nov».
 */
export function plazoEnPalabras(a: Pick<AcuerdoVista, 'situacion' | 'due_date' | 'closed_at'>, hoy: string): string {
  if (a.situacion === 'cumplido' || a.situacion === 'cancelado') {
    const dia = a.closed_at ? ` el ${diaCorto(fechaMx(a.closed_at))}` : '';
    return `${a.situacion === 'cumplido' ? 'Cumplido' : 'Cancelado'}${dia}`;
  }
  const rel = relativo(a.due_date, hoy);
  if (a.situacion === 'vencido') return `Venció ${rel}`;
  return `Vence ${rel}`;
}

/**
 * El plazo en palabras SÓLO si agrega algo a la etiqueta de la situación: «Vence hoy» junto a la etiqueta «Vence hoy» se
 * leía dos veces (lo encontró la prueba visual). «Venció hace 3 días» sí agrega los días; «Cumplido el 26 nov», la fecha.
 */
export function plazoAparte(a: Pick<AcuerdoVista, 'situacion' | 'due_date' | 'closed_at'>, hoy: string): string | null {
  const p = plazoEnPalabras(a, hoy);
  return p.toLowerCase() === ETIQUETA_SITUACION_ACUERDO[a.situacion].toLowerCase() ? null : p;
}

/**
 * Quién responde. Del proveedor: su persona, y quién lo sigue en la Suite (DC43). De Mega Dulces: el responsable.
 */
export function responsableEnPalabras(a: Pick<AcuerdoVista, 'area' | 'supplier_contact' | 'assigned_to'>): { quien: string; sub: string | null } {
  if (a.area === 'supplier') return { quien: `${a.supplier_contact ?? 'Proveedor'} (proveedor)`, sub: `Lo sigue ${a.assigned_to.nombre}` };
  return { quien: a.assigned_to.nombre, sub: null };
}

/** El proveedor por su nombre; sin ficha, por su clave (no se inventa un nombre). */
export const proveedorDelAcuerdo = (a: Pick<AcuerdoVista, 'supplier_name' | 'supplier_code'>) => a.supplier_name || `Clave ${a.supplier_code}`;

/**
 * La respuesta de arriba (Q.1): lo que pide atención hoy, y el total abierto. Sin abiertos lo dice; con la lista topada,
 * también (lo que no llegó no se cuenta como cero).
 */
export function respuestaAcuerdos(l: ListaAcuerdos): string {
  const { total, por_situacion: s } = l.abiertos;
  if (!total) return l.cerrados.total ? 'No hay acuerdos abiertos: todos están cumplidos o cancelados.' : 'Todavía no hay acuerdos capturados.';
  const frases: string[] = [];
  if (s.vencido) frases.push(`${plural(s.vencido, 'acuerdo venció', 'acuerdos vencieron')} sin cumplirse`);
  if (s.vence_hoy) frases.push(`${plural(s.vence_hoy, 'vence', 'vencen')} hoy`);
  if (s.esta_semana) frases.push(`${plural(s.esta_semana, 'vence', 'vencen')} esta semana`);
  const cabeza = frases.length ? `${frases.join(', ').replace(/^./, (c) => c.toUpperCase())}.` : 'Ningún acuerdo vence esta semana.';
  return `${cabeza} ${plural(total, 'acuerdo abierto', 'acuerdos abiertos')} en total.`;
}

export type VistaAcuerdos = 'abiertos' | 'cerrados';
export type DeQuien = 'todos' | 'mios';

export interface FiltroAcuerdos {
  readonly vista: VistaAcuerdos;
  readonly de: DeQuien;
  /** `null` = todas las áreas. */
  readonly area: AreaAcuerdo | null;
  /** `null` = todas las situaciones (los mosaicos de arriba filtran por una). */
  readonly situacion: SituacionAcuerdo | null;
  readonly q: string;
  /** El id de quien mira (de la sesión). */
  readonly yo: string | null;
}

/** Los campos donde busca el buscador común (`[BU]`): lo acordado, proveedor, clave, responsable y la persona del proveedor. */
const campos = (a: AcuerdoVista) => [a.description, a.supplier_name, a.supplier_code, a.assigned_to.nombre, a.supplier_contact, ETIQUETA_AREA_ACUERDO[a.area]];

const esMio = (a: AcuerdoVista, yo: string | null) => !!yo && a.assigned_to.user_id.toLowerCase() === yo.toLowerCase();

/** La lista de la vista elegida, filtrada. La lista llega ENTERA (hasta su tope declarado): filtrar aquí no pierde filas. */
export function filtrarAcuerdos(l: ListaAcuerdos, f: FiltroAcuerdos): AcuerdoVista[] {
  const base = f.vista === 'abiertos' ? l.abiertos.acuerdos : l.cerrados.acuerdos;
  const xs = base.filter((a) => (f.de === 'todos' || esMio(a, f.yo))
    && (!f.area || a.area === f.area)
    && (!f.situacion || a.situacion === f.situacion));
  return filtrarPorBusqueda(xs, f.q, campos);
}

/** Cuántos de la vista son de quien mira (para el conteo del filtro «Míos»). */
export function cuantosMios(l: ListaAcuerdos, vista: VistaAcuerdos, yo: string | null): number {
  return (vista === 'abiertos' ? l.abiertos.acuerdos : l.cerrados.acuerdos).filter((a) => esMio(a, yo)).length;
}

/** Cuántos hay por área en la vista (para las opciones del filtro, con su conteo). */
export function conteoPorArea(xs: readonly AcuerdoVista[]): Readonly<Record<AreaAcuerdo, number>> {
  const c: Record<AreaAcuerdo, number> = { compras: 0, marketing: 0, finanzas: 0, direccion: 0, supplier: 0 };
  for (const a of xs) c[a.area] += 1;
  return c;
}

/** Un acuerdo para editar: el mismo payload que capturar. */
export function dtoDeAcuerdo(a: AcuerdoVista): CapturarAcuerdoDto {
  return {
    area: a.area, description: a.description, due_date: a.due_date,
    assigned_to: a.area === 'supplier' ? null : a.assigned_to.user_id,
    supplier_contact: a.area === 'supplier' ? a.supplier_contact : null,
  };
}

/**
 * Lo que falta para poder guardar, en una frase (o `null`). Es un aviso ANTES de mandar: la API vuelve a revisar todo y
 * su mensaje es el que manda.
 */
export function faltaAcuerdo(dto: Partial<CapturarAcuerdoDto>): string | null {
  if (!dto.area) return 'Elige de qué área es el acuerdo.';
  const d = (dto.description ?? '').trim();
  if (!d) return 'Escribe qué se acordó.';
  if (d.length > MAX_DESCRIPCION_ACUERDO) return `Lo acordado, máximo ${MAX_DESCRIPCION_ACUERDO} caracteres.`;
  if (dto.area === 'supplier') {
    const c = (dto.supplier_contact ?? '').trim();
    if (!c) return 'Escribe quién del proveedor se comprometió.';
    if (c.length > MAX_CONTACTO_PROVEEDOR) return `El nombre, máximo ${MAX_CONTACTO_PROVEEDOR} caracteres.`;
  } else if (!dto.assigned_to) {
    return 'Elige quién de Mega Dulces es responsable.';
  }
  if (!dto.due_date) return 'Elige la fecha compromiso.';
  return null;
}
