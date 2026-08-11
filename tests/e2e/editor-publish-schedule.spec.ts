import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { expect, test, type Page } from '@playwright/test';

type ScenarioFixture = {
	bodyText: string;
	editPath: string;
	futureDate?: string;
	futureDateGmt?: string;
	listId: string;
	postId: number;
};

type Fixture = {
	immediate: ScenarioFixture;
	scheduled: ScenarioFixture;
};

type CampaignState = {
	campaignId: number;
	campaignStatus: string;
	metaStatus: string;
	postStatus: string;
	sendAt: string;
};

const LOCAL_LISTMONK_HOSTS = new Set( [
	'host.docker.internal',
	'localhost',
	'127.0.0.1',
] );

function loadDotEnv( filePath: string ) {
	if ( ! fs.existsSync( filePath ) ) {
		throw new Error(
			`${ filePath } is required. Run pnpm run listmonk:start before publish/schedule E2E.`
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
			`Refusing to run publish/schedule E2E against non-local Listmonk host: ${ parsed.hostname }`
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
	const immediateBody = `Listmonk publish E2E body ${ Date.now() }`;
	const scheduledBody = `Listmonk schedule E2E body ${ Date.now() }`;

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

function newspack_listmonk_connector_e2e_create_newsletter( $title, $body_text, $settings ) {
	$post_id = wp_insert_post(
		array(
			'post_type' => Newspack_Newsletters::NEWSPACK_NEWSLETTERS_CPT,
			'post_status' => 'draft',
			'post_title' => $title . ' ' . gmdate( 'c' ),
			'post_content' => '<!-- wp:paragraph --><p>' . esc_html( $body_text ) . '</p><!-- /wp:paragraph -->',
		),
		true
	);

	if ( is_wp_error( $post_id ) ) {
		return $post_id;
	}

	$list_id = absint( $settings['default_list_ids'][0] );
	update_post_meta( $post_id, 'send_list_id', $list_id );
	update_post_meta( $post_id, 'senderName', 'Editor Publish E2E' );
	update_post_meta( $post_id, 'senderEmail', 'smoke@example.com' );
	update_post_meta( $post_id, 'is_public', true );

	return array(
		'bodyText' => $body_text,
		'editPath' => sprintf( '/wp-admin/post.php?post=%d&action=edit', $post_id ),
		'listId' => (string) $list_id,
		'postId' => absint( $post_id ),
	);
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

	$immediate = newspack_listmonk_connector_e2e_create_newsletter( 'Listmonk publish E2E', ${ phpString(
		immediateBody
	) }, $settings );
	$scheduled = newspack_listmonk_connector_e2e_create_newsletter( 'Listmonk schedule E2E', ${ phpString(
		scheduledBody
	) }, $settings );

	if ( is_wp_error( $immediate ) ) {
		$errors[] = 'Unable to create immediate newsletter: ' . $immediate->get_error_message();
	}
	if ( is_wp_error( $scheduled ) ) {
		$errors[] = 'Unable to create scheduled newsletter: ' . $scheduled->get_error_message();
	}
}

if ( empty( $errors ) ) {
	$future_gmt = gmdate( 'Y-m-d H:i:s', time() + HOUR_IN_SECONDS );
	$scheduled['futureDateGmt'] = gmdate( 'Y-m-d\\TH:i:s', strtotime( $future_gmt ) );
	$scheduled['futureDate'] = str_replace( ' ', 'T', get_date_from_gmt( $future_gmt ) );
}

if ( ! empty( $errors ) ) {
	echo wp_json_encode( array( 'ok' => false, 'errors' => $errors ), JSON_PRETTY_PRINT ) . PHP_EOL;
	exit( 1 );
}

echo wp_json_encode(
	array(
		'ok' => true,
		'immediate' => $immediate,
		'scheduled' => $scheduled,
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

function readCampaignState( postId: number ): CampaignState {
	const php = `
$campaign_id = absint( get_post_meta( ${ postId }, '_wtnl_listmonk_campaign_id', true ) );
$campaign_status = '';
$send_at = '';

if ( $campaign_id ) {
	$client = new Newspack_Listmonk_Connector_Listmonk_Client();
	$campaign = $client->get_campaign( $campaign_id );
	if ( ! is_wp_error( $campaign ) ) {
		$campaign_data = $campaign['data'] ?? $campaign;
		$campaign_status = (string) ( $campaign_data['status'] ?? '' );
		$send_at = (string) ( $campaign_data['send_at'] ?? '' );
	}
}

echo wp_json_encode(
	array(
		'campaignId' => $campaign_id,
		'campaignStatus' => $campaign_status,
		'metaStatus' => (string) get_post_meta( ${ postId }, '_wtnl_listmonk_last_status', true ),
		'postStatus' => (string) get_post_status( ${ postId } ),
		'sendAt' => $send_at,
	),
	JSON_PRETTY_PRINT
) . PHP_EOL;
`;

	return JSON.parse( runWp( [ 'eval', php ] ) ) as CampaignState;
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
		.click( { timeout: 2000 } )
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

async function openNewsletterEditor( page: Page, scenario: ScenarioFixture ) {
	await page.goto( scenario.editPath );
	await prepareEditorUi( page );

	const panel = page.locator( '.wp-typia-newsletter-connector-panel' );
	await expect( panel ).toBeVisible();
	const listSelect = panel.getByLabel( 'List', { exact: true } );
	if ( ! ( await listSelect.isVisible().catch( () => false ) ) ) {
		await panel.getByRole( 'button', { name: /^Listmonk$/ } ).click();
	}
	await expect( listSelect ).toHaveValue( scenario.listId );
}

async function savePostInEditor(
	page: Page,
	edits: Record< string, unknown >
) {
	const result = await page.evaluate( async ( nextEdits ) => {
		type EditorDispatch = {
			editPost?: ( editsToApply: Record< string, unknown > ) => void;
			savePost?: () => Promise< unknown > | unknown;
		};
		type EditorSelect = {
			getEditedPostAttribute?: ( attribute: string ) => unknown;
			isAutosavingPost?: () => boolean;
			isSavingPost?: () => boolean;
		};

		const editorDispatch = window.wp?.data?.dispatch?.( 'core/editor' ) as
			| EditorDispatch
			| undefined;
		const editorSelect = window.wp?.data?.select?.( 'core/editor' ) as
			| EditorSelect
			| undefined;

		if (
			! editorDispatch?.editPost ||
			! editorDispatch.savePost ||
			! editorSelect
		) {
			throw new Error( 'WordPress editor data store is unavailable.' );
		}

		editorDispatch.editPost( nextEdits );
		await Promise.resolve( editorDispatch.savePost() );

		await new Promise< void >( ( resolve, reject ) => {
			const started = Date.now();
			const tick = () => {
				if (
					! editorSelect.isSavingPost?.() &&
					! editorSelect.isAutosavingPost?.()
				) {
					resolve();
					return;
				}
				if ( Date.now() - started > 30000 ) {
					reject( new Error( 'Timed out waiting for editor save.' ) );
					return;
				}
				window.setTimeout( tick, 100 );
			};
			tick();
		} );

		return {
			status: String(
				editorSelect.getEditedPostAttribute?.( 'status' ) ?? ''
			),
		};
	}, edits );

	return result;
}

async function expectCampaignStatus(
	postId: number,
	expectedStatus: 'running' | 'scheduled'
): Promise< CampaignState > {
	await expect
		.poll(
			() => {
				const state = readCampaignState( postId );
				const acceptableRemoteStatuses =
					expectedStatus === 'running'
						? [ 'running', 'finished' ]
						: [ expectedStatus ];

				return acceptableRemoteStatuses.includes(
					state.campaignStatus
				) && state.metaStatus === expectedStatus
					? 'ready'
					: `${ state.campaignStatus || '-' }/${
							state.metaStatus || '-'
					  }`;
			},
			{
				timeout: 45000,
			}
		)
		.toBe( 'ready' );

	const state = readCampaignState( postId );
	expect( state.campaignId ).toBeGreaterThan( 0 );
	expect( state.metaStatus ).toBe( expectedStatus );

	return state;
}

test.describe.configure( { mode: 'serial' } );

test.describe( 'Listmonk editor publish and schedule flow', () => {
	let fixture: Fixture;

	test.beforeAll( () => {
		fixture = createFixture();
	} );

	test( 'publishes a newsletter into a running Listmonk campaign', async ( {
		page,
	} ) => {
		await loginAsAdmin( page );
		await openNewsletterEditor( page, fixture.immediate );

		const saveResult = await savePostInEditor( page, {
			status: 'publish',
		} );
		expect( saveResult.status ).toMatch( /^(publish|private)$/ );

		const state = await expectCampaignStatus(
			fixture.immediate.postId,
			'running'
		);
		expect( state.postStatus ).toMatch( /^(publish|private)$/ );
	} );

	test( 'schedules a newsletter into a scheduled Listmonk campaign', async ( {
		page,
	} ) => {
		await loginAsAdmin( page );
		await openNewsletterEditor( page, fixture.scheduled );

		const saveResult = await savePostInEditor( page, {
			date: fixture.scheduled.futureDate,
			date_gmt: fixture.scheduled.futureDateGmt,
			status: 'future',
		} );
		expect( saveResult.status ).toMatch( /^(future|publish|private)$/ );

		const state = await expectCampaignStatus(
			fixture.scheduled.postId,
			'scheduled'
		);
		expect( state.sendAt ).not.toBe( '' );
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
