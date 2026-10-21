import { escalaDeLectura } from './lectura-escala';

describe('[RE.44] el OCR leyó la misma cifra con el separador corrido', () => {
  it('los casos reales de prod', () => {
    expect(escalaDeLectura(22.5, 22500)).toBe(1000);   // EL FAROLITO
    expect(escalaDeLectura(48.85, 48850)).toBe(1000);  // MAURO ALFREDO VARGAS
    expect(escalaDeLectura(6.25, 6255)).toBe(1000);    // BOTANAS PAU: pierde centavos, dentro del 1%
    expect(escalaDeLectura(81.3, 8130)).toBe(100);     // PAPAS DEL HOGAR
    expect(escalaDeLectura(2671, 26567)).toBeNull();   // ×9.95: fuera del 1%, no se afirma
  });
  it('al revés también (el papel leído 1,000 veces más grande)', () => {
    expect(escalaDeLectura(22500, 22.5)).toBe(0.001);
  });
  it('PRUEBA NEGATIVA: la misma cifra NO es un error de escala (eso es cuadrar)', () => {
    expect(escalaDeLectura(22500, 22500)).toBeNull();
  });
  it('PRUEBA NEGATIVA: un dígito perdido no se disfraza de escala (×10 queda fuera a propósito)', () => {
    expect(escalaDeLectura(1538, 15388)).toBeNull(); // ENRIQUE LEON: perdió el último 8
    expect(escalaDeLectura(2800, 27800)).toBeNull(); // FABRICACION DE PALILLO: perdió el 7
  });
  it('sin dato, o con cero, no se afirma nada', () => {
    expect(escalaDeLectura(null, 100)).toBeNull();
    expect(escalaDeLectura(0, 100)).toBeNull();
    expect(escalaDeLectura(10, 0)).toBeNull();
  });
});
