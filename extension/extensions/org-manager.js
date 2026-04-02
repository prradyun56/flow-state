import { firestoreRest } from './firebase-rest.js';

export const orgManager = {
  async createOrg(name, ownerUid, token, customRanks = null) {
    const payload = {
      name,
      ownerUid,
      createdAt: new Date().toISOString()
    };
    if (customRanks) payload.customRanks = customRanks;
    return firestoreRest.createDocument('organizations', payload, token);
  },

  async getOrg(orgId, token) {
    return firestoreRest.getDocument(`organizations/${orgId}`, token);
  },

  async listUserOrgs(uid, members, token) {
    const orgIds = [...new Set(
      members.filter(m => m.uid === uid && m.status === 'active').map(m => m.orgId)
    )];
    if (orgIds.length === 0) return [];
    const orgs = await Promise.all(orgIds.map(id =>
      firestoreRest.getDocument(`organizations/${id}`, token).catch(() => null)
    ));
    return orgs.filter(Boolean);
  },

  async searchOrgs(query, token) {
    const allOrgs = await firestoreRest.listDocuments('organizations', token);
    const q = query.toLowerCase();
    return allOrgs.filter(org => 
      org.isPublic && 
      org.name && 
      org.name.toLowerCase().includes(q)
    );
  },

  async requestJoinOrg(orgId, uid, displayName, email, token) {
    // 1. Find all roles for this org
    const roles = await firestoreRest.queryDocuments('roles', { field: 'orgId', op: 'EQUAL', value: orgId }, token);
    if (!roles || roles.length === 0) throw new Error('No roles found for this organization');

    // 2. Find the lowest level role
    let lowestRole = roles[0];
    for (const r of roles) {
      if (r.level < lowestRole.level) lowestRole = r;
    }

    // 3. Create a pending membership
    return firestoreRest.createDocument('members', {
      uid,
      orgId,
      roleId: lowestRole._id,
      displayName: displayName || '',
      email: email || '',
      status: 'pending',
      createdAt: new Date().toISOString()
    }, token);
  },

  /**
   * Send a join request to an org (creates in joinRequests collection).
   * Uses org.defaultRoleId if set, otherwise falls back to lowest role.
   */
  async requestToJoin(userId, orgId, displayName, email, token) {
    // Check for duplicate pending request
    const existing = await firestoreRest.queryDocuments('joinRequests',
      { field: 'orgId', op: 'EQUAL', value: orgId }, token).catch(() => []);
    const duplicate = existing.find(r => r.userId === userId && r.status === 'pending');
    if (duplicate) throw new Error('You already have a pending request for this organization');

    return firestoreRest.createDocument('joinRequests', {
      userId,
      orgId,
      displayName: displayName || '',
      email: email || '',
      status: 'pending',
      createdAt: new Date().toISOString()
    }, token);
  },

  /**
   * Approve a join request (from joinRequests collection) and add user to members.
   * Uses org.defaultRoleId or falls back to lowest-level role.
   */
  async approveJoinRequest(orgId, requestId, token) {
    const request = await firestoreRest.getDocument(`joinRequests/${requestId}`, token);
    if (!request) throw new Error('Join request not found');
    if (request.status !== 'pending') throw new Error('Request is not pending');

    const [org, roles] = await Promise.all([
      firestoreRest.getDocument(`organizations/${orgId}`, token),
      firestoreRest.queryDocuments('roles', { field: 'orgId', op: 'EQUAL', value: orgId }, token)
    ]);

    let defaultRole = roles.find(r => r._id === org?.defaultRoleId);
    if (!defaultRole) {
      defaultRole = roles.reduce((lowest, r) => {
        const rLevel = r.level ?? r.priority ?? 0;
        const lowestLevel = lowest.level ?? lowest.priority ?? 0;
        return (rLevel < lowestLevel ? r : lowest);
      }, roles[0]);
    }

    await firestoreRest.createDocument('members', {
      uid: request.userId,
      orgId,
      roleId: defaultRole._id,
      displayName: request.displayName || '',
      email: request.email || '',
      status: 'active',
      createdAt: new Date().toISOString()
    }, token);

    await firestoreRest.setDocument(`joinRequests/${requestId}`,
      { ...request, status: 'approved' }, token);
  },

  /**
   * Remove the current user from an org's members.
   * Blocks if the user is the org owner.
   */
  async leaveOrganization(userId, orgId, token) {
    const org = await firestoreRest.getDocument(`organizations/${orgId}`, token);
    if (!org) throw new Error('Organization not found');
    if (org.ownerUid === userId) throw new Error('Owner cannot leave the organization. Transfer ownership or delete it instead.');

    const members = await firestoreRest.queryDocuments('members',
      { field: 'orgId', op: 'EQUAL', value: orgId }, token);
    const userMember = members.find(m => m.uid === userId);
    if (!userMember) throw new Error('You are not a member of this organization');

    await firestoreRest.deleteDocument(`members/${userMember._id}`, token);
  },

  /**
   * Permanently delete an org and all related documents.
   * Only the org owner can do this.
   */
  async deleteOrganization(userId, orgId, token) {
    const org = await firestoreRest.getDocument(`organizations/${orgId}`, token);
    if (!org) throw new Error('Organization not found');
    if (org.ownerUid !== userId) throw new Error('Only the owner can delete the organization');

    const [members, roles, joinRequests] = await Promise.all([
      firestoreRest.queryDocuments('members', { field: 'orgId', op: 'EQUAL', value: orgId }, token),
      firestoreRest.queryDocuments('roles', { field: 'orgId', op: 'EQUAL', value: orgId }, token),
      firestoreRest.queryDocuments('joinRequests', { field: 'orgId', op: 'EQUAL', value: orgId }, token).catch(() => [])
    ]);

    await Promise.all([
      ...members.map(m => firestoreRest.deleteDocument(`members/${m._id}`, token)),
      ...roles.map(r => firestoreRest.deleteDocument(`roles/${r._id}`, token)),
      ...joinRequests.map(j => firestoreRest.deleteDocument(`joinRequests/${j._id}`, token))
    ]);

    await firestoreRest.deleteDocument(`organizations/${orgId}`, token);
  },

  /**
   * Change a member's role. Enforces hierarchy: current user must outrank target.
   */
  async changeMemberRole(orgId, targetUserId, newRoleId, currentUserId, token) {
    const [members, roles] = await Promise.all([
      firestoreRest.queryDocuments('members', { field: 'orgId', op: 'EQUAL', value: orgId }, token),
      firestoreRest.queryDocuments('roles', { field: 'orgId', op: 'EQUAL', value: orgId }, token)
    ]);

    const currentMember = members.find(m => m.uid === currentUserId);
    const targetMember = members.find(m => m.uid === targetUserId);
    if (!currentMember || !targetMember) throw new Error('Member not found');

    const currentRole = roles.find(r => r._id === currentMember.roleId);
    const targetRole = roles.find(r => r._id === targetMember.roleId);
    const newRole = roles.find(r => r._id === newRoleId);
    if (!currentRole || !targetRole || !newRole) throw new Error('Role not found');

    const currentLevel = currentRole.level ?? currentRole.priority ?? 0;
    const targetLevel = targetRole.level ?? targetRole.priority ?? 0;

    if (currentLevel <= targetLevel) {
      throw new Error('Cannot modify a member with equal or higher role');
    }

    await firestoreRest.setDocument(`members/${targetMember._id}`,
      { ...targetMember, roleId: newRoleId }, token);
  },

  /**
   * Kick a member from the organization. Enforces hierarchy:
   * - Cannot kick yourself
   * - Cannot kick the org owner
   * - Current user must outrank the target
   */
  async kickMember(orgId, targetUserId, currentUserId, token) {
    const org = await firestoreRest.getDocument(`organizations/${orgId}`, token);
    if (!org) throw new Error('Organization not found');
    if (org.ownerUid === targetUserId) throw new Error('Cannot remove the organization owner');
    if (targetUserId === currentUserId) throw new Error('Cannot remove yourself. Use "Leave Organization" instead.');

    const [members, roles] = await Promise.all([
      firestoreRest.queryDocuments('members', { field: 'orgId', op: 'EQUAL', value: orgId }, token),
      firestoreRest.queryDocuments('roles', { field: 'orgId', op: 'EQUAL', value: orgId }, token)
    ]);

    const currentMember = members.find(m => m.uid === currentUserId);
    const targetMember = members.find(m => m.uid === targetUserId);
    if (!currentMember || !targetMember) throw new Error('Member not found');

    const currentRole = roles.find(r => r._id === currentMember.roleId);
    const targetRole = roles.find(r => r._id === targetMember.roleId);
    if (!currentRole || !targetRole) throw new Error('Role not found');

    const currentLevel = currentRole.level ?? 0;
    const targetLevel = targetRole.level ?? 0;

    if (currentLevel <= targetLevel) {
      throw new Error('Cannot remove a member with equal or higher rank');
    }

    await firestoreRest.deleteDocument(`members/${targetMember._id}`, token);
  }
};
