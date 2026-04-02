document.addEventListener('DOMContentLoaded', () => {
  // --- State ---
  let currentUser = null;
  let currentRole = null;
  let currentOrgId = null;
  let allSessions = [];
  let searchQuery = '';
  let allMembers = [];
  let memberSearchQuery = '';

  // --- DOM refs ---
  const navItems = document.querySelectorAll('.nav-item');
  const viewSections = document.querySelectorAll('.view-section');
  const toastEl = document.getElementById('dash-toast');
  const userEmailEl = document.getElementById('sidebar-user-email');
  const userRoleEl = document.getElementById('sidebar-user-role');

  // --- Navigation ---
  navItems.forEach(btn => {
    btn.addEventListener('click', () => {
      navItems.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.section;
      viewSections.forEach(s => {
        s.classList.toggle('active', s.id === `view-${target}`);
      });
      loadSectionData(target);
    });
  });

  function loadSectionData(section) {
    switch (section) {
      case 'sessions': loadSessions(); break;
      case 'organizations': loadOrgs(); break;
      case 'members': loadMembers(); break;
      case 'roles': loadRoles(); break;
      case 'invites': loadInviteRoles(); break;
      case 'privacy': loadPrivacy(); break;
    }
  }

  // --- Auth check ---
  chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' }, (resp) => {
    if (resp && resp.user) {
      currentUser = resp.user;
      currentRole = resp.role || null;
      currentOrgId = resp.orgId || null;
      userEmailEl.textContent = currentUser.displayName || currentUser.email;

      const accountType = currentUser.accountType || 'individual';
      const isPersonalWorkspace = resp.orgName === 'Personal Workspace' || (!currentRole && accountType === 'individual');
      
      if (isPersonalWorkspace) {
        userRoleEl.textContent = 'Individual';
        userRoleEl.style.color = '#00e5ff'; // individual default color
        userRoleEl.className = 'sidebar-user-role';
        
        // Hide organizational tabs
        document.querySelector('[data-section="members"]').style.display = 'none';
        document.querySelector('[data-section="roles"]').style.display = 'none';
        document.querySelector('[data-section="invites"]').style.display = 'none';
      } else {
        userRoleEl.textContent = currentRole ? currentRole.name : 'Unknown Rank';
        userRoleEl.style.color = currentRole ? (currentRole.color || '#ffaa00') : '#888';
        userRoleEl.className = 'sidebar-user-role';
        
        // Ensure organizational tabs are visible for valid roles
        document.querySelector('[data-section="members"]').style.display = 'flex';
        document.querySelector('[data-section="roles"]').style.display = 'flex';
        document.querySelector('[data-section="invites"]').style.display = 'flex';
      }
    }
    loadSessions();
  });

  // --- Logout ---
  document.getElementById('sidebar-logout-btn').addEventListener('click', () => {
    if (!confirm('Logout of FlowState?')) return;
    chrome.storage.local.remove(['user', 'token', 'refreshToken', 'tokenExpiry', 'activeOrgId', 'sessions', 'members', 'roles'], () => {
      window.close();
    });
  });

  // --- Live updates ---
  chrome.runtime.onMessage.addListener((req) => {
    if (req.type === 'CLOUD_UPDATED') {
      const activeSection = document.querySelector('.nav-item.active');
      if (activeSection) loadSectionData(activeSection.dataset.section);
    }
  });

  // ===================== SESSIONS =====================
  const sessionsListEl = document.getElementById('dash-sessions-list');
  const sessionSearchEl = document.getElementById('dash-session-search');

  sessionSearchEl.addEventListener('input', () => {
    searchQuery = sessionSearchEl.value.trim().toLowerCase();
    renderSessions(allSessions);
  });

  function loadSessions() {
    chrome.runtime.sendMessage({ type: 'LIST_SESSIONS' }, (resp) => {
      if (resp && resp.ok) {
        allSessions = resp.data || [];
        renderSessions(allSessions);
      }
    });
  }

  function renderSessions(sessions) {
    sessionsListEl.innerHTML = '';
    let filtered = sessions;
    if (searchQuery) {
      filtered = sessions.filter(s =>
        (s.name || '').toLowerCase().includes(searchQuery) ||
        (s.creator_name || '').toLowerCase().includes(searchQuery)
      );
    }
    if (filtered.length === 0) {
      sessionsListEl.innerHTML = '<div class="empty-state">No sessions found</div>';
      return;
    }

    // Group sessions by creator role
    chrome.storage.local.get(['members', 'roles', 'activeOrgId'], (store) => {
      const members = store.members || [];
      const roles = store.roles || [];
      const orgId = store.activeOrgId || currentOrgId;

      // Build uid -> role object mapping for the active org
      const uidToRole = {};
      members.forEach(m => {
        if (m.orgId === orgId) {
          const role = roles.find(r => r._id === m.roleId);
          uidToRole[m.uid] = role || { name: 'Unknown', level: 0, color: '#888' };
        }
      });

      // Group sessions
      const groups = {};
      filtered.forEach(s => {
        const role = uidToRole[s.ownerUid] || { name: 'Unknown', level: 0, color: '#888' };
        const roleName = role.name;
        if (!groups[roleName]) groups[roleName] = { role, items: [] };
        groups[roleName].items.push(s);
      });

      // Sort groups by role level descending
      const sortedGroupKeys = Object.keys(groups).sort((a, b) => {
        return groups[b].role.level - groups[a].role.level;
      });

      sessionsListEl.innerHTML = '';
      sortedGroupKeys.forEach(roleName => {
        const group = groups[roleName];
        const color = group.role.color || '#aaaaaa';
        // Role group header
        const header = document.createElement('div');
        header.className = 'session-role-group-header';
        header.innerHTML = `
          <span class="session-role-dot" style="background:${color};box-shadow:0 0 8px ${color}"></span>
          <span class="session-role-label" style="color:${color}">${esc(roleName)}</span>
          <span class="session-role-count">${group.items.length} session${group.items.length !== 1 ? 's' : ''}</span>
          <span class="session-role-line"></span>`;
        sessionsListEl.appendChild(header);

        group.items.forEach(s => {
          const tabs = s.tabs || [];
          const time = s.created_at ? getTimeAgo(new Date(s.created_at)) : '';
          const vis = s.visibility || 'private';
          const visBadge = vis === 'private'
            ? '<span class="badge badge-private">Private</span>'
            : '<span class="badge badge-shared">Shared</span>';
          const creator = s.creator_name ? `by ${esc(s.creator_name)}` : '';

          const row = document.createElement('div');
          row.className = 'session-row';
          row.innerHTML = `
            <div class="session-info">
              <div class="session-name">${esc(s.name || 'Untitled')} ${visBadge}</div>
              <div class="session-meta">
                <span>❏ ${tabs.length} tab${tabs.length !== 1 ? 's' : ''}</span>
                ${creator ? `<span>${creator}</span>` : ''}
                ${time ? `<span>⏱ ${time}</span>` : ''}
              </div>
            </div>
            <div class="session-actions">
              <button class="dash-btn" data-action="restore" data-id="${s.session_id}" title="Restore">▶ Open</button>
              <button class="dash-btn ${s.is_shared ? 'dash-btn-primary' : ''}" data-action="share" data-id="${s.session_id}" title="Toggle share">🔗</button>
              <button class="dash-btn dash-btn-danger" data-action="delete" data-id="${s.session_id}" title="Delete">✕</button>
            </div>`;
          sessionsListEl.appendChild(row);
        });
      });

      // Re-attach button handlers
      sessionsListEl.querySelectorAll('[data-action="restore"]').forEach(b =>
        b.addEventListener('click', () => {
          chrome.runtime.sendMessage({ type: 'RESTORE_SESSION', session_id: b.dataset.id }, (r) => {
            toast(r && r.ok ? 'Session restored!' : 'Restore failed', r && r.ok ? 'success' : 'error');
          });
        })
      );
      sessionsListEl.querySelectorAll('[data-action="share"]').forEach(b =>
        b.addEventListener('click', () => {
          chrome.runtime.sendMessage({ type: 'TOGGLE_SHARE', session_id: b.dataset.id }, (r) => {
            if (r && r.ok) { toast(r.is_shared ? 'Shared' : 'Unshared', 'success'); loadSessions(); }
          });
        })
      );
      sessionsListEl.querySelectorAll('[data-action="delete"]').forEach(b =>
        b.addEventListener('click', () => {
          if (confirm('Delete this session?')) {
            chrome.runtime.sendMessage({ type: 'DELETE_SESSION', session_id: b.dataset.id }, (r) => {
              if (r && r.ok) { toast('Deleted', 'success'); loadSessions(); }
            });
          }
        })
      );
    });
  }

  // ===================== ORGANIZATIONS =====================
  const orgListEl = document.getElementById('dash-org-list');
  const createOrgBtn = document.getElementById('dash-create-org-btn');
  const createModal = document.getElementById('create-workspace-modal');
  const workspaceInput = document.getElementById('workspace-name-input');
  const cancelBtn = document.getElementById('btn-cancel-workspace');
  const submitBtn = document.getElementById('btn-submit-workspace');
  
  const rankBuilder = document.getElementById('dash-rank-builder');
  let customRanks = [];
  let currentLevel = 100;
  let rankCounter = 0;

  let activeColorBtn = null;
  const colorPickerFlyout = document.getElementById('custom-color-picker');
  const colorPickerHex = document.getElementById('color-picker-hex');

  function openColorPicker(btn, idx) {
    activeColorBtn = { btn, idx };
    const rect = btn.getBoundingClientRect();
    colorPickerFlyout.style.top = (rect.bottom + 10) + 'px';
    colorPickerFlyout.style.left = rect.left + 'px';
    colorPickerFlyout.classList.remove('hidden');
    colorPickerHex.value = customRanks[idx].color.toUpperCase();
  }

  document.addEventListener('click', (e) => {
    if (!colorPickerFlyout.contains(e.target) && !e.target.closest('.custom-color-btn')) {
      colorPickerFlyout.classList.add('hidden');
    }
  });

  colorPickerFlyout.querySelectorAll('.color-blob').forEach(blob => {
    blob.addEventListener('click', () => {
      if (!activeColorBtn) return;
      const hex = blob.dataset.hex;
      customRanks[activeColorBtn.idx].color = hex;
      activeColorBtn.btn.style.background = hex;
      colorPickerHex.value = hex.toUpperCase();
      colorPickerFlyout.classList.add('hidden');
    });
  });

  colorPickerHex.addEventListener('input', (e) => {
    if (!activeColorBtn) return;
    const hex = e.target.value;
    if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      customRanks[activeColorBtn.idx].color = hex;
      activeColorBtn.btn.style.background = hex;
    }
  });

  function renderRanks() {
    rankBuilder.innerHTML = '';
    customRanks.forEach((rank, idx) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '10px';
      row.style.alignItems = 'center';
      row.style.marginBottom = '5px';
      row.innerHTML = `
        <span style="color:#888; font-family:'JetBrains Mono',monospace; width:30px; font-size:12px;">L${rank.level}</span>
        <input type="text" class="dash-input" style="margin:0; flex:1; padding:8px;" placeholder="Rank Name" value="${rank.name}" data-idx="${idx}">
        <div class="custom-color-btn" style="background:${rank.color};" data-idx="${idx}"></div>
        ${idx > 0 ? `<button class="dash-btn btn-remove" style="width:36px; height:36px; padding:0; margin:0; background:rgba(255,51,102,0.1); border:1px solid rgba(255,51,102,0.4); color:#ff3366;" data-idx="${idx}">✕</button>` : `<div style="width:36px;"></div>`}
      `;
      rankBuilder.appendChild(row);
    });
    
    rankBuilder.querySelectorAll('input[type="text"]').forEach(input => {
      input.addEventListener('input', (e) => {
        customRanks[e.target.dataset.idx].name = e.target.value;
      });
    });
    rankBuilder.querySelectorAll('.custom-color-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        openColorPicker(e.currentTarget, parseInt(e.currentTarget.dataset.idx));
      });
    });
    rankBuilder.querySelectorAll('.btn-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        customRanks.splice(parseInt(e.currentTarget.dataset.idx), 1);
        renderRanks();
      });
    });
  }

  function initRankBuilder() {
    customRanks = [{ id: 'rank_0', name: 'Director', color: '#ff3366', level: 100 }];
    currentLevel = 100;
    rankCounter = 1;
    renderRanks();
  }

  document.getElementById('dash-add-lower-rank').addEventListener('click', (e) => {
    e.preventDefault();
    currentLevel -= 10;
    if(currentLevel < 10) currentLevel = 10;
    customRanks.push({ id: `rank_${rankCounter++}`, name: 'New Rank', color: '#00e5ff', level: currentLevel });
    renderRanks();
  });

  document.getElementById('dash-add-same-rank').addEventListener('click', (e) => {
    e.preventDefault();
    customRanks.push({ id: `rank_${rankCounter++}`, name: 'Co-Rank', color: '#ffaa00', level: currentLevel });
    renderRanks();
  });

  let isEditMode = false;
  let editingOrgId = null;

  const publicToggle = document.getElementById('public-workspace-toggle');

  createOrgBtn.addEventListener('click', () => {
    isEditMode = false;
    editingOrgId = null;
    createModal.classList.remove('hidden');
    document.querySelector('#create-workspace-modal h2').textContent = 'Create New Workspace';
    workspaceInput.value = '';
    workspaceInput.disabled = false;
    publicToggle.checked = true;
    submitBtn.textContent = 'Create';
    initRankBuilder();
    workspaceInput.focus();
  });

  window.openEditStructureModal = function() {
    isEditMode = true;
    editingOrgId = currentOrgId;
    createModal.classList.remove('hidden');
    document.querySelector('#create-workspace-modal h2').textContent = 'Edit Workspace Structure';
    
    chrome.storage.local.get(['organizations', 'roles'], (res) => {
      const org = (res.organizations || []).find(o => o._id === currentOrgId);
      if (org) {
        workspaceInput.value = org.name;
        publicToggle.checked = !!org.isPublic;
      }
      workspaceInput.disabled = true;
      
      const orgRoles = (res.roles || []).filter(r => r.orgId === currentOrgId);
      if (orgRoles.length > 0) {
        customRanks = orgRoles.map(r => ({
          id: r._id,
          name: r.name,
          color: r.color || '#fff',
          level: r.level || 0,
          originalId: r._id
        })).sort((a,b) => b.level - a.level);
        currentLevel = customRanks[customRanks.length - 1].level;
        rankCounter = customRanks.length;
      } else {
        initRankBuilder();
      }
      renderRanks();
      submitBtn.textContent = 'Save Changes';
    });
  }

  cancelBtn.addEventListener('click', () => {
    createModal.classList.add('hidden');
  });

  submitBtn.addEventListener('click', () => {
    const name = workspaceInput.value.trim();
    if (!isEditMode && !name) return;
    if (customRanks.some(r => !r.name.trim())) { toast('All ranks must have a valid name', 'error'); return; }
    submitBtn.textContent = isEditMode ? 'Saving...' : 'Creating...';
    submitBtn.disabled = true;

    const action = isEditMode ? 'UPDATE_ORG_RANKS' : 'CREATE_ORG_WITH_RANKS';
    const payload = isEditMode 
      ? { orgId: editingOrgId, customRanks, isPublic: publicToggle.checked } 
      : { name: name, customRanks, isPublic: publicToggle.checked };

    chrome.runtime.sendMessage({ type: action, ...payload }, (r) => {
      submitBtn.textContent = isEditMode ? 'Save Changes' : 'Create';
      submitBtn.disabled = false;
      if (r && r.ok) {
        createModal.classList.add('hidden');
        if (!isEditMode && r.orgId) currentOrgId = r.orgId;
        toast(isEditMode ? 'Structure updated successfully!' : `Workspace "${r.name}" created!`, 'success');
        loadOrgs();
        loadRoles();
      } else {
        toast(`Failed: ${r?.error || 'Unknown error'}`, 'error');
      }
    });
  });

  const expandedOrgs = new Set();
  const orgSearchInput = document.getElementById('dash-org-search');
  const searchResultsEl = document.getElementById('dash-search-results');
  let searchTimeout = null;

  orgSearchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const query = orgSearchInput.value.trim();
    if (!query) {
      searchResultsEl.innerHTML = '';
      searchResultsEl.classList.add('hidden');
      return;
    }
    searchTimeout = setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'SEARCH_ORGS', query }, (resp) => {
        if (resp && resp.ok) renderSearchResults(resp.data);
      });
    }, 400);
  });

  function renderSearchResults(orgs) {
    searchResultsEl.innerHTML = '';
    if (orgs.length === 0) {
      searchResultsEl.innerHTML = '<div style="padding:10px; color:#666; font-size:12px;">No workspaces found.</div>';
    } else {
      orgs.forEach(org => {
        const row = document.createElement('div');
        row.className = 'search-result-row';
        row.innerHTML = `
          <div style="font-weight:600;">${esc(org.name)}</div>
          <button class="dash-btn dash-btn-primary btn-join" data-id="${org._id}">Join</button>
        `;
        searchResultsEl.appendChild(row);
      });

      searchResultsEl.querySelectorAll('.btn-join').forEach(b => {
        b.addEventListener('click', () => {
          b.disabled = true; b.textContent = '...';
          chrome.runtime.sendMessage({ type: 'REQUEST_JOIN_ORG', orgId: b.dataset.id }, (r) => {
            if (r && r.ok) {
              toast('Join request sent!', 'success');
              b.textContent = 'Sent';
            } else {
              toast(r.error || 'Request failed', 'error');
              b.disabled = false; b.textContent = 'Join';
            }
          });
        });
      });
    }
    searchResultsEl.classList.remove('hidden');
  }

  function loadOrgs() {
    chrome.runtime.sendMessage({ type: 'LIST_ORGS' }, (resp) => {
      if (!resp || !resp.ok) { orgListEl.innerHTML = '<div class="empty-state">No organizations</div>'; return; }
      const orgs = resp.data || [];
      const activeId = resp.activeOrgId || currentOrgId;
      orgListEl.innerHTML = '';
      if (orgs.length === 0) { orgListEl.innerHTML = '<div class="empty-state">No organizations</div>'; return; }
      orgs.forEach(org => {
        const isActive = org._id === activeId;
        const isAdmin = isActive && currentRole && currentRole.level === 100;
        const isExpanded = expandedOrgs.has(org._id);
        
        const row = document.createElement('div');
        row.className = 'org-row-container';
        
        let actionButtons = '';
        if (!isActive) {
          actionButtons = `<button class="dash-btn" data-org-id="${org._id}">Switch</button>`;
        } else if (isAdmin && org.name !== 'Personal Workspace') {
          actionButtons = `
            <div class="org-dropdown-container" style="position:relative;">
              <button class="dash-btn dash-btn-icon" data-dropdown-trigger="${org._id}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle>
                </svg>
              </button>
              <div class="org-dropdown hidden" id="dropdown-${org._id}">
                <button class="dropdown-item" data-action="invite">Invite Members</button>
                <button class="dropdown-item" data-action="edit-structure">Edit Structure</button>
              </div>
            </div>
          `;
        }

        row.innerHTML = `
          <div class="org-row ${isActive ? 'active-org' : ''}" data-row-org-id="${org._id}">
            <div style="display:flex; align-items:center; gap:12px; flex:1; cursor:pointer;" class="org-expand-trigger">
              <span class="chevron" style="transform: rotate(${isExpanded ? '90' : '0'}deg); transition: transform 0.2s;">▶</span>
              <span class="org-name">${esc(org.name || 'Unnamed')}</span>
              ${isActive ? '<span class="badge badge-active">Active</span>' : ''}
            </div>
            ${actionButtons}
          </div>
          <div class="org-hierarchy ${isExpanded ? '' : 'hidden'}" id="hierarchy-${org._id}">
            <div style="font-size:11px; color:#666; padding:10px;">Loading hierarchy...</div>
          </div>
        `;
        orgListEl.appendChild(row);

        if (isExpanded) renderOrgHierarchy(org._id);
      });
      
      orgListEl.querySelectorAll('.org-expand-trigger').forEach(trigger => {
        trigger.addEventListener('click', () => {
          const orgId = trigger.closest('.org-row').dataset.rowOrgId;
          const hierarchyEl = document.getElementById(`hierarchy-${orgId}`);
          const chevron = trigger.querySelector('.chevron');
          
          if (expandedOrgs.has(orgId)) {
            expandedOrgs.delete(orgId);
            hierarchyEl.classList.add('hidden');
            chevron.style.transform = 'rotate(0deg)';
          } else {
            expandedOrgs.add(orgId);
            hierarchyEl.classList.remove('hidden');
            chevron.style.transform = 'rotate(90deg)';
            renderOrgHierarchy(orgId);
          }
        });
      });
      
      // Close dropdowns when clicking outside
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.org-dropdown-container')) {
          document.querySelectorAll('.org-dropdown').forEach(d => d.classList.add('hidden'));
        }
      });
      
      // Bind Dropdown triggers
      orgListEl.querySelectorAll('[data-dropdown-trigger]').forEach(b => {
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const targetId = `dropdown-${b.dataset.dropdownTrigger}`;
          document.querySelectorAll('.org-dropdown').forEach(d => {
            if (d.id !== targetId) d.classList.add('hidden');
          });
          document.getElementById(targetId).classList.toggle('hidden');
        });
      });
      
      // Bind Dropdown actions
      orgListEl.querySelectorAll('[data-action="invite"]').forEach(b => {
        b.addEventListener('click', (e) => {
           document.querySelectorAll('.sidebar li').forEach(li => li.classList.remove('active'));
           const inviteNav = document.querySelector('[data-section="invites"]');
           if(inviteNav) inviteNav.classList.add('active');
           switchSection('invites');
        });
      });
      orgListEl.querySelectorAll('[data-action="edit-structure"]').forEach(b => {
        b.addEventListener('click', (e) => {
           openEditStructureModal();
        });
      });
      orgListEl.querySelectorAll('[data-org-id]').forEach(b =>
        b.addEventListener('click', () => {
          chrome.runtime.sendMessage({ type: 'SET_ACTIVE_ORG', orgId: b.dataset.orgId }, () => {
            currentOrgId = b.dataset.orgId;
            toast('Switched workspace', 'success');
            loadOrgs();
          });
        })
      );
    });
  }

  function renderOrgHierarchy(orgId) {
    const hierarchyEl = document.getElementById(`hierarchy-${orgId}`);
    if (!hierarchyEl) return;

    // Fetch both roles and members
    chrome.runtime.sendMessage({ type: 'GET_ORG_ROLES', orgId }, (roleResp) => {
      chrome.runtime.sendMessage({ type: 'GET_ORG_MEMBERS', orgId }, (memResp) => {
        if (!roleResp?.ok || !memResp?.ok) {
          hierarchyEl.innerHTML = '<div style="padding:10px; color:#ff3366; font-size:11px;">Failed to load hierarchy.</div>';
          return;
        }

        const roles = (roleResp.data || []).sort((a, b) => (b.level || 0) - (a.level || 0));
        const members = memResp.data || [];

        if (roles.length === 0) {
          hierarchyEl.innerHTML = '<div style="padding:10px; color:#666; font-size:11px;">No ranks defined.</div>';
          return;
        }

        let html = '<div class="org-hierarchy">';
        roles.forEach(role => {
          const roleMembers = members.filter(m => m.roleId === role._id);
          const color = role.color || '#888';
          
          html += `
            <div class="rank-group">
              <div class="rank-header" style="background:${color}15; color:${color}; border:1px solid ${color}30;">
                ${esc(role.name)} <span style="opacity:0.6; margin-left:4px;">L${role.level}</span>
              </div>
              <div class="rank-members" style="margin-left:12px; display:flex; flex-direction:column; gap:4px; margin-top:4px;">
          `;

          if (roleMembers.length === 0) {
            html += '<div style="font-size:11px; color:#444; padding:2px 8px;">No members</div>';
          } else {
            roleMembers.forEach(m => {
              const isPending = m.status === 'pending';
              const name = m.displayName || m.email || 'Unknown User';
              const isYou = (currentUser && m.uid === currentUser.uid) ? ' (You)' : '';
              
              html += `
                <div class="member-item">
                  <div style="display:flex; align-items:center;">
                    <span class="status-dot" style="background:${isPending ? '#ffaa00' : '#00e5a0'}"></span>
                    <span>${esc(name)}${isYou}</span>
                  </div>
                  ${isPending ? '<span style="font-size:9px; color:#ffaa00; text-transform:uppercase; font-weight:700;">Pending</span>' : ''}
                </div>
              `;
            });
          }

          html += `</div></div>`;
        });
        html += '</div>';
        hierarchyEl.innerHTML = html;
      });
    });
  }

  // ===================== MEMBERS =====================
  const membersListEl = document.getElementById('dash-members-list');
  const memberSearchEl = document.getElementById('dash-member-search');

  memberSearchEl.addEventListener('input', () => {
    memberSearchQuery = memberSearchEl.value.trim().toLowerCase();
    renderMembers(allMembers);
  });

  function loadMembers() {
    chrome.runtime.sendMessage({ type: 'GET_ORG_MEMBERS' }, (resp) => {
      if (!resp || !resp.ok || !resp.data || resp.data.length === 0) {
        allMembers = [];
        membersListEl.innerHTML = '<div class="empty-state">No members found</div>';
        return;
      }
      allMembers = resp.data;
      renderMembers(allMembers);
    });
  }

  function renderMembers(members) {
    chrome.storage.local.get(['roles', 'user'], (store) => {
      const roles = store.roles || [];
      const currentUid = store.user?.uid;
      const currentDisplayName = store.user?.displayName || store.user?.email || '';

      let filtered = members;
      if (memberSearchQuery) {
        filtered = members.filter(m => {
          const name = getMemberName(m, currentUid, currentDisplayName);
          const role = roles.find(r => r._id === m.roleId);
          const roleName = role ? role.name : '';
          return name.toLowerCase().includes(memberSearchQuery) ||
                 roleName.toLowerCase().includes(memberSearchQuery) ||
                 (m.status || '').toLowerCase().includes(memberSearchQuery);
        });
      }

      if (filtered.length === 0) {
        membersListEl.innerHTML = '<div class="empty-state">No members found</div>';
        return;
      }

      let html = `<table class="members-table">
        <thead><tr><th>Member</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>`;
      filtered.forEach(m => {
        const role = roles.find(r => r._id === m.roleId);
        const roleName = role ? role.name : 'Unknown';
        const roleColor = role ? role.color : '#888';
        const memberName = getMemberName(m, currentUid, currentDisplayName);
        const statusBadge = m.status === 'active'
          ? '<span class="badge badge-active">Active</span>'
          : '<span class="badge badge-pending">Pending</span>';
        const approveBtn = m.status === 'pending'
          ? `<button class="dash-btn dash-btn-primary" data-approve-uid="${m._id}">Approve</button>`
          : '';
        const isYou = m.uid === currentUid ? ' <span style="color:var(--text-muted);font-size:9px;">(you)</span>' : '';
        html += `<tr>
          <td>
            <div style="font-size:11px;font-weight:600;letter-spacing:0.05em;">${esc(memberName)}${isYou}</div>
            <div style="font-size:9px;color:var(--text-muted);margin-top:2px;letter-spacing:0.03em;">${esc(m.email || '')}</div>
          </td>
          <td><span class="role-badge-inline" style="background:${roleColor}10; color:${roleColor}; border-color:${roleColor}50;">${esc(roleName)}</span></td>
          <td>${statusBadge}</td>
          <td>${approveBtn}</td>
        </tr>`;
      });
      html += '</tbody></table>';
      membersListEl.innerHTML = html;

      membersListEl.querySelectorAll('[data-approve-uid]').forEach(b =>
        b.addEventListener('click', () => {
          b.disabled = true; b.textContent = '...';
          chrome.runtime.sendMessage({ type: 'APPROVE_USER', uid: b.dataset.approveUid }, (r) => {
            if (r && r.ok) { toast('Approved!', 'success'); loadMembers(); }
            else { toast('Failed', 'error'); b.disabled = false; b.textContent = 'Approve'; }
          });
        })
      );
    });
  }

  function getMemberName(member, currentUid, currentDisplayName) {
    // If it's the current user, use their local displayName
    if (member.uid === currentUid) return currentDisplayName;
    // If member doc has displayName or email, use that
    if (member.displayName) return member.displayName;
    if (member.email) return member.email;
    // Fall back to shortened UID
    if (member.uid) return member.uid.substring(0, 8) + '…';
    return 'Unknown';
  }

  // ===================== ROLES =====================
  const rolesListEl = document.getElementById('dash-roles-list');

  function loadRoles() {
    chrome.storage.local.get(['roles', 'activeOrgId'], (result) => {
      const orgId = result.activeOrgId || currentOrgId;
      const roles = (result.roles || []).filter(r => r.orgId === orgId);
      rolesListEl.innerHTML = '';
      if (roles.length === 0) { rolesListEl.innerHTML = '<div class="empty-state">No roles defined for this workspace</div>'; return; }

      // Sort: Highest level first
      const sorted = [...roles].sort((a, b) => {
        const la = a.level ?? 0;
        const lb = b.level ?? 0;
        return lb - la;
      });

      sorted.forEach(role => {
        const card = document.createElement('div');
        card.className = 'role-card';
        const rc = role.color || '#fff';
        card.innerHTML = `
          <div class="role-card-header">
            <span class="role-card-name" style="color:${rc}; text-shadow:0 0 5px ${rc}50">${esc(role.name)}</span>
            ${role.isSystem ? '<span class="role-system-badge">System</span>' : ''}
          </div>
          <div class="perm-list">
            ${(role.permissions || []).map(p => `<span class="perm-tag">${esc(p)}</span>`).join('')}
          </div>`;
        rolesListEl.appendChild(card);
      });
    });
  }

  // ===================== INVITES =====================
  const inviteRoleEl = document.getElementById('dash-invite-role');
  const createInviteBtn = document.getElementById('dash-create-invite-btn');
  const inviteResultEl = document.getElementById('dash-invite-result');
  const inviteLinkEl = document.getElementById('dash-invite-link');
  const copyInviteBtn = document.getElementById('dash-copy-invite');

  function loadInviteRoles() {
    chrome.storage.local.get(['roles', 'activeOrgId'], (result) => {
      const orgId = result.activeOrgId || currentOrgId;
      const roles = (result.roles || []).filter(r => r.orgId === orgId);
      inviteRoleEl.innerHTML = '';
      roles.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.name;
        opt.textContent = r.name;
        inviteRoleEl.appendChild(opt);
      });
    });
  }

  createInviteBtn.addEventListener('click', () => {
    const roleName = inviteRoleEl.value || 'Viewer';
    createInviteBtn.disabled = true;
    createInviteBtn.textContent = 'Generating...';
    chrome.runtime.sendMessage({ type: 'CREATE_INVITE', roleName }, (r) => {
      createInviteBtn.disabled = false;
      createInviteBtn.textContent = 'Generate Invite Link';
      if (r && r.ok) {
        const link = `${chrome.runtime.getURL('auth.html')}?token=${r.token}`;
        inviteLinkEl.value = link;
        inviteResultEl.style.display = 'block';
        toast('Invite link created!', 'success');
      } else {
        toast(r?.error || 'Failed to create invite', 'error');
      }
    });
  });

  copyInviteBtn.addEventListener('click', () => {
    inviteLinkEl.select();
    navigator.clipboard.writeText(inviteLinkEl.value).then(() => toast('Copied!', 'success'));
  });

  // ===================== PRIVACY =====================
  const domainInput = document.getElementById('dash-domain-input');
  const addDomainBtn = document.getElementById('dash-add-domain-btn');
  const domainListEl = document.getElementById('dash-domain-list');
  const flaggedTabsListEl = document.getElementById('dash-flagged-tabs-list');

  function loadPrivacy() {
    chrome.runtime.sendMessage({ type: 'GET_PRIVACY_FLAGS' }, (resp) => {
      if (!resp || !resp.ok) return;
      // Domains
      const domains = resp.flaggedDomains || [];
      domainListEl.innerHTML = '';
      if (domains.length === 0) {
        domainListEl.innerHTML = '<div class="empty-state" style="padding:16px 0;">No flagged domains</div>';
      } else {
        domains.forEach(d => {
          const row = document.createElement('div');
          row.className = 'domain-row';
          row.innerHTML = `
            <div><div class="domain-row-name">${esc(d)}</div>
            <div class="domain-row-sub">all subdomains included</div></div>
            <button class="dash-btn dash-btn-danger" data-remove-domain="${esc(d)}">Remove</button>`;
          domainListEl.appendChild(row);
        });
        domainListEl.querySelectorAll('[data-remove-domain]').forEach(b =>
          b.addEventListener('click', () => {
            chrome.runtime.sendMessage({ type: 'REMOVE_DOMAIN_FLAG', domain: b.dataset.removeDomain }, (r) => {
              if (r && r.ok) { toast('Domain removed', 'success'); loadPrivacy(); }
            });
          })
        );
      }
      // Tabs
      const tabs = resp.flaggedTabs || [];
      flaggedTabsListEl.innerHTML = '';
      if (tabs.length === 0) {
        flaggedTabsListEl.innerHTML = '<div class="empty-state" style="padding:16px 0;">No flagged tabs</div>';
      } else {
        tabs.forEach(t => {
          const row = document.createElement('div');
          row.className = 'domain-row';
          row.innerHTML = `
            <div><div class="domain-row-name">${esc(t.hostname || t.title || 'Tab #' + t.id)}</div>
            <div class="domain-row-sub">${esc(t.title || t.url || '(closed)')}</div></div>
            <button class="dash-btn dash-btn-danger" data-unflag-tab="${t.id}">Unflag</button>`;
          flaggedTabsListEl.appendChild(row);
        });
        flaggedTabsListEl.querySelectorAll('[data-unflag-tab]').forEach(b =>
          b.addEventListener('click', () => {
            chrome.runtime.sendMessage({ type: 'TOGGLE_TAB_FLAG', tabId: parseInt(b.dataset.unflagTab, 10) }, (r) => {
              if (r && r.ok) { toast('Tab unflagged', 'success'); loadPrivacy(); }
            });
          })
        );
      }
    });
  }

  addDomainBtn.addEventListener('click', () => {
    const raw = domainInput.value.trim().toLowerCase();
    const domain = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!domain) { toast('Enter a domain', 'error'); return; }
    chrome.runtime.sendMessage({ type: 'ADD_DOMAIN_FLAG', domain }, (r) => {
      if (r && r.ok) { domainInput.value = ''; toast(`"${domain}" flagged`, 'success'); loadPrivacy(); }
    });
  });
  domainInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addDomainBtn.click(); });

  // ===================== HELPERS =====================
  function toast(msg, type) {
    toastEl.textContent = msg;
    toastEl.className = `dash-toast ${type}`;
    setTimeout(() => { toastEl.className = 'dash-toast hidden'; }, 3000);
  }

  function esc(s) {
    return (s || '').toString()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getTimeAgo(date) {
    const s = Math.floor((new Date() - date) / 1000);
    if (s / 31536000 > 1) return Math.floor(s / 31536000) + 'y ago';
    if (s / 2592000 > 1) return Math.floor(s / 2592000) + 'mo ago';
    if (s / 86400 > 1) return Math.floor(s / 86400) + 'd ago';
    if (s / 3600 > 1) return Math.floor(s / 3600) + 'h ago';
    if (s / 60 > 1) return Math.floor(s / 60) + 'm ago';
    return 'just now';
  }
});
