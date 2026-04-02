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
  }
};
