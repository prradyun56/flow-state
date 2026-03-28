const fs = require('fs');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;

const dom = new JSDOM(`<!DOCTYPE html><div id="sessions-list"></div>`);
const document = dom.window.document;
const sessionsListEl = document.getElementById('sessions-list');

let currentUser = { rank: 'board', uid: 'T2snUJi6TqOLgGXeMZvkRaDqVcn2' };

function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function getTimeAgo(date) {
  return "just now";
}

const sessions = [
  {
    "session_id": "b7772ec7-14ed-4aea-970b-b9804633c2a5",
    "name": "Untitled Session",
    "created_at": "2026-03-27T13:13:26.528Z",
    "tabs": [{}, {}, {}, {}, {}, {}],
    "notes": "",
    "user_id": "T2snUJi6TqOLgGXeMZvkRaDqVcn2",
    "creator_rank": "board",
    "creator_name": "abb",
    "is_shared": false,
    "updated_at": "2026-03-27T13:13:26.530Z"
  }
];

function renderSessions(sessions) {
  sessionsListEl.innerHTML = '';
  sessions.forEach(session => {
    const card = document.createElement('div');
    card.className = 'card';

    const timeAgo = getTimeAgo(new Date(session.created_at));
    const branchHtml = session.git_branch ? `<span class="meta-item card-branch">⎇ ${escapeHtml(session.git_branch)}</span>` : '';
    const notesHtml = session.notes ? `<div class="card-notes">${escapeHtml(session.notes)}</div>` : '';

    const creatorRank = session.creator_rank || 'jc';
    const rankBadge = `<span class="rank-badge ${creatorRank}">${creatorRank}</span>`;
    const sharedBadge = session.is_shared ? `<span class="session-shared-badge">Shared</span>` : '';
    const creatorName = session.creator_name ? `<span class="creator-name">by ${escapeHtml(session.creator_name)}</span>` : '';

    let shareBtnHtml = '';
    if (currentUser && (currentUser.rank === 'board' || currentUser.rank === 'sc') && session.user_id === currentUser.uid) {
      const activeClass = session.is_shared ? 'active' : '';
      shareBtnHtml = `<button class="icon-btn share-btn ${activeClass}" data-id="${session.session_id}" title="Toggle Share">🔗</button>`;
    }

    card.innerHTML = `
      <div class="card-header">
        <div class="card-title">
          ${escapeHtml(session.name || 'Untitled Session')}
          ${rankBadge}
          ${sharedBadge}
        </div>
        ${creatorName}
      </div>
      <div class="card-meta">
        <span class="meta-item">❏ ${session.tabs.length} tab${session.tabs.length !== 1 ? 's' : ''}</span>
        ${branchHtml}
        <span class="meta-item" style="margin-left:auto">⏱ ${timeAgo}</span>
      </div>
      ${notesHtml}
      <div class="card-actions">
        ${shareBtnHtml}
        <button class="icon-btn restore-btn" data-id="${session.session_id}" title="Restore">▶</button>
        <button class="icon-btn delete-btn" data-id="${session.session_id}" title="Delete">✕</button>
      </div>
    `;
    sessionsListEl.appendChild(card);
  });
  console.log("RENDER SUCCESS. HTML LENGTH:", sessionsListEl.innerHTML.length);
}

try {
  renderSessions(sessions);
} catch (e) {
  console.error("CRASH:", e);
}
