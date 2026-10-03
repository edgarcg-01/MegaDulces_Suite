import { describe, expect, it } from 'vitest';
import {
  MOTIVO_AUTOMATICO,
  anotaSolo,
  pasoDeReloj,
  porcentajeReloj,
} from './faltante-express';

/**
 * `[FLT.25]` — El candado del alta automática.
 *
 * El riesgo de esta función no es que falle: es que **acierte de más**. Un `anotaSolo` que
 * devuelve `true` siempre se ve idéntico en pantalla al correcto mientras se prueba con un
 * producto agotado, y escribe un faltante por cada consulta de precio. Por eso los casos
 * negativos pesan más que el positivo acá.
 */
describe('anotaSolo — qué veredicto escribe sin preguntar', () => {
  it('sin existencia anota solo: es el caso que la fase existe para capturar', () => {
    expect(anotaSolo('sin_existencia')).toBe(true);
  });

  it('con existencia NO anota: no faltó nada, era una consulta de precio', () => {
    expect(anotaSolo('hay_en_tienda')).toBe(false);
  });

  it('⛔ sin medir NO anota: "no se pudo leer" no es cero (ADR-056)', () => {
    // Si esto se pone en `true`, cada vez que el ERP no conteste se inventa un faltante que a lo
    // mejor está en el anaquel — y se le manda a Compras como venta perdida.
    expect(anotaSolo('no_medido')).toBe(false);
  });

  it('⛔ mientras la respuesta viaja NO anota: anotar por adelantado es anotar a ciegas', () => {
    expect(anotaSolo(undefined)).toBe(false);
  });

  it('el motivo automático es siempre agotado, nunca otro', () => {
    expect(MOTIVO_AUTOMATICO).toBe('agotado');
  });
});

describe('pasoDeReloj — la ventana con tiempo', () => {
  it('descuenta el paso cuando corre', () => {
    expect(pasoDeReloj(9000, false, 100)).toBe(8900);
  });

  it('⛔ en pausa NO descuenta: si se cierra sola, el botón de deshacer no sirve de nada', () => {
    expect(pasoDeReloj(9000, true, 100)).toBe(9000);
  });

  it('no baja de cero: un negativo dibujaría la barra al revés', () => {
    expect(pasoDeReloj(50, false, 100)).toBe(0);
  });
});

describe('porcentajeReloj — el ancho de la barra', () => {
  it('va de 100 a 0 a lo largo de la ventana', () => {
    expect(porcentajeReloj(9000, 9000)).toBe(100);
    expect(porcentajeReloj(4500, 9000)).toBe(50);
    expect(porcentajeReloj(0, 9000)).toBe(0);
  });

  it('se mantiene en el rango aunque le pasen basura', () => {
    expect(porcentajeReloj(99999, 9000)).toBe(100);
    expect(porcentajeReloj(-500, 9000)).toBe(0);
    expect(porcentajeReloj(100, 0)).toBe(0);
  });
});
