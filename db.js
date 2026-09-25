// שמירה מקומית בלבד (IndexedDB) – שום דבר לא יוצא מהמכשיר.
// images:  { id, blob, uploadedAt, name, count }
// entries: { id, number, imageId, box: {x0,y0,x1,y1}, band: {top,bottom} }  – קואורדינטות יחסיות (0..1)
const DB = (() => {
  const NAME = 'convoys';
  const VERSION = 1;
  let dbPromise;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(NAME, VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          const images = db.createObjectStore('images', { keyPath: 'id', autoIncrement: true });
          images.createIndex('uploadedAt', 'uploadedAt');
          const entries = db.createObjectStore('entries', { keyPath: 'id', autoIncrement: true });
          entries.createIndex('number', 'number');
          entries.createIndex('imageId', 'imageId');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function addImage(image, entries) {
    const db = await open();
    const tx = db.transaction(['images', 'entries'], 'readwrite');
    const imageId = await request(tx.objectStore('images').add(image));
    const store = tx.objectStore('entries');
    for (const e of entries) store.add({ ...e, imageId });
    await done(tx);
    return imageId;
  }

  async function getImage(id) {
    const db = await open();
    return request(db.transaction('images').objectStore('images').get(id));
  }

  async function allEntries() {
    const db = await open();
    return request(db.transaction('entries').objectStore('entries').getAll());
  }

  async function allImagesMeta() {
    const db = await open();
    const images = await request(db.transaction('images').objectStore('images').getAll());
    return images.map(({ blob, ...meta }) => meta);
  }

  // מוחק כל תמונה שהועלתה לפני תחילת היום הנוכחי (לפי שעון המכשיר)
  async function purgeBefore(timestamp) {
    const db = await open();
    const tx = db.transaction(['images', 'entries'], 'readwrite');
    const images = tx.objectStore('images');
    const entries = tx.objectStore('entries');
    const oldIds = await request(images.index('uploadedAt').getAllKeys(IDBKeyRange.upperBound(timestamp, true)));
    for (const id of oldIds) {
      images.delete(id);
      const entryIds = await request(entries.index('imageId').getAllKeys(id));
      for (const eid of entryIds) entries.delete(eid);
    }
    await done(tx);
    return oldIds.length;
  }

  async function clearAll() {
    const db = await open();
    const tx = db.transaction(['images', 'entries'], 'readwrite');
    tx.objectStore('images').clear();
    tx.objectStore('entries').clear();
    await done(tx);
  }

  return { addImage, getImage, allEntries, allImagesMeta, purgeBefore, clearAll };
})();
