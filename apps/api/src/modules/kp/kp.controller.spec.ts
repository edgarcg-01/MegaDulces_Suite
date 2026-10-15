import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { ZodValidationPipe } from '@megadulces/platform-core';
import { VerificadorPrecioQuery, VerificadorPreciosTodosQuery } from '@megadulces/contracts';
import { KpController } from './kp.controller';

/**
 * `[VAC.L6]` — La consulta del verificador se valida donde ENTRA el dato.
 *
 * Son endpoints `@Public()` (el kiosco no tiene cuenta), así que la frontera es esto. Hasta hoy el
 * único control era un saneo a mano dentro del servicio, sin tope de longitud, y una plaza mal
 * formada se ignoraba en silencio (la respuesta caía en la plaza determinista y el error de quien
 * llama no se veía).
 *
 * Límite declarado: el pipe se prueba con el MISMO esquema que usa el controlador, y que el
 * controlador lo tenga puesto en cada ruta se vigila como texto de su fuente (un test sin servidor
 * HTTP no ejecuta los decoradores).
 */

const pipePrecio = new ZodValidationPipe(VerificadorPrecioQuery);
const pipeTodos = new ZodValidationPipe(VerificadorPreciosTodosQuery);

describe('[VAC.L6] VerificadorPrecioQuery', () => {
  it('acepta una consulta normal y la devuelve tal cual', () => {
    expect(pipePrecio.transform({ q: '7501000000001', sucursal: '03' }))
      .toEqual({ q: '7501000000001', sucursal: '03' });
  });

  it('q y sucursal son opcionales: la ausencia la contesta el servicio ("Sin código"), no un 400', () => {
    expect(pipePrecio.transform({})).toEqual({});
  });

  it('⛔ un q de más de 64 caracteres es un 400, no llega al SQL', () => {
    expect(() => pipePrecio.transform({ q: 'a'.repeat(65) })).toThrow(BadRequestException);
    // En el límite exacto pasa: el tope no se come un código legítimo.
    expect(() => pipePrecio.transform({ q: 'a'.repeat(64) })).not.toThrow();
  });

  it('⛔ una sucursal mal formada es un 400 (antes se ignoraba en silencio)', () => {
    for (const mala of ['3', '003', 'ab', '0 3', "03'; DROP TABLE x;--"]) {
      expect(() => pipePrecio.transform({ q: '17083', sucursal: mala })).toThrow(BadRequestException);
    }
  });

  it('una sucursal vacía cuenta como ausente (un "?sucursal=" no es una plaza)', () => {
    expect(pipePrecio.transform({ q: '17083', sucursal: '' })).toEqual({ q: '17083' });
  });

  it('un q con forma de arreglo (?q=a&q=b) se rechaza: el servicio espera un texto', () => {
    expect(() => pipePrecio.transform({ q: ['a', 'b'] })).toThrow(BadRequestException);
  });

  it('el 400 dice QUÉ campo falló y nada más', () => {
    try {
      pipePrecio.transform({ sucursal: 'xx' });
      throw new Error('debió lanzar');
    } catch (e) {
      const cuerpo = JSON.stringify((e as BadRequestException).getResponse());
      expect(cuerpo).toContain('sucursal');
      expect(cuerpo).not.toMatch(/kdii|relation|postgres/i);
    }
  });
});

describe('[VAC.L6] VerificadorPreciosTodosQuery', () => {
  it('acepta la plaza o ninguna, y rechaza una mal formada', () => {
    expect(pipeTodos.transform({ sucursal: '01' })).toEqual({ sucursal: '01' });
    expect(pipeTodos.transform({})).toEqual({});
    expect(() => pipeTodos.transform({ sucursal: '1' })).toThrow(BadRequestException);
  });
});

describe('[VAC.L6] KpController', () => {
  it('reenvía al servicio los valores YA validados', () => {
    const kp = { getPrecio: vi.fn().mockReturnValue('r1'), getPreciosTodos: vi.fn().mockReturnValue('r2') };
    const c = new KpController(kp as never, {} as never);
    expect(c.getPrecio({ q: '17083', sucursal: '03' })).toBe('r1');
    expect(kp.getPrecio).toHaveBeenCalledWith('17083', '03');
    // Sin q: el servicio recibe '' y contesta "Sin código" (el 200 que el frontend ya entiende).
    c.getPrecio({});
    expect(kp.getPrecio).toHaveBeenLastCalledWith('', undefined);
    expect(c.getPreciosTodos({ sucursal: '01' })).toBe('r2');
    expect(kp.getPreciosTodos).toHaveBeenCalledWith('01');
  });

  /**
   * ⛔ La prueba que faltaba el 2026-10-15, cuando `[VAC]` tiró la API en PRODUCCIÓN con los
   * CUATRO checks del CI en verde. El defecto no era de tipos ni de lint: el parámetro decorado
   * estaba anotado con el NOMBRE DEL ESQUEMA, que también existe como valor, así que
   * `emitDecoratorMetadata` emitía el objeto Zod en `design:paramtypes` y Swagger moría al
   * arrancar leyendo `.constructor`.
   *
   * Las pruebas por regex que ya había NO lo veían: fijaban el texto del renglón que mataba el
   * arranque y lo daban por bueno. Ésta mira la metadata que Swagger realmente lee.
   *
   * ⚠️ Primero comprueba que HAY metadata: sin `emitDecoratorMetadata` la lista sale vacía y la
   * prueba pasaría sin medir nada — que es la forma de fallar que ya nos costó dos veces hoy.
   */
  it('⛔ el parámetro decorado NO lleva el esquema Zod en design:paramtypes (Swagger no arranca)', () => {
    for (const [metodo, esquema] of [['getPrecio', VerificadorPrecioQuery], ['getPreciosTodos', VerificadorPreciosTodosQuery]] as const) {
      const tipos = Reflect.getMetadata('design:paramtypes', KpController.prototype, metodo);
      expect(Array.isArray(tipos) && tipos.length > 0,
        `sin design:paramtypes en ${metodo} esta prueba no mide nada`).toBe(true);
      expect(tipos).not.toContain(esquema);
    }
  });

  it('cada ruta pública lleva el pipe de validación puesto (texto de la fuente)', () => {
    const fuente = readFileSync(join(__dirname, 'kp.controller.ts'), 'utf8');
    expect(fuente).toMatch(/@Query\(new ZodValidationPipe\(VerificadorPrecioQuery\)\)/);
    expect(fuente).toMatch(/@Query\(new ZodValidationPipe\(VerificadorPreciosTodosQuery\)\)/);
    // Y ya no queda el parámetro suelto sin validar.
    expect(fuente).not.toMatch(/@Query\('q'\)/);
    expect(fuente).not.toMatch(/@Query\('sucursal'\)/);
  });
});
