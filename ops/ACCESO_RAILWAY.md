# Control de acceso a Railway

> Registro de **quién accede a qué** en Railway. Se mantiene a mano: Railway no expone
> miembros por CLI, así que este archivo es la fuente de la política y el dashboard es donde
> se aplica. Actualizar cada vez que se agrega/quita a alguien.

Última revisión: **2026-09-22** · Revisó: `corresbarrada@gmail.com`

---

## Cuentas

| Alias | Cuenta Railway | Rol |
|---|---|---|
| **Dueño** | `corresbarrada@gmail.com` (Edgar Dayan Cortes Garcia) | Acceso a **TODO** |
| **0Sistemas** | `sistemas@megadulces.com.mx` | **Admin de `faithful-contentment`**, sin acceso a los otros |

⚠️ **"Admin" es rol de WORKSPACE: un admin de workspace ve TODOS los proyectos.** Para que
0Sistemas sea admin de `faithful` sin ver los otros dos, NO puede ser workspace admin. Dos vías:
- **A)** mismo workspace, 0Sistemas = Member, e **Invite** a `faithful` con rol de proyecto
  Admin/Editor (solo si el plan ofrece roles por proyecto en el diálogo de Invite).
- **B)** `faithful-contentment` en su PROPIO workspace, donde 0Sistemas es workspace Admin;
  los otros dos quedan en el workspace de `corresbarrada`. Es la limpia (admin real), cuesta
  una transferencia de proyecto.

Workspace: **personal** de `corresbarrada@gmail.com` ("Edgar Dayan Cortes Garcia's Projects").

---

## Matriz de acceso (estado OBJETIVO)

| Proyecto | ID | Contenido | Dueño | 0Sistemas |
|---|---|---|---|---|
| `faithful-contentment` | _(por confirmar)_ | — | ✓ | ✓ |
| `mega-dulces-compras` | _(por confirmar)_ | Compras | ✓ | ✗ |
| **`balanced-dream`** | `89caddfc-707f-41a1-82bf-17258ed16060` | **PROD**: app `MegaDulces` + `Postgres-PITR` + `observability` | ✓ | ✗ |

---

## Cómo funciona el acceso (medido en el dashboard 2026-09-22)

⚠️ **El acceso NO es por persona por proyecto — es por WORKSPACE.** En `balanced-dream`,
Members → "Who has access" muestra una sola fila: **"Everyone in the workspace"** (*"Their
workspace role"*), y la nota dice *"All workspace admins always have access."* O sea, un miembro
entra a un proyecto por dos vías:

1. **Admin del workspace** → ve TODOS los proyectos, siempre. No se puede excluir por proyecto.
2. El proyecto compartido con **"Everyone in the workspace"** → cualquier miembro entra.

Por eso no hay un "remover a 0Sistemas de balanced-dream": hay que cortar esas dos vías.

## Cómo se aplica (solo dashboard — el CLI no gestiona miembros)

1. **Workspace settings → Members** (link *"Manage in workspace settings"*): rol de
   `sistemas@megadulces.com.mx` debe ser **Member**, NUNCA Admin (un admin ve todo).
2. En **`balanced-dream`** y **`mega-dulces-compras`** → Settings → Members → quitar/restringir
   la fila **"Everyone in the workspace"**. Así los members normales dejan de verlos; solo
   quedan admins (vos) + invitados explícitos.
3. En **`faithful-contentment`** → dejar compartido con 0Sistemas (Everyone, o invitación
   explícita) para que **sí** lo vea.
4. **Settings → Tokens** de cada proyecto → revocar deploy tokens no reconocidos.

A nivel cuenta (`corresbarrada@gmail.com`):

5. **Account Settings → Tokens** → revocar API tokens que no se reconozcan.
6. **2FA activo** + contraseña propia no compartida (Railway y el Gmail).

Tras cerrar accesos, **rotar secretos** de los proyectos que 0Sistemas dejó de ver
(cadena de DB, `JWT_SECRET`, `ANTHROPIC_API_KEY`, tokens de terceros): bloquear el acceso
no invalida lo que ya conocían. Rotar `JWT_SECRET` fuerza re-login de todos.

---

## Verificación

- [ ] `balanced-dream` → Members: solo `corresbarrada@gmail.com`.
- [ ] `mega-dulces-compras` → Members: solo `corresbarrada@gmail.com`.
- [ ] `faithful-contentment` → Members: `corresbarrada@gmail.com` + `sistemas@megadulces.com.mx`.
- [ ] Tokens de proyecto y de cuenta revisados/revocados.
- [ ] Secretos rotados en los proyectos cerrados.
