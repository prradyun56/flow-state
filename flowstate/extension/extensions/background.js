import { storageManager } from './storage.js';
import { firestoreRest } from './firebase-rest.js';
import { orgManager } from './org-manager.js';
import { roleManager } from './role-manager.js';
import { permissionManager } from './permission-manager.js';
import { inviteManager } from './invite-manager.js';

// Initialize storage manager on start
chrome.runtime.onInstalled.addListener(() => {
  console.log('FlowState Extension installed/updated');
});

// --- Recording state ---
let activeRecording = null; // { sessionId: string, windowId: number }
let recordingReady = false; // true once rehydration completes

// --- Privacy filter state ---
let privacyFilter = {
  flaggedTabs: new Set(),    // Set<tabId>
  flaggedDomains: new Set()  // Set<string hostname>
};

// --- Activity and Restores ---
let tabActivityStats = {}; // { tabId: { openedAt, totalActiveMs, lastActivatedAt, state, url } }
let pendingRestores = {}; // { url: { state } }
let extensionCreatedTabs = new Set(); // tabIds opened by the extension, eligible for pageStates restore

// Rehydrate user account on service worker wake-up
chrome.storage.local.get(['user'], (result) => {
  if (result.user) {
    storageManager.setAccount(result.user);
  }
});

// Rehydrate recording state on service worker wake-up
// This MUST complete before tab listeners can do useful work
const rehydrateRecording = new Promise((resolve) => {
  chrome.storage.session.get(['activeRecording'], (result) => {
    if (result.activeRecording) {
      activeRecording = result.activeRecording;
      // Validate the window still exists
      chrome.windows.get(activeRecording.windowId, (win) => {
        if (chrome.runtime.lastError || !win) {
          stopRecording();
        }
        recordingReady = true;
        resolve();
      });
    } else {
      recordingReady = true;
      resolve();
    }
  });
});

// Rehydrate privacy filter on service worker wake-up
const rehydratePrivacy = new Promise((resolve) => {
  chrome.storage.local.get(['privacyFilter'], (result) => {
    if (result.privacyFilter) {
      privacyFilter.flaggedTabs = new Set(result.privacyFilter.flaggedTabs || []);
      privacyFilter.flaggedDomains = new Set(result.privacyFilter.flaggedDomains || []);
    }
    resolve();
  });
});

/** Wait for recording and privacy state to be rehydrated */
async function ensureRecordingReady() {
  if (!recordingReady) await rehydrateRecording;
  await rehydratePrivacy;
  return activeRecording;
}

// --- Tab event listeners (must be registered synchronously at top level for MV3) ---

function initTabStats(tab) {
  if (!tab || !tab.id) return;
  if (!tabActivityStats[tab.id]) {
    tabActivityStats[tab.id] = { openedAt: Date.now(), totalActiveMs: 0, lastActivatedAt: tab.active ? Date.now() : 0, state: {} };
  }
}

function finalizeTabActiveTime(tabId) {
  const stats = tabActivityStats[tabId];
  if (stats && stats.lastActivatedAt > 0) {
    stats.totalActiveMs += (Date.now() - stats.lastActivatedAt);
    stats.lastActivatedAt = 0;
  }
}

// New tab created — snapshot after a short delay so the tab gets its URL
chrome.tabs.onCreated.addListener((tab) => {
  initTabStats(tab);
  ensureRecordingReady().then((rec) => {
    if (!rec || tab.windowId !== rec.windowId) return;
    snapshotAndSave();
  });
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  finalizeTabActiveTime(tabId);
  delete tabActivityStats[tabId];
  extensionCreatedTabs.delete(tabId);
  ensureRecordingReady().then((rec) => {
    if (!rec || removeInfo.windowId !== rec.windowId) return;
    if (removeInfo.isWindowClosing) {
      syncRecordingToCloud().then(() => stopRecording());
      return;
    }
    snapshotAndSave();
  });
});

// Snapshot on BOTH url changes and page-load completion
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  initTabStats(tab);
  if (tab.url) tabActivityStats[tabId].url = tab.url;
  ensureRecordingReady().then((rec) => {
    if (!rec || tab.windowId !== rec.windowId) return;
    if (changeInfo.url || changeInfo.status === 'complete') {
      snapshotAndSave();
    }
  });
});

// Tab activated (switched to) — snapshot to keep order/state fresh
chrome.tabs.onActivated.addListener((activeInfo) => {
  Object.keys(tabActivityStats).forEach(id => finalizeTabActiveTime(id));
  if (!tabActivityStats[activeInfo.tabId]) {
    tabActivityStats[activeInfo.tabId] = { openedAt: Date.now(), totalActiveMs: 0, state: {} };
  }
  tabActivityStats[activeInfo.tabId].lastActivatedAt = Date.now();

  ensureRecordingReady().then((rec) => {
    if (!rec || activeInfo.windowId !== rec.windowId) return;
    snapshotAndSave();
  });
});

// Tab moved (reordered) — snapshot to capture new order
chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
  ensureRecordingReady().then((rec) => {
    if (!rec || moveInfo.windowId !== rec.windowId) return;
    snapshotAndSave();
  });
});

// Tab attached to this window from another window
chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  ensureRecordingReady().then((rec) => {
    if (!rec || attachInfo.newWindowId !== rec.windowId) return;
    snapshotAndSave();
  });
});

// Tab detached from this window
chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
  ensureRecordingReady().then((rec) => {
    if (!rec || detachInfo.oldWindowId !== rec.windowId) return;
    snapshotAndSave();
  });
});

// Stop recording if the tracked window is closed
chrome.windows.onRemoved.addListener((windowId) => {
  ensureRecordingReady().then((rec) => {
    if (rec && rec.windowId === windowId) {
      syncRecordingToCloud().then(() => stopRecording());
    }
  });
});

// --- Privacy filter helpers ---

/**
 * Single source of truth: returns false if the tab must NOT be recorded.
 * Checks both tab-level and domain-level flags.
 */
function shouldRecord(tab) {
  if (!tab || !tab.url) return false;
  if (privacyFilter.flaggedTabs.has(tab.id)) return false;
  let hostname;
  try { hostname = new URL(tab.url).hostname; } catch { return false; }
  if (!hostname) return true;
  for (const domain of privacyFilter.flaggedDomains) {
    if (hostname === domain || hostname.endsWith('.' + domain)) return false;
  }
  return true;
}

function _persistPrivacyFilter() {
  chrome.storage.local.set({
    privacyFilter: {
      flaggedTabs: [...privacyFilter.flaggedTabs],
      flaggedDomains: [...privacyFilter.flaggedDomains]
    }
  });
}

/**
 * Immediately scrubs flagged tabs from the active session without waiting for debounce.
 * Called whenever a flag is added so removal is instant and race-condition free.
 */
async function _enforcePrivacyOnSession() {
  if (!activeRecording) return;
  try {
    const tabs = await chrome.tabs.query({ windowId: activeRecording.windowId });
    const filteredTabs = tabs
      .filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'))
      .filter(t => shouldRecord(t))
      .map(t => ({ url: t.url, title: t.title, pinned: t.pinned }));
    const result = await chrome.storage.local.get(['sessions']);
    const sessions = result.sessions || [];
    const idx = sessions.findIndex(s => s.session_id === activeRecording.sessionId);
    if (idx !== -1) {
      sessions[idx].tabs = filteredTabs;
      sessions[idx].updated_at = new Date().toISOString();
      await chrome.storage.local.set({ sessions });
      chrome.runtime.sendMessage({ type: 'RECORDING_UPDATED', sessionId: activeRecording.sessionId }).catch(() => {});
    }
  } catch (e) {
    console.error('_enforcePrivacyOnSession error:', e);
  }
}

// --- Recording helpers ---
let snapshotTimer = null;

/**
 * Debounced snapshot — coalesces rapid tab events (e.g. opening 5 tabs at once)
 * into a single snapshot after 300ms of quiet.
 */
function snapshotAndSave() {
  if (!activeRecording) return;
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => _doSnapshot(), 300);
}

async function _doSnapshot() {
  if (!activeRecording) return;

  try {
    const tabs = await chrome.tabs.query({ windowId: activeRecording.windowId });
    // Update active time before snapshot
    tabs.forEach(t => {
      const stats = tabActivityStats[t.id];
      if (stats && t.active && stats.lastActivatedAt > 0) {
        stats.totalActiveMs += (Date.now() - stats.lastActivatedAt);
        stats.lastActivatedAt = Date.now();
      }
    });

    // Fetch live scroll/video state from every tab's content script
    // so snapshots are accurate even after service worker restarts
    const stateResults = await Promise.all(tabs.map(t => new Promise(resolve => {
      try {
        chrome.tabs.sendMessage(t.id, { type: 'GET_CURRENT_STATE' }, (resp) => {
          const state = (!chrome.runtime.lastError && resp && resp.state) ? resp.state : null;
          resolve({ tabId: t.id, state });
        });
      } catch {
        resolve({ tabId: t.id, state: null });
      }
    })));
    const freshStateMap = {};
    stateResults.forEach(r => { if (r.state) freshStateMap[r.tabId] = r.state; });

    const tabData = tabs
      .filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'))
      .filter(t => shouldRecord(t))
      .map(t => {
        const stats = tabActivityStats[t.id] || {};
        // Prefer live state from content script; fall back to cached stats
        const state = freshStateMap[t.id] || stats.state || {};
        return { 
          url: t.url, 
          title: t.title, 
          pinned: t.pinned,
          openedAt: stats.openedAt || Date.now(),
          totalActiveMs: stats.totalActiveMs || 0,
          state
        };
      });

    const result = await chrome.storage.local.get(['sessions']);
    const sessions = result.sessions || [];
    const idx = sessions.findIndex(s => s.session_id === activeRecording.sessionId);
    if (idx !== -1) {
      if (JSON.stringify(sessions[idx].tabs) === JSON.stringify(tabData)) return; // No change

      sessions[idx].tabs = tabData;
      sessions[idx].updated_at = new Date().toISOString();
      await chrome.storage.local.set({ sessions });
      chrome.runtime.sendMessage({ type: 'RECORDING_UPDATED', sessionId: activeRecording.sessionId }).catch(() => {});
      syncRecordingToCloud(); // sync instantly!
    }
  } catch (e) {
    console.error('snapshotAndSave error:', e);
  }
}

function scheduleDebouncedSync() {
  // Deprecated: Sync is now instant on meaningful change
}

async function syncRecordingToCloud() {
  if (!activeRecording) return;
  try {
    const result = await chrome.storage.local.get(['sessions']);
    const session = (result.sessions || []).find(s => s.session_id === activeRecording.sessionId);
    if (session) {
      await storageManager.saveSession(session);
    }
  } catch (e) {
    console.error('syncRecordingToCloud error:', e);
  }
}

function startRecording(sessionId, windowId) {
  activeRecording = { sessionId, windowId };
  chrome.storage.session.set({ activeRecording });
}

function stopRecording() {
  activeRecording = null;
  chrome.storage.session.remove(['activeRecording']);
}

// --- Alarm listener removed (sync is instant) ---

// --- Message listener for various operations ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Rehydrate storage manager if service worker was unloaded
  const ensureAccount = (callback) => {
    if (storageManager.currentUser) {
      callback();
      return;
    }
    chrome.storage.local.get(['user'], (result) => {
      if (result.user) {
        storageManager.setAccount(result.user);
      }
      callback();
    });
  };

  switch (request.type) {
    case 'AUTH_SUCCESS':
      chrome.storage.local.set({ user: request.user }, () => {
        storageManager.setAccount(request.user);
        sendResponse({ ok: true });
      });
      return true;

    case 'SIGN_OUT':
      if (activeRecording) {
        syncRecordingToCloud().then(() => {
          stopRecording();
          storageManager.setAccount(null);
          chrome.storage.local.remove(['user', 'sessions'], () => {
            sendResponse({ ok: true });
          });
        });
      } else {
        storageManager.setAccount(null);
        chrome.storage.local.remove(['user', 'sessions'], () => {
          sendResponse({ ok: true });
        });
      }
      return true;

    case 'GET_AUTH_STATUS':
      ensureAccount(() => {
        chrome.storage.local.get(['user', 'activeOrgId', 'members', 'roles', 'organizations'], (result) => {
          const user = result.user || null;
          const orgId = result.activeOrgId || null;
          let role = null;
          let orgName = null;
          
          if (user && orgId) {
            if (result.organizations) {
              const org = result.organizations.find(o => o._id === orgId);
              if (org) orgName = org.name;
            }
            if (result.members && result.roles) {
              const member = result.members.find(m => m.uid === user.uid && m.orgId === orgId && m.status === 'active');
              if (member) role = result.roles.find(r => r._id === member.roleId) || null;
            }
          }
          sendResponse({ user, orgId, role, orgName });
        });
      });
      return true;

    case 'SAVE_SESSION':
      ensureAccount(() => {
        chrome.tabs.query({ currentWindow: true }, (tabs) => {
          // Fetch fresh scroll/video state from every tab right now so the
          // saved position reflects exactly where the user is, even if the
          // service worker was just woken up and tabActivityStats is empty.
          Promise.all(tabs.map(t => new Promise(resolve => {
            chrome.tabs.sendMessage(t.id, { type: 'GET_CURRENT_STATE' }, (resp) => {
              const state = (!chrome.runtime.lastError && resp && resp.state) ? resp.state : null;
              resolve({ tabId: t.id, state });
            });
          }))).then(results => {
            const freshStateMap = {};
            results.forEach(r => { if (r.state) freshStateMap[r.tabId] = r.state; });

            const session = {
              session_id: crypto.randomUUID(),
              name: request.name || 'Untitled Session',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              visibility: request.visibility || 'private',
              tabs: tabs
                .filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'))
                .map(t => {
                  const stats = tabActivityStats[t.id] || {};
                  // Prefer live state from content script; fall back to cached stats
                  const state = freshStateMap[t.id] || stats.state || {};
                  return {
                    url: t.url,
                    title: t.title,
                    pinned: t.pinned,
                    openedAt: stats.openedAt || Date.now(),
                    totalActiveMs: stats.totalActiveMs || 0,
                    state
                  };
                }),
              notes: request.notes || ''
            };
            storageManager.saveSession(session).then(() => {
              // Always start recording after commit
              if (request.startRecording && tabs.length > 0) {
                const windowId = tabs[0].windowId;
                // Stop any existing recording first
                if (activeRecording) stopRecording();
                startRecording(session.session_id, windowId);
                // Immediate initial snapshot so the session has current tabs right away
                _doSnapshot().catch(() => {});
              }
              sendResponse({ ok: true, sessionId: session.session_id });
            });
          });
        });
      });
      return true;

    case 'LIST_SESSIONS':
      ensureAccount(() => {
        chrome.storage.local.get(['sessions'], (result) => {
          sendResponse({ ok: true, data: result.sessions || [] });
        });
      });
      return true;

    case 'DELETE_SESSION':
      ensureAccount(() => {
        // Stop recording if we're deleting the recorded session
        if (activeRecording && activeRecording.sessionId === request.session_id) {
          stopRecording();
        }
        storageManager.deleteSession(request.session_id).then(() => {
          sendResponse({ ok: true });
        });
      });
      return true;

    case 'RESTORE_SESSION':
      chrome.storage.local.get(['sessions'], (result) => {
        const session = (result.sessions || []).find(s => s.session_id === request.session_id);
        if (session && session.tabs) {
          // Build restore map and persist it to session storage so it survives
          // a service worker restart that could happen before the new tab loads.
          const restoreMap = {};
          session.tabs.forEach(tab => {
            if (tab.state) {
              restoreMap[tab.url] = { state: tab.state };
              pendingRestores[tab.url] = { state: tab.state };
            }
          });
          chrome.storage.session.set({ pendingRestores: restoreMap }, () => {
            session.tabs.forEach(tab => {
              chrome.tabs.create({ url: tab.url, active: false });
            });
            sendResponse({ ok: true });
          });
        } else {
          sendResponse({ ok: false, error: 'Session not found' });
        }
      });
      return true;

    case 'TOGGLE_SHARE':
      ensureAccount(() => {
        chrome.storage.local.get(['sessions', 'user'], async (result) => {
          const session = (result.sessions || []).find(s => s.session_id === request.session_id);
          if (session && result.user) {
            session.is_shared = !session.is_shared;
            try {
              await storageManager.saveSession(session);
              sendResponse({ ok: true, is_shared: session.is_shared });
            } catch (e) {
              sendResponse({ ok: false, error: e.message });
            }
          } else {
            sendResponse({ ok: false, error: 'Session not found' });
          }
        });
      });
      return true;

    case 'FORCE_SYNC':
      ensureAccount(() => {
        storageManager.fullSync().then(() => {
          sendResponse({ ok: true });
        }).catch(e => {
          sendResponse({ ok: false, error: e.message });
        });
      });
      return true;

    case 'START_RECORDING':
      ensureAccount(() => {
        // Stop any existing recording
        if (activeRecording) stopRecording();
        chrome.windows.getCurrent((win) => {
          startRecording(request.sessionId, win.id);
          // Do an immediate (non-debounced) initial snapshot, then respond
          _doSnapshot().then(() => {
            sendResponse({ ok: true, windowId: win.id });
          }).catch(() => {
            sendResponse({ ok: true, windowId: win.id });
          });
        });
      });
      return true;

    case 'STOP_RECORDING':
      if (activeRecording) {
        syncRecordingToCloud().then(() => {
          stopRecording();
          sendResponse({ ok: true });
        });
      } else {
        sendResponse({ ok: true });
      }
      return true;

    case 'GET_RECORDING_STATUS':
      sendResponse({
        recording: !!activeRecording,
        sessionId: activeRecording?.sessionId || null,
        windowId: activeRecording?.windowId || null
      });
      return true;

    case 'GET_PENDING_APPROVALS':
      ensureAccount(() => {
        chrome.storage.local.get(['user', 'activeOrgId'], async (result) => {
          const uid = result.user?.uid;
          const orgId = result.activeOrgId;
          if (!uid || !orgId) { sendResponse({ ok: false, data: [] }); return; }
          const canApprove = await permissionManager.hasPermission(uid, orgId, 'approve_users');
          if (!canApprove) { sendResponse({ ok: false, data: [] }); return; }
          try {
            const token = await storageManager.getValidToken();
            if (!token) { sendResponse({ ok: false, data: [] }); return; }
            const allMembers = await firestoreRest.queryDocuments('members',
              { field: 'orgId', op: 'EQUAL', value: orgId }, token);
            const pending = allMembers.filter(m => m.status === 'pending');
            sendResponse({ ok: true, data: pending });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
        });
      });
      return true;

    case 'POPUP_OPENED':
      storageManager.setPopupActive(true);
      // Immediately sync when popup opens for freshest data
      storageManager.syncFromCloud();
      sendResponse({ ok: true });
      return true;

    case 'POPUP_CLOSED':
      storageManager.setPopupActive(false);
      sendResponse({ ok: true });
      return true;

    case 'TOGGLE_TAB_FLAG': {
      const wasFlagged = privacyFilter.flaggedTabs.has(request.tabId);
      if (wasFlagged) {
        privacyFilter.flaggedTabs.delete(request.tabId);
      } else {
        privacyFilter.flaggedTabs.add(request.tabId);
      }
      _persistPrivacyFilter();
      _enforcePrivacyOnSession();
      sendResponse({ ok: true, flagged: !wasFlagged });
      return true;
    }

    case 'ADD_DOMAIN_FLAG':
      privacyFilter.flaggedDomains.add(request.domain);
      _persistPrivacyFilter();
      _enforcePrivacyOnSession();
      sendResponse({ ok: true });
      return true;

    case 'REMOVE_DOMAIN_FLAG':
      privacyFilter.flaggedDomains.delete(request.domain);
      _persistPrivacyFilter();
      sendResponse({ ok: true });
      return true;

    case 'GET_PRIVACY_FLAGS': {
      const tabIds = [...privacyFilter.flaggedTabs];
      const domainList = [...privacyFilter.flaggedDomains];
      if (tabIds.length === 0) {
        sendResponse({ ok: true, flaggedTabs: [], flaggedDomains: domainList });
        return true;
      }
      Promise.all(tabIds.map(id => new Promise(resolve => {
        chrome.tabs.get(id, tab => {
          if (chrome.runtime.lastError || !tab) {
            resolve({ id, url: null, title: '(closed tab)', hostname: null });
          } else {
            let hostname = null;
            try { hostname = new URL(tab.url || '').hostname; } catch {}
            resolve({ id, url: tab.url, title: tab.title || tab.url, hostname });
          }
        });
      }))).then(tabInfos => {
        sendResponse({ ok: true, flaggedTabs: tabInfos, flaggedDomains: domainList });
      });
      return true;
    }

    case 'APPROVE_USER':
      ensureAccount(() => {
        chrome.storage.local.get(['user', 'activeOrgId'], async (result) => {
          const uid = result.user?.uid;
          const orgId = result.activeOrgId;
          const canApprove = await permissionManager.hasPermission(uid, orgId, 'approve_users');
          if (!canApprove) { sendResponse({ ok: false, error: 'Unauthorized' }); return; }
          try {
            const token = await storageManager.getValidToken();
            if (!token) { sendResponse({ ok: false, error: 'Token expired' }); return; }
            const member = await firestoreRest.getDocument(`members/${request.uid}`, token);
            if (!member) { sendResponse({ ok: false, error: 'Member not found' }); return; }
            await firestoreRest.setDocument(`members/${request.uid}`, { ...member, status: 'active' }, token);
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
        });
      });
      return true;
      
    case 'TAB_STATE_UPDATE':
      if (sender && sender.tab) {
        const tabId = sender.tab.id;
        if (!tabActivityStats[tabId]) {
          tabActivityStats[tabId] = { openedAt: Date.now(), totalActiveMs: 0, lastActivatedAt: sender.tab.active ? Date.now() : 0, state: {} };
        }
        tabActivityStats[tabId].state = request.state;
      }
      sendResponse({ ok: true });
      return true;
      
    case 'ENSURE_ORG':
      ensureAccount(() => {
        chrome.storage.local.get(['user'], async (result) => {
          const uid = result.user?.uid;
          if (!uid) { sendResponse({ ok: false }); return; }
          try {
            const token = await storageManager.getValidToken();
            if (!token) { sendResponse({ ok: false }); return; }
            const members = await firestoreRest.queryDocuments('members',
              { field: 'uid', op: 'EQUAL', value: uid }, token);
            if (members.some(m => m.status === 'active')) {
              // Backfill displayName/email on existing member docs if missing
              const displayName = result.user?.displayName || '';
              const email = result.user?.email || '';
              for (const m of members) {
                if (!m.displayName && (displayName || email)) {
                  await firestoreRest.setDocument(`members/${m._id}`, {
                    ...m, displayName, email
                  }, token).catch(() => {});
                }
              }
              sendResponse({ ok: true, existing: true });
              storageManager.fullSync();
              return;
            }
            const org = await orgManager.createOrg('Default Workspace', uid, token);
            const roles = await roleManager.createDefaultRoles(org._id, token);
            const adminRole = roles.find(r => r.name === 'Admin');
            await firestoreRest.createDocument('members', {
              uid, orgId: org._id, roleId: adminRole._id,
              displayName: result.user?.displayName || '',
              email: result.user?.email || '',
              status: 'active', createdAt: new Date().toISOString()
            }, token);
            await new Promise(r => chrome.storage.local.set({ activeOrgId: org._id }, r));
            await storageManager.fullSync();
            sendResponse({ ok: true, orgId: org._id });
          } catch (e) {
            console.error('ENSURE_ORG error:', e);
            sendResponse({ ok: false, error: e.message });
          }
        });
      });
      return true;

    case 'CREATE_ORG':
      ensureAccount(() => {
        chrome.storage.local.get(['user'], async (result) => {
          const uid = result.user?.uid;
          if (!uid) { sendResponse({ ok: false }); return; }
          try {
            const token = await storageManager.getValidToken();
            if (!token) { sendResponse({ ok: false }); return; }
            const org = await orgManager.createOrg(request.name || 'New Workspace', uid, token);
            // Default to public
            await firestoreRest.setDocument(`organizations/${org._id}`, { ...org, isPublic: true }, token);
            const roles = await roleManager.createDefaultRoles(org._id, token);
            const adminRole = roles.find(r => r.name === 'Admin');
            await firestoreRest.createDocument('members', {
              uid, orgId: org._id, roleId: adminRole._id,
              displayName: result.user?.displayName || '',
              email: result.user?.email || '',
              status: 'active', createdAt: new Date().toISOString()
            }, token);
            await new Promise(r => chrome.storage.local.set({ activeOrgId: org._id }, r));
            await storageManager.fullSync();
            sendResponse({ ok: true, orgId: org._id, name: org.name });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
        });
      });
      return true;

    case 'CREATE_ORG_WITH_RANKS':
      ensureAccount(() => {
        chrome.storage.local.get(['user'], async (result) => {
          const uid = result.user?.uid;
          if (!uid) { sendResponse({ ok: false }); return; }
          try {
            const token = await storageManager.getValidToken();
            if (!token) { sendResponse({ ok: false }); return; }
            const org = await orgManager.createOrg(request.name || 'New Workspace', uid, token, request.customRanks);
            // Set visibility
            await firestoreRest.setDocument(`organizations/${org._id}`, { ...org, isPublic: !!request.isPublic }, token);
            
            const roles = [];
            for (const rank of request.customRanks) {
              const permissions = rank.level === 100 
                ? ['view_all_sessions', 'delete_any_session', 'manage_roles', 'invite_users', 'approve_users'] 
                : ['view_shared_sessions'];
              const role = await roleManager.createRole(org._id, rank.name, permissions, rank.level, rank.color, token);
              roles.push(role);
            }
            
            let topRole = roles[0];
            for (const r of roles) {
              if (r.level > topRole.level) topRole = r;
            }
            
            await firestoreRest.createDocument('members', {
              uid, orgId: org._id, roleId: topRole._id,
              displayName: result.user?.displayName || '',
              email: result.user?.email || '',
              status: 'active', createdAt: new Date().toISOString()
            }, token);
            await new Promise(r => chrome.storage.local.set({ activeOrgId: org._id }, r));
            await storageManager.fullSync();
            sendResponse({ ok: true, orgId: org._id, name: org.name });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
        });
      });
      return true;

    case 'UPDATE_ORG_RANKS':
      ensureAccount(() => {
        chrome.storage.local.get(['user'], async (result) => {
          const uid = result.user?.uid;
          const orgId = request.orgId;
          if (!uid || !orgId) { sendResponse({ ok: false }); return; }
          try {
            const token = await storageManager.getValidToken();
            if (!token) { sendResponse({ ok: false }); return; }
            
            // 1. Update org visibility if provided
            if (request.hasOwnProperty('isPublic')) {
              const org = await orgManager.getOrg(orgId, token);
              await firestoreRest.setDocument(`organizations/${orgId}`, { ...org, isPublic: !!request.isPublic }, token);
            }

            // 2. Handle Ranks (Roles)
            if (request.customRanks) {
              const existingRoles = await roleManager.getRolesForOrg(orgId, token);
              const members = await firestoreRest.queryDocuments('members', { field: 'orgId', op: 'EQUAL', value: orgId }, token);

              for (const rank of request.customRanks) {
                const permissions = rank.level === 100 
                  ? ['view_all_sessions', 'delete_any_session', 'manage_roles', 'invite_users', 'approve_users'] 
                  : ['view_shared_sessions'];
                
                if (rank.originalId) {
                  // Update existing
                  await roleManager.updateRoleStructure(rank.originalId, {
                    name: rank.name,
                    color: rank.color,
                    level: rank.level,
                    permissions
                  }, token);
                } else {
                  // Create new
                  await roleManager.createRole(orgId, rank.name, permissions, rank.level, rank.color, token);
                }
              }

              // Check for deletions (not implemented for safety as per plan, but we could add a check)
              // If a rank is missing from customRanks but exists in existingRoles, we'd need to migrate members.
            }

            await storageManager.fullSync();
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
        });
      });
      return true;

    case 'SEARCH_ORGS':
      ensureAccount(() => {
        chrome.storage.local.get(['user'], async (result) => {
          try {
            const token = await storageManager.getValidToken();
            if (!token) { sendResponse({ ok: false }); return; }
            const results = await orgManager.searchOrgs(request.query, token);
            sendResponse({ ok: true, data: results });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
        });
      });
      return true;

    case 'REQUEST_JOIN_ORG':
      ensureAccount(() => {
        chrome.storage.local.get(['user'], async (result) => {
          const user = result.user;
          if (!user) { sendResponse({ ok: false }); return; }
          try {
            const token = await storageManager.getValidToken();
            if (!token) { sendResponse({ ok: false }); return; }
            await orgManager.requestJoinOrg(request.orgId, user.uid, user.displayName, user.email, token);
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
        });
      });
      return true;

    case 'LIST_ORGS':
      ensureAccount(() => {
        chrome.storage.local.get(['user', 'members', 'activeOrgId'], async (result) => {
          const uid = result.user?.uid;
          if (!uid) { sendResponse({ ok: false, data: [] }); return; }
          try {
            const token = await storageManager.getValidToken();
            if (!token) { sendResponse({ ok: false, data: [] }); return; }
            const members = result.members || [];
            const orgs = await orgManager.listUserOrgs(uid, members, token);
            sendResponse({ ok: true, data: orgs, activeOrgId: result.activeOrgId || null });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
        });
      });
      return true;

    case 'SET_ACTIVE_ORG':
      chrome.storage.local.set({ activeOrgId: request.orgId }, () => {
        storageManager.fullSync();
        sendResponse({ ok: true });
      });
      return true;

    case 'CREATE_INVITE':
      ensureAccount(() => {
        chrome.storage.local.get(['user', 'activeOrgId', 'members', 'roles'], async (result) => {
          const uid = result.user?.uid;
          const orgId = result.activeOrgId;
          if (!uid || !orgId) { sendResponse({ ok: false }); return; }
          const canInvite = await permissionManager.hasPermission(uid, orgId, 'invite_users');
          if (!canInvite) { sendResponse({ ok: false, error: 'No permission to invite users' }); return; }
          try {
            const token = await storageManager.getValidToken();
            if (!token) { sendResponse({ ok: false }); return; }
            // Default to Viewer role if not specified
            const roles = result.roles || [];
            const targetRole = roles.find(r => r.orgId === orgId && r.name === (request.roleName || 'Viewer'));
            if (!targetRole) { sendResponse({ ok: false, error: 'Role not found' }); return; }
            const invite = await inviteManager.createInvite(orgId, targetRole._id, uid, request.maxUses || 10, token);
            sendResponse({ ok: true, token: invite.token, inviteId: invite._id });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
        });
      });
      return true;

    case 'ACCEPT_INVITE':
      ensureAccount(() => {
        chrome.storage.local.get(['user'], async (result) => {
          const uid = result.user?.uid;
          if (!uid) { sendResponse({ ok: false }); return; }
          try {
            const token = await storageManager.getValidToken();
            if (!token) { sendResponse({ ok: false }); return; }
            const res = await inviteManager.validateAndAccept(request.token, uid, token, {
              displayName: result.user?.displayName || '',
              email: result.user?.email || ''
            });
            await new Promise(r => chrome.storage.local.set({ activeOrgId: res.orgId }, r));
            await storageManager.fullSync();
            sendResponse({ ok: true, orgId: res.orgId });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
        });
      });
      return true;

    case 'GET_ORG_MEMBERS':
      ensureAccount(() => {
        chrome.storage.local.get(['user', 'activeOrgId'], async (result) => {
          const uid = result.user?.uid;
          const orgId = result.activeOrgId;
          if (!uid || !orgId) { sendResponse({ ok: false, data: [] }); return; }
          try {
            const token = await storageManager.getValidToken();
            if (!token) { sendResponse({ ok: false, data: [] }); return; }
            const members = await firestoreRest.queryDocuments('members',
              { field: 'orgId', op: 'EQUAL', value: orgId }, token);
            sendResponse({ ok: true, data: members });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
        });
      });
      return true;

    case 'UPDATE_ROLE':
      ensureAccount(() => {
        chrome.storage.local.get(['user', 'activeOrgId'], async (result) => {
          const uid = result.user?.uid;
          const orgId = result.activeOrgId;
          const canManage = await permissionManager.hasPermission(uid, orgId, 'manage_roles');
          if (!canManage) { sendResponse({ ok: false, error: 'Unauthorized' }); return; }
          try {
            const token = await storageManager.getValidToken();
            if (!token) { sendResponse({ ok: false }); return; }
            await roleManager.updateRole(request.roleId, request.permissions, token);
            await storageManager.fullSync();
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
        });
      });
      return true;

    case 'GET_RESTORED_STATE':
      if (sender && sender.tab && sender.tab.url) {
        const url = sender.tab.url;
        if (pendingRestores[url]) {
          // Fast path: explicit session restore still in memory
          const state = pendingRestores[url].state;
          delete pendingRestores[url];
          chrome.storage.session.get(['pendingRestores'], (r) => {
            const stored = r.pendingRestores || {};
            delete stored[url];
            chrome.storage.session.set({ pendingRestores: stored });
          });
          sendResponse({ ok: true, state });
        } else {
          chrome.storage.session.get(['pendingRestores'], (r) => {
            const stored = r.pendingRestores || {};
            if (stored[url]) {
              // Explicit session restore after SW restart
              const state = stored[url].state;
              delete stored[url];
              chrome.storage.session.set({ pendingRestores: stored });
              sendResponse({ ok: true, state });
            } else {
              sendResponse({ ok: false });
            }
          });
        }
      } else {
        sendResponse({ ok: false });
      }
      return true;
  }
});
