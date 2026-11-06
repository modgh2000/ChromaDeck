fn main() {
    tauri_build::build();

    // Force the build script (and therefore the Windows .res icon
    // compilation) to rerun whenever a bundled icon changes. Without this,
    // cargo considers the script fresh and keeps linking the previously
    // compiled resources, so a swapped logo silently never reaches the exe.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    println!("cargo:rerun-if-changed=tauri.conf.json");
}
