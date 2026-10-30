import { describe, expect, it } from 'vitest';
import type { ResumenLote } from '../../cash-ledger.service';
import { money } from '../finanzas-format';
import { avisoDeReposicion } from './caja-reposicion.component';

/**
 * El aviso de «Reponer». Canindo 30/10 (2026-10-30): decía «0 de 1… 1 no se pudieron» y el servidor
 * sí había mandado el porqué; lo que importa es que el folio y el motivo lleguen a la pantalla.
 */
const HOJA = 'Va en la hoja de gastos de Zona Canindo: se paga con la hoja aprobada, en Finanzas › Gastos › Hoja de zona.';
const doc = (folio: string) => ({ origen_ref: `06|X-D-26|${folio}|0011`, doc_tipo: 'X-D-26', folio });
const lote = (p: Partial<ResumenLote>): ResumenLote => ({
  filas: [], guardados: 0, duplicados: 0, rechazados: 0, no_confirmables: 0, monto_guardado: 0, ...p,
});

describe('avisoDeReposicion · lo que no entró dice cuál y por qué', () => {
  it('Canindo 30/10: nombra el folio y el motivo del servidor, y se queda hasta cerrarlo', () => {
    const a = avisoDeReposicion(lote({
      filas: [{ origen_ref: '06|X-D-26|0000373|0011', estado: 'no_confirmable', motivo: HOJA }],
      no_confirmables: 1,
      retiro: { device: 'AST700-19758', external_id: 1818, ref: 'bono productividad canindo', libre_antes: 24220, tomado: 0, libre_despues: 24220, del_cajon: 0 },
    }), 1, [doc('0000373')]);
    expect(a.detail).toContain('No entró (sigue en la cola) — X-D-26 0000373: Va en la hoja de gastos de Zona Canindo');
    expect(a.detail).toContain('Finanzas › Gastos › Hoja de zona.');
    expect(a.severity).toBe('error');
    expect(a.sticky).toBe(true);
  });

  it('[negativa] nada guardado no presume un reparto: sin «CAOS $0.00, cajón $0.00»', () => {
    const a = avisoDeReposicion(lote({
      filas: [{ origen_ref: 'x', estado: 'rechazado', motivo: 'algo' }], rechazados: 1,
      retiro: { device: 'd', external_id: 1, ref: null, libre_antes: 10, tomado: 0, libre_despues: 10, del_cajon: 0 },
    }), 1, []);
    expect(a.detail).not.toContain('CAOS');
  });

  it('todo entró: verde, con lo que tomó del retiro y lo del cajón, y se va solo', () => {
    const a = avisoDeReposicion(lote({
      filas: [{ origen_ref: '06|X-D-26|0000373|0011', estado: 'guardado', folio: 'CG-1' }], guardados: 1, monto_guardado: 24229.73,
      retiro: { device: 'd', external_id: 1818, ref: null, libre_antes: 24220, tomado: 24220, libre_despues: 0, del_cajon: 9.73 },
    }), 1, [doc('0000373')]);
    expect(a.detail).toBe(`1 de 1 egresos guardados por ${money(24229.73)} · CAOS ${money(24220)}, cajón ${money(9.73)}.`);
    expect(a.severity).toBe('success');
    expect(a.sticky).toBe(false);
  });

  it('a medias: junta los folios por motivo y cuenta aparte lo que ya estaba capturado', () => {
    const a = avisoDeReposicion(lote({
      filas: [
        { origen_ref: '06|X-D-26|0000001|0011', estado: 'guardado', folio: 'CG-1' },
        { origen_ref: '06|X-D-26|0000002|0011', estado: 'rechazado', motivo: 'Falta el concepto.' },
        { origen_ref: '06|X-D-26|0000003|0011', estado: 'rechazado', motivo: 'Falta el concepto.' },
        { origen_ref: '06|X-D-26|0000004|0011', estado: 'duplicado', motivo: 'Otra persona confirmó este mismo documento.' },
      ],
      guardados: 1, rechazados: 2, duplicados: 1, monto_guardado: 100,
    }), 4, [doc('0000001'), doc('0000002'), doc('0000003'), doc('0000004')]);
    expect(a.detail).toContain('1 ya estaba capturado');
    expect(a.detail).toContain('2 no entraron (siguen en la cola) — X-D-26 0000002, X-D-26 0000003: Falta el concepto.');
    expect(a.severity).toBe('warn');
  });

  it('[negativa] un rechazo sin motivo lo dice, en vez de dejar el hueco', () => {
    const a = avisoDeReposicion(lote({ filas: [{ origen_ref: 'ref-suelta', estado: 'rechazado' }], rechazados: 1 }), 1, []);
    expect(a.detail).toContain('ref-suelta: el servidor no dijo por qué.');
  });
});
