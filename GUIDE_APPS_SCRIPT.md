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
  const publicKey = getPublicKey();
  return ContentService
    .createTextOutput(JSON.stringify({ publicKey }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents || '{}');
  const cipherTextB64 = body.ciphertext;
  if (!cipherTextB64) return respond(400, { error: 'Missing ciphertext' });

  const plaintext = decryptCiphertext(cipherTextB64);
  const payload = JSON.parse(plaintext);

  // Append to the first sheet; adjust columns as needed
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
  const decrypted = rsa.decrypt(hex);
  if (!decrypted) throw new Error('Decryption failed');
  return decrypted;
}

function getPublicKey() {
  // Store the PEM as a file named public.pem in your Apps Script project, or hardcode it here
  const file = DriveApp.getFilesByName('public.pem');
  if (!file.hasNext()) throw new Error('public.pem file not found in Drive');
  return file.next().getBlob().getDataAsString();
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

Apps Script does not include Web Crypto, so we add a pure-JS RSA helper:

1. Create a new file in the Apps Script project named `jsrsasign.js`.
2. Paste the contents of the minified library from https://cdnjs.cloudflare.com/ajax/libs/jsrsasign/10.8.6/jsrsasign-all-min.js
3. Save the project. (You do **not** need to expose this file publicly; it stays server-side.)

## 4) Deploy the web app endpoint

1. In the Script Editor, click **Deploy → New deployment**.
2. Type: **Web app**. Set **Execute as**: **Me**. Set **Who has access**: **Anyone** (or restrict by Google account domain if you prefer).
3. Click **Deploy** and copy the **Web app URL**; this will be your `WEB_APP_URL` for submissions.

## 5) Update the HTML to encrypt before sending

1. Fetch the public key from the web app: `fetch(WEB_APP_URL)` will return `{ publicKey: "-----BEGIN PUBLIC KEY-----..." }`.
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

4. POST the ciphertext to the web app:

```javascript
await fetch(WEB_APP_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
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
