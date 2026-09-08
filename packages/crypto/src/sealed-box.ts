import sodium from 'libsodium-wrappers'

/** X25519 keypair for libsodium sealed boxes (anonymous sender, receiver-only decryption). */
export async function generateBoxKeypair(): Promise<{ publicKey: Buffer; privateKey: Buffer }> {
  await sodium.ready
  const kp = sodium.crypto_box_keypair()
  return { publicKey: Buffer.from(kp.publicKey), privateKey: Buffer.from(kp.privateKey) }
}

export async function sealTo(publicKey: Buffer, plaintext: Buffer): Promise<Buffer> {
  await sodium.ready
  return Buffer.from(sodium.crypto_box_seal(plaintext, publicKey))
}

export async function openSealed(ciphertext: Buffer, publicKey: Buffer, privateKey: Buffer): Promise<Buffer> {
  await sodium.ready
  return Buffer.from(sodium.crypto_box_seal_open(ciphertext, publicKey, privateKey))   // throws on failure
}
