export interface User {
  id: string;
  role: 'admin' | 'operator' | 'viewer';
  permissions: string[];
}

export interface RBACConfig {
  [role: string]: {
    permissions: string[];
  };
}

export const rbacConfig: RBACConfig = {
  admin: {
    permissions: [
      'resources:read',
      'resources:write',
      'resources:delete',
      'bulk:import'
    ]
  },
  operator: {
    permissions: [
      'resources:read',
      'resources:write',
      'bulk:import'
    ]
  },
  viewer: {
    permissions: [
      'resources:read'
    ]
  }
};

export function hasPermission(user: User, permission: string): boolean {
  const roleConfig = rbacConfig[user.role];
  return roleConfig?.permissions.includes(permission) || false;
}

export function checkPermission(user: User, permission: string): void {
  if (!hasPermission(user, permission)) {
    throw new Error(`Insufficient permissions. Required: ${permission}`);
  }
}