/**
 * `[MS.3.9]` Quién llama, CON SU NOMBRE.
 *
 * `actorDesdeRequest` sólo sabe lo que viaja en el JWT, y el JWT trae el `username` pero no el nombre: el
 * hilo de cada ticket mostraba `vis_frank` donde la línea «Asignada a…» (que sí lee la ficha) decía
 * «Frank (Dirección General)». Lo destapó la revisión visual — ningún test lo veía, porque comparaba contra el
 * mismo valor que el servicio escribía.
 *
 * Se resuelve una vez por petición con una lectura por llave primaria. El nombre se COPIA al mensaje
 * (`author_label`) a propósito: el hilo es registro y debe decir lo que decía cuando se escribió.
 */
import { Injectable } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { construirAcceso, type Membresia } from './domain/queue-access';
import { actorDesdeRequest, type ActorCtx, type AuthedRequest } from './service-desk.types';

@Injectable()
export class ServiceDeskActorsService {
  constructor(private readonly tk: TenantKnexService) {}

  async resolve(req: AuthedRequest): Promise<ActorCtx> {
    const base = actorDesdeRequest(req);
    const { u, membresias } = await this.tk.run(async (trx) => ({
      u: (await trx('identity.users').where({ id: base.userId }).first('nombre')) as { nombre: string | null } | undefined,
      // `[MS.7.6]` Las colas de la persona. Una lectura por llamada; el god-mode no la necesita (ve todas).
      membresias: base.esGod
        ? []
        : ((await trx('servicedesk.queue_members').where({ user_id: base.userId, active: true }).select('queue_id', 'role')) as Membresia[]),
    }));
    return {
      ...base,
      nombre: u?.nombre?.trim() || base.nombre,
      colas: construirAcceso({ god: base.esGod, esAgente: base.esAgente, esCoordinador: base.esCoordinador, membresias }),
    };
  }
}
