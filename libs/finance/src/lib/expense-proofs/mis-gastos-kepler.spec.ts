import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agruparGastosPorSolicitud, datosKeplerDeLaFila, llaveSolicitud } from './mis-gastos-kepler';

/**
 * `[GX.65.3]` — Candado de los datos de Kepler que «Mis gastos» publica para sus 3 columnas:
 * el proveedor por CLAVE y la lista de gastos `XA1001`. Son DATO: ninguno mueve el vale.
 */
describe('[GX.65.3] agruparGastosPorSolicitud', () => {
  it('una solicitud con varios gastos los trae TODOS, ordenados', () => {
    const m = agruparGastosPorSolicitud([
      { sucursal: '01', solicitud_folio: '0097020', doc_folio: '0097118' },
      { sucursal: '01', solicitud_folio: '0097020', doc_folio: '0097101' },
    ]);
    expect(m.get(llaveSolicitud('0097020', '01'))).toEqual(['0097101', '0097118']);
  });

  /**
   * ⛔ Prueba NEGATIVA: el mismo folio en otra plaza es OTRA solicitud. Desde el 1-oct cada
   * centro arrancó su serie en 0000001, así que juntar por folio solo mezclaría gastos ajenos.
   */
  it('⛔ el mismo folio en otra sucursal NO se mezcla', () => {
    const m = agruparGastosPorSolicitud([
      { sucursal: '01', solicitud_folio: '0000010', doc_folio: '0000011' },
      { sucursal: '06', solicitud_folio: '0000010', doc_folio: '0000099' },
    ]);
    expect(m.get(llaveSolicitud('0000010', '01'))).toEqual(['0000011']);
    expect(m.get(llaveSolicitud('0000010', '06'))).toEqual(['0000099']);
  });

  it('no duplica un gasto repetido y descarta filas sin folio', () => {
    const m = agruparGastosPorSolicitud([
      { sucursal: '01', solicitud_folio: '1', doc_folio: 'A' },
      { sucursal: '01', solicitud_folio: '1', doc_folio: 'A' },
      { sucursal: '01', solicitud_folio: '', doc_folio: 'B' },
      { sucursal: '01', solicitud_folio: '1', doc_folio: null },
    ]);
    expect(m.get(llaveSolicitud('1', '01'))).toEqual(['A']);
    expect(m.size).toBe(1);
  });

  it('la llave tolera espacios de Kepler', () => {
    expect(llaveSolicitud(' 0097012 ', '01 ')).toBe(llaveSolicitud('0097012', '01'));
  });
});

describe('[GX.65.3] datosKeplerDeLaFila', () => {
  const gastos = agruparGastosPorSolicitud([{ sucursal: '01', solicitud_folio: '0097012', doc_folio: '0097093' }]);

  it('publica clave, nombre y gastos', () => {
    expect(datosKeplerDeLaFila({ cuenta_clave: 'GS0044', acreedor: 'ACEROS Y REFACCIONES' }, gastos, '0097012', '01'))
      .toEqual({ proveedor_clave: 'GS0044', proveedor_nombre: 'ACEROS Y REFACCIONES', gasto_folios: ['0097093'] });
  });

  /** ⛔ Lo que no se leyó de Kepler se DECLARA en null: no se inventa con el nombre tecleado. */
  it('sin datos de Kepler declara null y lista vacía, no inventa', () => {
    expect(datosKeplerDeLaFila(undefined, gastos, '9999999', '01'))
      .toEqual({ proveedor_clave: null, proveedor_nombre: null, gasto_folios: [] });
    expect(datosKeplerDeLaFila({ cuenta_clave: '  ', acreedor: '' }, gastos, '0097012', '01').proveedor_clave).toBeNull();
  });

  it('devuelve una COPIA de la lista: quien la toque no ensucia el mapa compartido', () => {
    const r = datosKeplerDeLaFila(undefined, gastos, '0097012', '01');
    r.gasto_folios.push('X');
    expect(gastos.get(llaveSolicitud('0097012', '01'))).toEqual(['0097093']);
  });
});

/** Que el servicio de verdad lo cablee, y sin cambiar la etapa ni a las otras pantallas. */
describe('[GX.65.3] list() lo publica sólo en «lo mío»', () => {
  const soloCodigo = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const SERVICIO = soloCodigo(readFileSync(join(__dirname, 'expense-proofs.service.ts'), 'utf8'));

  it('los gastos se piden sólo cuando la lista es la de la persona', () => {
    expect(SERVICIO).toContain('q.mine ? await this.gastosPorSolicitud(trx, crudas)');
  });

  it('el puente es el mismo del Expediente: solicitud_folio + XA1001', () => {
    expect(SERVICIO).toContain(".where('doc_tipo', 'XA1001')");
    expect(SERVICIO).toContain(".whereIn('solicitud_folio', folios)");
  });

  it('las columnas del proveedor se piden sólo si existen en el entorno', () => {
    expect(SERVICIO).toContain("column_name IN ('cuenta_clave','acreedor')");
    expect(SERVICIO).toContain('...colsProv');
  });

  /** ⛔ La etapa NO se tocó: las pestañas de hoy siguen leyendo lo mismo. */
  it('⛔ la etapa sigue saliendo de conEtapa, igual que antes', () => {
    expect(SERVICIO).toContain('this.conEtapa(crudas, kep)');
  });
});
