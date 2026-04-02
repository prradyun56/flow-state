# FlowState Documentation

## Project Overview

**FlowState** is a Chromium-based browser extension designed for session management, team collaboration, and workspace recording. It allows users to group, save, and restore tabs collectively as "sessions", tracking exact scroll positions to let users resume work instantly. 

A central feature of FlowState is its **Organizational Collaboration Model**. Users can create or join Workspaces, invite other users via custom links, define custom hierarchical roles (with tailored RGB styling and specific granular permissions), and selectively share browser sessions across the organization.

## Architecture

At its core, the project is a **Manifest V3 (MV3)** Chrome Extension built utilizing Vanilla HTML, CSS, and modern JavaScript. It eschews heavy modern frameworks (like React or Vue) mostly to remain ultra-lightweight and rapidly responsive, heavily utilizing native DOM manipulation and the Web API.

### Backend Infrastructure
The extension relies completely on **Google Firebase** (specifically Cloud Firestore & Authentication). However, due to the restrictions of MV3 Service Workers—which do not have access to standard DOM constructs used by classic Firebase SDKs—the project accesses Firebase using a specialized **Firebase REST implementation**.

To ensure near-instantaneous load times, the extension heavily uses an aggressive local caching setup via `chrome.storage.local`. A sync engine (`storage.js`) periodically aggregates data from Firestore in the background and commits it to local storage. Therefore, UI rendering scripts (like the Dashboard) almost always perform ultra-fast reads from local storage instead of waiting on network delays.

### The Backend Data Pipeline

Because FlowState leverages a service worker and strict MV3 security paradigms, data does not flow directly from the UI to the database. Instead, it follows a strict, one-way declarative pipeline:

1. **User Action (UI Layer):** A user clicks "Create Workspace" or "Save Session" in `dashboard.js` or `popup.js`.
2. **Message Dispatch:** The UI cannot talk to Firebase directly for complex logic. Instead, it fires off a lightweight `chrome.runtime.sendMessage({ type: 'CREATE_ORG', ... })`.
3. **Background Router (`background.js`):** The service worker receives this message. It serves as the authoritative orchestrator, ensuring the request is valid.
4. **Manager Delegation:** The router passes the payload to a Business Logic Manager (e.g., `orgManager.createOrg()`). Here, RBAC permissions are verified via `role-manager.js`.
5. **REST API Execution (`firebase-rest.js`):** The Manager invokes the custom Firebase REST wrapper. A `POST` or `PATCH` request is structured, signed with the user's secret Identity Token, and sent over the wire to Google Firestore.
6. **Cloud Confirmation & Cache Update:** Firestore processes the change and returns a successful HTTP 200 response. `storage.js` is immediately triggered to run a sync, fetching the updated state from the cloud and overwriting `chrome.storage.local`.
7. **UI Re-render:** The background worker sends a `true` callback back to the UI which originally sent the message, or the UI listens for `chrome.storage.onChanged`. The Dashboard instantly re-renders using the fresh local cache.

---

## Technical File Breakdown

The major application source code lives inside the `/extension/extensions/` directory.

### Core Entry & Configuration

#### `manifest.json`
* **What it does:** It is the core blueprint of the Chrome Extension. It defines the name, version, icons, and fundamental structure.
* **How it does it:** Declares the `background.js` as the Service Worker, registers `content.js` to run on all URLs, specifies the `popup.html` for the browser action, and requests necessary permissions like `storage`, `tabs`, and various host permissions.
* **Why it's important:** Without this file, Chrome doesn't know the extension exists. It defines the security boundary and the scope of what the extension is allowed to do within the user's browser.

#### `firebase-config.js`
* **What it does:** Stores the public configuration variables needed to connect to the Firebase backend.
* **How it does it:** Exports a constant Javascript object containing structural keys such as `apiKey`, `authDomain`, `projectId`, and `storageBucket`.
* **Why it's important:** It provides the connection parameters required by `firebase-rest.js` to correctly route authentication and database requests to the specific Google Cloud project hosting FlowState's data.

#### `firebase-rest.js`
* **What it does:** A custom-built, lightweight library wrapping Firebase's native HTTP REST APIs for Firestore and Authentication.
* **How it does it:** It uses native `fetch()` calls to send GET, POST, and PATCH requests to Google's Identity Toolkit and Firestore endpoints, manually attaching the user's authentication token (`idToken`) in Authorization headers to secure the payloads.
* **Why it's important:** Manifest V3 Service Workers cannot run the official modular Firebase JS SDK reliably because they lack full DOM environments (like `window` or `document`). This file bypasses those limitations, ensuring guaranteed cloud communication without bloating the extension's binary size.

### Managers (Business Logic)

#### `storage.js`
* **What it does:** The synchronization heart and local caching engine.
* **How it does it:** It maintains background polling loops (calling `syncFromCloud()` or `fullSync()`) to periodically fetch organizations, members, roles, and sessions. It then deposits this data into `chrome.storage.local`.
* **Why it's important:** Fetching data from the cloud on-demand is slow and jittery. By caching organization states locally, UI components like the Popup and Dashboard can render instantly from local storage, creating a lightning-fast, highly responsive user experience.

#### `org-manager.js`
* **What it does:** Manages all logic related to Workspaces (Organizations).
* **How it does it:** Provides functions to create a new organization, update organization settings, and handle adding/removing users from specific workspaces. It communicates with `firebase-rest.js` to commit these operational changes to the cloud.
* **Why it's important:** It enforces the business rules of organization management, abstracting away the raw database queries from the UI files so that the background service worker can cleanly manage workspace state.

#### `role-manager.js`
* **What it does:** Handles Role-Based Access Control (RBAC) across workspaces.
* **How it does it:** It evaluates if a specific user (`uid`) can perform an action (`permission`) in a specific workspace (`orgId`). It computes this by checking the user's assigned role and cross-referencing it against the Boolean permission flags defined for that role.
* **Why it's important:** Ensures strict application security. By abstracting the `can()` function, the extension securely verifies if someone is an Admin, Editor, or Viewer before allowing destructive actions like deleting a session or modifying roles.

#### `invite-manager.js`
* **What it does:** Controls the generation and redemption lifecycle of organization invite links.
* **How it does it:** Generates cryptographic hashes for invites, sets expiration parameters or max uses, and handles the background logic when a new user validates the token (adding them as a pending member to the respective organization).
* **Why it's important:** It securely automates user onboarding, allowing organizations to cleanly scale and invite teammates without requiring manual admin intervention for every single new user.

#### `permission-manager.js`
* **What it does:** A thin routing file that coordinates capability checks.
* **How it does it:** Works as a middleware alongside `role-manager.js` to standardize access-control requests passing from the UI to the background layer.
* **Why it's important:** Keeps the codebase clean by centralizing where and how permissions are evaluated and routed.

### Service Workers & Injection

#### `background.js`
* **What it does:** The central nervous system of the extension. Runs continuously in the browser's background.
* **How it does it:** Uses `chrome.runtime.onMessage.addListener` to act as a massive router, receiving requests heavily from UI files (Dashboard/Popup) and delegating them to the appropriate Managers. It orchestrates tab grouping mechanics, recording lifecycles, caching operations, and user privacy states.
* **Why it's important:** It is the only file that remains active regardless of what tab the user is viewing. It handles all heavy lifting, background synchronization, listening to browser-level events (like tab closures), and data preservation.

#### `content.js`
* **What it does:** A script injected seamlessly into active browsing tabs that the user visits.
* **How it does it:** Listens to native browser DOM events (like the `scroll` event) to track exactly how far down a page a user currently is. It sends this `scrollTop` percentage context back to `background.js`.
* **Why it's important:** Enables the magical "Live Resume" feature. When a user restores a saved Session, the extension utilizes this to set the scroll percentage down the page automatically, allowing the user to resume visual work instantly exactly where they left off.

### Graphical User Interfaces (UI)

#### `auth.html` & `auth.js`
* **What it does:** The authentication gateway.
* **How it does it:** Presents login and registration forms to the user. On submission, `auth.js` invokes `firebase-rest.js` endpoints to securely receive an Identity Token. It then writes this token safely into `chrome.storage.local`.
* **Why it's important:** Protects user privacy by ensuring all operations require identity verification. It is the gatekeeper that allows Firestore to authorize database read/writes based on the verified User ID.

#### `popup.html` & `popup.js` & `styles.css`
* **What it does:** The immediate interaction drop-down accessible via clicking the Extension Icon near the URL bar.
* **How it does it:** Uses standard DOM manipulation to render active tabs. `popup.js` sends event messages to `background.js` to trigger "Start Recording", "Save Session", or swap Active Workspaces. `styles.css` themes it beautifully.
* **Why it's important:** This is the highest-traffic user interface. It needs to be lightweight and fast, allowing users to capture their context quickly without breaking their mental flow.

#### `dashboard.html` & `dashboard.js` & `dashboard.css`
* **What it does:** The primary full-page Admin Application and Team Explorer.
* **How it does it:** `dashboard.html` outlines a complex App layout with a sidebar and multi-panel views. `dashboard.js` dynamically pulls lists (Sessions, Roles, Members, Invites) largely from local storage (or requests deep fetches from background), rendering them into interactive tables and modals. `dashboard.css` powers the structural grids, sleek animations, and premium data-swatches.
* **Why it's important:** Provides the indispensable "Command Center". As Workspaces grow, users need a powerful, large-format interface to manage role hierarchies, resolve "Pending" invites, adjust RBAC permissions, and browse deep historical session logs.
