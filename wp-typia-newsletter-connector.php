<?php
/**
 * Plugin Name:       WPTypia Email Service Provider Connector for Newspack Newsletters with Listmonk
 * Description:       Companion ESP provider for sending Newspack Newsletters campaigns with Listmonk.
 * Version:           1.0.0
 * Requires at least: 6.7
 * Requires Plugins:  newspack-newsletters
 * Tested up to:      7.1
 * Requires PHP:      8.0
 * Author:            imjlk
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       wp-typia-newsletter-connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'NEWSPACK_LISTMONK_CONNECTOR_VERSION', '1.0.0' );
define( 'NEWSPACK_LISTMONK_CONNECTOR_FILE', __FILE__ );
define( 'NEWSPACK_LISTMONK_CONNECTOR_DIR', __DIR__ );

require_once __DIR__ . '/inc/bootstrap.php';

function newspack_listmonk_connector_get_build_root() {
	return __DIR__ . '/build/blocks';
}

function newspack_listmonk_connector_get_blocks_manifest_path() {
	return __DIR__ . '/build/blocks-manifest.php';
}

function newspack_listmonk_connector_register_blocks_from_manifest_fallback() {
	$build_root     = newspack_listmonk_connector_get_build_root();
	$manifest_data  = file_exists( __DIR__ . '/build/blocks-manifest.php' )
		? require __DIR__ . '/build/blocks-manifest.php'
		: array();

	if ( ! is_array( $manifest_data ) || empty( $manifest_data ) ) {
		$block_dirs = glob( $build_root . '/*', GLOB_ONLYDIR );
		if ( ! is_array( $block_dirs ) ) {
			return;
		}

		foreach ( $block_dirs as $block_dir ) {
			if ( file_exists( $block_dir . '/block.json' ) ) {
				register_block_type( $block_dir );
			}
		}
		return;
	}

	foreach ( array_keys( $manifest_data ) as $block_name ) {
		$block_slug = is_string( $block_name ) && str_contains( $block_name, '/' )
			? substr( $block_name, strpos( $block_name, '/' ) + 1 )
			: (string) $block_name;
		$block_dir  = trailingslashit( $build_root ) . $block_slug;

		if ( file_exists( $block_dir . '/block.json' ) ) {
			register_block_type( $block_dir );
		}
	}
}

function newspack_listmonk_connector_register_blocks() {
	$build_root    = newspack_listmonk_connector_get_build_root();
	$manifest_path = newspack_listmonk_connector_get_blocks_manifest_path();

	if ( ! is_dir( $build_root ) ) {
		return;
	}

	if (
		file_exists( $manifest_path ) && function_exists( 'wp_register_block_metadata_collection' )
	) {
		wp_register_block_metadata_collection( $build_root, $manifest_path );
	}

	newspack_listmonk_connector_register_blocks_from_manifest_fallback();
}

function newspack_listmonk_connector_enqueue_editor_plugins_editor() {
	$script_path = __DIR__ . '/build/editor-plugins/index.js';
	$style_path  = __DIR__ . '/build/editor-plugins/style-index.css';
	$style_rtl_path = __DIR__ . '/build/editor-plugins/style-index-rtl.css';

	if ( ! file_exists( $script_path ) || ! file_exists( __DIR__ . '/build/editor-plugins/index.asset.php' ) ) {
		return;
	}

	$asset = require __DIR__ . '/build/editor-plugins/index.asset.php';
	if ( ! is_array( $asset ) ) {
		$asset = array();
	}

	wp_enqueue_script(
		'wp-typia-newsletter-connector-editor-plugins',
		plugins_url( 'build/editor-plugins/index.js', __FILE__ ),
		isset( $asset['dependencies'] ) && is_array( $asset['dependencies'] ) ? $asset['dependencies'] : array(),
		isset( $asset['version'] ) ? $asset['version'] : filemtime( $script_path ),
		true
	);
	wp_add_inline_script(
		'wp-typia-newsletter-connector-editor-plugins',
		'window.newspack_listmonk_connector_editor = ' . wp_json_encode(
			array(
				'isConfigured' => ( new Newspack_Listmonk_Connector_Listmonk_Client() )->has_credentials(),
				'settingsUrl' => admin_url( 'options-general.php?page=wp-typia-newsletter-connector' ),
			)
		) . ';',
		'before'
	);

	if ( file_exists( $style_path ) ) {
		wp_enqueue_style(
			'wp-typia-newsletter-connector-editor-plugins',
			plugins_url( 'build/editor-plugins/style-index.css', __FILE__ ),
			array(),
			isset( $asset['version'] ) ? $asset['version'] : filemtime( $style_path )
		);
		if ( file_exists( $style_rtl_path ) ) {
			wp_style_add_data( 'wp-typia-newsletter-connector-editor-plugins', 'rtl', 'replace' );
		}
	}
}

/**
 * Keep Newspack's built-in setup modal from blocking the Listmonk editor panel.
 *
 * Newspack's modal can configure bundled providers, but Listmonk credentials live
 * on this companion plugin's settings screen. When Listmonk is already the active
 * provider, let the editor load and let the Listmonk panel show its own setup
 * notice if credentials are still missing.
 */
function newspack_listmonk_connector_enqueue_newspack_editor_compat() {
	wp_register_script(
		'wp-typia-newsletter-connector-newspack-editor-compat',
		false,
		array( 'newspack-newsletters-editor' ),
		NEWSPACK_LISTMONK_CONNECTOR_VERSION,
		true
	);
	wp_add_inline_script(
		'wp-typia-newsletter-connector-newspack-editor-compat',
		<<<'JS'
( function () {
	var data = window.newspack_newsletters_data;
	if ( ! data || data.service_provider !== 'listmonk' ) {
		return;
	}

	data.is_service_provider_configured = '1';
} )();
JS,
	);
	wp_enqueue_script( 'wp-typia-newsletter-connector-newspack-editor-compat' );
}

function newspack_listmonk_connector_register_rest_resources() {
	require_once __DIR__ . '/inc/rest/listmonk-settings.php';
	require_once __DIR__ . '/inc/rest/newsletter-preview.php';
	require_once __DIR__ . '/inc/rest/newsletter-sync.php';
	require_once __DIR__ . '/inc/rest/campaign-analytics.php';
}

add_action( 'init', 'newspack_listmonk_connector_register_blocks' );
add_action( 'enqueue_block_editor_assets', 'newspack_listmonk_connector_enqueue_editor_plugins_editor' );
add_action( 'newspack_newsletters_enqueue_block_editor_assets', 'newspack_listmonk_connector_enqueue_newspack_editor_compat', 20 );
add_action( 'init', 'newspack_listmonk_connector_register_rest_resources', 20 );
