//! Usage: cargo run --example audio_probe   (play some music while it runs)
fn main() {
    match globe_lib::devtools::probe_now_playing() {
        Some((title, artist, source, playing)) => println!("now playing: {title:?} by {artist:?} from {source} (playing: {playing})"),
        None => println!("now playing: no media session"),
    }
    match globe_lib::devtools::probe_audio(2) {
        Ok((rate, peak)) => println!("loopback ok: {rate} Hz, peak RMS {peak:.4} ({})", if peak > 0.001 { "sound detected" } else { "silence" }),
        Err(e) => {
            eprintln!("loopback failed: {e}");
            std::process::exit(1);
        }
    }
}
