import { firestoreRest } from './firebase-rest.js';

const DEFAULT_ROLES = {
  Admin:  { perms: ['view_all_sessions', 'share_sessions', 'invite_users', 'approve_users', 'manage_roles'], level: 100, color: '#ff3366' },
  Editor: { perms: ['view_team_sessions', 'share_sessions'], level: 50, color: '#ffaa00' },
  Viewer: { perms: ['view_own_sessions'], level: 10, color: '#00e5ff' }
};

export const roleManager = {
  async createDefaultRoles(orgId, token) {
    return Promise.all(
      Object.entries(DEFAULT_ROLES).map(([name, data]) => {
        const permissions = Array.isArray(data) ? data : data.perms;
        const level = data.level ?? 0;
        const color = data.color ?? '#fff';
        return firestoreRest.createDocument('roles', {
          orgId,
          name,
          permissions,
          level,
          color,
          isSystem: true,
          createdAt: new Date().toISOString()
        }, token);
      })
    );
  },

  async createRole(orgId, name, permissions, level, color, token) {
    return firestoreRest.createDocument('roles', {
      orgId,
      name,
      permissions,
      level,
      color,
      isSystem: false,
      createdAt: new Date().toISOString()
    }, token);
  },

  async getRolesForOrg(orgId, token) {
    return firestoreRest.queryDocuments('roles', { field: 'orgId', op: 'EQUAL', value: orgId }, token);
  },

  async updateRole(roleId, permissions, token) {
    const existing = await firestoreRest.getDocument(`roles/${roleId}`, token);
    if (!existing) throw new Error('Role not found');
    return firestoreRest.setDocument(`roles/${roleId}`, { ...existing, permissions }, token);
  },

  async updateRoleStructure(roleId, updates, token) {
    const existing = await firestoreRest.getDocument(`roles/${roleId}`, token);
    if (!existing) throw new Error('Role not found');
    return firestoreRest.setDocument(`roles/${roleId}`, { ...existing, ...updates }, token);
  },

  async deleteRole(roleId, token) {
    return firestoreRest.deleteDocument(`roles/${roleId}`, token);
  }
};
