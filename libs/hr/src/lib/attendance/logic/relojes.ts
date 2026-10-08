/**
 * Fase RH · `[RH.1.2]` — reglas puras de los relojes: el semáforo y el nombre que acepta el equipo.
 */

/** No es un equipo: agrupa lo que Mega Talento tenía sin reloj de origen (ver la carga única). */
export const PREFIJO_RELOJ_DESCONOCIDO = 'MT-SIN-RELOJ-';
export const esRelojDesconocido = (serie: string | null | undefined): boolean =>
  String(serie || '').startsWith(PREFIJO_RELOJ_DESCONOCIDO);

/**
 * El nombre como lo acepta el reloj: un ZKTeco MB360/MB160 con firmware 6.60 guarda 24 BYTES
 * ASCII. Una «Ñ» o una «á» salen como basura en la pantalla del equipo, así que se quitan aquí
 * —donde RH lo ve antes de confirmar— y no en silencio en el agente. 23 y no 24: queda el cero
 * final. Copia de `nombreParaReloj` de Mega Talento (`reloj-comandos.ts`).
 */
export function nombreParaReloj(t: unknown): string {
  return String(t || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .-]/g, '')
    .replace(/\s+/g, ' ').trim()
    .slice(0, 23).trim();
}

export type Semaforo = 'ok' | 'atrasado' | 'mudo' | 'pendiente';

/** Sin señal por 2 h o más = rojo; menos de 10 min = verde. Los umbrales de Mega Talento. */
export const MUDO_SEG = 2 * 60 * 60;
export const OK_SEG = 10 * 60;

/**
 * REGLA DE PRODUCTO (de Mega Talento): la pantalla nunca debe parecer al día cuando no lo está.
 * Falta de dato ≠ falta del empleado, pero el atraso tiene que VERSE. Sin señal nunca = mudo.
 */
export function semaforoReloj(r: { pendiente: boolean; segundosSinSenal: number | null }): Semaforo {
  if (r.pendiente) return 'pendiente';
  if (r.segundosSinSenal == null || r.segundosSinSenal >= MUDO_SEG) return 'mudo';
  return r.segundosSinSenal < OK_SEG ? 'ok' : 'atrasado';
}

/** Tras estos intentos fallidos una orden se queda en `error` y deja de reintentarse. */
export const MAX_INTENTOS_ORDEN = 3;

export type Orden = 'borrar' | 'renombrar' | 'restaurar';
export type EstadoOrden = 'pendiente' | 'enviado' | 'hecho' | 'error' | 'cancelado';

/** El estado de una orden después de que el agente reporta un intento. */
export function estadoTrasIntento(reporte: 'hecho' | 'error', intentosPrevios: number): EstadoOrden {
  if (reporte === 'hecho') return 'hecho';
  return intentosPrevios + 1 >= MAX_INTENTOS_ORDEN ? 'error' : 'pendiente';
}

/** Lo que entiende el agente de Mega Talento (`escritura.js`): `<orden>_usuario`. */
export const tipoParaAgente = (o: Orden): string => `${o}_usuario`;
