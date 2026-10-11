use std::io;
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

pub const MAX_FRAME: usize = 16 * 1024 * 1024;

pub struct FrameReader<R> {
    reader: R,
    frame: Vec<u8>,
}

impl<R: AsyncBufRead + Unpin> FrameReader<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            frame: Vec::new(),
        }
    }
    pub async fn next(&mut self) -> io::Result<Option<Vec<u8>>> {
        loop {
            let buffer = self.reader.fill_buf().await?;
            if buffer.is_empty() {
                return if self.frame.is_empty() {
                    Ok(None)
                } else {
                    Err(io::Error::other("Incomplete JSON frame"))
                };
            }
            let end = buffer.iter().position(|byte| *byte == b'\n');
            let length = end.map_or(buffer.len(), |index| index);
            if self.frame.len() + length > MAX_FRAME {
                return Err(io::Error::other("JSON frame exceeds 16 MiB"));
            }
            self.frame.extend_from_slice(&buffer[..length]);
            self.reader.consume(length + usize::from(end.is_some()));
            if end.is_some() {
                return Ok(Some(std::mem::take(&mut self.frame)));
            }
        }
    }
}
