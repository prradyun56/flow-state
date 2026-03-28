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
      
      const vault = await firestoreRest.getDocument('vault/master', token);
      if (!vault) return;

      const rank = this.currentUser.rank || 'jc';
      const uid = this.currentUser.uid;
      
      let cloudSessions = [];
      const extractPermittedSessions = () => {
         const permitted = [];
         ['board', 'sc', 'jc'].forEach(r => {
            if (vault[r]) {
               vault[r].forEach(u => {
                  const userSessions = u.sessions || [];
                  userSessions.forEach(s => {
                     // Security/Visibility checks
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
         return permitted;
      };

      cloudSessions = extractPermittedSessions();

      // De-duplicate by session_id
      const uniqueSessionsMap = new Map();
      for (const s of cloudSessions) {
        uniqueSessionsMap.set(s.session_id, s);
      }
      const uniqueSessions = Array.from(uniqueSessionsMap.values());

      if (uniqueSessions.length > 0) {
        for (const session of uniqueSessions) {
          await this.syncToLocal(session);
        }
      } else {
        // If there are zero sessions loaded from cloud, wipe local storage to clean state
        await new Promise(resolve => {
           chrome.storage.local.get(['sessions'], (result) => {
             const anonymousSessions = (result.sessions || []).filter(s => !s.user_id);
             chrome.storage.local.set({ sessions: anonymousSessions }, resolve);
           });
        });
      }

      chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'synced' });
    } catch (error) {
      console.error("Cloud sync error:", error);
      chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'error' });
    }
  }

  async saveSession(session) {
    // Add user context immediately so local rendering is correct before cloud sync
    if (this.currentUser) {
      session.user_id = this.currentUser.uid;
      session.creator_rank = this.currentUser.rank || 'jc';
      session.creator_name = this.currentUser.displayName || this.currentUser.email || 'Unknown';
      session.is_shared = session.is_shared || false;
    }

    // 1. Save locally first
    await this.saveToLocal(session);

    // 2. If signed in, save to cloud
    if (this.currentUser && this.currentUser.stsTokenManager?.accessToken) {
      try {
        chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'syncing' });
        const token = this.currentUser.stsTokenManager.accessToken;
        
        const sessionWithUser = {
          ...session,
          updated_at: new Date().toISOString()
        };
        delete sessionWithUser._id;

        const vault = await firestoreRest.getDocument('vault/master', token);
        if (vault) {
           let userFound = false;
           ['board', 'sc', 'jc'].forEach(r => {
              if (vault[r]) {
                 const uIdx = vault[r].findIndex(u => u.uid === this.currentUser.uid);
                 if (uIdx !== -1) {
                    vault[r][uIdx].sessions = vault[r][uIdx].sessions || [];
                    const sIdx = vault[r][uIdx].sessions.findIndex(s => s.session_id === session.session_id);
                    if (sIdx !== -1) vault[r][uIdx].sessions[sIdx] = sessionWithUser;
                    else vault[r][uIdx].sessions.unshift(sessionWithUser);
                    userFound = true;
                 }
              }
           });
           
           if (userFound) {
              await firestoreRest.setDocument('vault/master', vault, token);
              chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'synced' });
           } else {
              chrome.runtime.sendMessage({ type: 'UPDATE_SYNC_STATUS', status: 'error' });
           }
        }
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
        
        const vault = await firestoreRest.getDocument('vault/master', token);
        if (vault) {
           let modified = false;
           ['board', 'sc', 'jc'].forEach(r => {
              if (vault[r]) {
                 const uIdx = vault[r].findIndex(u => u.uid === this.currentUser.uid);
                 if (uIdx !== -1 && vault[r][uIdx].sessions) {
                    vault[r][uIdx].sessions = vault[r][uIdx].sessions.filter(s => s.session_id !== sessionId);
                    modified = true;
                 }
              }
           });
           if (modified) await firestoreRest.setDocument('vault/master', vault, token);
        }
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
