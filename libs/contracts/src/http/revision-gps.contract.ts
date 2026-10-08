// EMB.21 — Lo capturado en la guía, revisado contra el GPS cuando el viaje termina.
//
// Hora de salida, hora de llegada y kilómetros NO existen en Kepler (medido en prod el
// 2026-10-08: ninguna de las columnas del embarque U-D-41 los guarda). Se capturan al tomar el
// viaje — de ellos salen los viáticos — y, cuando la unidad regresa, el GPS de la flota los revisa.
// El GPS no los reemplaza: medido en 70 viajes con rastreador, sólo 2 de cada 3 se reconstruyen
// completos (unos no regresan en 48 h, otros traen el odómetro roto). Lo que no se puede medir se
// DECLARA con su motivo, nunca se pinta como «coincide» (ADR-056).
//
// La diferencia que importa es la que mueve dinero: si con el horario del GPS los viáticos
// cambian, se marca, aunque la hora sólo se haya movido unos minutos (cruzar las 7:00 cambia el
// desayuno). Las tolerancias de hora y kilómetros son de criterio, y por eso están a la vista.

import type { PersonaGuia, TarifasViatico } from './viaticos-guia.contract';
import { COMIDAS_VIATICO, ETIQUETA_COMIDA, horaAMinutos, viaticosDeLaGuia } from './viaticos-guia.contract';

/** Una hora capturada y la del GPS se consideran la misma si no se separan más que esto. */
export const TOLERANCIA_MINUTOS = 60;
/** Kilómetros capturados contra los del GPS: diferencia relativa tolerada. */
export const TOLERANCIA_KM = 0.2;

export type RevisionGpsEstado = 'coincide' | 'difiere' | 'no_medible' | 'en_curso';

/** Por qué no se pudo revisar. Cada uno tiene su frase en `MOTIVO_NO_MEDIBLE`. */
export type MotivoNoMedible =
  | 'sin_guia' | 'embarque_manual' | 'sin_unidad' | 'sin_gps' | 'origen_sin_coordenadas'
  | 'sin_puntos' | 'nunca_en_origen' | 'no_sale' | 'no_regresa' | 'en_curso';

export const MOTIVO_NO_MEDIBLE: Readonly<Record<MotivoNoMedible, string>> = {
  sin_guia: 'El embarque no tiene guía.',
  embarque_manual: 'El embarque no viene de Kepler: no se sabe de qué sucursal salió la unidad.',
  sin_unidad: 'El embarque no tiene unidad asignada.',
  sin_gps: 'La unidad no tiene rastreador GPS.',
  origen_sin_coordenadas: 'La sucursal de salida no tiene coordenadas registradas.',
  sin_puntos: 'El GPS no registró posiciones de la unidad en esos días.',
  nunca_en_origen: 'El GPS no muestra la unidad en la sucursal de salida.',
  no_sale: 'El GPS no muestra que la unidad saliera de la sucursal después de cargar.',
  no_regresa: 'El GPS no muestra que la unidad regresara a la sucursal en 48 horas.',
  en_curso: 'El viaje sigue en curso: se revisa cuando la unidad regrese.',
};

/** Lo que el coordinador capturó en la guía. Horas `HH:MM`. */
export interface ViajeCapturado {
  salida: string | null;
  llegada: string | null;
  duerme_fuera: boolean;
  km: number | null;
  viaticos: number | null;
}

/** El viaje como lo reconstruye el GPS. Horas `HH:MM` en hora de México. */
export interface ViajeGps {
  salida: string;
  llegada: string;
  /** Regresó otro día que el de la salida. */
  duerme_fuera: boolean;
  km: number | null;
  /** De dónde salen los km: el odómetro de la unidad, o la suma del trazo cuando el odómetro no es creíble. */
  km_metodo: 'odometro' | 'trazo' | null;
  puntos: number;
}

export interface RevisionGps {
  estado: RevisionGpsEstado;
  /** Por qué no se pudo revisar (estado `no_medible` o `en_curso`). */
  motivo: string | null;
  capturado: ViajeCapturado | null;
  gps: (ViajeGps & { viaticos: number | null }) | null;
  /** Cada diferencia, en una frase. Vacío si coincide. */
  diferencias: string[];
  tolerancias: { minutos: number; km: number };
}

/** Minutos entre dos horas del día, por el lado corto del reloj (23:30 y 00:30 están a 60). */
export function minutosEntre(a: string | null, b: string | null): number | null {
  const x = horaAMinutos(a);
  const y = horaAMinutos(b);
  if (x == null || y == null) return null;
  const d = Math.abs(x - y);
  return Math.min(d, 1440 - d);
}

const dinero = (v: number) => `$${v.toFixed(2)}`;
const duracion = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min` : `${min} min`);

/**
 * Compara lo capturado contra el GPS. Sólo tiene sentido con un viaje GPS completo y un horario
 * capturado; los viáticos del GPS se calculan con las MISMAS tarifas y las mismas personas.
 */
export function compararConGps(
  cap: ViajeCapturado,
  gps: ViajeGps,
  tarifas: TarifasViatico,
  va: Record<PersonaGuia, boolean>,
): { estado: 'coincide' | 'difiere'; diferencias: string[]; viaticos_gps: number } {
  const dif: string[] = [];
  const salida = minutosEntre(cap.salida, gps.salida);
  if (salida != null && salida > TOLERANCIA_MINUTOS) {
    dif.push(`Salida: se capturó ${cap.salida} y el GPS marca ${gps.salida} (${duracion(salida)} de diferencia).`);
  }
  const llegada = minutosEntre(cap.llegada, gps.llegada);
  if (llegada != null && llegada > TOLERANCIA_MINUTOS) {
    dif.push(`Llegada: se capturó ${cap.llegada} y el GPS marca ${gps.llegada} (${duracion(llegada)} de diferencia).`);
  }
  if (cap.duerme_fuera !== gps.duerme_fuera) {
    dif.push(gps.duerme_fuera
      ? 'Según el GPS la unidad regresó otro día, y la guía dice que no durmió fuera.'
      : 'La guía dice que durmió fuera, y según el GPS la unidad regresó el mismo día.');
  }
  if (cap.km != null && cap.km > 0 && gps.km != null && gps.km > 0 && Math.abs(cap.km - gps.km) / gps.km > TOLERANCIA_KM) {
    dif.push(`Kilómetros: se capturaron ${cap.km} y el GPS marca ${gps.km}.`);
  }
  // Lo que mueve dinero: los viáticos con el horario del GPS.
  const conGps = viaticosDeLaGuia({ salida: gps.salida, llegada: gps.llegada, duerme_fuera: gps.duerme_fuera }, tarifas, va);
  const capturados = viaticosDeLaGuia({ salida: cap.salida, llegada: cap.llegada, duerme_fuera: cap.duerme_fuera }, tarifas, va);
  const cambian = COMIDAS_VIATICO.filter((m) => conGps.comidas[m] !== capturados.comidas[m]);
  if (cambian.length) {
    dif.push(`Viáticos: con el horario del GPS serían ${dinero(conGps.total)} en vez de ${dinero(capturados.total)} (cambia ${cambian.map((m) => ETIQUETA_COMIDA[m].toLowerCase()).join(', ')}).`);
  }
  return { estado: dif.length ? 'difiere' : 'coincide', diferencias: dif, viaticos_gps: conGps.total };
}
