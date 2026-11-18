// Make a password hash for the PORTAL_USERS variable on Railway.
// Usage:  node hash-password.js "the password"
const crypto = require('crypto');
const pw = process.argv[2];
if (!pw) { console.error('Usage: node hash-password.js "the password"'); process.exit(1); }
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(pw, salt, 32);
console.log('scrypt$' + salt.toString('hex') + '$' + hash.toString('hex'));
