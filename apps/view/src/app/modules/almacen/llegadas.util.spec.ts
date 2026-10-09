import type { AndenLlegada } from '@megadulces/contracts';
import { diaAnterior, enPeriodo, ordenarLlegadas, resumirLlegadas } from './llegadas.util';

/**
 * `[WMS-REC.22]` Llegadas al andén — qué entra en cada periodo, el orden y los conteos.
 *
 * Lo que más importa: que **Hoy** no deje caer lo de ayer que sigue sin terminar (la misma queja
 * que dio origen a «Incompletos»), y que lo que va en camino no se cuente como llegada.
 */
const HOY = '2026-10-09';

function llegada(p: Partial<AndenLlegada>): AndenLlegada {
  return {
    clave: 'x', tipo: 'compra', estado: 'completa', dia: HOY,
    warehouse_id: 'w', warehouse_code: '01', warehouse_name: 'Padre Hidalgo',
    documento: '01/1', proveedor: 'P', origen_code: null, origen_nombre: null, salio: null, recibido_kepler: null,
    importe: 100, vale: null,
    resumen: { renglones: 1, listos: 1, faltan: 0, sin_caducidad: 0, verdes: 1, amarillos: 0, rojos: 0, por_autorizar: 0 },
    renglones: [],
    ...p,
  };
}

describe('[WMS-REC.22] diaAnterior', () => {
  it('cruza el mes sin pasar por la zona del navegador', () => {
    expect(diaAnterior('2026-10-01')).toBe('2026-09-30');
    expect(diaAnterior('2026-01-01')).toBe('2025-12-31');
  });
});

describe('[WMS-REC.22] el periodo', () => {
  it('Hoy: lo de hoy, lo que va en camino y lo de antes que sigue sin terminar', () => {
    expect(enPeriodo(llegada({ dia: HOY, estado: 'completa' }), 'hoy', HOY)).toBe(true);
    expect(enPeriodo(llegada({ dia: '2026-10-07', estado: 'sin_abrir' }), 'hoy', HOY)).toBe(true);
    expect(enPeriodo(llegada({ dia: '2026-10-08', estado: 'a_medias' }), 'hoy', HOY)).toBe(true);
    expect(enPeriodo(llegada({ dia: '2026-10-08', estado: 'en_camino' }), 'hoy', HOY)).toBe(true);
  });

  it('PRUEBA NEGATIVA: Hoy no muestra lo de ayer que ya quedó completo', () => {
    expect(enPeriodo(llegada({ dia: '2026-10-08', estado: 'completa' }), 'hoy', HOY)).toBe(false);
  });

  it('Ayer: sólo el día anterior; 7 días: toda la ventana', () => {
    expect(enPeriodo(llegada({ dia: '2026-10-08' }), 'ayer', HOY)).toBe(true);
    expect(enPeriodo(llegada({ dia: HOY }), 'ayer', HOY)).toBe(false);
    expect(enPeriodo(llegada({ dia: '2026-10-02' }), '7d', HOY)).toBe(true);
  });
});

describe('[WMS-REC.22] el orden', () => {
  it('primero lo que pide atención; dentro, lo más reciente', () => {
    const lista = [
      llegada({ clave: 'completa', estado: 'completa' }),
      llegada({ clave: 'camino', estado: 'en_camino' }),
      llegada({ clave: 'medias-temprano', estado: 'a_medias', vale: { id: '1', folio: 'V1', status: 'open', abierto_en: '2026-10-09T14:00:00Z', abierto_por: null, cerrado_en: null } }),
      llegada({ clave: 'medias-tarde', estado: 'a_medias', vale: { id: '2', folio: 'V2', status: 'open', abierto_en: '2026-10-09T18:00:00Z', abierto_por: null, cerrado_en: null } }),
      llegada({ clave: 'sin-abrir', estado: 'sin_abrir' }),
    ];
    expect(ordenarLlegadas(lista).map((l) => l.clave)).toEqual(['sin-abrir', 'medias-tarde', 'medias-temprano', 'completa', 'camino']);
  });
});

describe('[WMS-REC.22] el resumen', () => {
  it('cuenta las llegadas sin lo que va en camino, y suma lo que importa de cada estado', () => {
    const r = resumirLlegadas([
      llegada({ estado: 'sin_abrir', importe: 1500, tipo: 'compra' }),
      llegada({ estado: 'sin_abrir', importe: null, tipo: 'traspaso', dia: '2026-10-08' }),
      llegada({ estado: 'a_medias', tipo: 'traspaso', resumen: { renglones: 7, listos: 5, faltan: 2, sin_caducidad: 1, verdes: 3, amarillos: 1, rojos: 1, por_autorizar: 1 } }),
      llegada({ estado: 'completa', tipo: 'manual' }),
      llegada({ estado: 'en_camino', tipo: 'traspaso' }),
    ], HOY);
    expect(r).toEqual({
      llegaron: 4, proveedor: 1, traspaso: 2, manual: 1, anteriores: 1,
      sin_abrir: 2, importe_sin_abrir: 1500, a_medias: 1, renglones_sin_fecha: 2,
      completas: 1, sin_caducidad: 1, por_autorizar: 1, en_camino: 1,
    });
  });
});
