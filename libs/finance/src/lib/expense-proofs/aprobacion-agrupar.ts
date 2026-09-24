/**
 * `[GX.17]` — **Agrupar lo que espera luz verde.** Función pura.
 *
 * La pantalla de Aprobación no es una lista: quien autoriza no revisa 40 renglones sueltos,
 * revisa «lo del martes de Logística». Por eso el servicio devuelve los expedientes ya
 * agrupados por **fecha** y por **departamento**, y la pantalla sólo elige cuál de las dos
 * mira.
 *
 * Vive aparte del servicio, sin knex, porque es la parte que decide **qué se le muestra a
 * quien firma** — y eso se prueba sin levantar una base.
 *
 * ## ⚠️ El departamento no siempre existe, y no se inventa
 * `finance.expense_proofs.departamento` se llena al capturar, y cuando el capturista no lo
 * puso, `create()` guarda `Sucursal NN` — que no es un departamento, es una plaza. Y la
 * solicitud de Kepler trae otra cosa: `solicitante`, que es el área de gasto.
 *
 * Acá se elige en ese orden (departamento capturado → solicitante de Kepler → sin
 * clasificar) y **se declara cuál se usó** en `origen`. Mezclarlos en una sola etiqueta sin
 * decirlo haría que «Sucursal 00» y «LOGISTICA» convivan como si fueran lo mismo.
 */

/** Lo que la agrupación necesita de cada expediente. Nada más. */
export interface ExpedientePendiente {
  id: string;
  folio_solicitud: string;
  sucursal: string | null;
  /** Fecha del gasto (ISO `YYYY-MM-DD`); si falta, se cae a la de captura. */
  fecha_gasto: string | null;
  created_at: string;
  importe: number;
  /** Lo que capturó quien subió el expediente. Puede venir como `Sucursal NN`. */
  departamento: string | null;
  /** El área de gasto de la solicitud de Kepler. */
  solicitante: string | null;
  proveedor: string | null;
  clasificacion: string | null;
  forma_pago: string | null;
  /** ¿Trae al menos una foto con sello de cámara? (GX.14) */
  evidencia_en_vivo: boolean;
}

export type OrigenDepartamento = 'capturado' | 'solicitud' | 'sin_clasificar';

export interface GrupoAprobacion {
  clave: string;
  etiqueta: string;
  /** Sólo en los grupos por departamento: de dónde salió la etiqueta. */
  origen?: OrigenDepartamento;
  n: number;
  monto: number;
  ids: string[];
}

export interface AgrupadoAprobacion {
  total: number;
  monto_total: number;
  por_fecha: GrupoAprobacion[];
  por_departamento: GrupoAprobacion[];
}

/** La fecha con la que se agrupa: la del gasto, y si falta, la de captura. */
export function fechaDeAgrupacion(e: ExpedientePendiente): string {
  const f = (e.fecha_gasto ?? '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(f)) return f;
  return String(e.created_at ?? '').slice(0, 10) || 'sin_fecha';
}

/**
 * El departamento con el que se agrupa, y **de dónde salió**.
 *
 * `Sucursal NN` cuenta como capturado aunque sea una plaza: es lo que la persona puso, y
 * corregirlo acá sería inventar. Lo que sí se hace es marcarlo, para que la pantalla pueda
 * decir que ese grupo no es un departamento de verdad.
 */
export function departamentoDeAgrupacion(e: ExpedientePendiente): { etiqueta: string; origen: OrigenDepartamento } {
  const dep = String(e.departamento ?? '').trim();
  if (dep) return { etiqueta: dep, origen: 'capturado' };
  const sol = String(e.solicitante ?? '').trim();
  if (sol) return { etiqueta: sol, origen: 'solicitud' };
  return { etiqueta: 'Sin clasificar', origen: 'sin_clasificar' };
}

/** Suma dentro de un mapa de grupos, conservando el orden de aparición. */
function acumular(
  mapa: Map<string, GrupoAprobacion>,
  clave: string,
  etiqueta: string,
  e: ExpedientePendiente,
  origen?: OrigenDepartamento,
): void {
  const g = mapa.get(clave) ?? { clave, etiqueta, ...(origen ? { origen } : {}), n: 0, monto: 0, ids: [] };
  g.n += 1;
  g.monto += Number(e.importe) || 0;
  g.ids.push(e.id);
  mapa.set(clave, g);
}

/**
 * Agrupa los pendientes por fecha (descendente: lo más nuevo primero) y por departamento
 * (descendente por monto: lo que más pesa, arriba).
 *
 * ⚠️ El monto se redondea al final de cada grupo, no en cada suma: redondear en cada paso
 * corre el total unos centavos y quien firma ve una cifra que no cuadra con la suma de sus
 * renglones.
 */
export function agruparParaAprobacion(pendientes: readonly ExpedientePendiente[]): AgrupadoAprobacion {
  const lista = pendientes ?? [];
  const fechas = new Map<string, GrupoAprobacion>();
  const deptos = new Map<string, GrupoAprobacion>();

  for (const e of lista) {
    const f = fechaDeAgrupacion(e);
    acumular(fechas, f, f, e);
    const d = departamentoDeAgrupacion(e);
    acumular(deptos, d.etiqueta.toUpperCase(), d.etiqueta, e, d.origen);
  }

  const redondear = (g: GrupoAprobacion): GrupoAprobacion => ({ ...g, monto: Math.round(g.monto * 100) / 100 });

  return {
    total: lista.length,
    monto_total: Math.round(lista.reduce((a, e) => a + (Number(e.importe) || 0), 0) * 100) / 100,
    // Lo más reciente primero: es lo que se firma hoy.
    por_fecha: [...fechas.values()].map(redondear).sort((a, b) => b.clave.localeCompare(a.clave)),
    // Por monto: quien firma decide dónde mirar primero, y el dinero es el criterio.
    por_departamento: [...deptos.values()].map(redondear).sort((a, b) => b.monto - a.monto),
  };
}
