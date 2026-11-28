import {
  AREAS_ACUERDO, DIAS_MAX_COMPROMISO, MAX_CONTACTO_PROVEEDOR, MAX_DESCRIPCION_ACUERDO, MAX_NOTA_CIERRE_ACUERDO, sumarDias,
  type AccionAcuerdo, type AreaAcuerdo, type CapturarAcuerdoDto, type EstadoAcuerdo, type EstadoReunion, type SituacionAcuerdo,
} from '@megadulces/contracts';

/**
 * `[PQ.3.10]` Compras › Proveedores › Acuerdos — el dominio, sin base de datos (C1).
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PQ_ANEXO_CALENDARIO_COMPRAS.md` §9.3 y §10.20 (DC43–DC46), ADR-128.
 * Lo que aquí se decide, la base lo vuelve a exigir con sus CHECK (migración 20261126232231): el dominio da el mensaje en
 * español ANTES de llegar a la base; la base es la última palabra. Lo que cruza tablas (la reunión realizada, quién
 * puede ser responsable) sólo lo puede exigir aquí.
 *
 * Puras: no leen el reloj (`hoy` llega como argumento, fecha de la Ciudad de México) ni la base.
 */

export class AcuerdosError extends Error {
  constructor(readonly tipo: 'no_encontrado' | 'invalido' | 'conflicto', mensaje: string) {
    super(mensaje);
  }
}

const invalido = (m: string) => new AcuerdosError('invalido', m);
const conflicto = (m: string) => new AcuerdosError('conflicto', m);

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `AAAA-MM-DD` que existe en el calendario (no `2026-02-30`). */
function esFecha(s: unknown): s is string {
  if (typeof s !== 'string' || !FECHA.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** La reunión de la que sale el acuerdo, como la necesita el dominio. */
export interface ReunionDelAcuerdo {
  readonly status: EstadoReunion;
  /** El día de la reunión en la Ciudad de México (`AAAA-MM-DD`). */
  readonly fecha: string;
  readonly organizer_user_id: string;
}

export interface AcuerdoNormalizado {
  readonly area: AreaAcuerdo;
  readonly description: string;
  readonly supplier_contact: string | null;
  readonly assigned_to: string;
  readonly due_date: string;
}

/**
 * Por qué esta reunión NO recibe acuerdos (o `null` si sí). Lo acordado sale de lo que pasó (DC45): sólo una reunión
 * REALIZADA, que en Citas exige su minuta. La misma regla arma el botón y frena la escritura.
 */
export function porQueNoRecibe(reunion: Pick<ReunionDelAcuerdo, 'status'>): string | null {
  if (reunion.status === 'held') return null;
  if (reunion.status === 'cancelled') return 'La reunión está cancelada: no tiene acuerdos.';
  return 'Los acuerdos salen de una reunión realizada: escribe primero su minuta.';
}

/**
 * Capturar o editar un acuerdo de `reunion`. `responsables` = las personas que pueden tener un acuerdo de Mega Dulces
 * (las que AGENDAN Citas: DC44, cada responsable cierra el suyo), por id en minúsculas.
 *  - Del PROVEEDOR (DC43): el nombre de su persona es obligatorio y el responsable en la Suite es quien organizó la
 *    reunión; si la pantalla manda otro, se rechaza (no se cambia en silencio).
 *  - De un área de Mega Dulces: el responsable es obligatorio y tiene que agendar Citas; sin nombre de proveedor.
 *  - La fecha compromiso: desde el día de la reunión y hasta dos años después.
 */
export function validarAcuerdo(dto: CapturarAcuerdoDto, reunion: ReunionDelAcuerdo, responsables: ReadonlySet<string>): AcuerdoNormalizado {
  if (!dto || typeof dto !== 'object') throw invalido('Faltan los datos del acuerdo.');
  const motivo = porQueNoRecibe(reunion);
  if (motivo) throw conflicto(motivo);

  if (!AREAS_ACUERDO.includes(dto.area)) throw invalido('Elige el área del acuerdo.');

  const description = texto(dto.description);
  if (!description) throw invalido('Escribe qué se acordó.');
  if (description.length > MAX_DESCRIPCION_ACUERDO) {
    throw invalido(`Lo acordado, máximo ${MAX_DESCRIPCION_ACUERDO} caracteres (tiene ${description.length}).`);
  }

  const due_date = texto(dto.due_date);
  if (!esFecha(due_date)) throw invalido('La fecha compromiso no es válida (AAAA-MM-DD).');
  if (due_date < reunion.fecha) throw invalido('La fecha compromiso no puede ser antes de la reunión.');
  if (due_date > sumarDias(reunion.fecha, DIAS_MAX_COMPROMISO)) throw invalido('La fecha compromiso está a más de dos años de la reunión.');

  const contacto = texto(dto.supplier_contact);
  const pedido = texto(dto.assigned_to).toLowerCase();
  const organizador = reunion.organizer_user_id.toLowerCase();

  if (dto.area === 'supplier') {
    if (!contacto) throw invalido('Escribe el nombre de la persona del proveedor que se comprometió.');
    if (contacto.length > MAX_CONTACTO_PROVEEDOR) {
      throw invalido(`El nombre, máximo ${MAX_CONTACTO_PROVEEDOR} caracteres (tiene ${contacto.length}).`);
    }
    if (pedido && pedido !== organizador) {
      throw invalido('El acuerdo del proveedor lo sigue quien organizó la reunión: no se le asigna a otra persona.');
    }
    return { area: dto.area, description, supplier_contact: contacto, assigned_to: organizador, due_date };
  }

  if (contacto) throw invalido('Sólo el acuerdo del proveedor lleva el nombre de una persona del proveedor.');
  if (!UUID.test(pedido)) throw invalido('Elige quién de Mega Dulces es responsable del acuerdo.');
  if (!responsables.has(pedido)) throw invalido('El responsable tiene que agendar Citas: cada responsable cierra el suyo.');
  return { area: dto.area, description, supplier_contact: null, assigned_to: pedido, due_date };
}

/** La nota con que se cumple o se cancela un acuerdo. */
export function validarNota(dto: unknown): string {
  const t = texto((dto as { note?: unknown } | null)?.note);
  if (!t) throw invalido('Escribe la nota de cierre: qué pasó con el acuerdo.');
  if (t.length > MAX_NOTA_CIERRE_ACUERDO) throw invalido(`La nota, máximo ${MAX_NOTA_CIERRE_ACUERDO} caracteres (tiene ${t.length}).`);
  return t;
}

/**
 * Por qué NO se puede hacer `accion` con un acuerdo en `estado` (o `null` si sí). La misma regla arma los botones
 * (`acciones`) y frena la escritura, para que la pantalla no ofrezca lo que la API rechaza.
 *  - Cumplido y cancelado son finales: si hace falta, se captura otro en la siguiente reunión.
 *  - Iniciar sólo desde pendiente.
 */
export function porQueNo(accion: AccionAcuerdo, estado: EstadoAcuerdo): string | null {
  if (estado === 'done') return 'El acuerdo ya se cumplió: si hace falta otro, captúralo en la siguiente reunión.';
  if (estado === 'cancelled') return 'El acuerdo está cancelado: si hace falta otro, captúralo en la siguiente reunión.';
  if (accion === 'iniciar' && estado !== 'pending') return 'El acuerdo ya está en curso.';
  return null;
}

export function exigir(accion: AccionAcuerdo, estado: EstadoAcuerdo): void {
  const motivo = porQueNo(accion, estado);
  if (motivo) throw conflicto(motivo);
}

const ACCIONES: readonly AccionAcuerdo[] = ['iniciar', 'cumplir', 'cancelar', 'editar'];

export function acciones(estado: EstadoAcuerdo): AccionAcuerdo[] {
  return ACCIONES.filter((a) => porQueNo(a, estado) === null);
}

/** El estado al que lleva cada acción que cierra o inicia (editar no cambia el estado). */
export function estadoTras(accion: Exclude<AccionAcuerdo, 'editar'>): EstadoAcuerdo {
  return accion === 'iniciar' ? 'in_progress' : accion === 'cumplir' ? 'done' : 'cancelled';
}

interface Plazo {
  readonly status: EstadoAcuerdo;
  readonly due_date: string;
}

/**
 * Cómo va, para la persona. `hoy` es la fecha de la Ciudad de México. «Esta semana» = de mañana a seis días: los
 * siete días que siguen, no la semana del calendario (un acuerdo del lunes siguiente se ve el viernes).
 */
export function situacion(a: Plazo, hoy: string): SituacionAcuerdo {
  if (a.status === 'done') return 'cumplido';
  if (a.status === 'cancelled') return 'cancelado';
  if (a.due_date < hoy) return 'vencido';
  if (a.due_date === hoy) return 'vence_hoy';
  if (a.due_date <= sumarDias(hoy, 6)) return 'esta_semana';
  return 'al_dia';
}

const RANGO: Readonly<Record<SituacionAcuerdo, number>> = {
  vencido: 0, vence_hoy: 1, esta_semana: 2, al_dia: 3, cumplido: 4, cancelado: 4,
};

interface Ordenable extends Plazo {
  readonly id: string;
  readonly closed_at: string | null;
}

/**
 * El orden de la pestaña (§10.20): lo abierto primero —vencido, vence hoy, esta semana, al día—, por fecha compromiso
 * (lo más atrasado arriba); lo cerrado al final, lo más recién cerrado arriba. Empates por id: el orden es estable.
 */
export function ordenar<T extends Ordenable>(xs: readonly T[], hoy: string): T[] {
  return [...xs].sort((x, y) => {
    const sx = situacion(x, hoy); const sy = situacion(y, hoy);
    if (RANGO[sx] !== RANGO[sy]) return RANGO[sx] - RANGO[sy];
    if (RANGO[sx] < 4) {
      if (x.due_date !== y.due_date) return x.due_date < y.due_date ? -1 : 1;
    } else {
      const cx = x.closed_at ?? ''; const cy = y.closed_at ?? '';
      if (cx !== cy) return cx > cy ? -1 : 1;
    }
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
}
