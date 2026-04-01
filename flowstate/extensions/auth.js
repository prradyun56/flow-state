import { authRest, firestoreRest } from './firebase-rest.js';
import { GOOGLE_CLIENT_ID } from './firebase-config.js';

// DOM elements
const googleSigninBtn = document.getElementById('google-signin');
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

// Google Sign-In via chrome.identity
googleSigninBtn.addEventListener('click', async () => {
  clearError();
  const redirectUri = chrome.identity.getRedirectURL();
  const scopes = ['openid', 'email', 'profile'];
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', scopes.join(' '));

  try {
    setButtonLoading(googleSigninBtn, true);
    const responseUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        { url: authUrl.toString(), interactive: true },
        (callbackUrl) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(callbackUrl);
          }
        }
      );
    });

    // Extract access_token from the redirect URL fragment
    const params = new URLSearchParams(new URL(responseUrl.replace('#', '?')).search);
    const accessToken = params.get('access_token');
    if (!accessToken) throw new Error('No access token received from Google');

    // Exchange Google token with Firebase Auth
    const firebaseData = await authRest.signInWithIdp(accessToken, 'google.com');
    await handleSuccessfulLogin(firebaseData, true, firebaseData.idToken);
  } catch (error) {
    console.error('Google sign-in error:', error);
    if (!error.message.includes('User cancelled') && !error.message.includes('canceled')) {
      showError(error.message || 'Google sign-in failed');
    }
    setButtonLoading(googleSigninBtn, false);
  }
});

async function handleSuccessfulLogin(data, isGoogle = false, providerToken = null) {
  const uid = data.localId;
  const token = isGoogle ? providerToken : data.idToken;
  const email = data.email;
  const displayName = data.displayName || email.split('@')[0];

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

    // If missing from vault, show position application instead of auto-creating
    if (!userInVault) {
      showPositionApplication(vault, token, uid, email, displayName, isGoogle, data);
      return;
    }

    // Check status
    if (userInVault.status === 'pending') {
      throw new Error('Your account is pending approval by the Board.');
    }

    completeLogin(uid, email, displayName, token, isGoogle, data, rankInVault, userInVault.status);
  } catch (error) {
    throw error;
  }
}

function completeLogin(uid, email, displayName, token, isGoogle, data, rank, status) {
  chrome.runtime.sendMessage({
    type: 'AUTH_SUCCESS',
    user: {
      uid,
      email,
      displayName,
      stsTokenManager: {
        accessToken: token,
        refreshToken: isGoogle ? (data.refreshToken || '') : (data.refreshToken || '')
      },
      rank,
      status
    }
  });

  showSuccess('Signed in successfully!');
  setTimeout(() => window.close(), 1000);
}

function showPositionApplication(vault, token, uid, email, displayName, isGoogle, data) {
  // Hide the main auth container, show the position application
  document.querySelector('.auth-container:not(.position-app-container)').style.display = 'none';
  const posApp = document.getElementById('position-application');
  posApp.style.display = 'block';

  const submitBtn = document.getElementById('position-submit');
  const posError = document.getElementById('position-error');

  // Remove any previous listener by cloning
  const newSubmitBtn = submitBtn.cloneNode(true);
  submitBtn.parentNode.replaceChild(newSubmitBtn, submitBtn);

  newSubmitBtn.addEventListener('click', async () => {
    const selected = document.querySelector('input[name="position-rank"]:checked');
    if (!selected) {
      posError.textContent = 'Please select a position';
      posError.classList.add('show');
      posError.style.color = '#ff6b6b';
      return;
    }

    const rank = selected.value;

    try {
      setButtonLoading(newSubmitBtn, true);

      // Check if there's an approved board member (needed for approval logic)
      const hasBoardMember = (vault.board || []).some(u => u.status === 'approved');
      const status = (rank === 'jc' || !hasBoardMember) ? 'approved' : 'pending';

      const userEntry = {
        email: email,
        password: 'N/A (Migrated/Google)',
        uid: uid,
        status: status,
        sessions: []
      };

      if (!vault[rank]) vault[rank] = [];
      vault[rank].push(userEntry);

      await firestoreRest.setDocument('vault/master', vault, token);

      if (status === 'pending') {
        posError.textContent = `Application submitted! Pending ${rank.toUpperCase()} approval by Board.`;
        posError.classList.add('show');
        posError.style.color = '#00e5a0';
        setButtonLoading(newSubmitBtn, false);
        setTimeout(() => window.close(), 2500);
      } else {
        completeLogin(uid, email, displayName, token, isGoogle, data, rank, status);
      }
    } catch (e) {
      console.error('Position application error:', e);
      posError.textContent = e.message || 'Failed to submit application';
      posError.classList.add('show');
      posError.style.color = '#ff6b6b';
      setButtonLoading(newSubmitBtn, false);
    }
  });
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
          stsTokenManager: {
            accessToken: data.idToken,
            refreshToken: data.refreshToken || ''
          },
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
