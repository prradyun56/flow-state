import { firestoreRest } from './firebase-rest.js';

// Maps legacy flat permission strings to new nested permission paths
const LEGACY_PERM_MAP = {
  'members.changeRoles': ['manage_roles'],
  'members.invite':      ['invite_users'],
  'members.approve':     ['approve_users'],
  'roles.create':        ['manage_roles'],
  'roles.edit':          ['manage_roles'],
  'roles.delete':        ['manage_roles'],
  'sessions.read':       ['view_all_sessions', 'view_team_sessions', 'view_shared_sessions', 'view_own_sessions'],
  'sessions.write':      ['share_sessions'],
  'sessions.delete':     ['delete_any_session'],
  'members.kick':         ['manage_roles'],
  'org.settings':        ['manage_roles'],
  'org.delete':          [] // owner-only, not a role permission
};

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
  },

  /**
   * Check if a user has a specific permission in an org.
   * permissionPath: dot-notated string like "members.changeRoles" or "roles.create"
   * Supports both new nested object permissions and legacy flat array permissions.
   */
  async can(userId, orgId, permissionPath) {
    const result = await chrome.storage.local.get(['members', 'roles']);
    const members = result.members || [];
    const roles = result.roles || [];
    const member = members.find(m => m.uid === userId && m.orgId === orgId && m.status === 'active');
    if (!member) return false;
    const role = roles.find(r => r._id === member.roleId);
    if (!role) return false;

    const perms = role.permissions;

    // New nested object permissions: { sessions: { read: true }, members: { invite: true }, ... }
    if (perms && typeof perms === 'object' && !Array.isArray(perms)) {
      const parts = permissionPath.split('.');
      let cur = perms;
      for (const part of parts) {
        if (cur == null || typeof cur !== 'object') return false;
        cur = cur[part];
      }
      return !!cur;
    }

    // Legacy flat array permissions
    if (Array.isArray(perms)) {
      const legacyKeys = LEGACY_PERM_MAP[permissionPath];
      if (legacyKeys) {
        return legacyKeys.some(p => perms.includes(p));
      }
      return perms.includes(permissionPath);
    }

    return false;
  }
};
