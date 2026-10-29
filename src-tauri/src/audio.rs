//! Music sync: listens to whatever the PC is playing (WASAPI loopback on the
//! default output device, so it works with Spotify, YouTube in a browser, a
//! game, anything) and turns it into a small spectrum + beat signal for the
//! visuals. Audio is analysed in memory only; nothing is recorded, stored or
//! sent anywhere. Also reports the current track from the Windows media
//! session (the same info as the volume flyout).

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rustfft::{num_complex::Complex, FftPlanner};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const BANDS: usize = 32;
const FFT_SIZE: usize = 2048;
const FRAME: Duration = Duration::from_millis(33);
const MIN_HZ: f32 = 30.0;
const MAX_HZ: f32 = 16_000.0;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFrame {
    /// 0..1, auto-gained.
    pub level: f32,
    pub bass: f32,
    pub mid: f32,
    pub treble: f32,
    pub beat: bool,
    pub bands: Vec<f32>,
}

#[derive(Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub source: String,
    pub playing: bool,
}

/// Mono ring buffer shared with the audio callback.
struct Ring {
    data: Vec<f32>,
    pos: usize,
    sample_rate: u32,
}

impl Ring {
    fn push(&mut self, interleaved: &[f32], channels: usize) {
        let ch = channels.max(1);
        for frame in interleaved.chunks(ch) {
            let s = frame.iter().sum::<f32>() / ch as f32;
            let len = self.data.len();
            self.data[self.pos] = s;
            self.pos = (self.pos + 1) % len;
        }
    }

    fn latest(&self, out: &mut [f32]) {
        let len = self.data.len();
        let n = out.len();
        for (i, o) in out.iter_mut().enumerate() {
            *o = self.data[(self.pos + len - n + i) % len];
        }
    }
}

/// Turns spectra into smoothed, auto-gained bands and a beat flag.
pub struct Analyzer {
    band_edges: Vec<(usize, usize)>,
    peaks: [f32; BANDS],
    smooth: [f32; BANDS],
    level_peak: f32,
    level: f32,
    bass_avg: f32,
    last_beat: Instant,
}

impl Analyzer {
    pub fn new(sample_rate: u32) -> Self {
        let bin_hz = sample_rate as f32 / FFT_SIZE as f32;
        let max_bin = FFT_SIZE / 2 - 1;
        let band_edges = (0..BANDS)
            .map(|b| {
                let f0 = MIN_HZ * (MAX_HZ / MIN_HZ).powf(b as f32 / BANDS as f32);
                let f1 = MIN_HZ * (MAX_HZ / MIN_HZ).powf((b + 1) as f32 / BANDS as f32);
                let lo = ((f0 / bin_hz).floor() as usize).clamp(1, max_bin);
                let hi = ((f1 / bin_hz).ceil() as usize).clamp(lo + 1, max_bin + 1);
                (lo, hi)
            })
            .collect();
        Self {
            band_edges,
            peaks: [0.05; BANDS],
            smooth: [0.0; BANDS],
            level_peak: 0.05,
            level: 0.0,
            bass_avg: 0.0,
            last_beat: Instant::now(),
        }
    }

    /// `mags`: FFT magnitudes (FFT_SIZE / 2 bins). `rms`: time-domain RMS.
    pub fn frame(&mut self, mags: &[f32], rms: f32, now: Instant) -> AudioFrame {
        let mut bands = vec![0.0f32; BANDS];
        let mut raw_bass = 0.0;
        for (b, &(lo, hi)) in self.band_edges.iter().enumerate() {
            let e = mags[lo..hi].iter().copied().fold(0.0f32, f32::max);
            let v = (1.0 + e * 40.0).ln();
            if b < 5 {
                raw_bass += v / 5.0;
            }
            // Auto-gain: each band is normalised by its slowly decaying peak,
            // so quiet and loud music both drive the visuals.
            self.peaks[b] = v.max(self.peaks[b] * 0.997).max(0.05);
            let norm = (v / self.peaks[b]).clamp(0.0, 1.0);
            let s = &mut self.smooth[b];
            *s += (norm - *s) * if norm > *s { 0.55 } else { 0.12 };
            bands[b] = *s;
        }
        self.level_peak = rms.max(self.level_peak * 0.997).max(0.01);
        let lvl = (rms / self.level_peak).clamp(0.0, 1.0);
        self.level += (lvl - self.level) * if lvl > self.level { 0.5 } else { 0.1 };

        // Beat: bass energy jumps clearly above its recent average.
        let silent = rms < 0.002;
        let beat = !silent
            && raw_bass > self.bass_avg * 1.32
            && raw_bass > 0.25
            && now.duration_since(self.last_beat) > Duration::from_millis(230);
        if beat {
            self.last_beat = now;
        }
        self.bass_avg += (raw_bass - self.bass_avg) * 0.08;

        let avg = |r: std::ops::Range<usize>| bands[r.clone()].iter().sum::<f32>() / r.len() as f32;
        let (bass, mid, treble) = if silent { (0.0, 0.0, 0.0) } else { (avg(0..5), avg(5..17), avg(17..BANDS)) };
        if silent {
            bands.iter_mut().for_each(|v| *v *= 0.5);
        }
        AudioFrame { level: if silent { 0.0 } else { self.level }, bass, mid, treble, beat, bands }
    }
}

pub struct AudioHandle {
    stop: Arc<AtomicBool>,
}

impl AudioHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Builds a loopback capture on the current default output device.
fn open_loopback(ring: Arc<Mutex<Ring>>, failed: Arc<AtomicBool>) -> Result<(cpal::Stream, Option<cpal::DeviceId>), String> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or("No audio output device")?;
    let id = device.id().ok();
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let channels = supported.channels() as usize;
    let rate = supported.sample_rate();
    {
        let mut r = ring.lock().unwrap();
        r.sample_rate = rate;
        r.data.iter_mut().for_each(|v| *v = 0.0);
    }
    let config = supported.config();
    let err_flag = failed.clone();
    // Loopback routinely reports xruns (e.g. while nothing plays) and route
    // changes it follows by itself; only rebuild when the stream is dead.
    let on_err = move |e: cpal::Error| {
        use cpal::ErrorKind::*;
        if matches!(e.kind(), DeviceNotAvailable | StreamInvalidated | HostUnavailable | BackendError) {
            eprintln!("music sync: audio stream error: {e}");
            err_flag.store(true, Ordering::Relaxed);
        }
    };
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => {
            let ring = ring.clone();
            device.build_input_stream(config, move |d: &[f32], _: &_| ring.lock().unwrap().push(d, channels), on_err, None)
        }
        cpal::SampleFormat::I16 => {
            let ring = ring.clone();
            device.build_input_stream(
                config,
                move |d: &[i16], _: &_| {
                    let f: Vec<f32> = d.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
                    ring.lock().unwrap().push(&f, channels)
                },
                on_err,
                None,
            )
        }
        cpal::SampleFormat::I32 => {
            let ring = ring.clone();
            device.build_input_stream(
                config,
                move |d: &[i32], _: &_| {
                    let f: Vec<f32> = d.iter().map(|&s| s as f32 / i32::MAX as f32).collect();
                    ring.lock().unwrap().push(&f, channels)
                },
                on_err,
                None,
            )
        }
        other => return Err(format!("Unsupported audio sample format {other:?}")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((stream, id))
}

/// Starts capture + analysis + now-playing threads. Stop with the handle.
pub fn start(app: AppHandle) -> AudioHandle {
    let stop = Arc::new(AtomicBool::new(false));

    // Capture + analysis. cpal streams are not Send, so they live here.
    {
        let stop = stop.clone();
        let app = app.clone();
        std::thread::Builder::new()
            .name("music-sync".into())
            .spawn(move || {
                let ring = Arc::new(Mutex::new(Ring { data: vec![0.0; FFT_SIZE * 2], pos: 0, sample_rate: 48_000 }));
                let failed = Arc::new(AtomicBool::new(false));
                let mut current: Option<(cpal::Stream, Option<cpal::DeviceId>)> = None;
                let mut analyzer = Analyzer::new(48_000);
                let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
                let window: Vec<f32> = (0..FFT_SIZE)
                    .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FFT_SIZE - 1) as f32).cos())
                    .collect();
                let mut samples = vec![0.0f32; FFT_SIZE];
                let mut buf = vec![Complex::new(0.0f32, 0.0); FFT_SIZE];
                let mut mags = vec![0.0f32; FFT_SIZE / 2];
                let mut last_device_check = Instant::now() - Duration::from_secs(10);
                let mut was_silent = false;

                while !stop.load(Ordering::Relaxed) {
                    let tick = Instant::now();
                    // (Re)open the loopback when it failed or the default
                    // output device changed (e.g. headphones plugged in).
                    if current.is_none() || failed.load(Ordering::Relaxed) || last_device_check.elapsed() > Duration::from_secs(3) {
                        last_device_check = Instant::now();
                        let default_id = cpal::default_host().default_output_device().and_then(|d| d.id().ok());
                        let changed = current.as_ref().map(|(_, id)| *id != default_id).unwrap_or(true);
                        if changed || failed.load(Ordering::Relaxed) {
                            current = None;
                            failed.store(false, Ordering::Relaxed);
                            match open_loopback(ring.clone(), failed.clone()) {
                                Ok(s) => {
                                    analyzer = Analyzer::new(ring.lock().unwrap().sample_rate);
                                    current = Some(s);
                                }
                                Err(e) => {
                                    let _ = app.emit("music-error", e);
                                }
                            }
                        }
                    }

                    ring.lock().unwrap().latest(&mut samples);
                    let rms = (samples.iter().map(|s| s * s).sum::<f32>() / FFT_SIZE as f32).sqrt();
                    for (i, b) in buf.iter_mut().enumerate() {
                        *b = Complex::new(samples[i] * window[i], 0.0);
                    }
                    fft.process(&mut buf);
                    for (m, c) in mags.iter_mut().zip(buf.iter()) {
                        *m = c.norm() / FFT_SIZE as f32;
                    }
                    let frame = analyzer.frame(&mags, rms, Instant::now());
                    // While silent, send a single quiet frame instead of a stream of zeros.
                    let silent = frame.level == 0.0;
                    if !(silent && was_silent) {
                        let _ = app.emit("audio-frame", &frame);
                    }
                    was_silent = silent;
                    if let Some(rest) = FRAME.checked_sub(tick.elapsed()) {
                        std::thread::sleep(rest);
                    }
                }
            })
            .expect("failed to start music sync");
    }

    // Now playing (Windows media session).
    {
        let stop = stop.clone();
        std::thread::Builder::new()
            .name("now-playing".into())
            .spawn(move || {
                #[cfg(windows)]
                unsafe {
                    let _ = windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED);
                }
                let mut last = NowPlaying::default();
                while !stop.load(Ordering::Relaxed) {
                    let np = now_playing().unwrap_or_default();
                    if np != last {
                        let _ = app.emit("now-playing", &np);
                        last = np;
                    }
                    std::thread::sleep(Duration::from_millis(1500));
                }
            })
            .expect("failed to start now-playing reader");
    }
    AudioHandle { stop }
}

#[cfg(windows)]
fn now_playing() -> windows::core::Result<NowPlaying> {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    let manager = Manager::RequestAsync()?.get()?;
    let session = manager.GetCurrentSession()?;
    let props = session.TryGetMediaPropertiesAsync()?.get()?;
    let playing = session.GetPlaybackInfo()?.PlaybackStatus()? == Status::Playing;
    Ok(NowPlaying {
        title: props.Title()?.to_string(),
        artist: props.Artist()?.to_string(),
        source: session.SourceAppUserModelId()?.to_string(),
        playing,
    })
}

#[cfg(not(windows))]
fn now_playing() -> Result<NowPlaying, ()> {
    Err(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spectrum_with_tone(hz: f32, rate: u32, amp: f32) -> (Vec<f32>, f32) {
        let samples: Vec<f32> = (0..FFT_SIZE).map(|i| amp * (2.0 * std::f32::consts::PI * hz * i as f32 / rate as f32).sin()).collect();
        let mut buf: Vec<Complex<f32>> = samples.iter().map(|&s| Complex::new(s, 0.0)).collect();
        FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE).process(&mut buf);
        let mags = buf[..FFT_SIZE / 2].iter().map(|c| c.norm() / FFT_SIZE as f32).collect();
        let rms = (samples.iter().map(|s| s * s).sum::<f32>() / FFT_SIZE as f32).sqrt();
        (mags, rms)
    }

    #[test]
    fn low_tone_drives_bass_high_tone_drives_treble() {
        let mut a = Analyzer::new(48_000);
        let t = Instant::now();
        let (m, r) = spectrum_with_tone(60.0, 48_000, 0.5);
        let mut f = a.frame(&m, r, t);
        for i in 1..10 {
            f = a.frame(&m, r, t + Duration::from_millis(33 * i));
        }
        assert!(f.bass > f.treble, "bass {} treble {}", f.bass, f.treble);

        let mut a = Analyzer::new(48_000);
        let (m, r) = spectrum_with_tone(8_000.0, 48_000, 0.5);
        for i in 0..10 {
            f = a.frame(&m, r, t + Duration::from_millis(33 * i));
        }
        assert!(f.treble > f.bass, "bass {} treble {}", f.bass, f.treble);
    }

    #[test]
    fn silence_is_quiet_and_has_no_beats() {
        let mut a = Analyzer::new(48_000);
        let mags = vec![0.0; FFT_SIZE / 2];
        let f = a.frame(&mags, 0.0, Instant::now());
        assert_eq!(f.level, 0.0);
        assert!(!f.beat);
        assert_eq!(f.bands.len(), BANDS);
    }

    #[test]
    fn kick_after_quiet_is_a_beat() {
        let mut a = Analyzer::new(48_000);
        let t = Instant::now();
        let (quiet, qr) = spectrum_with_tone(60.0, 48_000, 0.02);
        for i in 0..30 {
            a.frame(&quiet, qr, t + Duration::from_millis(33 * i));
        }
        let (kick, kr) = spectrum_with_tone(60.0, 48_000, 0.9);
        let f = a.frame(&kick, kr, t + Duration::from_millis(33 * 31));
        assert!(f.beat);
    }
}

/// Opens the real loopback device for `secs` and returns (device sample
/// rate, peak RMS seen). Used by `examples/audio_probe.rs`.
pub fn probe(secs: u64) -> Result<(u32, f32), String> {
    let ring = Arc::new(Mutex::new(Ring { data: vec![0.0; FFT_SIZE * 2], pos: 0, sample_rate: 0 }));
    let failed = Arc::new(AtomicBool::new(false));
    let (_stream, _) = open_loopback(ring.clone(), failed.clone())?;
    let mut peak = 0.0f32;
    let mut samples = vec![0.0f32; FFT_SIZE];
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        std::thread::sleep(Duration::from_millis(50));
        ring.lock().unwrap().latest(&mut samples);
        let rms = (samples.iter().map(|s| s * s).sum::<f32>() / FFT_SIZE as f32).sqrt();
        peak = peak.max(rms);
    }
    if failed.load(Ordering::Relaxed) {
        return Err("stream reported an error".into());
    }
    let rate = ring.lock().unwrap().sample_rate;
    Ok((rate, peak))
}

/// Reads the current media session once (for `examples/audio_probe.rs`).
pub fn probe_now_playing() -> Option<NowPlaying> {
    #[cfg(windows)]
    unsafe {
        let _ = windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED);
    }
    now_playing().ok()
}
