/// Signed ChatGPT app CLIs this relay runs beside, newest first. The relay remains linked against
/// 0.163.0-alpha.10.2; later accepted engines retain its remote-control wire contract.
/// Keep in step with `relayAcceptedAppEngines` in src/native-engine-versions.ts; a gateway test compares them. This list is
/// relay-only: an engine joins `hostVerifiedAppEngines` only after the shared-native fixture passes against it.
pub const VERIFIED_CLI_VERSIONS: [&str; 10] = ["codex-cli 0.167.0-alpha.3.2", "codex-cli 0.166.0-alpha.6", "codex-cli 0.166.0-alpha.5.1", "codex-cli 0.165.0-alpha.1.2", "codex-cli 0.164.0-alpha.11.1", "codex-cli 0.163.0-alpha.11.2", "codex-cli 0.163.0-alpha.11.1", "codex-cli 0.163.0-alpha.11", "codex-cli 0.163.0-alpha.10.2", "codex-cli 0.162.0-alpha.17.2"];

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
        assert!(verified(b"codex-cli 0.167.0-alpha.3.2\n"));
        assert!(verified(b"codex-cli 0.166.0-alpha.6\n"));
        assert!(verified(b"codex-cli 0.166.0-alpha.5.1\n"));
        assert!(verified(b"codex-cli 0.165.0-alpha.1.2\n"));
        assert!(verified(b"codex-cli 0.164.0-alpha.11.1\n"));
        assert!(verified(b"codex-cli 0.163.0-alpha.11.2\n"));
        assert!(verified(b"codex-cli 0.163.0-alpha.11.1\n"));
        assert!(verified(b"codex-cli 0.163.0-alpha.11\n"));
        assert!(verified(b"codex-cli 0.163.0-alpha.10.2\n"));
        assert!(verified(b"codex-cli 0.162.0-alpha.17.2\n"));
        for printed in [
            &b"codex-cli 0.166.0-alpha.5.1-dirty\n"[..],
            b"codex-cli 0.166.0-alpha.5\n",
            b"codex-cli 0.166.0-alpha.6-dirty\n",
            b"codex-cli 0.166.0-alpha.7\n",
            b"codex-cli 0.167.0-alpha.3\n",
            b"codex-cli 0.167.0-alpha.3.2-dirty\n",
            b"codex-cli 0.167.0-alpha.3.3\n",
            b"codex-cli 0.166.0-alpha.6.1\n",
            b"codex-cli 0.165.0-alpha.1.2-dirty\n",
            b"codex-cli 0.165.0-alpha.1.3\n",
            b"codex-cli 0.164.0\n",
            b"codex-cli 0.164.0-alpha.11.1-dirty\n",
            b"codex-cli 0.163.0-alpha.11-dirty\n",
            b"codex-cli 0.163.0-alpha.11.1-dirty\n",
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
