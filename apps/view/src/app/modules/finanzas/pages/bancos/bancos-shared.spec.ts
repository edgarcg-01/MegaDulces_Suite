import { describe, expect, it } from 'vitest';
import { VIEW_GRUPOS, WORK_VIEWS, numeroDePestana, type DatosDePestanas } from './bancos-shared';

/** `[CB.59]` La barra de Bancos por proceso: cada vista en un grupo, y el número de cada pestaña. */
const BASE: DatosDePestanas = { descargas: null, sinClasificar: null, descuadradas: null, conciliadoPct: null, conciliacionVieja: false };

describe('[CB.59] barra de Bancos por proceso', () => {
  it('cada vista vive en un grupo que existe, en el orden del trabajo', () => {
    const grupos = VIEW_GRUPOS.map((g) => g.key);
    expect(WORK_VIEWS.every((v) => grupos.includes(v.grupo))).toBe(true);
    expect(WORK_VIEWS.map((v) => v.key)).toEqual(['cierre', 'estados', 'movimientos', 'cuentas', 'conciliacion', 'cuadre', 'comisiones', 'concentrado', 'contpaqi', 'capturas']);
    expect(WORK_VIEWS.filter((v) => v.grupo === 'mas').map((v) => v.label)).toEqual(['Concentrado', 'Factoraje', 'Capturas WhatsApp']);
  });

  it('Estados de cuenta: cuentas con descarga de las que tienen lector', () => {
    const n = numeroDePestana('estados', { ...BASE, descargas: [{ hasta: '2026-11-08', con_lector: true }, { hasta: null, con_lector: true }, { hasta: null, con_lector: false }] });
    expect(n).toEqual({ texto: '1/2', aria: '1 de 2 cuentas con su descarga', aviso: true });
  });

  it('Movimientos y Cuentas sólo llevan número cuando hay trabajo', () => {
    expect(numeroDePestana('movimientos', { ...BASE, sinClasificar: 266 })?.aria).toBe('266 sin clasificar');
    expect(numeroDePestana('movimientos', { ...BASE, sinClasificar: 0 })).toBeNull();
    expect(numeroDePestana('cuentas', { ...BASE, descuadradas: 3 })?.texto).toBe('3');
    expect(numeroDePestana('cuentas', { ...BASE, descuadradas: 0 })).toBeNull();
  });

  it('[negativa] una conciliación vieja no se presenta como vigente, y una sin correr no es 0 %', () => {
    expect(numeroDePestana('conciliacion', { ...BASE, conciliadoPct: 81, conciliacionVieja: true })?.texto).toBe('81% · desactualizado');
    expect(numeroDePestana('conciliacion', { ...BASE, conciliadoPct: null })?.texto).toBe('sin correr');
    expect(numeroDePestana('conciliacion', { ...BASE, conciliadoPct: 81 })).toEqual({ texto: '81%', aria: '81% conciliado por monto', aviso: false });
  });

  it('[CB.62] Comisiones: los cargos listos, informativo; sin propuesta o sin listos, sin número', () => {
    expect(WORK_VIEWS.find((v) => v.key === 'comisiones')?.grupo).toBe('kepler');
    expect(numeroDePestana('comisiones', { ...BASE, comisionesListas: 8 })).toEqual({ texto: '8', aria: '8 cargos de comisión listos para Kepler', aviso: false });
    expect(numeroDePestana('comisiones', { ...BASE, comisionesListas: 0 })).toBeNull();
    expect(numeroDePestana('comisiones', { ...BASE, comisionesListas: null })).toBeNull();
  });
});
