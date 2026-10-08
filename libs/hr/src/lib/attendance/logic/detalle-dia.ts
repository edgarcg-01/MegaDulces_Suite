import * as hd from './horario-deducido';

/**
 * Fase RH · `[RH.1.5]` — la comida, las horas netas y el desayuno de UN día. Copia textual de
 * `detalleDia` en `mega-talento-90/api/src/agente-horarios/asistencia-personas.ts` @ 5ca5f2a.
 *
 * La primera y la última marca son la jornada; las de en medio son salidas y regresos, y lo
 * que se descuenta es el tiempo FUERA, DE A PARES (no del primero al último: con seis marcas
 * —desayuno y comida en oficinas— la regla vieja le descontaba media jornada a una persona de oficinas).
 * Una marca de en medio SIN pareja no se descuenta: no se sabe si salió y no regresó o si el
 * lector no leyó el regreso.
 *
 * El desayuno es la PRIMERA pausa emparejada que empieza antes del corte, con el mismo techo
 * de plausibilidad que `reglas.ts::reglaDesayunoExcedido`: si las dos dejaran de coincidir, la
 * pantalla y la alerta dirían cosas distintas del mismo día.
 *
 * ══ EL DESAYUNO DE CORPORATIVO NO SE DESCUENTA (25/09/2026) ══
 * Se "paga" sólo si el día trae OTRA pausa emparejada además de él. Con una sola pausa no se
 * sabe cuál de las dos fue, y se descuenta. Lo que excede el tope NO se descuenta aquí: se ve
 * como exceso (columna y alerta); descontarlo en silencio cobraría dos veces la misma falta.
 */
export interface DetalleDia {
  comida: string;
  netasMin: number | null;
  brutasMin: number | null;
  desayunoMin: number | null;
  desayunoExcesoMin: number | null;
  /** El desayuno se contó como trabajado (no se descontó de las netas). */
  desayunoPagado: boolean;
  /** Minutos de pausa que NO son el desayuno (la comida), o null si no hubo. */
  comidaMin: number | null;
  /** Primera y última marca del día, en minutos (la jornada). */
  entradaMin: number | null;
  salidaMin: number | null;
}

export interface ConfigDesayuno {
  topeMin: number;
  hastaMin: number;
  maxPlausibleMin: number;
  cuentaComoJornada: boolean;
}

export function detalleDia(marcasCrudas: string[], desayuno?: ConfigDesayuno): DetalleDia {
  const vacio: DetalleDia = {
    comida: '—', netasMin: null, brutasMin: null, desayunoMin: null, desayunoExcesoMin: null,
    desayunoPagado: false, comidaMin: null, entradaMin: null, salidaMin: null,
  };
  const mins = hd.colapsarDuplicadas(
    marcasCrudas.map((x) => hd.aMinutos(x)).filter((x): x is number => x !== null),
  );
  if (mins.length < 2) return vacio;
  const brutas = mins[mins.length - 1] - mins[0];
  const medio = mins.slice(1, -1);

  const tramos: string[] = [];
  let fuera = 0;
  let desayunoMin: number | null = null;
  let pausas = 0;
  for (let i = 0; i < medio.length; i += 2) {
    if (i + 1 < medio.length) {
      tramos.push(`${hd.aHora(medio[i])} – ${hd.aHora(medio[i + 1])}`);
      fuera += medio[i + 1] - medio[i];
      pausas++;
      if (desayuno && desayunoMin == null && medio[i] < desayuno.hastaMin) {
        const dur = medio[i + 1] - medio[i];
        if (dur <= desayuno.maxPlausibleMin) desayunoMin = dur;
      }
    } else {
      // Impar: la última salida no tiene regreso. Se enseña, no se descuenta.
      tramos.push(hd.aHora(medio[i]) as string);
    }
  }

  const desayunoPagado = !!desayuno?.cuentaComoJornada && desayunoMin != null && pausas >= 2;
  // La comida es lo que estuvo fuera SIN contar el desayuno.
  const comidaMin = pausas && fuera - (desayunoMin ?? 0) > 0 ? fuera - (desayunoMin ?? 0) : null;
  if (desayunoPagado && desayunoMin != null) fuera -= desayunoMin;

  return {
    comida: tramos.length ? tramos.join(' · ') : '—',
    netasMin: Math.max(0, brutas - fuera),
    brutasMin: brutas,
    desayunoMin,
    desayunoExcesoMin: desayuno && desayunoMin != null ? Math.max(0, desayunoMin - desayuno.topeMin) : null,
    desayunoPagado,
    comidaMin,
    entradaMin: mins[0],
    salidaMin: mins[mins.length - 1],
  };
}

/** Minutos → 'Hh MMm' (o '—'). */
export function formatHoras(min: number): string {
  if (min <= 0) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
