import {
  decidirCancelar, decidirFirmar, decidirTomar, decidirUsar, estadoVigente, statusDeFallo, telefonoValido,
  type FilaFirma,
} from './caja-firma-solicitud.engine';

/**
 * `[CG.200]` Una prueba por transición VÁLIDA y una por cada PROHIBIDA.
 *
 * ⚠️ PRUEBA NEGATIVA (corrida el 2026-10-23): quitando la comparación de teléfono de `decidirTomar`,
 * se pone roja «otro teléfono no ve el contexto» (1 de 19). `decidirFirmar` tiene la suya propia.
 */
const AHORA = new Date('2026-10-23T18:00:00Z');
const LUEGO = new Date('2026-10-24T03:00:00Z');   // pasó el vencimiento de abajo
const fila = (o: Partial<FilaFirma> = {}): FilaFirma => ({
  estado: 'abierta', expira_at: '2026-10-24T02:00:00Z', telefono_id: null, monto: 1250.5, tipo: 'gasto', ...o,
});
const TEL = 'tel_AAAAAAAA';
const OTRO = 'tel_BBBBBBBB';

describe('[CG.200] estado vigente', () => {
  it('abierta y tomada vencen con el reloj; firmada, usada y cancelada no', () => {
    expect(estadoVigente(fila(), LUEGO)).toBe('vencida');
    expect(estadoVigente(fila({ estado: 'tomada', telefono_id: TEL }), LUEGO)).toBe('vencida');
    expect(estadoVigente(fila({ estado: 'firmada', telefono_id: TEL }), LUEGO)).toBe('firmada');
    expect(estadoVigente(fila({ estado: 'usada', telefono_id: TEL }), LUEGO)).toBe('usada');
    expect(estadoVigente(fila({ estado: 'cancelada' }), LUEGO)).toBe('cancelada');
    expect(estadoVigente(fila(), AHORA)).toBe('abierta');
  });

  it('el id del teléfono se acota antes de creerle', () => {
    expect(telefonoValido(TEL)).toBe(true);
    for (const x of ['', 'corto', 'a'.repeat(65), 'con espacio 1234', null, 12345678, "x'; drop--"]) {
      expect(telefonoValido(x), String(x)).toBe(false);
    }
  });
});

describe('[CG.200] tomar (el teléfono abre el QR)', () => {
  it('abierta → la toma este teléfono', () => {
    expect(decidirTomar(fila(), TEL, AHORA)).toEqual({ ok: true, accion: 'tomar' });
  });
  it('⭐ el MISMO teléfono que vuelve (bloqueo, recarga) no es un segundo uso', () => {
    expect(decidirTomar(fila({ estado: 'tomada', telefono_id: TEL }), TEL, AHORA)).toEqual({ ok: true, accion: 'ver' });
  });
  it('el mismo teléfono después de firmar oye «ya quedó», no «firma otra vez»', () => {
    expect(decidirTomar(fila({ estado: 'firmada', telefono_id: TEL }), TEL, AHORA)).toEqual({ ok: true, accion: 'ver_firmada' });
  });
  it('⛔ otro teléfono no ve el contexto', () => {
    expect(decidirTomar(fila({ estado: 'tomada', telefono_id: TEL }), OTRO, AHORA)).toEqual({ ok: false, fallo: 'otro_telefono' });
    expect(decidirTomar(fila({ estado: 'firmada', telefono_id: TEL }), OTRO, AHORA)).toEqual({ ok: false, fallo: 'otro_telefono' });
  });
  it('⛔ no existe · vencida · cancelada · ya usada', () => {
    expect(decidirTomar(null, TEL, AHORA)).toEqual({ ok: false, fallo: 'no_existe' });
    expect(decidirTomar(fila(), TEL, LUEGO)).toEqual({ ok: false, fallo: 'vencida' });
    expect(decidirTomar(fila({ estado: 'cancelada' }), TEL, AHORA)).toEqual({ ok: false, fallo: 'cancelada' });
    expect(decidirTomar(fila({ estado: 'usada', telefono_id: TEL }), TEL, AHORA)).toEqual({ ok: false, fallo: 'ya_usada' });
  });
});

describe('[CG.200] firmar (el teléfono manda el trazo)', () => {
  it('tomada por este teléfono + PNG válido → se guarda', () => {
    expect(decidirFirmar(fila({ estado: 'tomada', telefono_id: TEL }), TEL, true, AHORA)).toEqual({ ok: true, accion: 'guardar' });
  });
  it('abierta (reintento sin haber tomado, p. ej. tras un reinicio) también se guarda', () => {
    expect(decidirFirmar(fila(), TEL, true, AHORA)).toEqual({ ok: true, accion: 'guardar' });
  });
  it('⭐ IDEMPOTENTE: firmar otra vez desde el mismo teléfono contesta OK y no pisa', () => {
    expect(decidirFirmar(fila({ estado: 'firmada', telefono_id: TEL }), TEL, true, AHORA)).toEqual({ ok: true, accion: 'repetida' });
    // aunque el segundo trazo venga vacío: el primero ya manda
    expect(decidirFirmar(fila({ estado: 'firmada', telefono_id: TEL }), TEL, false, AHORA)).toEqual({ ok: true, accion: 'repetida' });
    // y aunque ya se haya usado: el acuse del primer envío pudo perderse
    expect(decidirFirmar(fila({ estado: 'usada', telefono_id: TEL }), TEL, true, AHORA)).toEqual({ ok: true, accion: 'repetida' });
  });
  it('⛔ otro teléfono no firma', () => {
    expect(decidirFirmar(fila({ estado: 'tomada', telefono_id: TEL }), OTRO, true, AHORA)).toEqual({ ok: false, fallo: 'otro_telefono' });
    expect(decidirFirmar(fila({ estado: 'firmada', telefono_id: TEL }), OTRO, true, AHORA)).toEqual({ ok: false, fallo: 'otro_telefono' });
  });
  it('⛔ PNG inválido · vencida · cancelada · no existe', () => {
    expect(decidirFirmar(fila({ estado: 'tomada', telefono_id: TEL }), TEL, false, AHORA)).toEqual({ ok: false, fallo: 'no_es_firma' });
    expect(decidirFirmar(fila({ estado: 'tomada', telefono_id: TEL }), TEL, true, LUEGO)).toEqual({ ok: false, fallo: 'vencida' });
    expect(decidirFirmar(fila({ estado: 'cancelada' }), TEL, true, AHORA)).toEqual({ ok: false, fallo: 'cancelada' });
    expect(decidirFirmar(null, TEL, true, AHORA)).toEqual({ ok: false, fallo: 'no_existe' });
  });
});

describe('[CG.200] usar (la PC guarda el movimiento con la firma)', () => {
  const firmada = fila({ estado: 'firmada', telefono_id: TEL });
  it('firmada + mismo tipo + mismo monto → se usa', () => {
    expect(decidirUsar(firmada, 'gasto', 1250.5)).toEqual({ ok: true, accion: 'usar' });
  });
  it('⭐ una firma firmada no vence: se puede guardar pasada la hora', () => {
    expect(estadoVigente(firmada, LUEGO)).toBe('firmada');
    expect(decidirUsar(firmada, 'gasto', 1250.5)).toEqual({ ok: true, accion: 'usar' });
  });
  it('⛔ monto distinto (aunque sea un centavo) o tipo distinto', () => {
    expect(decidirUsar(firmada, 'gasto', 1250.51)).toEqual({ ok: false, fallo: 'monto_distinto' });
    expect(decidirUsar(firmada, 'ingreso', 1250.5)).toEqual({ ok: false, fallo: 'monto_distinto' });
  });
  it('⛔ dos veces · sin firmar · cancelada · no existe', () => {
    expect(decidirUsar(fila({ estado: 'usada', telefono_id: TEL }), 'gasto', 1250.5)).toEqual({ ok: false, fallo: 'ya_usada' });
    expect(decidirUsar(fila({ estado: 'tomada', telefono_id: TEL }), 'gasto', 1250.5)).toEqual({ ok: false, fallo: 'no_firmada' });
    expect(decidirUsar(fila(), 'gasto', 1250.5)).toEqual({ ok: false, fallo: 'no_firmada' });
    expect(decidirUsar(fila({ estado: 'cancelada' }), 'gasto', 1250.5)).toEqual({ ok: false, fallo: 'cancelada' });
    expect(decidirUsar(null, 'gasto', 1)).toEqual({ ok: false, fallo: 'no_existe' });
  });
});

describe('[CG.200] cancelar', () => {
  it('abierta, tomada o firmada sin usar → se cancela; cancelar dos veces no es error', () => {
    for (const estado of ['abierta', 'tomada', 'firmada'] as const) {
      expect(decidirCancelar(fila({ estado, telefono_id: TEL }))).toEqual({ ok: true, accion: 'cancelar' });
    }
    expect(decidirCancelar(fila({ estado: 'cancelada' }))).toEqual({ ok: true, accion: 'ya_cancelada' });
  });
  it('⛔ lo usado ya es parte de un movimiento', () => {
    expect(decidirCancelar(fila({ estado: 'usada', telefono_id: TEL }))).toEqual({ ok: false, fallo: 'ya_usada' });
  });
});

describe('[CG.204] un código HTTP por causa', () => {
  it('cada fallo tiene el suyo', () => {
    expect(statusDeFallo('no_existe')).toBe(404);
    expect(statusDeFallo('vencida')).toBe(410);
    expect(statusDeFallo('otro_telefono')).toBe(409);
    expect(statusDeFallo('no_es_firma')).toBe(422);
  });
});
