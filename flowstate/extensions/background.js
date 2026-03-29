import { storageManager } from './storage.js';
import { firestoreRest } from './firebase-rest.js';

// Initialize storage manager on start
chrome.runtime.onInstalled.addListener(() => {
  console.log('FlowState Extension installed/updated');
});

// --- Recording state ---
let activeRecording = null; // { sessionId: string, windowId: number }
let recordingReady = false; // true once rehydration completes

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

/** Wait for recording state to be rehydrated, then check if we should snapshot */
async function ensureRecordingReady() {
  if (!recordingReady) await rehydrateRecording;
  return activeRecording;
}

// --- Tab event listeners (must be registered synchronously at top level for MV3) ---

// New tab created — snapshot after a short delay so the tab gets its URL
chrome.tabs.onCreated.addListener((tab) => {
  ensureRecordingReady().then((rec) => {
    if (!rec || tab.windowId !== rec.windowId) return;
    // New tabs start with no URL; the onUpdated listener will catch the real URL.
    // Still snapshot to record the tab count change.
    snapshotAndSave();
  });
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
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
  ensureRecordingReady().then((rec) => {
    if (!rec || tab.windowId !== rec.windowId) return;
    // Trigger on URL change (navigation) OR page fully loaded
    if (changeInfo.url || changeInfo.status === 'complete') {
      snapshotAndSave();
    }
  });
});

// Tab activated (switched to) — snapshot to keep order/state fresh
chrome.tabs.onActivated.addListener((activeInfo) => {
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
    const tabData = tabs
      .filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'))
      .map(t => ({ url: t.url, title: t.title, pinned: t.pinned }));

    const result = await chrome.storage.local.get(['sessions']);
    const sessions = result.sessions || [];
    const idx = sessions.findIndex(s => s.session_id === activeRecording.sessionId);
    if (idx !== -1) {
      sessions[idx].tabs = tabData;
      sessions[idx].updated_at = new Date().toISOString();
      await chrome.storage.local.set({ sessions });
      chrome.runtime.sendMessage({ type: 'RECORDING_UPDATED', sessionId: activeRecording.sessionId }).catch(() => {});
    }
    scheduleDebouncedSync();
  } catch (e) {
    console.error('snapshotAndSave error:', e);
  }
}

function scheduleDebouncedSync() {
  chrome.alarms.create('recording-sync', { delayInMinutes: 5 / 60 }); // ~5 seconds
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
  chrome.alarms.clear('recording-sync');
}

// --- Alarm listener for debounced sync ---
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'recording-sync' && activeRecording) {
    syncRecordingToCloud();
  }
});

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
        chrome.storage.local.get(['user'], (result) => {
          sendResponse({ user: result.user || null });
        });
      });
      return true;

    case 'SAVE_SESSION':
      ensureAccount(() => {
        chrome.tabs.query({ currentWindow: true }, (tabs) => {
          const session = {
            session_id: crypto.randomUUID(),
            name: request.name || 'Untitled Session',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            tabs: tabs
              .filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'))
              .map(t => ({ url: t.url, title: t.title, pinned: t.pinned })),
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
          session.tabs.forEach(tab => chrome.tabs.create({ url: tab.url, active: false }));
          sendResponse({ ok: true });
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
        chrome.storage.local.get(['user'], async (result) => {
          if (result.user && result.user.rank === 'board') {
            try {
              const token = await storageManager.getValidToken();
              if (!token) { sendResponse({ ok: false, data: [] }); return; }

              const vault = await firestoreRest.getDocument('vault/master', token);
              const pending = [];

              if (vault) {
                ['board', 'sc'].forEach(r => {
                  if (vault[r]) {
                    vault[r].forEach(u => {
                      if (u.status === 'pending') {
                        pending.push({ ...u, rank: r, _id: u.uid });
                      }
                    });
                  }
                });
              }
              sendResponse({ ok: true, data: pending });
            } catch (e) {
              sendResponse({ ok: false, error: e.message });
            }
          } else {
            sendResponse({ ok: false, data: [] });
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

    case 'APPROVE_USER':
      ensureAccount(() => {
        chrome.storage.local.get(['user'], async (result) => {
          if (result.user && result.user.rank === 'board') {
            try {
              const token = await storageManager.getValidToken();
              if (!token) { sendResponse({ ok: false, error: 'Token expired' }); return; }

              let vault = await firestoreRest.getDocument('vault/master', token);
              if (vault) {
                ['board', 'sc'].forEach(r => {
                  if (vault[r]) {
                    const idx = vault[r].findIndex(u => u.uid === request.uid);
                    if (idx !== -1) vault[r][idx].status = 'approved';
                  }
                });
                await firestoreRest.setDocument('vault/master', vault, token);
              }

              sendResponse({ ok: true });
            } catch (e) {
              sendResponse({ ok: false, error: e.message });
            }
          } else {
            sendResponse({ ok: false });
          }
        });
      });
      return true;
  }
});
