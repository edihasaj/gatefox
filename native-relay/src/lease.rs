use std::{fs::{File, OpenOptions}, io, path::Path};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

pub fn acquire(home: &Path) -> io::Result<File> {
    if home == Path::new("/") { return Err(io::Error::other("Invalid relay home")); }
    match std::fs::symlink_metadata(home) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o022 != 0 {
                return Err(io::Error::other("Relay home must be an owned private directory"));
            }
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            std::fs::create_dir_all(home)?;
            std::fs::set_permissions(home, std::fs::Permissions::from_mode(0o700))?;
        },
        Err(error) => return Err(error),
    }
    let file = OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .mode(0o600).custom_flags(libc::O_NOFOLLOW).open(home.join("relay.lock"))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
        return Err(io::Error::other("Relay lock is not an owned private file"));
    }
    file.try_lock().map_err(|_| io::Error::other("Another relay owns this native server"))?;
    Ok(file)
}
