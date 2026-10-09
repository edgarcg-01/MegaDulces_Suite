import 'reflect-metadata';
// ⚠️ `Permission` sale de `platform-core`, que es de donde lo toma el controlador — y los otros
// tres van por SUBPATH, no por el barrel raíz: `@megadulces/contracts` no los re-exporta a
// propósito (colgarlos del barrel suma ~225 kB al bundle del front). Importarlos del barrel
// compila y llega `undefined` en runtime, que es como fallaron las 7 primeras aserciones.
import { Permission } from '@megadulces/platform-core';
import { MODULE_GROUPS } from '@megadulces/contracts/authz/role-presets';
import { PERMISSION_META } from '@megadulces/contracts/authz/permission-meta';
import { AUTHZ_TREE } from '@megadulces/contracts/authz/authz-tree';
import { BudgetLinesController } from './budget-lines.controller';

/**
 * `[PVI.10]` — **Preparar ≠ autorizar, en el presupuesto.**
 *
 * `POST budgets/:id/approve` exigía `PRESUPUESTOS_GESTIONAR`, la misma llave que editar una
 * partida o mandar el ejercicio a firma — tanto, que la descripción de esa clave decía textual
 * *«crear **y aprobar** el ejercicio presupuestal»*. El único freno era no poder auto-aprobar la
 * propia captura, y eso separa PERSONAS, no FACULTADES: dos personas que preparan se aprueban el
 * ejercicio entre sí sin que nadie haya autorizado nada.
 *
 * ⚠️ **Lo que este candado NO puede sostener, y hay que decirlo:** medido en prod el 2026-10-09,
 * repartir la clave nueva **no separa a nadie hoy**. `PRESUPUESTOS_GESTIONAR` lo tienen
 * `direccion` (2 personas) y `superadmin` (8) — los mismos dos roles que ya tienen
 * `FINANCE_PAYMENT_CALENDAR_AUTORIZAR`, el precedente "restringido" de TP.6. Y 8 de esos 10 son
 * `superadmin`, que **saltea toda comprobación de permiso por NOMBRE DE ROL** (`RolesGuard:102`).
 * La separación empieza a valer el día que **Finanzas reciba `GESTIONAR`**, que es el hueco real:
 * hoy `finanzas` tiene sólo `VER` y nadie prepara salvo Dirección.
 *
 * ── Qué se prueba, y por qué así ────────────────────────────────────────────────────────────
 *
 * ⭐ Se lee la **metadata real** que escribe `@RequirePermissions` (`SetMetadata('permissions', …)`),
 *    no el texto del archivo. El patrón de la casa para esto es `readFileSync` + comparar cadenas,
 *    y acá no alcanza: un smoke por texto se pone verde con un comentario que mencione la clave,
 *    y rojo con un salto de línea. Lo que gobierna al guard es la metadata; es lo que hay que leer.
 *
 * ⛔ Y se prueba lo que tiene que quedar CERRADO, no sólo lo que se abre: que `approve` **no**
 *    acepte `GESTIONAR` y que la clave **no** entre al `MODULE_GROUP` `presupuestos` — ahí se
 *    otorgaría "de paquete" junto con GESTIONAR, que es exactamente lo que viene a separar.
 */

const permisosDe = (metodo: keyof BudgetLinesController): Permission[] =>
  (Reflect.getMetadata('permissions', BudgetLinesController.prototype[metodo] as object) ?? []) as Permission[];

describe('[PVI.10] aprobar el ejercicio es una facultad aparte', () => {
  it('⭐ `approve` exige PRESUPUESTOS_APROBAR', () => {
    expect(permisosDe('approve')).toEqual([Permission.PRESUPUESTOS_APROBAR]);
  });

  it('⛔ `approve` NO acepta PRESUPUESTOS_GESTIONAR: quien prepara no firma', () => {
    expect(permisosDe('approve')).not.toContain(Permission.PRESUPUESTOS_GESTIONAR);
  });

  it('`submit` SIGUE en GESTIONAR: mandar a firma es el último acto de quien prepara', () => {
    expect(permisosDe('submit')).toEqual([Permission.PRESUPUESTOS_GESTIONAR]);
  });

  it('las dos llaves son distintas — si alguien las iguala, esto se pone rojo', () => {
    expect(permisosDe('approve')).not.toEqual(permisosDe('submit'));
  });
});

describe('[PVI.10] la clave nueva está bien colocada', () => {
  it('⛔ NO entra al MODULE_GROUP `presupuestos`: ahí se otorgaría de paquete con GESTIONAR', () => {
    const grupo = MODULE_GROUPS['presupuestos'] ?? [];
    expect(grupo).toContain(Permission.PRESUPUESTOS_GESTIONAR);   // control: el grupo existe y es el correcto
    expect(grupo).not.toContain(Permission.PRESUPUESTOS_APROBAR);
  });

  it('⛔ no entra a NINGÚN grupo: repartirla es una decisión por migración, no un paquete', () => {
    const enAlgunGrupo = Object.entries(MODULE_GROUPS)
      .filter(([, perms]) => perms.includes(Permission.PRESUPUESTOS_APROBAR))
      .map(([g]) => g);
    expect(enAlgunGrupo).toEqual([]);
  });

  it('está documentada: sin meta, la pantalla de roles la muestra como una clave cruda', () => {
    const meta = PERMISSION_META[Permission.PRESUPUESTOS_APROBAR];
    expect(meta?.label).toBeTruthy();
    expect(meta?.description).toBeTruthy();
    expect(meta?.category).toBe('Finanzas');
  });

  it('abre la entrada del módulo: no se firma lo que no se puede ver', () => {
    const modulos = AUTHZ_TREE.flatMap((app) => app.projects ?? []).flatMap((p) => p.modules ?? []);
    const presupuesto = modulos.find((m) => m.id === 'presupuesto');
    expect(presupuesto).toBeDefined();
    expect(presupuesto?.manage).toContain(Permission.PRESUPUESTOS_APROBAR);
    expect(presupuesto?.view).not.toContain(Permission.PRESUPUESTOS_APROBAR);
  });
});
