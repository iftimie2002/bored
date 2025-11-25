// Apps Script backend for encrypted autosaves/test pings written from index.html.
// Copy/paste this entire file into a new Apps Script file (e.g., Code.gs) in your project.
// Requirements:
//   1) Paste the jsrsasign library (with the navigator/window shims) into its own file in the same project.
//   2) Paste the CryptoJS library (core + enc-base64 + mode-cbc + pad-pkcs7 + aes) into another file (or below).
//   3) Set the PRIVATE_KEY_PEM (and optionally PUBLIC_KEY_PEM) in Script Properties.
//   4) Ensure a sheet/tab named "RawData" exists; otherwise the first tab will be used.


// Helpers placed first to guarantee they are available to all files, even if
// Apps Script reorders execution (avoids ReferenceError: parseB64WordArray is
// not defined).
function sanitizeB64(str) {
  if (typeof str !== 'string') throw new Error('Expected base64 string');
  return str.replace(/\s+/g, '');
}

function validateB64String(str, label) {
  const clean = sanitizeB64(str);
  if (!/^[A-Za-z0-9+/=]+$/.test(clean)) {
    throw new Error(label + ' contains non-base64 characters');
  }
  if (clean.length % 4 !== 0) {
    throw new Error(label + ' length ' + clean.length + ' is not a multiple of 4 (bad padding?)');
  }
  return clean;
}

function parseB64WordArray(str, label) {
  const clean = validateB64String(str, label);
  try {
    const words = CryptoJS.enc.Base64.parse(clean);
    if (!words || typeof words.sigBytes !== 'number') {
      throw new Error('parse returned invalid WordArray');
    }
    return words;
  } catch (e) {
    throw new Error(label + ' is not valid base64: ' + e);
  }
}

function wordArrayHexPreview(words, limitBytes) {
  const hex = CryptoJS.enc.Hex.stringify(words);
  return hex.slice(0, limitBytes * 2);
}


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
      throw new Error('Invalid JSON in body: ' + err);
    }

    if (!body || !body.key || !body.iv || !body.ciphertext) {
      throw new Error('Missing key/iv/ciphertext in body');
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

  Logger.log('APPENDED to spreadsheet: %s', ss.getUrl());
  Logger.log('Sheet name: %s, lastRow: %s', sheet.getName(), sheet.getLastRow());
}


function decryptCiphertext(body) {
  if (typeof CryptoJS === 'undefined') throw new Error('Missing CryptoJS library');

  const privatePem = PropertiesService.getScriptProperties().getProperty('PRIVATE_KEY_PEM');
  if (!privatePem) throw new Error('Missing PRIVATE_KEY_PEM');

  // 1) RSA: obter a AES key em base64
  const rsa = new RSAKey();
  rsa.readPrivateKeyFromPEMString(privatePem);

  const aesKeyB64 = rsaDecryptToString(rsa, sanitizeB64(body.key));

  // validar que parece base64
  const aesKeyClean = validateB64String(aesKeyB64, 'AES key');

  // 2) Base64 → bytes da chave AES
  const aesKeyWords = parseB64WordArray(aesKeyClean, 'AES key');

  // deve ter 32 bytes (AES-256)
  if (aesKeyWords.sigBytes !== 32) {
    throw new Error('AES key length ' + aesKeyWords.sigBytes + ' (expected 32). raw b64 length: ' + aesKeyClean.length);
  }

  // 3) AES-CBC decrypt
  const ivWords = parseB64WordArray(body.iv, 'AES IV');
  if (ivWords.sigBytes !== 16) {
    throw new Error('AES IV length ' + ivWords.sigBytes + ' (expected 16). b64 length: ' + sanitizeB64(body.iv).length);
  }

  const cipherWords = parseB64WordArray(body.ciphertext, 'ciphertext');
  if (!cipherWords.sigBytes || cipherWords.sigBytes % 16 !== 0) {
    throw new Error('Ciphertext length ' + cipherWords.sigBytes + ' (must be >0 and multiple of 16). b64 length: ' + sanitizeB64(body.ciphertext).length);
  }

  const cipherParams = CryptoJS.lib.CipherParams.create({
    ciphertext: cipherWords
  });

  const decrypted = CryptoJS.AES.decrypt(cipherParams, aesKeyWords, {
    iv: ivWords,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7
  });

  if (!decrypted || typeof decrypted.sigBytes !== 'number') {
    throw new Error('AES decrypt returned invalid WordArray');
  }

  if (decrypted.sigBytes === 0) {
    throw new Error('AES decrypt produced 0 bytes; likely wrong key/iv');
  }

  let plaintext;
  try {
    plaintext = CryptoJS.enc.Utf8.stringify(decrypted);
  } catch (e) {
    const hexPreview = wordArrayHexPreview(decrypted, 64);
    const latin1Preview = CryptoJS.enc.Latin1.stringify(decrypted).slice(0, 64);
    throw new Error('Malformed UTF-8 after AES decrypt: ' + e + '\nbytes: ' + decrypted.sigBytes + '\nhex preview: ' + hexPreview + '\nlatin1 preview: ' + latin1Preview);
  }

  if (!plaintext) {
    const hexPreview = wordArrayHexPreview(decrypted, 64);
    throw new Error('AES decryption produced empty plaintext (wrong key/iv/padding?) hex preview: ' + hexPreview);
  }

  return plaintext;
}


function rsaDecryptToString(rsa, cipherTextB64) {
  // base64 → bytes → hex
  let bytes;
  try {
    bytes = Utilities.base64Decode(validateB64String(cipherTextB64, 'RSA ciphertext'));
  } catch (e) {
    throw new Error('RSA ciphertext is not base64 or failed to decode: ' + e);
  }
  const hex = bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');

  // TENTAR OAEP com SHA-256 (igual ao browser)
  var decrypted = rsa.decryptOAEP(hex, 'sha256');

  if (!decrypted) {
    throw new Error('RSA OAEP decryption failed');
  }

  const trimmed = decrypted.trim();
  if (trimmed.length !== decrypted.length) {
    throw new Error('RSA decrypted string has surrounding whitespace; expected raw base64');
  }

  return decrypted;  // deve ser uma string base64 (AES key)
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
    console.error(err);

    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const sheet = ss.getSheetByName('RawData') || ss.getSheets()[0];
      sheet.appendRow([
        new Date(),         // A
        'ERROR',            // B
        '',                 // C
        '',                 // D
        '',                 // E
        '',                 // F
        '',                 // G
        '',                 // H
        '',                 // I
        String(err)         // J – error message
      ]);
    } catch (e2) {
      console.error('failed to log error to sheet', e2);
    }

    return respond(500, { error: String(err) });
  }
}


function debugAppend() {
  const payload = {
    clientId: 'debug',
    timestamp: new Date().toISOString(),
    meta: { test: true },
    answers: {},
    sequence: [],
    pointer: 0,
    smartScore: 0,
    confidenceScore: 0,
    testPing: true
  };
  appendRow(payload);
}

