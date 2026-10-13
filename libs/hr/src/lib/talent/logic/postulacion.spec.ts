/**
 * `[RH.2.4]` Las reglas de una postulación (corren en CI, sin base). Decididas con David el 13-oct-2026.
 */
import { DIAS_PARA_REPOSTULAR, decidirPostulacion, mismaVacante, respuestaPublica, type ProcesoExistente } from './postulacion';

const AHORA = new Date('2026-10-13T18:00:00Z');
const hace = (dias: number) => new Date(AHORA.getTime() - dias * 86_400_000).toISOString();
const p = (o: Partial<ProcesoExistente> = {}): ProcesoExistente => ({
  id: 'c1', stage: 'filtro_inicial', job_posting_id: 'v-cajera', position_interest: null, job_posting_name: 'Cajera',
  deleted_at: null, is_spam: false, no_rehire: false, cerrado_en: null, created_at: hace(5), ...o,
});
const CAJERA = { job_posting_id: 'v-cajera', job_posting_name: 'Cajera', position_interest: null };
const ALMACEN = { job_posting_id: 'v-almacen', job_posting_name: 'Almacenista', position_interest: null };

describe('[RH.2.4] misma vacante', () => {
  it('por id cuando los dos lo tienen; si no, por el texto normalizado', () => {
    expect(mismaVacante(CAJERA, { ...CAJERA })).toBe(true);
    expect(mismaVacante(CAJERA, ALMACEN)).toBe(false);
    // El bot manda el puesto como lo escribió la persona.
    expect(mismaVacante({ job_posting_id: null, position_interest: '  CAJERA. ' }, CAJERA)).toBe(true);
    expect(mismaVacante({ job_posting_id: null, position_interest: 'Cajéra' }, { job_posting_id: null, position_interest: 'cajera' })).toBe(true);
  });
  it('⛔ NEGATIVA — sin dato no es «la misma»', () => {
    expect(mismaVacante({ job_posting_id: null, position_interest: null }, { job_posting_id: null, position_interest: null })).toBe(false);
  });
});

describe('[RH.2.4] decidir', () => {
  it('nadie con ese teléfono → se crea', () => {
    expect(decidirPostulacion([], CAJERA, AHORA)).toEqual({ accion: 'crear', en_lista_negra: false });
  });

  it('⭐ en proceso para la MISMA vacante → se rechaza (el duplicado se bota)', () => {
    expect(decidirPostulacion([p()], CAJERA, AHORA)).toMatchObject({ accion: 'rechazar', motivo: 'en_proceso_misma_vacante', candidato_id: 'c1' });
  });

  it('⭐ en proceso para OTRA vacante → también se rechaza: un proceso a la vez', () => {
    expect(decidirPostulacion([p()], ALMACEN, AHORA)).toMatchObject({ accion: 'rechazar', motivo: 'en_proceso_otra_vacante', vacante: 'Cajera' });
  });

  it('lo que no cuenta como proceso abierto: papelera, spam, cerrado', () => {
    const viejos = [p({ id: 'a', deleted_at: hace(1) }), p({ id: 'b', is_spam: true }), p({ id: 'c', stage: 'rechazado', cerrado_en: hace(200) })];
    expect(decidirPostulacion(viejos, CAJERA, AHORA).accion).toBe('crear');
  });

  it(`⭐ la misma vacante cerrada hace menos de ${DIAS_PARA_REPOSTULAR} días → se rechaza y dice desde cuándo`, () => {
    const d = decidirPostulacion([p({ stage: 'rechazado', cerrado_en: hace(30) })], CAJERA, AHORA);
    expect(d).toMatchObject({ accion: 'rechazar', motivo: 'cerrada_hace_poco' });
    expect(d.accion === 'rechazar' && d.puede_desde?.slice(0, 10)).toBe(new Date(AHORA.getTime() + 60 * 86_400_000).toISOString().slice(0, 10));
  });

  it('pasados los 90 días, o a OTRA vacante después de cerrado, sí se acepta', () => {
    expect(decidirPostulacion([p({ stage: 'rechazado', cerrado_en: hace(91) })], CAJERA, AHORA).accion).toBe('crear');
    expect(decidirPostulacion([p({ stage: 'contratado', cerrado_en: hace(10) })], ALMACEN, AHORA).accion).toBe('crear');
  });

  it('sin fecha de cierre se mide desde su alta (no se le regala la espera)', () => {
    expect(decidirPostulacion([p({ stage: 'rechazado', cerrado_en: null, created_at: hace(20) })], CAJERA, AHORA).accion).toBe('rechazar');
  });

  it('el más reciente de los abiertos es el que se reporta', () => {
    const d = decidirPostulacion([p({ id: 'viejo', created_at: hace(40) }), p({ id: 'nuevo', created_at: hace(2) })], CAJERA, AHORA);
    expect(d.accion === 'rechazar' && d.candidato_id).toBe('nuevo');
  });

  it('lista negra: se detecta aunque el registro marcado esté cerrado o en la papelera', () => {
    expect(decidirPostulacion([p({ stage: 'rechazado', cerrado_en: hace(400), no_rehire: true, deleted_at: hace(300) })], CAJERA, AHORA))
      .toEqual({ accion: 'crear', en_lista_negra: true });
  });
});

describe('[RH.2.4] lo que se le contesta a la persona', () => {
  const enProceso = decidirPostulacion([p()], ALMACEN, AHORA);
  it('⛔ por la web NO se nombra la vacante (cualquiera teclea el teléfono de otro)', () => {
    const t = respuestaPublica(enProceso, false);
    expect(t).not.toContain('Cajera');
    expect(t).toContain('un proceso a la vez');
  });
  it('por WhatsApp sí, porque el teléfono es de quien escribe', () => {
    expect(respuestaPublica(enProceso, true)).toContain('Cajera');
  });
  it('⛔ la lista negra nunca se menciona', () => {
    const d = decidirPostulacion([p({ stage: 'rechazado', cerrado_en: hace(400), no_rehire: true })], CAJERA, AHORA);
    for (const w of [false, true]) expect(respuestaPublica(d, w).toLowerCase()).not.toMatch(/negra|recontrat/);
  });
});
