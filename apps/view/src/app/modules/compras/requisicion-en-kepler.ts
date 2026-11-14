import { warehouseName, type RequisicionCancelacionDisponibleDto } from '@megadulces/contracts';
import type { RequisitionDetail } from './compras.service';

/**
 * `[KR.8]` + `[KR.7]` El banner «En Kepler» de la ficha de una requisición: dónde está en el ERP y qué
 * pasó allá. Función pura (sin Angular) para que la regla se pruebe y se mute sin levantar el componente.
 *
 * `[KR.7]` (anexo K §3e, 2026-11-14): lo que pasó EN KEPLER se lee de la réplica (`en_kepler`), no de lo
 * que la Suite cree. Antes, la palomita tenue «En Kepler como requisición…» salía también de una
 * requisición que allá ya estaba cancelada, y de 21 que Kepler reabrió porque una persona canceló su OC
 * a mano: la Suite seguía diciendo «Ordenada».
 *
 * SIN ACENTOS GRAVES en los textos: el componente vive en un template literal (ver la nota de `[KR.8]`).
 */
/**
 * `pideCancelar` (`[KR.7]` C3): el renglón le está diciendo a la persona que esta requisición sigue viva en Kepler
 * cuando no debería (la Suite la canceló, o Kepler la reabrió porque su OC se canceló). Ahí, si el botón no se
 * puede ofrecer, se dice por qué; en los demás renglones no se dice nada (sería ruido en 180 de 203 fichas).
 */
export interface BannerKepler { texto: string; icono: string; tenue: boolean; reintentable: boolean; pideCancelar: boolean }

/** « el 06/11/26 13:58 por 07» con lo que Kepler dejó (fecha y hora de Kepler, sin zona). */
export function quienCuando(c: { por: string | null; en: string } | null): string {
  if (!c) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{1,2}:\d{2}))?/.exec(c.en ?? '');
  const cuando = m ? ` el ${m[3]}/${m[2]}/${m[1].slice(2)}${m[4] ? ' ' + m[4] : ''}` : '';
  return `${cuando}${c.por ? ' por ' + c.por : ''}`;
}

/** `dd/MM/aa HH:mm` en hora de México, de un instante ISO (lo que guarda la Suite). */
export function fechaMx(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = Object.fromEntries(new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p['day']}/${p['month']}/${p['year']} ${p['hour']}:${p['minute']}`;
}

/** Qué ofrece la ficha junto al renglón «En Kepler»: el botón, o por qué no se puede. */
export interface CancelacionFicha { boton: boolean; nota: string | null }

/**
 * `[KR.7]` C3. El botón «Cancelar en Kepler» sale SÓLO si el servidor dice que se puede (interruptor, tope,
 * regla de Kepler contra la réplica). Si no se puede, el porqué se dice sólo donde el renglón pide cancelar
 * (`pideCancelar`); en una requisición normal —con su OC viva— no se dice nada.
 * `info` = la respuesta del `GET …/kepler-cancellation`; `fallo` = ese `GET` no contestó.
 */
export function cancelacionEnFicha(
  info: RequisicionCancelacionDisponibleDto | null, fallo: boolean, banner: BannerKepler | null,
): CancelacionFicha {
  if (!info) return { boton: false, nota: fallo && banner?.pideCancelar ? 'No se pudo revisar si se puede cancelar desde aquí.' : null };
  // Un intento anterior que Kepler rechazó: se dice, para no repetir a ciegas lo que ya falló.
  const intento = info.ultima?.estado === 'rechazada' && info.ultima.rechazo
    ? `Último intento desde la Suite, sin cambios en Kepler: ${info.ultima.rechazo}` : null;
  if (info.disponible) return { boton: true, nota: intento };
  if (!banner?.pideCancelar || !info.porque) return { boton: false, nota: null };
  const porque = /[.!?]$/.test(info.porque) ? info.porque : `${info.porque}.`;
  return { boton: false, nota: intento ? `${porque} ${intento}` : porque };
}

/** `estadoSuite` = la etiqueta del estado de la Suite («Ordenada», «Cancelada»…), la misma de la ficha. */
export function bannerKepler(r: RequisitionDetail, estadoSuite: string): BannerKepler | null {
  if (r.estado === 'pending_approval' || r.estado === 'draft') return null;
  // `[KR.10]` Compra y traspaso salen como DOCUMENTOS DISTINTOS, y decirlo importa: quien
  // lo busque en Kepler tiene que saber si abre Requisición de compra o Pedido de traspaso.
  const doc = r.source_type === 'branch' ? 'pedido de traspaso' : 'requisición';
  const ek = r.en_kepler;
  const dondeKepler = `${doc} ${r.kepler_folio} de ${warehouseName(r.kepler_sucursal)}`;
  const aqui = `En la Suite sigue como «${estadoSuite}».`;
  // `[KR.7]` C3: la cancelaron EN KEPLER desde la Suite (D43). Va primero: la réplica tarda uno o dos minutos
  // en verla en C, y mientras tanto las reglas de abajo dirían «en Kepler sigue viva».
  if (r.kepler_cancelacion) {
    const c = r.kepler_cancelacion;
    const estadoAlla = ek?.requisicion?.estado === 'C' ? ''
      : ek === null ? ' Su estado en Kepler no se pudo leer.'
      : ' Kepler todavía no lo refleja en su réplica.';
    return { icono: 'pi-ban', tenue: false, reintentable: false, pideCancelar: false,
      texto: `La ${dondeKepler} se canceló en Kepler desde la Suite el ${fechaMx(c.en)} por ${c.por || 'alguien sin nombre registrado'}: «${c.motivo}».${estadoAlla}` };
  }
  if (r.estado === 'cancelled') {
    // `[KR.7]` El revés: la Suite la dio por cancelada y en Kepler sigue viva (1 caso, 2026-11-14).
    if (r.kepler_folio && ek?.requisicion && ek.requisicion.estado !== 'C') {
      const ocViva = ek.ocs.some((o) => o.estado !== 'C');
      return { icono: 'pi-exclamation-triangle', tenue: false, reintentable: false, pideCancelar: true,
        texto: `En la Suite está cancelada, pero en Kepler la ${dondeKepler} sigue viva${ocViva ? ', con su orden de compra' : ''}: hay que cancelarla allá.` };
    }
    return null;
  }
  if (r.kepler_folio) {
    const rq = ek?.requisicion ?? null;
    if (rq?.estado === 'C') {
      return { icono: 'pi-ban', tenue: false, reintentable: false, pideCancelar: false,
        texto: `En Kepler, la ${dondeKepler} se canceló${quienCuando(rq.cancelada)}. ${aqui}` };
    }
    const ocs = ek?.ocs ?? [];
    const ocsCanceladas = ocs.filter((o) => o.estado === 'C');
    if (rq && (rq.estado === 'A' || rq.estado === 'N') && ocsCanceladas.length && !ocs.some((o) => o.estado !== 'C')) {
      // Su OC se canceló y Kepler reabrió la requisición. Si se canceló DESDE la Suite, el aviso de
      // D41 ya dice cuándo, quién y por qué: aquí sólo el estado de la requisición allá.
      const oc = ocsCanceladas[ocsCanceladas.length - 1];
      return { icono: 'pi-ban', tenue: false, reintentable: false, pideCancelar: true,
        texto: r.oc_cancelada
          ? `En Kepler, la ${dondeKepler} volvió a pendiente: ya no tiene orden de compra viva.`
          : `En Kepler, la ${dondeKepler} volvió a pendiente: su orden de compra ${oc.folio} se canceló a mano${quienCuando(oc.cancelada)}. ${aqui}` };
    }
    if (ek === null) {
      return { icono: 'pi-question-circle', tenue: true, reintentable: false, pideCancelar: false,
        texto: `En Kepler como ${dondeKepler}. Su estado allá no se pudo leer.` };
    }
    return { icono: 'pi-check-circle', tenue: true, reintentable: false, pideCancelar: false,
      texto: `En Kepler como ${dondeKepler}.` };
  }
  if (r.kepler_error) {
    return { icono: 'pi-exclamation-triangle', tenue: false, reintentable: true, pideCancelar: false,
      texto: `No se pudo escribir en Kepler: ${r.kepler_error}` };
  }
  return { icono: 'pi-clock', tenue: false, reintentable: true, pideCancelar: false,
    texto: 'Todavía no se escribió en Kepler. Se aprobó en lote, o la integración está apagada en este despliegue.' };
}
