import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { expect, test, type Page } from '@playwright/test';

type Fixture = {
	bodyText: string;
	editPath: string;
	listId: string;
	postId: number;
	testEmail: string;
};

const LOCAL_LISTMONK_HOSTS = new Set( [
	'host.docker.internal',
	'localhost',
	'127.0.0.1',
] );

function loadDotEnv( filePath: string ) {
	if ( ! fs.existsSync( filePath ) ) {
		throw new Error(
			`${ filePath } is required. Run pnpm run listmonk:start before editor E2E.`
		);
	}

	for ( const rawLine of fs
		.readFileSync( filePath, 'utf8' )
		.split( /\r?\n/ ) ) {
		const line = rawLine.trim();
		if ( ! line || line.startsWith( '#' ) ) {
			continue;
		}

		const equalsIndex = line.indexOf( '=' );
		if ( equalsIndex < 1 ) {
			continue;
		}

		const key = line.slice( 0, equalsIndex ).trim();
		let value = line.slice( equalsIndex + 1 ).trim();
		if (
			( value.startsWith( '"' ) && value.endsWith( '"' ) ) ||
			( value.startsWith( "'" ) && value.endsWith( "'" ) )
		) {
			value = value.slice( 1, -1 );
		}

		process.env[ key ] = process.env[ key ] || value;
	}
}

function requireEnv( name: string ): string {
	const value = process.env[ name ]?.trim();
	if ( ! value ) {
		throw new Error( `Missing required environment variable: ${ name }` );
	}

	return value;
}

function assertLocalListmonk() {
	const baseUrl = requireEnv( 'LISTMONK_BASE_URL' );
	let parsed: URL;
	try {
		parsed = new URL( baseUrl );
	} catch {
		throw new Error( `Invalid LISTMONK_BASE_URL: ${ baseUrl }` );
	}

	if ( ! LOCAL_LISTMONK_HOSTS.has( parsed.hostname ) ) {
		throw new Error(
			`Refusing to run editor E2E against non-local Listmonk host: ${ parsed.hostname }`
		);
	}
}

function parseListIds( rawValue: string ): number[] {
	const ids = rawValue
		.split( /[,\s]+/ )
		.map( ( value ) => Number.parseInt( value, 10 ) )
		.filter( ( value ) => Number.isInteger( value ) && value > 0 );

	if ( ids.length === 0 ) {
		throw new Error(
			'LISTMONK_DEFAULT_LIST_IDS must contain at least one positive integer.'
		);
	}

	return [ ...new Set( ids ) ];
}

function phpString( value: string ): string {
	return `'${ value.replace( /\\/g, '\\\\' ).replace( /'/g, "\\'" ) }'`;
}

function runWp( args: string[] ): string {
	const result = spawnSync(
		process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
		[ 'exec', 'wp-env', 'run', 'cli', 'wp', ...args ],
		{
			cwd: process.cwd(),
			encoding: 'utf8',
			stdio: [ 'pipe', 'pipe', 'pipe' ],
		}
	);

	if ( result.error ) {
		throw result.error;
	}

	if ( result.status !== 0 ) {
		throw new Error(
			[
				`WP-CLI command failed: wp ${ args.join( ' ' ) }`,
				result.stdout.trim(),
				result.stderr.trim(),
			]
				.filter( Boolean )
				.join( '\n' )
		);
	}

	return result.stdout.trim();
}

function resolvePluginSlug( candidates: string[] ): string {
	const installed = runWp( [ 'plugin', 'list', '--field=name' ] )
		.split( /\r?\n/ )
		.map( ( line ) => line.trim() )
		.filter( Boolean );

	const slug = candidates.find( ( candidate ) =>
		installed.includes( candidate )
	);
	if ( ! slug ) {
		throw new Error(
			`Unable to find plugin slug. Expected one of ${ candidates.join(
				', '
			) }. Installed: ${ installed.join( ', ' ) }`
		);
	}

	return slug;
}

function createFixture(): Fixture {
	loadDotEnv( '.listmonk.env' );
	assertLocalListmonk();

	const settings = {
		api_token: requireEnv( 'LISTMONK_API_TOKEN' ),
		api_user: requireEnv( 'LISTMONK_API_USER' ),
		base_url: requireEnv( 'LISTMONK_BASE_URL' ),
		default_from_email: requireEnv( 'LISTMONK_FROM_EMAIL' ),
		default_list_ids: parseListIds(
			requireEnv( 'LISTMONK_DEFAULT_LIST_IDS' )
		),
		default_template_id: 0,
		send_mode: 'campaign',
	};
	const bodyText = `Listmonk editor E2E body ${ Date.now() }`;

	runWp( [
		'plugin',
		'activate',
		resolvePluginSlug( [
			'newspack-newsletters',
			'newspack-newsletters.latest-stable',
		] ),
	] );
	runWp( [ 'plugin', 'activate', 'wp-typia-newsletter-connector' ] );
	runWp( [
		'option',
		'update',
		'newspack_newsletters_service_provider',
		'listmonk',
	] );

	const php = `
$errors = array();
$settings = json_decode( ${ phpString( JSON.stringify( settings ) ) }, true );
if ( ! is_array( $settings ) ) {
	$errors[] = 'Unable to decode settings.';
}

if ( empty( $errors ) ) {
	update_option( 'newspack_listmonk_connector_settings', $settings, false );
	Newspack_Newsletters::set_service_provider( 'listmonk' );

	$administrator_ids = get_users(
		array(
			'role' => 'administrator',
			'number' => 1,
			'fields' => 'ID',
		)
	);
	if ( ! empty( $administrator_ids ) ) {
		wp_set_current_user( absint( $administrator_ids[0] ) );
	}

	$post_id = wp_insert_post(
		array(
			'post_type' => Newspack_Newsletters::NEWSPACK_NEWSLETTERS_CPT,
			'post_status' => 'draft',
			'post_title' => 'Listmonk editor E2E ' . gmdate( 'c' ),
			'post_content' => '<!-- wp:paragraph --><p>${ bodyText }</p><!-- /wp:paragraph -->',
		),
		true
	);

	if ( is_wp_error( $post_id ) ) {
		$errors[] = 'Unable to create newsletter: ' . $post_id->get_error_message();
	} else {
		$list_id = absint( $settings['default_list_ids'][0] );
		$test_email = sprintf( 'editor-e2e-%d@example.com', $post_id );

		update_post_meta( $post_id, 'send_list_id', $list_id );
		update_post_meta( $post_id, 'senderName', 'Editor E2E' );
		update_post_meta( $post_id, 'senderEmail', 'smoke@example.com' );

		$client = new Newspack_Listmonk_Connector_Listmonk_Client();
		$subscriber = $client->request(
			'POST',
			'/api/subscribers',
			array(
				'email' => $test_email,
				'name' => 'Editor E2E',
				'status' => 'enabled',
				'lists' => array( $list_id ),
				'attribs' => new stdClass(),
				'preconfirm_subscriptions' => true,
			)
		);
		if ( is_wp_error( $subscriber ) ) {
			$errors[] = 'Unable to create test subscriber: ' . $subscriber->get_error_message();
		}
	}
}

if ( ! empty( $errors ) ) {
	echo wp_json_encode( array( 'ok' => false, 'errors' => $errors ), JSON_PRETTY_PRINT ) . PHP_EOL;
	exit( 1 );
}

echo wp_json_encode(
	array(
		'ok' => true,
		'bodyText' => ${ phpString( bodyText ) },
		'editPath' => sprintf( '/wp-admin/post.php?post=%d&action=edit', $post_id ),
		'listId' => (string) $list_id,
		'postId' => absint( $post_id ),
		'testEmail' => $test_email,
	),
	JSON_PRETTY_PRINT
) . PHP_EOL;
`;

	const output = runWp( [ 'eval', php ] );
	const decoded = JSON.parse( output ) as Fixture & {
		errors?: string[];
		ok?: boolean;
	};
	if ( ! decoded.ok ) {
		throw new Error(
			decoded.errors?.join( '\n' ) || 'Fixture setup failed.'
		);
	}

	return decoded;
}

function createUnconfiguredFixture(): Pick< Fixture, 'editPath' | 'postId' > {
	runWp( [
		'plugin',
		'activate',
		resolvePluginSlug( [
			'newspack-newsletters',
			'newspack-newsletters.latest-stable',
		] ),
	] );
	runWp( [ 'plugin', 'activate', 'wp-typia-newsletter-connector' ] );
	runWp( [
		'option',
		'update',
		'newspack_newsletters_service_provider',
		'listmonk',
	] );
	runWp( [ 'option', 'delete', 'newspack_listmonk_connector_settings' ] );

	const php = `
$errors = array();
Newspack_Newsletters::set_service_provider( 'listmonk' );

$post_id = wp_insert_post(
	array(
		'post_type' => Newspack_Newsletters::NEWSPACK_NEWSLETTERS_CPT,
		'post_status' => 'draft',
		'post_title' => 'Listmonk unconfigured editor E2E ' . gmdate( 'c' ),
		'post_content' => '<!-- wp:paragraph --><p>Listmonk unconfigured body</p><!-- /wp:paragraph -->',
	),
	true
);

if ( is_wp_error( $post_id ) ) {
	$errors[] = 'Unable to create newsletter: ' . $post_id->get_error_message();
}

if ( ! empty( $errors ) ) {
	echo wp_json_encode( array( 'ok' => false, 'errors' => $errors ), JSON_PRETTY_PRINT ) . PHP_EOL;
	exit( 1 );
}

echo wp_json_encode(
	array(
		'ok' => true,
		'editPath' => sprintf( '/wp-admin/post.php?post=%d&action=edit', $post_id ),
		'postId' => absint( $post_id ),
	),
	JSON_PRETTY_PRINT
) . PHP_EOL;
`;

	const output = runWp( [ 'eval', php ] );
	const decoded = JSON.parse( output ) as Pick<
		Fixture,
		'editPath' | 'postId'
	> & {
		errors?: string[];
		ok?: boolean;
	};
	if ( ! decoded.ok ) {
		throw new Error(
			decoded.errors?.join( '\n' ) || 'Unconfigured fixture setup failed.'
		);
	}

	return decoded;
}

async function loginAsAdmin( page: Page ) {
	await page.goto( '/wp-admin/' );
	if ( ! page.url().includes( 'wp-login.php' ) ) {
		return;
	}

	await page.locator( '#user_login' ).fill( 'admin' );
	await page.locator( '#user_pass' ).fill( 'password' );
	await Promise.all( [
		page.waitForURL( /\/wp-admin\// ),
		page.locator( '#wp-submit' ).click(),
	] );
}

async function prepareEditorUi( page: Page ) {
	await page.waitForFunction( () => Boolean( window.wp?.data ) );
	await dismissLayoutModal( page );
	for ( let index = 0; index < 2; index++ ) {
		await page.keyboard.press( 'Escape' );
		await page.waitForTimeout( 300 );
	}
	await page
		.locator( '.components-modal__header button' )
		.last()
		.click( { timeout: 2000 } )
		.catch( () => undefined );
	await page
		.getByRole( 'button', { name: /^Close$/ } )
		.click( {
			timeout: 2000,
		} )
		.catch( () => undefined );

	await page.evaluate( () => {
		window.wp?.data
			?.dispatch?.( 'core/edit-post' )
			?.openGeneralSidebar?.( 'edit-post/document' );
	} );
	await dismissLayoutModal( page );
}

async function dismissLayoutModal( page: Page ) {
	// Give the Newspack layout modal a moment to mount before we try to
	// dismiss it; removing it too early leaves the overlay in place and the
	// modal intercepts pointer events on the editor panel below.
	const overlay = page
		.locator( '.components-modal__screen-overlay' )
		.filter( { hasText: 'Choose a layout' } );
	await overlay.first().waitFor( { state: 'attached', timeout: 3000 } ).catch(
		() => undefined
	);

	await page
		.getByRole( 'button', { name: /Blank newsletter/i } )
		.click( { timeout: 3000 } )
		.catch( () => undefined );

	await overlay
		.evaluateAll( ( overlays ) => {
			for ( const overlayNode of overlays ) {
				overlayNode.remove();
			}
		} )
		.catch( () => undefined );

	// Confirm the overlay is gone so subsequent clicks are not intercepted.
	await expect( overlay ).toHaveCount( 0 );
}

test.describe.configure( { mode: 'serial' } );

test.describe( 'Listmonk editor panel', () => {
	let fixture: Fixture;

	test.beforeAll( () => {
		fixture = createFixture();
	} );

	test( 'renders preview, syncs campaign, and sends a test email', async ( {
		page,
	} ) => {
		await loginAsAdmin( page );
		await page.goto( fixture.editPath );
		await prepareEditorUi( page );

		const panel = page.locator( '.wp-typia-newsletter-connector-panel' );
		await expect( panel ).toBeVisible();
		const listSelect = panel.getByLabel( 'List', { exact: true } );
		if ( ! ( await listSelect.isVisible().catch( () => false ) ) ) {
			await panel.getByRole( 'button', { name: /^Listmonk$/ } ).click();
		}
		await expect( listSelect ).toBeVisible();

		const analyticsSection = panel.locator(
			'.wp-typia-newsletter-connector-panel__analytics'
		);
		await expect(
			analyticsSection.getByText( 'Analytics', { exact: true } )
		).toBeVisible();
		await expect(
			analyticsSection.getByText( 'Sync to Listmonk to view analytics.' )
		).toBeVisible();

		await listSelect.selectOption( fixture.listId );
		await expect( listSelect ).toHaveValue( fixture.listId );

		await expect( panel.getByText( 'Listmonk merge tags' ) ).toBeVisible();
		await expect(
			panel
				.locator(
					'.wp-typia-newsletter-connector-panel__merge-tags code'
				)
				.filter( { hasText: '{{ UnsubscribeURL }}' } )
		).toBeVisible();
		await expect(
			panel
				.locator(
					'.wp-typia-newsletter-connector-panel__merge-tags code'
				)
				.filter( { hasText: '{{ TrackView }}' } )
		).toBeVisible();

		const rawHtmlPreview = panel.getByLabel( 'Raw HTML preview' );
		await expect( rawHtmlPreview ).toHaveValue(
			new RegExp( fixture.bodyText )
		);

		const payloadPreview = panel.getByLabel( 'Listmonk payload' );
		await expect( payloadPreview ).toHaveValue( /"sendMode": "campaign"/ );
		await expect( payloadPreview ).toHaveValue(
			new RegExp( `"postId": ${ fixture.postId }` )
		);

		const syncButton = panel
			.locator( '.wp-typia-newsletter-connector-panel__actions button' )
			.filter( { hasText: /^Sync$/ } );
		await syncButton.scrollIntoViewIfNeeded();
		await expect( syncButton ).toBeEnabled();
		await syncButton.click();
		await expect(
			page
				.locator( '.components-snackbar__content' )
				.filter( { hasText: 'Newsletter synced to Listmonk.' } )
				.last()
		).toBeVisible();
		await expect(
			panel
				.locator( '.wp-typia-newsletter-connector-panel__status strong' )
				.first()
		).toHaveText( /\d+/ );
		await expect( panel.getByText( 'draft' ) ).toBeVisible();

		const refreshAnalyticsButton = analyticsSection.getByRole( 'button', {
			name: /^Refresh analytics$/,
		} );
		await expect( refreshAnalyticsButton ).toBeVisible();
		await expect( refreshAnalyticsButton ).toBeEnabled();
		await expect(
			analyticsSection.getByLabel( 'From', { exact: true } )
		).toHaveValue( /^\d{4}-\d{2}-\d{2}$/ );
		await expect(
			analyticsSection.getByLabel( 'To', { exact: true } )
		).toHaveValue( /^\d{4}-\d{2}-\d{2}$/ );
		for ( const metric of [
			'Sent',
			'To send',
			'Views',
			'Clicks',
			'Bounces',
		] ) {
			await expect(
				analyticsSection
					.locator(
						'.wp-typia-newsletter-connector-panel__analytics-metric'
					)
					.filter( { hasText: metric } )
			).toBeVisible();
		}
		await expect( analyticsSection.getByText( 'Top links' ) ).toBeVisible();
		await refreshAnalyticsButton.click();
		await expect( analyticsSection.getByText( 'Top links' ) ).toBeVisible();

		await panel
			.getByLabel( 'Test email', { exact: true } )
			.fill( fixture.testEmail );
		await page.getByRole( 'button', { name: /^Send test$/ } ).click();
		await expect(
			page
				.locator( '.components-snackbar__content' )
				.filter( {
					hasText: `Listmonk test message sent to ${ fixture.testEmail }.`,
				} )
				.last()
		).toBeVisible();
	} );

	test( 'does not show the Newspack configure modal when Listmonk settings are incomplete', async ( {
		page,
	} ) => {
		const unconfiguredFixture = createUnconfiguredFixture();

		await loginAsAdmin( page );
		await page.goto( unconfiguredFixture.editPath );
		await prepareEditorUi( page );

		await expect( page.getByText( 'Configure plugin' ) ).toHaveCount( 0 );

		const panel = page.locator( '.wp-typia-newsletter-connector-panel' );
		await expect( panel ).toBeVisible();
		const configurationNotice = panel.getByText(
			'Configure Listmonk settings before syncing newsletters.'
		);
		if ( ! ( await configurationNotice.isVisible().catch( () => false ) ) ) {
			await panel.getByRole( 'button', { name: /^Listmonk$/ } ).click();
		}
		await expect( configurationNotice ).toBeVisible();
		await expect(
			panel.getByText( 'Open Listmonk settings' )
		).toBeVisible();
		await expect(
			page.getByText( 'Listmonk API URL, user, and token are required.' )
		).toHaveCount( 0 );
	} );
} );

declare global {
	interface Window {
		wp?: {
			data?: {
				dispatch?: ( storeName: string ) => {
					openGeneralSidebar?: ( name: string ) => void;
				};
				select?: ( storeName: string ) => unknown;
			};
		};
	}
}
