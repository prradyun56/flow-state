import { firestoreRest } from './firebase-rest.js';

export const orgManager = {
  async createOrg(name, ownerUid, token) {
    return firestoreRest.createDocument('organizations', {
      name,
      ownerUid,
      createdAt: new Date().toISOString()
    }, token);
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
  }
};
