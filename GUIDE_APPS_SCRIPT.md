# Encrypting survey submissions with Google Apps Script

This guide shows how to encrypt survey payloads in the browser with a public key, send them to a Google Apps Script web app, decrypt them with a private key stored in script properties, and write the plaintext into the connected Google Sheet.

## 1) Generate a key pair (do this once)

Run these commands locally (not in the browser) to create a 2048-bit RSA key pair:

```bash
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem
```

Keep `private.pem` secret. The `public.pem` contents are safe to embed in your HTML/JS.

## 2) Prepare the Google Sheet and Apps Script project

1. Create or open the Google Sheet that will store responses.
2. In the Sheet, click **Extensions → Apps Script** to open the Script Editor.
3. In **Project Settings**, turn on **Show "appsscript.json" manifest file** (helps with deployments).
4. In **Project Properties → Script Properties**, add a property named `PRIVATE_KEY_PEM` and paste the full contents of `private.pem` (including the `BEGIN/END` lines). This keeps the private key out of the client.

## 3) Add the Apps Script code

Create a new file `Code.gs` in the Script Editor and paste:

```javascript
// Decrypt RSA-OAEP ciphertexts produced in the browser and append rows to the active sheet.
// Requires the jsrsasign library pasted into a separate file (see below).

function doGet(e) {
  // Publish the public key so the browser can encrypt.
  return respond(200, { publicKey: getPublicKey() });
}

function doPost(e) {
  // Browser sends text/plain with mode: 'no-cors' so the request succeeds even
  // if CORS headers are misconfigured. Apps Script still receives the body.
  const body = JSON.parse(e.postData.contents || '{}');
  const cipherTextB64 = body.ciphertext;
  if (!cipherTextB64) return respond(400, { error: 'Missing ciphertext' });

  const plaintext = decryptCiphertext(cipherTextB64);
  const payload = JSON.parse(plaintext);

  // Append to the first sheet; adjust columns as needed
  // "First sheet" means whatever tab is leftmost in the spreadsheet UI (index 0).
  // Each item in the array below becomes one column in that row, in this order:
  //   A: timestamp, B: clientId, C: meta, D: answers, E: sequence,
  //   F: pointer,   G: smartScore, H: confidenceScore
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  sheet.appendRow([
    new Date(),
    payload.clientId,
    JSON.stringify(payload.meta),
    JSON.stringify(payload.answers),
    JSON.stringify(payload.sequence),
    payload.pointer,
    payload.smartScore,
    payload.confidenceScore,
  ]);

  return respond(200, { status: 'ok' });
}

function decryptCiphertext(cipherTextB64) {
  const privatePem = PropertiesService.getScriptProperties().getProperty('PRIVATE_KEY_PEM');
  if (!privatePem) throw new Error('Missing PRIVATE_KEY_PEM');

  const rsa = new RSAKey();
  rsa.readPrivateKeyFromPEMString(privatePem);

  // jsrsasign expects hex; convert base64 → bytes → hex
  const bytes = Utilities.base64Decode(cipherTextB64);
  const hex = bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');

  // Use OAEP with SHA-256 to match the browser's Web Crypto configuration.
  const decrypted = rsa.decryptOAEP(hex, 'sha256');
  if (!decrypted) throw new Error('Decryption failed');
  return decrypted;
}

function getPublicKey() {
  // Option 1: store the PEM in Script Properties (recommended so you don't rely on Drive files)
  const prop = PropertiesService.getScriptProperties().getProperty('PUBLIC_KEY_PEM');
  if (prop) return prop;

  // Option 2: hardcode the PEM here if you prefer (replace the string below)
  // return `-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----`;

  throw new Error('Missing PUBLIC_KEY_PEM script property or hardcoded public key');
}

function respond(status, obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON)
    .setHeader('Access-Control-Allow-Origin', '*')
    .setHeader('Access-Control-Allow-Headers', 'Content-Type')
    .setHeader('Access-Control-Allow-Methods', 'POST, GET')
    .setHeader('Access-Control-Allow-Credentials', 'true')
    .setHeader('Access-Control-Allow-Private-Network', 'true')
    .setHeader('X-Content-Type-Options', 'nosniff')
    .setHeader('X-Frame-Options', 'SAMEORIGIN')
    .setHeader('Cache-Control', 'no-store')
    .setHeader('status', status);
}
```

### Add the jsrsasign library (for RSA-OAEP decryption)

Apps Script does not include Web Crypto, so we add a pure-JS RSA helper. Apps Script will suffix files with `.gs` or `.html`; either is fine, but using a `.gs` script file keeps it alongside the rest of your server-only code.

1. Create a new file in the Apps Script project (e.g., name it `jsrsasign.js.gs`).
2. Paste the contents of the minified library from https://cdnjs.cloudflare.com/ajax/libs/jsrsasign/10.8.6/jsrsasign-all-min.js
3. Save the project. (You do **not** need to expose this file publicly; it stays server-side.)

## 4) Deploy the web app endpoint

1. In the Script Editor, click **Deploy → New deployment**.
2. Type: **Web app**. Set **Execute as**: **Me**. Set **Who has access**: **Anyone** (or restrict by Google account domain if you prefer).
3. Click **Deploy** and copy the **Web app URL**; this will be your `WEB_APP_URL` for submissions.

## 5) Update the HTML to encrypt before sending

1. Fetch the public key from the web app: a `GET` to `WEB_APP_URL` returns JSON like `{ "publicKey": "-----BEGIN PUBLIC KEY-----..." }`. In your HTML/JS, do this once on load and keep the PEM string in memory (no need to store it locally):

```javascript
const WEB_APP_URL = 'https://script.google.com/macros/s/.../exec';
const { publicKey: pubKeyPem } = await fetch(WEB_APP_URL).then(r => r.json());
```

2. Import the public key into the browser using the Web Crypto API:

```javascript
const publicKey = await crypto.subtle.importKey(
  'spki',
  pemToArrayBuffer(pubKeyPem),
  { name: 'RSA-OAEP', hash: 'SHA-256' },
  false,
  ['encrypt']
);
```

3. Encrypt your JSON payload:

```javascript
const encoded = new TextEncoder().encode(JSON.stringify(payload));
const cipherBuffer = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, encoded);
const cipherTextB64 = btoa(String.fromCharCode(...new Uint8Array(cipherBuffer)));
```

4. POST the ciphertext to the web app (send `text/plain` with `mode: 'no-cors'` so it succeeds even if headers are missing):

```javascript
await fetch(WEB_APP_URL, {
  method: 'POST',
  mode: 'no-cors',
  headers: { 'Content-Type': 'text/plain' },
  body: JSON.stringify({ ciphertext: cipherTextB64 })
});
```

## 6) Test end-to-end

1. Open the deployed web app URL in a tab and confirm it returns your public key JSON.
2. Submit a test payload from the browser and check that the Sheet shows decrypted data in new rows.
3. If decryption fails, confirm the key pair matches (regenerate both) and that `PRIVATE_KEY_PEM` is set.

## Key handling reminders

* Never embed the private key in HTML or JavaScript sent to users.
* Rotate keys periodically: repeat step 1 and update `PRIVATE_KEY_PEM` (and the public key) when needed.
* Restrict who can access the Sheet; only decrypted data is stored there, but the sheet itself holds sensitive responses.
