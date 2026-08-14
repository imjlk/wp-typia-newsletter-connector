<?php
/**
 * Admin settings screen.
 *
 * @package Newspack_Listmonk_Connector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Register settings page.
 */
function newspack_listmonk_connector_register_settings_page() {
	add_options_page(
		__( 'Newsletter Connector', 'wp-typia-newsletter-connector' ),
		__( 'Newsletter Connector', 'wp-typia-newsletter-connector' ),
		'manage_options',
		'wp-typia-newsletter-connector',
		'newspack_listmonk_connector_render_settings_page'
	);
}
add_action( 'admin_menu', 'newspack_listmonk_connector_register_settings_page' );

/**
 * Enqueue the React settings screen.
 *
 * @param string $hook_suffix Current admin page hook.
 */
function newspack_listmonk_connector_enqueue_settings_page( $hook_suffix ) {
	if ( 'settings_page_wp-typia-newsletter-connector' !== $hook_suffix ) {
		return;
	}

	$script_path    = NEWSPACK_LISTMONK_CONNECTOR_DIR . '/build/admin-views/index.js';
	$style_path     = NEWSPACK_LISTMONK_CONNECTOR_DIR . '/build/admin-views/style-index.css';
	$style_rtl_path = NEWSPACK_LISTMONK_CONNECTOR_DIR . '/build/admin-views/style-index-rtl.css';

	if ( ! file_exists( $script_path ) || ! file_exists( __DIR__ . '/../../build/admin-views/index.asset.php' ) ) {
		return;
	}

	$asset = require __DIR__ . '/../../build/admin-views/index.asset.php';
	if ( ! is_array( $asset ) ) {
		$asset = array();
	}

	$handle = 'wp-typia-newsletter-connector-admin-views';

	wp_enqueue_script(
		$handle,
		plugins_url( 'build/admin-views/index.js', NEWSPACK_LISTMONK_CONNECTOR_FILE ),
		isset( $asset['dependencies'] ) && is_array( $asset['dependencies'] ) ? $asset['dependencies'] : array(),
		isset( $asset['version'] ) ? $asset['version'] : filemtime( $script_path ),
		true
	);

	wp_add_inline_script(
		$handle,
		'window.wpApiSettings = Object.assign( {}, window.wpApiSettings || {}, ' . wp_json_encode(
			array(
				'root'  => esc_url_raw( rest_url() ),
				'nonce' => wp_create_nonce( 'wp_rest' ),
			)
		) . ' );',
		'before'
	);

	if ( file_exists( $style_path ) ) {
		wp_enqueue_style(
			$handle,
			plugins_url( 'build/admin-views/style-index.css', NEWSPACK_LISTMONK_CONNECTOR_FILE ),
			array( 'wp-components' ),
			isset( $asset['version'] ) ? $asset['version'] : filemtime( $style_path )
		);
		if ( file_exists( $style_rtl_path ) ) {
			wp_style_add_data( $handle, 'rtl', 'replace' );
		}
	}
}
add_action( 'admin_enqueue_scripts', 'newspack_listmonk_connector_enqueue_settings_page' );

/**
 * Handle settings submission.
 */
function newspack_listmonk_connector_maybe_save_settings() {
	if ( empty( $_POST['newspack_listmonk_connector_settings_nonce'] ) ) {
		return;
	}
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	check_admin_referer( 'newspack_listmonk_connector_settings', 'newspack_listmonk_connector_settings_nonce' );

	$settings = array(
		'base_url'            => isset( $_POST['base_url'] ) ? esc_url_raw( wp_unslash( $_POST['base_url'] ) ) : '',
		'api_user'            => isset( $_POST['api_user'] ) ? sanitize_text_field( wp_unslash( $_POST['api_user'] ) ) : '',
		'api_token'           => isset( $_POST['api_token'] ) ? sanitize_text_field( wp_unslash( $_POST['api_token'] ) ) : '',
		// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- Custom sanitizer preserves display-name email syntax.
		'default_from_email'  => isset( $_POST['default_from_email'] ) ? newspack_listmonk_connector_sanitize_from_email( wp_unslash( $_POST['default_from_email'] ) ) : '',
		'default_template_id' => isset( $_POST['default_template_id'] ) ? absint( wp_unslash( $_POST['default_template_id'] ) ) : '',
		'default_list_ids'    => isset( $_POST['default_list_ids'] ) ? sanitize_text_field( wp_unslash( $_POST['default_list_ids'] ) ) : '',
	);

	newspack_listmonk_connector_save_settings( $settings );

	if ( ! empty( $_POST['test_connection'] ) ) {
		$result = ( new Newspack_Listmonk_Connector_Listmonk_Client() )->test_connection();
		if ( is_wp_error( $result ) ) {
			add_settings_error( 'newspack_listmonk_connector', 'connection_failed', $result->get_error_message(), 'error' );
		} else {
			add_settings_error( 'newspack_listmonk_connector', 'connection_ok', __( 'Listmonk connection succeeded.', 'wp-typia-newsletter-connector' ), 'success' );
		}
	} else {
		add_settings_error( 'newspack_listmonk_connector', 'settings_saved', __( 'Listmonk settings saved.', 'wp-typia-newsletter-connector' ), 'success' );
	}
}
add_action( 'admin_init', 'newspack_listmonk_connector_maybe_save_settings' );

/**
 * Render settings page.
 */
function newspack_listmonk_connector_render_settings_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	?>
	<div class="wrap">
		<h1><?php esc_html_e( 'WPTypia Email Service Provider Connector for Newspack Newsletters with Listmonk', 'wp-typia-newsletter-connector' ); ?></h1>
		<?php settings_errors( 'newspack_listmonk_connector' ); ?>
		<div id="wp-typia-newsletter-connector-settings-root">
			<p><?php esc_html_e( 'Loading Listmonk settings...', 'wp-typia-newsletter-connector' ); ?></p>
		</div>
	</div>
	<?php
}
