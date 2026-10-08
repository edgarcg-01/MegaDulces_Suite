import { readFileSync } from 'fs';
import { join } from 'path';
import { BadRequestException } from '@nestjs/common';
import { UX_CAPTURAS_CLIENT_UUID, UX_SESIONES_CLIENT_UUID, conLlave, esChoqueDe } from './receiving-idempotency';

/**
 * `[WMS-REC.19]` — **La llave de reintento del Andén.**
 *
 * Con poco internet el equipo reintenta. Lo que se cuida acá es que reintentar no duplique:
 * la captura escribe EXISTENCIA, así que una captura repetida es mercancía contada dos veces.
 * El comportamiento contra una base real lo prueba aparte la prueba local con transacción
 * revertida; acá van las reglas que se pueden romper sin base.
 */
const SESION = readFileSync(join(__dirname, 'receiving-session.service.ts'), 'utf8');
const AUDITOR = readFileSync(join(__dirname, 'receiving-auditor.service.ts'), 'utf8');
const MIGRACION = readFileSync(
  join(__dirname, '../../../../../database/migrations-newdb/20261007213847_receiving_client_uuid.js'),
  'utf8',
);

/** El cuerpo de un método, desde su firma hasta la siguiente firma de método del mismo nivel. */
function cuerpo(fuente: string, firma: string): string {
  const i = fuente.indexOf(firma);
  if (i < 0) throw new Error(`No existe ${firma}`);
  const resto = fuente.slice(i + firma.length);
  const sig = resto.search(/\n {2}(?:private |async |static )?[a-zA-Z]+\(/);
  return fuente.slice(i, sig < 0 ? fuente.length : i + firma.length + sig);
}

describe('[WMS-REC.19] la llave', () => {
  it('sin llave es una operación nueva, como antes', () => {
    expect(conLlave(undefined)).toBe(false);
    expect(conLlave(null)).toBe(false);
    expect(conLlave('')).toBe(false);
  });

  it('una llave bien formada se acepta', () => {
    expect(conLlave('3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c')).toBe(true);
  });

  it('una llave mal formada es un 400, no un 500 ni una operación sin llave', () => {
    expect(() => conLlave('no-es-uuid')).toThrow(BadRequestException);
  });

  it('sólo el choque de SU índice cuenta como reintento', () => {
    expect(esChoqueDe({ code: '23505', constraint: UX_CAPTURAS_CLIENT_UUID }, UX_CAPTURAS_CLIENT_UUID)).toBe(true);
    // El folio del vale también es único: chocar ahí NO es un reintento y no se debe tragar.
    expect(esChoqueDe({ code: '23505', constraint: 'commercial_recv_sessions_folio_unique' }, UX_SESIONES_CLIENT_UUID)).toBe(false);
    expect(esChoqueDe({ code: '23503', constraint: UX_CAPTURAS_CLIENT_UUID }, UX_CAPTURAS_CLIENT_UUID)).toBe(false);
    expect(esChoqueDe(null, UX_CAPTURAS_CLIENT_UUID)).toBe(false);
  });

  it('los índices que el código espera son los que crea la migración', () => {
    expect(MIGRACION).toContain(`indice: '${UX_SESIONES_CLIENT_UUID}'`);
    expect(MIGRACION).toContain(`indice: '${UX_CAPTURAS_CLIENT_UUID}'`);
    expect(MIGRACION).toMatch(/ON commercial\.\$\{tabla\} \(tenant_id, client_uuid\)\s+WHERE client_uuid IS NOT NULL/);
  });
});

describe('[WMS-REC.19] abrir el vale', () => {
  const abrir = cuerpo(SESION, 'private abrir(');

  it('el extractor encuentra el método de verdad', () => {
    expect(abrir.length).toBeGreaterThan(500);
    expect(abrir).toContain('folio_ya_recibido');
  });

  it('el reintento se contesta ANTES del guardia de folio ya recibido', () => {
    // Al revés, el equipo que reintenta recibiría un 409 por el vale que él mismo abrió.
    expect(abrir.indexOf('sesionPorLlave(trx, clientUuid)')).toBeGreaterThan(-1);
    expect(abrir.indexOf('sesionPorLlave(trx, clientUuid)')).toBeLessThan(abrir.indexOf('folio_ya_recibido'));
  });

  it('la llave se guarda en el vale, y SÓLO cuando viene', () => {
    // Sin el condicional, abrir un vale fallaría para TODOS si el código llega a prod antes
    // que la migración: el INSERT nombraría una columna que todavía no existe.
    expect(abrir).toContain('...(clientUuid ? { client_uuid: clientUuid } : {})');
  });
});

describe('[WMS-REC.19] fechar una caducidad', () => {
  const evaluar = cuerpo(AUDITOR, 'async evaluate(');

  it('el extractor encuentra el método de verdad', () => {
    expect(evaluar).toContain('writeStockForCapture');
  });

  it('el reintento se contesta antes de subir la foto', () => {
    expect(evaluar.indexOf('capturaPorLlave(clientUuid)')).toBeGreaterThan(-1);
    expect(evaluar.indexOf('capturaPorLlave(clientUuid)')).toBeLessThan(evaluar.indexOf('storage.putFile'));
  });

  it('el reintento NO vuelve a escribir stock: devuelve la captura tal como está', () => {
    const bloque = evaluar.slice(evaluar.indexOf('if (clientUuid) {'), evaluar.indexOf('const confirmedLot'));
    expect(bloque).toContain('return this.getCapture(previa)');
    expect(bloque).not.toContain('writeStockForCapture');
  });

  it('si el alta de stock falla, la captura se revierte y SUELTA la llave', () => {
    // Sin soltarla, cada reintento recibiría la captura muerta y la mercancía no entraría nunca.
    const comp = evaluar.slice(evaluar.indexOf("status: 'rejected'"), evaluar.indexOf("status: 'rejected'") + 200);
    expect(comp).toContain('...(clientUuid ? { client_uuid: null } : {})');
  });

  it('la llave se guarda en la captura, y SÓLO cuando viene', () => {
    expect(cuerpo(AUDITOR, 'private guardarCaptura(')).toContain('...(clientUuid ? { client_uuid: clientUuid } : {})');
  });

  it('sin llave, ni evaluate ni open nombran la columna nueva (el código no depende del orden de despliegue)', () => {
    // Cada mención de `client_uuid` en un INSERT/UPDATE tiene que estar detrás del condicional.
    for (const fuente of [SESION, AUDITOR]) {
      const sueltas = fuente.split('\n').filter((l) => /client_uuid:/.test(l) && !/clientUuid \?/.test(l) && !/where\(/.test(l));
      expect(sueltas).toEqual([]);
    }
  });
});
