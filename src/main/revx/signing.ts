import * as crypto from "crypto";

/**
 * Revolut X request signing (Ed25519).
 * Message = timestamp + METHOD + path-from-/api + query(no '?') + minified-body,
 * concatenated with NO separators, signed with the Ed25519 private key, base64-encoded.
 * Ref: https://developer.revolut.com/docs/api/revolut-x-crypto-exchange
 */
export function signRequest(
  privateKeyPem: string,
  timestampMs: string,
  method: string,
  apiPath: string, // must start with /api, e.g. /api/1.0/balances
  query: string, // without '?', empty string if none
  body: string // minified JSON string, empty string if none
): string {
  const message = `${timestampMs}${method.toUpperCase()}${apiPath}${query}${body}`;
  const signature = crypto.sign(null, Buffer.from(message, "utf-8"), privateKeyPem);
  return signature.toString("base64");
}

export interface Ed25519KeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}
