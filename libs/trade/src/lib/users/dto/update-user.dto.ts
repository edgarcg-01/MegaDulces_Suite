import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { UserWriteDto } from './user-write.dto';

/**
 * `[ID.7]` — Edición de usuario: `UserWriteDto` con todo opcional.
 *
 * `PartialType` es lo que mata la duplicación: antes este archivo repetía 9
 * campos literal del create, y las dos listas ya habían divergido (el create
 * exigía `department_code`, el update no; el update aceptaba
 * `finance_expense_area_ids`, el create no).
 *
 * `activo` vive SÓLO acá: un alta nace activa, y "dar de baja" es una operación
 * de edición. El ciclo de vida completo (`invited | active | suspended |
 * terminated` + `must_change_password`) llega en `[ID.8]`; hasta entonces esto
 * sigue siendo el booleano de siempre.
 */
export class UpdateUserDto extends PartialType(UserWriteDto) {
  @ApiProperty({ description: 'Estado activo o inactivo', required: false })
  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}
