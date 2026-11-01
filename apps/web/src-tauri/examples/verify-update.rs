// Release gate: ensure the signing secret matches the verification key shipped to clients.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{env, fs};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let paths: Vec<_> = env::args().skip(1).collect();
    if paths.len() != 2 {
        return Err("Usage: verify-update <AppImage> <AppImage.sig>".into());
    }
    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))?;
    let public_key = STANDARD.decode(
        config["plugins"]["updater"]["pubkey"]
            .as_str()
            .ok_or("Missing verification key")?,
    )?;
    let signature = STANDARD.decode(fs::read_to_string(&paths[1])?.trim())?;
    let public_key = PublicKey::decode(std::str::from_utf8(&public_key)?)?;
    let signature = Signature::decode(std::str::from_utf8(&signature)?)?;
    public_key.verify(&fs::read(&paths[0])?, &signature, true)?;
    println!("Desktop update signature matches the shipped public key.");
    Ok(())
}
