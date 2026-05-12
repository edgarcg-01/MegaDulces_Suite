"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequirePermissions = exports.PERMISSIONS_KEY = void 0;
var common_1 = require("@nestjs/common");
exports.PERMISSIONS_KEY = 'permissions';
var RequirePermissions = function () {
    var permissions = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        permissions[_i] = arguments[_i];
    }
    return (0, common_1.SetMetadata)(exports.PERMISSIONS_KEY, permissions);
};
exports.RequirePermissions = RequirePermissions;
