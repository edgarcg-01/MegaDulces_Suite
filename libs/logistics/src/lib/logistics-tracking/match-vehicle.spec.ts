import { matchVehicle } from './logistics-tracking.service';

/**
 * `[EMB.55]` El rastreador se liga a su unidad por la placa que trae en el nombre del GPS. El caso
 * real: «FREIGHTLINER 882EW9» contra la unidad de Kepler `882-EW9` no empataba, y el camión pasó 40
 * días con su GPS fuera de la flota.
 */
describe('matchVehicle', () => {
  const flota = [
    { id: 'freightliner', plate: '882-EW9' },
    { id: 'international', plate: '55AB1M' },
    { id: 'nissan', plate: 'GA2027C' },
  ];

  it('empata la placa aunque Kepler la escriba con guiones y el GPS sin ellos', () => {
    expect(matchVehicle('FREIGHTLINER 882EW9', flota)).toBe('freightliner');
    expect(matchVehicle('INTERNATIONAL 55AB1M', flota)).toBe('international');
    expect(matchVehicle('NISSAN GA2027C (CAM)', flota)).toBe('nissan');
  });

  it('PRUEBA NEGATIVA: una placa que no está en la flota no liga a nada', () => {
    expect(matchVehicle('HINO 500-67BB9C', [...flota, { id: 'hino', plate: '69BB9C' }])).toBeNull();
    expect(matchVehicle('DESCONTINUADO', flota)).toBeNull();
  });

  it('PRUEBA NEGATIVA: si la placa normalizada empata con dos unidades vivas, no se adivina', () => {
    expect(matchVehicle('NISSAN GA2027C', [...flota, { id: 'cascaron', plate: 'GA-2027-C' }])).toBeNull();
  });
});
