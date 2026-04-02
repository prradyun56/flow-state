export const permissionManager = {
  async hasPermission(uid, orgId, permission) {
    const result = await chrome.storage.local.get(['members', 'roles']);
    const members = result.members || [];
    const roles = result.roles || [];
    const member = members.find(m => m.uid === uid && m.orgId === orgId && m.status === 'active');
    if (!member) return false;
    const role = roles.find(r => r._id === member.roleId);
    if (!role || !role.permissions) return false;
    if (Array.isArray(role.permissions)) {
      return role.permissions.includes(permission);
    }
    const [cat, key] = permission.split('.');
    return !!(role.permissions[cat] && role.permissions[cat][key]);
  },

  async getMemberRole(uid, orgId) {
    const result = await chrome.storage.local.get(['members', 'roles']);
    const members = result.members || [];
    const roles = result.roles || [];
    const member = members.find(m => m.uid === uid && m.orgId === orgId);
    if (!member) return null;
    return roles.find(r => r._id === member.roleId) || null;
  },

  async getMember(uid, orgId) {
    const result = await chrome.storage.local.get(['members']);
    return (result.members || []).find(m => m.uid === uid && m.orgId === orgId) || null;
  }
};
