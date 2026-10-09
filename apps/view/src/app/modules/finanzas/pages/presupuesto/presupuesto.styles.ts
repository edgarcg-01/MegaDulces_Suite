/**
 * `[PVI.9]` — Estilos COMPARTIDOS de `/finanzas/presupuesto` (shell + hijos).
 *
 * Por qué existe: al partir la pantalla por vista, la encapsulación emulada de Angular hace que
 * **el estilo del padre no alcance al hijo**. Bancos ya pagó esa lección y la dejó escrita: sin un
 * archivo común terminaron con **105 clases duplicadas** y drift real — `.bad` llegó a significar
 * `--bad-fg` en seis archivos y `--warn-fg` en otro. Ver `bancos.styles.ts`.
 *
 * ⭐ El bloque se levantó **ENTERO y verbatim** del `styles:` del shell, no regla por regla. Elegir
 *    cuáles "son de Ventas" exigía un juicio por clase sobre 116 reglas, sin poder mirar la
 *    pantalla — y una regla omitida no rompe el build: desmaqueta una tabla en producción. Mover
 *    todo es verificable (el diff es un corte y pega) y deja el reparto fino para cuando cada vista
 *    tenga su componente y se pueda ver qué usa de verdad.
 *
 * Uso:  styles: [PRESUPUESTO_STYLES, `…lo propio de esta vista…`]
 *
 * Regla: si una clase la necesitan 2+ componentes, va acá — no se copia.
 * Tokens en libs/design-tokens/tokens.css.
 */
export const PRESUPUESTO_STYLES = `
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .pres-section { margin-top:1.4rem; }
    .pres-section-head { display:flex; justify-content:space-between; align-items:center; }
    .pres-section h2 { font-size:.95rem; margin:0 0 .5rem; }
    .pres-budget-chips { display:flex; gap:.5rem; flex-wrap:wrap; margin:.4rem 0 1rem; }
    .pres-chip { display:inline-flex; align-items:center; gap:.4rem; padding:.35rem .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font-size:.82rem; cursor:pointer; }
    .pres-chip.on { border-color:var(--action); box-shadow:0 0 0 1px var(--action); }
    .pres-chip-yr { color:var(--text-muted); }
    /* El nombre acompana al folio, no compite con el: el folio es la identidad. */
    .pres-chip-name { color:var(--text-muted); }
    .pres-summary-head { display:flex; justify-content:flex-end; align-items:center; gap:.75rem; flex-wrap:wrap; margin:.6rem 0 .4rem; }
    .pres-summary-title { font-size:.9rem; font-weight:600; display:inline-flex; align-items:center; gap:.4rem; flex-wrap:wrap; }
    .pres-detail-bar { display:flex; justify-content:space-between; align-items:center; gap:.75rem; flex-wrap:wrap; margin:.4rem 0 .2rem; }
    .pres-detail-actions { display:flex; gap:.4rem; flex-wrap:wrap; }
    .pres-mov-state { display:flex; flex-wrap:wrap; gap:.4rem 1rem; font-size:.78rem; color:var(--text-muted); padding:.5rem .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); margin-bottom:.6rem; }
    .pres-mov-state b { color:var(--text-main); margin-left:.25rem; }
    .pres-lbl-hint { font-size:.72rem; color:var(--text-faint); margin:.3rem 0 0; }
    .pres-cf-period { display:flex; gap:.4rem; flex-wrap:wrap; align-items:center; }
    .pres-eval-notes { margin:.6rem 0; font-size:.82rem; }
    .pres-eval-notes p { margin:.35rem 0; display:flex; align-items:center; gap:.4rem; flex-wrap:wrap; }
    .pres-inline-calc { display:inline-flex; align-items:center; gap:.3rem; }
    .pres-margen { width:9rem; }
    .pres-row2 { display:flex; gap:.6rem; } .pres-row2 > div { flex:1; }
    .pres-alert { display:flex; align-items:center; gap:.4rem; font-size:.8rem; color:var(--warn-fg,#b45309); background:color-mix(in srgb, var(--warn-fg,#b45309) 8%, transparent); border:1px solid color-mix(in srgb, var(--warn-fg,#b45309) 25%, transparent); border-radius:var(--r-md); padding:.4rem .6rem; margin:.5rem 0; }
    .pres-nodata { font-size:.76rem; color:var(--warn-fg,#b45309); display:inline-flex; align-items:center; gap:.3rem; }
    .pres-cap-form { display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; }
    .pres-nav { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; }
    /* [PU.VA] Era texto gris en MAYÚSCULAS pegado a las pestañas, y se leía como una octava
       pestaña deshabilitada. Ahora es un rótulo de grupo: minúscula, sin tracking de botón, con
       el divisor separado del texto y el cursor de texto apagado. */
    .pres-nav-sep { font-size:.7rem; color:var(--text-muted); letter-spacing:0; margin-left:.5rem;
      padding-left:.75rem; border-left:1px solid var(--border-color); cursor:default; user-select:none; }
    /* [PU.VA] Acción-herramienta: ícono sin rótulo, para que no compita con la acción de negocio. */
    .pres-act-ico { min-width:2rem; padding-inline:.5rem; }
    .pres-assump { border:1px solid var(--border-color); border-radius:var(--r-md); padding:.7rem .8rem; margin:.6rem 0 1rem; background:color-mix(in srgb, var(--action, #d97706) 4%, transparent); }
    .pres-assump-head { display:flex; align-items:center; justify-content:space-between; gap:.6rem; flex-wrap:wrap; margin-bottom:.5rem; }
    .pres-assump-head h3 { margin:0; font-size:.92rem; }
    .pres-assump-grid { display:flex; gap:1.4rem; flex-wrap:wrap; }
    .pres-assump-col { flex:1; min-width:14rem; }
    .pres-assump-col h4 { margin:.2rem 0 .4rem; font-size:.8rem; color:var(--text-muted); }
    /* [VE.7.1] Sin text-transform capitalize: capitalizaba CADA palabra y producia
       "Presupuestar Por Sucursal", "Control De Sobregiro" y "Respaldo (Canal Sin Historia
       Propia)". Los rotulos ya vienen escritos como deben leerse. */
    .pres-assump-row { display:flex; align-items:center; justify-content:space-between; gap:.5rem; margin:.25rem 0; font-size:.82rem; }
    /* [PU.VA] La casilla y su rótulo son UNA cosa: sin esto 'space-between' los manda a los
       extremos opuestos del renglón. */
    .pres-assump-check { display:inline-flex; align-items:center; gap:.45rem; }
    /* [PU.VA] Los valores de la columna se alineaban por su BORDE derecho, no por el dígito: el
       renglón del respaldo («29.3 % · respaldo») es más ancho y su número quedaba corrido, o sea
       que el único que avisa que no es una medición propia era el único que no se podía escanear.
       Un ancho fijo para el número y el sufijo afuera arregla las dos cosas. */
    .pres-assump-row .pres-mono { font-variant-numeric: tabular-nums; }
    .pres-assump-val { display:inline-flex; align-items:baseline; gap:.35rem; justify-content:flex-end; }
    .pres-assump-val > .pres-assump-num { min-width:4.2rem; text-align:right; }
    /* [PU.VA] El sufijo reserva su ancho SIEMPRE, incluso vacío. Sin esto no alcanzaba con darle
       ancho al número: el «· respaldo» va después y lo corre hacia la izquierda, así que el único
       renglón que avisa que no es una medición propia era el único que no se podía escanear.
       Medido en pantalla: el primer intento (ancho sólo en el número) NO lo arregló. */
    .pres-assump-val > .pres-assump-suf { min-width:5.2rem; text-align:left; }
    /* [VE.7] Separa lo que el sistema CALCULA de lo que la persona DECIDE. */
    .pres-assump-sub { margin:1rem 0 .35rem; padding-top:.6rem; border-top:1px solid var(--border-subtle,#e5e1dc); font-size:var(--fs-xs); color:var(--text-muted); }
    .pres-assump-in { width:8rem; }
    /* [PU.R] La cascada del estado de resultados. El renglon de corte va en negritas y con
       linea arriba: es lo que separa margen bruto de resultado al leerla de corrido. */
    .pres-pnl { border-collapse:collapse; margin:.4rem 0 .8rem; min-width:min(100%,38rem); }
    .pres-pnl th { text-align:left; font-size:.68rem; text-transform:uppercase; letter-spacing:.05em;
      color:var(--text-muted,#78716c); font-weight:600; padding:.3rem .7rem;
      border-bottom:1px solid var(--surface-border,#e7e5e4); }
    .pres-pnl td { padding:.32rem .7rem; font-size:.84rem; }
    .pres-pnl-rgl { white-space:nowrap; }
    .pres-pnl-fuerte td { font-weight:700; border-top:1px solid var(--surface-border,#e7e5e4); }
    .pres-date { padding:.35rem .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font-size:.85rem; }
    .pres-amt { width:10rem; } .pres-reason { flex:1; min-width:12rem; }
    .pres-current { font-size:.82rem; color:var(--text-muted); margin-top:.5rem; }
    .pres-none { color:var(--warn-fg); }
    .pres-hist-table { width:100%; border-collapse:collapse; font-size:.78rem; margin-top:.6rem; }
    .pres-hist-table th, .pres-hist-table td { padding:.3rem .5rem; border-bottom:1px solid var(--border-color); text-align:left; }
    .pres-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    .ta-r { text-align:right; }
    .pres-neg { color:var(--bad-fg,#b42318); }
    .pres-table { font-size:.84rem; margin-top:.4rem; }
    .pres-muted { color:var(--text-muted); }
    .pres-hint { font-size:.76rem; color:var(--text-muted); margin-top:.5rem; display:flex; align-items:center; gap:.35rem; }
    /* [PU.V6] El aviso de que el total cubre PARTE del ejercicio. No es un hint apagado: una
       persona esta por aprobar un presupuesto al que le falta su mejor trimestre. */
    .pres-warn { font-size:.8rem; margin:.5rem 0 0; padding:.5rem .7rem; display:flex; align-items:flex-start; gap:.45rem;
      border-radius:var(--radius-sm); border:1px solid var(--warn-border, var(--border));
      background:var(--warn-bg, var(--surface-2)); color:var(--warn-text, var(--text)); }
    .pres-warn .pi { margin-top:.1rem; flex:0 0 auto; }
    .pres-crit { color:var(--bad-fg); margin-left:.3rem; }
    .pres-row-critical { background:color-mix(in srgb, var(--bad-fg) 5%, transparent); }
    .pres-empty-block { text-align:center; padding:1.6rem; color:var(--text-muted); display:flex; flex-direction:column; align-items:center; gap:.5rem; }
    .pres-empty-ico { font-size:1.6rem; color:var(--text-faint); }
    :host ::ng-deep .pres-tag { font-size:.64rem; }
    .pres-empty { text-align:center; color:var(--text-faint); padding:1.2rem; }
    .pres-lbl { display:block; font-size:.76rem; color:var(--text-muted); margin:.4rem 0 .2rem; }
    .pres-full { width:100%; }
    .pres-check { display:flex; align-items:center; gap:.4rem; margin-top:.6rem; font-size:.82rem; }
    .pres-dlg-actions { margin-top:.8rem; }
    /* PVA — badge de origen de la meta */
    .ec-src { display:inline-block; font-size:.62rem; padding:.05rem .35rem; border-radius:.35rem; border:1px solid var(--border); color:var(--text-muted); white-space:nowrap; }
    .ec-src-historico_ajustado { color:var(--good-fg,#067647); border-color:color-mix(in srgb, var(--good-fg,#067647) 40%, transparent); }
    .ec-src-estacional { color:var(--text-muted); border-style:dashed; }
    .ec-src-proxy_canal { color:var(--warn-fg); border-style:dashed; }
    .ec-src-sin_base_declarado { color:var(--text-faint); border-style:dotted; }
    .ec-src-manual { color:var(--bad-fg,#b42318); border-color:color-mix(in srgb, var(--bad-fg,#b42318) 40%, transparent); }
    .ec-src-mixto { color:var(--text-faint); }
    .pres-propose-tbl { width:100%; border-collapse:collapse; font-size:.82rem; margin:.4rem 0 .2rem; }
    .pres-propose-tbl th, .pres-propose-tbl td { padding:.3rem .4rem; border-bottom:1px solid var(--border); text-align:left; }
    .pres-growth-in { width:5rem; text-align:right; }
    /* PVR — badges de estado de conciliación */
    .ec-src-recon-concilia { color:var(--good-fg,#067647); border-color:color-mix(in srgb, var(--good-fg,#067647) 40%, transparent); }
    .ec-src-recon-revisar { color:var(--bad-fg,#b42318); border-color:color-mix(in srgb, var(--bad-fg,#b42318) 40%, transparent); }
    .ec-src-recon-sin_facturacion, .ec-src-recon-sin_sellout { color:var(--text-faint); border-style:dashed; }
    .pres-recon-notes { margin-top:.6rem; }
`;
