---
name: pulido-de-pantalla
description: Pulir el diseño de una pantalla que YA EXISTE sin cambiar su diseño - mismo estilo, mismas funciones, menos fricción. Produce una maqueta HOY vs PULIDO reconstruida desde el código, con cada cambio ligado a su archivo y a su regla, verificada con capturas antes de entregarla, y solo después pasa al código. Para la app del vendedor en campo y cualquier pantalla de view o portal. Se invoca con pulir, pulido, mejorar la pantalla, más amigable, más rápido en campo, más intuitivo, "se ve cargado", "abruma", "no se lee al sol", rediseño ligero, maqueta antes y después, propuesta de mejora de UI. No es para rediseñar desde cero ni para auditar (eso es `auditoria-diseno`).
---

# Pulido de pantalla — el mismo diseño, sin lo que estorba

> **Por qué existe.** Pedido de Desarrollo (2026-11-17) sobre la app del vendedor: tres rediseños
> desde cero se rechazaron («está horrible», «está todo mal»), y lo que sí sirvió fue **pulir
> el diseño que ya tenían**. La lección: quien usa la app todos los días ya aprendió su forma;
> cambiarla cuesta más de lo que ahorra. Se cambia **lo que estorba**, no lo que funciona.
>
> Manda [`docs/ESTANDAR_DE_INTERFACES.md`](../../../docs/ESTANDAR_DE_INTERFACES.md) y, para
> «Mercado», la skill [`diseno`](../diseno/SKILL.md) + `DESIGN.md`. Para encontrar los problemas,
> [`auditoria-diseno`](../auditoria-diseno/SKILL.md). Esta skill es lo que viene después: cómo se
> propone y se aplica el arreglo.

## 0 · Antes de proponer nada

1. **Pregunta el alcance** si no viene dicho: qué pantallas y en qué orden, y si quiere maqueta
   primero o código directo. Una pregunta, con opciones.
2. **Audita con `auditoria-diseno`** y quédate con los hallazgos que **estorban la tarea**, con
   número: tamaño de toque (px), tamaño de letra (px), cuántos avisos antes del primer dato,
   cuántos toques para la acción principal, botones que hacen lo mismo.
3. **Lee las decisiones que ya se tomaron.** Los comentarios `[VTK.n]` / `[MCP.n]` del template
   dicen qué pidió el usuario y por qué. ⛔ No se deshace un pedido explícito (el checador «24/7»
   en el encabezado, por ejemplo) sin decirlo como decisión a confirmar.

## 1 · Qué cuenta como pulido (y qué no)

| ✅ Pulido | ⛔ Ya no es pulido |
|---|---|
| Toques a 44 px, letra mínima 12–13 px | Cambiar la navegación o el flujo |
| Juntar avisos repetidos en una línea | Quitar una función que alguien usa |
| Ordenar por importancia lo que ya está | Paleta, tipografía o estilo nuevos |
| Rótulos que dicen lo que hacen («Ver pedido», no «Agendar» si solo abre) | Pantallas nuevas |
| Mover a un menú existente lo que casi no se usa (con su número de uso) | Esconder lo vital (ley de Tesler) |
| Quitar decoración que no informa (animaciones de fondo, pastillas redundantes) | |

Todo lo de la columna derecha se propone **aparte**, como decisión, nunca mezclado con el pulido.

## 2 · La maqueta HOY vs PULIDO

- **Una página HTML autocontenida** en `docs/maquetas/<código>-<pantalla>-pulido.html` (ejemplo: [`app-vendedor-pulido.html`](../../../docs/maquetas/app-vendedor-pulido.html)), con los
  tokens reales de [`libs/design-tokens/tokens.css`](../../../libs/design-tokens/tokens.css)
  (incluido el bloque `.vendor-shell` si es la app del vendedor).
- **HOY se reconstruye desde el código**, con los valores reales del CSS del componente
  (tamaños, colores, radios, textos), no de memoria ni de una captura vieja. Lo que no se pudo
  reconstruir se marca como tal.
- **PULIDO** al lado, con los mismos datos de ejemplo, para que la diferencia sea solo el
  pulido.
- Junto a cada par: la lista **«Qué cambia»**, cada cambio con su **cifra** (hoy 34 px → 44 px)
  y el **archivo y selector** donde va (`vendor-take-order.component.ts · .chipbar`).
- Los datos de ejemplo son verosímiles y del dominio (clientes, productos, folios con forma
  real). Nada de `[PLACEHOLDER]` visible ni iniciales sin sentido en lugar de imágenes.

## 3 · Verificar ANTES de entregar

⛔ **Nunca se entrega una maqueta sin haberla visto renderizada.** Se aprendió el 2026-11-17:
una maqueta entregada sin revisar llegó rota al usuario.

```bash
# captura de cada sección con Playwright (Node — nada de Python, regla 4)
node -e "
const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1280,height:900}});
const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto('file://'+process.cwd()+'/docs/maquetas/<archivo>.html');await p.waitForTimeout(800);
for(const s of await p.\$\$('section[id]')){await s.screenshot({path:'/tmp/'+await s.getAttribute('id')+'.png'});}
console.log(errs.length?errs:'sin errores');await b.close()})();"
```

Mira cada captura y busca: texto cortado, elementos encimados, una cifra repetida donde debía
cambiar, estilos que se cruzan entre secciones (dos clases con el mismo nombre), y errores de
consola. Corrige y vuelve a capturar. Las capturas se entregan junto con la maqueta.

## 4 · Del visto bueno al código

Solo con el visto bueno del usuario, y con la skill [`criterio`](../criterio/SKILL.md):

- Un cambio de la lista = un cambio en el componente, en el selector que la maqueta dijo.
- `npm run check:pantalla -- <módulo>` **antes y después**, sin fallas nuevas.
- Los tamaños táctiles van por los tokens existentes (`--tap-min`, `pointer: coarse`), no con
  números sueltos.
- Commit por pantalla, `style([CÓDIGO]): pulido de <pantalla>`, con pathspec.
- Cierre con [`cierre-por-capas`](../cierre-por-capas/SKILL.md).

## Lo que se entrega

1. El enlace o la ruta de la maqueta y sus capturas.
2. En el chat, los 5–8 cambios con más efecto, en una línea cada uno.
3. **Aparte**, los cambios que mueven cosas de lugar o quitan algo visible, como decisiones a
   confirmar.
