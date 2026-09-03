/**
 * Fase LC — estilos del Libro de Compras. Surface Operations: hairline en vez de sombra,
 * cero hex crudo, cifras en mono tabular. Master-detail permanente (sector Fiscal).
 */
export const LIBRO_COMPRAS_STYLES = `
:host { display: block; }

.lc-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem;
  margin: 0 0 1rem;
}
.lc-head h1 { font-size: var(--fs-xl); font-weight: var(--fw-bold); margin: 0 0 .15rem; }
.lc-head p { margin: 0; font-size: var(--fs-sm); max-width: 62ch; }
.muted { color: var(--text-muted); }
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.strong { font-weight: var(--fw-semibold); }

/* Master-detail: la lista de meses no desaparece al abrir uno. */
.lc-layout { display: grid; grid-template-columns: minmax(15rem, 18rem) 1fr; gap: 1rem; align-items: start; }
@media (max-width: 60rem) { .lc-layout { grid-template-columns: 1fr; } }

/* ── Meses ─────────────────────────────────────────────────────────────── */
.lc-meses { display: flex; flex-direction: column; gap: .35rem; position: sticky; top: 1rem; max-height: 78vh; overflow-y: auto; }
.lc-mes {
  display: flex; flex-direction: column; gap: .3rem; width: 100%; text-align: left;
  padding: .6rem .7rem; border: 1px solid var(--border-color); border-radius: var(--radius-md);
  background: var(--card-bg); color: inherit; cursor: pointer;
  transition: background var(--dur-short) var(--ease-out), border-color var(--dur-short) var(--ease-out);
}
.lc-mes:hover { background: rgba(var(--ink-rgb), .035); }
.lc-mes:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }
.lc-mes.sel { border-color: var(--action); background: rgba(var(--ink-rgb), .05); }
.lc-mes-top { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
/* Sólo la inicial. 'capitalize' ponía mayúscula en CADA palabra y salía "Septiembre De
   2026": el mes viene de Intl como "septiembre de 2026" y el "de" es preposición. */
.lc-mes-nombre { font-weight: var(--fw-medium); font-size: var(--fs-sm); }
.lc-mes-nombre::first-letter { text-transform: uppercase; }
.lc-mes-cifras { display: flex; justify-content: space-between; gap: .5rem; font-size: var(--fs-xs); color: var(--text-muted); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.lc-mes-alerta { font-size: var(--fs-micro); color: var(--bad-fg); }
.lc-mes-skel { height: 4.1rem; border-radius: var(--radius-md); background: var(--skeleton-bg, rgba(var(--ink-rgb), .06)); }

/* ── Detalle ───────────────────────────────────────────────────────────── */
.lc-detalle { display: flex; flex-direction: column; gap: .85rem; min-width: 0; }
.lc-skel-bloque { height: 22rem; border-radius: var(--radius-md); background: var(--skeleton-bg, rgba(var(--ink-rgb), .06)); }

/* Answer-first: el veredicto antes que el grid. */
.lc-veredicto {
  display: flex; align-items: center; gap: .75rem; flex-wrap: wrap;
  padding: .75rem .9rem; border: 1px solid var(--border-color); border-radius: var(--radius-md);
  background: var(--card-bg); border-left-width: 3px;
}
.lc-veredicto > div:first-of-type { display: flex; flex-direction: column; gap: .1rem; flex: 1 1 20rem; min-width: 0; }
.lc-veredicto strong { font-size: var(--fs-base); }
.lc-veredicto span { font-size: var(--fs-sm); }
.lc-veredicto i { font-size: 1.15rem; }
.lc-veredicto.v-ok { border-left-color: var(--ok-fg); } .lc-veredicto.v-ok i { color: var(--ok-fg); }
.lc-veredicto.v-warn { border-left-color: var(--warn-fg); } .lc-veredicto.v-warn i { color: var(--warn-fg); }
.lc-veredicto.v-bad { border-left-color: var(--bad-fg); } .lc-veredicto.v-bad i { color: var(--bad-fg); }
.lc-veredicto.v-neutral { border-left-color: var(--action); } .lc-veredicto.v-neutral i { color: var(--action); }
.lc-acciones { display: flex; gap: .4rem; flex-wrap: wrap; }

.lc-avisos { list-style: none; margin: 0; padding: .55rem .7rem; display: flex; flex-direction: column; gap: .3rem;
  border: 1px solid var(--border-color); border-left: 3px solid var(--border-color); border-radius: var(--radius-md);
  background: var(--card-bg); font-size: var(--fs-sm); }
.lc-avisos li { display: flex; align-items: center; gap: .45rem; }
.lc-avisos i { font-size: .8rem; }
/* Lo que traba el trámite. */
.lc-bloq { border-left-color: var(--bad-fg); }
.lc-bloq i { color: var(--bad-fg); }
/* Lo que solo hay que mirar: se postea igual. */
.lc-info { border-left-color: var(--warn-fg); }
.lc-info i { color: var(--warn-fg); }

.lc-opciones { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; font-size: var(--fs-sm); }
.lc-opciones > label { display: flex; align-items: center; gap: .45rem; }
.lc-chk { cursor: pointer; }
.lc-cuadre { margin-left: auto; font-family: var(--font-mono); font-variant-numeric: tabular-nums;
  font-size: var(--fs-xs); color: var(--text-muted); }
.lc-cuadre.ok { color: var(--ok-fg); }

/* ── Tabla densa ───────────────────────────────────────────────────────── */
.lc-tablewrap { border: 1px solid var(--border-color); border-radius: var(--radius-md); overflow: hidden; background: var(--card-bg); }
.lc-tablewrap :is(td, th).c-num { text-align: right; white-space: nowrap; }
.lc-tablewrap :is(td, th).c-chk { width: 2.4rem; text-align: center; }
.lc-tablewrap :is(td, th).c-cta { white-space: nowrap; }
.lc-tablewrap td.c-num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.lc-tablewrap tr.excluida td { opacity: .5; }
.lc-prov { display: block; font-size: var(--fs-sm); }
.lc-prov + small { display: block; font-size: var(--fs-micro); }

/* ── Vacíos ────────────────────────────────────────────────────────────── */
.lc-empty { display: flex; flex-direction: column; gap: .3rem; padding: 1.5rem 1rem; }
.lc-empty i { font-size: 1.4rem; color: var(--text-muted); }
.lc-empty p { margin: 0; font-size: var(--fs-sm); }
.lc-empty-lg { padding: 4rem 1.5rem; border: 1px dashed var(--border-color); border-radius: var(--radius-md); }

.lc-campo { display: flex; flex-direction: column; gap: .35rem; font-size: var(--fs-sm); }
.lc-campo input { width: 100%; }

/* El libro completo es pantalla de LECTURA: el archivo sale del sub-módulo, que es el
   único que no arrastra los CFDIs que ContPAQi ya tiene asociados. Se dice, no se esconde
   —un botón que no está y nadie explica se lee como un bug. */
.lc-solo-lectura { margin: -.25rem 0 0; padding: .55rem .7rem; border-radius: var(--radius-sm);
  background: var(--surface-subtle); border: 1px solid var(--border-subtle);
  font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.45;
  display: flex; gap: .5rem; align-items: baseline; }
.lc-solo-lectura i { color: var(--action); }
.lc-solo-lectura strong { color: var(--text-color); font-weight: var(--fw-semibold); }
`;

/**
 * Extras del sub-módulo "Movimientos no asociados". Se concatenan a los de arriba en vez de
 * duplicar el archivo: es la misma pantalla con otro alcance, no otro diseño.
 */
export const NO_ASOCIADOS_STYLES = `${LIBRO_COMPRAS_STYLES}
/* En el tablero del sub-módulo el número que manda es lo que ENTRA AL TXT, no el total sin
   asociar del mes: es el mismo número que el encabezado del detalle, para que no se lean
   dos cifras distintas del mismo mes. */
.na-falta { font-weight: var(--fw-semibold); color: var(--text-color); }
.na-falta.cero { color: var(--ok-fg); font-weight: var(--fw-medium); }
.na-mes-sinlibro { font-size: var(--fs-micro); color: var(--bad-fg); }
/* Lo que NO entra, en voz baja: es contexto, no la acción del mes. */
.na-mes-nota { font-size: var(--fs-micro); color: var(--text-muted); }

/* Renglón de contexto bajo la tira: lo que queda fuera del TXT y por qué. Deliberadamente
   en texto y no en mosaicos — "ya posteadas" puede ser 14× el total accionable y como KPI
   se robaba la lectura de la pantalla. */
.na-contexto { margin: -.35rem 0 0; font-size: var(--fs-sm); display: flex; flex-wrap: wrap; gap: .25rem; align-items: baseline; }
.na-contexto .warn { color: var(--warn-fg); }

/* Las que ya están posteadas: visibles pero apagadas, con la razón a la vista. Se muestran
   a propósito — esconderlas haría creer que el mes tiene menos pendientes de los que tiene. */
.lc-tablewrap tr.dup td { opacity: .55; }
.lc-tablewrap tr.dup td:first-child { box-shadow: inset 2px 0 0 var(--warn-fg); }

/* El folio de la póliza es editable: los meses sin libro (ago-2026) tienen que entrar como
   folio 1, no como complemento en el 2. Se ve como dato, no como botón, hasta el hover. */
.na-caratula { font: inherit; color: inherit; background: none; border: 0; padding: 0 .15rem;
  border-radius: var(--radius-xs); cursor: pointer; display: inline-flex; align-items: baseline; gap: .3rem; }
.na-caratula i { font-size: .7em; opacity: 0; transition: opacity .12s ease; }
.na-caratula:hover { background: var(--surface-hover); color: var(--text-color); }
.na-caratula:hover i { opacity: .6; }
.na-caratula:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
.na-caratula:focus-visible i { opacity: .6; }

/* El límite del anti-duplicado exacto, siempre a la vista. Va en voz baja cuando está
   cargado (es una garantía, no una alerta) y en warn cuando NO — porque sin histórico la
   puerta por UUID no cubre nada y eso se lee igual que "no hay duplicados". */
.na-cobertura { margin: -.25rem 0 0; font-size: var(--fs-micro); color: var(--text-muted);
  display: flex; gap: .45rem; align-items: baseline; line-height: 1.45; }
.na-cobertura i { color: var(--ok-fg); }
.na-cobertura strong { color: var(--text-color); font-weight: var(--fw-semibold); }
.na-cobertura code { font-family: var(--font-mono); font-size: .95em; }
.na-cobertura.vacia { color: var(--warn-fg); }
.na-cobertura.vacia i, .na-cobertura.vacia strong { color: var(--warn-fg); }

/* Prueba EXACTA por UUID: es el mismo folio fiscal, no hay nada que juzgar. Se marca más
   fuerte que la sospecha por importe y su checkbox va apagado. */
.lc-tablewrap tr.exacta td:first-child { box-shadow: inset 2px 0 0 var(--bad-fg); }

.na-dlg-nota { margin: 0 0 .9rem; font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.45; }
.na-dlg-nota strong { display: block; margin-top: .4rem; color: var(--warn-fg); font-weight: var(--fw-semibold); }
.na-dlg-aviso { margin: .9rem 0 0; font-size: var(--fs-micro); color: var(--text-muted); }
`;
