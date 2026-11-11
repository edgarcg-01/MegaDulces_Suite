import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Knex } from 'knex';
import { Observable, Subject, concat, map, of } from 'rxjs';
import { PgListenService } from '@megadulces/platform-core';

/**
 * `[RH.1.3]` Los avisos que la Suite le da al lector de relojes, en lugar de que el lector PREGUNTE cada rato.
 *
 * Hasta el 2026-11-11 el lector releía la lista de relojes cada 30 min y preguntaba por órdenes (dar de baja o
 * renombrar a alguien en un reloj) cada minuto POR RELOJ: 12 × 1,440 preguntas al día para unas cuantas órdenes al
 * mes. La regla del 2026-11-10 (ningún cron: el dato por EVENTO) pide lo contrario: cuando RH cambia un reloj o deja
 * una orden, la base emite un `NOTIFY` dentro de la MISMA transacción (sale al confirmar), la API lo reenvía al lector
 * por una conexión abierta (SSE) y el lector actúa en ese momento.
 *
 * ⛔ Un `NOTIFY` no se guarda (`PgListenService`): lo que se emite mientras nadie escucha se pierde. Por eso el aviso
 * dice «anda a buscar», nunca lleva el dato, y hay dos eventos de «ponte al día» que cierran el hueco SIN reloj:
 *   · cuando el lector se conecta (o reconecta) a los avisos, lo primero que recibe es `ponte_al_dia`;
 *   · cuando el LISTEN de esta API se recupera de una caída, manda `ponte_al_dia` a todos los lectores conectados.
 */
export const CANAL_RELOJES = 'hr_relojes';

export type AvisoRelojes = { tipo: 'padron' } | { tipo: 'comando'; serie: string } | { tipo: 'ponte_al_dia' };

/** Dentro de la transacción que cambia el reloj o deja la orden: el aviso sale sólo si ésta se confirma. */
export async function avisarRelojes(trx: Knex | Knex.Transaction, aviso: AvisoRelojes): Promise<void> {
  await trx.raw('select pg_notify(?, ?)', [CANAL_RELOJES, JSON.stringify(aviso)]);
}

/** Lo que llega por el canal; algo que no se entiende se descarta (no se reenvía basura al lector). */
export function leerAviso(payload: string): AvisoRelojes | null {
  try {
    const a = JSON.parse(payload) as Partial<AvisoRelojes> & { serie?: unknown };
    if (a?.tipo === 'padron' || a?.tipo === 'ponte_al_dia') return { tipo: a.tipo };
    if (a?.tipo === 'comando' && typeof a.serie === 'string' && a.serie.trim()) return { tipo: 'comando', serie: a.serie.trim() };
  } catch { /* no es JSON */ }
  return null;
}

/** Forma de un evento SSE de Nest (`@Sse`). */
export interface EventoSse { type: string; data: AvisoRelojes }

@Injectable()
export class HrRelojesAvisosService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HrRelojesAvisosService.name);
  private readonly avisos = new Subject<AvisoRelojes>();
  private soltar: Array<() => void> = [];

  // `@Inject` explícito: no depender de `design:paramtypes` (`#414`).
  constructor(@Inject(PgListenService) private readonly listen: PgListenService) {}

  onModuleInit(): void {
    try {
      this.soltar = [
        this.listen.escuchar(CANAL_RELOJES, (p) => { const a = leerAviso(p); if (a) this.avisos.next(a); }),
        this.listen.alConectar(() => this.avisos.next({ tipo: 'ponte_al_dia' })),
      ];
    } catch (e) {
      // Sin LISTEN el lector no se entera de altas ni de órdenes hasta que se reconecte: se DICE, no se calla.
      this.logger.error(`no se pudo escuchar ${CANAL_RELOJES}: ${(e as Error)?.message} — el lector sólo se pondrá al día al reconectarse`);
    }
  }

  onModuleDestroy(): void {
    for (const s of this.soltar) s();
    this.avisos.complete();
  }

  /** Para cada lector que se conecta: primero «ponte al día» (lo de antes), después cada aviso en vivo. */
  flujo(): Observable<EventoSse> {
    return concat(of<AvisoRelojes>({ tipo: 'ponte_al_dia' }), this.avisos.asObservable())
      .pipe(map((a) => ({ type: a.tipo, data: a })));
  }
}
