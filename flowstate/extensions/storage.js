import { firestoreRest } from './firebase-rest.js';
import { authRest } from './firebase-rest.js';

class StorageManager {
  constructor() {
    this.currentUser = null;
    this.pollInterval = null;
  }

  setAccount(user) {
    this.currentUser = user;
    if (user) {
      this.startPolling();
    } else {
      this.stopPolling();
    }
  }

  startPolling() {
    this.stopPolling();
    this.syncFromCloud();
    this.pollInterval = setInterval(() => this.syncFromCloud(), 60000);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Get a valid access token, refreshing if expired.
   * Returns the token string or null if refresh fails.
   */
  async getValidToken() {
    if (!this.currentUser?.stsTokenManager) return null;

    const tokenMgr = this.currentUser.stsTokenManager;

    // If token is still valid (with 5 min buffer), use it
    if (tokenMgr.expiresAt && Date.now() < tokenMgr.expiresAt - 300000) {
      return tokenMgr.accessToken;
    }

    // Token expired or about to expire - refresh it
    if (!tokenMgr.refreshToken) {
      console.warn('No refresh token available, cannot refresh session');
      return tokenMgr.accessToken; // Try the old token anyway
    }

    try {
      console.log('Refreshing expired Firebase token...');
      const refreshed = await authRest.refreshToken(tokenMgr.refreshToken);

      // Update in-memory user
      this.currentUser.stsTokenManager.accessToken = refreshed.idToken;
      this.currentUser.stsTokenManager.refreshToken = refreshed.refreshToken;
      this.currentUser.stsTokenManager.expiresAt = Date.now() + (parseInt(refreshed.expiresIn) * 1000);

      // Persist updated token to chrome.storage so it survives restarts
      chrome.storage.local.set({ user: this.currentUser });

      return refreshed.idToken;
    } catch (error) {
      console.error('Token refresh failed:', error);
      return tokenMgr.accessToken; // Try the old token as fallback
    }
  }

  async syncFromCloud() {
    if (!this.currentUser?.stsTokenManager?.accessToken) return;

    try {
      const token = await this.getValidToken();
      if (!token) return;

      const cloudSessions = await firestoreRest.queryDocuments('sessions', {
        field: 'user_id',
        op: 'EQUAL',
        value: this.currentUser.uid
      }, token);

      // Sync cloud sessions to local
      const cloudIds = new Set();
      if (cloudSessions && cloudSessions.length > 0) {
        for (const session of cloudSessions) {
          cloudIds.add(session.session_id || session._id);
          await this.syncToLocal(session);
        }
      }

      // Push any local-only sessions to cloud (bidirectional sync)
      await this.pushLocalToCloud(token, cloudIds);

      chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'synced' });
    } catch (error) {
      console.error('Cloud sync error:', error.message, 'Status:', error.status);

      // If it's a permission error, log helpful info
      if (error.status === 403 || error.status === 401) {
        console.error(
          'Firebase permission denied. Check Firestore Security Rules.\n' +
          'Required rule: allow read, write: if request.auth != null && request.auth.uid == resource.data.user_id;'
        );
      }

      chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'error' });
    }
  }

  /**
   * Push local sessions that don't exist in cloud yet.
   */
  async pushLocalToCloud(token, cloudIds) {
    const localSessions = await this.getLocalSessions();
    for (const session of localSessions) {
      if (!cloudIds.has(session.session_id)) {
        try {
          const sessionWithUser = {
            ...session,
            user_id: this.currentUser.uid,
            updated_at: new Date().toISOString()
          };
          delete sessionWithUser._id;
          await firestoreRest.setDocument(`sessions/${session.session_id}`, sessionWithUser, token);
        } catch (err) {
          console.error('Failed to push local session to cloud:', session.session_id, err.message);
        }
      }
    }
  }

  async getLocalSessions() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['sessions'], (result) => {
        resolve(result.sessions || []);
      });
    });
  }

  async saveSession(session) {
    // 1. Save locally first (always works)
    await this.saveToLocal(session);

    // 2. If signed in, save to cloud
    if (this.currentUser?.stsTokenManager?.accessToken) {
      try {
        chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'syncing' });
        const token = await this.getValidToken();
        if (!token) throw new Error('No valid token');

        const sessionWithUser = {
          ...session,
          user_id: this.currentUser.uid,
          updated_at: new Date().toISOString()
        };
        delete sessionWithUser._id;

        await firestoreRest.setDocument(`sessions/${session.session_id}`, sessionWithUser, token);
        chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'synced' });
      } catch (error) {
        console.error('Cloud save error:', error.message, 'Status:', error.status);
        chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'error' });
        // Session is still saved locally, will be pushed to cloud on next sync
      }
    }
  }

  async deleteSession(sessionId) {
    // 1. Delete locally
    await this.deleteFromLocal(sessionId);

    // 2. If signed in, delete from cloud
    if (this.currentUser?.stsTokenManager?.accessToken) {
      try {
        const token = await this.getValidToken();
        if (token) {
          await firestoreRest.deleteDocument(`sessions/${sessionId}`, token);
        }
      } catch (error) {
        console.error('Cloud delete error:', error.message);
      }
    }
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

  async syncToLocal(cloudSession) {
    return new Promise((resolve) => {
      chrome.storage.local.get(['sessions'], (result) => {
        const sessions = result.sessions || [];
        const id = cloudSession.session_id || cloudSession._id;
        const index = sessions.findIndex(s => s.session_id === id);

        // Ensure session_id is set (cloud docs use _id from parseDoc)
        if (!cloudSession.session_id && cloudSession._id) {
          cloudSession.session_id = cloudSession._id;
        }

        if (index !== -1) {
          // Cloud wins on conflicts
          sessions[index] = cloudSession;
        } else {
          sessions.unshift(cloudSession);
        }

        chrome.storage.local.set({ sessions }, resolve);
      });
    });
  }
}

export const storageManager = new StorageManager();
