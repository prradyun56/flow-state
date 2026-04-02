import { firestoreRest } from './firebase-rest.js';
import { authRest } from './firebase-rest.js';
import { orgManager } from './org-manager.js';
import { roleManager } from './role-manager.js';

class StorageManager {
  constructor() {
    this.currentUser = null;
    this.pollInterval = null;
    this.syncInProgress = false;
    this.tokenExpiresAt = 0;
    this.popupActive = null;
  }

  setAccount(user) {
    this.currentUser = user;
    if (user) {
      this.tokenExpiresAt = user.stsTokenManager?.expirationTime || 0;
      this.startPolling();
    } else {
      this.stopPolling();
      this.tokenExpiresAt = 0;
    }
  }

  startPolling() {
    this.stopPolling();
    this.fullSync();
    this.pollInterval = setInterval(() => this.syncFromCloud(), 30000);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  setPopupActive(isActive) {
    this.popupActive = !!isActive;
  }

  async getValidToken() {
    if (!this.currentUser) return null;
    const token = this.currentUser.stsTokenManager?.accessToken;
    const refreshToken = this.currentUser.stsTokenManager?.refreshToken;
    if (token && Date.now() < this.tokenExpiresAt) return token;
    if (refreshToken) {
      try {
        const refreshed = await authRest.refreshToken(refreshToken);
        this.currentUser.stsTokenManager.accessToken = refreshed.idToken;
        this.currentUser.stsTokenManager.refreshToken = refreshed.refreshToken;
        this.tokenExpiresAt = Date.now() + 3500 * 1000;
        this.currentUser.stsTokenManager.expirationTime = this.tokenExpiresAt;
        await new Promise(resolve => chrome.storage.local.set({ user: this.currentUser }, resolve));
        return refreshed.idToken;
      } catch (e) {
        console.error('Token refresh failed:', e);
        return null;
      }
    }
    return token || null;
  }

  async fullSync() {
    if (this.syncInProgress) return;
    this.syncInProgress = true;
    try {
      const token = await this.getValidToken();
      if (!token) { this.syncInProgress = false; return; }

      chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'syncing' }).catch(() => {});

      // Run one-time migration if needed
      const { migrated } = await new Promise(r => chrome.storage.local.get(['migrated'], r));
      if (!migrated) await this.migrateFromVaultMaster(token);

      const uid = this.currentUser.uid;
      const members = await firestoreRest.queryDocuments('members',
        { field: 'uid', op: 'EQUAL', value: uid }, token);
      const orgIds = [...new Set(members.map(m => m.orgId))];
      const roles = orgIds.length > 0
        ? (await Promise.all(orgIds.map(orgId =>
            firestoreRest.queryDocuments('roles', { field: 'orgId', op: 'EQUAL', value: orgId }, token)
          ))).flat()
        : [];

      const sessions = await this._pullSessions(uid, members, roles, token);
      await this._pushLocalSessions(sessions, token);
      await new Promise(r => chrome.storage.local.set({ members, roles, sessions }, r));

      // Set default activeOrgId if not yet set
      const { activeOrgId } = await new Promise(r => chrome.storage.local.get(['activeOrgId'], r));
      if (!activeOrgId && members.length > 0) {
        await new Promise(r => chrome.storage.local.set({ activeOrgId: members[0].orgId }, r));
      }

      chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'synced' }).catch(() => {});
      this.broadcastUpdate();
    } catch (error) {
      console.error('fullSync error:', error);
      chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'error' }).catch(() => {});
    } finally {
      this.syncInProgress = false;
    }
  }

  async syncFromCloud() {
    if (this.syncInProgress) return;
    this.syncInProgress = true;
    try {
      const token = await this.getValidToken();
      if (!token) { this.syncInProgress = false; return; }
      const uid = this.currentUser.uid;
      const { members: cachedMembers, roles: cachedRoles } = await new Promise(r =>
        chrome.storage.local.get(['members', 'roles'], r));
      const sessions = await this._pullSessions(uid, cachedMembers || [], cachedRoles || [], token);
      await new Promise(r => chrome.storage.local.set({ sessions }, r));
      chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'synced' }).catch(() => {});
      this.broadcastUpdate();
    } catch (error) {
      console.error('syncFromCloud error:', error);
    } finally {
      this.syncInProgress = false;
    }
  }

  async _pullSessions(uid, members, roles, token) {
    const allSessions = [];
    const seen = new Set();

    for (const member of members) {
      if (member.status !== 'active') continue;
      const role = roles.find(r => r._id === member.roleId);
      if (!role) continue;
      const permissions = role.permissions || [];
      let fetched = [];

      if (permissions.includes('view_all_sessions')) {
        fetched = await firestoreRest.queryDocuments('sessions',
          { field: 'orgId', op: 'EQUAL', value: member.orgId }, token);
      } else if (permissions.includes('view_team_sessions')) {
        const all = await firestoreRest.queryDocuments('sessions',
          { field: 'orgId', op: 'EQUAL', value: member.orgId }, token);
        fetched = all.filter(s => s.ownerUid === uid || s.isShared);
      } else {
        const own = await firestoreRest.queryDocuments('sessions',
          { field: 'ownerUid', op: 'EQUAL', value: uid }, token);
        fetched = own.filter(s => s.orgId === member.orgId);
      }

      for (const s of fetched) {
        const id = s.session_id || s._id;
        if (!seen.has(id)) { seen.add(id); allSessions.push(s); }
      }
    }
    return allSessions;
  }

  async _pushLocalSessions(cloudSessions, token) {
    const { sessions: localSessions, activeOrgId } = await new Promise(r =>
      chrome.storage.local.get(['sessions', 'activeOrgId'], r));
    if (!localSessions || !activeOrgId || !this.currentUser) return;
    const cloudIds = new Set(cloudSessions.map(s => s.session_id || s._id));
    for (const s of localSessions) {
      if (s.user_id === this.currentUser.uid && !cloudIds.has(s.session_id)) {
        const toCloud = { ...s, orgId: s.orgId || activeOrgId, ownerUid: this.currentUser.uid };
        await firestoreRest.setDocument(`sessions/${s.session_id}`, toCloud, token).catch(() => {});
      }
    }
  }

  async saveSession(session) {
    if (this.currentUser) {
      session.ownerUid = this.currentUser.uid;
      session.user_id = this.currentUser.uid;
      session.creator_name = this.currentUser.displayName || this.currentUser.email || 'Unknown';
      if (!session.orgId) {
        const { activeOrgId } = await new Promise(r => chrome.storage.local.get(['activeOrgId'], r));
        session.orgId = activeOrgId || '';
      }
      if (session.visibility === 'read' || session.visibility === 'edit') {
        session.isShared = true;
        session.is_shared = true;
        session.access_level = session.visibility;
      } else {
        session.isShared = false;
        session.is_shared = false;
        session.access_level = 'private';
      }
    }

    await this.saveToLocal(session);

    const token = await this.getValidToken();
    if (token) {
      try {
        chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'syncing' }).catch(() => {});
        const toCloud = { ...session, updated_at: new Date().toISOString() };
        delete toCloud._id;
        await firestoreRest.setDocument(`sessions/${session.session_id}`, toCloud, token);
        await this.saveToLocal({ ...session, updated_at: toCloud.updated_at });
        chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'synced' }).catch(() => {});
        this.broadcastUpdate();
      } catch (error) {
        console.error('Cloud save error:', error);
        chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'error' }).catch(() => {});
      }
    }
  }

  async deleteSession(sessionId) {
    await this.deleteFromLocal(sessionId);
    const token = await this.getValidToken();
    if (token) {
      await firestoreRest.deleteDocument(`sessions/${sessionId}`, token).catch(e =>
        console.error('Cloud delete error:', e)
      );
      this.broadcastUpdate();
    }
  }

  async migrateFromVaultMaster(token) {
    try {
      const vault = await firestoreRest.getDocument('vault/master', token);
      if (!vault) {
        await new Promise(r => chrome.storage.local.set({ migrated: true }, r));
        return;
      }
      const uid = this.currentUser.uid;
      const org = await orgManager.createOrg('Default Workspace', uid, token);
      const roles = await roleManager.createDefaultRoles(org._id, token);
      const roleMap = { board: 'Admin', sc: 'Editor', jc: 'Viewer' };

      for (const rank of ['board', 'sc', 'jc']) {
        for (const user of (vault[rank] || [])) {
          const role = roles.find(r => r.name === roleMap[rank]);
          if (!role) continue;
          await firestoreRest.createDocument('members', {
            uid: user.uid,
            orgId: org._id,
            roleId: role._id,
            status: user.status === 'approved' ? 'active' : 'pending',
            createdAt: new Date().toISOString()
          }, token).catch(() => {});
          for (const session of (user.sessions || [])) {
            await firestoreRest.setDocument(`sessions/${session.session_id}`, {
              ...session, orgId: org._id, ownerUid: user.uid, isShared: !!session.is_shared
            }, token).catch(() => {});
          }
        }
      }
      await new Promise(r => chrome.storage.local.set({ migrated: true, activeOrgId: org._id }, r));
    } catch (e) {
      console.error('Migration error:', e);
      await new Promise(r => chrome.storage.local.set({ migrated: true }, r));
    }
  }

  broadcastUpdate() {
    chrome.runtime.sendMessage({ type: 'CLOUD_UPDATED' }).catch(() => {});
  }

  getLocalSessions() {
    return new Promise(r => chrome.storage.local.get(['sessions'], res => r(res.sessions || [])));
  }

  async saveToLocal(session) {
    return new Promise(resolve => {
      chrome.storage.local.get(['sessions'], result => {
        const sessions = result.sessions || [];
        const index = sessions.findIndex(s => s.session_id === session.session_id);
        if (index !== -1) sessions[index] = session;
        else sessions.unshift(session);
        chrome.storage.local.set({ sessions }, resolve);
      });
    });
  }

  async deleteFromLocal(sessionId) {
    return new Promise(resolve => {
      chrome.storage.local.get(['sessions'], result => {
        const sessions = (result.sessions || []).filter(s => s.session_id !== sessionId);
        chrome.storage.local.set({ sessions }, resolve);
      });
    });
  }
}

export const storageManager = new StorageManager();
