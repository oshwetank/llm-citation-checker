/*
 * build.js — the version compiled INTO the code, as opposed to the one in
 * manifest.json.
 *
 * They normally agree, and the whole point of this file is catching when they
 * don't. After an update, a real browser was found running new interface
 * files and a new manifest (it reported 0.41.0) on top of an OLD background
 * script and adapters: its captures carried fingerprints only the old code
 * leaves, and its runs failed with a bug fixed two versions earlier — while
 * every screen claimed the new version. The likeliest cause on Windows is
 * extracting over the folder while Chrome holds some of its files open, so
 * those files are silently skipped. chrome.runtime.getManifest() can't catch
 * that: it reads the manifest, not the code that's actually running.
 *
 * The background and the panel each import this file themselves, so each
 * reports the build it was actually loaded with; the panel compares the two
 * and says so loudly when they differ. test/build-id.test.mjs keeps it equal
 * to manifest.json's version.
 */
export const BUILD = "0.50.0";
