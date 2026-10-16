import type { RespuestaHistoriaPrecio } from '@megadulces/contracts';

/**
 * `[CAT-PRECIO.4]` La gráfica de UN precio: una ESCALERA, no una línea. Un precio no «pasa» de $18 a
 * $20 en tres días: vale $18 hasta el día del cambio y $20 desde ese día. Unir los puntos con
 * diagonales dibujaría precios que nunca se cobraron.
 */
export interface PuntoPrecio {
  /** `YYYY-MM-DD`. */
  fecha: string;
  precio: number;
}

export interface GraficaPrecio {
  /** Atributo `d` del `<path>` (escalera). Vacío = no hay con qué dibujar. */
  d: string;
  puntos: { x: number; y: number; fecha: string; precio: number }[];
  min: number;
  max: number;
  desde: string | null;
  hasta: string | null;
}

const dia = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/**
 * Los escalones en orden cronológico: arranca con el precio ANTERIOR al primer cambio (el que regía
 * entonces), sigue con el nuevo de cada cambio, y termina hoy con el precio vigente de la ficha.
 */
export function serieHistoria(r: RespuestaHistoriaPrecio, hoy: string): PuntoPrecio[] {
  const asc = [...r.cambios].reverse();
  const serie: PuntoPrecio[] = [];
  if (asc.length) serie.push({ fecha: asc[0].fecha, precio: asc[0].anterior });
  for (const c of asc) serie.push({ fecha: c.fecha, precio: c.nuevo });
  const ultimo = serie[serie.length - 1];
  if (r.precio_actual !== null && (!ultimo || ultimo.fecha < hoy)) serie.push({ fecha: hoy, precio: r.precio_actual });
  return serie;
}

export function graficaPrecio(serie: PuntoPrecio[], ancho = 640, alto = 180, margen = 10): GraficaPrecio {
  if (serie.length < 2) return { d: '', puntos: [], min: 0, max: 0, desde: serie[0]?.fecha ?? null, hasta: serie[0]?.fecha ?? null };
  const precios = serie.map((p) => p.precio);
  const min = Math.min(...precios);
  const max = Math.max(...precios);
  const x0 = dia(serie[0].fecha);
  const x1 = dia(serie[serie.length - 1].fecha);
  const sx = (f: string) => margen + ((dia(f) - x0) / Math.max(x1 - x0, 1)) * (ancho - 2 * margen);
  // Un precio que nunca cambió se dibuja a media altura, no pegado a un borde.
  const sy = (p: number) => (max === min ? alto / 2 : alto - margen - ((p - min) / (max - min)) * (alto - 2 * margen));
  const puntos = serie.map((p) => ({ x: sx(p.fecha), y: sy(p.precio), fecha: p.fecha, precio: p.precio }));
  let d = `M${puntos[0].x.toFixed(1)},${puntos[0].y.toFixed(1)}`;
  for (let i = 1; i < puntos.length; i++) {
    d += ` H${puntos[i].x.toFixed(1)} V${puntos[i].y.toFixed(1)}`;
  }
  return { d, puntos, min, max, desde: serie[0].fecha, hasta: serie[serie.length - 1].fecha };
}
