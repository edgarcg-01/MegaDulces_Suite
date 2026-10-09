import { Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService, obligacionNoEsDePruebaSql } from '@megadulces/platform-core';

const round2 = (n: number) => Math.round(Number(n) * 100) / 100;

/** Un renglón esperando una firma. `monto` NULL = no medible; nunca 0 para decir "no sé". */
export interface FirmaPendiente {
  tipo: 'ejercicio' | 'obligacion';
  id: string;
  titulo: string;
  detalle: string;
  monto: number | null;
  /** Mejor aproximación disponible a "desde cuándo espera". Ver `desde_es_proxy`. */
  desde: string | null;
  dias_esperando: number | null;
  desde_es_proxy: boolean;
  /** La consecuencia de NO firmar, en una línea. Sin esto la bandeja es una lista de tareas. */
  que_se_traba: string;
  ruta: string;
  permiso: string;
}

/**
 * ⭐ El estado de UNA cola. Va por cola y no sólo en total porque **una cola vacía se esconde
 * detrás de una llena**: medido en prod el 2026-10-09, la bandeja trae 156 obligaciones por
 * $74.8M y **cero** ejercicios — con un solo contador, ese cero no se ve, y es justamente el
 * que dice que nadie mandó un presupuesto a aprobar.
 */
export interface EstadoCola {
  cola: 'ejercicios' | 'obligaciones';
  total: number;
  monto: number | null;
  vacia_porque: string | null;
}

export interface BandejaFirmas {
  total: number;
  monto_total: number | null;
  items: FirmaPendiente[];
  por_cola: EstadoCola[];
  /** Sólo cuando `total === 0`: POR QUÉ está vacía la bandeja entera. */
  vacia_porque: string | null;
  aguas_arriba: {
    ejercicios_borrador: number;
    ejercicios_en_revision: number;
    obligaciones_propuesta: number;
    monto_propuesta: number | null;
  };
  excluido_por_prueba: { ejercicios: number; obligaciones: number; monto: number | null };
  as_of: string;
}

/**
 * `[TES.17]` **La bandeja de firmas — el verbo que el encabezado promete y que no tenía cola.**
 *
 * `/presupuesto` dice textual *"El sistema arma solo el presupuesto... Tú **autorizas**"*, y
 * medido contra prod el 2026-10-09 **no había una sola cosa esperando una firma**: los 3
 * ejercicios en `borrador`, las 312 obligaciones en `propuesta`, cero autorizadas. El verbo de
 * Dirección existía en el título y no tenía bandeja.
 *
 * Las dos colas son las dos únicas puertas donde un humano convierte una propuesta en un hecho:
 *
 *     budget.budgets            status 'pendiente'  -> POST budgets/:id/approve   (PRESUPUESTOS_APROBAR)
 *     budget.expense_obligations status 'propuesta' -> POST expenses/authorize    (acto humano, HITL)
 *
 * ── ⭐ POR QUÉ ESTO NO ES UNA LISTA DE TAREAS ──────────────────────────────
 *
 * **Una bandeja vacía y una tubería trabada se ven IGUAL.** Hoy esta bandeja devuelve cero
 * items, y la lectura ingenua es "no hay nada que hacer"; la verdad es "nadie envió nada". Por
 * eso `vacia_porque` no es decorado: es el campo que distingue las dos, y se **deriva** de lo
 * que hay aguas arriba en vez de escribirse a mano. Es ADR-056 aplicado a una cola — lo que no
 * se puede afirmar se declara — con una vuelta de tuerca: acá lo que se declara es el VACÍO.
 *
 * Y cada renglón carga `que_se_traba`. Una cola sin consecuencia escrita no se atiende: la
 * frase de las obligaciones no la inventé, es la del propio endpoint que las autoriza —
 * *"recién ahí entran al Calendario"*.
 *
 * ── ⚠️ EL EJERCICIO DE PRUEBA NO SUMA, Y SE DECLARA CUÁNTO SE SACÓ ────────
 *
 * `budget.budgets` tiene un duplicado marcado `is_test` que es copia **byte a byte** del real
 * (mismos 47 renglones, mismos $74,850,066.62). Si entrara a una cifra que Dirección mira para
 * firmar, la bandeja pediría autorizar **el doble**. Se excluye — y se publica **cuánto se
 * excluyó**, porque un filtro silencioso es otra manera de que el número no se pueda explicar.
 *
 * ⛔ `expense_obligations` **no tiene `budget_id`**: el salto es
 * `budget_line_id -> budget_lines.budget_id -> budgets.is_test`. Sin ese salto se cuenta doble
 * y se ve perfectamente normal. Es el mismo `whereNotExists` de `budget-cashflow.service.ts`, y
 * va con `NOT EXISTS` y no con `JOIN` a propósito: un `JOIN` también se comería las
 * obligaciones **sin** partida, que no son de prueba — sólo no están ligadas.
 *
 * ── ⚠️ `desde` ES UN PROXY Y LO DICE ─────────────────────────────────────
 *
 * Ninguna de las dos tablas guarda *cuándo entró a la cola*: `budgets` tiene `authorized_at`
 * (que se llena al SALIR, no al entrar) y las obligaciones sólo `created_at`. Se usa
 * `updated_at` para el ejercicio y `created_at` para la obligación, y cada fila viaja con
 * `desde_es_proxy: true`. Publicar "lleva 12 días esperando" como un hecho medido, cuando es
 * la fecha del último toque, sería exactamente el tipo de cifra que no se puede defender.
 */
@Injectable()
export class PendingApprovalsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async bandeja(): Promise<BandejaFirmas> {
    const tenantId = this.tenantCtx.requireTenantId();
    const hoy = new Date();

    return this.tk.run(async (trx) => {
      // ── Cola 1: ejercicios esperando aprobación ────────────────────────
      const ejercicios = await trx('budget.budgets')
        .where({ tenant_id: tenantId })
        .select('id', 'folio', 'name', 'fiscal_year', 'status', 'updated_at', 'is_test')
        .whereIn('status', ['pendiente'])
        .orderBy('updated_at', 'asc');

      // ── Cola 2: obligaciones esperando autorización ────────────────────
      /*
       * `[PVI.17]` El `NOT EXISTS` que saca SÓLO lo que cuelga de un ejercicio de prueba se mudó a
       * `libs/platform-core` **sin cambiar una coma de su lógica**. Motivo: «Mi trabajo»
       * (`libs/trade`) necesita exactamente el mismo filtro para contar esta cola en la portada de
       * Dirección, y las dos librerías no se pueden importar entre sí. Copiarlo ya cobró el mismo
       * día: una sesión midió «312 obligaciones por $149,618,183.14» —el duplicado incluido— y
       * estuvo a un commit de cablear el doble a la portada. **Dos definiciones de la misma cola
       * es cómo nacen los dos números.**
       */
      const noEsDePrueba = (qb: any) => qb.whereRaw(obligacionNoEsDePruebaSql());

      const oblig = await noEsDePrueba(trx('budget.expense_obligations'))
        .where({ tenant_id: tenantId }).andWhere('status', 'propuesta')
        .select('id', 'concept', 'beneficiary', 'subtype', 'original_amount', 'original_due_date',
          'created_at', 'is_critical')
        .orderBy('original_amount', 'desc');

      // ── Lo que se dejó afuera, para poder decirlo ──────────────────────
      const [prueba] = await trx('budget.budgets').where('is_test', true).count<{ count: string }[]>('* as count');
      const obligPrueba = await trx('budget.expense_obligations as o')
        .join('budget.budget_lines as bl', 'bl.id', 'o.budget_line_id')
        .join('budget.budgets as bb', 'bb.id', 'bl.budget_id')
        .where('bb.is_test', true).andWhere('o.status', 'propuesta')
        .select(trx.raw('count(*)::int as n'), trx.raw('coalesce(sum(o.original_amount),0)::float8 as monto'))
        .first() as unknown as { n: number; monto: number };

      // ── Aguas arriba: lo que explica un vacío ──────────────────────────
      const porEstado = await trx('budget.budgets')
        .where({ tenant_id: tenantId })
        .andWhere((q: any) => q.where('is_test', false).orWhereNull('is_test'))
        .select('status').count<{ status: string; n: string }[]>('* as n').groupBy('status');
      const cuenta = (s: string) => Number(porEstado.find((r) => r.status === s)?.n ?? 0);

      const propuestaAgg = await noEsDePrueba(trx('budget.expense_obligations'))
        .where({ tenant_id: tenantId }).andWhere('status', 'propuesta')
        .select(trx.raw('count(*)::int as n'), trx.raw('coalesce(sum(original_amount),0)::float8 as monto'))
        .first() as unknown as { n: number; monto: number };

      const dias = (d: Date | string | null) => {
        if (!d) return null;
        const t = new Date(d).getTime();
        return Number.isNaN(t) ? null : Math.max(0, Math.round((hoy.getTime() - t) / 86400000));
      };
      const iso = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);

      const items: FirmaPendiente[] = [];

      for (const e of ejercicios.filter((r: any) => r.is_test !== true)) {
        items.push({
          tipo: 'ejercicio',
          id: e.id,
          titulo: `${e.folio ?? 'sin folio'} · ${e.name}`,
          detalle: `Ejercicio ${e.fiscal_year}`,
          monto: null, // el egreso vigente se mide en otra consulta; acá NULL es honesto, 0 no
          desde: iso(e.updated_at),
          dias_esperando: dias(e.updated_at),
          desde_es_proxy: true,
          que_se_traba: 'Sin aprobar, el ejercicio no se hace vigente ni materializa sus partidas: nada gobierna el gasto.',
          ruta: '/presupuesto',
          permiso: 'PRESUPUESTOS_APROBAR',
        });
      }

      for (const o of oblig) {
        const monto = o.original_amount === null || o.original_amount === undefined
          ? null : round2(Number(o.original_amount));
        items.push({
          tipo: 'obligacion',
          id: o.id,
          titulo: o.concept ?? '(sin concepto)',
          detalle: [o.beneficiary, o.subtype, o.is_critical ? 'crítico' : null]
            .filter(Boolean).join(' · ') || '—',
          monto,
          desde: iso(o.created_at),
          dias_esperando: dias(o.created_at),
          desde_es_proxy: true,
          que_se_traba: 'Sin autorizar NO entra al Calendario de pagos: no se le puede asignar día ni reservar capacidad.',
          ruta: '/presupuesto',
          permiso: 'FINANCE_PAYMENTS_GESTIONAR',
        });
      }

      const montos = items.map((i) => i.monto).filter((m): m is number => m !== null);
      const montoTotal = montos.length ? round2(montos.reduce((a, b) => a + b, 0)) : null;

      const dinero = (n: number) => n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

      // ── El estado de cada cola, POR SEPARADO ───────────────────────────
      // Medido en prod: ejercicios 0 · obligaciones 156 por $74,809,091.57. Con un solo
      // contador el cero de la primera queda tapado por la segunda, y ese cero es el que dice
      // que nadie mandó un presupuesto a aprobar.
      const nEjercicios = items.filter((i) => i.tipo === 'ejercicio').length;
      const nOblig = items.filter((i) => i.tipo === 'obligacion').length;
      const montoOblig = items.filter((i) => i.tipo === 'obligacion')
        .map((i) => i.monto).filter((m): m is number => m !== null);

      const porCola: EstadoCola[] = [
        {
          cola: 'ejercicios',
          total: nEjercicios,
          monto: null, // el egreso vigente no se mide acá; NULL es honesto, 0 sería falso
          vacia_porque: nEjercicios > 0 ? null
            : (cuenta('borrador') || cuenta('en_revision'))
              ? `Ningún ejercicio espera aprobación, pero hay ${cuenta('borrador')} en borrador y ${cuenta('en_revision')} en revisión: nadie apretó «Enviar a autorización».`
              : 'No hay ejercicios esperando aprobación ni ninguno preparándose.',
        },
        {
          cola: 'obligaciones',
          total: nOblig,
          monto: montoOblig.length ? round2(montoOblig.reduce((a, b) => a + b, 0)) : null,
          vacia_porque: nOblig > 0 ? null
            : 'Ninguna obligación espera autorización.',
        },
      ];

      // ── ⭐ El vacío, explicado ──────────────────────────────────────────
      // Se DERIVA de lo de arriba. Si algún día hay 0 items y 0 aguas arriba, el mensaje lo
      // dice igual de claro — y eso sí sería "no hay nada que hacer".
      let vaciaPorque: string | null = null;
      if (items.length === 0) {
        const partes: string[] = [];
        if (cuenta('borrador')) partes.push(`${cuenta('borrador')} ejercicio(s) en borrador`);
        if (cuenta('en_revision')) partes.push(`${cuenta('en_revision')} en revisión`);
        if (propuestaAgg?.n) {
          partes.push(`${propuestaAgg.n} obligación(es) en propuesta por ${dinero(round2(propuestaAgg.monto))}`);
        }
        vaciaPorque = partes.length
          ? `Nadie ha enviado nada a firma. Aguas arriba hay ${partes.join(' y ')}: la bandeja está vacía porque la tubería está trabada, no porque no haya trabajo.`
          : 'No hay nada esperando firma y tampoco nada aguas arriba: la cola está realmente al día.';
      }


      return {
        total: items.length,
        monto_total: montoTotal,
        items,
        por_cola: porCola,
        vacia_porque: vaciaPorque,
        aguas_arriba: {
          ejercicios_borrador: cuenta('borrador'),
          ejercicios_en_revision: cuenta('en_revision'),
          obligaciones_propuesta: propuestaAgg?.n ?? 0,
          monto_propuesta: propuestaAgg ? round2(propuestaAgg.monto) : null,
        },
        excluido_por_prueba: {
          ejercicios: Number(prueba?.count ?? 0),
          obligaciones: obligPrueba?.n ?? 0,
          monto: obligPrueba ? round2(obligPrueba.monto) : null,
        },
        as_of: new Date().toISOString(),
      };
    });
  }
}
