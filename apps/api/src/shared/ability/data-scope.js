"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDataScope = getDataScope;
var ability_1 = require("@casl/ability");
function getDataScope(user) {
    if (!user.rules || user.rules.length === 0) {
        return { type: 'own', userId: user.sub };
    }
    var ability = (0, ability_1.createMongoAbility)(user.rules);
    if (ability.can('read', 'reports_global')) {
        return { type: 'all', userId: user.sub };
    }
    if (ability.can('read', 'reports_team')) {
        return { type: 'team', userId: user.sub };
    }
    return { type: 'own', userId: user.sub };
}
