// =========== IndexedDB 工具模块 ===========
// 用于存储网页快照（正文/字幕），支持大容量存储

const DB_NAME = 'KnowSeekCache';
const DB_VERSION = 1;
const STORE_NAME = 'pageSnapshots';

export interface PageSnapshot {
  url: string;
  title: string;
  type: 'article' | 'video';
  content: string;
  stats: {
    charCount: number;
    paraCount: number;
  };
  metadata?: {
    videoId: string;
    duration: number;
    description: string;
  };
  savedAt: number;
  updatedAt: number;
  recordIds: string[];
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'url' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
        store.createIndex('type', 'type', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveSnapshot(data: PageSnapshot): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(data);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function getSnapshot(url: string): Promise<PageSnapshot | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(url);
    request.onsuccess = () => { db.close(); resolve(request.result || undefined); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

export async function deleteSnapshot(url: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(url);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function getAllSnapshots(): Promise<PageSnapshot[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => { db.close(); resolve(request.result || []); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

export async function clearAllSnapshots(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function addRecordId(url: string, recordId: string): Promise<void> {
  const existing = await getSnapshot(url);
  if (existing) {
    if (!existing.recordIds.includes(recordId)) {
      existing.recordIds.push(recordId);
      existing.updatedAt = Date.now();
      await saveSnapshot(existing);
    }
  }
}

export async function removeRecordId(url: string, recordId: string): Promise<void> {
  const existing = await getSnapshot(url);
  if (existing) {
    existing.recordIds = existing.recordIds.filter(id => id !== recordId);
    existing.updatedAt = Date.now();
    if (existing.recordIds.length === 0) {
      await deleteSnapshot(url);
    } else {
      await saveSnapshot(existing);
    }
  }
}

export async function getStorageEstimate(): Promise<{ usage: number; quota: number }> {
  if (navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate();
    return {
      usage: estimate.usage || 0,
      quota: estimate.quota || 0
    };
  }
  return { usage: 0, quota: 0 };
}