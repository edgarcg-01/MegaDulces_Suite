import type {
  EjercicioFila, HuecoDeclarado, MotorPresupuesto, ObligacionesResumen, PresupuestoDireccion,
} from '@megadulces/contracts';
import type { MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { money } from '../finanzas-format';

/**
 * `[PU.DIR.1]` — **La vista «Dirección»: la lógica, fuera de la plantilla.**
 *
 * Por qué vive acá y no en el componente: la regla del carril que especifica es **cero cifras en
 * la plantilla**. Una frase como «van 29 corridas y ninguno de los 3 ejercicios esta firmado» ES
 * una cifra — sólo que escrita con palabras. Armarla en TypeScript la vuelve probable sin montar
 * el componente, y deja la plantilla con puras interpolaciones.
 *
 * ── ⛔ `money()` CONVIERTE `null` EN `$0.00`, Y ESO ES JUSTO LO PROHIBIDO ──
 *
 * `shared/util/money.util.ts` hace `Number(v || 0)`: un monto que no se pudo medir sale como
 * **cero pesos**, que es una afirmación. Ningún monto de este archivo llega a `money()` sin pasar
 * antes por {@link montoODeclarado}, que devuelve el motivo en vez del cero.
 */

/** Un monto que puede faltar. `null` sale con su motivo, NUNCA como $0.00. */
export function montoODeclarado(v: number | null | undefined, motivo = 'sin medir'): string {
  return v === null || v === undefined ? motivo : money(v);
}

export interface RespuestaDireccion {
  /** La respuesta de la pagina, en una linea. */
  titular: string;
  /** El matiz que cambia como se lee el titular. `null` si no hay nada que matizar. */
  detalle: string | null;
  /**
   * ⭐ Los bloques que NO se pudieron medir y que por eso la respuesta no cubre.
   *
   * Sin esto, una respuesta armada con dos de tres clausulas se lee **idéntica** a una completa:
   * el lector no tiene forma de saber que falta un tercio. Es la misma regla que el contrato
   * aplica a cada bloque, aplicada a la frase que los resume.
   */
  sinMedir: string[];
}

/** ¿Cuántos ejercicios REALES hay, y cuántos tienen firma? El de prueba no cuenta de ningún lado. */
export function conteoDeFirma(ejercicios: EjercicioFila[]): { reales: number; firmados: number; prueba: number } {
  const reales = ejercicios.filter((e) => !e.is_test);
  return {
    reales: reales.length,
    firmados: reales.filter((e) => e.autorizado_en !== null).length,
    prueba: ejercicios.length - reales.length,
  };
}

/** La espera más larga entre los ejercicios sin firmar. `null` si ninguno espera. */
export function esperaMasLarga(ejercicios: EjercicioFila[]): number | null {
  const dias = ejercicios
    .filter((e) => !e.is_test && e.dias_sin_firmar !== null)
    .map((e) => e.dias_sin_firmar as number);
  return dias.length ? Math.max(...dias) : null;
}

/**
 * La respuesta de la página, armada **clausula por clausula** desde el payload.
 *
 * ⚠️ Cada clausula depende de SU bloque. Si un bloque llega `null` su clausula no se inventa: se
 * omite del titular y su nombre entra a `sinMedir`. Una respuesta mas corta sin decir por que es
 * una respuesta que miente por omision.
 */
export function respuestaDireccion(d: PresupuestoDireccion | null): RespuestaDireccion | null {
  if (!d) return null;

  const clausulas: string[] = [];
  const sinMedir: string[] = [];

  if (d.motor) {
    const c = d.motor.corridas;
    clausulas.push(
      c === 0
        ? 'el motor no ha corrido ni una vez'
        : `el presupuesto lo escribe un motor que lleva ${c} ${c === 1 ? 'corrida' : 'corridas'}`,
    );
  } else {
    sinMedir.push('el motor');
  }

  if (d.ejercicios_error || !d.ejercicios) {
    sinMedir.push('los ejercicios');
  } else {
    const f = conteoDeFirma(d.ejercicios.filas);
    if (f.reales === 0) clausulas.push('no hay ningun ejercicio real que firmar');
    else if (f.firmados === 0) {
      clausulas.push(
        f.reales === 1 ? 'el unico ejercicio sigue sin firma' : `ninguno de los ${f.reales} ejercicios tiene firma`,
      );
    } else if (f.firmados < f.reales) clausulas.push(`${f.firmados} de ${f.reales} ejercicios estan firmados`);
    else clausulas.push('los ejercicios estan firmados');
  }

  // La meta no es un bloque propio: es un hueco declarado. Si el hueco no viene, no se afirma
  // que haya meta — simplemente no se dice nada, que es distinto.
  if (d.huecos.some((h) => /meta/i.test(h.nombre))) clausulas.push('no hay meta contra la cual juzgarlo');

  if (!clausulas.length) return { titular: 'No se pudo medir nada de esta vista.', detalle: null, sinMedir };

  const titular = `${mayuscula(clausulas.join(', '))}.`;

  return { titular, detalle: detalleDePrueba(d.obligaciones, d.obligaciones_error), sinMedir };
}

/**
 * ⛔ El matiz que mas cambia la lectura: **cuanto del tamano aparente es de un ejercicio de
 * prueba**. El de prueba es copia casi exacta del real, asi que un total combinado se ve normal
 * y publica el doble; este dominio ya lo publico una vez.
 */
function detalleDePrueba(o: ObligacionesResumen | null, err: string | null): string | null {
  if (err) return `No se pudo medir el peso del ejercicio de prueba: ${err}`;
  if (!o || o.prueba.n === 0) return null;
  return `Ojo con el tamano: ${o.prueba.n} obligaciones por ${money(o.prueba.monto)} son de un ejercicio de prueba y no entran a ningun total.`;
}

function mayuscula(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** La cadencia del motor, derivada por el servidor. `null` se DECLARA, no se calla. */
export function leyendaCadencia(m: MotorPresupuesto | null): string {
  if (!m) return 'sin medir';
  return m.cadencia ?? 'cadencia no derivable: hacen falta tres corridas para tener dos diferencias que comparar';
}

/**
 * El aviso de corridas con error. `null` cuando no hay ninguna — **no** un texto en verde:
 * un bloque que siempre dice algo deja de leerse.
 */
export function avisoCorridasConError(m: MotorPresupuesto | null): string | null {
  if (!m || m.error === 0) return null;
  const cola = m.ultima_error ? ` La ultima fue el ${m.ultima_error}.` : '';
  return `${m.error} de las ${m.corridas} corridas terminaron en error.${cola} El motor no avisa cuando falla: hay que venir a mirarlo.`;
}

/**
 * Las cuatro metricas de la vista.
 *
 * ⭐ **`0 / 2`, no `0 / 3`.** El ejercicio de prueba no se puede firmar —su propia fila dice «no
 * aplica»— asi que meterlo en el denominador publica una razon cuyo numerador jamas podria
 * alcanzarlo. Va aparte, en su propia metrica, que ademas es el aviso de duplicacion.
 */
export function metricasDireccion(d: PresupuestoDireccion | null): MetricStripItem[] {
  if (!d) return [];
  const items: MetricStripItem[] = [];

  items.push(
    d.motor
      ? {
          label: 'Corridas del motor',
          value: d.motor.corridas,
          format: 'number',
          tone: d.motor.error > 0 ? 'warn' : 'default',
          sub: `${d.motor.ok} bien · ${d.motor.error} con error`,
          state: 'medido',
        }
      : noMedido('Corridas del motor', d.motor_error),
  );

  if (d.ejercicios_error || !d.ejercicios) items.push(noMedido('Ejercicios firmados', d.ejercicios_error));
  else {
    const f = conteoDeFirma(d.ejercicios.filas);
    const espera = esperaMasLarga(d.ejercicios.filas);
    items.push({
      label: 'Ejercicios firmados',
      value: `${f.firmados} / ${f.reales}`,
      format: 'text',
      tone: f.reales > 0 && f.firmados === 0 ? 'bad' : 'default',
      sub: espera === null
        ? 'ninguno espera firma'
        : `el mas viejo lleva ${espera} ${espera === 1 ? 'dia' : 'dias'} esperando`,
      state: 'medido',
    });
  }

  if (d.obligaciones_error) {
    items.push(noMedido('Obligaciones reales', d.obligaciones_error));
    items.push(noMedido('Del ejercicio de prueba', d.obligaciones_error));
  } else if (d.obligaciones) {
    items.push({
      label: 'Obligaciones reales',
      value: d.obligaciones.reales.monto,
      format: 'currency-short',
      sub: `${d.obligaciones.reales.n} obligaciones`,
      state: 'medido',
    });
    items.push({
      label: 'Del ejercicio de prueba',
      value: d.obligaciones.prueba.monto,
      format: 'currency-short',
      tone: 'muted',
      sub: `${d.obligaciones.prueba.n} obligaciones · no entran a ningun total`,
      state: 'medido',
    });
  }

  return items;
}

function noMedido(label: string, motivo: string | null): MetricStripItem {
  return {
    label,
    value: 'sin medir',
    format: 'text',
    tone: 'muted',
    state: 'no_medido',
    stateNote: motivo ?? 'el bloque llego vacio y sin motivo, que es un defecto del servidor',
    sub: motivo ?? 'sin motivo declarado',
  };
}

/**
 * El peso de un hueco, en texto.
 *
 * ⛔ Las dos ausencias **no son la misma y no se pintan igual**: `medido: false` es «no hay con
 * qué medirlo» y sale con su motivo; `valor: null` con `medido: true` es una consulta que corrió
 * y no devolvió cifra. Ninguna de las dos sale como `0`, que se leería como «no falta nada».
 */
export function pesoTexto(h: HuecoDeclarado): string {
  if (!h.peso.medido) return h.peso.como;
  if (h.peso.valor === null) return `sin cifra: ${h.peso.como}`;
  return `${h.peso.valor.toLocaleString('es-MX')} ${h.peso.unidad}`;
}

/**
 * Los huecos, ordenados: primero lo que SÍ se midió y tiene cifra.
 *
 * ⚠️ Lo que no se pudo medir va al final a propósito. Es la misma razón por la que un indicador
 * sin meta se ordena primero en un tablero de estados y acá al revés: allá la ausencia ES el
 * hallazgo; acá todos son ausencias, así que lo que manda es cuál se puede dimensionar.
 */
export function huecosOrdenados(h: HuecoDeclarado[]): HuecoDeclarado[] {
  const rango = (x: HuecoDeclarado) => (x.peso.medido && x.peso.valor !== null ? 0 : x.peso.medido ? 1 : 2);
  return [...h].sort((a, b) => rango(a) - rango(b));
}
