# Changelog

All notable changes to this plugin are documented in this file. Release entries
are generated from Sampo changesets.

## 0.1.2 — 2026-08-14

### Changed

- [e0f7b9d](https://github.com/imjlk/wp-typia-newsletter-connector/commit/e0f7b9decf1b529a2cebfbe12ef5152e59f145cc) Rename the plugin for trademark-safe WordPress.org review and verify compatibility with WordPress 7.1, including its enforced iframed editor and updated form controls. — Thanks @imjlk!

## 0.1.1 — 2026-08-07

### Fixed

- Replace dynamic PHP include paths with explicit local resource loading, remove development documentation from the WordPress.org package, and update the WPTypia tooling used to validate generated contracts.

### Changed

- [3ed995c](https://github.com/imjlk/wp-typia-newsletter-connector/commit/3ed995c7f2192d6c4b3eb194fb41ebe3eedae01f) Add changeset-driven versioning and verified WordPress plugin release automation. — Thanks @imjlk!
- [c35932f](https://github.com/imjlk/wp-typia-newsletter-connector/commit/c35932f698bea5e78d5b2075ab76c1dbf92981f7) Align the plugin slug, text domain, REST namespace, and release artifacts for WordPress.org review while keeping the directory-facing display name distinct. — Thanks @imjlk!

## 0.1.0 - 2026-07-30

- Initial WordPress.org release for the Newspack Newsletters and Listmonk integration.
- Declares Newspack Newsletters as the required companion dependency and adds Listmonk provider registration, settings, campaign sync, test send, send/schedule transitions, editor panel, subscriber sync, analytics, and compatibility fallbacks.
- Documents that bounce and complaint webhooks should terminate at Listmonk, not WordPress.
