# FlowState Extension - Detailed Architecture & Working

FlowState is a Chrome Extension designed to serve as a developer context switcher, allowing users to save and restore browser tab sessions across devices. It uses Firebase for cloud synchronization and implements a role-based access control (RBAC) system.

## Project Structure

*   **`manifest.json`**: The central configuration file for the Manifest V3 extension, defining permissions, entry points, and policies.
*   **`background.js`**: The service worker, acting as the background script handling events like tab changes, window closures, and communication with other parts of the extension.
*   **`popup.html` & `popup.js`**: The user interface of the extension popup, where users manage their sessions.
*   **`auth.html` & `auth.js`**: The authentication UI and logic for signing in/up using Google or Email/Password.
*   **`storage.js`**: The local and cloud storage manager, handling data synchronization.
*   **`firebase-rest.js`**: A custom wrapper around Firebase REST APIs to ensure compatibility with Manifest V3 CSP.
*   **`firebase-config.js`**: Contains Firebase project credentials.
*   **`styles.css`**: Styling for the popup and authentication pages.

## 1. Extension Core (Manifest V3)

The extension is built using the latest Manifest V3 (MV3) architecture. The key constraints of MV3 include:
*   No execution of remotely hosted code (hence no standard Firebase JS SDK).
*   Background processes are handled by Service Workers, which can sleep/wake up and cannot rely on persistent in-memory global variables across sleep cycles.

To accommodate this, the extension uses direct HTTP requests to Firebase REST APIs (`firebase-rest.js`) and stores its critical state in `chrome.storage.local` and `chrome.storage.session` to rehydrate state upon service worker wake-ups.

## 2. Authentication Flow (`auth.html`, `auth.js`, `firebase-rest.js`)

Due to MV3 constraints, the standard Firebase Authentication SDK is not used. Instead, a custom authentication flow is implemented.

### Google Sign-In
1.  **OAuth Flow**: When the user clicks "Sign in with Google", `auth.js` uses `chrome.identity.launchWebAuthFlow` to initiate an OAuth 2.0 flow with Google.
2.  **Access Token**: Google returns an access token in the redirect URL fragment.
3.  **Firebase Exchange**: The Google access token is sent to the Firebase Identity Toolkit REST API (via `authRest.signInWithIdp`) to exchange it for a Firebase ID token.
4.  **Vault Verification**: The user's UID is checked against the centralized Firestore database (`vault/master`).
5.  **Role Assignment / Completion**: If the user exists and is approved, their details are saved to `chrome.storage.local`, and the popup is notified. If they are new, they are prompted to apply for a position (rank).

### Email/Password Sign-In/Up
1.  **API interaction**: Custom forms capture credentials.
2.  **REST API**: Sends requests to `accounts:signUp` or `accounts:signInWithPassword` via `authRest`.
3.  **Vault Update**: On sign-up, the user is added to `vault/master` under their selected rank. Junior Core (`jc`) members are automatically approved, while higher tiers requires Board approval.

## 3. Storage & Synchronization (`storage.js`)

The `StorageManager` class orchestrates data between `chrome.storage.local` (for fast UI rendering) and Firebase Firestore (for synchronization).

### Data Model
Data is stored within a single Firestore document: `vault/master`. It contains arrays for each rank (`board`, `sc`, `jc`). Inside these rank arrays are user objects, which contain an array of `sessions`.

```json
{
  "board": [
    {
      "uid": "123",
      "email": "user@example.com",
      "status": "approved",
      "sessions": [ { "session_id": "abc", "name": "...", "tabs": [...] } ]
    }
  ],
  "jc": [...]
}
```

### Sync Strategy
*   **Polling**: Instead of persistent WebSocket connections (which can keep the service worker awake needlessly or fail due to sleep), the extension polls Firestore every 30 seconds using `setInterval`.
*   **Full Sync (`fullSync`)**: Performed on initialization. It pushes any local sessions that exist only locally (not in the cloud) to Firestore, and then pulls permitted cloud sessions to local storage.
*   **Pull Sync (`syncFromCloud`)**: Periodically checks the cloud. It downloads the `vault/master` document, calculates a hash, and compares it to a locally cached hash. If the hash has changed, it re-evaluates which sessions the current user is permitted to see and updates `chrome.storage.local`.
*   **Message Broadcasting**: When cloud data is synced and local storage is updated, `broadcastUpdate` sends a `CLOUD_UPDATED` message, causing the UI to re-render.

## 4. Role-Based Access Control (RBAC)

Access to sessions is strictly governed by the user's assigned rank, evaluated during the `_pullFromCloud` operation in `storage.js`.

*   **JC (Junior Core)**: Can only view their own sessions and sessions marked as `is_shared = true` by other users.
*   **SC (Senior Core)**: Can view their own sessions, any session created by a JC, and any session marked as shared.
*   **Board**: Can view everything (their own, SC, and JC sessions), and manages approvals for pending user accounts via the popup.

## 5. Live Recording System (`background.js`)

The extension can "record" a active window, continuously taking snapshots of its open tabs.

1.  **Initiation**: Triggered from the popup (`START_RECORDING`). The `windowId` and `sessionId` are saved in `chrome.storage.session`.
2.  **Event Listeners**: `background.js` registers synchronous listeners for `chrome.tabs.onCreated`, `onRemoved`, `onUpdated`, `onActivated`, `onMoved`, `onAttached`, `onDetached`, and `chrome.windows.onRemoved`.
3.  **Debounced Snapshots**: When a tab event fires for the recorded window, `snapshotAndSave()` is called. This function is debounced by 300ms using `setTimeout` to prevent spamming the database during rapid tab operations (like closing 10 tabs at once).
4.  **Local Save**: The snapshot updates the session directly in `chrome.storage.local`.
5.  **Debounced Cloud Sync**: After updating local storage, an alarm (`chrome.alarms.create`) is set to sync changes to the cloud 5 seconds later.

## 6. Popup UI (`popup.js`, `styles.css`)

The popup acts as the primary control center.

*   **Reactivity**: It relies on `chrome.storage.local` to render its view. It listens for runtime messages like `CLOUD_UPDATED` and `RECORDING_UPDATED` to instantly refresh the displayed list.
*   **Session Management**: Allows creating, restoring, sharing, and deleting sessions. Restoring a session simply iterates through the saved `tabs` array and calls `chrome.tabs.create`.
*   **Admin Panel**: If the user is a `board` member, an extra "Pending Approvals" section appears, allowing them to approve new SC/Board registrations.
*   **Status Indicators**: Displays real-time sync status ("Syncing", "Synced", "Live") using CSS animations.

## 7. Overcoming Manifest V3 Restrictions

1.  **Service Worker Lifecycle**: Since background scripts can constantly terminate, global variables reset. The extension rehydrates critical context (like active recording state) from `chrome.storage.session` every time the service worker wakes up before evaluating tab events.
2.  **No Dynamic Code Execution**: Directly integrating standard Firebase web SDKs often fails in MV3 due to Content Security Policy (CSP) blocking `eval` or remote fetching. Building a custom wrapper (`firebase-rest.js`) over the standard Google Cloud/Firebase REST endpoints mitigates this entirely.
3.  **Persistent Connectivity**: Periodic polling and debounced saving ensures state synchronization without relying on long-lived connections that MV3 service workers frequently abruptly kill.
