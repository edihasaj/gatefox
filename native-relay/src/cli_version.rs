/// Signed ChatGPT app CLIs this relay runs beside, newest first. The relay links the newest one's SDK
/// transport; the older one stays accepted so a Mac whose app has not updated yet keeps its relay.
/// Keep in step with `verifiedAppEngines` in src/native-engine-versions.ts; a gateway test compares them.
pub const VERIFIED_CLI_VERSIONS: [&str; 2] = ["codex-cli 0.163.0-alpha.10.2", "codex-cli 0.162.0-alpha.17.2"];

/// Whether `codex --version` printed exactly one of the verified versions (surrounding whitespace aside).
pub fn verified(stdout: &[u8]) -> bool {
    let printed = String::from_utf8_lossy(stdout);
    VERIFIED_CLI_VERSIONS.contains(&printed.trim())
}

#[cfg(test)]
mod tests {
    use super::verified;

    #[test]
    fn accepts_only_the_verified_app_clis() {
        assert!(verified(b"codex-cli 0.163.0-alpha.10.2\n"));
        assert!(verified(b"codex-cli 0.162.0-alpha.17.2\n"));
        for printed in [
            &b"codex-cli 0.164.0\n"[..],
            b"codex-cli 0.163.0-alpha.10\n",
            b"codex-cli 0.163.0-alpha.10.2-dirty\n",
            b"0.163.0-alpha.10.2\n",
            b"codex-cli 0.163.0-alpha.10.2\ncodex-cli 0.162.0-alpha.17.2\n",
            b"",
        ] {
            assert!(!verified(printed), "accepted {:?}", String::from_utf8_lossy(printed));
        }
    }
}
