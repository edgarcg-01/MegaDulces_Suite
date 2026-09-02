/**
 * Horario de atención del departamento de e-commerce, y cálculo de hasta
 * cuándo hay que confirmar un pedido.
 *
 * POR QUÉ ESTO IMPORTA
 * Un pedido con tarjeta lleva el cargo reservado en Mercado Pago, y esa
 * reserva vence: 5 días en la API de Orders, 7 en Checkout Bricks. Si nadie
 * confirma antes, la reserva se cancela sola y el cobro se pierde — pero el
 * dinero estuvo retenido en la tarjeta del cliente todo ese tiempo, sin cobro
 * ni entrega. Eso es una llamada de reclamo.
 *
 * Por eso la fecha límite no se calcula "a X horas": se calcula sobre el
 * horario real en que alguien puede atenderlo.
 */

/** Lunes a viernes, 8:00 a 18:30. */
export const ABRE_HORA = 8;
export const CIERRA_HORA = 18;
export const CIERRA_MIN = 30;

/**
 * Días festivos oficiales de México (Ley Federal del Trabajo, art. 74).
 * Se calculan por año en vez de listarlos a mano: una lista escrita a mano se
 * queda vieja en enero y nadie se acuerda de actualizarla.
 *
 * NO incluye los puentes no oficiales ni las vacaciones de la empresa. Si Mega
 * Dulces cierra en días que no están aquí, hay que agregarlos en DIAS_EXTRA.
 */
export const DIAS_EXTRA: string[] = [
  // Formato 'YYYY-MM-DD'. Ejemplo: '2026-12-24',
];

/** Enésimo lunes de un mes. Ej: lunesDeMes(2026, 1, 1) = primer lunes de febrero. */
function lunesDeMes(anio: number, mes: number, cual: number): Date {
  const d = new Date(anio, mes, 1);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  d.setDate(d.getDate() + (cual - 1) * 7);
  return d;
}

const aClave = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const cacheFestivos = new Map<number, Set<string>>();

export function festivosDe(anio: number): Set<string> {
  const ya = cacheFestivos.get(anio);
  if (ya) return ya;

  const f = new Set<string>([
    `${anio}-01-01`,                       // Año nuevo
    aClave(lunesDeMes(anio, 1, 1)),        // 1er lunes de febrero — Constitución
    aClave(lunesDeMes(anio, 2, 3)),        // 3er lunes de marzo — Natalicio de Juárez
    `${anio}-05-01`,                       // Día del trabajo
    `${anio}-09-16`,                       // Independencia
    aClave(lunesDeMes(anio, 10, 3)),       // 3er lunes de noviembre — Revolución
    `${anio}-12-25`,                       // Navidad
  ]);
  // Transmisión del Poder Ejecutivo: cada seis años. 2024, 2030, 2036...
  if ((anio - 2024) % 6 === 0) f.add(`${anio}-10-01`);

  for (const d of DIAS_EXTRA) f.add(d);
  cacheFestivos.set(anio, f);
  return f;
}

export function esDiaHabil(d: Date): boolean {
  const dia = d.getDay();
  if (dia === 0 || dia === 6) return false;          // domingo o sábado
  return !festivosDe(d.getFullYear()).has(aClave(d));
}

/** ¿Hay alguien atendiendo en este momento? */
export function enHorario(d = new Date()): boolean {
  if (!esDiaHabil(d)) return false;
  const min = d.getHours() * 60 + d.getMinutes();
  return min >= ABRE_HORA * 60 && min <= CIERRA_HORA * 60 + CIERRA_MIN;
}

/** Cierre del siguiente día hábil después de la fecha dada. */
export function siguienteCierreHabil(desde = new Date()): Date {
  const d = new Date(desde);
  d.setDate(d.getDate() + 1);
  let guarda = 0;
  while (!esDiaHabil(d) && guarda++ < 30) d.setDate(d.getDate() + 1);
  d.setHours(CIERRA_HORA, CIERRA_MIN, 0, 0);
  return d;
}

/**
 * Hasta cuándo hay que confirmar un pedido que llega en este momento.
 *
 * La regla es el cierre del SIGUIENTE día hábil. Con el horario de lunes a
 * viernes eso da:
 *
 *   Lunes 10:00       → martes 18:30       (~32 h)
 *   Viernes 10:00     → lunes 18:30        (~80 h)
 *   Viernes 19:00     → lunes 18:30        (~71 h)
 *   Sábado            → lunes 18:30        (~56 h)
 *
 * Todos caben en los 5 días de la reserva. El caso que aprieta es un puente
 * largo, y por eso festivosDe() los toma en cuenta: sin eso, un pedido del
 * viernes antes de un lunes festivo tendría fecha límite el lunes, cuando no
 * hay nadie.
 */
export function limiteConfirmacion(desde = new Date()): Date {
  return siguienteCierreHabil(desde);
}

/**
 * Cuándo se le va a hacer caso a un pedido que llega ahora. Es lo que se le
 * dice al cliente, y no es lo mismo que la fecha límite: el límite es el
 * compromiso máximo, esto es la expectativa razonable.
 */
export function cuandoSeAtiende(desde = new Date()): { fecha: Date; texto: string } {
  if (enHorario(desde)) {
    return { fecha: desde, texto: 'Lo revisamos hoy mismo' };
  }
  const d = new Date(desde);
  // Si es día hábil pero antes de abrir, se atiende ese mismo día.
  const min = d.getHours() * 60 + d.getMinutes();
  if (esDiaHabil(d) && min < ABRE_HORA * 60) {
    d.setHours(ABRE_HORA, 0, 0, 0);
    return { fecha: d, texto: 'Lo revisamos hoy a partir de las 8:00' };
  }
  // Si no, el siguiente día hábil a la hora de apertura.
  d.setDate(d.getDate() + 1);
  let guarda = 0;
  while (!esDiaHabil(d) && guarda++ < 30) d.setDate(d.getDate() + 1);
  d.setHours(ABRE_HORA, 0, 0, 0);

  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  return { fecha: d, texto: `Lo revisamos el ${dias[d.getDay()]} a partir de las 8:00` };
}
