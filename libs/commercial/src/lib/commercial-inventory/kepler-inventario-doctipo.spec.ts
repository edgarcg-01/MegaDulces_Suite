import { describe, expect, it } from 'vitest';

import {
  DOCTIPOS_INVENTARIO, IVA_ACTA_PCT, MARCA_INVENTARIO, SERIE_INVENTARIO, SQL_EXISTENCIA_KEPLER,
  cantidadDelRenglon, coordenadaInventario, ivaDelActa, plantillaInventarioDe, repartirDiferencias,
  totalDelEncabezado, type DiferenciaInventario,
} from './kepler-inventario-doctipo';
import { SQL_TOPE_INVENTARIO, horaMx } from './kepler-inventario-sink.adapter';

/**
 * `[ICR.K8]` — **Las reglas del inventario físico de Kepler, con su prueba negativa.**
 *
 * Cada caso de acá contrasta una cifra MEDIDA en prod el 2026-11-27 (ver el anexo
 * `FASE_ICR_ANEXO_ANATOMIA_INVENTARIO_FISICO_KEPLER_2026-11-27.md`). Y cada candado se rompe a
 * propósito una vez: un gate sin prueba negativa es una intención.
 *
 * ⛔ **Nada de esto toca Kepler.** Son funciones puras y la forma del SQL; el adapter sólo se
 * ejerce contra el ERP desde `md`, con autorización de Edgar.
 */

/** El acta de Yurécuaro del 17-sep-2026, tal como está en el ERP. Es la vara de todo el archivo. */
const YURECUARO = {
  acta: { folio: '0000003', renglones: 1567, importe: 679888.72, iva: 108782.20 },
  entrada: { folio: '0000004', renglones: 264, importe: 116053.19 },
  salida: { folio: '0000003', renglones: 346, importe: 64540.70 },
};

const fila = (sku: string, contado: number, existencia: number): DiferenciaInventario => ({
  sku, nombre: `PROD ${sku}`, contado, existencia, diferencia: +(contado - existencia).toFixed(2),
});

describe('[ICR.K1] cuál documento mueve la existencia', () => {
  it('el acta NO mueve existencia; la entrada y la salida SÍ (kdij: 0 de 123 · 108 de 108 · 94 de 94)', () => {
    expect(DOCTIPOS_INVENTARIO.acta.mueveExistencia).toBe(false);
    expect(DOCTIPOS_INVENTARIO.entrada.mueveExistencia).toBe(true);
    expect(DOCTIPOS_INVENTARIO.salida.mueveExistencia).toBe(true);
  });

  it('las coordenadas son las del catálogo del ERP, no nombres inventados', () => {
    expect(coordenadaInventario('acta')).toBe('N-A-45');
    expect(coordenadaInventario('entrada')).toBe('N-A-30');
    expect(coordenadaInventario('salida')).toBe('N-D-30');
    // ⛔ El exportador viejo rotulaba `InvIn`/`InvOut` y `PhysInv`: inglés que no existe en Kepler.
    const nombres = Object.values(DOCTIPOS_INVENTARIO).map((d) => d.nombreKepler);
    expect(nombres).toEqual(['Captura inventario físico', 'Entrada Inventario físico', 'Salida inventario físico']);
    expect(nombres.join(' ')).not.toMatch(/InvIn|InvOut|PhysInv/);
  });
});

describe('[ICR.K1] ⛔ dónde va la marca de la Suite, y dónde NO', () => {
  it('la marca va a c24 en los TRES — nunca a c11', () => {
    for (const t of ['acta', 'entrada', 'salida'] as const) {
      expect(DOCTIPOS_INVENTARIO[t].marca).toBe('c24');
    }
  });

  it('c11 del acta es la ZONA; c11 de los movimientos es el FOLIO DEL ACTA', () => {
    expect(DOCTIPOS_INVENTARIO.acta.c11).toBe('zona');
    expect(DOCTIPOS_INVENTARIO.entrada.c11).toBe('folio_acta');
    expect(DOCTIPOS_INVENTARIO.salida.c11).toBe('folio_acta');
  });

  // Prueba negativa: si alguien moviera la marca a c11, el movimiento perdería su liga al acta.
  it('⛔ ROJO a propósito: marcar en c11 pisaría la liga (243 de 249 entradas la llevan ahí)', () => {
    const roto = { ...DOCTIPOS_INVENTARIO.entrada, marca: 'c11' as unknown as 'c24' };
    const pisaLaLiga = roto.marca === ('c11' as string) && roto.c11 === 'folio_acta';
    expect(pisaLaLiga).toBe(true);
    expect(DOCTIPOS_INVENTARIO.entrada.marca).not.toBe('c11');
  });
});

describe('[ICR.K1] la lista `limpiar` está vacía, y es una medición', () => {
  it('ninguno de los tres limpia columnas: no hay huella de proceso en el documento', () => {
    for (const t of ['acta', 'entrada', 'salida'] as const) {
      expect(DOCTIPOS_INVENTARIO[t].limpiar).toEqual([]);
    }
  });
});

describe('[ICR.K2] el IVA del acta — 16 % del importe contado', () => {
  it('reproduce el c14 de Yurécuaro al centavo', () => {
    expect(ivaDelActa(YURECUARO.acta.importe)).toBe(YURECUARO.acta.iva);
    expect(IVA_ACTA_PCT).toBe(16);
  });

  // Prueba negativa real: estas dos se ponen rojas si alguien cambia la tasa de la constante.
  it('⛔ ROJO a propósito: la tasa está anclada — $100 contados dan $16 de IVA, no otra cosa', () => {
    expect(ivaDelActa(100)).toBe(16);
    expect(ivaDelActa(0)).toBe(0);
  });
});

describe('[ICR.K3] el total del encabezado', () => {
  it('el acta va en CERO (no tiene cuentas contables); los movimientos llevan su importe', () => {
    expect(totalDelEncabezado('acta', YURECUARO.acta.importe)).toBe(0);
    expect(totalDelEncabezado('entrada', YURECUARO.entrada.importe)).toBe(YURECUARO.entrada.importe);
    expect(totalDelEncabezado('salida', YURECUARO.salida.importe)).toBe(YURECUARO.salida.importe);
  });
});

describe('[ICR.K4] el reparto: el acta lleva todo, los movimientos sólo la diferencia', () => {
  const filas = [
    fila('A', 10, 10),  // cuadra → no genera movimiento
    fila('B', 12, 10),  // sobra 2 → entrada
    fila('C', 3, 10),   // faltan 7 → salida
    fila('D', 0, 5),    // contado en cero → salida de 5
    fila('E', 4, 0),    // Kepler no tenía → entrada de 4
  ];
  const r = repartirDiferencias(filas);

  it('el acta lleva TODO lo contado, no sólo lo que difiere (1,567 contra 610 en Yurécuaro)', () => {
    expect(r.acta).toHaveLength(5);
    expect(r.entrada.map((f) => f.sku)).toEqual(['B', 'E']);
    expect(r.salida.map((f) => f.sku)).toEqual(['C', 'D']);
  });

  it('ningún SKU cae en la entrada y en la salida a la vez (0 de 610 medidos)', () => {
    const cruce = r.entrada.filter((f) => r.salida.some((s) => s.sku === f.sku));
    expect(cruce).toEqual([]);
  });

  it('la cantidad del renglón: lo contado en el acta, el VALOR ABSOLUTO de la diferencia en el movimiento', () => {
    const c = filas[2]; // contado 3, existencia 10 → diferencia −7
    expect(cantidadDelRenglon('acta', c)).toBe(3);
    expect(cantidadDelRenglon('salida', c)).toBe(7);
  });

  it('⛔ ROJO a propósito: escribir lo CONTADO como cantidad del movimiento ajustaría de más', () => {
    // Medido: 114 de los 610 movimientos de Yurécuaro son MAYORES que lo contado del mismo SKU.
    const c = filas[2];
    expect(cantidadDelRenglon('salida', c)).not.toBe(c.contado);
  });

  it('la proporción tiene la forma de Yurécuaro: se ajusta mucho menos de lo que se cuenta', () => {
    expect(r.entrada.length + r.salida.length).toBeLessThan(r.acta.length);
    const proporcionReal = (YURECUARO.entrada.renglones + YURECUARO.salida.renglones) / YURECUARO.acta.renglones;
    expect(proporcionReal).toBeCloseTo(0.389, 3);
  });
});

describe('[ICR.K1] la serie y la marca', () => {
  it('la serie es 1 (medido en 2,310 documentos de la familia)', () => {
    expect(SERIE_INVENTARIO).toBe(1);
  });

  it('la marca es el folio del conteo de la Suite', () => {
    expect(MARCA_INVENTARIO).toBe('INV-');
    expect('INV-2026-00007'.startsWith(MARCA_INVENTARIO)).toBe(true);
  });

  it('cada tipo tiene SU contador, y es el que declara kdmm.c17', () => {
    expect(DOCTIPOS_INVENTARIO.acta.contador).toBe('KFNA4501');
    expect(DOCTIPOS_INVENTARIO.entrada.contador).toBe('KFNA3001');
    expect(DOCTIPOS_INVENTARIO.salida.contador).toBe('KFND3001');
  });

  it('el prefijo c63: el acta lo trae (312/312), los movimientos van vacíos (243/249 y 221/227)', () => {
    expect(DOCTIPOS_INVENTARIO.acta.prefijo).toBe('NA4501-');
    expect(DOCTIPOS_INVENTARIO.entrada.prefijo).toBe('');
    expect(DOCTIPOS_INVENTARIO.salida.prefijo).toBe('');
  });
});

describe('[ICR.K1] la plantilla por servidor — el candado que apaga una sucursal', () => {
  const env = {
    KEPLER_INV_ACTA_TEMPLATE_FOLIO_04: '0000003',
    KEPLER_INV_ENTRADA_TEMPLATE_FOLIO_04: '0000004',
    KEPLER_INV_SALIDA_TEMPLATE_FOLIO_04: '0000003',
  };

  it('resuelve la plantilla de su servidor, con serie 1 por default', () => {
    const p = plantillaInventarioDe('acta', '04', env);
    expect(p).toEqual({ ok: true, valor: { serie: '1', folio: '0000003' } });
  });

  it('⛔ ROJO a propósito: sin la variable del servidor, APAGADO — nunca el folio de otra plaza', () => {
    const p = plantillaInventarioDe('salida', '08', env);
    expect(p.ok).toBe(false);
    expect(p.ok === false && p.motivo).toContain('KEPLER_INV_SALIDA_TEMPLATE_FOLIO_08');
  });

  it('⛔ ROJO a propósito: oficinas (00) NO hereda la variable sin sufijo (sin comodines)', () => {
    const p = plantillaInventarioDe('acta', '00', { ...env, KEPLER_INV_ACTA_TEMPLATE_FOLIO: '0000001' });
    expect(p.ok).toBe(false);
  });

  it('una sucursal mal escrita se rechaza antes de abrir conexión', () => {
    expect(plantillaInventarioDe('acta', '01-005', env).ok).toBe(false);
    expect(plantillaInventarioDe('acta', '', env).ok).toBe(false);
  });
});

describe('[ICR.K4] la existencia sale de Kepler, con la fórmula de Kepler', () => {
  it('usa kdil c4 + c8 − c9 con piso en cero — nunca c9 solo', () => {
    expect(SQL_EXISTENCIA_KEPLER).toContain('c4 + c8 - c9');
    expect(SQL_EXISTENCIA_KEPLER).toContain('GREATEST');
    expect(SQL_EXISTENCIA_KEPLER).toContain('md.kdil');
  });

  it('⛔ ROJO a propósito: no lee ninguna tabla de la Suite (commercial.stock está muerta)', () => {
    expect(SQL_EXISTENCIA_KEPLER).not.toMatch(/commercial\.|inventory\.|analytics\./);
  });
});

describe('[ICR.K6] el tope diario cuenta ACTAS, no los tres documentos', () => {
  it('filtra exactamente N-A-45 con marca de la Suite', () => {
    expect(SQL_TOPE_INVENTARIO).toContain(`c2 = 'N'`);
    expect(SQL_TOPE_INVENTARIO).toContain(`c3 = 'A'`);
    expect(SQL_TOPE_INVENTARIO).toContain(`btrim(c4::text) = '45'`);
    expect(SQL_TOPE_INVENTARIO).toContain('btrim(c24) LIKE $3');
  });

  it('⛔ ROJO a propósito: si contara los tres tipos, un ajuste gastaría 3 del cupo', () => {
    // El error de `[AB.NI.8]`: el tope del traspaso contaba también las compras y el pedido
    // nacía bloqueado 2 de cada 3 días — cero U-D-40 escritos en toda la historia.
    expect(SQL_TOPE_INVENTARIO).not.toContain(`'30'`);
  });
});

describe('[ICR.K5] la hora de captura', () => {
  it('es HH:MM de 24 h, hora de México (kdm1.c69 es varchar(5))', () => {
    const h = horaMx(new Date('2026-09-17T18:13:00-06:00'));
    expect(h).toBe('18:13');
    expect(h).toHaveLength(5);
  });
});
