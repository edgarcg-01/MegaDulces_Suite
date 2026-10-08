// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el archivo NO CARGUE.
import type { SdStatus } from '@megadulces/contracts';
import { estadoTrasTraslado, terminaEspera, validarTraslado, type EntradaTraslado } from './traslado';

/**
 * `[MS.7.11]` Cuándo se puede trasladar un ticket y cómo queda. Lo que se defiende:
 *  · ⛔ no se pierde un ticket: la cola destino debe tener quién la atienda y la categoría debe ser suya;
 *  · un ticket resuelto/cerrado/cancelado no se traslada;
 *  · sin motivo no se traslada;
 *  · todo ticket queda en «nuevo» (sin asignar); uno que estaba en espera TERMINA su espera (no se puede quedar en espera sin asignado).
 */
const OK: EntradaTraslado = { status: 'en_proceso', origenId: 'ti', destinoId: 'mto', destinoActiva: true, categoriaEsDelDestino: true, miembrosDestino: 2, motivo: 'Es de infraestructura física' };
const con = (o: Partial<EntradaTraslado>): EntradaTraslado => ({ ...OK, ...o });

describe('MS.7.11 · validarTraslado', () => {
  it('⭐ el caso normal se puede', () => {
    expect(validarTraslado(OK)).toBeNull();
    for (const s of ['nuevo', 'asignado', 'en_proceso', 'en_espera'] as SdStatus[]) expect(validarTraslado(con({ status: s }))).toBeNull();
  });

  it('⛔ NEGATIVA — sin motivo (o sólo espacios) no se traslada', () => {
    expect(validarTraslado(con({ motivo: '' }))?.http).toBe(400);
    expect(validarTraslado(con({ motivo: '   ' }))?.http).toBe(400);
  });

  it('⛔ NEGATIVA — una solicitud resuelta, cerrada o cancelada no se traslada (409)', () => {
    for (const s of ['resuelto', 'cerrado', 'cancelado'] as SdStatus[]) expect(validarTraslado(con({ status: s }))?.http).toBe(409);
  });

  it('⛔ NEGATIVA — a la misma cola no (400)', () => {
    expect(validarTraslado(con({ destinoId: 'ti' }))?.http).toBe(400);
  });

  it('⛔ NEGATIVA — a una cola apagada o inexistente no (400)', () => {
    expect(validarTraslado(con({ destinoActiva: false }))?.http).toBe(400);
  });

  it('⛔ NEGATIVA — con una categoría que no es de la cola destino no (400)', () => {
    expect(validarTraslado(con({ categoriaEsDelDestino: false }))?.http).toBe(400);
  });

  it('⭐ NEGATIVA — a una cola que NADIE atiende no: el ticket se perdería (409)', () => {
    const e = validarTraslado(con({ miembrosDestino: 0 }));
    expect(e?.http).toBe(409);
    expect(e?.mensaje).toMatch(/nadie atiende/i);
    expect(validarTraslado(con({ miembrosDestino: 1 }))).toBeNull(); // CONTROL: con UNA persona basta
  });

  it('el motivo se revisa antes que lo demás (el mensaje que se ve primero es el que la persona puede arreglar)', () => {
    expect(validarTraslado(con({ motivo: '', destinoActiva: false, miembrosDestino: 0 }))?.mensaje).toMatch(/por qué/i);
  });
});

describe('MS.7.11 · estadoTrasTraslado', () => {
  it('⭐ TODOS quedan en «nuevo»: la asignación se quita y la base exige asignado para asignado/en proceso', () => {
    for (const s of ['nuevo', 'asignado', 'en_proceso', 'en_espera'] as SdStatus[]) expect(estadoTrasTraslado(s)).toBe('nuevo');
  });
  it('⛔ NEGATIVA — nunca devuelve «en espera»: un ticket en espera sin asignado no podría reanudarse (quedaría atorado)', () => {
    for (const s of ['nuevo', 'asignado', 'en_proceso', 'en_espera'] as SdStatus[]) expect(estadoTrasTraslado(s)).not.toBe('en_espera');
  });
  it('sólo un ticket que estaba en espera tiene una pausa que cerrar', () => {
    expect(terminaEspera('en_espera')).toBe(true);
    for (const s of ['nuevo', 'asignado', 'en_proceso'] as SdStatus[]) expect(terminaEspera(s)).toBe(false);
  });
});
