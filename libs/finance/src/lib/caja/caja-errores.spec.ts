import { BadRequestException } from '@nestjs/common';
import { traducirErrorDeCaja } from './caja-errores';

/**
 * `[CG.154]` El traductor de errores del libro de caja.
 *
 * Sale de la auditoría E2E contra producción (hallazgo E4): glosa corta, `monto = 0` y un
 * `client_uuid` mal formado devolvían **500 Internal server error** con el SQL adentro.
 */
describe('[CG.154] traducirErrorDeCaja', () => {
  const lanzar = (e: unknown) => () => traducirErrorDeCaja(e);

  it('una regla conocida sale como 400 con su frase, no como 500', () => {
    expect(lanzar({ code: '23514', constraint: 'cash_ledger_glosa_chk' }))
      .toThrow(BadRequestException);
    try { traducirErrorDeCaja({ code: '23514', constraint: 'cash_ledger_glosa_chk' }); } catch (e) {
      expect((e as BadRequestException).message).toContain('al menos 5 caracteres');
    }
  });

  it('el monto en cero se explica en palabras', () => {
    try { traducirErrorDeCaja({ code: '23514', constraint: 'cash_ledger_monto_chk' }); } catch (e) {
      expect((e as BadRequestException).message).toContain('mayor que cero');
    }
  });

  it('un uuid mal formado (22P02) es culpa del dato, no del servidor', () => {
    expect(lanzar({ code: '22P02' })).toThrow(BadRequestException);
  });

  it('un CHECK sin frase escrita dice que es una regla del libro, SIN nombrarla', () => {
    try { traducirErrorDeCaja({ code: '23514', constraint: 'una_regla_que_nadie_mapeo' }); } catch (e) {
      const m = (e as BadRequestException).message;
      expect(m).toContain('reglas del libro de caja');
      // No se filtra el nombre de la constraint: es superficie que el cajero no tiene por qué ver.
      expect(m).not.toContain('una_regla_que_nadie_mapeo');
    }
  });

  it('⛔ PRUEBA NEGATIVA: lo desconocido NO se disfraza de 400 — se vuelve a lanzar tal cual', () => {
    // Es la aserción que da sentido a todas las de arriba. Un 400 genérico sobre una causa que
    // nadie entendió convierte un defecto del SERVIDOR en «el usuario escribió algo mal», que es
    // justo la mentira que este módulo viene arrastrando.
    const raro = Object.assign(new Error('connection terminated unexpectedly'), { code: '08006' });
    expect(lanzar(raro)).toThrow(raro);
    expect(lanzar(raro)).not.toThrow(BadRequestException);
  });

  it('[CGP-D.3] cada regla del corte que vive en la base tiene su frase', () => {
    // Si la migración renombra una regla y este mapa no se entera, la regla cae en la frase
    // genérica o, siendo un 23505, en un 500: esta prueba lo dice antes que la cajera.
    const reglas: Array<[string, string, string]> = [
      ['23514', 'cut_aritmetica_chk', 'contado menos el esperado'],
      ['23514', 'cut_conteo_sellado_chk', 'ya está sellado'],
      ['23514', 'cut_reconteo_constancia_chk', 'antes hubo un conteo'],
      ['23514', 'cut_firmado_inmutable_chk', 'no se reabre'],
      ['23514', 'cut_desglose_cuadra_chk', 'no suma lo que dice el contado'],
      ['23505', 'ux_cash_cut_sucursal_fecha', 'Ya existe un corte'],
    ];
    for (const [code, constraint, frase] of reglas) {
      expect(lanzar({ code, constraint })).toThrow(BadRequestException);
      expect(lanzar({ code, constraint })).toThrow(frase);
    }
  });

  it('⛔ nunca devuelve el mensaje crudo de Postgres', () => {
    const crudo = Object.assign(
      new Error('new row for relation "cash_ledger" violates check constraint "cash_ledger_monto_chk"'),
      { code: '23514', constraint: 'cash_ledger_monto_chk' },
    );
    try { traducirErrorDeCaja(crudo); } catch (e) {
      const m = (e as BadRequestException).message;
      expect(m).not.toContain('cash_ledger');
      expect(m).not.toContain('check constraint');
    }
  });
});
