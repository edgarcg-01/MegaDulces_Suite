import { describe, expect, it } from 'vitest';
import { VIEW_GRUPOS, WORK_VIEWS, numeroDePestana, type DatosDePestanas } from './bancos-shared';

/** `[CB.59]` La barra de Bancos por proceso: cada vista en un grupo, y el número de cada pestaña. */
const BASE: DatosDePestanas = { descargas: null, sinClasificar: null, descuadradas: null, conciliadoPct: null, conciliacionVieja: false };

describe('[CB.59] barra de Bancos por proceso', () => {
  it('cada vista vive en un grupo que existe, en el orden del trabajo', () => {
    const grupos = VIEW_GRUPOS.map((g) => g.key);
    expect(WORK_VIEWS.every((v) => grupos.includes(v.grupo))).toBe(true);
    expect(WORK_VIEWS.map((v) => v.key)).toEqual(['cierre', 'estados', 'ingresos', 'cuentas', 'conciliacion', 'cuadre', 'comisiones', 'concentrado', 'contpaqi']);
    // [CB.78] Capturas WhatsApp salió de la barra (0 capturas en toda su vida).
    expect(WORK_VIEWS.filter((v) => v.grupo === 'mas').map((v) => v.label)).toEqual(['Concentrado', 'Factoraje']);
  });

  it('Estados de cuenta: cuentas con descarga de las que tienen lector', () => {
    const n = numeroDePestana('estados', { ...BASE, descargas: [{ hasta: '2026-11-08', con_lector: true }, { hasta: null, con_lector: true }, { hasta: null, con_lector: false }] });
    expect(n).toEqual({ texto: '1/2', aria: '1 de 2 cuentas con su descarga', aviso: true });
  });

  it('[CB.64] Movimientos ya no es pestaña (es la ventana de Cuentas); Cuentas sólo lleva número cuando hay trabajo', () => {
    expect(WORK_VIEWS.some((v) => v.key === 'movimientos')).toBe(false);
    expect(numeroDePestana('movimientos', { ...BASE, sinClasificar: 266 })).toBeNull();
    expect(numeroDePestana('cuentas', { ...BASE, descuadradas: 3 })?.texto).toBe('3');
    expect(numeroDePestana('cuentas', { ...BASE, descuadradas: 0 })).toBeNull();
    // [BFU.4.5.13] Ingresos y egresos: lo que falta explicar; aviso sólo si algo va tarde, y sin medir no dice nada.
    expect(numeroDePestana('ingresos', { ...BASE, porLigar: { n: 565, atrasados: 216 } })).toEqual({ texto: '565', aria: '565 movimientos por explicar, 216 con más de 5 días hábiles', aviso: true });
    expect(numeroDePestana('ingresos', { ...BASE, porLigar: { n: 12, atrasados: 0 } })?.aviso).toBe(false);
    expect(numeroDePestana('ingresos', { ...BASE, porLigar: { n: 0, atrasados: 0 } })).toBeNull();
    expect(numeroDePestana('ingresos', { ...BASE, porLigar: null })).toBeNull();
  });

  it('[negativa] una conciliación vieja no se presenta como vigente, y una sin correr no es 0 %', () => {
    expect(numeroDePestana('conciliacion', { ...BASE, conciliadoPct: 81, conciliacionVieja: true })?.texto).toBe('81% · desactualizado');
    expect(numeroDePestana('conciliacion', { ...BASE, conciliadoPct: null })?.texto).toBe('sin correr');
    expect(numeroDePestana('conciliacion', { ...BASE, conciliadoPct: 81 })).toEqual({ texto: '81%', aria: '81% conciliado por monto', aviso: false });
  });

  it('[CB.77][negativa] mientras el estado no llega (o falló), la pestaña no dice «sin correr»: no lleva número', () => {
    expect(numeroDePestana('conciliacion', { ...BASE, conciliadoPct: null, conciliacionMedida: false })).toBeNull();
    expect(numeroDePestana('conciliacion', { ...BASE, conciliadoPct: null, conciliacionMedida: true })?.texto).toBe('sin correr');
  });

  it('[CB.62] Comisiones: los cargos listos, informativo; sin propuesta o sin listos, sin número', () => {
    expect(WORK_VIEWS.find((v) => v.key === 'comisiones')?.grupo).toBe('kepler');
    expect(numeroDePestana('comisiones', { ...BASE, comisionesListas: 8 })).toEqual({ texto: '8', aria: '8 cargos de comisión listos para Kepler', aviso: false });
    expect(numeroDePestana('comisiones', { ...BASE, comisionesListas: 0 })).toBeNull();
    expect(numeroDePestana('comisiones', { ...BASE, comisionesListas: null })).toBeNull();
  });
});
