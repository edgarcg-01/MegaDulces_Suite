/**
 * Fase RH · frente NE · `[NE.0.17]` — EL PUENTE ENTRE UN PADRÓN DE NÓMINA Y EL DE LA SUITE.
 *
 * Cierra el patrón *A2 «dos padrones sin llave común, que sólo se unen por el nombre escrito»*.
 * Una sola pieza para las **dos** fuentes de nómina que existen, porque el empate es el mismo:
 *   · **ContPAQi** (`contpaqi_ods.v_nomina_empleado`, dentro de la base) → `system = 'contpaqi'`
 *   · el padrón del sistema viejo (el `.mdb`, la mitad en **efectivo**)   → `system = 'nomina'`
 *
 * ⛔ **No hay llave dura que comprar** (`[NE.0.13]`): el número del reloj coincide con el de
 * nómina **por debajo de lo que daría el azar** (1.8 % contra 6.5 %), `person_code` no coincide
 * nunca, y la CURP —que sí liga contra ContPAQi— **la Suite no la guarda en ningún lado**. El
 * empate por nombre no es pereza: hoy es lo único que hay. Por eso lo que sale de acá **se marca
 * como provisional** (`matched_by = 'nombre'`) y se puede auditar y reemplazar.
 *
 * ── Las cuatro reglas, cada una con la medición que la obligó (2026-11-24, prod, sólo lectura) ──
 *
 * 1. ⛔⛔ **«Activo» NO es la población viva.** De 1,246 usuarios internos, **263 están `active`,
 *    435 están `invited`** —cargados por `[RH.1.4]`, nunca entraron al sistema, **y cobran igual**—
 *    y 548 son bajas. *Cifra: filtrar por «activo» hundió el empate de 77.6 % a **39 %**, y el
 *    error no se veía: daba un número plausible.* Ver `[NE.0.10]`: «activo» en un padrón no
 *    significa nada; el hecho es **quién cobró**.
 *
 * 2. ⛔ **Un empate 1:N no es un empate.** Un nombre repetido suele ser un registro viejo sin dar
 *    de baja: si **uno solo** de los candidatos está `active`, ése es; si quedan dos del mismo
 *    estado, va a la cola humana. *Cifra: preferir el vigente dejó la ambigüedad en 1 de 259.*
 *
 * 3. ⛔ **El nivel 3 no es un empate, es un JUICIO.** Coincidir sólo en apellidos + primer nombre
 *    **no se inserta**: un alias equivocado liga a una persona con el sueldo de otra. Sale como
 *    rechazo `juicio` para que lo resuelva alguien (`[NE.0.5]`).
 *
 * 4. ⭐ **Dos códigos para UNA persona sí se registran; dos PERSONAS bajo un usuario, nunca.**
 *    Se distinguen por su llave dura (CURP · RFC · NSS). *Cifra: el padrón del `.mdb` tiene a una
 *    persona dada de alta **dos veces**, con la misma CURP, el mismo RFC y el mismo NSS —una de
 *    las filas con la CURP partida por un salto de línea—. Registrar los dos códigos es correcto:
 *    es exactamente lo que una tabla de alias existe para decir.*
 *
 * Lógica **pura**: no toca base ni red. Quien la alimenta y quien escribe `hr.person_aliases`
 * viven en el servicio; acá sólo está la decisión, para que se pueda probar sin base.
 */

/** Una persona tal como la nombra SU sistema de nómina. */
export interface PersonaDeNomina {
  /** Cómo la nombra su sistema. Es el `external_code` del alias. */
  codigo: string;
  nombreCompleto: string;
  /**
   * Lo que permite saber si dos filas son la MISMA persona: CURP, RFC, NSS… Se comparan
   * normalizadas (sin espacios ni saltos de línea, en mayúsculas) y se ignoran los rellenos
   * (`-`, vacío, `null`), que en estos padrones abundan y empatarían a todos con todos.
   */
  llavesDuras?: ReadonlyArray<string | number | null | undefined>;
}

/** Una persona del padrón de la Suite (`identity.users`, `kind = 'interno'`). */
export interface PersonaDeLaSuite {
  id: string;
  nombre: string;
  /** `active` · `invited` · `terminated`… tal cual viene de `identity.users.status`. */
  status: string;
}

/** Los estados de `identity.users` que son **gente viva**: trabaja y cobra. */
export const ESTADOS_VIVOS: ReadonlySet<string> = new Set(['active', 'invited']);

export type NivelDeEmpate = 1 | 2;

export interface EmpateDePadron {
  codigo: string;
  userId: string;
  nivel: NivelDeEmpate;
  /** En palabras, para la nota del alias: queda escrito CÓMO se ligó. */
  como: string;
  /** Su sistema de nómina tiene más de un código para esta misma persona. */
  duplicado: boolean;
}

export type MotivoDeRechazo =
  /** Más de un candidato vivo y ninguno destaca: un 1:N no es un empate. */
  | 'ambiguo'
  /** Sólo coincide con alguien que la Suite tiene dado de baja: cobra y figura como baja. */
  | 'solo-baja'
  /** Nadie se llama así en la Suite. */
  | 'sin-candidato'
  /** Coincide sólo en apellidos + primer nombre: es un juicio, lo decide una persona. */
  | 'juicio'
  /** Dos PERSONAS distintas caen en el mismo usuario: no se liga ninguna. */
  | 'choque';

export interface RechazoDePadron {
  codigo: string;
  motivo: MotivoDeRechazo;
  /** Qué habría que mirar para resolverlo. Sin datos personales. */
  detalle: string;
}

export interface Puente {
  empates: EmpateDePadron[];
  rechazos: RechazoDePadron[];
  resumen: {
    universo: number;
    nivel1: number;
    nivel2: number;
    ligados: number;
    rechazados: number;
    /** Personas cuyo sistema de nómina les dio más de un código (y las dos filas son la misma persona). */
    duplicadosEnElOrigen: number;
    /** `ligados + rechazados` tiene que ser `universo`: si no, el puente perdió gente en el camino. */
    cierra: boolean;
  };
}

/**
 * MAYÚSCULAS, sin acentos, sin puntuación, espacios colapsados.
 *
 * ⭐ **La `Ñ` se pliega a `N` a propósito**, igual que los acentos: los dos padrones escriben el
 * mismo apellido de las dos formas («Muñoz» y «Munoz») y son la misma persona. Plegarla une; no
 * plegarla pierde empates reales. Un salto de línea dentro del dato —que los hay— cae como espacio.
 */
export function normalizaNombre(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const palabras = (s: string | null | undefined): string[] => normalizaNombre(s).split(' ').filter(Boolean);
/** Las mismas palabras en cualquier orden: «Juan Pérez Soto» y «Pérez Soto Juan» son el mismo nombre. */
const enOrden = (s: string | null | undefined): string => palabras(s).slice().sort().join(' ');

/** Las llaves duras que de verdad identifican: sin rellenos ni espacios. */
function llavesUtiles(p: PersonaDeNomina): string[] {
  return (p.llavesDuras ?? [])
    .map((v) => String(v ?? '').replace(/\s+/g, '').toUpperCase())
    .filter((v) => v !== '' && v !== '-' && v !== 'NULL' && v !== '0');
}

/** ¿Dos filas del padrón son la misma persona? Lo dice una llave dura compartida, no el nombre. */
export function esLaMismaPersona(a: PersonaDeNomina, b: PersonaDeNomina): boolean {
  const la = llavesUtiles(a);
  if (!la.length) return false;
  const lb = new Set(llavesUtiles(b));
  return la.some((k) => lb.has(k));
}

function indexa(gente: readonly PersonaDeLaSuite[], llave: (n: string) => string): Map<string, PersonaDeLaSuite[]> {
  const m = new Map<string, PersonaDeLaSuite[]>();
  for (const u of gente) {
    const k = llave(u.nombre);
    if (!k) continue;
    const ya = m.get(k);
    if (ya) ya.push(u);
    else m.set(k, [u]);
  }
  return m;
}

/**
 * De varios candidatos vivos, el único que vale. Regla 2: si **uno solo** está `active`, ése es
 * (los otros son registros viejos sin dar de baja). Si no destaca ninguno, no hay empate.
 */
function elUnico(candidatos: readonly PersonaDeLaSuite[]): PersonaDeLaSuite | null {
  if (candidatos.length <= 1) return candidatos[0] ?? null;
  const activos = candidatos.filter((u) => u.status === 'active');
  return activos.length === 1 ? (activos[0] as PersonaDeLaSuite) : null;
}

/** La clave del nivel 3 en la Suite: los dos últimos tokens son los apellidos. */
function claveDeJuicio(nombre: string): string {
  const t = palabras(nombre);
  return t.length >= 3 ? `${t[t.length - 2]}|${t[t.length - 1]}|${t[0]}` : '';
}

/** La clave del nivel 3 en el padrón de nómina, que sí trae los apellidos separados. */
function claveDeJuicioDePadron(p: PersonaDeNomina & { aPaterno?: string; aMaterno?: string }): string {
  const ap = normalizaNombre(p.aPaterno);
  const am = normalizaNombre(p.aMaterno);
  if (!ap || !am) return claveDeJuicio(p.nombreCompleto);
  const apellidos = new Set([...palabras(ap), ...palabras(am)]);
  const pila = palabras(p.nombreCompleto).filter((t) => !apellidos.has(t));
  return pila.length ? `${ap}|${am}|${pila[0]}` : '';
}

/**
 * Tiende el puente entre un padrón de nómina y el de la Suite.
 *
 * Todo el universo sale clasificado: lo que no liga **se declara con su motivo**, no se pierde
 * (ADR-056). `resumen.cierra` lo verifica: `ligados + rechazados === universo`.
 */
export function tiendePuente(
  padron: ReadonlyArray<PersonaDeNomina & { aPaterno?: string; aMaterno?: string }>,
  suite: readonly PersonaDeLaSuite[],
): Puente {
  const vivos = suite.filter((u) => ESTADOS_VIVOS.has(u.status));
  const bajas = suite.filter((u) => !ESTADOS_VIVOS.has(u.status));
  const porExacto = indexa(vivos, normalizaNombre);
  const porOrden = indexa(vivos, enOrden);
  const porBajas = indexa(bajas, normalizaNombre);

  const porJuicio = new Map<string, PersonaDeLaSuite[]>();
  for (const u of vivos) {
    const k = claveDeJuicio(u.nombre);
    if (!k) continue;
    const ya = porJuicio.get(k);
    if (ya) ya.push(u);
    else porJuicio.set(k, [u]);
  }

  const empates: EmpateDePadron[] = [];
  const rechazos: RechazoDePadron[] = [];

  for (const p of padron) {
    const exacto = porExacto.get(normalizaNombre(p.nombreCompleto)) ?? [];
    const u1 = elUnico(exacto);
    if (u1) {
      empates.push({
        codigo: p.codigo, userId: u1.id, nivel: 1, duplicado: false,
        como: exacto.length > 1 ? 'nombre exacto (varios registros, uno solo vigente)' : 'nombre exacto',
      });
      continue;
    }
    if (exacto.length) {
      rechazos.push({ codigo: p.codigo, motivo: 'ambiguo', detalle: `${exacto.length} personas vivas se llaman igual y ninguna destaca` });
      continue;
    }

    const orden = porOrden.get(enOrden(p.nombreCompleto)) ?? [];
    const u2 = elUnico(orden);
    if (u2) {
      empates.push({ codigo: p.codigo, userId: u2.id, nivel: 2, duplicado: false, como: 'mismos nombres en otro orden' });
      continue;
    }
    if (orden.length) {
      rechazos.push({ codigo: p.codigo, motivo: 'ambiguo', detalle: `${orden.length} personas vivas con los mismos nombres` });
      continue;
    }

    // Regla 3: coincidir sólo en apellidos + primer nombre NO liga. Lo decide una persona.
    const kj = claveDeJuicioDePadron(p);
    if (kj && (porJuicio.get(kj) ?? []).length) {
      rechazos.push({ codigo: p.codigo, motivo: 'juicio', detalle: 'coincide en apellidos y primer nombre, pero no en el nombre completo' });
      continue;
    }

    if ((porBajas.get(normalizaNombre(p.nombreCompleto)) ?? []).length) {
      rechazos.push({ codigo: p.codigo, motivo: 'solo-baja', detalle: 'cobra, y en la Suite figura como baja' });
      continue;
    }
    rechazos.push({ codigo: p.codigo, motivo: 'sin-candidato', detalle: 'nadie se llama así en la Suite' });
  }

  // ── Regla 4: un usuario con más de un código ───────────────────────────────────────────────
  const delPadron = new Map(padron.map((p) => [p.codigo, p]));
  const porUsuario = new Map<string, EmpateDePadron[]>();
  for (const e of empates) {
    const ya = porUsuario.get(e.userId);
    if (ya) ya.push(e);
    else porUsuario.set(e.userId, [e]);
  }
  const vetados = new Set<string>();
  let duplicadosEnElOrigen = 0;
  for (const [, grupo] of porUsuario) {
    if (grupo.length < 2) continue;
    const filas = grupo.map((e) => delPadron.get(e.codigo) as PersonaDeNomina);
    const mismaPersona = filas.every((f) => esLaMismaPersona(f, filas[0] as PersonaDeNomina));
    if (mismaPersona) {
      duplicadosEnElOrigen++;
      for (const e of grupo) e.duplicado = true;
    } else {
      for (const e of grupo) {
        vetados.add(e.codigo);
        rechazos.push({
          codigo: e.codigo, motivo: 'choque',
          detalle: `${grupo.length} códigos de personas distintas caen en el mismo usuario de la Suite`,
        });
      }
    }
  }
  const finales = empates.filter((e) => !vetados.has(e.codigo));

  const nivel1 = finales.filter((e) => e.nivel === 1).length;
  const nivel2 = finales.length - nivel1;
  return {
    empates: finales,
    rechazos,
    resumen: {
      universo: padron.length,
      nivel1,
      nivel2,
      ligados: finales.length,
      rechazados: rechazos.length,
      duplicadosEnElOrigen,
      cierra: finales.length + rechazos.length === padron.length,
    },
  };
}

/**
 * La nota que queda escrita en el alias. ⭐ Un empate por nombre es **provisional por
 * definición**: la nota dice cómo se ligó y con qué, para poder auditarlo y reemplazarlo.
 * ⛔ No lleva nombres de personas: la fila ya apunta a quién es.
 */
export function notaDelAlias(e: EmpateDePadron, p: { item: string; fecha: string; sistema: string }): string {
  return (
    `[${p.item}] ${p.fecha}: empate por ${e.como} contra identity.users (nivel ${e.nivel}). ` +
    `Padrón de ${p.sistema}, código ${e.codigo}.` +
    (e.duplicado ? ' ⚠️ Ese padrón tiene MÁS DE UN código para esta persona (misma llave dura).' : '') +
    ' PROVISIONAL: reemplazar por una llave real si aparece.'
  );
}
