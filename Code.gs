// Apps Script backend for encrypted autosaves/test pings written from index.html.
// Copy/paste this entire file into a new Apps Script file (e.g., Code.gs) in your project.
// Requirements:
//   1) Paste the jsrsasign library (with the navigator/window shims) into its own file in the same project.
//   2) Paste the CryptoJS library (core + enc-base64 + mode-cbc + pad-pkcs7 + aes) into another file (or below).
//   3) Set the PRIVATE_KEY_PEM (and optionally PUBLIC_KEY_PEM) in Script Properties.
//   4) Ensure a sheet/tab named "RawData" exists; otherwise the first tab will be used.

function doGet() {
  // Returns the public key so the browser can encrypt payloads.
  return respond(200, { publicKey: getPublicKey() });
}

function doPost(e) {
  return withErrorHandling(() => {
    const rawBody = e && e.postData && e.postData.contents;
    if (!rawBody) return respond(400, { error: 'Missing body' });

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch (err) {
      return respond(400, { error: 'Invalid JSON', detail: String(err) });
    }

    if (!body || !body.key || !body.iv || !body.ciphertext) {
      return respond(400, { error: 'Missing key/iv/ciphertext' });
    }

    const plaintext = decryptCiphertext(body);
    const payload = JSON.parse(plaintext);

    appendRow(payload);
    return respond(200, { status: 'ok' });
  });
}

function appendRow(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('RawData') || ss.getSheets()[0];
  sheet.appendRow([
    new Date(),
    payload.clientId || '',
    payload.timestamp || '',
    JSON.stringify(payload.meta || {}),
    JSON.stringify(payload.answers || {}),
    JSON.stringify(payload.sequence || {}),
    payload.pointer !== undefined ? payload.pointer : '',
    payload.smartScore !== undefined ? payload.smartScore : '',
    payload.confidenceScore !== undefined ? payload.confidenceScore : '',
    payload.testPing ? 'test' : ''
  ]);
}

function decryptCiphertext(body) {
  if (typeof CryptoJS === 'undefined') throw new Error('Missing CryptoJS library');

  const privatePem = PropertiesService.getScriptProperties().getProperty('PRIVATE_KEY_PEM');
  if (!privatePem) throw new Error('Missing PRIVATE_KEY_PEM');

  // 1) RSA-decrypt the wrapped AES key (encrypted raw bytes with RSA-OAEP).
  const rsa = new RSAKey();
  rsa.readPrivateKeyFromPEMString(privatePem);

  const aesKeyBytes = rsaDecryptToBytes(rsa, body.key);
  const aesKeyWords = CryptoJS.lib.WordArray.create(aesKeyBytes);

  // 2) AES-CBC decrypt the payload using the IV and ciphertext.
  const ivWords = CryptoJS.enc.Base64.parse(body.iv);
  const cipherParams = CryptoJS.lib.CipherParams.create({
    ciphertext: CryptoJS.enc.Base64.parse(body.ciphertext)
  });

  const decrypted = CryptoJS.AES.decrypt(cipherParams, aesKeyWords, {
    iv: ivWords,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7
  });

  const plaintext = CryptoJS.enc.Utf8.stringify(decrypted);
  if (!plaintext) throw new Error('AES decryption failed (malformed UTF-8)');
  return plaintext;
}

function rsaDecryptToBytes(rsa, cipherTextB64) {
  // jsrsasign expects hex; convert base64 → bytes → hex.
  const bytes = Utilities.base64Decode(cipherTextB64);
  const hex = bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');

  // Prefer OAEP (matches browser Web Crypto). Fallback to PKCS1 v1.5 if OAEP is unavailable.
  const decrypted =
    (typeof rsa.decryptOAEP === 'function' ? rsa.decryptOAEP(hex, 'sha256') : null) ||
    rsa.decrypt(hex);
  if (!decrypted) throw new Error('RSA decryption failed');

  // Convert decrypted string (raw bytes) back to a Uint8Array.
  const out = new Uint8Array(decrypted.length);
  for (let i = 0; i < decrypted.length; i++) {
    out[i] = decrypted.charCodeAt(i) & 0xff;
  }
  return out;
}

function getPublicKey() {
  const stored = PropertiesService.getScriptProperties().getProperty('PUBLIC_KEY_PEM');
  if (!stored) throw new Error('PUBLIC_KEY_PEM is missing in Script Properties');
  return stored;
}

function respond(status, obj) {
  const output = ContentService.createTextOutput(JSON.stringify(obj));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

function doOptions() {
  return respond(200, { status: 'ok' });
}

function withErrorHandling(fn) {
  try {
    return fn();
  } catch (err) {
    console.error(err); // Visible under Apps Script Executions for debugging.
    return respond(500, { error: String(err) });
  }
}
