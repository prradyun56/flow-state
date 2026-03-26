import { firebaseConfig } from './firebase-config.js';

const API_KEY = firebaseConfig.apiKey;
const PROJECT_ID = firebaseConfig.projectId;
const AUTH_BASE_URL = 'https://identitytoolkit.googleapis.com/v1';
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

/**
 * Firebase Auth REST API
 */
export const authRest = {
  async signUp(email, password) {
    const url = `${AUTH_BASE_URL}/accounts:signUp?key=${API_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ email, password, returnSecureToken: true }),
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error.message);
    return data;
  },

  async signIn(email, password) {
    const url = `${AUTH_BASE_URL}/accounts:signInWithPassword?key=${API_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ email, password, returnSecureToken: true }),
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error.message);
    return data;
  },

  async getUser(idToken) {
    const url = `${AUTH_BASE_URL}/accounts:lookup?key=${API_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ idToken }),
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error.message);
    return data.users[0];
  }
};

/**
 * Firestore REST API
 */
export const firestoreRest = {
  async getDocument(path, idToken) {
    const url = `${FIRESTORE_BASE_URL}/${path}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${idToken}` }
    });
    if (response.status === 404) return null;
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Firestore error');
    return this.parseDoc(data);
  },

  async setDocument(path, fields, idToken) {
    const url = `${FIRESTORE_BASE_URL}/${path}`;
    const response = await fetch(url, {
      method: 'PATCH', // PATCH works as Set with merge if we don't specify mask
      body: JSON.stringify({ fields: this.encodeFields(fields) }),
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Firestore error');
    return data;
  },

  async deleteDocument(path, idToken) {
    const url = `${FIRESTORE_BASE_URL}/${path}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${idToken}` }
    });
    if (!response.ok && response.status !== 404) {
      const data = await response.json();
      throw new Error(data.error?.message || 'Firestore error');
    }
  },

  async queryDocuments(collection, where, idToken) {
    const url = `${FIRESTORE_BASE_URL}:runQuery`;
    // Simplified query for single where clause
    const query = {
      structuredQuery: {
        from: [{ collectionId: collection }],
        where: {
          fieldFilter: {
            field: { fieldPath: where.field },
            op: where.op,
            value: this.encodeValue(where.value)
          }
        }
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(query),
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      }
    });
    
    const results = await response.json();
    if (!response.ok) throw new Error(results.error?.message || 'Firestore error');
    
    return results
      .filter(r => r.document)
      .map(r => this.parseDoc(r.document));
  },

  // Helpers to handle Firestore's weird JSON format
  parseDoc(doc) {
    const fields = doc.fields || {};
    const result = { _id: doc.name.split('/').pop() };
    for (const key in fields) {
      result[key] = this.decodeValue(fields[key]);
    }
    return result;
  },

  decodeValue(val) {
    if (val.stringValue !== undefined) return val.stringValue;
    if (val.integerValue !== undefined) return parseInt(val.integerValue);
    if (val.booleanValue !== undefined) return val.booleanValue;
    if (val.timestampValue !== undefined) return val.timestampValue;
    if (val.arrayValue !== undefined) return (val.arrayValue.values || []).map(v => this.decodeValue(v));
    if (val.mapValue !== undefined) {
      const map = {};
      const fields = val.mapValue.fields || {};
      for (const k in fields) map[k] = this.decodeValue(fields[k]);
      return map;
    }
    return null;
  },

  encodeFields(obj) {
    const fields = {};
    for (const key in obj) {
      fields[key] = this.encodeValue(obj[key]);
    }
    return fields;
  },

  encodeValue(val) {
    if (typeof val === 'string') return { stringValue: val };
    if (typeof val === 'number') return { integerValue: val.toString() };
    if (typeof val === 'boolean') return { booleanValue: val };
    if (Array.isArray(val)) return { arrayValue: { values: val.map(v => this.encodeValue(v)) } };
    if (val && typeof val === 'object') return { mapValue: { fields: this.encodeFields(val) } };
    return { nullValue: null };
  }
};
