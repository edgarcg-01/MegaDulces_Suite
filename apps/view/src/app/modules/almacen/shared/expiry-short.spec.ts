import { formatExpiryEcho, parseExpiryShort, maskExpiryMx, digitsOf } from './expiry-short';

describe('parseExpiryShort', () => {
  it('4 dígitos MMAA → último día de ese mes', () => {
    expect(parseExpiryShort('0327')).toBe('2027-03-31');
  });

  it('6 dígitos DDMMAA → esa fecha exacta', () => {
    expect(parseExpiryShort('150327')).toBe('2027-03-15');
  });

  it('mes inválido → null', () => {
    expect(parseExpiryShort('1327')).toBeNull();
    expect(parseExpiryShort('0027')).toBeNull();
    expect(parseExpiryShort('001227')).toBeNull(); // día 00
  });

  it('largo inválido → null', () => {
    expect(parseExpiryShort('032')).toBeNull();
    expect(parseExpiryShort('03271')).toBeNull();
    expect(parseExpiryShort('1234567')).toBeNull();
  });

  it('vacío o nulo → null, sin lanzar', () => {
    expect(parseExpiryShort('')).toBeNull();
    expect(parseExpiryShort(null)).toBeNull();
    expect(parseExpiryShort(undefined)).toBeNull();
    expect(parseExpiryShort('   ')).toBeNull();
  });

  it('febrero de año bisiesto da 29', () => {
    expect(parseExpiryShort('0228')).toBe('2028-02-29'); // 2028 bisiesto
  });

  it('febrero de año no bisiesto da 28', () => {
    expect(parseExpiryShort('0227')).toBe('2027-02-28');
  });

  it('el día se valida contra SU mes: 31 de febrero no existe', () => {
    // Sin esta regla, Date desbordaría a marzo y guardaría una caducidad falsa.
    expect(parseExpiryShort('310228')).toBeNull();
    expect(parseExpiryShort('310427')).toBeNull(); // abril tiene 30
    expect(parseExpiryShort('300427')).toBe('2027-04-30');
  });

  it('tolera separadores tecleados por costumbre', () => {
    expect(parseExpiryShort('03/27')).toBe('2027-03-31');
    expect(parseExpiryShort('15 03 27')).toBe('2027-03-15');
    expect(parseExpiryShort('15-03-27')).toBe('2027-03-15');
  });

  it('diciembre y enero no se corren de año', () => {
    expect(parseExpiryShort('1227')).toBe('2027-12-31');
    expect(parseExpiryShort('0127')).toBe('2027-01-31');
  });
});

describe('formatExpiryEcho', () => {
  it('ISO → DD/MM/AAAA', () => {
    expect(formatExpiryEcho('2027-03-31')).toBe('31/03/2027');
  });

  it('vacío o basura → cadena vacía', () => {
    expect(formatExpiryEcho(null)).toBe('');
    expect(formatExpiryEcho('')).toBe('');
    expect(formatExpiryEcho('31/03/2027')).toBe('');
  });
});

describe('parseExpiryShort — año completo (8 dígitos)', () => {
  it('acepta DDMMAAAA, que es lo que se teclea al ver la máscara DD/MM/AA', () => {
    expect(parseExpiryShort('15032027')).toBe('2027-03-15');
    expect(parseExpiryShort('30/04/2028')).toBe('2028-04-30');
  });

  it('sigue validando el día contra SU mes', () => {
    expect(parseExpiryShort('31022028')).toBeNull();
  });

  it('rechaza un año fuera del siglo — un dedazo no puede pasar como plazo bueno', () => {
    expect(parseExpiryShort('15032820')).toBeNull();
    expect(parseExpiryShort('15031999')).toBeNull();
  });

  it('no confunde largos: 5 o 7 dígitos siguen siendo incompletos', () => {
    expect(parseExpiryShort('1503202')).toBeNull();
    expect(parseExpiryShort('15032')).toBeNull();
  });

  describe('maskExpiryMx — la diagonal la pone el campo (formato MX)', () => {
    it('pone la diagonal en el 3er dígito, que es donde arranca el mes', () => {
      expect(maskExpiryMx('1')).toBe('1');
      expect(maskExpiryMx('15')).toBe('15');
      expect(maskExpiryMx('150')).toBe('15/0');
      expect(maskExpiryMx('1503')).toBe('15/03');
    });

    it('completa DD/MM/AAAA', () => {
      expect(maskExpiryMx('150320')).toBe('15/03/20');
      expect(maskExpiryMx('15032027')).toBe('15/03/2027');
    });

    it('NO deja diagonal colgando: borrar un dígito borra un dígito', () => {
      // Con "15/" al final, Backspace se come el separador y la máscara lo
      // repone: el operador borra dos veces para corregir el día.
      expect(maskExpiryMx('15')).not.toContain('/');
      expect(maskExpiryMx('1503')).not.toMatch(/\/$/);
    });

    it('ignora lo que el operador teclee de más (diagonales, letras, 9 dígitos)', () => {
      expect(maskExpiryMx('15/03/2027')).toBe('15/03/2027');
      expect(maskExpiryMx('15a03b2027')).toBe('15/03/2027');
      expect(maskExpiryMx('150320271')).toBe('15/03/2027');
    });

    it('tolera vacío y null (viene de un campo de captura)', () => {
      expect(maskExpiryMx('')).toBe('');
      expect(maskExpiryMx(null)).toBe('');
      expect(maskExpiryMx(undefined)).toBe('');
    });

    it('dibuja pero NO valida: el 31 de febrero se ve y el parser lo rechaza', () => {
      expect(maskExpiryMx('31022027')).toBe('31/02/2027');
      expect(parseExpiryShort(digitsOf('31/02/2027'))).toBeNull();
    });

    it('lo enmascarado y lo parseado leen los MISMOS dígitos', () => {
      expect(parseExpiryShort(digitsOf(maskExpiryMx('15032027')))).toBe('2027-03-15');
      // Y el atajo del empaque sin día sigue vivo: 4 dígitos = mes y año.
      expect(parseExpiryShort(digitsOf(maskExpiryMx('0327')))).toBe('2027-03-31');
    });
  });
});
