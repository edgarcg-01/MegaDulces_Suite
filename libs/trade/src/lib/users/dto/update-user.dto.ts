import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { UserWriteDto } from './user-write.dto';

/**
 * `[ID.7]` — Edición de usuario: `UserWriteDto` con todo opcional.
 *
 * `PartialType` es lo que mata la duplicación: antes este archivo repetía 9
 * campos literal del create, y las dos listas ya habían divergido (el create
 * exigía `department_code`, el update no; el update aceptaba
 * `finance_expense_area_ids`, el create no).
 *
 * El ciclo de vida vive SÓLO acá: un alta nace activa, y cambiar de estado es
 * una operación de edición. `[ID.8]` reemplazó el booleano `activo` por `status`
 * (`invited | active | suspended | terminated`); el booleano se sigue aceptando
 * como alias deprecado y la DB los mantiene de acuerdo por trigger.
 */
export const USER_STATUSES = ['invited', 'active', 'suspended', 'terminated'] as const;

export class UpdateUserDto extends PartialType(UserWriteDto) {
  /**
   * `[ID.8]` — Estado del ciclo de vida. FUENTE DE VERDAD; `activo` se deriva.
   *
   * `invited` creado y nunca entró · `active` · `suspended` baja temporal, vuelve
   * · `terminated` ya no trabaja acá (conserva historial). Un booleano no
   * distinguía las tres últimas y por eso en prod había 117 usuarios "activos"
   * incluidas 9 cuentas POS muertas.
   */
  @ApiProperty({ description: `Ciclo de vida: ${USER_STATUSES.join(' | ')}. Reemplaza a 'activo', que se deriva.`, required: false, enum: USER_STATUSES })
  @IsOptional()
  @IsIn(USER_STATUSES as unknown as string[])
  status?: (typeof USER_STATUSES)[number];

  /**
   * @deprecated usar `status`. Se sigue aceptando: el trigger de la DB deriva
   * `status` desde el booleano para los clientes que todavía mandan esto.
   */
  @ApiProperty({ description: "DEPRECADO — usar `status`. Se mapea a active/suspended.", required: false, deprecated: true })
  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  /** `[ID.8]` — Fuerza cambio de contraseña en el próximo login. */
  @ApiProperty({ description: 'Fuerza al usuario a cambiar su contraseña en el próximo login', required: false })
  @IsOptional()
  @IsBoolean()
  must_change_password?: boolean;
}
