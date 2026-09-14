use crate::config::sha256_digest_tagged;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const CHUNK_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub digest: String,
    pub offset: u64,
    pub length: u64,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub enum FileStorage {
    Blob {
        object_digest: String,
        bytes: Vec<u8>,
    },
    Chunks {
        chunks: Vec<Chunk>,
    },
}

pub fn content_digest(bytes: &[u8]) -> String {
    sha256_digest_tagged(bytes)
}

pub fn store_file(bytes: Vec<u8>) -> (String, FileStorage) {
    let digest = content_digest(&bytes);
    let size = bytes.len() as u64;
    if size <= CHUNK_BYTES {
        (
            digest.clone(),
            FileStorage::Blob {
                object_digest: digest,
                bytes,
            },
        )
    } else {
        let chunks = chunk_bytes(&bytes);
        (digest, FileStorage::Chunks { chunks })
    }
}

pub fn store_streamed<F>(file_size: u64, mut read: F) -> std::io::Result<(String, FileStorage)>
where
    F: FnMut(&mut [u8]) -> std::io::Result<usize>,
{
    if file_size <= CHUNK_BYTES {
        let mut bytes = vec![0u8; file_size as usize];
        fill_buf(&mut bytes, &mut read)?;
        return Ok(store_file(bytes));
    }
    let mut hasher = Sha256::new();
    let mut chunks = Vec::new();
    let mut offset = 0u64;
    let mut buf = vec![0u8; CHUNK_BYTES as usize];
    while offset < file_size {
        let remaining = (file_size - offset) as usize;
        let want = remaining.min(buf.len());
        fill_buf(&mut buf[..want], &mut read)?;
        let slice = &buf[..want];
        hasher.update(slice);
        chunks.push(Chunk {
            digest: content_digest(slice),
            offset,
            length: want as u64,
            bytes: slice.to_vec(),
        });
        offset += want as u64;
    }
    let digest = format!("sha256:{}", hex_encode(&hasher.finalize()));
    Ok((digest, FileStorage::Chunks { chunks }))
}

fn fill_buf<F>(dest: &mut [u8], read: &mut F) -> std::io::Result<()>
where
    F: FnMut(&mut [u8]) -> std::io::Result<usize>,
{
    let mut filled = 0usize;
    while filled < dest.len() {
        let n = read(&mut dest[filled..])?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "snapshot file truncated during streaming read",
            ));
        }
        filled += n;
    }
    Ok(())
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        hex.push(HEX[(byte >> 4) as usize] as char);
        hex.push(HEX[(byte & 0x0f) as usize] as char);
    }
    hex
}

pub fn chunk_bytes(bytes: &[u8]) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut offset = 0u64;
    let total = bytes.len();
    while (offset as usize) < total {
        let start = offset as usize;
        let end = (start + CHUNK_BYTES as usize).min(total);
        let slice = bytes[start..end].to_vec();
        let length = slice.len() as u64;
        chunks.push(Chunk {
            digest: content_digest(&slice),
            offset,
            length,
            bytes: slice,
        });
        offset += length;
    }
    chunks
}

pub fn storage_json(storage: &FileStorage) -> Value {
    match storage {
        FileStorage::Blob { object_digest, .. } => json!({
            "kind": "blob",
            "objectDigest": object_digest
        }),
        FileStorage::Chunks { chunks } => json!({
            "kind": "chunks",
            "chunks": chunks.iter().map(|c| json!({
                "digest": c.digest,
                "offset": c.offset,
                "length": c.length
            })).collect::<Vec<_>>()
        }),
    }
}

pub fn collect_blob_payloads(storage: &FileStorage) -> Vec<(String, Vec<u8>)> {
    match storage {
        FileStorage::Blob {
            object_digest,
            bytes,
        } => vec![(object_digest.clone(), bytes.clone())],
        FileStorage::Chunks { chunks } => chunks
            .iter()
            .map(|c| (c.digest.clone(), c.bytes.clone()))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CHUNK_BYTES, FileStorage, chunk_bytes, content_digest, store_file, store_streamed,
    };

    #[test]
    fn small_file_is_single_blob() {
        let (digest, storage) = store_file(b"hello".to_vec());
        assert!(digest.starts_with("sha256:"));
        match storage {
            FileStorage::Blob { bytes, .. } => assert_eq!(bytes, b"hello"),
            FileStorage::Chunks { .. } => panic!("expected blob"),
        }
    }

    #[test]
    fn huge_file_is_ordered_4mib_chunks() {
        let size = (CHUNK_BYTES as usize) + 16;
        let bytes = vec![7u8; size];
        let chunks = chunk_bytes(&bytes);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].offset, 0);
        assert_eq!(chunks[0].length, CHUNK_BYTES);
        assert_eq!(chunks[1].offset, CHUNK_BYTES);
        assert_eq!(chunks[1].length, 16);
        assert_ne!(chunks[0].digest, chunks[1].digest);
    }

    #[test]
    fn streamed_huge_file_matches_digest_without_full_vec_slice() {
        let size = (CHUNK_BYTES as usize) + 32;
        let bytes = vec![9u8; size];
        let mut cursor = 0usize;
        let (digest, storage) = store_streamed(size as u64, |buf| {
            let n = buf.len().min(bytes.len() - cursor);
            buf[..n].copy_from_slice(&bytes[cursor..cursor + n]);
            cursor += n;
            Ok(n)
        })
        .expect("stream");
        assert_eq!(digest, content_digest(&bytes));
        match storage {
            FileStorage::Chunks { chunks } => {
                assert_eq!(chunks.len(), 2);
                assert_eq!(chunks[0].length, CHUNK_BYTES);
                assert_eq!(chunks[1].length, 32);
            }
            FileStorage::Blob { .. } => panic!("expected chunks"),
        }
    }
}
