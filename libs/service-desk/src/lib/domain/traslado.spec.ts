// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el archivo NO CARGUE.
import type { SdStatus } from '@megadulces/contracts';
import { destinosDeTraslado, estadoTrasTraslado, terminaEspera, validarTraslado, type EntradaTraslado } from './traslado';

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

/**
 * `[MSH.2]` R3 (confirmada por Sistemas el 2026-10-06): un ticket confidencial NO sale a un área que no lo es, y uno normal no entra a una
 * confidencial. Entre las coordinadoras de RH se usa REASIGNAR. La base lo impide con un trigger (23514), pero un 500 no explica nada.
 */
describe('MSH.2 · validarTraslado — la clase de la cola (R3)', () => {
  it('⛔ NEGATIVA — confidencial → no confidencial: 409 con la salida correcta («reasígnala»)', () => {
    const e = validarTraslado(con({ origenConfidencial: true, destinoConfidencial: false }));
    expect(e?.http).toBe(409);
    expect(e?.mensaje).toMatch(/reasígnala/i);
  });
  it('⛔ NEGATIVA — normal → confidencial: 409 con la salida correcta («levanta una solicitud nueva»)', () => {
    const e = validarTraslado(con({ origenConfidencial: false, destinoConfidencial: true }));
    expect(e?.http).toBe(409);
    expect(e?.mensaje).toMatch(/solicitud nueva/i);
  });
  it('CONTROL: confidencial → OTRA confidencial pasa a esta función (quién puede es regla de coordinación del origen); normal → normal pasa', () => {
    expect(validarTraslado(con({ origenConfidencial: true, destinoConfidencial: true }))).toBeNull();
    expect(validarTraslado(con({ origenConfidencial: false, destinoConfidencial: false }))).toBeNull();
  });
  it('⭐ lo de antes no cambia: sin los campos nuevos (ausentes = no confidencial) el traslado se valida igual', () => {
    expect(validarTraslado(OK)).toBeNull();
  });
  it('el motivo, el estado y la cola vacía se revisan ANTES que la clase (el mensaje que se ve primero es el que se puede arreglar)', () => {
    expect(validarTraslado(con({ motivo: '', origenConfidencial: true, destinoConfidencial: false }))?.http).toBe(400);
    expect(validarTraslado(con({ status: 'resuelto', origenConfidencial: true, destinoConfidencial: false }))?.http).toBe(409);
  });
});

describe('[MSP.5.0] destinosDeTraslado — a dónde se puede trasladar', () => {
  // La forma de prod (2026-11-24): Presupuestos restringe quién LEVANTA (3 puestos); TI y Mantenimiento no.
  const COLAS = [
    { id: 'q-ti', code: 'ti', name: 'TI', confidential: false, requester_positions: null },
    { id: 'q-mto', code: 'mantenimiento', name: 'Mantenimiento', confidential: false, requester_positions: null },
    { id: 'q-pres', code: 'presupuestos', name: 'Presupuestos y Requerimientos', confidential: false, requester_positions: ['encargado_sucursal', 'auxiliar_encargado', 'jefe_zona'] },
    { id: 'q-rh', code: 'rh', name: 'Recursos Humanos', confidential: true, requester_positions: null },
    { id: 'q-vacia', code: 'vacia', name: 'Sin categorías', confidential: null, requester_positions: null },
  ];
  const CATS = [
    { id: 'c-ti', queue_id: 'q-ti', name: 'Equipo de cómputo e impresoras' },
    { id: 'c-mto', queue_id: 'q-mto', name: 'Plomería' },
    { id: 'c-pres', queue_id: 'q-pres', name: 'Compra de activos' },
    { id: 'c-rh', queue_id: 'q-rh', name: 'Nómina' },
    { id: 'c-huerfana', queue_id: 'q-apagada', name: 'De una cola que no vino (apagada)' },
  ];

  it('⭐ Presupuestos SÍ aparece aunque restrinja quién levanta: trasladar no es levantar (D8)', () => {
    const d = destinosDeTraslado(COLAS, CATS);
    expect(d.queues.map((q) => q.code)).toContain('presupuestos');
    expect(d.categories.filter((c) => c.queue_id === 'q-pres').map((c) => c.name)).toEqual(['Compra de activos']);
  });
  it('⛔ NEGATIVA — una cola sin categorías no se ofrece (no habría qué elegir), ni la categoría de una cola que no vino', () => {
    const d = destinosDeTraslado(COLAS, CATS);
    expect(d.queues.map((q) => q.id)).not.toContain('q-vacia');
    expect(d.categories.map((c) => c.id)).not.toContain('c-huerfana');
  });
  it('⛔ la lista de puestos NO sale en la respuesta', () => {
    expect(JSON.stringify(destinosDeTraslado(COLAS, CATS))).not.toContain('requester_positions');
    expect(JSON.stringify(destinosDeTraslado(COLAS, CATS))).not.toContain('encargado_sucursal');
  });
  it('la marca de confidencial viaja como verdadero/falso (el servidor decide con ella; null = no)', () => {
    const d = destinosDeTraslado(COLAS, CATS);
    expect(d.queues.find((q) => q.id === 'q-rh')?.confidential).toBe(true);
    expect(d.queues.find((q) => q.id === 'q-ti')?.confidential).toBe(false);
  });
  it('CONTROL: conserva el orden en que llegan las colas (el de la base: sort_order, nombre)', () => {
    expect(destinosDeTraslado(COLAS, CATS).queues.map((q) => q.id)).toEqual(['q-ti', 'q-mto', 'q-pres', 'q-rh']);
  });
});
