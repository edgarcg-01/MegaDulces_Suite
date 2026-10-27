/**
 * `[LE.4]` — Lo que el libro rechaza llega a la persona con su NOMBRE y una frase, nunca como un
 * 500. Cada regla de la base (`cashbook._falla`, CHECK con nombre `cashbook_*`) y de las reglas de
 * TypeScript (`ReglaInvalida`, `DineroInvalido`) se traduce aquí.
 *
 * Un código `cashbook_*` que no esté en el diccionario igual sale como 422 con el detalle de la
 * base: una frase que falta es deuda de redacción, no un error del servidor.
 */
import { BadRequestException, ConflictException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { DineroInvalido } from '@megadulces/contracts';
import { ReglaInvalida } from './reglas';
import { HechoInvalido } from './identidad';

const FRASES: Readonly<Record<string, string>> = {
  cashbook_sin_tenant: 'No se pudo identificar la empresa de la sesión.',
  cashbook_sin_jornada_abierta: 'No hay una jornada abierta: ábrela antes de registrar.',
  cashbook_ya_hay_jornada_abierta: 'Ya hay una jornada abierta: ciérrala antes de abrir otra.',
  cashbook_jornada_anterior: 'Esa fecha no es posterior a la última jornada: un día cerrado no se reabre.',
  cashbook_jornada_cerrada: 'Ese día ya está cerrado: el ajuste va al día abierto.',
  cashbook_no_cuadra: 'El movimiento no cuadra: lo que entra no es igual a lo que sale.',
  cashbook_piezas_no_suman: 'Las piezas no suman el importe.',
  cashbook_piezas_no_cuadran: 'Los billetes que salen de un lado no son los que entran al otro.',
  cashbook_cuenta_exige_piezas: 'En la caja se cuenta por pieza: un importe tecleado no es un conteo.',
  cashbook_cuenta_sin_desglose: 'Esa cuenta no lleva piezas.',
  cashbook_denominacion_fuera_de_catalogo: 'Esa denominación no existe en el catálogo.',
  cashbook_pieza_invalida: 'Las piezas son números enteros.',
  cashbook_piezas_no_negativas: 'No hay tantos billetes de esa denominación.',
  cashbook_saldo_no_negativo: 'No hay saldo suficiente.',
  cashbook_monto_invalido: 'El monto no es válido (centavos enteros, mayor que cero).',
  cashbook_linea_no_cero: 'Una línea en cero no mueve nada.',
  cashbook_fecha_futura: 'La fecha está en el futuro.',
  cashbook_requiere_autorizacion: 'Este movimiento lo autoriza otra persona.',
  cashbook_autoriza_quien_registra: 'Quien registró no puede autorizar lo suyo.',
  cashbook_autoriza_otro: 'Quien registró no puede autorizar lo suyo.',
  cashbook_cierre_cuatro_ojos: 'Quien hizo el arqueo de cierre no puede autorizar el cierre.',
  cashbook_cierre_sin_arqueo: 'Antes de cerrar la jornada falta el arqueo de cierre de la caja.',
  cashbook_descuadre_interno: 'El libro tiene un descuadre interno: no se cierra, es un incidente.',
  cashbook_solicitud_no_pendiente: 'Esa solicitud ya se decidió.',
  cashbook_solicitud_vencida: 'Esa solicitud venció: hay que pedirla otra vez.',
  cashbook_solicitud_inexistente: 'No existe esa solicitud.',
  cashbook_solicitud_rechazo_con_motivo: 'Un rechazo dice por qué.',
  cashbook_reversa_con_motivo: 'Una reversa dice por qué.',
  cashbook_reversa_de_reversa: 'Una reversa no se revierte: se registra el movimiento otra vez.',
  cashbook_asiento_una_reversa: 'Ese movimiento ya tiene reversa.',
  cashbook_asiento_inexistente: 'No existe ese movimiento.',
  cashbook_peticion_reusada: 'Esa petición ya se registró con otro contenido.',
  cashbook_evento_cambio: 'Ese hecho ya se registró con otro contenido: va como versión nueva.',
  cashbook_divisas_sin_puente: 'Dos monedas sólo se cruzan por el cambio de divisas.',
  cashbook_divisas_sin_tipo_de_cambio: 'Falta el tipo de cambio, su fuente o quién lo fijó.',
  cashbook_conteo_sorpresa_con_testigo: 'Un arqueo sorpresa lleva un testigo distinto de quien cuenta.',
  cashbook_hallazgo_se_cierra_con_algo: 'Un hallazgo se cierra con un movimiento o con una nota que firma otra persona.',
  cashbook_estado_final: 'Eso ya quedó cerrado y no cambia.',
  cashbook_inmutable: 'El libro no se edita: se corrige con una reversa.',
  cashbook_cuenta_distinta: 'Esa cuenta ya existe con otra forma.',
};

/** Los que hablan de un ESTADO (otra persona ya actuó, ya existe): 409. Los demás, 422. */
const CONFLICTO = new Set(['cashbook_ya_hay_jornada_abierta', 'cashbook_solicitud_no_pendiente', 'cashbook_asiento_una_reversa',
  'cashbook_peticion_reusada', 'cashbook_evento_cambio', 'cashbook_estado_final', 'cashbook_cuenta_distinta']);

export const fraseDelLibro = (codigo: string): string | undefined => FRASES[codigo];

export function traducirErrorDelLibro(e: unknown): never {
  if (e instanceof ReglaInvalida || e instanceof DineroInvalido || e instanceof HechoInvalido) {
    throw new BadRequestException({ codigo: e.codigo, mensaje: fraseDelLibro(e.codigo) ?? e.message, detalle: e.message });
  }
  const pg = e as { code?: string; constraint?: string; detail?: string; message?: string };
  if ((pg?.code === '23514' || pg?.code === '23505') && pg.constraint?.startsWith('cashbook_')) {
    const cuerpo = { codigo: pg.constraint, mensaje: fraseDelLibro(pg.constraint) ?? pg.detail ?? pg.message, detalle: pg.detail ?? null };
    if (CONFLICTO.has(pg.constraint)) throw new ConflictException(cuerpo);
    throw new UnprocessableEntityException(cuerpo);
  }
  if (pg?.code === '42501') throw new ForbiddenException({ codigo: 'sin_permiso_en_el_libro', mensaje: 'El libro no se escribe directo.' });
  throw e;
}
