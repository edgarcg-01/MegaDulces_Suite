import { diaDeFecha, diaMxDeInstante } from './dia-negocio.contract';

/**
 * `[CGP-L.5]` Las dos preguntas de fecha de la caja, probadas en TRES zonas horarias del proceso:
 * corré este archivo con `TZ=UTC`, `TZ=America/Mexico_City` y `TZ=Asia/Tokyo`. Tiene que dar lo mismo
 * en las tres: el día de una fecha no puede depender de dónde corre el servidor.
 */
describe('[CGP-L.5] diaDeFecha — qué día es una columna `date`', () => {
  it('un `date` de Postgres llega como medianoche LOCAL del proceso: se lee con sus componentes locales', () => {
    // Es exactamente lo que hace node-postgres con '2026-10-12' (sin parser propio en este repo).
    expect(diaDeFecha(new Date(2026, 9, 12))).toBe('2026-10-12');
  });

  it('un texto `YYYY-MM-DD` o ISO se toma tal cual', () => {
    expect(diaDeFecha('2026-10-12')).toBe('2026-10-12');
    expect(diaDeFecha('2026-10-12T00:00:00.000Z')).toBe('2026-10-12');
  });

  it('⛔ [negativa] `String(Date)` («Mon Oct 12 2026») NO es una fecha: se declara, no se recorta', () => {
    expect(diaDeFecha(String(new Date(2026, 9, 12)))).toBeNull();
    expect(diaDeFecha('basura')).toBeNull();
    expect(diaDeFecha(null)).toBeNull();
    expect(diaDeFecha(new Date(NaN))).toBeNull();
  });
});

describe('[CGP-L.5] diaMxDeInstante — qué día de NEGOCIO fue un instante', () => {
  it('⛔ un depósito a las 19:00 de México del 12-oct es del 12, aunque en UTC ya sea el 13', () => {
    expect(diaMxDeInstante('2026-10-13T01:00:00.000Z')).toBe('2026-10-12');
    expect(diaMxDeInstante(new Date('2026-10-13T01:00:00.000Z'))).toBe('2026-10-12');
  });

  it('a mediodía, el mismo día en las dos', () => {
    expect(diaMxDeInstante('2026-10-12T18:00:00.000Z')).toBe('2026-10-12');
  });

  it('sin instante usable, null', () => {
    expect(diaMxDeInstante(null)).toBeNull();
    expect(diaMxDeInstante('basura')).toBeNull();
  });
});
