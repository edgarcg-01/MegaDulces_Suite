/**
 * `[RH.1.5c]` Quién es promotora. Un falso positivo SACA a una persona de la medición de asistencia, así que lo que
 * se defiende es el caso que Mega Talento corrigió el 08/10/2026: «PROMOTORIA MEGA DULCES» es personal de piso.
 */
import { esDeptoDePromotoria, esPromotora } from './tipos';

describe('[RH.1.5c] promotoría de marca', () => {
  it('un departamento de promotoría de una marca es promotoría', () => {
    expect(esDeptoDePromotoria('PROMOTORIA RICOLINO')).toBe(true);
    expect(esDeptoDePromotoria('Zona Promotoria')).toBe(true);
    expect(esPromotora({ departamento: 'PROMOTORA DE MARCA' })).toBe(true);
  });

  it('⛔ «PROMOTORIA MEGA DULCES» NO: las paga Mega Dulces y se miden como personal', () => {
    expect(esDeptoDePromotoria('PROMOTORIA MEGA DULCES')).toBe(false);
    expect(esDeptoDePromotoria('Promotoría MegaDulces')).toBe(false);
    expect(esPromotora({ departamento: 'PROMOTORIA MEGA DULCES' })).toBe(false);
  });

  it('la casilla marcada manda aunque el departamento no diga nada', () => {
    expect(esPromotora({ es_promotora: true, departamento: 'CAJAS' })).toBe(true);
    expect(esPromotora({ departamento: null })).toBe(false);
    expect(esPromotora(null)).toBe(false);
  });
});
