import { TestBed } from '@angular/core/testing';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { PromotionFormDialogComponent } from './promotion-form-dialog.component';
import { PROMOTION_META, PROMOTION_META_LIST } from '../promotions-meta';

/**
 * **Al abrir "Nueva promoción" ya se está creando la promoción.**
 *
 * ── El defecto que cierra ────────────────────────────────────────────────────────────────────
 * El diálogo abría en una antesala: seis tarjetas grandes con el título
 * *"Nueva promoción · Elegí el tipo"* y un único botón, **Cancelar**. Ahí nadie estaba creando
 * nada — era un clic que no producía trabajo, y encima escondía el formulario detrás de una
 * pantalla decorativa. Ahora el tipo es un control más **dentro** del formulario.
 *
 * ── Y el otro defecto, el de color ──────────────────────────────────────────────────────────
 * Las tarjetas se pintaban con seis hex de la paleta default de Tailwind, **incluido el morado
 * `#8b5cf6`** que `DESIGN.md` mata por nombre (Anti-slop #1) — era el hallazgo **#4** de su
 * tabla de QA, vivo y alimentando dos pantallas. El color de grupo sale de `--chart-N` (§Q.6),
 * que además trae variante dark; un hex no.
 *
 * ── Por qué con TestBed ─────────────────────────────────────────────────────────────────────
 * `tsc` no mira dentro del template de Angular: montar el componente es lo único que fuerza su
 * compilación. Este archivo lo probó en su primera corrida — el template traía un acento grave
 * dentro del literal y reventaba, que es la sexta vez que ese error aparece en este repo.
 */

const fb = new FormBuilder();

/** Un formulario con los campos comunes, como el que arma el padre. */
const formDoble = () =>
  fb.group({
    code: [''],
    name: [''],
    description: [''],
    banner_url: [''],
    starts_at: [null],
    ends_at: [null],
    priority: [100],
    usage_limit: [null],
    active: [true],
    product_id: [null],
    percent: [null],
  });

function montar(over: Partial<PromotionFormDialogComponent> = {}) {
  TestBed.configureTestingModule({
    imports: [PromotionFormDialogComponent, ReactiveFormsModule],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(PromotionFormDialogComponent);
  const c = fixture.componentInstance;
  c.visible = true;
  c.header = 'Nueva promoción · Descuento % en producto';
  c.selectedType = 'percent_off_product';
  c.form = formDoble();
  c.metaList = PROMOTION_META_LIST;
  Object.assign(c, over);
  fixture.detectChanges();
  return { fixture, c };
}

/** El diálogo de PrimeNG monta su contenido fuera del host; se lee del documento. */
const texto = () => document.body.textContent || '';

describe('PromotionFormDialogComponent · abrir ya es crear', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('monta y compila el template (lo que tsc no hace)', () => {
    const { c } = montar();
    expect(c).toBeTruthy();
  });

  it('⭐ NEGATIVA: ya NO existe la antesala "Elegí el tipo"', () => {
    montar();
    // El texto de la antesala era literalmente éste. Si vuelve, volvió el paso muerto.
    expect(texto()).not.toContain('Elegí el tipo de promoción');
  });

  it('⭐ al abrir para crear se ve el FORMULARIO, no un selector a pantalla completa', () => {
    const { fixture } = montar();
    // El botón de guardar sólo existía en el paso 2; que esté presente al abrir es la prueba
    // de que se abre creando.
    expect(texto()).toContain('Crear promoción');
    expect(fixture.componentInstance.form).toBeTruthy();
  });

  it('el tipo queda como selector en línea, con las 6 mecánicas y la elegida marcada', () => {
    const { fixture } = montar();
    const pills = fixture.nativeElement.ownerDocument.querySelectorAll('.type-pill');
    expect(pills.length).toBe(6);
    const marcadas = Array.from(pills).filter(
      (p) => (p as HTMLElement).getAttribute('aria-checked') === 'true',
    );
    // Exactamente una: cero dejaría al usuario sin saber qué va a crear, dos serían una mentira.
    expect(marcadas.length).toBe(1);
    expect((marcadas[0] as HTMLElement).textContent).toContain(
      PROMOTION_META['percent_off_product'].shortLabel,
    );
  });

  it('cambiar de mecánica avisa al padre (que es quien conserva lo escrito)', () => {
    const { fixture, c } = montar();
    const emitidos: string[] = [];
    c.typeChange.subscribe((t) => emitidos.push(t));
    const pills = fixture.nativeElement.ownerDocument.querySelectorAll('.type-pill');
    (pills[2] as HTMLElement).click();
    expect(emitidos).toEqual([PROMOTION_META_LIST[2].type]);
  });

  it('⭐ al EDITAR no se puede cambiar el tipo: invalidaría las reglas guardadas', () => {
    // El formulario del padre trae los campos de LA mecánica que se edita; el doble tiene que
    // traerlos también o Angular revienta con "Cannot find control" — y eso sería un defecto
    // del doble, no de la pantalla.
    const conNxm = formDoble();
    conNxm.addControl('n_buy', fb.control(2));
    conNxm.addControl('m_pay', fb.control(1));
    const { fixture } = montar({
      editing: { id: 'x', promotion_type: 'nxm', name: 'Vieja' } as never,
      selectedType: 'nxm',
      form: conNxm,
    });
    const pills = fixture.nativeElement.ownerDocument.querySelectorAll('.type-pill');
    expect(pills.length).toBe(0);
  });

  it('⭐ el color de grupo sale de --chart-N, nunca de un hex (DESIGN.md #4)', () => {
    for (const m of PROMOTION_META_LIST) {
      expect(m.color).toMatch(/^var\(--chart-\d\)$/);
      // El morado de la IA y el azul, matados por nombre en el Anti-slop #1.
      expect(m.color).not.toContain('#');
    }
  });

  it('cada mecánica se distingue por algo más que el color (label propio)', () => {
    // DESIGN.md: "Color nunca es único portador de significado (+ icono/texto)".
    const labels = PROMOTION_META_LIST.map((m) => m.shortLabel);
    const iconos = PROMOTION_META_LIST.map((m) => m.icon);
    expect(new Set(labels).size).toBe(6);
    expect(new Set(iconos).size).toBe(6);
  });
});
