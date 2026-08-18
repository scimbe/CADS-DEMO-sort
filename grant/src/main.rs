//! `sort-channel-grant` -- mints the operator-signed [`ct_common::channel::ChannelGrant`]s the
//! Sort Arena waiting room needs (see bridge/server.js's mintGrants). Vendored from
//! CADS-webconference-demo's `ct-video-call-grant`, which this session confirmed is fully
//! generic despite the video-specific name: "two holder pubkeys in, two grants out" is exactly
//! what a bridge<->participant pairing needs too, nothing about the crate itself is
//! video-conferencing-specific. Renamed here, otherwise unmodified logic.
//!
//! A participant cannot mint their own grant -- that needs the channel **operator's** private
//! key, which must never reach them. This offline CLI plays the operator's part: given two
//! holder public keys (the bridge's own, and a join-request's submitted holderPub), it locally
//! signs one [`ct_common::channel::SignedChannelGrant`] per holder for the deterministic
//! `channel_id_for_link(operator, holder_a, holder_b)` -- the exact id both the bridge
//! (bridge/attestation.js) and the participant's own `ct-agent channel member-material` call
//! independently compute, no coordination round-trip needed.
//!
//! This performs **no network call**: minting a grant is pure local signing. Registering the
//! resulting channel + holders with the live control plane (`POST /me/channels`, then
//! `POST /me/channels/:channel/members` for each holder, both owner-authenticated) so the
//! edge's `ChannelAuthorizer` actually recognizes them as members is a separate, credentialed
//! step -- deliberately not bundled into this tool, which never needs a network connection or
//! an OIDC session.
//!
//! Usage:
//!   sort-channel-grant <holder_a_hex> <holder_b_hex> [--operator-private <hex> | --operator-private-file <path>] [--ttl-secs <n>]
//!
//! `--operator-private-file` reads the key from a file in-process instead of taking it inline --
//! the bridge (bridge/server.js's `mintGrants`) shells out to this binary via `execFile`, and an
//! inline `--operator-private <hex>` argument sits in this process's argv (visible to any
//! same-user process via e.g. `/proc/<pid>/cmdline`) for the duration of every mint call. The
//! file path itself is not a secret; only its contents are, and those never appear on the
//! command line.
//!
//! Prints, one line per field:
//!   operator_public_hex=<...>   (register this exact channel with POST /me/channels)
//!   channel_id_hex=<...>
//!   grant_a_hex=<...>           (the bridge's own grant -- CT_CHANNEL_GRANT for its initiate dial)
//!   grant_b_hex=<...>           (the participant's grant -- delivered back via the status poll)

use ct_common::channel::{channel_id_for_link, ChannelGrant, Direction, Rights, SignedChannelGrant};
use ed25519_dalek::{Signer, SigningKey};

const DEFAULT_TTL_SECS: u64 = 3600;
// --ttl-secs bounded so a typo (e.g. a 20-digit value) can't produce either an
// immediately-expired grant or, for the right wrapped value under release-mode Rust's wrapping
// arithmetic, one valid for centuries. mint()'s checked_add is defense in depth against the same
// mistake if Args is ever constructed directly (as the test module does) rather than through
// parse_args.
const MAX_TTL_SECS: u64 = 30 * 24 * 3600; // 30 days -- generous for this deployment's own grants

struct Args {
    holder_a: [u8; 32],
    holder_b: [u8; 32],
    operator_private: Option<[u8; 32]>,
    ttl_secs: u64,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// sort#43: slices `s` as BYTES, never as a `&str`. `&str` indexing panics if a boundary doesn't
// land on a UTF-8 char boundary -- a 64-byte input containing one multi-byte codepoint (plus 62
// ASCII hex chars) passes the length check above and then panics here, and Rust's slice-boundary
// panic message echoes the offending string verbatim. This is used to decode `--operator-private`
// too, so that panic could echo secret key material to stderr. Byte-slicing never panics this way,
// and no branch below ever includes `s`/`pair` in its error text.
fn from_hex32(s: &str) -> Result<[u8; 32], String> {
    if s.len() != 64 {
        return Err(format!("expected 64 hex chars (32 bytes), got {} bytes", s.len()));
    }
    let bytes = s.as_bytes();
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        let pair = &bytes[2 * i..2 * i + 2];
        let digits = std::str::from_utf8(pair).map_err(|_| "invalid hex character".to_string())?;
        *b = u8::from_str_radix(digits, 16).map_err(|_| "invalid hex character".to_string())?;
    }
    Ok(out)
}

// Shared by both --operator-private and --operator-private-file so the all-zero-key rejection
// applies identically regardless of which one supplied the bytes -- a misconfigured key is a
// misconfigured key either way.
fn validate_operator_key(bytes: [u8; 32]) -> Result<[u8; 32], String> {
    if bytes == [0u8; 32] {
        return Err("must not be the all-zero key".to_string());
    }
    Ok(bytes)
}

fn parse_args(raw: &[String]) -> Result<Args, String> {
    let mut positional = Vec::new();
    let mut operator_private = None;
    let mut operator_private_source: Option<&'static str> = None; // for the mutual-exclusivity error message
    let mut ttl_secs = DEFAULT_TTL_SECS;
    let mut i = 0;
    while i < raw.len() {
        match raw[i].as_str() {
            "--operator-private" => {
                if let Some(prior) = operator_private_source {
                    return Err(format!("--operator-private conflicts with {prior} -- pass only one"));
                }
                let v = raw.get(i + 1).ok_or("--operator-private needs a value")?;
                let bytes = from_hex32(v).map_err(|e| format!("--operator-private: {e}"))?;
                operator_private = Some(validate_operator_key(bytes).map_err(|e| format!("--operator-private {e}"))?);
                operator_private_source = Some("--operator-private");
                i += 2;
            }
            "--operator-private-file" => {
                if let Some(prior) = operator_private_source {
                    return Err(format!("--operator-private-file conflicts with {prior} -- pass only one"));
                }
                let path = raw.get(i + 1).ok_or("--operator-private-file needs a value")?;
                let contents = std::fs::read_to_string(path).map_err(|e| format!("--operator-private-file {path}: {e}"))?;
                let bytes = from_hex32(contents.trim()).map_err(|e| format!("--operator-private-file {path}: {e}"))?;
                operator_private = Some(validate_operator_key(bytes).map_err(|e| format!("--operator-private-file {e}"))?);
                operator_private_source = Some("--operator-private-file");
                i += 2;
            }
            "--ttl-secs" => {
                let v = raw.get(i + 1).ok_or("--ttl-secs needs a value")?;
                let parsed = v.parse::<u64>().map_err(|_| "--ttl-secs must be a positive integer".to_string())?;
                if parsed == 0 || parsed > MAX_TTL_SECS {
                    return Err(format!("--ttl-secs must be between 1 and {MAX_TTL_SECS} (30 days), got {parsed}"));
                }
                ttl_secs = parsed;
                i += 2;
            }
            other => {
                positional.push(other.to_string());
                i += 1;
            }
        }
    }
    if positional.len() != 2 {
        return Err(format!(
            "expected exactly 2 positional args (holder_a_hex holder_b_hex), got {}",
            positional.len()
        ));
    }
    Ok(Args {
        holder_a: from_hex32(&positional[0]).map_err(|e| format!("holder_a_hex: {e}"))?,
        holder_b: from_hex32(&positional[1]).map_err(|e| format!("holder_b_hex: {e}"))?,
        operator_private,
        ttl_secs,
    })
}

struct MintedGrants {
    operator_public_hex: String,
    channel_id_hex: String,
    grant_a_hex: String,
    grant_b_hex: String,
}

/// The pure, testable core: given parsed args, an operator signing key (generated by the caller
/// if `args.operator_private` is `None`), and the current unix time, produce the two signed
/// grants. No I/O, no process exit -- kept separate from `main` so it's directly unit-testable.
fn mint(args: &Args, operator_sk: &SigningKey, now: u64) -> MintedGrants {
    let operator_public = operator_sk.verifying_key().to_bytes();
    let channel = channel_id_for_link(&operator_public, &args.holder_a, &args.holder_b);
    // parse_args bounds ttl_secs to MAX_TTL_SECS for anything built through the CLI, so this can
    // never actually overflow u64 for any realistic `now` -- checked_add is defense in depth
    // against an Args built directly (as the test module below does) with an out-of-band
    // ttl_secs, panicking loudly instead of silently wrapping to a garbage expiry the way
    // release-mode Rust's default `+` would.
    let expires_at = now.checked_add(args.ttl_secs).expect("now + ttl_secs overflowed u64 -- ttl_secs should be bounded by parse_args");

    let sign_for = |holder: [u8; 32]| -> SignedChannelGrant {
        let grant = ChannelGrant { channel, holder, direction: Direction::Both, rights: Rights::ReadWrite, delegable: false, expires_at };
        let signature = operator_sk.sign(&grant.signing_bytes()).to_bytes();
        SignedChannelGrant { grant, signature }
    };

    MintedGrants {
        operator_public_hex: hex(&operator_public),
        channel_id_hex: hex(&channel.0),
        grant_a_hex: hex(&sign_for(args.holder_a).encode()),
        grant_b_hex: hex(&sign_for(args.holder_b).encode()),
    }
}

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args(&raw) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("sort-channel-grant: {e}");
            eprintln!("usage: sort-channel-grant <holder_a_hex> <holder_b_hex> [--operator-private <hex> | --operator-private-file <path>] [--ttl-secs <n>]");
            std::process::exit(2);
        }
    };
    let operator_sk = match args.operator_private {
        Some(bytes) => SigningKey::from_bytes(&bytes),
        None => SigningKey::generate(&mut rand::rngs::OsRng),
    };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("system clock before unix epoch").as_secs();
    let minted = mint(&args, &operator_sk, now);

    println!("operator_public_hex={}", minted.operator_public_hex);
    println!("channel_id_hex={}", minted.channel_id_hex);
    println!("grant_a_hex={}", minted.grant_a_hex);
    println!("grant_b_hex={}", minted.grant_b_hex);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ct_common::channel::verify;

    fn args(holder_a: [u8; 32], holder_b: [u8; 32]) -> Args {
        Args { holder_a, holder_b, operator_private: None, ttl_secs: DEFAULT_TTL_SECS }
    }

    #[test]
    fn minted_grants_verify_against_the_real_ct_common_verify_and_carry_the_right_rights() {
        let operator_sk = SigningKey::generate(&mut rand::rngs::OsRng);
        let holder_a = [0x11u8; 32];
        let holder_b = [0x22u8; 32];
        let now = 1_000_000_000;

        let minted = mint(&args(holder_a, holder_b), &operator_sk, now);
        let operator_pub = operator_sk.verifying_key().to_bytes();

        let grant_a = SignedChannelGrant::decode(&hex_decode(&minted.grant_a_hex)).unwrap();
        let grant_b = SignedChannelGrant::decode(&hex_decode(&minted.grant_b_hex)).unwrap();

        assert!(verify(&operator_pub, &grant_a, now).is_ok());
        assert!(verify(&operator_pub, &grant_b, now).is_ok());
        assert_eq!(grant_a.grant.holder, holder_a);
        assert_eq!(grant_b.grant.holder, holder_b);
        assert_eq!(grant_a.grant.direction, Direction::Both);
        assert_eq!(grant_a.grant.rights, Rights::ReadWrite);
        assert!(!grant_a.grant.delegable);
        assert_eq!(grant_a.grant.expires_at, now + DEFAULT_TTL_SECS);

        // Both grants share the same channel id -- the deterministic link id, matching exactly
        // what the participant's own channel_id_for_link() (WASM or member-material) computes.
        assert_eq!(grant_a.grant.channel, grant_b.grant.channel);
        assert_eq!(hex(&grant_a.grant.channel.0), minted.channel_id_hex);
        let expected_channel = channel_id_for_link(&operator_pub, &holder_a, &holder_b);
        assert_eq!(grant_a.grant.channel, expected_channel);
    }

    #[test]
    fn minted_grants_fail_verification_after_expiry() {
        let operator_sk = SigningKey::generate(&mut rand::rngs::OsRng);
        let holder_a = [0x33u8; 32];
        let holder_b = [0x44u8; 32];
        let now = 1_000_000_000;
        let minted = mint(&args(holder_a, holder_b), &operator_sk, now);
        let grant_a = SignedChannelGrant::decode(&hex_decode(&minted.grant_a_hex)).unwrap();
        let operator_pub = operator_sk.verifying_key().to_bytes();

        assert!(verify(&operator_pub, &grant_a, now + DEFAULT_TTL_SECS).is_err(), "must be expired at exactly expires_at");
    }

    #[test]
    fn a_grant_signed_by_a_different_operator_key_is_rejected() {
        let operator_sk = SigningKey::generate(&mut rand::rngs::OsRng);
        let other_sk = SigningKey::generate(&mut rand::rngs::OsRng);
        let minted = mint(&args([0x55u8; 32], [0x66u8; 32]), &operator_sk, 1_000_000_000);
        let grant_a = SignedChannelGrant::decode(&hex_decode(&minted.grant_a_hex)).unwrap();

        let wrong_pub = other_sk.verifying_key().to_bytes();
        assert!(verify(&wrong_pub, &grant_a, 1_000_000_000).is_err());
    }

    #[test]
    fn parse_args_accepts_the_operator_private_and_ttl_flags_in_either_order() {
        let a = [0xAAu8; 32];
        let b = [0xBBu8; 32];
        let raw = vec![
            hex(&a),
            "--ttl-secs".to_string(),
            "60".to_string(),
            hex(&b),
            "--operator-private".to_string(),
            hex(&[0x01u8; 32]),
        ];
        let parsed = parse_args(&raw).unwrap();
        assert_eq!(parsed.holder_a, a);
        assert_eq!(parsed.holder_b, b);
        assert_eq!(parsed.ttl_secs, 60);
        assert_eq!(parsed.operator_private, Some([0x01u8; 32]));
    }

    #[test]
    fn parse_args_rejects_bad_arity_and_bad_hex() {
        assert!(parse_args(&[hex(&[0u8; 32])]).is_err(), "only one positional arg");
        assert!(parse_args(&["not-hex".to_string(), hex(&[0u8; 32])]).is_err());
        assert!(parse_args(&["--ttl-secs".to_string(), "not-a-number".to_string(), hex(&[0u8; 32]), hex(&[1u8; 32])]).is_err());
    }

    #[test]
    fn parse_args_rejects_ttl_out_of_range() {
        let holders = || vec![hex(&[0u8; 32]), hex(&[1u8; 32])];
        let with_ttl = |ttl: &str| {
            let mut raw = vec!["--ttl-secs".to_string(), ttl.to_string()];
            raw.extend(holders());
            raw
        };
        assert!(parse_args(&with_ttl("0")).is_err(), "zero ttl should be rejected");
        assert!(parse_args(&with_ttl(&(MAX_TTL_SECS + 1).to_string())).is_err(), "past the 30-day cap should be rejected");
        assert!(parse_args(&with_ttl("99999999999999999999")).is_err(), "a value that doesn't even fit u64 should be rejected, not silently wrapped");
        assert!(parse_args(&with_ttl(&MAX_TTL_SECS.to_string())).is_ok(), "exactly the cap should still be accepted");
    }

    #[test]
    fn parse_args_rejects_all_zero_operator_key() {
        let raw = vec![
            hex(&[0u8; 32]),
            hex(&[1u8; 32]),
            "--operator-private".to_string(),
            hex(&[0u8; 32]),
        ];
        assert!(parse_args(&raw).is_err());
    }

    fn write_temp_key_file(bytes: [u8; 32]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "sort-channel-grant-test-key-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::write(&path, hex(&bytes)).unwrap();
        path
    }

    #[test]
    fn parse_args_reads_operator_private_from_a_file() {
        let key = [0x42u8; 32];
        let path = write_temp_key_file(key);
        let raw = vec![hex(&[0u8; 32]), hex(&[1u8; 32]), "--operator-private-file".to_string(), path.to_str().unwrap().to_string()];
        let parsed = parse_args(&raw).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(parsed.operator_private, Some(key));
    }

    #[test]
    fn parse_args_trims_whitespace_from_the_key_file_contents() {
        // A real file (echo/a text editor) commonly carries a trailing newline -- from_hex32's
        // exact-64-char check would otherwise reject an otherwise-valid key purely because of
        // how it was written to disk.
        let key = [0x7eu8; 32];
        let path = std::env::temp_dir().join(format!(
            "sort-channel-grant-test-key-nl-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::write(&path, format!("{}\n", hex(&key))).unwrap();
        let raw = vec![hex(&[0u8; 32]), hex(&[1u8; 32]), "--operator-private-file".to_string(), path.to_str().unwrap().to_string()];
        let parsed = parse_args(&raw).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(parsed.operator_private, Some(key));
    }

    #[test]
    fn parse_args_rejects_all_zero_operator_key_from_a_file() {
        let path = write_temp_key_file([0u8; 32]);
        let raw = vec![hex(&[0u8; 32]), hex(&[1u8; 32]), "--operator-private-file".to_string(), path.to_str().unwrap().to_string()];
        let result = parse_args(&raw);
        std::fs::remove_file(&path).ok();
        assert!(result.is_err());
    }

    #[test]
    fn parse_args_rejects_a_missing_operator_private_file() {
        let raw = vec![
            hex(&[0u8; 32]),
            hex(&[1u8; 32]),
            "--operator-private-file".to_string(),
            "/nonexistent/path/that/should/not/exist".to_string(),
        ];
        assert!(parse_args(&raw).is_err());
    }

    #[test]
    fn parse_args_rejects_both_operator_private_and_operator_private_file_together() {
        let path = write_temp_key_file([0x11u8; 32]);
        let raw = vec![
            hex(&[0u8; 32]),
            hex(&[1u8; 32]),
            "--operator-private".to_string(),
            hex(&[0x22u8; 32]),
            "--operator-private-file".to_string(),
            path.to_str().unwrap().to_string(),
        ];
        let result = parse_args(&raw);
        std::fs::remove_file(&path).ok();
        assert!(result.is_err(), "specifying both should be rejected, not silently pick one");
    }

    fn hex_decode(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn from_hex32_rejects_non_ascii_input_cleanly_instead_of_panicking() {
        // sort#43: one 4-byte UTF-8 emoji + 60 ASCII 'a's = 64 BYTES, so the old `s.len() != 64`
        // guard (a byte-length check) passed straight through to the `&str` slice at `[0..2]` --
        // squarely inside the emoji's 4-byte encoding, not on a char boundary, which panicked.
        // This must return a clean Err instead.
        let mut s = String::from('\u{1F600}'); // 4 bytes
        s.push_str(&"a".repeat(60)); // 4 + 60 = 64 bytes total
        assert_eq!(s.len(), 64);
        let result = from_hex32(&s);
        assert!(result.is_err(), "must error, not panic, on non-ASCII input");
    }

    #[test]
    fn from_hex32_error_never_echoes_the_input() {
        // The same function decodes --operator-private, so its error text must never repeat back
        // any part of a rejected value -- that value may be a real secret.
        let mut s = String::from('\u{1F600}');
        s.push_str(&"a".repeat(60));
        let err = from_hex32(&s).unwrap_err();
        assert!(!err.contains('\u{1F600}'));
        assert!(!err.contains(&s));
    }
}
