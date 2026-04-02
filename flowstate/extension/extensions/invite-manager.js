import { firestoreRest } from './firebase-rest.js';

export const inviteManager = {
  async createInvite(orgId, roleId, createdBy, maxUses = 10, token) {
    const inviteToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    return firestoreRest.createDocument('invites', {
      orgId,
      roleId,
      createdBy,
      expiresAt,
      maxUses,
      uses: 0,
      token: inviteToken
    }, token);
  },

  async validateAndAccept(inviteToken, uid, token, userInfo = {}) {
    const results = await firestoreRest.queryDocuments(
      'invites',
      { field: 'token', op: 'EQUAL', value: inviteToken },
      token
    );
    const invite = results[0];
    if (!invite) throw new Error('Invite not found');
    if (new Date(invite.expiresAt) < new Date()) throw new Error('Invite expired');
    if (invite.uses >= invite.maxUses) throw new Error('Invite link has been fully used');

    const member = await firestoreRest.createDocument('members', {
      uid,
      orgId: invite.orgId,
      roleId: invite.roleId,
      displayName: userInfo.displayName || '',
      email: userInfo.email || '',
      status: 'active',
      createdAt: new Date().toISOString()
    }, token);

    // Increment uses
    await firestoreRest.setDocument(`invites/${invite._id}`, {
      ...invite,
      uses: invite.uses + 1
    }, token);

    return { orgId: invite.orgId, roleId: invite.roleId, member };
  }
};
