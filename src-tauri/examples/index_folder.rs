//! Usage: cargo run --example index_folder -- <index.sqlite3> <folder>
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: index_folder <index.sqlite3> <folder>");
        std::process::exit(2);
    }
    let t = std::time::Instant::now();
    match globe_lib::devtools::index_folder(std::path::Path::new(&args[1]), &args[2]) {
        Ok((files, dirs, skipped, errors)) => println!(
            "indexed {files} files, {dirs} folders ({skipped} excluded, {errors} errors) in {:?}",
            t.elapsed()
        ),
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}
