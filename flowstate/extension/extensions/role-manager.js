import { firestoreRest } from './firebase-rest.js';

const DEFAULT_ROLES = {
  Admin:  ['view_all_sessions', 'share_sessions', 'invite_users', 'approve_users', 'manage_roles'],
  Editor: ['view_team_sessions', 'share_sessions'],
  Viewer: ['view_own_sessions']
};

export const roleManager = {
  async createDefaultRoles(orgId, token) {
    return Promise.all(
      Object.entries(DEFAULT_ROLES).map(([name, permissions]) =>
        firestoreRest.createDocument('roles', {
          orgId,
          name,
          permissions,
          isSystem: true,
          createdAt: new Date().toISOString()
        }, token)
      )
    );
  },

  async getRolesForOrg(orgId, token) {
    return firestoreRest.queryDocuments('roles', { field: 'orgId', op: 'EQUAL', value: orgId }, token);
  },

  async updateRole(roleId, permissions, token) {
    const existing = await firestoreRest.getDocument(`roles/${roleId}`, token);
    if (!existing) throw new Error('Role not found');
    return firestoreRest.setDocument(`roles/${roleId}`, { ...existing, permissions }, token);
  }
};
