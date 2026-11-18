---
name: capa-interfaz
description: Capa C3 (Interfaz) de la suite — la pantalla Angular vista como CAPA, no como diseño. OBLIGATORIO antes de crear o cambiar una pantalla, ruta, componente o servicio Angular en apps/view, apps/vendor o apps/portal. Revisa que la capa de abajo esté verificada, que la pantalla no recalcule reglas, que tenga ruta y permiso propios, que distinga cargando/vacío/error/no medido, que funcione offline (vendedor) y que pase check:pantalla antes y después. Enruta a `diseno` para todo lo visual y a `auditoria-diseno` antes de decir que quedó bien. Se invoca con pantalla, vista, componente, ruta, Angular, frontend, formulario, tabla, botón, app del vendedor, portal, offline, Capacitor, "no se ve", "sale vacío", "agrega un campo a la pantalla".
---

# C3 · Interfaz — la pantalla como capa

> **Lo visual no está aquí.** Colores, tipografía, espaciado, tablas y estados visuales son de la
> skill [`diseno`](../diseno/SKILL.md) (obligatoria en todo C3) y, por encima de ella, de
> [`docs/ESTANDAR_DE_INTERFACES.md`](../../../docs/ESTANDAR_DE_INTERFACES.md). Esta skill cubre lo
> que hace que una pantalla sea **verdadera y alcanzable** como pieza del sistema: de dónde lee,
> quién la ve y qué pasa cuando algo falla. Para mejorar una pantalla que ya existe sin cambiar
> su diseño, el procedimiento es [`pulido-de-pantalla`](../pulido-de-pantalla/SKILL.md).

## Antes de tocar la pantalla

1. **¿La capa de abajo está verificada?** ⛔ Si el dato (C0) no está arbitrado, **no se escribe
   C3** (método §1). Construir la pantalla primero es como nacieron buena parte de los 330 items
   🧪. Si el endpoint no existe o no está probado, el trabajo empieza en [`capa-api`](../capa-api/SKILL.md).
2. **Carga [`diseno`](../diseno/SKILL.md)** antes de editar cualquier archivo de la pantalla.
3. **Corre la compuerta antes de cambiar nada**, para saber qué fallas ya traía:

   ```bash
   npm run check:pantalla -- <módulo>
   ```

## Reglas de la capa

| Regla | Por qué |
|---|---|
| **La pantalla no recalcula reglas de negocio.** Muestra lo que el servicio decidió | Una regla en dos lugares diverge (`capa-dominio`) |
| **Tipos desde `libs/contracts`**, no interfaces locales copiadas | Si cambia el contrato, la copia miente en silencio |
| **Ruta con `permissionGuard`** y botones con `perms.has(...)` | Una vista debe funcionar con **sus** permisos, incluidos los lookups de sus filtros (`GOTCHAS.md` §4) |
| **Cargando ≠ vacío ≠ error ≠ sin permiso ≠ no medido** | Un 403 o un error tragado se lee como «no hay datos» |
| **La edad del dato se declara** cuando no es en vivo («hace 14 min») | Un dato viejo presentado como actual es un dato falso (ESTÁNDAR, ley 0) |
| **Lo no medido se muestra como no medido**, nunca como `0` ni en verde | ADR-056 |
| **Dinero:** coercionar el string antes de formatear | `GOTCHAS.md` §6 |
| **Carga en menos de 500 ms** | Método §1, C3 |
| **Nada de `styleClass` en `p-select` / `p-inputnumber`** (PrimeNG v22 lo ignora) | `GOTCHAS.md` §41 |

### App del vendedor (`apps/vendor`, Capacitor + Dexie)

Es la única app que trabaja **sin señal**. Además de lo anterior:

- Todo lo que el vendedor captura tiene que **sobrevivir sin conexión** y sincronizar después.
  Revisa `offline-order.service`, `offline-sync.service` y `offline-database.service` antes de
  cambiar un flujo de captura.
- Un cambio de forma en los datos guardados en Dexie necesita **migración del lado del
  celular**: el teléfono puede traer datos de la versión anterior.
- Lo que no se pudo enviar se ve (el aviso de transacciones muertas del shell). Nada de
  descartar en silencio.
- Se toca con el pulgar, al sol y con prisa: toques de 44 px, letra legible, un solo botón
  principal por pantalla (skill `diseno`, `DESIGN.md` §PWA).

## Verificado cuando

- [ ] La capa de abajo está verificada, o la pantalla declara lo que no lo está.
- [ ] Ruta con guard y permiso propio; probada con un rol de permiso mínimo.
- [ ] Los cinco estados (cargando, vacío, error, sin permiso, no medido) se distinguen.
- [ ] `npm run check:pantalla -- <módulo>` antes y después, **sin fallas nuevas**.
- [ ] Si es la app del vendedor: el flujo funciona sin señal y sincroniza al volver.
- [ ] Auditada con [`auditoria-diseno`](../auditoria-diseno/SKILL.md) antes de decir que quedó bien.

## Lo que se reporta

```text
C3  <app>/<ruta> — permiso <CLAVE> · lee <endpoint>
    check:pantalla: antes <n> fallas → después <n> (nuevas: 0)
    estados: cargando ✓ vacío ✓ error ✓ sin permiso ✓ no medido ✓ · offline: <✓ | no aplica>
```
