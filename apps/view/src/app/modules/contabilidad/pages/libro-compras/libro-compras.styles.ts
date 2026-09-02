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
.lc-mes-nombre { font-weight: var(--fw-medium); font-size: var(--fs-sm); text-transform: capitalize; }
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
  border: 1px solid var(--border-color); border-left: 3px solid var(--bad-fg); border-radius: var(--radius-md);
  background: var(--card-bg); font-size: var(--fs-sm); }
.lc-avisos li { display: flex; align-items: center; gap: .45rem; }
.lc-avisos i { color: var(--bad-fg); font-size: .8rem; }

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
`;
