import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * ⭐⭐ `[ICR.M8]` — **UN RACK TIENE UN SOLO DUEÑO A LA VEZ.**
 *
 * La cola de toma de rack del conteo físico, acordada con Edgar el 2026-11-27
 * (`FASE_ICR_ANEXO_CONTEO_TRIMESTRAL_2026-11-27.md` §4). El contador entra, el sistema le entrega
 * **el siguiente rack libre en orden de recorrido** y se lo bloquea; cuenta; marca «terminé este
 * rack»; el sistema le entrega el siguiente.
 *
 * **No hay duplicados por construcción**: tomar un rack es exclusivo. **No hay racks olvidados**:
 * todos están en la cola, incluido el montón «sin rack». **Nadie pregunta qué sigue.** Y el que
 * es rápido toma más, así que la carga se empareja sola.
 *
 * ── Por qué una cola y no un reparto ────────────────────────────────────────────────────────
 *
 * El reparto por pasillo **ya existe entero** (`inventory-team.service.ts`, PA.3: equipos parejos
 * por pasillo en `commercial.inventory_count_assignments.aisle_id`) y este servicio **no lo
 * reemplaza**. Lo que faltaba no era el reparto: era el **estado** (libre / tomado por quién /
 * terminado) y el **orden**. Un reparto estático le da a cada quien lo mismo aunque uno termine
 * en una hora y otro en seis; la cola lo empareja sola y, sobre todo, **dice cuándo un rack ya se
 * contó**, que es lo que distingue «no está» de «nadie llegó» (F32).
 *
 * ── Dónde vive la exclusividad: en la base ──────────────────────────────────────────────────
 *
 * Tomar un rack es una **carrera**: dos personas pueden apretar «dame el siguiente» en el mismo
 * milisegundo. Eso NO se resuelve con un `if` en JavaScript —entre el `SELECT` que ve «libre» y
 * el `UPDATE` que lo toma cabe la petición de la otra persona—. Se resuelve con:
 *
 *  1. una **fila única** por `(folio, rack, vuelta)` (`commercial_inv_rack_state_unica`, con
 *     `NULLS NOT DISTINCT` para que el montón «sin rack» sea UNA fila y no una por pedido), y
 *  2. **`FOR UPDATE ... SKIP LOCKED`** sobre esa fila: el segundo que llega no espera al primero,
 *     se lleva la siguiente libre.
 *
 * El `CHECK ck_rack_state_dueno_coherente` cierra el resto: `taken` sin dueño no se puede
 * escribir.
 *
 * ── Las tres reglas que el código NO puede relajar ──────────────────────────────────────────
 *
 *  · **La segunda vuelta nunca cae en quien hizo la primera** de ESE rack (§4.6). No previene una
 *    confusión: previene que el doble conteo ciego sea teatro. Con una sola persona no hay dos
 *    testigos, hay uno escribiendo dos veces. Vale también para `unirse`.
 *  · **Liberar no borra lo capturado** (§4.6). Las capturas viven en
 *    `commercial.inventory_count_scan_log` y este servicio no las toca nunca; quien tome el rack
 *    después **ve qué productos** ya se contaron ahí, para continuar y no recomenzar.
 *  · **Unirse es explícito, nunca automático** (§4.6). Sólo cuando la cola no tiene nada libre
 *    para esa persona.
 *
 * ── ⚠️ Lo que este servicio da por cierto, y hay que enganchar ───────────────────────────────
 *
 *  · La captura sigue yendo por `submitCount`, que recibe `aisle_id` = **dónde está parada la
 *    persona** (`[ICR.M3]`). El rack que entrega esta cola es exactamente ese `aisle_id`.
 *  · `submitCount` elige la vuelta con `capture_pass ?? inventory_counts.current_pass`, que es
 *    **del folio**. La cola lleva la vuelta **por rack** (§4.6: un rack pasa a su segunda en
 *    cuanto cierra la primera, sin esperar al folio). Por eso `takeNext` devuelve `pass`: la
 *    pantalla tiene que mandarlo como `capture_pass`, o las capturas de la segunda vuelta de un
 *    rack caerán en `count_1` mientras el folio siga en la vuelta 1.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lo que se le muestra a la persona cuando no hay rack: el montón es un rack más, sin código. */
export const SIN_RACK = 'Sin rack';

export interface RackDeLaCola {
  /** `null` = el montón «sin rack», que es un rack más y va el último de la cola. */
  aisle_id: string | null;
  code: string;
  name: string | null;
  /** La vuelta DE ESTE RACK, no la del folio. Se manda como `capture_pass` al capturar. */
  pass: number;
  walk_sequence: number | null;
  taken_at: string | null;
  /** Qué productos ya se contaron en este rack en esta vuelta (sin cantidades: el conteo es ciego). */
  ya_contado?: { product_id: string | null; product_sku: string | null; name: string | null }[];
}

export interface TomarSiguienteRespuesta {
  estado: 'asignado' | 'ya_era_tuyo' | 'sin_libres' | 'terminado';
  rack: RackDeLaCola | null;
  /** Racks libres que quedan en la cola para CUALQUIERA (no sólo para quien pregunta). */
  libres: number;
  /** Sólo en `sin_libres`: a cuáles te podés unir, y quién los tiene (§4.6). */
  puedes_unirte: { aisle_id: string | null; code: string; holder: string | null; desde: string | null }[];
  motivo?: string;
}

@Injectable()
export class InventoryRackQueueService {
  private readonly logger = new Logger(InventoryRackQueueService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private userId(): string {
    const uid = this.tenantCtx.get()?.userId;
    // Fail-closed, igual que `submitCount`: sin usuario no se puede atribuir un rack, y un rack
    // sin dueño atribuible rompe la segregación del doble conteo aguas abajo.
    if (!uid) throw new ForbiddenException('Sesión sin usuario; no se puede tomar un rack.');
    return uid;
  }

  private async folioOrThrow(trx: any, countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    const folio = await trx('commercial.inventory_counts').where('id', countId).first();
    if (!folio) throw new NotFoundException('Folio no encontrado');
    if (folio.status === 'reconciled' || folio.status === 'cancelled')
      throw new ConflictException(`El folio está en '${folio.status}'; su cola ya no se reparte.`);
    return folio;
  }

  /**
   * Crea las filas de cola que falten para la **primera vuelta**: una por rack activo del almacén
   * del folio, más la del montón «sin rack».
   *
   * ⭐ Se llama en CADA `takeNext` y es idempotente (`ON CONFLICT DO NOTHING` contra el índice
   * único). No es un lujo: **Yurécuaro tenía 0 racks el 2026-11-27 y los da de alta el lunes 30**,
   * y el folio del martes puede abrirse antes o después de eso. Si la cola se armara una sola vez
   * al abrir el folio, los racks dados de alta a media mañana quedarían fuera y **nadie se
   * enteraría**: no saldrían en la cola ni como pendientes.
   *
   * ⚠️ Con el catálogo vacío queda **una sola fila**: el montón. Ése es el caso de Yurécuaro si el
   * lunes no alcanzan a capturar, y el sistema tiene que comportarse —no quedarse sin cola—.
   */
  private async ensureQueue(trx: any, folio: { id: string; warehouse_id: string }, uid: string) {
    await trx.raw(
      `INSERT INTO commercial.inventory_count_rack_state
         (tenant_id, count_id, aisle_id, pass, status, created_by, updated_by)
       SELECT public.current_tenant_id(), ?, a.id, 1, 'free', ?, ?
         FROM commercial.warehouse_aisles a
        WHERE a.warehouse_id = ? AND a.active = true
       ON CONFLICT DO NOTHING`,
      [folio.id, uid, uid, folio.warehouse_id],
    );
    // El montón «sin rack», siempre. Va aparte porque no sale de ninguna fila del catálogo.
    await trx.raw(
      `INSERT INTO commercial.inventory_count_rack_state
         (tenant_id, count_id, aisle_id, pass, status, created_by, updated_by)
       VALUES (public.current_tenant_id(), ?, NULL, 1, 'free', ?, ?)
       ON CONFLICT DO NOTHING`,
      [folio.id, uid, uid],
    );
  }

  /** El rótulo con el que la persona reconoce su rack. El montón tiene nombre propio. */
  private static rotulo(aisleId: string | null, code: string | null, name: string | null): RackDeLaCola['code'] {
    if (!aisleId) return SIN_RACK;
    return code || name || '—';
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // 1. «Dame el siguiente»
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * `[ICR.M8]` Entrega **el siguiente rack libre en orden de recorrido**, bloqueado a nombre de
   * quien pregunta. Si ya trae uno, le devuelve ése: una persona, un rack, y cerrar la app no le
   * hace perder su trabajo.
   *
   * El orden de la cola: **primero la vuelta 1 de todos los racks**, después la 2; dentro de cada
   * vuelta, por `walk_sequence` (el recorrido del almacén), y el montón «sin rack» **al final**.
   * ⚠️ Medido el 2026-11-27: las 4 filas del catálogo tienen `grid_row = grid_col = 0`, o sea que
   * hoy **no hay orden ninguno**; por eso el desempate explícito por `code` e `id`, para que la
   * cola sea al menos estable mientras nadie capture el recorrido.
   */
  async takeNext(countId: string): Promise<TomarSiguienteRespuesta> {
    const uid = this.userId();
    return this.tk.run(async (trx) => {
      const folio = await this.folioOrThrow(trx, countId);

      // ⚠️ Candado por persona, como en `[GP.3]`: dos peticiones del mismo contador (dos
      // pestañas, un reintento de la red) veían las dos «no traigo ninguno» y se llevaban DOS
      // racks. Con el candado la segunda espera y ve el que ya tiene.
      await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [`icr-m8-rack:${countId}:${uid}`]);

      await this.ensureQueue(trx, folio, uid);

      const mio = await this.rackDe(trx, countId, uid);
      if (mio) {
        mio.ya_contado = await this.yaContadoEn(trx, countId, mio.aisle_id, mio.pass);
        return { estado: 'ya_era_tuyo', rack: mio, libres: await this.libres(trx, countId), puedes_unirte: [] };
      }

      // ⭐⭐ LA CARRERA SE RESUELVE ACÁ, EN LA BASE.
      //
      // `FOR UPDATE OF r SKIP LOCKED`: si dos personas piden a la vez, la fila que uno tiene
      // bloqueada el otro NO la espera — se lleva la siguiente. Sin `SKIP LOCKED` la cola se
      // serializa; sin `FOR UPDATE` los dos se llevarían el mismo rack.
      //
      // ⛔ `FOR UPDATE OF r` y no `FOR UPDATE` a secas: `warehouse_aisles` entra por LEFT JOIN
      // (el montón «sin rack» no tiene fila ahí) y Postgres rechaza bloquear el lado nulo de un
      // outer join.
      //
      // Las dos exclusiones de la persona:
      //   · `NOT (uid = ANY(r.held_by))` — no le volvemos a dar un rack en el que ya estuvo en
      //     esta misma vuelta (p. ej. uno que el supervisor le liberó).
      //   · el `NOT EXISTS` sobre una vuelta ANTERIOR del MISMO rack — §4.6: la segunda vuelta
      //     nunca cae en quien hizo la primera. Es la única negación que se conserva.
      const { rows } = await trx.raw(
        `UPDATE commercial.inventory_count_rack_state s
            SET status = 'taken',
                holder_id = ?::uuid,
                taken_at = now(),
                held_by = CASE WHEN ?::uuid = ANY(s.held_by)
                               THEN s.held_by ELSE array_append(s.held_by, ?::uuid) END,
                updated_at = now(),
                updated_by = ?::uuid
          WHERE s.id = (
            SELECT r.id
              FROM commercial.inventory_count_rack_state r
              LEFT JOIN commercial.warehouse_aisles a ON a.id = r.aisle_id
             WHERE r.count_id = ?
               AND r.status = 'free'
               AND NOT (?::uuid = ANY(r.held_by))
               AND NOT EXISTS (
                     SELECT 1 FROM commercial.inventory_count_rack_state p
                      WHERE p.count_id = r.count_id
                        AND p.aisle_id IS NOT DISTINCT FROM r.aisle_id
                        AND p.pass < r.pass
                        AND ?::uuid = ANY(p.held_by))
             ORDER BY r.pass ASC,
                      (r.aisle_id IS NULL) ASC,
                      a.walk_sequence ASC NULLS LAST,
                      a.code ASC,
                      r.aisle_id ASC
             LIMIT 1
             FOR UPDATE OF r SKIP LOCKED)
        RETURNING s.aisle_id, s.pass, s.taken_at`,
        [uid, uid, uid, uid, countId, uid, uid],
      );

      const tomado = (rows as any[])[0];
      if (tomado) {
        const rack = await this.decorar(trx, tomado.aisle_id, tomado.pass, tomado.taken_at);
        rack.ya_contado = await this.yaContadoEn(trx, countId, rack.aisle_id, rack.pass);
        this.logger.log(`[ICR.M8] folio ${folio.folio}: rack ${rack.code} (vuelta ${rack.pass}) → ${uid}`);
        return { estado: 'asignado', rack, libres: await this.libres(trx, countId), puedes_unirte: [] };
      }

      // No quedó nada libre PARA ESTA PERSONA. Dos casos muy distintos, y se distinguen.
      const ocupados = await this.ocupadosParaUnirse(trx, countId, uid);
      if (ocupados.length) {
        return {
          estado: 'sin_libres',
          rack: null,
          libres: await this.libres(trx, countId),
          puedes_unirte: ocupados,
          motivo: 'No quedan racks libres. Puedes unirte a uno que alguien esté contando: repártanse el rack y la pantalla avisa si se pisan.',
        };
      }
      return {
        estado: 'terminado',
        rack: null,
        libres: 0,
        puedes_unirte: [],
        motivo: 'No queda nada por contar que te toque a ti.',
      };
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // 2. «Terminé este rack»
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * `[ICR.M8]` Cierra el rack que la persona tiene y, si el folio corre con doble conteo ciego,
   * **abre su segunda vuelta** en la cola — para alguien que no sea quien acaba de contarlo.
   *
   * ⚠️ Cerrar un rack **no afirma que lo que hay ahí esté completo**: por eso no toca ni un
   * renglón del folio. La regla de cierre por rack (que lo no contado en un rack cerrado valga
   * como faltante) está declarada FUERA del martes (§6 del anexo); esto es el «terminé mi rack»
   * informativo, que es lo que le deja ver el avance al supervisor.
   */
  async finish(countId: string, dto: { aisle_id?: string | null }) {
    const uid = this.userId();
    const pedido = dto?.aisle_id ? String(dto.aisle_id).trim() : null;
    if (pedido && !UUID.test(pedido)) throw new BadRequestException('aisle_id inválido');

    const cerrado = await this.tk.run(async (trx) => {
      const folio = await this.folioOrThrow(trx, countId);

      let q = trx('commercial.inventory_count_rack_state')
        .where({ count_id: countId, holder_id: uid, status: 'taken' });
      // Sin `aisle_id` se cierra el que la persona trae (sólo puede traer uno). Con él, se exige
      // que coincida: cerrar «el que sea» desde una pantalla vieja cerraría el equivocado.
      q = pedido ? q.andWhere('aisle_id', pedido) : q.whereRaw('true');
      if (!pedido && dto && Object.prototype.hasOwnProperty.call(dto, 'aisle_id') && dto.aisle_id === null)
        q = q.whereNull('aisle_id');

      const [fila] = await q
        .update({
          status: 'done',
          holder_id: null,
          finished_at: trx.fn.now(),
          finished_by: uid,
          updated_at: trx.fn.now(),
          updated_by: uid,
        })
        .returning(['aisle_id', 'pass']);
      if (!fila)
        throw new ConflictException('No tienes ese rack tomado. Toca «Dame el siguiente».');

      // La segunda vuelta de ESTE rack nace libre, y nace acá y no al abrir el folio: una fila
      // `free` que todavía no se puede trabajar se vería igual que una que sí, y alguien la
      // tomaría para encontrarse con que nadie hizo la primera.
      if (folio.blind_double_count && Number(fila.pass) === 1) {
        await trx.raw(
          `INSERT INTO commercial.inventory_count_rack_state
             (tenant_id, count_id, aisle_id, pass, status, created_by, updated_by)
           VALUES (public.current_tenant_id(), ?, ?::uuid, 2, 'free', ?, ?)
           ON CONFLICT DO NOTHING`,
          [countId, fila.aisle_id, uid, uid],
        );
      }
      return { aisle_id: fila.aisle_id as string | null, pass: Number(fila.pass) };
    });

    // Paso 4 de la regla madre: «el sistema le entrega el siguiente libre». Va en su propia
    // transacción porque `takeNext` toma su propio candado por persona.
    const siguiente = await this.takeNext(countId);
    return { ok: true, cerrado, siguiente };
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // 3. Unirse a un rack ocupado (§4.6) — explícito, nunca automático
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * `[ICR.M8]` Cuando la cola se vacía y alguien sigue contando, el que quedó libre **puede
   * unirse** a un rack ocupado. Lo que lo vuelve seguro es el aviso que ya existe del lado del
   * servidor: al escanear algo ya contado en ese rack, la respuesta lo dice (§4.3, `[ICR.M3]`).
   * Se reparten el rack físicamente —«vos las de arriba, yo las de abajo»— y si se pisan se
   * enteran al instante, no al final.
   *
   * ⛔ Unirse **no cambia de dueño**: el rack sigue siendo de quien lo tomó. Lo que hace es
   * anotar al que llega en `held_by`, que es lo que después impide que la segunda vuelta de ese
   * rack le toque a él.
   *
   * ⛔ Y no se puede unir a un rack cuya vuelta anterior contó esa misma persona: la única
   * negación que se conserva (§4.4).
   */
  async join(countId: string, dto: { aisle_id?: string | null }) {
    const uid = this.userId();
    const pedido = dto?.aisle_id ? String(dto.aisle_id).trim() : null;
    if (pedido && !UUID.test(pedido)) throw new BadRequestException('aisle_id inválido');

    return this.tk.run(async (trx) => {
      await this.folioOrThrow(trx, countId);
      await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [`icr-m8-rack:${countId}:${uid}`]);

      const mio = await this.rackDe(trx, countId, uid);
      if (mio) throw new ConflictException(`Todavía tienes el rack ${mio.code}. Termínalo antes de unirte a otro.`);

      const { rows } = await trx.raw(
        `UPDATE commercial.inventory_count_rack_state s
            SET held_by = array_append(s.held_by, ?::uuid), updated_at = now(), updated_by = ?::uuid
          WHERE s.count_id = ?
            AND s.aisle_id IS NOT DISTINCT FROM ?::uuid
            AND s.status = 'taken'
            AND NOT (?::uuid = ANY(s.held_by))
            AND NOT EXISTS (
                  SELECT 1 FROM commercial.inventory_count_rack_state p
                   WHERE p.count_id = s.count_id
                     AND p.aisle_id IS NOT DISTINCT FROM s.aisle_id
                     AND p.pass < s.pass
                     AND ?::uuid = ANY(p.held_by))
        RETURNING s.aisle_id, s.pass, s.taken_at`,
        [uid, uid, countId, pedido, uid, uid],
      );
      const fila = (rows as any[])[0];
      if (!fila) {
        // Se distingue el «no está ocupado» del «no puedes tú», porque la persona hace cosas
        // distintas con cada respuesta.
        const estado = await trx('commercial.inventory_count_rack_state')
          .where({ count_id: countId })
          .andWhere((b: any) => (pedido ? b.where('aisle_id', pedido) : b.whereNull('aisle_id')))
          .orderBy('pass', 'desc')
          .first('status', 'pass');
        if (!estado) throw new NotFoundException('Ese rack no está en la cola de este folio.');
        if (estado.status !== 'taken')
          throw new ConflictException('Ese rack no lo está contando nadie. Toca «Dame el siguiente».');
        throw new ConflictException(
          'No puedes unirte a este rack: tú hiciste su primera vuelta y el segundo conteo lo tiene que hacer otra persona.',
        );
      }

      const rack = await this.decorar(trx, fila.aisle_id, fila.pass, fila.taken_at);
      rack.ya_contado = await this.yaContadoEn(trx, countId, rack.aisle_id, rack.pass);
      this.logger.log(`[ICR.M8] folio ${countId}: ${uid} se UNIÓ al rack ${rack.code} (vuelta ${rack.pass})`);
      return { ok: true, rack };
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // 4. Liberar (supervisor) — §4.6
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * `[ICR.M8]` El caso que va a pasar: alguien se va, se le muere el teléfono, o le tocó un rack
   * enorme y no avanza. Su rack queda bloqueado a su nombre y nadie más lo puede tomar.
   *
   * ⭐⭐ **Lo ya capturado se queda.** Este método no toca ni una fila de
   * `commercial.inventory_count_scan_log`: es mercancía contada de verdad. Quien tome el rack
   * después **ve qué se contó ahí** (`ya_contado`), para continuar y no recomenzar.
   *
   * ⚠️ `held_by` **no se limpia**: la persona liberada sigue contando como «ya estuvo acá», así
   * que la cola no se lo vuelve a dar y la segunda vuelta no le va a tocar. Si volvió y quiere
   * seguir en ese rack, el camino es `join` —explícito—, no que la cola se lo devuelva sola.
   */
  async release(countId: string, dto: { aisle_id?: string | null; pass?: number; reason?: string }) {
    const uid = this.userId();
    const pedido = dto?.aisle_id ? String(dto.aisle_id).trim() : null;
    if (pedido && !UUID.test(pedido)) throw new BadRequestException('aisle_id inválido');
    const motivo = String(dto?.reason ?? '').trim() || null;

    return this.tk.run(async (trx) => {
      await this.folioOrThrow(trx, countId);
      let q = trx('commercial.inventory_count_rack_state')
        .where({ count_id: countId, status: 'taken' })
        .andWhere((b: any) => (pedido ? b.where('aisle_id', pedido) : b.whereNull('aisle_id')));
      if (dto?.pass) q = q.andWhere('pass', Number(dto.pass));

      const [fila] = await q
        .update({
          status: 'free',
          holder_id: null,
          taken_at: null,
          released_at: trx.fn.now(),
          released_by: uid,
          release_reason: motivo,
          updated_at: trx.fn.now(),
          updated_by: uid,
        })
        .returning(['aisle_id', 'pass', 'held_by']);
      if (!fila) throw new ConflictException('Ese rack no lo tiene nadie tomado.');

      const rack = await this.decorar(trx, fila.aisle_id, fila.pass, null);
      const capturas = await this.contarCapturas(trx, countId, fila.aisle_id, Number(fila.pass));
      this.logger.log(
        `[ICR.M8] folio ${countId}: rack ${rack.code} LIBERADO por ${uid}` +
          `${motivo ? ` (${motivo})` : ''}; ${capturas} captura(s) se conservan.`,
      );
      return { ok: true, rack, capturas_conservadas: capturas };
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // 5. El tablero del supervisor
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * `[ICR.M8]` **El supervisor ve qué rack tiene cada quién y desde hace cuánto.** Eso le dice a
   * quién ir a ayudar y qué rack liberar, sin preguntarle a nadie (§4.6).
   *
   * Incluye los racks que **todavía nadie tomó**: ésa es la mitad que hoy no existe y la que
   * distingue «acá no hay nada» de «nadie llegó».
   */
  async board(countId: string) {
    const uid = this.tenantCtx.get()?.userId ?? null;
    return this.tk.run(async (trx) => {
      const folio = await this.folioOrThrow(trx, countId);
      if (uid) await this.ensureQueue(trx, folio, uid);

      const { rows } = await trx.raw(
        `SELECT s.aisle_id, s.pass, s.status, s.taken_at, s.finished_at, s.released_at,
                s.release_reason, s.held_by,
                a.code, a.name, a.walk_sequence,
                u.nombre AS holder_nombre, u.username AS holder_username, s.holder_id,
                (SELECT count(DISTINCT l.item_id)
                   FROM commercial.inventory_count_scan_log l
                  WHERE l.count_id = s.count_id
                    AND l.aisle_id IS NOT DISTINCT FROM s.aisle_id
                    AND l.slot = 'count_' || s.pass
                    AND l.quantity_native IS NOT NULL)::int AS productos_capturados
           FROM commercial.inventory_count_rack_state s
           LEFT JOIN commercial.warehouse_aisles a ON a.id = s.aisle_id
           LEFT JOIN identity.users u ON u.id = s.holder_id
          WHERE s.count_id = ?
          ORDER BY s.pass ASC, (s.aisle_id IS NULL) ASC,
                   a.walk_sequence ASC NULLS LAST, a.code ASC, s.aisle_id ASC`,
        [countId],
      );

      const racks = (rows as any[]).map((r) => ({
        aisle_id: r.aisle_id as string | null,
        code: InventoryRackQueueService.rotulo(r.aisle_id, r.code, r.name),
        name: r.name as string | null,
        pass: Number(r.pass),
        status: r.status as string,
        walk_sequence: r.walk_sequence === null ? null : Number(r.walk_sequence),
        holder: r.holder_id ? { user_id: r.holder_id, name: r.holder_nombre || r.holder_username || '—' } : null,
        taken_at: r.taken_at,
        /** Minutos que lleva tomado. Es lo que dice a quién ir a ayudar. */
        minutos_tomado: r.taken_at ? Math.round((Date.now() - new Date(r.taken_at).getTime()) / 60000) : null,
        finished_at: r.finished_at,
        released_at: r.released_at,
        release_reason: r.release_reason,
        personas: Array.isArray(r.held_by) ? r.held_by.length : 0,
        productos_capturados: Number(r.productos_capturados) || 0,
      }));

      return {
        folio: folio.folio,
        status: folio.status,
        current_pass: Number(folio.current_pass) || 1,
        blind_double_count: !!folio.blind_double_count,
        // ⚠️ `sin_orden_de_recorrido` se publica a propósito: con el catálogo sin capturar, la
        // cola entrega en un orden estable pero que NO es el del almacén. Eso se DECLARA, no se
        // dibuja como si estuviera bien.
        sin_orden_de_recorrido: racks.some((r) => r.aisle_id && r.walk_sequence === null),
        racks,
        resumen: {
          libres: racks.filter((r) => r.status === 'free').length,
          tomados: racks.filter((r) => r.status === 'taken').length,
          terminados: racks.filter((r) => r.status === 'done').length,
        },
      };
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Auxiliares
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /** El rack que esta persona tiene tomado ahora, si tiene alguno. */
  private async rackDe(trx: any, countId: string, uid: string): Promise<RackDeLaCola | null> {
    const fila = await trx('commercial.inventory_count_rack_state')
      .where({ count_id: countId, holder_id: uid, status: 'taken' })
      .first('aisle_id', 'pass', 'taken_at');
    if (!fila) return null;
    return this.decorar(trx, fila.aisle_id, fila.pass, fila.taken_at);
  }

  private async decorar(
    trx: any,
    aisleId: string | null,
    pass: number | string,
    takenAt: string | null,
  ): Promise<RackDeLaCola> {
    const a = aisleId
      ? await trx('commercial.warehouse_aisles').where('id', aisleId).first('code', 'name', 'walk_sequence')
      : null;
    return {
      aisle_id: aisleId,
      code: InventoryRackQueueService.rotulo(aisleId, a?.code ?? null, a?.name ?? null),
      name: a?.name ?? null,
      pass: Number(pass),
      walk_sequence: a?.walk_sequence === null || a?.walk_sequence === undefined ? null : Number(a.walk_sequence),
      taken_at: takenAt,
    };
  }

  private async libres(trx: any, countId: string): Promise<number> {
    const r = await trx('commercial.inventory_count_rack_state')
      .where({ count_id: countId, status: 'free' })
      .count('* as n')
      .first();
    return Number(r?.n) || 0;
  }

  /** Los racks ocupados a los que ESTA persona se podría unir (§4.6). */
  private async ocupadosParaUnirse(trx: any, countId: string, uid: string) {
    const { rows } = await trx.raw(
      `SELECT s.aisle_id, s.pass, s.taken_at, a.code, a.name,
              u.nombre AS holder_nombre, u.username AS holder_username
         FROM commercial.inventory_count_rack_state s
         LEFT JOIN commercial.warehouse_aisles a ON a.id = s.aisle_id
         LEFT JOIN identity.users u ON u.id = s.holder_id
        WHERE s.count_id = ?
          AND s.status = 'taken'
          AND NOT (?::uuid = ANY(s.held_by))
          AND NOT EXISTS (
                SELECT 1 FROM commercial.inventory_count_rack_state p
                 WHERE p.count_id = s.count_id
                   AND p.aisle_id IS NOT DISTINCT FROM s.aisle_id
                   AND p.pass < s.pass
                   AND ?::uuid = ANY(p.held_by))
        ORDER BY s.taken_at ASC`,
      [countId, uid, uid],
    );
    return (rows as any[]).map((r) => ({
      aisle_id: r.aisle_id as string | null,
      code: InventoryRackQueueService.rotulo(r.aisle_id, r.code, r.name),
      holder: (r.holder_nombre || r.holder_username || null) as string | null,
      desde: r.taken_at as string | null,
    }));
  }

  /**
   * ⭐ **Qué se contó ya en este rack, SIN las cantidades.**
   *
   * §4.6 pide que quien tome un rack relevado «vea lo que ya se contó ahí, para continuar y no
   * recomenzar». §4.3 prohíbe mostrarle la cantidad ajena: el conteo es ciego y decirle «ya hay
   * 24» le da un número al que anclarse. Las dos cosas se cumplen mostrando **qué productos**, no
   * **cuántos** — que además es lo único que hace falta para no recontar.
   */
  private async yaContadoEn(trx: any, countId: string, aisleId: string | null, pass: number) {
    const { rows } = await trx.raw(
      `SELECT DISTINCT i.product_id, i.product_sku, p.nombre AS name
         FROM commercial.inventory_count_scan_log l
         JOIN commercial.inventory_count_items i ON i.id = l.item_id
         LEFT JOIN public.products p ON p.id = i.product_id
        WHERE l.count_id = ?
          AND l.aisle_id IS NOT DISTINCT FROM ?::uuid
          AND l.slot = ?
          AND l.quantity_native IS NOT NULL
        ORDER BY p.nombre NULLS LAST
        LIMIT 500`,
      [countId, aisleId, `count_${pass}`],
    );
    return (rows as any[]).map((r) => ({
      product_id: r.product_id ?? null,
      product_sku: r.product_sku ?? null,
      name: r.name ?? null,
    }));
  }

  private async contarCapturas(trx: any, countId: string, aisleId: string | null, pass: number): Promise<number> {
    const { rows } = await trx.raw(
      `SELECT count(*)::int AS n
         FROM commercial.inventory_count_scan_log l
        WHERE l.count_id = ?
          AND l.aisle_id IS NOT DISTINCT FROM ?::uuid
          AND l.slot = ?
          AND l.quantity_native IS NOT NULL`,
      [countId, aisleId, `count_${pass}`],
    );
    return Number((rows as any[])[0]?.n) || 0;
  }
}
