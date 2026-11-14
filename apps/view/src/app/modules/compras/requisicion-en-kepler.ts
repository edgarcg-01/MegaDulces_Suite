import { warehouseName } from '@megadulces/contracts';
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
export interface BannerKepler { texto: string; icono: string; tenue: boolean; reintentable: boolean }

/** « el 06/11/26 13:58 por 07» con lo que Kepler dejó (fecha y hora de Kepler, sin zona). */
export function quienCuando(c: { por: string | null; en: string } | null): string {
  if (!c) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{1,2}:\d{2}))?/.exec(c.en ?? '');
  const cuando = m ? ` el ${m[3]}/${m[2]}/${m[1].slice(2)}${m[4] ? ' ' + m[4] : ''}` : '';
  return `${cuando}${c.por ? ' por ' + c.por : ''}`;
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
  if (r.estado === 'cancelled') {
    // `[KR.7]` El revés: la Suite la dio por cancelada y en Kepler sigue viva (1 caso, 2026-11-14).
    if (r.kepler_folio && ek?.requisicion && ek.requisicion.estado !== 'C') {
      const ocViva = ek.ocs.some((o) => o.estado !== 'C');
      return { icono: 'pi-exclamation-triangle', tenue: false, reintentable: false,
        texto: `En la Suite está cancelada, pero en Kepler la ${dondeKepler} sigue viva${ocViva ? ', con su orden de compra' : ''}: hay que cancelarla allá.` };
    }
    return null;
  }
  if (r.kepler_folio) {
    const rq = ek?.requisicion ?? null;
    if (rq?.estado === 'C') {
      return { icono: 'pi-ban', tenue: false, reintentable: false,
        texto: `En Kepler, la ${dondeKepler} se canceló${quienCuando(rq.cancelada)}. ${aqui}` };
    }
    const ocs = ek?.ocs ?? [];
    const ocsCanceladas = ocs.filter((o) => o.estado === 'C');
    if (rq && (rq.estado === 'A' || rq.estado === 'N') && ocsCanceladas.length && !ocs.some((o) => o.estado !== 'C')) {
      // Su OC se canceló y Kepler reabrió la requisición. Si se canceló DESDE la Suite, el aviso de
      // D41 ya dice cuándo, quién y por qué: aquí sólo el estado de la requisición allá.
      const oc = ocsCanceladas[ocsCanceladas.length - 1];
      return { icono: 'pi-ban', tenue: false, reintentable: false,
        texto: r.oc_cancelada
          ? `En Kepler, la ${dondeKepler} volvió a pendiente: ya no tiene orden de compra viva.`
          : `En Kepler, la ${dondeKepler} volvió a pendiente: su orden de compra ${oc.folio} se canceló a mano${quienCuando(oc.cancelada)}. ${aqui}` };
    }
    if (ek === null) {
      return { icono: 'pi-question-circle', tenue: true, reintentable: false,
        texto: `En Kepler como ${dondeKepler}. Su estado allá no se pudo leer.` };
    }
    return { icono: 'pi-check-circle', tenue: true, reintentable: false,
      texto: `En Kepler como ${dondeKepler}.` };
  }
  if (r.kepler_error) {
    return { icono: 'pi-exclamation-triangle', tenue: false, reintentable: true,
      texto: `No se pudo escribir en Kepler: ${r.kepler_error}` };
  }
  return { icono: 'pi-clock', tenue: false, reintentable: true,
    texto: 'Todavía no se escribió en Kepler. Se aprobó en lote, o la integración está apagada en este despliegue.' };
}
