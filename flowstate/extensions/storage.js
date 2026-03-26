import { firestoreRest } from './firebase-rest.js';

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
    // Poll every 60 seconds (conservative for a Chrome Extension)
    this.syncFromCloud(); // Initial sync
    this.pollInterval = setInterval(() => this.syncFromCloud(), 60000);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  async syncFromCloud() {
    if (!this.currentUser || !this.currentUser.stsTokenManager?.accessToken) return;

    try {
      const token = this.currentUser.stsTokenManager.accessToken;
      const cloudSessions = await firestoreRest.queryDocuments('sessions', {
        field: 'user_id',
        op: 'EQUAL',
        value: this.currentUser.uid
      }, token);

      if (cloudSessions) {
        for (const session of cloudSessions) {
          await this.syncToLocal(session);
        }
        chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'synced' });
      }
    } catch (error) {
      console.error("Cloud sync error:", error);
      chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'error' });
    }
  }

  async saveSession(session) {
    // 1. Save locally first
    await this.saveToLocal(session);

    // 2. If signed in, save to cloud
    if (this.currentUser && this.currentUser.stsTokenManager?.accessToken) {
      try {
        chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'syncing' });
        const token = this.currentUser.stsTokenManager.accessToken;
        
        const sessionWithUser = {
          ...session,
          user_id: this.currentUser.uid,
          updated_at: new Date().toISOString()
        };

        // Standardize structure for REST (remove _id if it was added by parser)
        delete sessionWithUser._id;

        await firestoreRest.setDocument(`sessions/${session.session_id}`, sessionWithUser, token);
        chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'synced' });
      } catch (error) {
        console.error("Cloud save error:", error);
        chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'error' });
      }
    }
  }

  async deleteSession(sessionId) {
    // 1. Delete locally
    await this.deleteFromLocal(sessionId);

    // 2. If signed in, delete from cloud
    if (this.currentUser && this.currentUser.stsTokenManager?.accessToken) {
      try {
        const token = this.currentUser.stsTokenManager.accessToken;
        await firestoreRest.deleteDocument(`sessions/${sessionId}`, token);
      } catch (error) {
        console.error("Cloud delete error:", error);
      }
    }
  }

  // Local storage helpers (remain mostly same but optimized)
  async saveToLocal(session) {
    return new Promise((resolve) => {
      chrome.storage.local.get(["sessions"], (result) => {
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
      chrome.storage.local.get(["sessions"], (result) => {
        const sessions = (result.sessions || []).filter(s => s.session_id !== sessionId);
        chrome.storage.local.set({ sessions }, resolve);
      });
    });
  }

  async syncToLocal(cloudSession) {
    return new Promise((resolve) => {
      chrome.storage.local.get(["sessions"], (result) => {
        const sessions = result.sessions || [];
        const index = sessions.findIndex(s => s.session_id === cloudSession.session_id);
        
        if (index !== -1) {
          // Cloud wins in this demo implementation
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
