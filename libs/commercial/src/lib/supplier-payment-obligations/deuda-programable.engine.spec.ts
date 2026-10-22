import { describe, expect, it } from 'vitest';
import { armarDeudaProgramable, nombreDocumento, type FilaDeudaCruda } from './deuda-programable.engine';

const AL = '2026-10-22';

const fila = (o: Partial<FilaDeudaCruda> & { folio: string; pendiente: number }): FilaDeudaCruda => ({
  sucursal: o.sucursal ?? '00',
  proveedor: o.proveedor ?? 'CD015',
  proveedor_nombre: o.proveedor_nombre ?? 'DISTRIBUIDORA DE LA ROSA SA DE CV',
  doc_tipo: o.doc_tipo ?? 20,
  doc_sub: o.doc_sub ?? 1,
  vencimiento: o.vencimiento ?? '2026-10-01',
  dias_vencido: o.dias_vencido ?? 21,
  anterior_al_corte: o.anterior_al_corte ?? false,
  supplier_id: o.supplier_id === undefined ? 'sup-1' : o.supplier_id,
  programado: o.programado ?? false,
  ...o,
});

describe('[PGP.6] armarDeudaProgramable', () => {
  it('ofrece lo no programado y publica la cobertura sobre TODA la deuda', () => {
    const r = armarDeudaProgramable(
      [fila({ folio: 'A', pendiente: 70, programado: true }), fila({ folio: 'B', pendiente: 20 }), fila({ folio: 'C', pendiente: 10 })],
      { limit: 100, al: AL },
    );
    expect(r.universo.documentos_total).toBe(3);
    expect(r.universo.pendiente_total).toBe(100);
    expect(r.universo.documentos_programados).toBe(1);
    expect(r.universo.pendiente_programado).toBe(70);
    // El denominador es el total, no lo que falta: así el avance se puede ver.
    expect(r.universo.pct_programado).toBe(70);
    expect(r.documentos.map((d) => d.folio)).toEqual(['B', 'C']);
  });

  it('⛔ la lista que se topa LO DICE — nunca afirma que no hay más', () => {
    const rows = Array.from({ length: 5 }, (_, i) => fila({ folio: `F${i}`, pendiente: 10 }));
    const corta = armarDeudaProgramable(rows, { limit: 2, al: AL });
    expect(corta.universo.mostrados).toBe(2);
    expect(corta.universo.hay_mas).toBe(true);

    const entera = armarDeudaProgramable(rows, { limit: 50, al: AL });
    expect(entera.universo.mostrados).toBe(5);
    expect(entera.universo.hay_mas).toBe(false);
  });

  it('el acreedor que no resuelve al catálogo se declara y NO se ofrece', () => {
    const r = armarDeudaProgramable(
      [fila({ folio: 'A', pendiente: 80 }), fila({ folio: 'X', pendiente: 20, supplier_id: null })],
      { limit: 100, al: AL },
    );
    // No se le puede crear obligación sin supplier_id: no se ofrece…
    expect(r.documentos.map((d) => d.folio)).toEqual(['A']);
    // …pero se cuenta y se dice, y su dinero sigue en el denominador.
    expect(r.universo.documentos_sin_catalogo).toBe(1);
    expect(r.universo.pendiente_sin_catalogo).toBe(20);
    expect(r.universo.pendiente_total).toBe(100);
    expect(r.documentos.every((d) => d.supplier_id)).toBe(true);
  });

  it('sin deuda: ceros medidos y lista vacía, con su fecha de corte', () => {
    const r = armarDeudaProgramable([], { limit: 100, al: AL });
    expect(r.universo.documentos_total).toBe(0);
    expect(r.universo.pendiente_total).toBe(0);
    expect(r.universo.pct_programado).toBe(0);
    expect(r.universo.hay_mas).toBe(false);
    expect(r.universo.al).toBe(AL);
    expect(r.documentos).toEqual([]);
  });

  it('todo programado: cobertura 100 % y nada que ofrecer', () => {
    const r = armarDeudaProgramable(
      [fila({ folio: 'A', pendiente: 60, programado: true }), fila({ folio: 'B', pendiente: 40, programado: true })],
      { limit: 100, al: AL },
    );
    expect(r.universo.pct_programado).toBe(100);
    expect(r.documentos).toEqual([]);
    expect(r.universo.hay_mas).toBe(false);
  });

  it('el documento se nombra en palabras, y el desconocido NO se inventa', () => {
    expect(nombreDocumento(20, 1)).toBe('Aplica Orden Entrada');
    expect(nombreDocumento(45, 1)).toBe('Nota cargo a proveedor');
    expect(nombreDocumento(99, 7)).toBe('Documento 99/7');
    const r = armarDeudaProgramable([fila({ folio: 'A', pendiente: 10, doc_tipo: 99, doc_sub: 7 })], { limit: 10, al: AL });
    expect(r.documentos[0].documento).toBe('Documento 99/7');
  });

  it('el dinero sale al centavo y la fecha en ISO, venga como venga del driver', () => {
    const r = armarDeudaProgramable(
      [fila({ folio: ' A ', pendiente: 10.005, vencimiento: '2026-10-01T06:00:00.000Z', dias_vencido: '21' as unknown as number })],
      { limit: 10, al: AL },
    );
    expect(r.documentos[0].pendiente).toBe(10.01);
    expect(r.documentos[0].vencimiento).toBe('2026-10-01');
    expect(r.documentos[0].dias_vencido).toBe(21);
    expect(r.documentos[0].folio).toBe('A');
  });

  it('un documento sin fecha de vencimiento se declara null, no se le pone hoy', () => {
    const r = armarDeudaProgramable(
      [fila({ folio: 'A', pendiente: 10, vencimiento: null, dias_vencido: null })],
      { limit: 10, al: AL },
    );
    expect(r.documentos[0].vencimiento).toBeNull();
    expect(r.documentos[0].dias_vencido).toBeNull();
  });
});
