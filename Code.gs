// Apps Script backend for encrypted autosaves/test pings written from index.html.
// Copy/paste this entire file into a new Apps Script file (e.g., Code.gs) in your project.
// Requirements:
//   1) Paste the jsrsasign library (with the navigator/window shims) into its own file in the same project.
//   2) Set the PRIVATE_KEY_PEM (and optionally PUBLIC_KEY_PEM) in Script Properties.
//   3) Ensure a sheet/tab named "RawData" exists; otherwise the first tab will be used.

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

    const cipherTextB64 = body && body.ciphertext;
    if (!cipherTextB64) return respond(400, { error: 'Missing ciphertext' });

    const plaintext = decryptCiphertext(cipherTextB64);
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

function decryptCiphertext(cipherTextB64) {
  const privatePem = PropertiesService.getScriptProperties().getProperty('PRIVATE_KEY_PEM');
  if (!privatePem) throw new Error('Missing PRIVATE_KEY_PEM');

  const rsa = new RSAKey();
  rsa.readPrivateKeyFromPEMString(privatePem);

  // jsrsasign expects hex; convert base64 → bytes → hex.
  const bytes = Utilities.base64Decode(cipherTextB64);
  const hex = bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  // Prefer OAEP (matches browser Web Crypto). Fallback to PKCS1 v1.5 if OAEP is unavailable.
  const decrypted =
    (typeof rsa.decryptOAEP === 'function' ? rsa.decryptOAEP(hex, 'sha256') : null) ||
    rsa.decrypt(hex);
  if (!decrypted) throw new Error('Decryption failed');
  return decrypted;
}

function getPublicKey() {
  // Use Script Property PUBLIC_KEY_PEM if present; otherwise fall back to the bundled key.
  const stored = PropertiesService.getScriptProperties().getProperty('PUBLIC_KEY_PEM');
  if (stored) return stored;

  return `
-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxWwSLTeQoGM5Gvb9yBBJ
7Q4CFpNu3baUSEfm3NJb5LI59HdM66o3h0Sl2RTbwW2Q9zK1kDqLTf/J5kMnwtU9
GKcEuKD1UYWvzZO9C/ekPoKhzMWccdFujIrTeLPJGjncSr0QZ9ZfAoSAYMamdtlR
lfsNZjrUwEL9NsrPd4RMgaYHAI28TlceDhObgZPzjwBPOy0zEQiqW6NA+eQh88ES
/CKvTjFt8E+jZzmFdqPFKHZ56scmThT7VK1IisRCnQFSRKqyKXBBg9C5Qmro7+3p
KiZAS/mG2QMYEwpVeJ5GzvH3ENBgNBps84YivNU0P0OtJ1vz24meWgemkppqadr+
ZwIDAQAB
-----END PUBLIC KEY-----
`;
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
