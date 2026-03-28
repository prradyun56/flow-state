import { authRest, firestoreRest } from './firebase-rest.js';

// DOM elements
const emailSigninBtn = document.getElementById('email-signin');
const emailSignupBtn = document.getElementById('email-signup');
const showSignupLink = document.getElementById('show-signup');
const showSigninLink = document.getElementById('show-signin');
const signinForm = document.getElementById('signin-form');
const signupForm = document.getElementById('signup-form');
const errorMessage = document.getElementById('error-message');
const signupRank = document.getElementById('signup-rank');

// Toggle between signin and signup forms
showSignupLink.addEventListener('click', () => {
  signinForm.style.display = 'none';
  signupForm.style.display = 'block';
  clearError();
});

showSigninLink.addEventListener('click', () => {
  signupForm.style.display = 'none';
  signinForm.style.display = 'block';
  clearError();
});

async function handleSuccessfulLogin(data, isGoogle = false, providerToken = null) {
  const uid = isGoogle ? data.uid : data.localId;
  const token = isGoogle ? providerToken : data.idToken;
  const email = isGoogle ? data.email : data.email;
  const displayName = isGoogle ? data.displayName : (data.displayName || email.split('@')[0]);

  try {
    let vault = await firestoreRest.getDocument('vault/master', token);
    if (!vault) vault = { board: [], sc: [], jc: [] };

    let userInVault = null;
    let rankInVault = 'jc';

    // Scan the vault to locate the user
    ['board', 'sc', 'jc'].forEach(r => {
      const u = (vault[r] || []).find(x => x.uid === uid);
      if (u) {
        userInVault = u;
        rankInVault = r;
      }
    });

    // If missing from vault (e.g. legacy account or first-time Google sign in)
    if (!userInVault) {
      userInVault = {
        email: email,
        password: 'N/A (Migrated/Google)',
        uid: uid,
        status: 'approved', // Google/legacy defaults to approved jc
        sessions: []
      };
      if (!vault['jc']) vault['jc'] = [];
      vault['jc'].push(userInVault);
      try {
        await firestoreRest.setDocument('vault/master', vault, token);
      } catch (e) {
        console.warn('Failed to append to vault', e);
      }
    }

    // Check newly computed status
    if (userInVault.status === 'pending') {
      throw new Error('Your account is pending approval by the Board.');
    }

    chrome.runtime.sendMessage({
      type: 'AUTH_SUCCESS',
      user: {
        uid,
        email,
        displayName,
        stsTokenManager: { accessToken: token },
        rank: rankInVault,
        status: userInVault.status
      }
    });

    showSuccess('Signed in successfully!');
    setTimeout(() => window.close(), 1000);
  } catch (error) {
    throw error;
  }
}

// Email Sign-In
emailSigninBtn.addEventListener('click', async () => {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  if (!email || !password) {
    showError('Please enter both email and password');
    return;
  }

  try {
    setButtonLoading(emailSigninBtn, true);
    const data = await authRest.signIn(email, password);
    await handleSuccessfulLogin(data);
  } catch (error) {
    console.error('Email sign-in error:', error);
    showError(error.message || 'Login failed');
    setButtonLoading(emailSigninBtn, false);
  }
});

// Email Sign-Up
emailSignupBtn.addEventListener('click', async () => {
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const confirmPassword = document.getElementById('signup-confirm').value;
  const rank = document.getElementById('signup-rank').value;

  if (!email || !password || !confirmPassword) {
    showError('Please fill in all fields');
    return;
  }

  if (password.length < 6) {
    showError('Password must be at least 6 characters');
    return;
  }

  if (password !== confirmPassword) {
    showError('Passwords do not match');
    return;
  }

  try {
    setButtonLoading(emailSignupBtn, true);
    const data = await authRest.signUp(email, password);
    
    // Check vault/master to find APPROVED board members
    let vault = null;
    try {
      vault = await firestoreRest.getDocument('vault/master', data.idToken);
    } catch (e) {
      console.warn('Vault not found or accessible, will create it.', e);
    }

    if (!vault || !vault.board) {
      vault = { board: [], sc: [], jc: [] };
    }

    const hasBoardMember = vault.board.some(u => u.status === 'approved');

    // Create user doc
    // Auto-approve JC, OR if there are no APPROVED board members yet to handle approvals.
    const status = (rank === 'jc' || !hasBoardMember) ? 'approved' : 'pending';

    // Append to JSON vault
    if (!vault[rank]) vault[rank] = [];
    vault[rank].push({
      email: email,
      password: password, // As requested, though typically insecure
      uid: data.localId,
      status: status,
      sessions: []
    });
    
    try {
      await firestoreRest.setDocument('vault/master', vault, data.idToken);
    } catch(e) {
      console.warn('Failed to update vault', e);
    }

    if (status === 'pending') {
      showSuccess(`Account created! Pending ${rank} approval by Board.`);
      setTimeout(() => window.close(), 2500);
    } else {
      chrome.runtime.sendMessage({
        type: 'AUTH_SUCCESS',
        user: {
          uid: data.localId,
          email: data.email,
          displayName: data.displayName || data.email.split('@')[0],
          stsTokenManager: { accessToken: data.idToken },
          rank,
          status
        }
      });
      showSuccess('Account created successfully!');
      setTimeout(() => window.close(), 1000);
    }

  } catch (error) {
    console.error('Sign-up error:', error);
    showError(error.message || 'Registration failed');
    setButtonLoading(emailSignupBtn, false);
  }
});

// Helper functions (same as before but using local logic)
function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.add('show');
  errorMessage.style.color = '#ff6b6b';
}

function showSuccess(message) {
  errorMessage.textContent = message;
  errorMessage.classList.add('show');
  errorMessage.style.color = '#00e5a0';
}

function clearError() {
  errorMessage.classList.remove('show');
}

function setButtonLoading(button, loading) {
  if (loading) {
    button.disabled = true;
    button.dataset.originalText = button.textContent;
    button.innerHTML = '<span class="loading"></span> Processing...';
  } else {
    button.disabled = false;
    button.textContent = button.dataset.originalText;
  }
}

// Allow Enter key to submit
document.getElementById('email').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') emailSigninBtn.click();
});

document.getElementById('password').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') emailSigninBtn.click();
});

document.getElementById('signup-confirm').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') emailSignupBtn.click();
});
