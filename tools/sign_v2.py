"""Minimaler APK-Signer (APK Signature Scheme v2, RSA-2048 / SHA-256)."""
import struct, hashlib, sys
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

def lp(b): return struct.pack('<I', len(b)) + b

def find_eocd(d):
    i = d.rfind(b'PK\x05\x06')
    assert i >= 0
    return i

def chunk_digest(parts):
    chunks = []
    for part in parts:
        for o in range(0, len(part), 1 << 20):
            c = part[o:o + (1 << 20)]
            chunks.append(hashlib.sha256(b'\xa5' + struct.pack('<I', len(c)) + c).digest())
    return hashlib.sha256(b'\x5a' + struct.pack('<I', len(chunks)) + b''.join(chunks)).digest()

def sign(inp, out, key_pem, cert_pem):
    d = open(inp, 'rb').read()
    e = find_eocd(d)
    cd_size, cd_off = struct.unpack('<II', d[e + 12:e + 20])
    assert cd_off + cd_size == e, 'Signierblock schon vorhanden?'
    entries, cd, eocd = d[:cd_off], d[cd_off:e], d[e:]
    digest = chunk_digest([entries, cd, eocd])
    key = serialization.load_pem_private_key(open(key_pem, 'rb').read(), None)
    from cryptography import x509
    cert = x509.load_pem_x509_certificate(open(cert_pem, 'rb').read())
    cert_der = cert.public_bytes(serialization.Encoding.DER)
    pub_der = cert.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    ALG = 0x0103  # RSASSA-PKCS1-v1_5 mit SHA2-256
    signed_data = lp(lp(struct.pack('<I', ALG) + lp(digest))) + lp(lp(cert_der)) + lp(b'')
    sig = key.sign(signed_data, padding.PKCS1v15(), hashes.SHA256())
    signer = lp(signed_data) + lp(lp(struct.pack('<I', ALG) + lp(sig))) + lp(pub_der)
    v2 = lp(lp(signer))
    pair = struct.pack('<Q', len(v2) + 4) + struct.pack('<I', 0x7109871a) + v2
    size = len(pair) + 8 + 16
    block = struct.pack('<Q', size) + pair + struct.pack('<Q', size) + b'APK Sig Block 42'
    new_eocd = eocd[:16] + struct.pack('<I', cd_off + len(block)) + eocd[20:]
    open(out, 'wb').write(entries + block + cd + new_eocd)

if __name__ == '__main__':
    sign(*sys.argv[1:5])
