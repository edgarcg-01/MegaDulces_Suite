import type { HrPersonaAsistencia } from '@megadulces/contracts';
import { SIN_DEPARTAMENTO, departamentoDe } from './reporte-formato';

/**
 * `[RH.13.5]` «Personas»: toda la plaza, uno o varios departamentos, personas sueltas o una sola (David, 12-nov:
 * «aquí es plaza y personas también»). Es el campo de Mega Talento (`asistencia-resumen.ts`, 06/10/2026), que
 * reemplazó los chips de «Secciones»: elegir un departamento entero es lo mismo que marcar a todos los suyos.
 *
 * Se guardan DOS cosas y no una lista de códigos: el departamento elegido entero sigue entero aunque la semana
 * siguiente traiga a alguien nuevo en él. Lo suelto se guarda por código, y se borra al cambiar de plaza (los
 * números se repiten entre plazas: el #112 de aquí no es el #112 de allá).
 */
export interface SeleccionPersonas { departamentos: string[]; elegidas: string[]; }

export interface OpcionPersonas {
  /** `d:<DEPARTAMENTO>` o `p:<código>`: una sola lista, para que el teclado y la búsqueda alcancen las dos. */
  value: string;
  label: string;
  tipo: 'depto' | 'persona';
  codigo?: string;
  n?: number;
}

const D = 'd:';
const P = 'p:';
const nombre = (p: HrPersonaAsistencia) => p.nombreCompleto || p.nombre || `#${p.codigo}`;

function miembros(personas: HrPersonaAsistencia[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const p of personas) {
    const d = departamentoDe(p);
    m.set(d, [...(m.get(d) ?? []), p.codigo]);
  }
  return m;
}

/** Cada departamento seguido de su gente, en el orden de la tabla (alfabético, «SIN DEPARTAMENTO» al final). */
export function opcionesPersonas(personas: HrPersonaAsistencia[]): OpcionPersonas[] {
  const grupos = new Map<string, HrPersonaAsistencia[]>();
  for (const p of personas) grupos.set(departamentoDe(p), [...(grupos.get(departamentoDe(p)) ?? []), p]);
  const orden = [...grupos.keys()].sort((a, b) => (a === SIN_DEPARTAMENTO ? 1 : b === SIN_DEPARTAMENTO ? -1 : a.localeCompare(b)));
  const out: OpcionPersonas[] = [];
  for (const d of orden) {
    const gente = (grupos.get(d) ?? []).slice().sort((a, b) => nombre(a).localeCompare(nombre(b)));
    out.push({ value: D + d, label: d, tipo: 'depto', n: gente.length });
    for (const p of gente) out.push({ value: P + p.codigo, label: nombre(p), tipo: 'persona', codigo: p.codigo });
  }
  return out;
}

/** Los códigos que la selección cubre HOY (departamentos enteros + sueltas que siguen en la plaza). */
export function cubiertas(personas: HrPersonaAsistencia[], s: SeleccionPersonas): Set<string> {
  const deps = new Set(s.departamentos);
  const sueltas = new Set(s.elegidas);
  return new Set(personas.filter((p) => deps.has(departamentoDe(p)) || sueltas.has(p.codigo)).map((p) => p.codigo));
}

export function haySeleccion(s: SeleccionPersonas): boolean {
  return s.departamentos.length > 0 || s.elegidas.length > 0;
}

/** Lo que el campo marca: el departamento entero y, con él, a cada uno de los suyos. */
export function valorSeleccion(personas: HrPersonaAsistencia[], s: SeleccionPersonas): string[] {
  return [...s.departamentos.map((d) => D + d), ...[...cubiertas(personas, s)].map((c) => P + c)];
}

/**
 * Traduce un cambio del campo a la selección. Marcar un departamento lo elige entero; desmarcar a alguien de un
 * departamento entero lo vuelve «todos menos él»; marcar a todos los de un departamento (de dos o más) lo vuelve
 * el departamento. Con uno solo no se promueve: «Ventas» en vez del nombre escondería que es una persona.
 */
export function aplicarCambio(personas: HrPersonaAsistencia[], antes: SeleccionPersonas, nuevo: string[]): SeleccionPersonas {
  const prev = new Set(valorSeleccion(personas, antes));
  const next = new Set(nuevo ?? []);
  const deps = new Set(antes.departamentos);
  const sueltas = new Set(antes.elegidas);
  const gente = miembros(personas);
  const deptoDe = new Map(personas.map((p) => [p.codigo, departamentoDe(p)]));

  for (const v of next) {
    if (prev.has(v)) continue;
    if (v.startsWith(D)) {
      const d = v.slice(D.length);
      deps.add(d);
      for (const c of gente.get(d) ?? []) sueltas.delete(c);
    } else if (v.startsWith(P)) {
      const c = v.slice(P.length);
      if (!deps.has(deptoDe.get(c) ?? '')) sueltas.add(c);
    }
  }
  for (const v of prev) {
    if (next.has(v)) continue;
    if (v.startsWith(D)) {
      deps.delete(v.slice(D.length));
    } else if (v.startsWith(P)) {
      const c = v.slice(P.length);
      const d = deptoDe.get(c) ?? '';
      if (deps.has(d)) {
        deps.delete(d);
        for (const x of gente.get(d) ?? []) if (x !== c) sueltas.add(x);
      } else {
        sueltas.delete(c);
      }
    }
  }
  for (const [d, cs] of gente) {
    if (!deps.has(d) && cs.length > 1 && cs.every((c) => sueltas.has(c))) {
      deps.add(d);
      for (const c of cs) sueltas.delete(c);
    }
  }
  return { departamentos: [...deps].sort(), elegidas: [...sueltas] };
}

/** La persona sola, cuando lo elegido cubre exactamente a una: su tabla día por día. */
export function personaUnica(personas: HrPersonaAsistencia[], s: SeleccionPersonas): HrPersonaAsistencia | null {
  if (!haySeleccion(s)) return null;
  const c = cubiertas(personas, s);
  if (c.size !== 1) return null;
  const [cod] = [...c];
  return personas.find((p) => p.codigo === cod) ?? null;
}

/** Lo que dice el campo cerrado. Vacío = toda la plaza (lo dice el placeholder). */
export function etiquetaPersonas(personas: HrPersonaAsistencia[], s: SeleccionPersonas): string {
  if (!haySeleccion(s)) return '';
  const uno = personaUnica(personas, s);
  if (uno) return nombre(uno);
  const n = cubiertas(personas, s).size;
  if (!s.elegidas.length) return s.departamentos.length <= 3 ? s.departamentos.join(' + ') : `${s.departamentos.length} departamentos`;
  return `${n} personas`;
}
