# bored
surveys for general market research

## Data flow (current setup)
- The browser encrypts survey state with a random AES-256 key, then wraps that AES key with the Apps Script web app’s RSA public key to avoid RSA size limits.
- Autosave runs after most interactions (debounced ~800ms) and posts the encrypted payload (key + iv + ciphertext) to the web app endpoint.
- Your Apps Script/web app is responsible for RSA-unwrapping the AES key, decrypting the payload, and writing the plaintext into Google Sheets, so submissions arrive nearly in real time once decrypted.
