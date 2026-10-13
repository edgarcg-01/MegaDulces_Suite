/**
 * `[RH.2.4]` Los mínimos para avanzar (los de Mega Talento, que nacieron de 20 candidatos que no debían estar adelante).
 */
import { puedeAvanzarPorCuestionario, revisarAvance } from './avance';

const listo = { stage: 'filtro_inicial', cv_url: 'https://c/cv.pdf', bot_state: 'completado', position_interest: 'Cajera', portal_data: {} };

describe('[RH.2.4] mínimos para avanzar', () => {
  it('con CV, registro completo y sin banderas graves: cumple', () => {
    expect(revisarAvance(listo)).toEqual({ ok: true, motivos: [] });
  });

  it('⛔ cada falta se dice en palabras', () => {
    expect(revisarAvance({ ...listo, cv_url: null }).motivos).toEqual(['No tiene CV en el expediente.']);
    expect(revisarAvance({ ...listo, bot_state: 'esperando_tiempo_traslado' }).motivos).toEqual(['Su registro está incompleto: falta tiempo traslado.']);
    expect(revisarAvance({ ...listo, portal_data: { dictamen: { reglas: [
      { gravedad: 'alta', codigo: 'familiar', texto: 'Tiene un familiar en la empresa.' },
      { gravedad: 'alta', codigo: 'sin_cv', texto: 'no se repite' },
      { gravedad: 'media', codigo: 'x', texto: 'no es grave' },
    ] } } }).motivos).toEqual(['Tiene un familiar en la empresa.']);
    expect(revisarAvance(listo, ['Almacenista']).motivos).toEqual(['El puesto "Cajera" no está abierto hoy.']);
    expect(revisarAvance(listo, ['cajera ']).ok).toBe(true);
  });

  it('el cuestionario sólo empuja hacia adelante desde Filtro o Entrevista Orientación', () => {
    for (const stage of [null, 'filtro_inicial', 'nuevo', 'entrevista_rh']) expect(puedeAvanzarPorCuestionario({ ...listo, stage }).ok).toBe(true);
    for (const stage of ['aptitudes', 'psicometria', 'contratado', 'rechazado']) expect(puedeAvanzarPorCuestionario({ ...listo, stage }).ok).toBe(false);
  });
});
