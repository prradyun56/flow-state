import { firestoreRest } from './firebase-rest.js';
import { authRest } from './firebase-rest.js';

class StorageManager {
  constructor() {
    this.currentUser = null;
    this.pollInterval = null;
    this.syncInProgress = false;
    this.tokenExpiresAt = 0;
  }

  setAccount(user) {
    this.currentUser = user;
    if (user) {
      // Use the token's actual expiration time so rehydrated tokens are correctly
      // detected as expired and refreshed before the first Firestore call.
      this.tokenExpiresAt = user.stsTokenManager?.expirationTime || 0;
      this.startPolling();
    } else {
      this.stopPolling();
      this.tokenExpiresAt = 0;
    }
  }

  startPolling() {
    this.stopPolling();
    this.fullSync(); // Initial sync: push local + pull cloud
    this.pollInterval = setInterval(() => this.syncFromCloud(), 30000); // 30s polling
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Ensure we have a valid token, refreshing if needed.
   * Returns the current access token or null if refresh fails.
   */
  async getValidToken() {
    if (!this.currentUser) return null;

    const token = this.currentUser.stsTokenManager?.accessToken;
    const refreshToken = this.currentUser.stsTokenManager?.refreshToken;

    // If token hasn't expired yet, use it
    if (token && Date.now() < this.tokenExpiresAt) {
      return token;
    }

    // Try to refresh
    if (refreshToken) {
      try {
        const refreshed = await authRest.refreshToken(refreshToken);
        this.currentUser.stsTokenManager.accessToken = refreshed.idToken;
        this.currentUser.stsTokenManager.refreshToken = refreshed.refreshToken;
        this.tokenExpiresAt = Date.now() + 3500 * 1000;
        this.currentUser.stsTokenManager.expirationTime = this.tokenExpiresAt;

        // Persist the refreshed token
        await new Promise(resolve => {
          chrome.storage.local.set({ user: this.currentUser }, resolve);
        });

        return refreshed.idToken;
      } catch (e) {
        console.error('Token refresh failed:', e);
        return null;
      }
    }

    // No refresh token available, try the existing token anyway
    return token || null;
  }

  /**
   * Full bidirectional sync — pushes local-only sessions to cloud,
   * then pulls all permitted sessions from cloud to local.
   */
  async fullSync() {
    if (this.syncInProgress) return;
    this.syncInProgress = true;

    try {
      const token = await this.getValidToken();
      if (!token) { this.syncInProgress = false; return; }

      chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'syncing' }).catch(() => {});

      const vault = await firestoreRest.getDocument('vault/master', token);
      if (!vault) { this.syncInProgress = false; return; }

      const uid = this.currentUser.uid;
      const rank = this.currentUser.rank || 'jc';

      // Find the user's entry in the vault
      let userEntry = null;
      let userRank = null;
      for (const r of ['board', 'sc', 'jc']) {
        if (vault[r]) {
          const found = vault[r].find(u => u.uid === uid);
          if (found) { userEntry = found; userRank = r; break; }
        }
      }

      if (!userEntry) { this.syncInProgress = false; return; }

      // Get local sessions belonging to this user
      const localSessions = await this.getLocalSessions();
      const mySessions = localSessions.filter(s => s.user_id === uid);
      const cloudSessionIds = new Set((userEntry.sessions || []).map(s => s.session_id));

      // Push local-only sessions to cloud
      let vaultModified = false;
      for (const local of mySessions) {
        if (!cloudSessionIds.has(local.session_id)) {
          const clean = { ...local };
          delete clean._id;
          userEntry.sessions = userEntry.sessions || [];
          userEntry.sessions.unshift(clean);
          vaultModified = true;
        }
      }

      if (vaultModified) {
        await firestoreRest.setDocument('vault/master', vault, token);
      }

      // Now pull cloud sessions to local (same logic as syncFromCloud)
      await this._pullFromCloud(vault, uid, rank);

      chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'synced' }).catch(() => {});
    } catch (error) {
      console.error('Full sync error:', error);
      chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'error' }).catch(() => {});
    } finally {
      this.syncInProgress = false;
    }
  }

  /** Simple hash of vault data for change detection */
  _hashVault(vault) {
    try {
      const data = JSON.stringify(vault);
      let hash = 0;
      for (let i = 0; i < data.length; i++) {
        const chr = data.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0; // Convert to 32bit integer
      }
      return hash;
    } catch { return Date.now(); }
  }

  /** Broadcast to all extension views that cloud data changed */
  broadcastUpdate() {
    chrome.runtime.sendMessage({ type: 'CLOUD_UPDATED' }).catch(() => {});
  }

  async syncFromCloud() {
    if (this.syncInProgress) return;
    this.syncInProgress = true;

    try {
      const token = await this.getValidToken();
      if (!token) { this.syncInProgress = false; return; }

      const vault = await firestoreRest.getDocument('vault/master', token);
      if (!vault) { this.syncInProgress = false; return; }

      // Change detection — skip if vault hasn't changed
      const newHash = this._hashVault(vault);
      if (newHash === this.lastVaultHash) {
        chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'synced' }).catch(() => {});
        this.syncInProgress = false;
        return;
      }
      this.lastVaultHash = newHash;

      const rank = this.currentUser.rank || 'jc';
      const uid = this.currentUser.uid;

      await this._pullFromCloud(vault, uid, rank);

      chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'synced' }).catch(() => {});
      // Notify all views that data changed
      this.broadcastUpdate();
    } catch (error) {
      console.error('Cloud sync error:', error);
      chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'error' }).catch(() => {});
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * Pull permitted sessions from vault into local storage.
   */
  async _pullFromCloud(vault, uid, rank) {
    const permitted = [];

    ['board', 'sc', 'jc'].forEach(r => {
      if (vault[r]) {
        vault[r].forEach(u => {
          const userSessions = u.sessions || [];
          userSessions.forEach(s => {
            if (s.user_id === uid) permitted.push(s);
            else if (rank === 'board') {
              if (s.creator_rank === 'sc' || s.creator_rank === 'jc') permitted.push(s);
            } else if (rank === 'sc') {
              if (s.creator_rank === 'jc' || s.is_shared) permitted.push(s);
            } else if (rank === 'jc') {
              if (s.is_shared) permitted.push(s);
            }
          });
        });
      }
    });

    // De-duplicate by session_id, keeping the latest updated_at
    const uniqueMap = new Map();
    for (const s of permitted) {
      const existing = uniqueMap.get(s.session_id);
      if (!existing || (s.updated_at && (!existing.updated_at || s.updated_at > existing.updated_at))) {
        uniqueMap.set(s.session_id, s);
      }
    }
    const cloudSessions = Array.from(uniqueMap.values());

    // Replace all user-associated local sessions with cloud truth
    await new Promise(resolve => {
      chrome.storage.local.get(['sessions'], (result) => {
        // Keep anonymous sessions (created before login)
        const anonymousSessions = (result.sessions || []).filter(s => !s.user_id);
        const merged = [...cloudSessions, ...anonymousSessions];
        chrome.storage.local.set({ sessions: merged }, resolve);
      });
    });
  }

  async saveSession(session) {
    if (this.currentUser) {
      session.user_id = this.currentUser.uid;
      session.creator_rank = this.currentUser.rank || 'jc';
      session.creator_name = this.currentUser.displayName || this.currentUser.email || 'Unknown';
      
      if (session.visibility === 'read' || session.visibility === 'edit') {
        session.is_shared = true;
        session.access_level = session.visibility;
      } else if (session.visibility === 'private') {
        session.is_shared = false;
        session.access_level = 'private';
      } else {
        session.is_shared = session.is_shared || false;
      }
    }

    // 1. Save locally first for instant UI
    await this.saveToLocal(session);

    // 2. Push to cloud
    const token = await this.getValidToken();
    if (token) {
      try {
        chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'syncing' }).catch(() => {});

        const sessionForCloud = {
          ...session,
          updated_at: new Date().toISOString()
        };
        delete sessionForCloud._id;

        const vault = await firestoreRest.getDocument('vault/master', token);
        if (vault) {
          let userFound = false;
          ['board', 'sc', 'jc'].forEach(r => {
            if (vault[r]) {
              const uIdx = vault[r].findIndex(u => u.uid === this.currentUser.uid);
              if (uIdx !== -1) {
                vault[r][uIdx].sessions = vault[r][uIdx].sessions || [];
                const sIdx = vault[r][uIdx].sessions.findIndex(s => s.session_id === session.session_id);
                if (sIdx !== -1) vault[r][uIdx].sessions[sIdx] = sessionForCloud;
                else vault[r][uIdx].sessions.unshift(sessionForCloud);
                userFound = true;
              }
            }
          });

          if (userFound) {
            await firestoreRest.setDocument('vault/master', vault, token);
            // Invalidate hash so other devices pick up the change
            this.lastVaultHash = null;
            // Update local copy with the cloud timestamp
            await this.saveToLocal(sessionForCloud);
            chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'synced' }).catch(() => {});
            this.broadcastUpdate();
          } else {
            chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'error' }).catch(() => {});
          }
        }
      } catch (error) {
        console.error('Cloud save error:', error);
        chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'error' }).catch(() => {});
        // Session is still saved locally — will be pushed on next fullSync
      }
    }
  }

  async deleteSession(sessionId) {
    // 1. Delete locally
    await this.deleteFromLocal(sessionId);

    // 2. Delete from cloud
    const token = await this.getValidToken();
    if (token) {
      try {
        const vault = await firestoreRest.getDocument('vault/master', token);
        if (vault) {
          let modified = false;
          ['board', 'sc', 'jc'].forEach(r => {
            if (vault[r]) {
              const uIdx = vault[r].findIndex(u => u.uid === this.currentUser.uid);
              if (uIdx !== -1 && vault[r][uIdx].sessions) {
                const before = vault[r][uIdx].sessions.length;
                vault[r][uIdx].sessions = vault[r][uIdx].sessions.filter(s => s.session_id !== sessionId);
                if (vault[r][uIdx].sessions.length !== before) modified = true;
              }
            }
          });
          if (modified) {
            await firestoreRest.setDocument('vault/master', vault, token);
            this.lastVaultHash = null;
            this.broadcastUpdate();
          }
        }
      } catch (error) {
        console.error('Cloud delete error:', error);
      }
    }
  }

  // Local storage helpers
  getLocalSessions() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['sessions'], (result) => {
        resolve(result.sessions || []);
      });
    });
  }

  async saveToLocal(session) {
    return new Promise((resolve) => {
      chrome.storage.local.get(['sessions'], (result) => {
        const sessions = result.sessions || [];
        const index = sessions.findIndex(s => s.session_id === session.session_id);
        if (index !== -1) {
          sessions[index] = session;
        } else {
          sessions.unshift(session);
        }
        chrome.storage.local.set({ sessions }, resolve);
      });
    });
  }

  async deleteFromLocal(sessionId) {
    return new Promise((resolve) => {
      chrome.storage.local.get(['sessions'], (result) => {
        const sessions = (result.sessions || []).filter(s => s.session_id !== sessionId);
        chrome.storage.local.set({ sessions }, resolve);
      });
    });
  }
}

export const storageManager = new StorageManager();
