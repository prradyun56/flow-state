chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "SAVE_SESSION") {
    chrome.tabs.query({ currentWindow: true }, (tabs) => {
      chrome.storage.local.get(["sessions"], (result) => {
        const sessions = result.sessions || [];
        const session = {
          session_id: crypto.randomUUID(),
          name: request.name || "Untitled Session",
          created_at: new Date().toISOString(),
          tabs: tabs.map(t => ({ url: t.url, title: t.title, pinned: t.pinned })),
          terminal_commands: [],
          working_directory: "",
          git_branch: "",
          notes: request.notes || ""
        };
        const newSessions = [session, ...sessions];
        chrome.storage.local.set({ sessions: newSessions }, () => {
          sendResponse({ ok: true, data: session });
        });
      });
    });
    return true; // async
  }
  
  if (request.type === "RESTORE_SESSION") {
    chrome.storage.local.get(["sessions"], (result) => {
      const sessions = result.sessions || [];
      const session = sessions.find(s => s.session_id === request.session_id);
      if (session) {
        session.tabs.forEach(t => {
          chrome.tabs.create({ url: t.url, pinned: t.pinned });
        });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "Session not found" });
      }
    });
    return true;
  }
  
  if (request.type === "LIST_SESSIONS") {
    chrome.storage.local.get(["sessions"], (result) => {
      sendResponse({ ok: true, data: result.sessions || [] });
    });
    return true;
  }
  
  if (request.type === "DELETE_SESSION") {
    chrome.storage.local.get(["sessions"], (result) => {
      let sessions = result.sessions || [];
      sessions = sessions.filter(s => s.session_id !== request.session_id);
      chrome.storage.local.set({ sessions }, () => {
        sendResponse({ ok: true });
      });
    });
    return true;
  }
  
  if (request.type === "IMPORT_SESSION") {
    try {
      const newSession = JSON.parse(request.jsonString);
      if (!newSession.session_id) newSession.session_id = crypto.randomUUID();
      chrome.storage.local.get(["sessions"], (result) => {
        const sessions = result.sessions || [];
        chrome.storage.local.set({ sessions: [newSession, ...sessions] }, () => {
          sendResponse({ ok: true, data: newSession });
        });
      });
    } catch(e) {
      sendResponse({ ok: false, error: e.toString() });
    }
    return true;
  }
});
