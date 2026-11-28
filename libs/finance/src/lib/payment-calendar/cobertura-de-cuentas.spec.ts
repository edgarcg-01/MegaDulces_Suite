/**
 * `[PGP.233]` Qué cuentas impiden afirmar que un pago vencido no salió del banco.
 *
 * La misma condición que el `cubierto` de `SQL_SALIDA_DE_BANCO`, en una función pura para poder
 * NOMBRAR la cuenta (el SQL sólo devuelve un booleano). Vectores sintéticos con la forma de lo
 * medido en prod el 2026-11-27: una cuenta sin descarga nunca pero DORMIDA (`STDR 5565`), otra
 * viva con la descarga 8 días atrás (`STDR 1621`) y el resto al día.
 */
import { cuentasQueNoCubren, type FilaCoberturaDeCuenta } from './pagos-vencidos.sql';

const cta = (o: Partial<FilaCoberturaDeCuenta> & { id: string }): FilaCoberturaDeCuenta => ({
  cuenta: o.id, hasta: '2030-03-31', dormida: false, ...o,
});
const HOY = '2030-03-31';

describe('[PGP.233] cuentasQueNoCubren', () => {
  const alDia = cta({ id: 'AL-DIA' });
  const atrasada = cta({ id: 'ATRASADA', hasta: '2030-03-20' });
  const nuncaDormida = cta({ id: 'DORMIDA', hasta: null, dormida: true });
  const nuncaViva = cta({ id: 'VIVA-SIN-DESCARGA', hasta: null, dormida: false });

  it('sin cuenta preparada, una cuenta VIVA atrasada frena la medición y se nombra', () => {
    const r = cuentasQueNoCubren([alDia, atrasada], '2030-03-25', HOY, null);
    expect(r.map((c) => c.cuenta)).toEqual(['ATRASADA']);
  });

  it('⛔ la cuenta DORMIDA no frena nada (`[PGP.202]`): sin ella, todo pago sin preparar quedaba sin medir para siempre', () => {
    expect(cuentasQueNoCubren([alDia, nuncaDormida], '2030-03-25', HOY, null)).toEqual([]);
    // La misma cuenta sin descarga, pero VIVA, sí frena.
    expect(cuentasQueNoCubren([alDia, nuncaViva], '2030-03-25', HOY, null).map((c) => c.cuenta)).toEqual(['VIVA-SIN-DESCARGA']);
  });

  it('con cuenta preparada sólo cuenta ESA, aunque esté dormida', () => {
    expect(cuentasQueNoCubren([alDia, atrasada], '2030-03-25', HOY, 'AL-DIA')).toEqual([]);
    expect(cuentasQueNoCubren([alDia, nuncaDormida], '2030-03-25', HOY, 'DORMIDA').map((c) => c.cuenta)).toEqual(['DORMIDA']);
  });

  it('la descarga sólo tiene que llegar al día del pago + 3 (la ventana del banco), no a hoy', () => {
    // Pago del 10: le basta con que la descarga llegue al 13, aunque hoy sea 31.
    expect(cuentasQueNoCubren([cta({ id: 'C1', hasta: '2030-03-13' })], '2030-03-10', HOY, null)).toEqual([]);
    expect(cuentasQueNoCubren([cta({ id: 'C1', hasta: '2030-03-12' })], '2030-03-10', HOY, null).map((c) => c.cuenta)).toEqual(['C1']);
  });

  it('un pago de hoy mismo no exige descarga del futuro: el límite se corta en hoy', () => {
    expect(cuentasQueNoCubren([cta({ id: 'C1', hasta: HOY })], HOY, HOY, null)).toEqual([]);
  });

  it('sin cuentas, no inventa un bloqueo', () => {
    expect(cuentasQueNoCubren([], '2030-03-25', HOY, null)).toEqual([]);
  });
});
