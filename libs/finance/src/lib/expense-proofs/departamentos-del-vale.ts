/**
 * `[GX.98]` — **El departamento del que viene cada gasto: el de Kepler, no el capturado.**
 *
 * ## El defecto
 * La barra «Por departamento» de Aprobación agrupaba por `finance.expense_proofs.departamento`.
 * Medido en prod el 2026-11-06: los **1,672 vales** dicen `Sucursal NN` — la captura nunca pregunta
 * el departamento y `create()` rellena con la plaza. O sea que «por departamento» era «por sucursal»
 * con otro nombre.
 *
 * ## La fuente
 * Los renglones de la solicitud `X-A-15` en `kepler_ods.kdm6`: `c16` = departamento (catálogo
 * `kdc3`: `c1` código → `c2` nombre), `c11` = importe del renglón (ERP_KEPLER §3.y.2). Medido el
 * mismo día:
 *  · 1,655 de 1,672 vales tienen departamento; los 41 códigos se traducen a nombre y significan
 *    lo mismo en todas las sucursales.
 *  · 1,293 tienen UNO; **355 lo reparten entre 2 o más** (hasta 26).
 *  · Los renglones suman el importe en 1,162; en 458 suman **sin IVA** (×1.16 cuadra) y en 45 no
 *    cuadran. Por eso la parte de cada departamento sale de la PROPORCIÓN de sus renglones aplicada
 *    al importe del vale, nunca del renglón a secas.
 *
 * ## Decisión del usuario (2026-11-06)
 * Un vale repartido aparece **en cada uno de sus departamentos, con su parte** («$500 de $1,250»).
 * Las partes suman exactamente el importe del vale: los totales por grupo cuadran con el total.
 *
 * Vive aparte del servicio, sin knex: es lo que decide qué ve quien firma, y se prueba sin base.
 */
import type { GrupoAprobacion } from './aprobacion-agrupar';

/** Un departamento del vale, con la parte del importe que le toca. */
export interface DepartamentoDelVale {
  clave: string;
  /** Nombre de `kdc3`. `null` = el código no está en el catálogo (se muestra la clave). */
  nombre: string | null;
  importe: number;
}

/** Lo que trae Kepler por departamento: la suma de sus renglones (con o sin IVA, da igual). */
export interface RenglonesDeDepartamento {
  clave: string;
  nombre: string | null;
  importe: number;
}

/** El nombre de Kepler sin el punto final que traen casi todos («MORELIA ABASTOS.»). */
export function nombreDeDepartamento(nombre: string | null | undefined): string | null {
  const n = String(nombre ?? '').replace(/[\s.]+$/, '').trim();
  return n || null;
}

const centavos = (n: number) => Math.round(n * 100);

/**
 * Reparte el importe del vale entre sus departamentos en proporción a sus renglones.
 * ⭐ Las partes suman EXACTAMENTE el importe (al centavo), por residuo mayor. Con renglones en cero (o negativos) se reparte parejo.
 * Sin departamentos devuelve `[]` — «no tiene en Kepler», que la pantalla dice.
 */
export function repartirPorDepartamento(renglones: readonly RenglonesDeDepartamento[], importeVale: number): DepartamentoDelVale[] {
  const porClave = new Map<string, RenglonesDeDepartamento>();
  for (const r of renglones) {
    const clave = String(r.clave ?? '').trim();
    if (!clave) continue;
    const prev = porClave.get(clave);
    porClave.set(clave, { clave, nombre: nombreDeDepartamento(prev?.nombre ?? r.nombre), importe: (prev?.importe ?? 0) + (Number(r.importe) || 0) });
  }
  const deps = [...porClave.values()].sort((a, b) => b.importe - a.importe || a.clave.localeCompare(b.clave));
  if (!deps.length) return [];
  const total = deps.reduce((s, d) => s + Math.max(0, d.importe), 0);
  const totalCts = centavos(Number(importeVale) || 0);
  const exactas = deps.map((d) => total > 0 ? totalCts * Math.max(0, d.importe) / total : totalCts / deps.length);
  const partes = exactas.map((x) => Math.floor(x));
  // Residuo mayor: cada centavo que el redondeo dejó fuera va a la parte que más perdió al
  // redondear (en empate, a la de más dinero). Así la suma cuadra al centavo y nadie gana de más.
  const orden = exactas.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((p, q) => q.r - p.r || p.i - q.i);
  for (let k = 0, falta = totalCts - partes.reduce((t, p) => t + p, 0); k < orden.length && falta > 0; k++, falta--) partes[orden[k].i] += 1;
  return deps.map((d, i) => ({ clave: d.clave, nombre: d.nombre, importe: partes[i] / 100 }));
}

/** La clave del grupo de los vales sin departamento en Kepler. */
export const SIN_DEPARTAMENTO = 'sin-departamento';

export interface ValeParaAgrupar {
  id: string;
  importe: number;
  /** `null` = no se pudo leer Kepler; `[]` = Kepler no le tiene departamento. Los dos van aparte. */
  departamentos: readonly DepartamentoDelVale[] | null;
}

/**
 * Los grupos de la barra. Un vale repartido entra en CADA uno de sus departamentos con su parte:
 * `n` cuenta vales (uno puede contar en varios grupos) y `monto` suma partes (las partes de todos
 * los grupos suman el total de la lista). Ordenados por monto; «sin departamento» al final.
 */
export function agruparPorDepartamento(vales: readonly ValeParaAgrupar[]): GrupoAprobacion[] {
  const grupos = new Map<string, GrupoAprobacion>();
  const sumar = (clave: string, etiqueta: string, origen: GrupoAprobacion['origen'], id: string, monto: number) => {
    let g = grupos.get(clave);
    if (!g) { g = { clave, etiqueta, origen, n: 0, monto: 0, ids: [] }; grupos.set(clave, g); }
    if (!g.ids.includes(id)) { g.ids.push(id); g.n += 1; }
    g.monto = Math.round((g.monto + monto) * 100) / 100;
  };
  for (const v of vales) {
    if (!v.departamentos?.length) {
      sumar(SIN_DEPARTAMENTO, v.departamentos === null ? 'Sin leer en Kepler' : 'Sin departamento en Kepler', 'sin_clasificar', v.id, Number(v.importe) || 0);
      continue;
    }
    for (const d of v.departamentos) sumar(`dep:${d.clave}`, d.nombre ?? d.clave, 'kepler', v.id, d.importe);
  }
  return [...grupos.values()].sort((a, b) => {
    if (a.clave === SIN_DEPARTAMENTO) return 1;
    if (b.clave === SIN_DEPARTAMENTO) return -1;
    return b.monto - a.monto || a.etiqueta.localeCompare(b.etiqueta, 'es');
  });
}
