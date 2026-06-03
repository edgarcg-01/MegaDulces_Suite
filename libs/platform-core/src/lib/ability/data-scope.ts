import { createMongoAbility } from '@casl/ability';
import type { AppAbility } from './ability.types';

export function getDataScope(user: { sub: string; rules?: any[] }): {
  type: 'own' | 'team' | 'all';
  userId: string;
} {
  if (!user.rules || user.rules.length === 0) {
    return { type: 'own', userId: user.sub };
  }

  const ability = createMongoAbility<AppAbility>(user.rules as any);

  if (ability.can('read', 'reports_global')) {
    return { type: 'all', userId: user.sub };
  }
  if (ability.can('read', 'reports_team')) {
    return { type: 'team', userId: user.sub };
  }
  return { type: 'own', userId: user.sub };
}
