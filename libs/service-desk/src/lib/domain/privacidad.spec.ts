// [CG.38.1] Sin import de 'vitest': la config usa `globals: true`. Importarlo hace que el archivo NO CARGUE.
import { MENSAJES_PRIVACIDAD, decidirConsentimiento, type EntradaConsentimiento } from './privacidad';

/**
 * `[PRV.2]` Lo que se defiende:
 *  · ⛔ una cola que exige aviso y no tiene versión vigente NO crea tickets (fail-closed);
 *  · ⛔ sin casilla marcada ni aceptación previa NO se crea;
 *  · ⛔ aceptar una versión VIEJA no vale;
 *  · ⛔ la casilla de quien atiende NO consiente por la persona titular;
 *  · quien ya aceptó la vigente no vuelve a marcar; una cola sin aviso (TI, Mantenimiento) queda exactamente igual.
 */
const V2 = { id: 'aviso-v2', version: 2 };
const base = (o: Partial<EntradaConsentimiento> = {}): EntradaConsentimiento => ({
  colaExigeAviso: true, avisoVigente: V2, idAceptado: undefined, yaAcepto: false, aNombreDeOtro: false, ...o,
});

describe('PRV.2 · decidirConsentimiento', () => {
  it('⭐ CONTROL — una cola SIN aviso (TI, Mantenimiento) no cambia: nada que aceptar ni registrar', () => {
    expect(decidirConsentimiento(base({ colaExigeAviso: false, avisoVigente: null }))).toEqual({ ok: true, registrar: false });
    expect(decidirConsentimiento(base({ colaExigeAviso: false }))).toEqual({ ok: true, registrar: false });
  });

  it('⭐ marca la casilla de la versión vigente → pasa y SE REGISTRA la aceptación', () => {
    expect(decidirConsentimiento(base({ idAceptado: V2.id }))).toEqual({ ok: true, registrar: true });
  });

  it('⛔ NEGATIVA — sin casilla y sin aceptación previa → 400 «falta aceptar»', () => {
    const r = decidirConsentimiento(base());
    expect(r).toMatchObject({ ok: false, codigo: 'falta_aceptar', status: 400 });
    if (!r.ok) expect(r.mensaje).toBe(MENSAJES_PRIVACIDAD.falta_aceptar);
  });

  it('⛔ NEGATIVA — fail-closed: cola con aviso y SIN versión vigente publicada → 409, aunque marquen la casilla', () => {
    expect(decidirConsentimiento(base({ avisoVigente: null }))).toMatchObject({ ok: false, codigo: 'sin_aviso_publicado', status: 409 });
    expect(decidirConsentimiento(base({ avisoVigente: null, idAceptado: V2.id, yaAcepto: true }))).toMatchObject({ ok: false, codigo: 'sin_aviso_publicado' });
  });

  it('⛔ NEGATIVA — aceptar una versión VIEJA no vale (publicaron otra mientras llenaba el formulario)', () => {
    expect(decidirConsentimiento(base({ idAceptado: 'aviso-v1' }))).toMatchObject({ ok: false, codigo: 'aviso_desactualizado', status: 400 });
    // ni siquiera si ya había aceptado la vigente: mandar un id distinto es una petición inconsistente, no se adivina
    expect(decidirConsentimiento(base({ idAceptado: 'aviso-v1', yaAcepto: true }))).toMatchObject({ ok: false, codigo: 'aviso_desactualizado' });
  });

  it('⭐ quien ya aceptó la vigente NO vuelve a marcar: pasa sin registrar otra vez', () => {
    expect(decidirConsentimiento(base({ yaAcepto: true }))).toEqual({ ok: true, registrar: false });
    expect(decidirConsentimiento(base({ yaAcepto: true, idAceptado: V2.id }))).toEqual({ ok: true, registrar: false });
  });

  it('⛔ NEGATIVA — a nombre de OTRA persona: la casilla de quien atiende NO consiente por ella → 409', () => {
    expect(decidirConsentimiento(base({ aNombreDeOtro: true, idAceptado: V2.id }))).toMatchObject({ ok: false, codigo: 'requiere_aceptacion_previa', status: 409 });
    expect(decidirConsentimiento(base({ aNombreDeOtro: true }))).toMatchObject({ ok: false, codigo: 'requiere_aceptacion_previa' });
  });

  it('⭐ a nombre de otra persona que YA aceptó la vigente → pasa, sin registrar nada nuevo', () => {
    expect(decidirConsentimiento(base({ aNombreDeOtro: true, yaAcepto: true }))).toEqual({ ok: true, registrar: false });
  });

  it('los cuatro rechazos tienen su mensaje', () => {
    for (const m of Object.values(MENSAJES_PRIVACIDAD)) expect(m.length).toBeGreaterThan(20);
    expect(Object.keys(MENSAJES_PRIVACIDAD).sort()).toEqual(['aviso_desactualizado', 'falta_aceptar', 'requiere_aceptacion_previa', 'sin_aviso_publicado']);
  });
});
