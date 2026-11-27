import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ORDEN_PAPEL,
  SIN_UBICAR,
  codigosDe,
  ordenDeRecorrido,
  tramoDe,
  ubicacionDe,
  ubicacionesDe,
  type UbicacionDelProducto,
} from './ubicacion-del-producto';

/**
 * `[ICR.0.2][ICR.0.3][ICR.0.4]` — **Dónde está un producto, una sola vez en todo el repo.**
 *
 * ## Qué protege
 *
 * Dos oficios necesitan la misma pregunta —*¿dónde está este producto?*— y la contestaban por
 * separado: el **surtido** desde el 2026-11-17 (`apoyo-surtido.ts`, `[GP.RF.33]`) y el **conteo
 * físico** desde el 2026-11-27. Las dos copias ya se estaban separando: la del conteo **no excluía
 * las ubicaciones dadas de baja**. Hoy eso no cambia ningún número (476 de 476 están `activa`), y
 * ése es justo el momento en que conviene juntarlas: cuando todavía no costó nada (ADR-056).
 *
 * ## Lo que NO es lo mismo entre los dos, y por eso se dice en cada llamada
 *
 * Qué hacer con un `papel` que el código no conoce:
 *
 *  · **surtir** lo descarta — un papel nuevo podría ser cuarentena o merma, y mandar al surtidor
 *    ahí sería sacar mercancía que no debe salir;
 *  · **contar** lo conserva — lo que está en cuarentena existe y hay que contarlo.
 *
 * Las dos pruebas negativas de abajo fijan esa diferencia. Hoy no se puede ejercer en prod
 * (`ck_bin_assignments_papel` admite exactamente tres valores): se prueba con una fila armada.
 *
 * ## Alcance de lo que afirma
 *
 * Ejerce las funciones de verdad, con filas armadas a mano. Del lado de la base **lee el texto de
 * la migración**: afirma que la vista filtra y deriva lo que debe, NO que esté creada en prod —
 * eso lo verifica la propia migración al aplicarse, contando sus filas contra la fuente.
 *
 * ⚠️ Sin `import` de `vitest`: el runner del monorepo inyecta los globales.
 */

/** Una fila de la vista, con lo justo para la prueba. */
const U = (p: Partial<UbicacionDelProducto> = {}): UbicacionDelProducto => ({
  product_id: 'p1',
  bin_code: 'TA011',
  tramo: 'T-A',
  pick_sequence: 20011,
  papel: 'exhibicion_tienda',
  presentacion_rotulo: 'PAQ',
  ...p,
});

const VISTA_SQL: string = require('../../../../../database/migrations-newdb/20261127150434_icr_c0_v_product_bin_location.js').SELECT_SQL;

describe('[ICR.0.2] la ubicación de un producto, en un solo lugar', () => {
  it('CONTROL — con UNA asignación devuelve esa, su tramo y su orden; sin ninguna, nada', () => {
    const una = [U()];
    expect(ubicacionDe(una, 'p1')?.bin_code).toBe('TA011');
    expect(tramoDe(una, 'p1')).toBe('T-A');
    expect(codigosDe(una, 'p1')).toBe('TA011');
    expect(ordenDeRecorrido(una[0])).toBe(20011);
    // Y el control del otro lado: lo que no está, no se inventa.
    expect(ubicacionDe(una, 'p2')).toBeNull();
    expect(tramoDe(una, 'p2')).toBe(SIN_UBICAR);
    expect(codigosDe(una, 'p2')).toBeNull();
  });

  it('gana el lugar fijo sobre la exhibición, y la reserva va al final', () => {
    const filas = [
      U({ bin_code: 'TC021', papel: 'reserva_preferida', pick_sequence: 60021, tramo: 'T-C' }),
      U({ bin_code: 'TB013', papel: 'exhibicion_tienda', pick_sequence: 40013, tramo: 'T-B' }),
      U({ bin_code: 'BA011', papel: 'surtido_fijo', pick_sequence: 10011, tramo: 'B-A' }),
    ];
    expect(ubicacionDe(filas, 'p1')?.bin_code).toBe('BA011');
    expect(tramoDe(filas, 'p1')).toBe('B-A');
    // Y el orden declarado es el que se usa, no el del arreglo.
    expect(ORDEN_PAPEL['surtido_fijo']).toBeLessThan(ORDEN_PAPEL['exhibicion_tienda']);
    expect(ORDEN_PAPEL['exhibicion_tienda']).toBeLessThan(ORDEN_PAPEL['reserva_preferida']);
  });

  it('dentro del mismo papel desempata la presentación pedida', () => {
    const filas = [
      U({ bin_code: 'TA011', presentacion_rotulo: 'PZA' }),
      U({ bin_code: 'TA014', presentacion_rotulo: 'CJA' }),
    ];
    expect(ubicacionDe(filas, 'p1', { unidad: 'CJA' })?.bin_code).toBe('TA014');
    expect(ubicacionDe(filas, 'p1', { unidad: 'pza' })?.bin_code).toBe('TA011');
  });

  it('`[ICR.0.4]` un producto en varias ubicaciones las devuelve TODAS, en orden de recorrido', () => {
    const filas = [
      U({ bin_code: 'TA014', pick_sequence: 20014 }),
      U({ bin_code: 'C01', pick_sequence: null, tramo: 'sin-recorrido' }),
      U({ bin_code: 'TA011', pick_sequence: 20011 }),
    ];
    expect(ubicacionesDe(filas, 'p1').map((u) => u.bin_code)).toEqual(['TA011', 'TA014', 'C01']);
    // Lo que no tiene recorrido va al final y NO se pierde: es mercancía que alguien va a contar.
    expect(codigosDe(filas, 'p1')).toBe('TA011 · TA014 · C01');
  });

  it('⭐ el papel desconocido: surtir NO va, contar SÍ cuenta', () => {
    const filas = [U({ papel: 'cuarentena' })];
    // Contar: la mercancía existe, así que se declara dónde está.
    expect(ubicacionDe(filas, 'p1')?.bin_code).toBe('TA011');
    expect(tramoDe(filas, 'p1')).toBe('T-A');
    // Surtir: entre equivocarse y no ir, no ir.
    expect(ubicacionDe(filas, 'p1', { descartarPapelDesconocido: true })).toBeNull();
  });

  it('PRUEBA NEGATIVA — si el orden de los papeles se invierte, el candado se pone ROJO', () => {
    const invertido: Record<string, number> = {
      surtido_fijo: 2,
      exhibicion_tienda: 1,
      reserva_preferida: 0,
    };
    expect(invertido, 'la mutación no aplicó').not.toEqual(ORDEN_PAPEL);
    // Con el orden invertido ganaría la reserva, y la aserción de arriba fallaría.
    const gana = ['reserva_preferida', 'surtido_fijo'].sort((a, b) => invertido[a] - invertido[b])[0];
    expect(gana).toBe('reserva_preferida');
    expect(gana).not.toBe(
      ['reserva_preferida', 'surtido_fijo'].sort((a, b) => ORDEN_PAPEL[a] - ORDEN_PAPEL[b])[0],
    );
  });
});

describe('[ICR.0.2] la vista derivada junta y filtra, y no decide cuál gana', () => {
  it('CONTROL — la migración exporta un SELECT y no una cadena vacía', () => {
    expect(typeof VISTA_SQL).toBe('string');
    expect(VISTA_SQL.length).toBeGreaterThan(200);
    expect(VISTA_SQL).toContain('commercial.bin_assignments');
    expect(VISTA_SQL).toContain('commercial.warehouse_bins');
  });

  it('⛔ excluye lo borrado y lo dado de baja — la diferencia que separaba a las dos copias', () => {
    expect(VISTA_SQL).toContain('a.deleted_at IS NULL');
    expect(VISTA_SQL).toContain("b.estado <> 'baja'");
  });

  it('`[ICR.0.3]` deriva el tramo, y lo que no tiene recorrido lo DICE en vez de dejarlo nulo', () => {
    expect(VISTA_SQL).toContain("b.zona || '-' || b.pasillo");
    expect(VISTA_SQL).toContain("'sin-recorrido'");
    expect(VISTA_SQL).toContain('AS tramo');
  });

  it('⛔ la prioridad de papel NO vive en la vista: vive en este módulo, una sola vez', () => {
    expect(VISTA_SQL).not.toContain('orden_papel');
    expect(VISTA_SQL).not.toContain("WHEN 'surtido_fijo'");
  });

  it('PRUEBA NEGATIVA — si alguien quita el filtro de bajas, el candado se pone ROJO', () => {
    const mutante = VISTA_SQL.split("\n   AND b.estado <> 'baja'").join('');
    expect(mutante, 'la mutación no aplicó: el candado no probaría nada').not.toBe(VISTA_SQL);
    expect(mutante).not.toContain("b.estado <> 'baja'");
  });
});
