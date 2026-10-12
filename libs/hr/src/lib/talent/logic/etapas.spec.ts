/**
 * `[RH.2.2]` Las reglas puras de reclutamiento (corren en CI, sin base).
 */
import { esApartado, esEtapaDestino, etapaDe, fusion, motivoValido, tieneCv, ETAPAS_VIGENTES } from './etapas';

describe('[RH.2.2] etapas', () => {
  it('las 4 etapas vigentes en el orden de Mega Talento', () => {
    expect(ETAPAS_VIGENTES).toEqual(['filtro_inicial', 'entrevista_rh', 'aptitudes', 'psicometria']);
  });

  it('las etapas viejas se leen en su vigente (copia de normalizar() de etapa.ts)', () => {
    expect(etapaDe('contacto_pendiente')).toBe('filtro_inicial');
    expect(etapaDe('entrevista')).toBe('entrevista_rh');
    expect(etapaDe('nuevo')).toBe('filtro_inicial');
    expect(etapaDe('entrevista_jefe')).toBe('aptitudes');
    expect(etapaDe('documental')).toBe('psicometria');
    expect(etapaDe('oferta')).toBe('psicometria');
    expect(etapaDe('dictamen')).toBe('psicometria');
  });

  it('sin etapa o desconocida → filtro inicial; los desenlaces se respetan', () => {
    expect(etapaDe(null)).toBe('filtro_inicial');
    expect(etapaDe('  ')).toBe('filtro_inicial');
    expect(etapaDe('cualquier_cosa')).toBe('filtro_inicial');
    expect(etapaDe('contratado')).toBe('contratado');
    expect(etapaDe('rechazado')).toBe('rechazado');
  });

  it('⛔ NEGATIVA — una etapa vieja no es destino: no se escribe', () => {
    expect(esEtapaDestino('aptitudes')).toBe(true);
    expect(esEtapaDestino('contratado')).toBe(true);
    expect(esEtapaDestino('dictamen')).toBe(false);
    expect(esEtapaDestino('entrevista')).toBe(false);
    expect(esEtapaDestino(undefined)).toBe(false);
  });

  it('apartados', () => {
    expect(['postulados', 'en_proceso', 'spam', 'no_recontratables', 'papelera'].every(esApartado)).toBe(true);
    expect(esApartado('todos')).toBe(false);
  });
});

describe('[RH.2.2] ¿tiene CV?', () => {
  it('el de la web o el que llegó por WhatsApp (slot o tipo «cv»)', () => {
    expect(tieneCv({ cv_url: 'https://x/cv.pdf' })).toBe(true);
    expect(tieneCv({ cv_url: '  ', documents: [{ slot: 'cv', url: 'https://x' }] })).toBe(true);
    expect(tieneCv({ documents: [{ tipo: 'cv', archivo_local: '/data/media/a.pdf' }] })).toBe(true);
    expect(tieneCv({ documents: [{ slot: 'ine', url: 'https://x' }] })).toBe(false);
    expect(tieneCv({ documents: [{ slot: 'cv', url: '' }] })).toBe(false);
    expect(tieneCv({ documents: 'no-es-lista' })).toBe(false);
  });
});

describe('[RH.2.2] motivo', () => {
  it('obligatorio, sin espacios, recortado a 500', () => {
    expect(motivoValido('  abandonó el puesto ')).toBe('abandonó el puesto');
    expect(motivoValido('  ')).toBeNull();
    expect(motivoValido('ok')).toBeNull();
    expect(motivoValido(undefined)).toBeNull();
    expect(motivoValido('x'.repeat(600))?.length).toBe(500);
  });
});

describe('[RH.2.2] fusión', () => {
  const bot = {
    full_name: 'Ana Pérez', phone: '5213511234567', cv_url: null, bot_state: 'esperando_cv', stage: null,
    documents: [{ slot: 'ine', url: 'https://w/ine.jpg' }, { slot: 'cv', url: 'https://w/cv.pdf' }],
    portal_data: { dictamen: 'apto', riesgo: 'bajo' }, created_at: '2026-08-01T10:00:00Z', last_activity_at: '2026-08-03T10:00:00Z',
    legacy_portal_id: 'FireStoreId0000000001',
  };
  const portal = {
    full_name: 'Ana Pérez López', phone: '3511234567', cv_url: 'https://c/cv.pdf', bot_state: null, stage: 'aptitudes',
    documents: [{ slot: 'cv', url: 'https://w/cv.pdf' }],
    portal_data: { riesgo: 'medio', solicitud: { ok: true } }, created_at: '2026-08-02T10:00:00Z', last_activity_at: '2026-08-02T10:00:00Z',
    legacy_portal_id: null,
  };

  it('sólo rellena huecos: nunca pisa un dato del que se conserva', () => {
    const { cambios, rellenados } = fusion(portal, bot);
    expect(rellenados.sort()).toEqual(['bot_state', 'legacy_portal_id']);
    expect(cambios['full_name']).toBeUndefined();
    expect(cambios['cv_url']).toBeUndefined();
    expect(cambios['stage']).toBeUndefined();
    expect(cambios['bot_state']).toBe('esperando_cv');
  });

  it('portal_data: lo del conservado gana; documentos sin repetir el mismo archivo', () => {
    const { cambios } = fusion(portal, bot);
    expect(cambios['portal_data']).toEqual({ dictamen: 'apto', riesgo: 'medio', solicitud: { ok: true } });
    expect((cambios['documents'] as unknown[]).length).toBe(2);
  });

  it('alta = la más vieja; última actividad = la más reciente', () => {
    const { cambios } = fusion(portal, bot);
    expect(cambios['created_at']).toBe('2026-08-01T10:00:00Z');
    expect(cambios['last_activity_at']).toBe('2026-08-03T10:00:00Z');
    // Al revés no hay nada que mover.
    const otra = fusion(bot, portal).cambios;
    expect(otra['created_at']).toBeUndefined();
    expect(otra['last_activity_at']).toBeUndefined();
  });
});
